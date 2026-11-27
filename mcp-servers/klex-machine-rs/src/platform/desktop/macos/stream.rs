//! The RFB stream source: the main display through ScreenCaptureKit as
//! 128-pixel tiles, viewer input as Quartz events, and the general
//! pasteboard. The framebuffer is in points, so input needs no scaling on
//! Retina displays and bandwidth stays near that of a non-Retina screen.

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use dispatch2::{DispatchQueue, DispatchRetained};
use objc2_app_kit::{NSEvent, NSPasteboard, NSPasteboardTypeString};
use objc2_core_foundation::CGPoint;
use objc2_core_graphics::{CGDisplayBounds, CGMainDisplayID};
use objc2_foundation::NSString;

use super::super::macos_keys::{StreamKeyAction, stream_key_action, stream_modifier_flag};
use super::capture::{self, Capture, Frame, MAX_DIMENSION, StreamSettings};
use super::input::{Input, button_events};
use super::system::{SCREEN_RECORDING_MISSING, require_accessibility, screen_recording_allowed};
use super::threads::{main_async, on_main_blocking};
use crate::desktop::image::{RgbImage, encode_jpeg};
use crate::desktop::provider::{MouseButton, ScrollDirection};
use crate::desktop::rfb::clipboard::MAX_CLIPBOARD_BYTES;
use crate::desktop::rfb::{
    STREAM_TILE_SIZE, StreamBackend, StreamCapture, StreamKey, StreamSink, TileRect,
};

const TILE: usize = STREAM_TILE_SIZE as usize;
/// Tiles with more colours than this in a sample are sent as JPEG.
const PHOTO_COLOR_THRESHOLD: usize = 64;
/// JPEG tiles unchanged for this long are sent again losslessly.
const LOSSLESS_DELAY: Duration = Duration::from_millis(1_500);
const TICK: Duration = Duration::from_millis(500);
const CLIPBOARD_POLL: Duration = Duration::from_millis(250);
const FRAMES_PER_SECOND: i32 = 15;

pub struct MacosStreamBackend;

impl StreamBackend for MacosStreamBackend {
    fn start(&self, sink: StreamSink) -> Result<Box<dyn StreamCapture>, String> {
        if !screen_recording_allowed() {
            return Err(SCREEN_RECORDING_MISSING.into());
        }
        require_accessibility()?;
        let shared = Arc::new(Shared::default());
        let queue = DispatchQueue::new("klex.stream.capture", None);
        let tiles = Arc::new(Mutex::new(Tiles::new(sink.clone(), shared.clone())));
        let running: Arc<Mutex<Option<Capture>>> = Arc::default();

        spawn("klex-stream-capture", {
            let (sink, shared, queue, tiles, running) = (
                sink.clone(),
                shared.clone(),
                queue.clone(),
                tiles.clone(),
                running.clone(),
            );
            move || start_capture(sink, shared, queue, tiles, running)
        });
        spawn("klex-stream-tick", {
            let (shared, queue, tiles, running) = (
                shared.clone(),
                queue.clone(),
                tiles.clone(),
                running.clone(),
            );
            move || tick_loop(shared, queue, tiles, running)
        });
        let (input, commands) = mpsc::channel();
        spawn("klex-stream-input", {
            let shared = shared.clone();
            move || StreamInput::new(shared).run(commands)
        });
        let (clipboard, texts) = mpsc::channel();
        spawn("klex-stream-clipboard", {
            let sink = sink.clone();
            move || clipboard_loop(sink, texts)
        });
        Ok(Box::new(MacosCapture {
            shared,
            queue,
            tiles,
            running,
            input: Some(input),
            clipboard: Some(clipboard),
        }))
    }
}

fn spawn(name: &str, work: impl FnOnce() + Send + 'static) {
    let _ = std::thread::Builder::new().name(name.into()).spawn(work);
}

#[derive(Default)]
struct Shared {
    stopped: AtomicBool,
    /// Framebuffer width << 32 | height, for mapping viewer coordinates.
    frame_size: AtomicU64,
}

