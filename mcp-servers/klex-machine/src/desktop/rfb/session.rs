//! Server half of one RFB 3.3/3.7/3.8 viewer with security None, always
//! shared. Updates follow the viewer's requests and carry only tiles changed
//! since the viewer last received them, so a slow viewer skips frames
//! instead of queueing them. Input is passed on as is: the stream relays
//! already drop it for viewers without control.

use std::collections::HashSet;
use std::sync::Arc;
use std::time::Duration;

use indexmap::IndexMap;
use tokio::sync::mpsc::UnboundedSender;
use tokio::task::JoinHandle;

use super::clipboard::{
    CLIPBOARD_TEXT, ClipboardMessage, EXTENDED_CLIPBOARD, clipboard_caps, clipboard_notify,
    clipboard_provide, clipboard_request, decode_legacy_cut_text, legacy_cut_text,
    parse_clipboard_message,
};
use super::encoding::{
    ENCODING_RAW, ENCODING_TIGHT, JPEG_QUALITY_BY_LEVEL, PixelFormat, SERVER_PIXEL_FORMAT,
    encode_raw, encode_tight, encode_tight_jpeg, rect_header,
};
use super::filter::{RfbProtocolError, message_length, parse_version};
use super::framebuffer::{EncodedKey, Framebuffer};
use super::server::{Event, Run};
use super::{StreamKey, TileRect};
use crate::desktop::provider::{MouseButton, ScrollDirection};

const SERVER_VERSION: &[u8] = b"RFB 003.008\n";
const SECURITY_NONE: u8 = 1;

const QUALITY_LEVEL_0: i32 = -32;
const COMPRESS_LEVEL_0: i32 = -256;
const DESKTOP_SIZE: i32 = -223;
const QEMU_EXTENDED_KEY: i32 = -258;
const EXTENDED_DESKTOP_SIZE: i32 = -308;
const DEFAULT_ZLIB_LEVEL: u32 = 6;
/// Writes beyond this many unflushed bytes pause updates until they drain.
const HIGH_WATER: usize = 16 * 1024;

/// How long input waits for clipboard text a viewer announced. Viewers paste
/// by announcing their clipboard and pressing V right away, so V must not
/// reach the desktop before the text it pastes.
pub const CLIPBOARD_WAIT: Duration = Duration::from_millis(1_000);
const MAX_HELD_INPUT: usize = 1_000;

const BUTTONS: [(u8, MouseButton); 3] = [
    (1, MouseButton::Left),
    (2, MouseButton::Middle),
    (4, MouseButton::Right),
];
const WHEELS: [(u8, ScrollDirection); 4] = [
    (8, ScrollDirection::Up),
    (16, ScrollDirection::Down),
    (32, ScrollDirection::Left),
    (64, ScrollDirection::Right),
];

/// What a session reaches of the server that owns the capture.
pub struct Host<'a> {
    pub name: &'a str,
    pub run: Option<&'a mut Run>,
    pub events: &'a UnboundedSender<Event>,
}

