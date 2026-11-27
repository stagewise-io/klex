//! Desktop operations in model-facing screenshot coordinates. Every
//! operation runs one at a time, input is authorized against the control
//! lease when it runs, and accessibility handles are exposed as short refs.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use serde_json::{Value, json};
use tokio::io::DuplexStream;

use super::lease::{DesktopControlLease, InputDenied};
use super::provider::{
    AccessibilityElement, AccessibilityNode, AccessibilityProvider, AccessibilityQuery,
    AccessibilityTree, CaptureOptions, DesktopCapabilities, DesktopProvider, ImageFormat,
    LaunchOptions, MouseButton, Point, Region, ScreenSize, ScrollDirection,
};

/// Screenshots fit this box so model-facing coordinates stay stable.
pub const MAX_SCREENSHOT_SIZE: ScreenSize = ScreenSize {
    width: 1280,
    height: 800,
};
const PROBE_RETRY: Duration = Duration::from_secs(10);
const PROBE_REFRESH: Duration = Duration::from_secs(60);
pub const DEFAULT_SETTLE_MS: u64 = 300;
const MAX_SETTLE_MS: u64 = 5_000;
pub const DEFAULT_TREE_DEPTH: u32 = 30;
pub const MAX_TREE_DEPTH: u32 = 60;
pub const DEFAULT_TREE_NODES: u32 = 300;
pub const MAX_TREE_NODES: u32 = 1_000;
const MAX_TREE_CHARACTERS: usize = 24_000;
const MAX_REFS: usize = 10_000;
const FRAME_ONLY_HINT: &str = "Only the window itself is exposed. The app may not support accessibility, or, for Chrome and Electron apps, was started without --force-renderer-accessibility. Use desktop_screenshot.";
const TRUNCATED_HINT: &str = "[truncated: pass a ref to read one subtree, or lower maxDepth]";

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum DesktopError {
    Denied(InputDenied),
    Failed(String),
}

impl From<String> for DesktopError {
    fn from(message: String) -> Self {
        Self::Failed(message)
    }
}

impl From<&str> for DesktopError {
    fn from(message: &str) -> Self {
        Self::Failed(message.to_string())
    }
}

impl From<InputDenied> for DesktopError {
    fn from(denied: InputDenied) -> Self {
        Self::Denied(denied)
    }
}

impl std::fmt::Display for DesktopError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Denied(denied) => formatter.write_str(&denied.message),
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

pub type ServiceResult<T> = Result<T, DesktopError>;

pub struct Screenshot {
    pub data: Vec<u8>,
    pub mime_type: &'static str,
    /// Screenshot size; every desktop coordinate uses this space.
    pub width: i64,
    pub height: i64,
    /// Physical screen size.
    pub screen: ScreenSize,
}

pub struct Zoom {
    pub shot: Screenshot,
    pub region: Region,
}

#[derive(Clone, Debug, Default)]
pub struct TreeOptions {
    pub window: Option<String>,
    pub reference: Option<String>,
    pub interactive_only: Option<bool>,
    pub max_depth: Option<f64>,
    pub max_nodes: Option<f64>,
}

pub struct TreeText {
    pub text: String,
    pub nodes: usize,
    pub truncated: bool,
}

/// One input or window operation, in screenshot coordinates.
#[derive(Clone, Debug)]
pub enum DesktopAction {
    Click {
        point: Point,
        button: MouseButton,
        count: u32,
        modifiers: Vec<String>,
    },
    ClickElement {
        reference: String,
        button: MouseButton,
        count: u32,
        modifiers: Vec<String>,
    },
    Drag {
        from: Point,
        to: Point,
        button: MouseButton,
    },
    Move {
        point: Point,
    },
    Scroll {
        point: Point,
        direction: ScrollDirection,
        amount: u32,
    },
    Type {
        text: String,
    },
    Key {
        keys: Vec<String>,
    },
    ListWindows,
    FocusWindow {
        id: String,
    },
    Launch {
        command: String,
        args: Vec<String>,
        cwd: Option<String>,
    },
}

#[derive(Clone, Copy)]
struct Space {
    scale: f64,
    width: i64,
    height: i64,
}

#[derive(Clone)]
struct RefEntry {
    handle: String,
    role: String,
}

#[derive(Default)]
struct Refs {
    // Least-recently-printed first; evicting from the front never drops a ref
    // printed in the same response.
    by_ref: IndexMap<String, RefEntry>,
    by_handle: std::collections::HashMap<String, String>,
    next: u64,
}

