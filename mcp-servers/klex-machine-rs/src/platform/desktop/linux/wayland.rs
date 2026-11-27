//! The Wayland desktop through xdg-desktop-portal: screenshots from the
//! screen cast, input through the remote desktop portal, and the built-in
//! RFB stream fed by both. Wayland gives clients no view of other windows, so
//! there is no window list, focus or accessibility tree.

use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use tokio::io::DuplexStream;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use super::keys;
use super::portal::{self, BTN_LEFT, BTN_MIDDLE, BTN_RIGHT, Input, Portal, Remote};
use crate::desktop::Warn;
use crate::desktop::image::RgbImage;
use crate::desktop::provider::{
    CaptureOptions, DesktopCapabilities, DesktopFuture, DesktopProvider, DesktopWindow,
    LaunchOptions, MouseButton, Point, Region, ScreenSize, ScrollDirection,
};
use crate::desktop::rfb::tiles::{FrameRef, TileSender};
use crate::desktop::rfb::{RfbServer, StreamBackend, StreamCapture, StreamKey, StreamSink};

const CLICK_HOLD: Duration = Duration::from_millis(12);
const CLICK_GAP: Duration = Duration::from_millis(80);
const DRAG_PAUSE: Duration = Duration::from_millis(50);
const SCROLL_GAP: Duration = Duration::from_millis(30);
const TYPE_DELAY: Duration = Duration::from_millis(12);
const KEY_DELAY: Duration = Duration::from_millis(40);
const FRAME: Duration = Duration::from_millis(100);

const NO_WINDOWS: &str = "Wayland does not let klex-machine list or focus windows. Use desktop_screenshot to find a window and click it instead.";

pub struct WaylandDesktopProvider {
    portal: Arc<Portal>,
    /// For X11 apps under XWayland, passed on to launched processes.
    display: Option<String>,
    warn: Warn,
    stream: Mutex<Option<Arc<RfbServer>>>,
}

impl WaylandDesktopProvider {
    pub fn new(portal: Arc<Portal>, display: Option<String>, warn: Warn) -> Self {
        Self {
            portal,
            display,
            warn,
            stream: Mutex::new(None),
        }
    }

    fn remote(&self) -> Result<Arc<dyn Remote>, String> {
        self.portal.remote()
    }

    fn stream_server(&self) -> Arc<RfbServer> {
        let mut stream = self
            .stream
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        stream
            .get_or_insert_with(|| {
                let warn = self.warn.clone();
                Arc::new(
                    RfbServer::new(
                        Arc::new(WaylandStreamBackend {
                            portal: self.portal.clone(),
                            warn: self.warn.clone(),
                        }),
                        crate::platform::host::hostname(),
                    )
                    .on_error(Arc::new(move |error: &str| {
                        warn(error.trim_end_matches('.'))
                    })),
                )
            })
            .clone()
    }
}

fn frame_size(remote: &dyn Remote) -> Result<ScreenSize, String> {
    let frame = remote
        .latest()
        .ok_or("The screen stream has no picture yet")?;
    Ok(ScreenSize {
        width: frame.width.into(),
        height: frame.height.into(),
    })
}

fn capture(remote: &dyn Remote, options: CaptureOptions) -> Result<Vec<u8>, String> {
    let frame = remote
        .latest()
        .ok_or("The screen stream has no picture yet")?;
    let (width, height) = (i64::from(frame.width), i64::from(frame.height));
    let region = options.region.unwrap_or(Region {
        x: 0,
        y: 0,
        width,
        height,
    });
    let x = region.x.clamp(0, width - 1);
    let y = region.y.clamp(0, height - 1);
    let region_width = region.width.clamp(1, width - x);
    let region_height = region.height.clamp(1, height - y);
    let start = (y as usize * frame.width as usize + x as usize) * 4;
    let mut image = RgbImage::from_bgrx(
        region_width as u32,
        region_height as u32,
        frame.width as usize * 4,
        &frame.bgrx[start..],
    );
    if let Some(size) = options.size {
        image = image.resized(size);
    }
    image.encode(options.format)
}

fn evdev_button(button: MouseButton) -> i32 {
    match button {
        MouseButton::Left => BTN_LEFT,
        MouseButton::Middle => BTN_MIDDLE,
        MouseButton::Right => BTN_RIGHT,
    }
}

fn axis(direction: ScrollDirection) -> Input {
    match direction {
        ScrollDirection::Up => Input::Axis {
            vertical: true,
            steps: -1,
        },
        ScrollDirection::Down => Input::Axis {
            vertical: true,
            steps: 1,
        },
        ScrollDirection::Left => Input::Axis {
            vertical: false,
            steps: -1,
        },
        ScrollDirection::Right => Input::Axis {
            vertical: false,
            steps: 1,
        },
    }
}

