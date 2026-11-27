//! Provider-independent desktop contract. Coordinates are physical screen
//! pixels; the service maps them to and from the model-facing screenshot
//! space.

use futures::future::BoxFuture;
use serde::Serialize;
use tokio::io::DuplexStream;

pub type DesktopResult<T> = Result<T, String>;
pub type DesktopFuture<'a, T> = BoxFuture<'a, DesktopResult<T>>;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MouseButton {
    Left,
    Middle,
    Right,
}

impl MouseButton {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "left" => Some(Self::Left),
            "middle" => Some(Self::Middle),
            "right" => Some(Self::Right),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Middle => "middle",
            Self::Right => "right",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ScrollDirection {
    Up,
    Down,
    Left,
    Right,
}

impl ScrollDirection {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "up" => Some(Self::Up),
            "down" => Some(Self::Down),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Up => "up",
            Self::Down => "down",
            Self::Left => "left",
            Self::Right => "right",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ImageFormat {
    Jpeg,
    Png,
}

impl ImageFormat {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Jpeg => "jpeg",
            Self::Png => "png",
        }
    }

    pub fn mime_type(self) -> &'static str {
        match self {
            Self::Jpeg => "image/jpeg",
            Self::Png => "image/png",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Point {
    pub x: i64,
    pub y: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct Region {
    pub x: i64,
    pub y: i64,
    pub width: i64,
    pub height: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct ScreenSize {
    pub width: i64,
    pub height: i64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CaptureOptions {
    /// Physical region to capture. The whole screen when `None`.
    pub region: Option<Region>,
    /// Output size. The captured size when `None`.
    pub size: Option<ScreenSize>,
    pub format: ImageFormat,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct DesktopWindow {
    pub id: String,
    pub title: String,
    pub bounds: Region,
    pub focused: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LaunchOptions {
    pub command: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessibilityQuery {
    /// Window id from `list_windows`; the focused window when `None`.
    pub window: Option<String>,
    /// Element handle whose subtree to read instead of a whole window.
    pub root: Option<String>,
    /// Keep only controls a user can act on, plus the root.
    pub interactive_only: bool,
    pub max_depth: u32,
    pub max_nodes: u32,
}

/// One element of an accessibility tree, in physical screen pixels.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessibilityElement {
    /// Opaque and provider-defined; valid while the element lives.
    pub handle: String,
    /// Lower-case role name such as `push button` or `entry`.
    pub role: String,
    pub name: String,
    /// Text or numeric value; never set for password fields.
    pub value: Option<String>,
    /// Normalized names such as `focused`, `checked` or `disabled`.
    pub states: Vec<String>,
    /// `None` when the element has no on-screen geometry.
    pub bounds: Option<Region>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AccessibilityNode {
    pub element: AccessibilityElement,
    /// Depth among the returned nodes; the root is 0.
    pub depth: u32,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccessibilityTree {
    pub application: Option<String>,
    /// Title of the window the tree belongs to, when known.
    pub window: Option<String>,
    /// Pre-order: each node follows its parent.
    pub nodes: Vec<AccessibilityNode>,
    /// Some nodes were left out by a depth, size or time limit.
    pub truncated: bool,
}

/// What a desktop can do right now. Tools and streaming follow this alone.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DesktopCapabilities {
    /// Screenshots and input work: the desktop_* tools are offered.
    pub computer_use: bool,
    /// An RFB source can be opened: the desktop is offered to Cloud viewers.
    pub stream: bool,
    /// Accessibility trees can be read and elements targeted. It adds the
    /// accessibility tools only alongside `computer_use`.
    pub accessibility: bool,
    /// Physical screen size; always set with `computer_use`.
    pub screen: Option<ScreenSize>,
    /// Why computer use is off and how the user can turn it on, when known.
    pub hint: Option<String>,
}

impl DesktopCapabilities {
    pub fn none() -> Self {
        Self::default()
    }

    pub fn unavailable(hint: impl Into<String>) -> Self {
        Self {
            hint: Some(hint.into()),
            ..Self::default()
        }
    }
}

/// Accessibility trees, for providers whose probe reports `accessibility`.
pub trait AccessibilityProvider: Send + Sync {
    fn tree(&self, query: AccessibilityQuery) -> DesktopFuture<'_, AccessibilityTree>;
    /// Re-reads one element, or `None` once it is gone.
    fn element(&self, handle: String) -> DesktopFuture<'_, Option<AccessibilityElement>>;
}

/// One platform's desktop: computer use and the stream source.
pub trait DesktopProvider: Send + Sync {
    /// Never fails; an unusable desktop reports no capabilities.
    fn probe(&self) -> BoxFuture<'_, DesktopCapabilities>;
    /// Current physical size, re-read before input so resolution changes apply.
    fn screen_size(&self) -> DesktopFuture<'_, ScreenSize>;
    fn capture(&self, options: CaptureOptions) -> DesktopFuture<'_, Vec<u8>>;
    fn click(
        &self,
        point: Point,
        button: MouseButton,
        count: u32,
        modifiers: Vec<String>,
    ) -> DesktopFuture<'_, ()>;
    fn drag(&self, from: Point, to: Point, button: MouseButton) -> DesktopFuture<'_, ()>;
    fn move_to(&self, point: Point) -> DesktopFuture<'_, ()>;
    fn scroll(
        &self,
        point: Point,
        direction: ScrollDirection,
        amount: u32,
    ) -> DesktopFuture<'_, ()>;
    fn type_text(&self, text: String) -> DesktopFuture<'_, ()>;
    fn key(&self, combos: Vec<String>) -> DesktopFuture<'_, ()>;
    fn list_windows(&self) -> DesktopFuture<'_, Vec<DesktopWindow>>;
    fn focus_window(&self, id: String) -> DesktopFuture<'_, ()>;
    /// Starts a detached process and returns its PID.
    fn launch(&self, options: LaunchOptions) -> DesktopFuture<'_, u32>;
    /// Required when `probe` reports `accessibility`.
    fn accessibility(&self) -> Option<&dyn AccessibilityProvider> {
        None
    }
    /// Opens a new connection to an RFB 3.x server for one viewer. It must
    /// allow shared sessions and security type None. Fails when `stream` is
    /// false.
    fn open_stream(&self) -> DesktopFuture<'_, DuplexStream>;
}