struct ProbeCache {
    value: DesktopCapabilities,
    at: Instant,
    ttl: Duration,
}

pub struct DesktopService {
    pub lease: DesktopControlLease,
    provider: Arc<dyn DesktopProvider>,
    max: ScreenSize,
    probe: tokio::sync::Mutex<Option<ProbeCache>>,
    stale: AtomicBool,
    queue: tokio::sync::Mutex<()>,
    refs: Mutex<Refs>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// `Math.round`.
pub fn js_round(value: f64) -> i64 {
    (value + 0.5).floor() as i64
}

fn stale_ref(reference: &str) -> DesktopError {
    DesktopError::Failed(format!(
        "{reference} is stale or unknown. Read the tree again with desktop_accessibility_tree."
    ))
}

impl DesktopService {
    pub fn new(provider: Arc<dyn DesktopProvider>) -> Self {
        Self::with_lease(provider, DesktopControlLease::new())
    }

    pub fn with_lease(provider: Arc<dyn DesktopProvider>, lease: DesktopControlLease) -> Self {
        Self {
            lease,
            provider,
            max: MAX_SCREENSHOT_SIZE,
            probe: tokio::sync::Mutex::new(None),
            stale: AtomicBool::new(false),
            queue: tokio::sync::Mutex::new(()),
            refs: Mutex::default(),
        }
    }

    /// The provider's latest probe. A full result is re-checked every minute
    /// and a partial one every few seconds, so a desktop that appears or goes
    /// away is noticed without probing on every request.
    pub async fn capabilities(&self) -> DesktopCapabilities {
        let mut cache = self.probe.lock().await;
        let stale = self.stale.swap(false, Ordering::SeqCst);
        if let Some(cached) = cache.as_ref()
            && !stale
            && cached.at.elapsed() < cached.ttl
        {
            return cached.value.clone();
        }
        let value = self.provider.probe().await;
        let ttl = if value.computer_use && value.stream {
            PROBE_REFRESH
        } else {
            PROBE_RETRY
        };
        *cache = Some(ProbeCache {
            value: value.clone(),
            at: Instant::now(),
            ttl,
        });
        value
    }

    /// Drops the cached probe, for callers that just saw a capability fail.
    pub fn invalidate(&self) {
        self.stale.store(true, Ordering::SeqCst);
    }

    /// Opens an RFB source for one viewer.
    pub async fn open_stream(&self) -> Result<DuplexStream, String> {
        self.provider.open_stream().await
    }

    pub async fn screenshot(&self, format: ImageFormat) -> ServiceResult<Screenshot> {
        let _queue = self.queue.lock().await;
        self.capture(format).await
    }

    pub async fn zoom(&self, region: Region, format: ImageFormat) -> ServiceResult<Zoom> {
        let _queue = self.queue.lock().await;
        let screen = self.provider.screen_size().await?;
        let space = self.space(screen);
        assert_region(region, space)?;
        let physical = clamp_region(
            Region {
                x: (region.x as f64 / space.scale).floor() as i64,
                y: (region.y as f64 / space.scale).floor() as i64,
                width: (region.width as f64 / space.scale).ceil() as i64,
                height: (region.height as f64 / space.scale).ceil() as i64,
            },
            screen,
        );
        let fit = (self.max.width as f64 / physical.width as f64)
            .min(self.max.height as f64 / physical.height as f64);
        let size = ScreenSize {
            width: js_round(physical.width as f64 * fit).max(1),
            height: js_round(physical.height as f64 * fit).max(1),
        };
        let data = self
            .provider
            .capture(CaptureOptions {
                region: Some(physical),
                size: Some(size),
                format,
            })
            .await?;
        Ok(Zoom {
            shot: Screenshot {
                data,
                mime_type: format.mime_type(),
                width: size.width,
                height: size.height,
                screen,
            },
            region,
        })
    }

    /// Runs one action; `Value::Null` means it has no result of its own.
    pub async fn perform(&self, action: DesktopAction) -> ServiceResult<Value> {
        let _queue = self.queue.lock().await;
        self.run(action).await
    }