fn motion(point: Point) -> Input {
    Input::Motion(point.x as f64, point.y as f64)
}

fn keysym_of(name: &str) -> Result<u32, String> {
    keys::keysym(name).ok_or_else(|| format!("Unsupported key name: {name}"))
}

/// Presses `keysyms` in order, then releases them in reverse; every release
/// is sent even when a press failed.
async fn tap(remote: &dyn Remote, keysyms: &[u32], delay: Duration) -> Result<(), String> {
    let mut pressed = 0;
    let mut outcome = Ok(());
    for &keysym in keysyms {
        outcome = remote.input(Input::Keysym(keysym, true)).await;
        if outcome.is_err() {
            break;
        }
        pressed += 1;
    }
    tokio::time::sleep(delay / 2).await;
    for &keysym in keysyms[..pressed].iter().rev() {
        let released = remote.input(Input::Keysym(keysym, false)).await;
        outcome = outcome.and(released);
    }
    tokio::time::sleep(delay / 2).await;
    outcome
}

impl DesktopProvider for WaylandDesktopProvider {
    fn probe(&self) -> BoxFuture<'_, DesktopCapabilities> {
        async move {
            match self.remote().and_then(|remote| frame_size(&*remote)) {
                Ok(screen) => DesktopCapabilities {
                    computer_use: true,
                    stream: true,
                    accessibility: false,
                    screen: Some(screen),
                    hint: None,
                },
                Err(hint) => DesktopCapabilities::unavailable(hint),
            }
        }
        .boxed()
    }

    fn screen_size(&self) -> DesktopFuture<'_, ScreenSize> {
        async move { frame_size(&*self.remote()?) }.boxed()
    }

    fn capture(&self, options: CaptureOptions) -> DesktopFuture<'_, Vec<u8>> {
        async move {
            let remote = self.remote()?;
            tokio::task::spawn_blocking(move || capture(&*remote, options))
                .await
                .map_err(|_| "Screen capture failed".to_string())?
        }
        .boxed()
    }

    fn click(
        &self,
        point: Point,
        button: MouseButton,
        count: u32,
        modifiers: Vec<String>,
    ) -> DesktopFuture<'_, ()> {
        async move {
            let remote = self.remote()?;
            let held = modifiers
                .iter()
                .map(|modifier| keysym_of(&keys::to_xdotool_modifier(modifier)?))
                .collect::<Result<Vec<_>, _>>()?;
            let mut pressed = 0;
            let mut outcome = Ok(());
            for &keysym in &held {
                outcome = remote.input(Input::Keysym(keysym, true)).await;
                if outcome.is_err() {
                    break;
                }
                pressed += 1;
            }
            if outcome.is_ok() {
                let code = evdev_button(button);
                let mut down = false;
                outcome = async {
                    remote.input(motion(point)).await?;
                    for index in 0..count {
                        if index > 0 {
                            tokio::time::sleep(CLICK_GAP).await;
                        }
                        remote.input(Input::Button(code, true)).await?;
                        down = true;
                        tokio::time::sleep(CLICK_HOLD).await;
                        remote.input(Input::Button(code, false)).await?;
                        down = false;
                    }
                    Ok(())
                }
                .await;
                if down {
                    let released = remote.input(Input::Button(code, false)).await;
                    outcome = outcome.and(released);
                }
            }
            for &keysym in held[..pressed].iter().rev() {
                let released = remote.input(Input::Keysym(keysym, false)).await;
                outcome = outcome.and(released);
            }
            outcome
        }
        .boxed()
    }

    fn drag(&self, from: Point, to: Point, button: MouseButton) -> DesktopFuture<'_, ()> {
        let middle = Point {
            x: ((from.x + to.x) as f64 / 2.0).round() as i64,
            y: ((from.y + to.y) as f64 / 2.0).round() as i64,
        };
        async move {
            let remote = self.remote()?;
            let code = evdev_button(button);
            remote.input(motion(from)).await?;
            remote.input(Input::Button(code, true)).await?;
            let moved = async {
                for point in [middle, to] {
                    tokio::time::sleep(DRAG_PAUSE).await;
                    remote.input(motion(point)).await?;
                }
                tokio::time::sleep(DRAG_PAUSE).await;
                Ok::<_, String>(())
            }
            .await;
            let released = remote.input(Input::Button(code, false)).await;
            moved.and(released)
        }
        .boxed()
    }

    fn move_to(&self, point: Point) -> DesktopFuture<'_, ()> {
        async move { self.remote()?.input(motion(point)).await }.boxed()
    }

    fn scroll(
        &self,
        point: Point,
        direction: ScrollDirection,
        amount: u32,
    ) -> DesktopFuture<'_, ()> {
        async move {
            let remote = self.remote()?;
            remote.input(motion(point)).await?;
            for index in 0..amount {
                if index > 0 {
                    tokio::time::sleep(SCROLL_GAP).await;
                }
                remote.input(axis(direction)).await?;
            }
            Ok(())
        }
        .boxed()
    }

    fn type_text(&self, text: String) -> DesktopFuture<'_, ()> {
        async move {
            let remote = self.remote()?;
            for character in text.chars() {
                tap(&*remote, &[keys::char_keysym(character)], TYPE_DELAY).await?;
            }
            Ok(())
        }
        .boxed()
    }

    fn key(&self, combos: Vec<String>) -> DesktopFuture<'_, ()> {
        async move {
            let combos = combos
                .iter()
                .map(|combo| {
                    keys::to_xdotool_combo(combo)?
                        .iter()
                        .map(|name| keysym_of(name))
                        .collect::<Result<Vec<_>, _>>()
                })
                .collect::<Result<Vec<_>, _>>()?;
            let remote = self.remote()?;
            for combo in combos {
                tap(&*remote, &combo, KEY_DELAY).await?;
            }
            Ok(())
        }
        .boxed()
    }

    fn list_windows(&self) -> DesktopFuture<'_, Vec<DesktopWindow>> {
        futures::future::ready(Err(NO_WINDOWS.into())).boxed()
    }

    fn focus_window(&self, _id: String) -> DesktopFuture<'_, ()> {
        futures::future::ready(Err(NO_WINDOWS.into())).boxed()
    }

    fn launch(&self, options: LaunchOptions) -> DesktopFuture<'_, u32> {
        futures::future::ready(super::launch(self.display.as_deref(), options)).boxed()
    }

    fn open_stream(&self) -> DesktopFuture<'_, DuplexStream> {
        async move {
            self.remote()?;
            Ok(self.stream_server().open())
        }
        .boxed()
    }
}

