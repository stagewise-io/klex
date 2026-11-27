//! A deterministic desktop for conformance tests, identical in both
//! klex-machine implementations. The screen is 1600x1000 with `fake_pixel`
//! colours, captures are PNG whatever the format asks for, and every call is
//! appended as one JSON line to `KLEX_MACHINE_DESKTOP_FAKE_LOG` when set.

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::io::DuplexStream;

use super::image::encode_plain_png;
use super::provider::{
    AccessibilityElement, AccessibilityNode, AccessibilityProvider, AccessibilityQuery,
    AccessibilityTree, CaptureOptions, DesktopCapabilities, DesktopFuture, DesktopProvider,
    DesktopWindow, LaunchOptions, MouseButton, Point, Region, ScreenSize, ScrollDirection,
};
use super::rfb::{
    RfbServer, STREAM_TILE_SIZE, StreamBackend, StreamCapture, StreamKey, StreamSink, TileRect,
};

pub const FAKE_SCREEN: ScreenSize = ScreenSize {
    width: 1600,
    height: 1000,
};
pub const FAKE_UNAVAILABLE_HINT: &str = "The fake desktop is unavailable.";
pub const FAKE_CLIPBOARD: &str = "fake clipboard";
const FAKE_PID: u32 = 4242;

/// `fake` with accessibility, `fake-basic` without it, `fake-unavailable`
/// with only a hint.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FakeDesktopMode {
    Full,
    Basic,
    Unavailable,
}

impl FakeDesktopMode {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "fake" => Some(Self::Full),
            "fake-basic" => Some(Self::Basic),
            "fake-unavailable" => Some(Self::Unavailable),
            _ => None,
        }
    }
}

/// The fake screen's colour at a pixel, as 0xRRGGBB.
pub fn fake_pixel(x: u32, y: u32) -> u32 {
    ((x & 0xff) << 16) | ((y & 0xff) << 8) | (((x >> 4) ^ (y >> 4)) & 0xff)
}

#[derive(Clone)]
struct FakeElement {
    node: AccessibilityNode,
    interactive: bool,
}

struct FakeWindow {
    window: DesktopWindow,
    application: &'static str,
    elements: Vec<FakeElement>,
}

#[allow(clippy::too_many_arguments)]
fn element(
    window: &str,
    index: u32,
    depth: u32,
    role: &str,
    name: &str,
    bounds: Region,
    interactive: bool,
    value: Option<&str>,
    states: &[&str],
) -> FakeElement {
    FakeElement {
        node: AccessibilityNode {
            element: AccessibilityElement {
                handle: format!("{window}:{index}"),
                role: role.into(),
                name: name.into(),
                value: value.map(str::to_string),
                states: states.iter().map(|state| state.to_string()).collect(),
                bounds: Some(bounds),
            },
            depth,
        },
        interactive,
    }
}

fn region(x: i64, y: i64, width: i64, height: i64) -> Region {
    Region {
        x,
        y,
        width,
        height,
    }
}

fn fake_windows() -> Vec<FakeWindow> {
    vec![
        FakeWindow {
            window: DesktopWindow {
                id: "101".into(),
                title: "Fake editor".into(),
                bounds: region(100, 50, 800, 600),
                focused: true,
            },
            application: "Fake app",
            elements: vec![
                element(
                    "101",
                    0,
                    0,
                    "window",
                    "Fake editor",
                    region(100, 50, 800, 600),
                    true,
                    None,
                    &[],
                ),
                element(
                    "101",
                    1,
                    1,
                    "button",
                    "Save",
                    region(120, 70, 80, 30),
                    true,
                    None,
                    &[],
                ),
                element(
                    "101",
                    2,
                    1,
                    "label",
                    "Untitled",
                    region(220, 70, 200, 30),
                    false,
                    None,
                    &[],
                ),
                element(
                    "101",
                    3,
                    1,
                    "textbox",
                    "Search",
                    region(120, 120, 300, 30),
                    true,
                    Some("hello"),
                    &["focusable", "editable"],
                ),
                element(
                    "101",
                    4,
                    2,
                    "button",
                    "Offscreen",
                    region(2000, 2000, 50, 20),
                    true,
                    None,
                    &[],
                ),
            ],
        },
        FakeWindow {
            window: DesktopWindow {
                id: "202".into(),
                title: "Fake terminal".into(),
                bounds: region(900, 500, 600, 400),
                focused: false,
            },
            application: "Fake shell",
            elements: vec![element(
                "202",
                0,
                0,
                "window",
                "Fake terminal",
                region(900, 500, 600, 400),
                true,
                None,
                &[],
            )],
        },
    ]
}