    /// Runs an action, waits for the UI to settle, then captures, with no
    /// other desktop operation in between.
    pub async fn perform_with_screenshot(
        &self,
        action: DesktopAction,
        settle_ms: u64,
        format: ImageFormat,
    ) -> ServiceResult<(Value, Screenshot)> {
        let _queue = self.queue.lock().await;
        let value = self.run(action).await?;
        tokio::time::sleep(Duration::from_millis(settle_ms.min(MAX_SETTLE_MS))).await;
        let shot = self.capture(format).await?;
        Ok((value, shot))
    }

    /// The accessibility tree of a window or of an earlier ref's subtree, as
    /// text with refs and bounds in screenshot coordinates.
    pub async fn accessibility_tree(&self, options: TreeOptions) -> ServiceResult<TreeText> {
        let _queue = self.queue.lock().await;
        let provider = self.accessible()?;
        let root = match options.reference.as_deref() {
            Some(reference) => Some(self.ref_entry(reference)?.handle),
            None => None,
        };
        let space = self.space(self.provider.screen_size().await?);
        let query = AccessibilityQuery {
            window: options.window.filter(|window| !window.is_empty()),
            root: root.clone(),
            interactive_only: options.interactive_only.unwrap_or(true),
            max_depth: clamp_int(options.max_depth, DEFAULT_TREE_DEPTH, MAX_TREE_DEPTH),
            max_nodes: clamp_int(options.max_nodes, DEFAULT_TREE_NODES, MAX_TREE_NODES),
        };
        let tree = match provider.tree(query).await {
            Ok(tree) => tree,
            Err(error) => {
                if let Some(reference) = options.reference.as_deref()
                    && error.to_lowercase().contains("gone")
                {
                    return Err(stale_ref(reference));
                }
                return Err(error.into());
            }
        };
        Ok(self.format_tree(&tree, space.scale, root.is_none()))
    }

    async fn run(&self, action: DesktopAction) -> ServiceResult<Value> {
        match action {
            DesktopAction::Click {
                point,
                button,
                count,
                modifiers,
            } => {
                let map = self.authorize_input().await?;
                let point = map.to_screen(point)?;
                self.provider.click(point, button, count, modifiers).await?;
                Ok(Value::Null)
            }
            DesktopAction::ClickElement {
                reference,
                button,
                count,
                modifiers,
            } => {
                self.click_element(&reference, button, count, modifiers)
                    .await
            }
            DesktopAction::Drag { from, to, button } => {
                let map = self.authorize_input().await?;
                let (from, to) = (map.to_screen(from)?, map.to_screen(to)?);
                self.provider.drag(from, to, button).await?;
                Ok(Value::Null)
            }
            DesktopAction::Move { point } => {
                let map = self.authorize_input().await?;
                let point = map.to_screen(point)?;
                self.provider.move_to(point).await?;
                Ok(Value::Null)
            }
            DesktopAction::Scroll {
                point,
                direction,
                amount,
            } => {
                let map = self.authorize_input().await?;
                let point = map.to_screen(point)?;
                self.provider.scroll(point, direction, amount).await?;
                Ok(Value::Null)
            }
            DesktopAction::Type { text } => {
                self.authorize_input().await?;
                self.provider.type_text(text).await?;
                Ok(Value::Null)
            }
            DesktopAction::Key { keys } => {
                self.authorize_input().await?;
                self.provider.key(keys).await?;
                Ok(Value::Null)
            }
            DesktopAction::FocusWindow { id } => {
                self.authorize_input().await?;
                self.provider.focus_window(id).await?;
                Ok(Value::Null)
            }
            DesktopAction::Launch { command, args, cwd } => {
                self.authorize_input().await?;
                let pid = self
                    .provider
                    .launch(LaunchOptions {
                        command,
                        args,
                        cwd: cwd.filter(|cwd| !cwd.is_empty()),
                    })
                    .await?;
                Ok(json!({ "pid": pid }))
            }
            DesktopAction::ListWindows => {
                let space = self.space(self.provider.screen_size().await?);
                let windows = self.provider.list_windows().await?;
                let scale = |value: i64| js_round(value as f64 * space.scale);
                Ok(Value::Array(
                    windows
                        .into_iter()
                        .map(|window| {
                            json!({
                                "id": window.id,
                                "title": window.title,
                                "bounds": {
                                    "x": scale(window.bounds.x),
                                    "y": scale(window.bounds.y),
                                    "width": scale(window.bounds.width),
                                    "height": scale(window.bounds.height),
                                },
                                "focused": window.focused,
                            })
                        })
                        .collect(),
                ))
            }
        }
    }