impl Host<'_> {
    fn framebuffer(&self) -> Option<&Framebuffer> {
        self.run.as_ref()?.framebuffer.as_ref()
    }

    fn clipboard_text(&self) -> Option<String> {
        self.run.as_ref()?.clipboard.clone()
    }

    fn move_to(&mut self, x: u32, y: u32) {
        if let Some(run) = self.run.as_mut() {
            run.capture.move_to(x, y);
        }
    }

    fn button(&mut self, button: MouseButton, down: bool, x: u32, y: u32) {
        if let Some(run) = self.run.as_mut() {
            run.capture.button(button, down, x, y);
        }
    }

    fn wheel(&mut self, direction: ScrollDirection, x: u32, y: u32) {
        if let Some(run) = self.run.as_mut() {
            run.capture.wheel(direction, x, y);
        }
    }

    fn key(&mut self, key: StreamKey) {
        if let Some(run) = self.run.as_mut() {
            run.capture.key(key);
        }
    }

    fn set_clipboard(&mut self, text: String) {
        if let Some(run) = self.run.as_mut() {
            run.set_clipboard_from_viewer(text);
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Phase {
    Version,
    Security,
    Init,
    Waiting,
    Messages,
    Closed,
}

/// The JPEG quality a viewer accepts.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum JpegSupport {
    /// The viewer has not sent its encodings yet.
    Unknown,
    None,
    Quality(u8),
}

enum HeldInput {
    Key(StreamKey),
    Pointer(u8, u32, u32),
    Clipboard(String),
}

struct Held {
    generation: u64,
    queue: Vec<HeldInput>,
}

#[derive(Clone, Copy)]
struct SizeAnnouncement {
    reason: u16,
    status: u16,
}

pub struct Session {
    pub id: u64,
    out: Option<UnboundedSender<Vec<u8>>>,
    reader: JoinHandle<()>,
    unflushed: usize,
    draining: bool,
    phase: Phase,
    minor: u32,
    buffer: Vec<u8>,
    format: PixelFormat,
    encodings: HashSet<i32>,
    resized_early: bool,
    negotiated: bool,
    jpeg_level: Option<usize>,
    zlib_level: u32,
    request: Option<TileRect>,
    sent: Vec<u32>,
    pending_extended_size: Option<SizeAnnouncement>,
    pending_desktop_size: bool,
    pending_qemu: bool,
    announced_extended_size: bool,
    announced_qemu: bool,
    sent_clipboard_caps: bool,
    keys: IndexMap<String, StreamKey>,
    buttons: u8,
    pointer: (i64, i64),
    held: Option<Held>,
    held_generation: u64,
    /// The session's JPEG support changed since the server last looked.
    pub quality_changed: bool,
}

impl Session {
    pub fn new(id: u64, out: UnboundedSender<Vec<u8>>, reader: JoinHandle<()>) -> Self {
        let mut session = Self {
            id,
            out: Some(out),
            reader,
            unflushed: 0,
            draining: false,
            phase: Phase::Version,
            minor: 8,
            buffer: Vec::new(),
            format: SERVER_PIXEL_FORMAT,
            encodings: HashSet::new(),
            resized_early: false,
            negotiated: false,
            jpeg_level: None,
            zlib_level: DEFAULT_ZLIB_LEVEL,
            request: None,
            sent: Vec::new(),
            pending_extended_size: None,
            pending_desktop_size: false,
            pending_qemu: false,
            announced_extended_size: false,
            announced_qemu: false,
            sent_clipboard_caps: false,
            keys: IndexMap::new(),
            buttons: 0,
            pointer: (-1, -1),
            held: None,
            held_generation: 0,
            quality_changed: false,
        };
        session.write(SERVER_VERSION.to_vec());
        session
    }

    pub fn closed(&self) -> bool {
        self.phase == Phase::Closed
    }

    pub fn jpeg_support(&self) -> JpegSupport {
        if !self.negotiated {
            return JpegSupport::Unknown;
        }
        match self.jpeg_level.filter(|_| self.jpeg_allowed()) {
            Some(level) => JpegSupport::Quality(JPEG_QUALITY_BY_LEVEL[level]),
            None => JpegSupport::None,
        }
    }

    /// The framebuffer was replaced by one of another size. The new size
    /// goes out with the first frame committed to it.
    pub fn resized(&mut self, host: &mut Host<'_>, tiles: usize) {
        if self.phase != Phase::Messages {
            return;
        }
        self.sent = vec![0; tiles];
        // Until SetEncodings arrives the viewer's resize support is unknown.
        // An update request before it means the viewer settled for the defaults.
        if self.negotiated {
            self.follow_resize(host);
        } else {
            self.resized_early = true;
        }
    }

    /// Queues the new size for the viewer, or closes it. False when closed.
    fn follow_resize(&mut self, host: &mut Host<'_>) -> bool {
        if self.encodings.contains(&EXTENDED_DESKTOP_SIZE) {
            self.pending_extended_size = Some(SizeAnnouncement {
                reason: 0,
                status: 0,
            });
        } else if self.encodings.contains(&DESKTOP_SIZE) {
            self.pending_desktop_size = true;
        } else {
            self.close(host, Some("The viewer cannot follow a resize".into()));
            return false;
        }
        true
    }

    /// New tiles were committed.
    pub fn update(&mut self, host: &mut Host<'_>) {
        if self.phase != Phase::Messages || self.request.is_none() || self.draining {
            return;
        }
        if self.resized_early {
            self.resized_early = false;
            if !self.follow_resize(host) {
                return;
            }
        }
        let jpeg = self.jpeg_allowed();
        let tight = self.tight_allowed();
        let (format, zlib_level) = (self.format, self.zlib_level);
        let Some(framebuffer) = host.run.as_mut().and_then(|run| run.framebuffer.as_mut()) else {
            return;
        };
        let full = TileRect {
            x: 0,
            y: 0,
            width: framebuffer.width,
            height: framebuffer.height,
        };
        let mut rects: Vec<Arc<Vec<u8>>> = Vec::new();
        if let Some(announcement) = self.pending_extended_size {
            rects.push(Arc::new(extended_desktop_size(framebuffer, announcement)));
        } else if self.pending_desktop_size {
            rects.push(Arc::new(rect_header(full, DESKTOP_SIZE)));
        }
        if self.pending_qemu {
            rects.push(Arc::new(rect_header(
                TileRect {
                    x: 0,
                    y: 0,
                    width: 0,
                    height: 0,
                },
                QEMU_EXTENDED_KEY,
            )));
        }
        // A request made before a resize covers the old size.
        let rect = if self
            .pending_extended_size
            .is_some_and(|announcement| announcement.reason == 0)
            || self.pending_desktop_size
        {
            full
        } else {
            self.request.unwrap_or(full)
        };
        if self.sent.len() != framebuffer.tiles.len() {
            self.sent = vec![0; framebuffer.tiles.len()];
        }
        for index in 0..framebuffer.tiles.len() {
            let tile = &framebuffer.tiles[index];
            if tile.version == 0
                || tile.version == self.sent[index]
                || (tile.jpeg.is_some() && !jpeg)
                || !tile.rect.intersects(&rect)
            {
                continue;
            }
            rects.push(encode(framebuffer, index, tight, format, zlib_level));
            self.sent[index] = framebuffer.tiles[index].version;
        }
        if rects.is_empty() {
            return;
        }
        self.pending_extended_size = None;
        self.pending_desktop_size = false;
        self.pending_qemu = false;
        self.request = None;
        let size: usize = rects.iter().map(|rect| rect.len()).sum();
        let mut message = Vec::with_capacity(4 + size);
        message.extend_from_slice(&[0, 0]);
        message.extend_from_slice(&(rects.len() as u16).to_be_bytes());
        for rect in rects {
            message.extend_from_slice(&rect);
        }
        self.write(message);
    }

    /// The desktop's clipboard changed.
    pub fn clipboard_changed(&mut self, host: &Host<'_>) {
        if self.phase != Phase::Messages {
            return;
        }
        if self.encodings.contains(&EXTENDED_CLIPBOARD) {
            self.write(clipboard_notify(true));
            return;
        }
        if let Some(text) = host.clipboard_text() {
            self.write(legacy_cut_text(&text));
        }
    }

    pub fn close(&mut self, host: &mut Host<'_>, _error: Option<String>) {
        if self.phase == Phase::Closed {
            return;
        }
        self.phase = Phase::Closed;
        self.held = None;
        for (_, key) in std::mem::take(&mut self.keys) {
            host.key(StreamKey { down: false, ..key });
        }
        for (bit, button) in BUTTONS {
            if self.buttons & bit != 0 {
                host.button(
                    button,
                    false,
                    self.pointer.0.max(0) as u32,
                    self.pointer.1.max(0) as u32,
                );
            }
        }
        self.buttons = 0;
        // Queued writes still flush; the writer then shuts the stream down.
        self.out = None;
        self.reader.abort();
    }

    fn write(&mut self, data: Vec<u8>) {
        if self.phase == Phase::Closed {
            return;
        }
        let Some(out) = &self.out else {
            return;
        };
        self.unflushed += data.len();
        if out.send(data).is_err() {
            return;
        }
        if self.unflushed > HIGH_WATER {
            self.draining = true;
        }
    }

    /// The writer flushed `bytes` to the viewer.
    pub fn flushed(&mut self, host: &mut Host<'_>, bytes: usize) {
        self.unflushed = self.unflushed.saturating_sub(bytes);
        if self.draining && self.unflushed == 0 {
            self.draining = false;
            self.update(host);
        }
    }

    pub fn receive(&mut self, host: &mut Host<'_>, chunk: &[u8]) {
        if self.phase == Phase::Closed {
            return;
        }
        self.buffer.extend_from_slice(chunk);
        if let Err(error) = self.process(host) {
            self.close(host, Some(error.0));
        }
    }

    fn process(&mut self, host: &mut Host<'_>) -> Result<(), RfbProtocolError> {
        loop {
            let length = match self.phase {
                Phase::Version => Some(12),
                Phase::Security | Phase::Init => Some(1),
                Phase::Waiting | Phase::Closed => None,
                Phase::Messages => message_length(&self.buffer)?,
            };
            let Some(length) = length.filter(|length| self.buffer.len() >= *length) else {
                return Ok(());
            };
            // Drained first: accepting a message can re-enter `process`.
            let message: Vec<u8> = self.buffer.drain(..length).collect();
            self.accept(host, &message)?;
            if matches!(self.phase, Phase::Waiting | Phase::Closed) {
                return Ok(());
            }
        }
    }

    fn accept(&mut self, host: &mut Host<'_>, message: &[u8]) -> Result<(), RfbProtocolError> {
        match self.phase {
            Phase::Version => {
                let minor = parse_version(message)?;
                self.minor = if minor >= 8 {
                    8
                } else if minor == 7 {
                    7
                } else {
                    3
                };
                if self.minor == 3 {
                    self.write(u32::from(SECURITY_NONE).to_be_bytes().to_vec());
                    self.phase = Phase::Init;
                } else {
                    self.write(vec![1, SECURITY_NONE]);
                    self.phase = Phase::Security;
                }
            }
            Phase::Security => {
                if message[0] != SECURITY_NONE {
                    if self.minor == 8 {
                        let reason = b"Only security type None is offered";
                        let mut failure = 1u32.to_be_bytes().to_vec();
                        failure.extend_from_slice(&(reason.len() as u32).to_be_bytes());
                        failure.extend_from_slice(reason);
                        self.write(failure);
                    }
                    return Err(RfbProtocolError("Unsupported RFB security type".into()));
                }
                if self.minor == 8 {
                    self.write(vec![0; 4]);
                }
                self.phase = Phase::Init;
            }
            Phase::Init => {
                self.phase = Phase::Waiting;
                if host.run.is_none() {
                    return Err(RfbProtocolError(
                        "The desktop capture is not running".into(),
                    ));
                }
                if host.framebuffer().is_some() {
                    self.start(host);
                }
            }
            Phase::Messages => self.message(host, message)?,
            Phase::Waiting | Phase::Closed => {}
        }
        Ok(())
    }

    /// The capture's first framebuffer is ready.
    pub fn start(&mut self, host: &mut Host<'_>) {
        if self.phase != Phase::Waiting {
            return;
        }
        let Some(framebuffer) = host.framebuffer() else {
            return;
        };
        let mut init = Vec::with_capacity(24 + host.name.len());
        init.extend_from_slice(&(framebuffer.width as u16).to_be_bytes());
        init.extend_from_slice(&(framebuffer.height as u16).to_be_bytes());
        init.extend_from_slice(&SERVER_PIXEL_FORMAT.write());
        init.extend_from_slice(&(host.name.len() as u32).to_be_bytes());
        init.extend_from_slice(host.name.as_bytes());
        self.sent = vec![0; framebuffer.tiles.len()];
        self.write(init);
        self.phase = Phase::Messages;
        self.receive(host, &[]);
    }

    fn message(&mut self, host: &mut Host<'_>, message: &[u8]) -> Result<(), RfbProtocolError> {
        let u16_at = |at: usize| u16::from_be_bytes([message[at], message[at + 1]]);
        let u32_at = |at: usize| {
            u32::from_be_bytes([
                message[at],
                message[at + 1],
                message[at + 2],
                message[at + 3],
            ])
        };
        match message[0] {
            0 => {
                let format = PixelFormat::read(&message[4..]);
                if let Some(problem) = format.unsupported() {
                    return Err(RfbProtocolError(format!("SetPixelFormat: {problem}")));
                }
                self.format = format;
                self.quality_changed = true;
            }
            2 => self.set_encodings(host, message),
            3 => self.update_request(host, message),
            4 => self.key(
                host,
                StreamKey {
                    down: message[1] != 0,
                    keysym: u32_at(4),
                    keycode: 0,
                },
            ),
            5 => self.input(
                host,
                HeldInput::Pointer(message[1], u32::from(u16_at(2)), u32::from(u16_at(4))),
            ),
            6 => self.cut_text(host, message),
            251 => {
                if self.encodings.contains(&EXTENDED_DESKTOP_SIZE) {
                    // The desktop's resolution belongs to its user, not the viewer.
                    self.pending_extended_size = Some(SizeAnnouncement {
                        reason: 1,
                        status: 1,
                    });
                    self.update(host);
                }
            }
            255 => self.key(
                host,
                StreamKey {
                    down: u16_at(2) != 0,
                    keysym: u32_at(4),
                    keycode: u32_at(8),
                },
            ),
            // EnableContinuousUpdates and fences are never offered.
            _ => {}
        }
        Ok(())
    }

    fn set_encodings(&mut self, host: &mut Host<'_>, message: &[u8]) {
        let count = u16::from_be_bytes([message[2], message[3]]) as usize;
        let mut encodings = HashSet::new();
        let mut jpeg_level = None;
        let mut zlib_level = None;
        for index in 0..count {
            let at = 4 + index * 4;
            let encoding = i32::from_be_bytes([
                message[at],
                message[at + 1],
                message[at + 2],
                message[at + 3],
            ]);
            encodings.insert(encoding);
            if jpeg_level.is_none() && (QUALITY_LEVEL_0..=QUALITY_LEVEL_0 + 9).contains(&encoding) {
                jpeg_level = Some((encoding - QUALITY_LEVEL_0) as usize);
            }
            if zlib_level.is_none() && (COMPRESS_LEVEL_0..=COMPRESS_LEVEL_0 + 9).contains(&encoding)
            {
                zlib_level = Some((encoding - COMPRESS_LEVEL_0) as u32);
            }
        }
        self.encodings = encodings;
        self.jpeg_level = jpeg_level;
        self.zlib_level = zlib_level.unwrap_or(DEFAULT_ZLIB_LEVEL).max(1);
        self.negotiated = true;
        if self.encodings.contains(&EXTENDED_DESKTOP_SIZE) && !self.announced_extended_size {
            self.announced_extended_size = true;
            self.pending_extended_size.get_or_insert(SizeAnnouncement {
                reason: 0,
                status: 0,
            });
        }
        if self.resized_early {
            self.resized_early = false;
            if !self.follow_resize(host) {
                return;
            }
        }
        if self.encodings.contains(&QEMU_EXTENDED_KEY) && !self.announced_qemu {
            self.announced_qemu = true;
            self.pending_qemu = true;
        }
        if self.encodings.contains(&EXTENDED_CLIPBOARD) && !self.sent_clipboard_caps {
            self.sent_clipboard_caps = true;
            self.write(clipboard_caps());
        }
        self.quality_changed = true;
        self.update(host);
    }

    fn update_request(&mut self, host: &mut Host<'_>, message: &[u8]) {
        let Some(framebuffer) = host.framebuffer() else {
            return;
        };
        let u16_at = |at: usize| u32::from(u16::from_be_bytes([message[at], message[at + 1]]));
        let incremental = message[1] != 0;
        let rect = TileRect {
            x: u16_at(2),
            y: u16_at(4),
            width: u16_at(6),
            height: u16_at(8),
        };
        if !incremental {
            if self.sent.len() != framebuffer.tiles.len() {
                self.sent = vec![0; framebuffer.tiles.len()];
            }
            for (index, tile) in framebuffer.tiles.iter().enumerate() {
                if tile.rect.intersects(&rect) {
                    self.sent[index] = 0;
                }
            }
        }
        self.request = Some(rect);
        self.update(host);
    }

    fn tight_allowed(&self) -> bool {
        self.encodings.contains(&ENCODING_TIGHT) && self.format.tight_compatible()
    }

    fn jpeg_allowed(&self) -> bool {
        self.tight_allowed() && self.jpeg_level.is_some()
    }

    fn cut_text(&mut self, host: &mut Host<'_>, message: &[u8]) {
        let length = i32::from_be_bytes([message[4], message[5], message[6], message[7]]);
        let payload = &message[8..];
        if length >= 0 {
            let text = decode_legacy_cut_text(payload);
            self.input(host, HeldInput::Clipboard(text));
            return;
        }
        match parse_clipboard_message(payload) {
            ClipboardMessage::Request(formats) => {
                if formats & CLIPBOARD_TEXT != 0
                    && let Some(text) = host.clipboard_text()
                {
                    self.write(clipboard_provide(&text));
                }
            }
            ClipboardMessage::Peek => {
                let has_text = host.clipboard_text().is_some();
                self.write(clipboard_notify(has_text));
            }
            ClipboardMessage::Notify(formats) => {
                if formats & CLIPBOARD_TEXT != 0 {
                    self.write(clipboard_request());
                    self.hold_input(host);
                }
            }
            ClipboardMessage::Provide(text) => {
                if let Some(text) = text {
                    host.set_clipboard(text);
                }
                self.release_input(host);
            }
            ClipboardMessage::Caps | ClipboardMessage::Unknown => {}
        }
    }

    fn key(&mut self, host: &mut Host<'_>, key: StreamKey) {
        self.input(host, HeldInput::Key(key));
    }

    fn input(&mut self, host: &mut Host<'_>, input: HeldInput) {
        if let Some(held) = self.held.as_mut() {
            held.queue.push(input);
            if held.queue.len() >= MAX_HELD_INPUT {
                self.release_input(host);
            }
            return;
        }
        self.apply(host, input);
    }

    fn apply(&mut self, host: &mut Host<'_>, input: HeldInput) {
        match input {
            HeldInput::Key(key) => {
                let id = if key.keycode != 0 {
                    format!("c{}", key.keycode)
                } else {
                    format!("s{}", key.keysym)
                };
                if key.down {
                    self.keys.insert(id, key);
                } else {
                    self.keys.shift_remove(&id);
                }
                host.key(key);
            }
            HeldInput::Pointer(mask, x, y) => {
                let Some(framebuffer) = host.framebuffer() else {
                    return;
                };
                let x = x.min(framebuffer.width.saturating_sub(1));
                let y = y.min(framebuffer.height.saturating_sub(1));
                if (i64::from(x), i64::from(y)) != self.pointer {
                    self.pointer = (i64::from(x), i64::from(y));
                    host.move_to(x, y);
                }
                for (bit, button) in BUTTONS {
                    if mask & bit != self.buttons & bit {
                        host.button(button, mask & bit != 0, x, y);
                    }
                }
                for (bit, direction) in WHEELS {
                    if mask & bit != 0 && self.buttons & bit == 0 {
                        host.wheel(direction, x, y);
                    }
                }
                self.buttons = mask;
            }
            HeldInput::Clipboard(text) => host.set_clipboard(text),
        }
    }

    fn hold_input(&mut self, host: &Host<'_>) {
        if self.held.is_some() {
            return;
        }
        self.held_generation += 1;
        let generation = self.held_generation;
        let events = host.events.clone();
        let id = self.id;
        tokio::spawn(async move {
            tokio::time::sleep(CLIPBOARD_WAIT).await;
            let _ = events.send(Event::HeldTimeout(id, generation));
        });
        self.held = Some(Held {
            generation,
            queue: Vec::new(),
        });
    }

    pub fn held_timeout(&mut self, host: &mut Host<'_>, generation: u64) {
        if self
            .held
            .as_ref()
            .is_some_and(|held| held.generation == generation)
        {
            self.release_input(host);
        }
    }

    fn release_input(&mut self, host: &mut Host<'_>) {
        let Some(held) = self.held.take() else {
            return;
        };
        for input in held.queue {
            if self.phase == Phase::Closed {
                return;
            }
            self.apply(host, input);
        }
    }
}

fn encode(
    framebuffer: &mut Framebuffer,
    index: usize,
    tight: bool,
    format: PixelFormat,
    zlib_level: u32,
) -> Arc<Vec<u8>> {
    let tile = &framebuffer.tiles[index];
    let jpeg = tile.jpeg.clone();
    let key = if jpeg.is_some() {
        EncodedKey::Jpeg
    } else if tight {
        EncodedKey::Tight(zlib_level)
    } else {
        EncodedKey::Raw(format.key())
    };
    if let Some(encoded) = tile.encoded.get(&key) {
        return encoded.clone();
    }
    let rect = tile.rect;
    let mut encoded;
    if let Some(jpeg) = jpeg {
        encoded = rect_header(rect, ENCODING_TIGHT);
        encoded.extend_from_slice(&encode_tight_jpeg(&jpeg));
    } else if tight {
        encoded = rect_header(rect, ENCODING_TIGHT);
        encoded.extend_from_slice(&encode_tight(
            &framebuffer.pixels(index),
            rect.width,
            rect.height,
            zlib_level,
        ));
    } else {
        encoded = rect_header(rect, ENCODING_RAW);
        encoded.extend_from_slice(&encode_raw(&framebuffer.pixels(index), &format));
    }
    let encoded = Arc::new(encoded);
    framebuffer.tiles[index]
        .encoded
        .insert(key, encoded.clone());
    encoded
}

fn extended_desktop_size(framebuffer: &Framebuffer, announcement: SizeAnnouncement) -> Vec<u8> {
    let mut out = rect_header(
        TileRect {
            x: u32::from(announcement.reason),
            y: u32::from(announcement.status),
            width: framebuffer.width,
            height: framebuffer.height,
        },
        EXTENDED_DESKTOP_SIZE,
    );
    let mut screen = [0u8; 20];
    screen[0] = 1;
    screen[12..14].copy_from_slice(&(framebuffer.width as u16).to_be_bytes());
    screen[14..16].copy_from_slice(&(framebuffer.height as u16).to_be_bytes());
    out.extend_from_slice(&screen);
    out
}
