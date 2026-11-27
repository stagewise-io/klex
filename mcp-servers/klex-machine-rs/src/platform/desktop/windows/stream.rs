//! The Windows stream capture behind the built-in RFB server. The primary
//! monitor is captured with GDI about ten times a second, in physical
//! pixels. While the lock screen or a UAC prompt holds the input desktop,
//! which no user process can capture, the frame is a placeholder. Input goes
//! through SendInput as scan codes; the clipboard is polled on its own thread.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU8, AtomicUsize, Ordering};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender, channel};
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::{Duration, Instant};

use windows_sys::Win32::Foundation::{GlobalFree, HWND, RECT};
use windows_sys::Win32::System::DataExchange::{
    CloseClipboard, EmptyClipboard, GetClipboardData, GetClipboardSequenceNumber,
    IsClipboardFormatAvailable, OpenClipboard, SetClipboardData,
};
use windows_sys::Win32::System::Memory::{
    GMEM_MOVEABLE, GlobalAlloc, GlobalLock, GlobalSize, GlobalUnlock,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_SCANCODE, VkKeyScanW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE};

use super::super::windows_keys::{StreamToken, extended, stream_token};
use super::computer::wheel;
use super::win32::{
    self, Canvas, button_flags, keyboard, mouse, scan_code, screen_size, try_send, unicode,
};
use crate::desktop::Warn;
use crate::desktop::image::{RgbImage, encode_jpeg};
use crate::desktop::provider::{MouseButton, ScrollDirection};
use crate::desktop::rfb::{
    STREAM_TILE_SIZE, StreamBackend, StreamCapture, StreamKey, StreamSink, TileRect,
};

const MAX_DIMENSION: i32 = 16_384;
const FRAME: Duration = Duration::from_millis(100);
const PHOTO_COLORS: usize = 64;
/// A tile sent as JPEG goes again losslessly once it has been still this long.
const LOSSLESS_DELAY: Duration = Duration::from_millis(1500);
const MAX_CLIPBOARD_BYTES: usize = 1 << 20;
const CLIPBOARD_POLL: Duration = Duration::from_millis(250);
const BLOCKED_CHECK: Duration = Duration::from_millis(250);
const CF_UNICODETEXT: u32 = 13;
const PLACEHOLDER: &str = "Windows is locked or showing a UAC prompt";
const INPUT_BLOCKED: &str =
    "An administrator window has focus; remote input is blocked until it is closed or loses focus";

pub struct WindowsStreamBackend {
    warn: Warn,
    captures: Arc<AtomicUsize>,
}

impl WindowsStreamBackend {
    /// `captures` counts running capture loops.
    pub fn new(warn: Warn, captures: Arc<AtomicUsize>) -> Self {
        Self { warn, captures }
    }
}

/// Counts one capture loop from `start` until the loop exits, or until its
/// thread fails to spawn.
struct Capturing(Arc<AtomicUsize>);

impl Capturing {
    fn new(count: &Arc<AtomicUsize>) -> Self {
        count.fetch_add(1, Ordering::SeqCst);
        Self(count.clone())
    }
}