    /// Click the centre of an element from an earlier tree. The element is
    /// re-read first, so a ref whose element went away or moved off screen
    /// fails instead of clicking whatever is now at its old position.
    async fn click_element(
        &self,
        reference: &str,
        button: MouseButton,
        count: u32,
        modifiers: Vec<String>,
    ) -> ServiceResult<Value> {
        let provider = self.accessible()?;
        let entry = self.ref_entry(reference)?;
        let screen = self.provider.screen_size().await?;
        let space = self.space(screen);
        let element = provider.element(entry.handle.clone()).await?;
        let Some(element) = element.filter(|element| element.role == entry.role) else {
            return Err(stale_ref(reference));
        };
        let Some(center) = element_center(&element) else {
            return Err(format!(
                "{reference} has no on-screen position. Use desktop_screenshot and click by coordinates."
            )
            .into());
        };
        if center.x < 0 || center.y < 0 || center.x >= screen.width || center.y >= screen.height {
            return Err(format!(
                "{reference} is off screen. Scroll it into view, then read the tree again."
            )
            .into());
        }
        // Same rule as other input: authorize after the last await.
        self.lease.authorize()?;
        self.provider
            .click(center, button, count, modifiers)
            .await?;
        Ok(json!({
            "ref": reference,
            "x": (space.width - 1).min(js_round(center.x as f64 * space.scale)),
            "y": (space.height - 1).min(js_round(center.y as f64 * space.scale)),
        }))
    }

    /// Re-reads the geometry so resolution changes never use stale scaling,
    /// then authorizes after the last await so a takeover cannot land
    /// between the check and the input.
    async fn authorize_input(&self) -> ServiceResult<ScreenMap> {
        let screen = self.provider.screen_size().await?;
        let space = self.space(screen);
        self.lease.authorize()?;
        Ok(ScreenMap { screen, space })
    }

    async fn capture(&self, format: ImageFormat) -> ServiceResult<Screenshot> {
        let screen = self.provider.screen_size().await?;
        let space = self.space(screen);
        let size = ScreenSize {
            width: space.width,
            height: space.height,
        };
        let data = self
            .provider
            .capture(CaptureOptions {
                region: None,
                size: (size != screen).then_some(size),
                format,
            })
            .await?;
        Ok(Screenshot {
            data,
            mime_type: format.mime_type(),
            width: size.width,
            height: size.height,
            screen,
        })
    }

    fn space(&self, screen: ScreenSize) -> Space {
        let scale = 1f64
            .min(self.max.width as f64 / screen.width as f64)
            .min(self.max.height as f64 / screen.height as f64);
        Space {
            scale,
            width: js_round(screen.width as f64 * scale),
            height: js_round(screen.height as f64 * scale),
        }
    }

    fn accessible(&self) -> ServiceResult<&dyn AccessibilityProvider> {
        self.provider
            .accessibility()
            .ok_or_else(|| "Accessibility is not available on this desktop".into())
    }

    fn ref_entry(&self, reference: &str) -> ServiceResult<RefEntry> {
        lock(&self.refs)
            .by_ref
            .get(reference)
            .cloned()
            .ok_or_else(|| stale_ref(reference))
    }

    fn ref_for(refs: &mut Refs, element: &AccessibilityElement) -> String {
        if let Some(known) = refs.by_handle.get(&element.handle).cloned()
            && let Some(entry) = refs.by_ref.shift_remove(&known)
        {
            // A ref keeps the role it was issued with, so a handle whose
            // element changed role gets a new ref and the old one reads as stale.
            if entry.role == element.role {
                refs.by_ref.insert(known.clone(), entry);
                return known;
            }
        }
        while refs.by_ref.len() >= MAX_REFS {
            let Some((oldest, entry)) = refs.by_ref.shift_remove_index(0) else {
                break;
            };
            if refs.by_handle.get(&entry.handle) == Some(&oldest) {
                refs.by_handle.remove(&entry.handle);
            }
        }
        refs.next += 1;
        let reference = format!("r{}", refs.next);
        refs.by_ref.insert(
            reference.clone(),
            RefEntry {
                handle: element.handle.clone(),
                role: element.role.clone(),
            },
        );
        refs.by_handle
            .insert(element.handle.clone(), reference.clone());
        reference
    }