#[derive(Clone)]
struct Recorder(Option<PathBuf>);

impl Recorder {
    fn record(&self, entry: Value) {
        let Some(path) = &self.0 else {
            return;
        };
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(path)
        {
            let _ = writeln!(file, "{entry}");
        }
    }
}

pub struct FakeDesktopProvider {
    mode: FakeDesktopMode,
    recorder: Recorder,
    windows: Mutex<Vec<FakeWindow>>,
    stream: OnceLock<RfbServer>,
}

impl FakeDesktopProvider {
    pub fn new(mode: FakeDesktopMode, log: Option<PathBuf>) -> Self {
        Self {
            mode,
            recorder: Recorder(log),
            windows: Mutex::new(fake_windows()),
            stream: OnceLock::new(),
        }
    }

    fn windows(&self) -> std::sync::MutexGuard<'_, Vec<FakeWindow>> {
        self.windows
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn record(&self, entry: Value) {
        self.recorder.record(entry);
    }

    fn find_element(windows: &[FakeWindow], handle: &str) -> Option<(usize, usize)> {
        windows.iter().enumerate().find_map(|(window, state)| {
            state
                .elements
                .iter()
                .position(|element| element.node.element.handle == handle)
                .map(|index| (window, index))
        })
    }

    fn tree_now(&self, query: &AccessibilityQuery) -> Result<AccessibilityTree, String> {
        let windows = self.windows();
        let (window, nodes): (Option<&FakeWindow>, Vec<FakeElement>) = match &query.root {
            Some(root) => {
                let Some((window, start)) = Self::find_element(&windows, root) else {
                    return Err(format!("The element {root} is gone"));
                };
                let elements = &windows[window].elements;
                let root_depth = elements[start].node.depth;
                let mut end = start + 1;
                while end < elements.len() && elements[end].node.depth > root_depth {
                    end += 1;
                }
                let nodes = elements[start..end]
                    .iter()
                    .cloned()
                    .map(|mut element| {
                        element.node.depth -= root_depth;
                        element
                    })
                    .collect();
                (Some(&windows[window]), nodes)
            }
            None => {
                let window = match &query.window {
                    None => windows.iter().find(|candidate| candidate.window.focused),
                    Some(id) => windows.iter().find(|candidate| &candidate.window.id == id),
                };
                let Some(window) = window else {
                    return Err(format!(
                        "No window has id {}",
                        query.window.as_deref().unwrap_or("undefined")
                    ));
                };
                (Some(window), window.elements.clone())
            }
        };
        let kept: Vec<FakeElement> = nodes
            .into_iter()
            .filter(|element| {
                element.node.depth < query.max_depth
                    && (element.node.depth == 0 || element.interactive || !query.interactive_only)
            })
            .collect();
        let truncated = kept.len() > query.max_nodes as usize;
        Ok(AccessibilityTree {
            application: window.map(|window| window.application.to_string()),
            window: window.map(|window| window.window.title.clone()),
            nodes: kept
                .into_iter()
                .take(query.max_nodes as usize)
                .map(|element| element.node)
                .collect(),
            truncated,
        })
    }
}

fn ok<'a, T: Send + 'a>(value: T) -> DesktopFuture<'a, T> {
    futures::future::ready(Ok(value)).boxed()
}

impl AccessibilityProvider for FakeDesktopProvider {
    fn tree(&self, query: AccessibilityQuery) -> DesktopFuture<'_, AccessibilityTree> {
        futures::future::ready(self.tree_now(&query)).boxed()
    }

    fn element(&self, handle: String) -> DesktopFuture<'_, Option<AccessibilityElement>> {
        let windows = self.windows();
        let found = Self::find_element(&windows, &handle)
            .map(|(window, index)| windows[window].elements[index].node.element.clone());
        ok(found)
    }
}