impl Shared {
    fn frame_size(&self) -> (u32, u32) {
        let packed = self.frame_size.load(Ordering::SeqCst);
        ((packed >> 32) as u32, packed as u32)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn point_settings() -> (StreamSettings, (f64, f64)) {
    let bounds = CGDisplayBounds(CGMainDisplayID());
    let size = (bounds.size.width, bounds.size.height);
    (
        StreamSettings {
            width: (size.0 as usize).clamp(1, MAX_DIMENSION),
            height: (size.1 as usize).clamp(1, MAX_DIMENSION),
            shows_cursor: true,
            frames_per_second: FRAMES_PER_SECOND,
        },
        size,
    )
}

fn start_capture(
    sink: StreamSink,
    shared: Arc<Shared>,
    queue: DispatchRetained<DispatchQueue>,
    tiles: Arc<Mutex<Tiles>>,
    running: Arc<Mutex<Option<Capture>>>,
) {
    let display = match capture::main_display() {
        Ok(display) => display,
        Err(error) => return sink.ended(Some(error)),
    };
    let on_frame = {
        let tiles = tiles.clone();
        Box::new(move |frame: Frame<'_>| lock(&tiles).process(frame))
    };
    let on_stop = {
        let (sink, shared) = (sink.clone(), shared.clone());
        Box::new(move |error: String| {
            if !shared.stopped.load(Ordering::SeqCst) {
                sink.ended(Some(format!("Screen capture stopped: {error}")));
            }
        })
    };
    let (settings, _) = point_settings();
    match Capture::start(&display, settings, queue, on_frame, on_stop) {
        Ok(capture) => {
            let mut slot = lock(&running);
            if shared.stopped.load(Ordering::SeqCst) {
                capture.stop();
            } else {
                *slot = Some(capture);
            }
        }
        Err(error) => sink.ended(Some(error)),
    }
}

/// Re-sends settled JPEG tiles losslessly and follows display size changes.
fn tick_loop(
    shared: Arc<Shared>,
    queue: DispatchRetained<DispatchQueue>,
    tiles: Arc<Mutex<Tiles>>,
    running: Arc<Mutex<Option<Capture>>>,
) {
    let (_, mut configured) = point_settings();
    while !shared.stopped.load(Ordering::SeqCst) {
        std::thread::sleep(TICK);
        let (settings, size) = point_settings();
        if size != configured
            && let Some(capture) = lock(&running).as_ref()
        {
            configured = size;
            capture.reconfigure(settings);
        }
        let tiles = tiles.clone();
        queue.exec_async(move || lock(&tiles).settle());
    }
}

/// The last frame and what each tile was sent as. Touched on the capture
/// queue only.
struct Tiles {
    sink: StreamSink,
    shared: Arc<Shared>,
    width: usize,
    height: usize,
    pixels: Vec<u8>,
    lossy: Vec<bool>,
    changed_at: Vec<Instant>,
    quality: Option<u8>,
}

impl Tiles {
    fn new(sink: StreamSink, shared: Arc<Shared>) -> Self {
        Self {
            sink,
            shared,
            width: 0,
            height: 0,
            pixels: Vec::new(),
            lossy: Vec::new(),
            changed_at: Vec::new(),
            quality: None,
        }
    }

    fn rects(&self) -> Vec<(usize, TileRect)> {
        let mut rects = Vec::new();
        for y in (0..self.height).step_by(TILE) {
            for x in (0..self.width).step_by(TILE) {
                rects.push((
                    rects.len(),
                    TileRect {
                        x: x as u32,
                        y: y as u32,
                        width: TILE.min(self.width - x) as u32,
                        height: TILE.min(self.height - y) as u32,
                    },
                ));
            }
        }
        rects
    }

    fn resize(&mut self, width: usize, height: usize) {
        self.width = width;
        self.height = height;
        self.pixels = vec![0; width * height * 4];
        let count = width.div_ceil(TILE) * height.div_ceil(TILE);
        self.lossy = vec![false; count];
        self.changed_at = vec![Instant::now(); count];
        self.shared
            .frame_size
            .store((width as u64) << 32 | height as u64, Ordering::SeqCst);
        self.sink.resize(width as u32, height as u32);
    }

    fn process(&mut self, frame: Frame<'_>) {
        if self.shared.stopped.load(Ordering::SeqCst) {
            return;
        }
        let resized = frame.width != self.width || frame.height != self.height;
        if resized {
            self.resize(frame.width, frame.height);
        }
        let row_bytes = self.width * 4;
        let now = Instant::now();
        let mut sent = false;
        for (index, rect) in self.rects() {
            let (x, y) = (rect.x as usize, rect.y as usize);
            let (w, h) = (rect.width as usize, rect.height as usize);
            let span = |row: usize| {
                (y + row) * frame.stride + x * 4..(y + row) * frame.stride + (x + w) * 4
            };
            let ours =
                |row: usize| (y + row) * row_bytes + x * 4..(y + row) * row_bytes + (x + w) * 4;
            let changed =
                resized || (0..h).any(|row| frame.bytes[span(row)] != self.pixels[ours(row)]);
            if !changed {
                continue;
            }
            for row in 0..h {
                self.pixels[ours(row)].copy_from_slice(&frame.bytes[span(row)]);
            }
            self.changed_at[index] = now;
            self.send_tile(index, rect, false);
            sent = true;
        }
        if sent {
            self.sink.frame();
        }
    }

    fn tile_pixels(&self, rect: TileRect) -> Vec<u8> {
        let row_bytes = self.width * 4;
        let (x, w) = (rect.x as usize, rect.width as usize);
        let mut out = Vec::with_capacity(w * rect.height as usize * 4);
        for row in rect.y as usize..(rect.y + rect.height) as usize {
            out.extend_from_slice(
                &self.pixels[row * row_bytes + x * 4..row * row_bytes + (x + w) * 4],
            );
        }
        out
    }

    fn send_tile(&mut self, index: usize, rect: TileRect, lossless: bool) {
        let tile = self.tile_pixels(rect);
        if !lossless
            && let Some(quality) = self.quality
            && is_photographic(&tile)
        {
            let image =
                RgbImage::from_bgrx(rect.width, rect.height, rect.width as usize * 4, &tile);
            if let Ok(jpeg) = encode_jpeg(&image, quality) {
                self.sink.jpeg(rect, jpeg);
                self.lossy[index] = true;
                return;
            }
        }
        self.sink.raw(rect, tile);
        self.lossy[index] = false;
    }

    fn refresh(&mut self) {
        if self.width == 0 {
            return;
        }
        for (index, rect) in self.rects() {
            self.send_tile(index, rect, true);
        }
        self.sink.frame();
    }

    fn settle(&mut self) {
        let now = Instant::now();
        let mut sent = false;
        for (index, rect) in self.rects() {
            if self.lossy[index] && now.duration_since(self.changed_at[index]) >= LOSSLESS_DELAY {
                self.send_tile(index, rect, true);
                sent = true;
            }
        }
        if sent {
            self.sink.frame();
        }
    }
}

/// Samples every third pixel; text and UI rarely use many colours per tile.
fn is_photographic(tile: &[u8]) -> bool {
    let mut colors = HashSet::new();
    for pixel in tile.as_chunks::<4>().0.iter().step_by(3) {
        colors.insert([pixel[0], pixel[1], pixel[2]]);
        if colors.len() > PHOTO_COLOR_THRESHOLD {
            return true;
        }
    }
    false
}

enum Command {
    Move(u32, u32),
    Button(MouseButton, bool, u32, u32),
    Wheel(ScrollDirection, u32, u32),
    Key(StreamKey),
}

/// Press and release stay separate events, so viewers can hold keys, drag,
/// and repeat clicks themselves.
struct StreamInput {
    shared: Arc<Shared>,
    input: Input,
    double_click: Duration,
    held_keys: Vec<u16>,
    /// Characters without a key code; their events still carry code 0.
    held_characters: Vec<char>,
    held_buttons: Vec<MouseButton>,
    last_point: CGPoint,
    last_down: Option<(MouseButton, Instant, CGPoint, i64)>,
}

impl StreamInput {
    fn new(shared: Arc<Shared>) -> Self {
        let interval =
            on_main_blocking(MAIN_THREAD_TIMEOUT, NSEvent::doubleClickInterval).unwrap_or(0.5);
        Self {
            shared,
            input: Input::new(),
            double_click: Duration::from_secs_f64(if interval.is_finite() && interval > 0.0 {
                interval
            } else {
                0.5
            }),
            held_keys: Vec::new(),
            held_characters: Vec::new(),
            held_buttons: Vec::new(),
            last_point: CGPoint::new(0.0, 0.0),
            last_down: None,
        }
    }

    fn run(mut self, commands: Receiver<Command>) {
        while let Ok(command) = commands.recv() {
            match command {
                Command::Move(x, y) => {
                    if let Some(point) = self.location(x, y) {
                        self.move_to(point);
                    }
                }
                Command::Button(button, down, x, y) => {
                    if let Some(point) = self.location(x, y) {
                        self.button(button, down, point);
                    }
                }
                Command::Wheel(direction, x, y) => {
                    if let Some(point) = self.location(x, y) {
                        self.last_point = point;
                        self.input.wheel(direction, 2, self.flags());
                    }
                }
                Command::Key(key) => self.key(key),
            }
        }
        for button in self.held_buttons.clone() {
            self.button(button, false, self.last_point);
        }
        for character in std::mem::take(&mut self.held_characters) {
            self.input.unicode_event(character, false, self.flags());
        }
        for code in self.held_keys.clone().into_iter().rev() {
            self.key_code(code, false);
        }
    }

    fn flags(&self) -> u64 {
        self.held_keys
            .iter()
            .filter_map(|code| stream_modifier_flag(*code))
            .fold(0, |flags, flag| flags | flag)
    }

    fn location(&self, x: u32, y: u32) -> Option<CGPoint> {
        let (width, height) = self.shared.frame_size();
        if width == 0 || height == 0 {
            return None;
        }
        let bounds = CGDisplayBounds(CGMainDisplayID());
        Some(CGPoint::new(
            bounds.origin.x + f64::from(x) * bounds.size.width / f64::from(width),
            bounds.origin.y + f64::from(y) * bounds.size.height / f64::from(height),
        ))
    }

    fn move_to(&mut self, point: CGPoint) {
        self.last_point = point;
        let held = [MouseButton::Left, MouseButton::Right, MouseButton::Middle]
            .into_iter()
            .find(|button| self.held_buttons.contains(button));
        match held {
            Some(button) => {
                let events = button_events(button);
                self.input
                    .mouse_event(events.dragged, point, events.button, self.flags(), None);
            }
            None => self.input.mouse_event(
                objc2_core_graphics::CGEventType::MouseMoved,
                point,
                objc2_core_graphics::CGMouseButton::Left,
                self.flags(),
                None,
            ),
        }
    }

    fn button(&mut self, button: MouseButton, down: bool, point: CGPoint) {
        self.last_point = point;
        let mut count = 1;
        if down {
            let now = Instant::now();
            if let Some((last, at, last_point, last_count)) = self.last_down
                && last == button
                && now.duration_since(at) <= self.double_click
                && (last_point.x - point.x).abs() <= 4.0
                && (last_point.y - point.y).abs() <= 4.0
            {
                count = last_count + 1;
            }
            self.last_down = Some((button, now, point, count));
            if !self.held_buttons.contains(&button) {
                self.held_buttons.push(button);
            }
        } else {
            let Some(index) = self.held_buttons.iter().position(|held| *held == button) else {
                return;
            };
            self.held_buttons.remove(index);
            if let Some((last, _, _, last_count)) = self.last_down
                && last == button
            {
                count = last_count;
            }
        }
        let events = button_events(button);
        self.input.mouse_event(
            if down { events.down } else { events.up },
            point,
            events.button,
            self.flags(),
            Some(count),
        );
    }

    fn key_code(&mut self, code: u16, down: bool) {
        if code >= 128 {
            return;
        }
        if down {
            if !self.held_keys.contains(&code) {
                self.held_keys.push(code);
            }
        } else {
            self.held_keys.retain(|held| *held != code);
        }
        self.input.key_event(code, down, self.flags());
    }

    fn key(&mut self, key: StreamKey) {
        match stream_key_action(key) {
            Some(StreamKeyAction::Code(code)) => self.key_code(code, key.down),
            Some(StreamKeyAction::Unicode(code_point)) => {
                if let Some(character) = char::from_u32(code_point) {
                    if key.down {
                        if !self.held_characters.contains(&character) {
                            self.held_characters.push(character);
                        }
                    } else {
                        self.held_characters.retain(|held| *held != character);
                    }
                    self.input.unicode_event(character, key.down, self.flags());
                }
            }
            None => {}
        }
    }
}

const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(2);

/// The pasteboard change count last reported or written. Only main-thread
/// blocks touch it, so writes and polls apply in order even when the main
/// thread is slow.
type LastChange = Arc<Mutex<Option<isize>>>;

fn poll_pasteboard(sink: &StreamSink, last: &LastChange, writes: &AtomicUsize, initial: bool) {
    // A queued viewer write wins over whatever the pasteboard holds now.
    if writes.load(Ordering::SeqCst) > 0 {
        return;
    }
    let pasteboard = NSPasteboard::generalPasteboard();
    let count = pasteboard.changeCount();
    let mut last = lock(last);
    if !initial && *last == Some(count) {
        return;
    }
    *last = Some(count);
    // SAFETY: a static NSString.
    let kind = unsafe { NSPasteboardTypeString };
    if let Some(text) = pasteboard.stringForType(kind).map(|text| text.to_string())
        && !text.is_empty()
        && text.len() <= MAX_CLIPBOARD_BYTES
    {
        sink.clipboard(text);
    }
}

fn write_pasteboard(text: &str, last: &LastChange) {
    // SAFETY: a static NSString.
    let kind = unsafe { NSPasteboardTypeString };
    let pasteboard = NSPasteboard::generalPasteboard();
    pasteboard.clearContents();
    pasteboard.setString_forType(&NSString::from_str(text), kind);
    *lock(last) = Some(pasteboard.changeCount());
}

/// Reports clipboard text at start and on every change, and sets it for
/// viewers without echoing it back. Pasteboard access runs on the main
/// thread, as AppKit requires; this thread only paces it.
fn clipboard_loop(sink: StreamSink, texts: Receiver<String>) {
    let last = LastChange::default();
    let writes = Arc::new(AtomicUsize::new(0));
    let polling = Arc::new(AtomicBool::new(true));
    main_async({
        let (sink, last, writes, polling) =
            (sink.clone(), last.clone(), writes.clone(), polling.clone());
        move || {
            poll_pasteboard(&sink, &last, &writes, true);
            polling.store(false, Ordering::SeqCst);
        }
    });
    loop {
        match texts.recv_timeout(CLIPBOARD_POLL) {
            Ok(text) => {
                let (last, writes) = (last.clone(), writes.clone());
                writes.fetch_add(1, Ordering::SeqCst);
                main_async(move || {
                    write_pasteboard(&text, &last);
                    writes.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(RecvTimeoutError::Timeout) => {
                if polling.swap(true, Ordering::SeqCst) {
                    continue;
                }
                let (sink, last, writes, polling) =
                    (sink.clone(), last.clone(), writes.clone(), polling.clone());
                main_async(move || {
                    poll_pasteboard(&sink, &last, &writes, false);
                    polling.store(false, Ordering::SeqCst);
                });
            }
            Err(RecvTimeoutError::Disconnected) => return,
        }
    }
}

struct MacosCapture {
    shared: Arc<Shared>,
    queue: DispatchRetained<DispatchQueue>,
    tiles: Arc<Mutex<Tiles>>,
    running: Arc<Mutex<Option<Capture>>>,
    input: Option<Sender<Command>>,
    clipboard: Option<Sender<String>>,
}

impl MacosCapture {
    fn send(&self, command: Command) {
        if let Some(input) = &self.input {
            let _ = input.send(command);
        }
    }
}

impl StreamCapture for MacosCapture {
    fn set_quality(&mut self, quality: Option<u8>) {
        let tiles = self.tiles.clone();
        self.queue.exec_async(move || {
            lock(&tiles).quality = quality.map(|quality| quality.clamp(1, 100))
        });
    }

    fn refresh(&mut self) {
        let tiles = self.tiles.clone();
        self.queue.exec_async(move || lock(&tiles).refresh());
    }

    fn move_to(&mut self, x: u32, y: u32) {
        self.send(Command::Move(x, y));
    }

    fn button(&mut self, button: MouseButton, down: bool, x: u32, y: u32) {
        self.send(Command::Button(button, down, x, y));
    }

    fn wheel(&mut self, direction: ScrollDirection, x: u32, y: u32) {
        self.send(Command::Wheel(direction, x, y));
    }

    fn key(&mut self, key: StreamKey) {
        self.send(Command::Key(key));
    }

    fn set_clipboard(&mut self, text: String) {
        if let Some(clipboard) = &self.clipboard {
            let _ = clipboard.send(text);
        }
    }

    fn stop(&mut self) {
        self.shared.stopped.store(true, Ordering::SeqCst);
        self.input = None;
        self.clipboard = None;
        if let Some(capture) = lock(&self.running).take() {
            capture.stop();
        }
    }
}

impl Drop for MacosCapture {
    fn drop(&mut self) {
        self.stop();
    }
}