    fn format_tree(&self, tree: &AccessibilityTree, scale: f64, whole_window: bool) -> TreeText {
        let header = [
            tree.window
                .as_ref()
                .map(|window| format!("window {}", json_string(window))),
            tree.application
                .as_ref()
                .filter(|application| !application.is_empty())
                .map(|application| format!("application {}", json_string(application))),
        ]
        .into_iter()
        .flatten()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join(", ");
        let mut length = crate::utf16::len(&header);
        let mut lines = if header.is_empty() {
            Vec::new()
        } else {
            vec![header]
        };
        let mut truncated = tree.truncated;
        let mut count = 0;
        let mut refs = lock(&self.refs);
        for node in &tree.nodes {
            let reference = Self::ref_for(&mut refs, &node.element);
            let line = format_node(node, &reference, scale);
            let line_length = crate::utf16::len(&line);
            if length + line_length + 1 > MAX_TREE_CHARACTERS {
                truncated = true;
                break;
            }
            lines.push(line);
            length += line_length + 1;
            count += 1;
        }
        drop(refs);
        if whole_window && !truncated && tree.nodes.len() <= 1 {
            lines.push(FRAME_ONLY_HINT.into());
        }
        if truncated {
            lines.push(TRUNCATED_HINT.into());
        }
        TreeText {
            text: lines.join("\n"),
            nodes: count,
            truncated,
        }
    }
}

struct ScreenMap {
    screen: ScreenSize,
    space: Space,
}

impl ScreenMap {
    fn to_screen(&self, point: Point) -> ServiceResult<Point> {
        assert_point(point, self.space)?;
        Ok(Point {
            x: (self.screen.width - 1).min(js_round(point.x as f64 / self.space.scale)),
            y: (self.screen.height - 1).min(js_round(point.y as f64 / self.space.scale)),
        })
    }
}

fn json_string(value: &str) -> String {
    Value::String(value.to_string()).to_string()
}

fn format_node(node: &AccessibilityNode, reference: &str, scale: f64) -> String {
    let element = &node.element;
    let mut parts = vec![
        format!(
            "{}{reference} {}",
            "  ".repeat(node.depth as usize),
            element.role
        ),
        json_string(&element.name),
    ];
    if let Some(value) = &element.value {
        parts.push(format!("value={}", json_string(value)));
    }
    if let Some(bounds) = element.bounds {
        let scaled = |value: i64| js_round(value as f64 * scale);
        parts.push(format!(
            "@{},{} {}x{}",
            scaled(bounds.x),
            scaled(bounds.y),
            scaled(bounds.width).max(1),
            scaled(bounds.height).max(1)
        ));
    }
    if !element.states.is_empty() {
        parts.push(format!("[{}]", element.states.join(", ")));
    }
    parts.join(" ")
}

fn element_center(element: &AccessibilityElement) -> Option<Point> {
    let bounds = element.bounds?;
    if bounds.width <= 0 || bounds.height <= 0 {
        return None;
    }
    Some(Point {
        x: js_round(bounds.x as f64 + bounds.width as f64 / 2.0),
        y: js_round(bounds.y as f64 + bounds.height as f64 / 2.0),
    })
}

fn clamp_int(value: Option<f64>, fallback: u32, max: u32) -> u32 {
    match value {
        Some(value) if value.is_finite() => value.floor().clamp(1.0, max as f64) as u32,
        _ => fallback,
    }
}

fn assert_point(point: Point, space: Space) -> ServiceResult<()> {
    if point.x < 0 || point.y < 0 || point.x >= space.width || point.y >= space.height {
        return Err(format!(
            "Coordinates ({}, {}) are outside the {}x{} screenshot",
            point.x, point.y, space.width, space.height
        )
        .into());
    }
    Ok(())
}

fn assert_region(region: Region, space: Space) -> ServiceResult<()> {
    assert_point(
        Point {
            x: region.x,
            y: region.y,
        },
        space,
    )?;
    if region.x + region.width > space.width || region.y + region.height > space.height {
        return Err(format!(
            "Region exceeds the {}x{} screenshot",
            space.width, space.height
        )
        .into());
    }
    Ok(())
}

fn clamp_region(region: Region, screen: ScreenSize) -> Region {
    let x = region.x.min(screen.width - 1);
    let y = region.y.min(screen.height - 1);
    Region {
        x,
        y,
        width: region.width.min(screen.width - x).max(1),
        height: region.height.min(screen.height - y).max(1),
    }
}