impl DesktopProvider for FakeDesktopProvider {
    fn probe(&self) -> BoxFuture<'_, DesktopCapabilities> {
        let capabilities = if self.mode == FakeDesktopMode::Unavailable {
            DesktopCapabilities::unavailable(FAKE_UNAVAILABLE_HINT)
        } else {
            DesktopCapabilities {
                computer_use: true,
                stream: true,
                accessibility: self.mode == FakeDesktopMode::Full,
                screen: Some(FAKE_SCREEN),
                hint: None,
            }
        };
        futures::future::ready(capabilities).boxed()
    }

    fn screen_size(&self) -> DesktopFuture<'_, ScreenSize> {
        ok(FAKE_SCREEN)
    }

    fn capture(&self, options: CaptureOptions) -> DesktopFuture<'_, Vec<u8>> {
        self.record(json!({
            "call": "capture",
            "region": options.region,
            "size": options.size,
            "format": options.format.as_str(),
        }));
        let region = options.region.unwrap_or(Region {
            x: 0,
            y: 0,
            width: FAKE_SCREEN.width,
            height: FAKE_SCREEN.height,
        });
        let size = options.size.unwrap_or(ScreenSize {
            width: region.width,
            height: region.height,
        });
        let (width, height) = (size.width as usize, size.height as usize);
        let mut rgb = Vec::with_capacity(width * height * 3);
        for y in 0..height {
            let sy = region.y + (y as i64 * region.height) / size.height;
            for x in 0..width {
                let sx = region.x + (x as i64 * region.width) / size.width;
                let color = fake_pixel(sx as u32, sy as u32);
                rgb.extend_from_slice(&[(color >> 16) as u8, (color >> 8) as u8, color as u8]);
            }
        }
        ok(encode_plain_png(width as u32, height as u32, &rgb))
    }

    fn click(
        &self,
        point: Point,
        button: MouseButton,
        count: u32,
        modifiers: Vec<String>,
    ) -> DesktopFuture<'_, ()> {
        self.record(json!({
            "call": "click",
            "x": point.x,
            "y": point.y,
            "button": button.as_str(),
            "count": count,
            "modifiers": modifiers,
        }));
        ok(())
    }

    fn drag(&self, from: Point, to: Point, button: MouseButton) -> DesktopFuture<'_, ()> {
        self.record(json!({ "call": "drag", "from": from, "to": to, "button": button.as_str() }));
        ok(())
    }

    fn move_to(&self, point: Point) -> DesktopFuture<'_, ()> {
        self.record(json!({ "call": "move", "x": point.x, "y": point.y }));
        ok(())
    }

    fn scroll(
        &self,
        point: Point,
        direction: ScrollDirection,
        amount: u32,
    ) -> DesktopFuture<'_, ()> {
        self.record(json!({
            "call": "scroll",
            "x": point.x,
            "y": point.y,
            "direction": direction.as_str(),
            "amount": amount,
        }));
        ok(())
    }

    fn type_text(&self, text: String) -> DesktopFuture<'_, ()> {
        self.record(json!({ "call": "type", "text": text }));
        ok(())
    }

    fn key(&self, combos: Vec<String>) -> DesktopFuture<'_, ()> {
        self.record(json!({ "call": "key", "keys": combos }));
        ok(())
    }

    fn list_windows(&self) -> DesktopFuture<'_, Vec<DesktopWindow>> {
        ok(self
            .windows()
            .iter()
            .map(|state| state.window.clone())
            .collect())
    }

    fn focus_window(&self, id: String) -> DesktopFuture<'_, ()> {
        self.record(json!({ "call": "focusWindow", "id": id }));
        let mut windows = self.windows();
        if !windows.iter().any(|state| state.window.id == id) {
            return futures::future::ready(Err(format!("No window has id {id}"))).boxed();
        }
        for state in windows.iter_mut() {
            state.window.focused = state.window.id == id;
        }
        ok(())
    }

    fn launch(&self, options: LaunchOptions) -> DesktopFuture<'_, u32> {
        self.record(json!({
            "call": "launch",
            "command": options.command,
            "args": options.args,
            "cwd": options.cwd,
        }));
        ok(FAKE_PID)
    }

    fn accessibility(&self) -> Option<&dyn AccessibilityProvider> {
        (self.mode == FakeDesktopMode::Full).then_some(self as &dyn AccessibilityProvider)
    }

    fn open_stream(&self) -> DesktopFuture<'_, DuplexStream> {
        if self.mode == FakeDesktopMode::Unavailable {
            return futures::future::ready(Err(FAKE_UNAVAILABLE_HINT.to_string())).boxed();
        }
        let server = self.stream.get_or_init(|| {
            RfbServer::new(
                Arc::new(FakeStreamBackend {
                    recorder: self.recorder.clone(),
                }),
                "klex-machine fake desktop",
            )
        });
        ok(server.open())
    }
}

