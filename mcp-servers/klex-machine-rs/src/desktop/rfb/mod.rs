//! A built-in RFB server fed by a platform capture backend.

pub mod clipboard;
pub mod encoding;
pub mod filter;
mod framebuffer;
mod server;
mod session;
pub mod tiles;

use serde::Serialize;
use tokio::sync::mpsc::UnboundedSender;

pub use server::RfbServer;

use super::provider::{MouseButton, ScrollDirection};

/// Side of a square tile in framebuffer pixels. Captures send every update
/// as whole tiles on this grid (smaller at the right and bottom edges).
pub const STREAM_TILE_SIZE: u32 = 128;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct TileRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

impl TileRect {
    fn intersects(&self, other: &TileRect) -> bool {
        self.x < other.x + other.width
            && other.x < self.x + self.width
            && self.y < other.y + other.height
            && other.y < self.y + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StreamKey {
    pub down: bool,
    /// X11 keysym, for keys a viewer could not map to a physical key.
    pub keysym: u32,
    /// QEMU XT keycode of the physical key, or 0 when unknown. One-byte set 1
    /// scancodes are as-is; 0xE0-prefixed ones are the second byte | 0x80.
    pub keycode: u32,
}

pub(crate) enum SinkEvent {
    Resize(u32, u32),
    Raw(TileRect, Vec<u8>),
    Jpeg(TileRect, Vec<u8>),
    Frame,
    Clipboard(String),
    Ended(Option<String>),
}

/// Where a running capture reports what it sees, from any thread. Pixels
/// are BGRX, 4 bytes each, rows packed. Tiles of one frame take effect
/// together on `frame()`.
#[derive(Clone)]
pub struct StreamSink {
    run: u64,
    events: UnboundedSender<server::Event>,
}

impl StreamSink {
    fn send(&self, event: SinkEvent) -> bool {
        self.events
            .send(server::Event::Sink(self.run, event))
            .is_ok()
    }

    /// The framebuffer size; a full frame of tiles follows.
    pub fn resize(&self, width: u32, height: u32) -> bool {
        self.send(SinkEvent::Resize(width, height))
    }

    pub fn raw(&self, tile: TileRect, bgrx: Vec<u8>) -> bool {
        self.send(SinkEvent::Raw(tile, bgrx))
    }

    pub fn jpeg(&self, tile: TileRect, data: Vec<u8>) -> bool {
        self.send(SinkEvent::Jpeg(tile, data))
    }

    pub fn frame(&self) -> bool {
        self.send(SinkEvent::Frame)
    }

    /// The desktop's clipboard changed to this text.
    pub fn clipboard(&self, text: String) -> bool {
        self.send(SinkEvent::Clipboard(text))
    }

    /// The capture stopped on its own; nothing more follows.
    pub fn ended(&self, error: Option<String>) {
        self.send(SinkEvent::Ended(error));
    }
}

/// One running capture, plus input and clipboard for the same desktop. Calls
/// come from the server task and must not block.
pub trait StreamCapture: Send {
    /// JPEG quality 1 to 100 for busy tiles, or `None` for lossless only.
    fn set_quality(&mut self, quality: Option<u8>);
    /// Sends every tile again.
    fn refresh(&mut self);
    /// Coordinates are framebuffer pixels.
    fn move_to(&mut self, x: u32, y: u32);
    fn button(&mut self, button: MouseButton, down: bool, x: u32, y: u32);
    fn wheel(&mut self, direction: ScrollDirection, x: u32, y: u32);
    fn key(&mut self, key: StreamKey);
    fn set_clipboard(&mut self, text: String);
    fn stop(&mut self);
}

/// A platform's frame, input and clipboard source for the RFB server.
pub trait StreamBackend: Send + Sync {
    fn start(&self, sink: StreamSink) -> Result<Box<dyn StreamCapture>, String>;
}