// MARK: Stream

/// The evdev code of a QEMU XT keycode, for viewers that send physical keys.
/// One-byte set 1 scancodes match evdev codes; 0xE0-prefixed keys do not.
fn xt_to_evdev(keycode: u32) -> Option<i32> {
    let code = match keycode {
        0x01..=0x58 => keycode,
        0x9c => 96,  // KP Enter
        0x9d => 97,  // Right Control
        0xb5 => 98,  // KP Divide
        0xb7 => 99,  // Print
        0xb8 => 100, // Right Alt
        0xc7 => 102, // Home
        0xc8 => 103, // Up
        0xc9 => 104, // Page Up
        0xcb => 105, // Left
        0xcd => 106, // Right
        0xcf => 107, // End
        0xd0 => 108, // Down
        0xd1 => 109, // Page Down
        0xd2 => 110, // Insert
        0xd3 => 111, // Delete
        0xdb => 125, // Left Super
        0xdc => 126, // Right Super
        0xdd => 127, // Menu
        _ => return None,
    };
    Some(code as i32)
}

fn stream_key(key: StreamKey) -> Option<Input> {
    if let Some(code) = xt_to_evdev(key.keycode) {
        return Some(Input::Keycode(code, key.down));
    }
    (key.keysym != 0).then_some(Input::Keysym(key.keysym, key.down))
}

struct WaylandStreamBackend {
    portal: Arc<Portal>,
    warn: Warn,
}

struct Shared {
    running: AtomicBool,
    quality: AtomicU8,
    refresh: AtomicBool,
}

impl StreamBackend for WaylandStreamBackend {
    fn start(&self, sink: StreamSink) -> Result<Box<dyn StreamCapture>, String> {
        let remote = self.portal.remote()?;
        let runtime = tokio::runtime::Handle::try_current()
            .map_err(|_| "The stream needs the async runtime".to_string())?;
        let shared = Arc::new(Shared {
            running: AtomicBool::new(true),
            quality: AtomicU8::new(0),
            refresh: AtomicBool::new(false),
        });
        let capture = (shared.clone(), remote.clone());
        std::thread::Builder::new()
            .name("wayland-capture".into())
            .spawn(move || {
                let (shared, remote) = capture;
                let error = capture_loop(&shared, &*remote, &sink).err();
                shared.running.store(false, Ordering::SeqCst);
                sink.ended(error);
            })
            .map_err(|error| format!("Could not start the stream capture: {error}"))?;
        let (input, inputs) = unbounded_channel();
        runtime.spawn(input_loop(remote, self.warn.clone(), inputs));
        Ok(Box::new(WaylandCapture {
            shared,
            input: Some(input),
        }))
    }
}