impl Drop for Capturing {
    fn drop(&mut self) {
        self.0.fetch_sub(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct Blocked {
    checked_at: Option<Instant>,
    by: Option<String>,
}

struct Shared {
    running: AtomicBool,
    /// JPEG quality for busy tiles; 0 sends everything losslessly.
    quality: AtomicU8,
    refresh: AtomicBool,
    blocked: Mutex<Blocked>,
    warn: Warn,
}

impl Shared {
    fn running(&self) -> bool {
        self.running.load(Ordering::SeqCst)
    }

    /// The elevated app whose window has focus, rechecked at most every
    /// `BLOCKED_CHECK`; each change is logged.
    fn input_blocked_by(&self) -> Option<String> {
        let mut blocked = self
            .blocked
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if blocked
            .checked_at
            .is_some_and(|at| at.elapsed() < BLOCKED_CHECK)
        {
            return blocked.by.clone();
        }
        blocked.checked_at = Some(Instant::now());
        let current = win32::elevated_foreground();
        if current != blocked.by {
            match &current {
                Some(name) => (self.warn)(&format!(
                    "An administrator window ({name}) has focus. Windows discards all remote input, anywhere on the screen, until it is closed or loses focus."
                )),
                None => (self.warn)("Remote input reaches the desktop again."),
            }
            blocked.by = current.clone();
        }
        current
    }
}

enum Input {
    Move(u32, u32),
    Button(MouseButton, bool, u32, u32),
    Wheel(ScrollDirection, u32, u32),
    Key(bool, StreamToken),
}

impl StreamBackend for WindowsStreamBackend {
    fn start(&self, sink: StreamSink) -> Result<Box<dyn StreamCapture>, String> {
        let shared = Arc::new(Shared {
            running: AtomicBool::new(true),
            quality: AtomicU8::new(0),
            refresh: AtomicBool::new(false),
            blocked: Mutex::default(),
            warn: self.warn.clone(),
        });
        let (input, inputs) = channel();
        let (clipboard, clipboards) = channel();
        let spawn = |name: &str, body: Box<dyn FnOnce() + Send>| {
            std::thread::Builder::new()
                .name(name.into())
                .spawn(body)
                .map(drop)
                .map_err(|error| format!("Could not start the stream {name}: {error}"))
        };
        // Threads that did start exit once `running` is cleared and the
        // senders above are dropped.
        let stop = |error: String| {
            shared.running.store(false, Ordering::SeqCst);
            error
        };
        let capture = (shared.clone(), sink.clone(), Capturing::new(&self.captures));
        spawn(
            "capture",
            Box::new(move || {
                let (shared, sink, _capturing) = capture;
                capture_loop(&shared, &sink);
            }),
        )
        .map_err(stop)?;
        let clipboard_state = (shared.clone(), sink);
        spawn(
            "clipboard",
            Box::new(move || clipboard_loop(&clipboard_state.0, &clipboard_state.1, &clipboards)),
        )
        .map_err(stop)?;
        let input_state = shared.clone();
        spawn("input", Box::new(move || input_loop(&input_state, &inputs))).map_err(stop)?;
        Ok(Box::new(WindowsCapture {
            shared,
            input: Some(input),
            clipboard: Some(clipboard),
        }))
    }
}

struct WindowsCapture {
    shared: Arc<Shared>,
    input: Option<Sender<Input>>,
    clipboard: Option<Sender<String>>,
}

impl WindowsCapture {
    fn send(&self, input: Input) {
        if let Some(sender) = &self.input {
            let _ = sender.send(input);
        }
    }
}

impl StreamCapture for WindowsCapture {
    fn set_quality(&mut self, quality: Option<u8>) {
        self.shared
            .quality
            .store(quality.unwrap_or(0).min(100), Ordering::SeqCst);
    }

    fn refresh(&mut self) {
        self.shared.refresh.store(true, Ordering::SeqCst);
    }

    fn move_to(&mut self, x: u32, y: u32) {
        self.send(Input::Move(x, y));
    }

    fn button(&mut self, button: MouseButton, down: bool, x: u32, y: u32) {
        self.send(Input::Button(button, down, x, y));
    }

    fn wheel(&mut self, direction: ScrollDirection, x: u32, y: u32) {
        self.send(Input::Wheel(direction, x, y));
    }

    fn key(&mut self, key: StreamKey) {
        if let Some(token) = stream_token(key) {
            self.send(Input::Key(key.down, token));
        }
    }

    fn set_clipboard(&mut self, text: String) {
        if let Some(sender) = &self.clipboard {
            let _ = sender.send(text);
        }
    }

    fn stop(&mut self) {
        self.shared.running.store(false, Ordering::SeqCst);
        // The input thread lets go of held keys and buttons once its channel closes.
        self.input = None;
        self.clipboard = None;
    }
}

impl Drop for WindowsCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

// MARK: Capture

struct Screen {
    canvas: Canvas,
    previous: Vec<u32>,
    /// Per tile: whether it last went out as JPEG, and when it last changed.
    lossy: Vec<bool>,
    changed_at: Vec<Instant>,
    was_secure: bool,
}

fn capture_loop(shared: &Shared, sink: &StreamSink) {
    win32::init_dpi_awareness();
    let mut screen: Option<Screen> = None;
    while shared.running() {
        let started = Instant::now();
        match capture_frame(shared, sink, &mut screen) {
            Ok(true) => {}
            Ok(false) => break,
            Err(error) => {
                (shared.warn)(&format!("Capture failed: {error}"));
                sleep(Duration::from_millis(500));
            }
        }
        sleep(
            FRAME
                .saturating_sub(started.elapsed())
                .max(Duration::from_millis(10)),
        );
    }
    shared.running.store(false, Ordering::SeqCst);
}

/// Sends what changed. `Ok(false)` once the server is gone.
fn capture_frame(
    shared: &Shared,
    sink: &StreamSink,
    screen: &mut Option<Screen>,
) -> Result<bool, String> {
    let (width, height) = screen_size();
    if width <= 0 || height <= 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
        sleep(Duration::from_millis(500));
        return Ok(true);
    }
    let mut full = shared.refresh.swap(false, Ordering::SeqCst);
    let tile = STREAM_TILE_SIZE as i32;
    if screen
        .as_ref()
        .is_none_or(|screen| screen.canvas.width != width || screen.canvas.height != height)
    {
        let tiles = (width as u32).div_ceil(STREAM_TILE_SIZE) as usize
            * (height as u32).div_ceil(STREAM_TILE_SIZE) as usize;
        *screen = Some(Screen {
            canvas: Canvas::new(width, height)?,
            previous: vec![0; width as usize * height as usize],
            lossy: vec![false; tiles],
            changed_at: vec![Instant::now(); tiles],
            was_secure: false,
        });
        if !sink.resize(width as u32, height as u32) {
            return Ok(false);
        }
        full = true;
    }
    let Some(screen) = screen.as_mut() else {
        return Ok(true);
    };
    let mut secure = !win32::input_desktop_name().eq_ignore_ascii_case("default");
    if !secure && screen.canvas.grab(0, 0).is_err() {
        secure = true;
    }
    if secure {
        let size = (height / 40).max(12);
        screen.canvas.draw_text(
            RECT {
                left: 0,
                top: 0,
                right: width,
                bottom: height,
            },
            (32, 32, 32),
            PLACEHOLDER,
            size,
        );
    } else {
        screen.canvas.draw_cursor();
        if shared.input_blocked_by().is_some() {
            let size = (height / 50).max(12);
            screen.canvas.draw_text(
                RECT {
                    left: 0,
                    top: 0,
                    right: width,
                    bottom: size * 13 / 5,
                },
                (178, 96, 16),
                INPUT_BLOCKED,
                size,
            );
        }
    }
    if secure != screen.was_secure {
        full = true;
    }
    screen.was_secure = secure;
    let current: Vec<u32> = screen
        .canvas
        .bgrx()
        .as_chunks::<4>()
        .0
        .iter()
        .map(|pixel| u32::from_le_bytes(*pixel))
        .collect();
    let quality = shared.quality.load(Ordering::SeqCst);
    let now = Instant::now();
    let mut sent = false;
    let mut index = 0;
    for ty in (0..height).step_by(tile as usize) {
        for tx in (0..width).step_by(tile as usize) {
            let rect = TileRect {
                x: tx as u32,
                y: ty as u32,
                width: tile.min(width - tx) as u32,
                height: tile.min(height - ty) as u32,
            };
            let changed = full || tile_changed(&current, &screen.previous, width, rect);
            let lossless_due =
                screen.lossy[index] && now - screen.changed_at[index] >= LOSSLESS_DELAY;
            if changed {
                copy_tile(&current, &mut screen.previous, width, rect);
                screen.changed_at[index] = now;
            }
            if changed || lossless_due {
                let jpeg = if changed && !full && !secure {
                    quality
                } else {
                    0
                };
                match send_tile(sink, &screen.previous, width, rect, jpeg)? {
                    Some(lossy) => screen.lossy[index] = lossy,
                    None => return Ok(false),
                }
                sent = true;
            }
            index += 1;
        }
    }
    Ok(!sent || sink.frame())
}

fn rows(width: i32, rect: TileRect) -> impl Iterator<Item = std::ops::Range<usize>> {
    (rect.y..rect.y + rect.height).map(move |y| {
        let start = y as usize * width as usize + rect.x as usize;
        start..start + rect.width as usize
    })
}

fn tile_changed(current: &[u32], previous: &[u32], width: i32, rect: TileRect) -> bool {
    rows(width, rect).any(|row| {
        current[row.clone()]
            .iter()
            .zip(&previous[row])
            .any(|(a, b)| (a ^ b) & 0x00ff_ffff != 0)
    })
}

fn copy_tile(from: &[u32], to: &mut [u32], width: i32, rect: TileRect) {
    for row in rows(width, rect) {
        to[row.clone()].copy_from_slice(&from[row]);
    }
}

/// Text and UI rarely use many colours per tile; every third pixel is enough
/// to tell.
fn photographic(pixels: &[u32], width: i32, rect: TileRect) -> bool {
    let mut colors = HashSet::new();
    let count = rect.width * rect.height;
    for i in (0..count).step_by(3) {
        let (x, y) = (rect.x + i % rect.width, rect.y + i / rect.width);
        colors.insert(pixels[y as usize * width as usize + x as usize] & 0x00ff_ffff);
        if colors.len() > PHOTO_COLORS {
            return true;
        }
    }
    false
}

/// Whether the tile went out as JPEG, or `None` once the server is gone.
fn send_tile(
    sink: &StreamSink,
    pixels: &[u32],
    width: i32,
    rect: TileRect,
    quality: u8,
) -> Result<Option<bool>, String> {
    let mut bgrx = Vec::with_capacity((rect.width * rect.height * 4) as usize);
    for row in rows(width, rect) {
        for pixel in &pixels[row] {
            bgrx.extend_from_slice(&pixel.to_le_bytes());
        }
    }
    if quality > 0 && photographic(pixels, width, rect) {
        let image = RgbImage::from_bgrx(rect.width, rect.height, rect.width as usize * 4, &bgrx);
        let jpeg = encode_jpeg(&image, quality)?;
        return Ok(sink.jpeg(rect, jpeg).then_some(true));
    }
    Ok(sink.raw(rect, bgrx).then_some(false))
}

// MARK: Clipboard

/// Clipboard writes need an owner window; a message-only one is enough.
struct ClipboardWindow(HWND);

impl ClipboardWindow {
    fn new() -> Self {
        let class = win32::wide("STATIC");
        // SAFETY: STATIC is a system class; the window is destroyed on drop.
        let window = unsafe {
            CreateWindowExW(
                0,
                class.as_ptr(),
                std::ptr::null(),
                0,
                0,
                0,
                0,
                0,
                HWND_MESSAGE,
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                std::ptr::null(),
            )
        };
        Self(window)
    }

    /// Opens the clipboard, retrying briefly while another process holds it.
    fn open(&self) -> Option<OpenClipboardGuard> {
        for attempt in 0..5 {
            if attempt > 0 {
                sleep(Duration::from_millis(20));
            }
            // SAFETY: plain call; closed by the guard.
            if unsafe { OpenClipboard(self.0) } != 0 {
                return Some(OpenClipboardGuard);
            }
        }
        None
    }
}

impl Drop for ClipboardWindow {
    fn drop(&mut self) {
        if !self.0.is_null() {
            // SAFETY: the window was created by this thread.
            unsafe { DestroyWindow(self.0) };
        }
    }
}

struct OpenClipboardGuard;

impl Drop for OpenClipboardGuard {
    fn drop(&mut self) {
        // SAFETY: the clipboard was opened by this thread.
        unsafe { CloseClipboard() };
    }
}

/// `false` when the text did not reach the clipboard, as while another
/// process holds it; the caller retries.
fn write_clipboard(window: &ClipboardWindow, text: &str) -> bool {
    let units: Vec<u16> = text.encode_utf16().chain(Some(0)).collect();
    // SAFETY: the global block is sized for `units`, and ownership passes to
    // the clipboard only when SetClipboardData succeeds; it is freed on every
    // other path.
    unsafe {
        // Prepared before emptying, so a failure leaves the clipboard as it was.
        let memory = if text.is_empty() {
            std::ptr::null_mut()
        } else {
            let memory = GlobalAlloc(GMEM_MOVEABLE, units.len() * 2);
            if memory.is_null() {
                return false;
            }
            let target = GlobalLock(memory).cast::<u16>();
            if target.is_null() {
                GlobalFree(memory);
                return false;
            }
            std::ptr::copy_nonoverlapping(units.as_ptr(), target, units.len());
            GlobalUnlock(memory);
            memory
        };
        let written = match window.open() {
            Some(_open) => {
                EmptyClipboard() != 0
                    && (memory.is_null() || !SetClipboardData(CF_UNICODETEXT, memory).is_null())
            }
            None => false,
        };
        if !written && !memory.is_null() {
            GlobalFree(memory);
        }
        written
    }
}

/// The clipboard's text, empty without any, or `None` while another
/// process holds it.
fn read_clipboard(window: &ClipboardWindow) -> Option<String> {
    // SAFETY: plain call.
    if unsafe { IsClipboardFormatAvailable(CF_UNICODETEXT) } == 0 {
        return Some(String::new());
    }
    let _open = window.open()?;
    // SAFETY: the clipboard is open; the handle stays valid until it closes,
    // and reads stay within the block's size.
    unsafe {
        let memory = GetClipboardData(CF_UNICODETEXT);
        if memory.is_null() {
            return Some(String::new());
        }
        let source = GlobalLock(memory).cast::<u16>();
        if source.is_null() {
            return Some(String::new());
        }
        let units = std::slice::from_raw_parts(source, GlobalSize(memory) / 2);
        let length = units
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units.len());
        let text = String::from_utf16_lossy(&units[..length]);
        GlobalUnlock(memory);
        Some(text)
    }
}

fn clipboard_loop(shared: &Shared, sink: &StreamSink, viewer: &Receiver<String>) {
    let window = ClipboardWindow::new();
    let mut pending: Option<String> = None;
    let mut seen: Option<u32> = None;
    while shared.running() {
        if let Some(text) = pending.take() {
            if write_clipboard(&window, &text) {
                // SAFETY: plain call.
                seen = Some(unsafe { GetClipboardSequenceNumber() });
            } else {
                pending = Some(text);
            }
        }
        // SAFETY: plain call.
        let sequence = unsafe { GetClipboardSequenceNumber() };
        if seen != Some(sequence)
            && let Some(text) = read_clipboard(&window)
        {
            seen = Some(sequence);
            if !text.is_empty() && text.len() <= MAX_CLIPBOARD_BYTES && !sink.clipboard(text) {
                break;
            }
        }
        match viewer.recv_timeout(CLIPBOARD_POLL) {
            Ok(text) => pending = Some(viewer.try_iter().last().unwrap_or(text)),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
    }
}

// MARK: Input

#[derive(Default)]
struct InputState {
    held_keys: Vec<StreamToken>,
    /// Characters pressed as virtual keys for a shortcut go up the same way.
    held_character_keys: Vec<(StreamToken, u16)>,
    held_buttons: Vec<MouseButton>,
    pointer: Option<(i32, i32)>,
}

impl InputState {
    fn move_to(&mut self, x: i32, y: i32) {
        if self.pointer == Some((x, y)) {
            return;
        }
        self.pointer = Some((x, y));
        let _ = win32::move_to(x, y);
    }

    fn button(&mut self, button: MouseButton, down: bool, x: i32, y: i32) {
        let held = self.held_buttons.contains(&button);
        if !down && !held {
            return;
        }
        self.move_to(x, y);
        if down && !held {
            self.held_buttons.push(button);
        } else if !down {
            self.held_buttons.retain(|other| *other != button);
        }
        let (press, release) = button_flags(button);
        try_send(&[mouse(if down { press } else { release }, 0, 0, 0)]);
    }

    fn shortcut_held(&self) -> bool {
        self.held_keys
            .iter()
            .any(|token| token.is_shortcut_modifier())
    }

    fn key(&mut self, down: bool, token: StreamToken) {
        let up = if down { 0 } else { KEYEVENTF_KEYUP };
        match token {
            StreamToken::Scan(code) => try_send(&[keyboard(0, code, KEYEVENTF_SCANCODE | up)]),
            StreamToken::Extended(code) => try_send(&[keyboard(
                0,
                code,
                KEYEVENTF_SCANCODE | KEYEVENTF_EXTENDEDKEY | up,
            )]),
            StreamToken::Virtual(vk) => {
                let flags = if extended(vk) {
                    KEYEVENTF_EXTENDEDKEY
                } else {
                    0
                };
                try_send(&[keyboard(vk, scan_code(vk), flags | up)]);
            }
            StreamToken::Character(code) => {
                let Some(character) = char::from_u32(code) else {
                    return;
                };
                let mut buffer = [0u16; 2];
                let units = character.encode_utf16(&mut buffer);
                let vk = if down {
                    let vk = match units {
                        [unit] if self.shortcut_held() => {
                            // SAFETY: plain call.
                            let scan = unsafe { VkKeyScanW(*unit) };
                            (scan != -1).then_some((scan & 0xff) as u16)
                        }
                        _ => None,
                    };
                    if let Some(vk) = vk {
                        self.held_character_keys.push((token, vk));
                    }
                    vk
                } else {
                    self.held_character_keys
                        .iter()
                        .position(|(held, _)| *held == token)
                        .map(|at| self.held_character_keys.remove(at).1)
                };
                match vk {
                    Some(vk) => try_send(&[keyboard(vk, scan_code(vk), up)]),
                    None => {
                        for unit in units.iter() {
                            try_send(&[unicode(*unit, !down)]);
                        }
                    }
                }
            }
        }
        if down {
            if !self.held_keys.contains(&token) {
                self.held_keys.push(token);
            }
        } else {
            self.held_keys.retain(|held| *held != token);
        }
    }

    fn release_all(&mut self) {
        while let Some(token) = self.held_keys.last().copied() {
            self.key(false, token);
        }
        let (x, y) = self.pointer.unwrap_or((0, 0));
        for button in self.held_buttons.clone() {
            self.button(button, false, x, y);
        }
    }
}

fn coordinate(value: u32) -> i32 {
    i32::try_from(value).unwrap_or(i32::MAX)
}

fn input_loop(shared: &Shared, inputs: &Receiver<Input>) {
    win32::init_dpi_awareness();
    let mut state = InputState::default();
    while let Ok(input) = inputs.recv() {
        shared.input_blocked_by();
        match input {
            Input::Move(x, y) => state.move_to(coordinate(x), coordinate(y)),
            Input::Button(button, down, x, y) => {
                state.button(button, down, coordinate(x), coordinate(y));
            }
            Input::Wheel(direction, x, y) => {
                state.move_to(coordinate(x), coordinate(y));
                try_send(&[wheel(direction)]);
            }
            Input::Key(down, token) => state.key(down, token),
        }
    }
    state.release_all();
}