/// Sends the fake screen as raw tiles and records stream input.
struct FakeStreamBackend {
    recorder: Recorder,
}

fn send_all(sink: &StreamSink) {
    for y in (0..FAKE_SCREEN.height as u32).step_by(STREAM_TILE_SIZE as usize) {
        for x in (0..FAKE_SCREEN.width as u32).step_by(STREAM_TILE_SIZE as usize) {
            let tile = TileRect {
                x,
                y,
                width: STREAM_TILE_SIZE.min(FAKE_SCREEN.width as u32 - x),
                height: STREAM_TILE_SIZE.min(FAKE_SCREEN.height as u32 - y),
            };
            let mut pixels = Vec::with_capacity((tile.width * tile.height * 4) as usize);
            for row in 0..tile.height {
                for column in 0..tile.width {
                    pixels.extend_from_slice(&fake_pixel(x + column, y + row).to_le_bytes());
                }
            }
            sink.raw(tile, pixels);
        }
    }
    sink.frame();
}

impl StreamBackend for FakeStreamBackend {
    fn start(&self, sink: StreamSink) -> Result<Box<dyn StreamCapture>, String> {
        sink.resize(FAKE_SCREEN.width as u32, FAKE_SCREEN.height as u32);
        send_all(&sink);
        sink.clipboard(FAKE_CLIPBOARD.into());
        Ok(Box::new(FakeCapture {
            sink,
            recorder: self.recorder.clone(),
            stopped: Arc::new(AtomicBool::new(false)),
        }))
    }
}

struct FakeCapture {
    sink: StreamSink,
    recorder: Recorder,
    stopped: Arc<AtomicBool>,
}

impl StreamCapture for FakeCapture {
    fn set_quality(&mut self, _quality: Option<u8>) {}

    fn refresh(&mut self) {
        if !self.stopped.load(Ordering::SeqCst) {
            send_all(&self.sink);
        }
    }

    fn move_to(&mut self, x: u32, y: u32) {
        self.recorder
            .record(json!({ "call": "stream.move", "x": x, "y": y }));
    }

    fn button(&mut self, button: MouseButton, down: bool, x: u32, y: u32) {
        self.recorder.record(json!({
            "call": "stream.button",
            "button": button.as_str(),
            "down": down,
            "x": x,
            "y": y,
        }));
    }

    fn wheel(&mut self, direction: ScrollDirection, x: u32, y: u32) {
        self.recorder.record(json!({
            "call": "stream.wheel",
            "direction": direction.as_str(),
            "x": x,
            "y": y,
        }));
    }

    fn key(&mut self, key: StreamKey) {
        self.recorder.record(json!({
            "call": "stream.key",
            "down": key.down,
            "keysym": key.keysym,
            "keycode": key.keycode,
        }));
    }

    fn set_clipboard(&mut self, text: String) {
        self.recorder
            .record(json!({ "call": "stream.clipboard", "text": text }));
    }

    fn stop(&mut self) {
        self.stopped.store(true, Ordering::SeqCst);
    }
}