fn capture_loop(shared: &Shared, remote: &dyn Remote, sink: &StreamSink) -> Result<(), String> {
    let mut tiles = TileSender::new();
    let mut last = None;
    while shared.running.load(Ordering::SeqCst) {
        let after = last
            .as_ref()
            .map_or(0, |frame: &super::pipewire::Frame| frame.sequence);
        let fresh = match remote.wait_newer(after, FRAME)? {
            Some(frame) => {
                last = Some(frame);
                true
            }
            None => false,
        };
        let Some(frame) = &last else {
            continue;
        };
        let full = shared.refresh.swap(false, Ordering::SeqCst);
        let quality = shared.quality.load(Ordering::SeqCst);
        let frame = FrameRef {
            width: frame.width,
            height: frame.height,
            bgrx: &frame.bgrx,
        };
        if !tiles.send(sink, frame, quality, full, fresh)? {
            break;
        }
    }
    Ok(())
}

enum StreamInput {
    Move(u32, u32),
    Button(MouseButton, bool, u32, u32),
    Wheel(ScrollDirection, u32, u32),
    Key(StreamKey),
}

async fn input_loop(
    remote: Arc<dyn Remote>,
    warn: Warn,
    mut inputs: UnboundedReceiver<StreamInput>,
) {
    let mut held: Vec<Input> = Vec::new();
    let mut warned = false;
    while let Some(input) = inputs.recv().await {
        let events = match input {
            StreamInput::Move(x, y) => vec![Input::Motion(x.into(), y.into())],
            StreamInput::Button(button, down, x, y) => {
                vec![
                    Input::Motion(x.into(), y.into()),
                    Input::Button(evdev_button(button), down),
                ]
            }
            StreamInput::Wheel(direction, x, y) => {
                vec![Input::Motion(x.into(), y.into()), axis(direction)]
            }
            StreamInput::Key(key) => stream_key(key).into_iter().collect(),
        };
        for event in events {
            match event {
                Input::Button(code, down) => track(&mut held, Input::Button(code, true), down),
                Input::Keycode(code, down) => track(&mut held, Input::Keycode(code, true), down),
                Input::Keysym(sym, down) => track(&mut held, Input::Keysym(sym, true), down),
                _ => {}
            }
            if let Err(error) = remote.input(event).await
                && !std::mem::replace(&mut warned, true)
            {
                warn(&format!("Stream input failed: {error}"));
            }
        }
    }
    for pressed in held.into_iter().rev() {
        let released = match pressed {
            Input::Button(code, _) => Input::Button(code, false),
            Input::Keycode(code, _) => Input::Keycode(code, false),
            Input::Keysym(sym, _) => Input::Keysym(sym, false),
            other => other,
        };
        let _ = remote.input(released).await;
    }
}

fn track(held: &mut Vec<Input>, pressed: Input, down: bool) {
    held.retain(|input| *input != pressed);
    if down {
        held.push(pressed);
    }
}

struct WaylandCapture {
    shared: Arc<Shared>,
    input: Option<UnboundedSender<StreamInput>>,
}

impl WaylandCapture {
    fn send(&self, input: StreamInput) {
        if let Some(sender) = &self.input {
            let _ = sender.send(input);
        }
    }
}

impl StreamCapture for WaylandCapture {
    fn set_quality(&mut self, quality: Option<u8>) {
        self.shared
            .quality
            .store(quality.unwrap_or(0).min(100), Ordering::SeqCst);
    }

    fn refresh(&mut self) {
        self.shared.refresh.store(true, Ordering::SeqCst);
    }

    fn move_to(&mut self, x: u32, y: u32) {
        self.send(StreamInput::Move(x, y));
    }

    fn button(&mut self, button: MouseButton, down: bool, x: u32, y: u32) {
        self.send(StreamInput::Button(button, down, x, y));
    }

    fn wheel(&mut self, direction: ScrollDirection, x: u32, y: u32) {
        self.send(StreamInput::Wheel(direction, x, y));
    }

    fn key(&mut self, key: StreamKey) {
        self.send(StreamInput::Key(key));
    }

    // Sharing the clipboard through the portal is not supported yet.
    fn set_clipboard(&mut self, _text: String) {}

    fn stop(&mut self) {
        self.shared.running.store(false, Ordering::SeqCst);
        // The input task lets go of held keys and buttons once its channel closes.
        self.input = None;
    }
}

impl Drop for WaylandCapture {
    fn drop(&mut self) {
        self.stop();
    }
}

pub fn portal(token_path: Option<std::path::PathBuf>, warn: Warn) -> Arc<Portal> {
    Portal::new(token_path, portal::portal_connector(), warn)
}

#[cfg(test)]
mod tests;
