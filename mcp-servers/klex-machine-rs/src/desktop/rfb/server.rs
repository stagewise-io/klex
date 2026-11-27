//! A built-in RFB server over in-memory streams: no listener, no password.
//! Each `open()` returns one end of a duplex pair for one viewer. Viewers
//! share one capture, which runs only while at least one is connected. One
//! task owns all state; sockets, timers and the capture report to it.

use std::collections::BTreeMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use tokio::io::{AsyncReadExt, AsyncWriteExt, DuplexStream};
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender, unbounded_channel};

use super::clipboard::MAX_CLIPBOARD_BYTES;
use super::framebuffer::Framebuffer;
use super::session::{Host, JpegSupport, Session};
use super::{SinkEvent, StreamBackend, StreamCapture, StreamSink, TileRect};

/// A capture that sends no framebuffer within this time has failed.
const READY_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_DIMENSION: u32 = 16_384;
const STREAM_BUFFER_BYTES: usize = 256 * 1024;

pub(crate) enum Event {
    Open(DuplexStream),
    Read(u64, Vec<u8>),
    ReadClosed(u64),
    Flushed(u64, usize),
    HeldTimeout(u64, u64),
    ReadyTimeout(u64),
    Sink(u64, SinkEvent),
}

pub struct Run {
    id: u64,
    pub capture: Box<dyn StreamCapture>,
    pub framebuffer: Option<Framebuffer>,
    pub clipboard: Option<String>,
    /// Text a viewer just put on the clipboard, so its echo is not announced.
    from_viewer: Option<String>,
    quality: Option<u8>,
}

impl Run {
    pub fn set_clipboard_from_viewer(&mut self, text: String) {
        if text.len() > MAX_CLIPBOARD_BYTES {
            return;
        }
        self.from_viewer = Some(text.clone());
        self.clipboard = Some(text.clone());
        self.capture.set_clipboard(text);
    }
}

pub type ErrorHook = Arc<dyn Fn(&str) + Send + Sync>;

pub struct RfbServer {
    backend: Arc<dyn StreamBackend>,
    name: String,
    on_error: Option<ErrorHook>,
    events: Mutex<Option<UnboundedSender<Event>>>,
}

impl RfbServer {
    pub fn new(backend: Arc<dyn StreamBackend>, name: impl Into<String>) -> Self {
        Self {
            backend,
            name: name.into(),
            on_error: None,
            events: Mutex::new(None),
        }
    }

    /// Receives why a capture failed.
    pub fn on_error(mut self, hook: ErrorHook) -> Self {
        self.on_error = Some(hook);
        self
    }

    /// Opens a connection for one viewer. Must run inside a Tokio runtime.
    pub fn open(&self) -> DuplexStream {
        let (viewer, server) = tokio::io::duplex(STREAM_BUFFER_BYTES);
        let mut events = self
            .events
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let sender = events.get_or_insert_with(|| {
            let (sender, receiver) = unbounded_channel();
            let state = State {
                backend: self.backend.clone(),
                name: self.name.clone(),
                on_error: self.on_error.clone(),
                events: sender.clone(),
                sessions: BTreeMap::new(),
                run: None,
                next_id: 0,
            };
            tokio::spawn(state.serve(receiver));
            sender.clone()
        });
        let _ = sender.send(Event::Open(server));
        viewer
    }
}

struct State {
    backend: Arc<dyn StreamBackend>,
    name: String,
    on_error: Option<ErrorHook>,
    events: UnboundedSender<Event>,
    sessions: BTreeMap<u64, Session>,
    run: Option<Run>,
    next_id: u64,
}

macro_rules! host {
    ($state:expr) => {
        Host {
            name: &$state.name,
            run: $state.run.as_mut(),
            events: &$state.events,
        }
    };
}

impl State {
    async fn serve(mut self, mut receiver: UnboundedReceiver<Event>) {
        while let Some(event) = receiver.recv().await {
            self.handle(event);
        }
    }

    fn handle(&mut self, event: Event) {
        match event {
            Event::Open(stream) => self.open(stream),
            Event::Read(id, data) => {
                if let Some(session) = self.sessions.get_mut(&id) {
                    session.receive(&mut host!(self), &data);
                }
                self.settle(id);
            }
            Event::ReadClosed(id) => {
                if let Some(session) = self.sessions.get_mut(&id) {
                    session.close(&mut host!(self), None);
                }
                self.settle(id);
            }
            Event::Flushed(id, bytes) => {
                if let Some(session) = self.sessions.get_mut(&id) {
                    session.flushed(&mut host!(self), bytes);
                }
                self.settle(id);
            }
            Event::HeldTimeout(id, generation) => {
                if let Some(session) = self.sessions.get_mut(&id) {
                    session.held_timeout(&mut host!(self), generation);
                }
                self.settle(id);
            }
            Event::ReadyTimeout(run) => {
                if self
                    .run
                    .as_ref()
                    .is_some_and(|current| current.id == run && current.framebuffer.is_none())
                {
                    self.fail("The desktop capture did not start".into());
                }
            }
            Event::Sink(run, event) => {
                if self.run.as_ref().is_some_and(|current| current.id == run) {
                    self.sink(event);
                }
            }
        }
    }

    fn open(&mut self, stream: DuplexStream) {
        self.next_id += 1;
        let id = self.next_id;
        let (mut read, mut write) = tokio::io::split(stream);
        let (out, mut outgoing) = unbounded_channel::<Vec<u8>>();
        let events = self.events.clone();
        tokio::spawn(async move {
            while let Some(data) = outgoing.recv().await {
                if write.write_all(&data).await.is_err() {
                    break;
                }
                let _ = events.send(Event::Flushed(id, data.len()));
            }
            let _ = write.shutdown().await;
        });
        let events = self.events.clone();
        let reader = tokio::spawn(async move {
            let mut buffer = vec![0u8; 64 * 1024];
            loop {
                match read.read(&mut buffer).await {
                    Ok(0) | Err(_) => break,
                    Ok(count) => {
                        if events
                            .send(Event::Read(id, buffer[..count].to_vec()))
                            .is_err()
                        {
                            return;
                        }
                    }
                }
            }
            let _ = events.send(Event::ReadClosed(id));
        });
        self.sessions.insert(id, Session::new(id, out, reader));
        if self.run.is_none()
            && let Err(error) = self.start()
        {
            if let Some(session) = self.sessions.get_mut(&id) {
                session.close(&mut host!(self), Some(error));
            }
            self.settle(id);
        }
    }

    fn start(&mut self) -> Result<(), String> {
        self.next_id += 1;
        let id = self.next_id;
        let sink = StreamSink {
            run: id,
            events: self.events.clone(),
        };
        let capture = self.backend.start(sink)?;
        self.run = Some(Run {
            id,
            capture,
            framebuffer: None,
            clipboard: None,
            from_viewer: None,
            quality: None,
        });
        let events = self.events.clone();
        tokio::spawn(async move {
            tokio::time::sleep(READY_TIMEOUT).await;
            let _ = events.send(Event::ReadyTimeout(id));
        });
        Ok(())
    }

    fn sink(&mut self, event: SinkEvent) {
        let Some(run) = self.run.as_mut() else {
            return;
        };
        match event {
            SinkEvent::Resize(width, height) => {
                if width == 0 || height == 0 || width > MAX_DIMENSION || height > MAX_DIMENSION {
                    self.fail(format!("Invalid desktop size {width}x{height}"));
                    return;
                }
                let first = run.framebuffer.is_none();
                let framebuffer = Framebuffer::new(width, height);
                let tiles = framebuffer.tiles.len();
                run.framebuffer = Some(framebuffer);
                let ids: Vec<u64> = self.sessions.keys().copied().collect();
                for id in ids {
                    if let Some(session) = self.sessions.get_mut(&id) {
                        if first {
                            session.start(&mut host!(self));
                        } else {
                            session.resized(&mut host!(self), tiles);
                        }
                    }
                    self.settle(id);
                }
            }
            SinkEvent::Raw(tile, pixels) => {
                let Some(framebuffer) = run.framebuffer.as_mut() else {
                    return;
                };
                if !framebuffer.stage_raw(tile, pixels) {
                    self.bad_tile(tile);
                }
            }
            SinkEvent::Jpeg(tile, data) => {
                let Some(framebuffer) = run.framebuffer.as_mut() else {
                    return;
                };
                if !framebuffer.stage_jpeg(tile, data) {
                    self.bad_tile(tile);
                }
            }
            SinkEvent::Frame => {
                if !run
                    .framebuffer
                    .as_mut()
                    .is_some_and(|framebuffer| framebuffer.commit())
                {
                    return;
                }
                self.each_session(|session, host| session.update(host));
            }
            SinkEvent::Clipboard(text) => {
                if text.len() > MAX_CLIPBOARD_BYTES {
                    return;
                }
                let echo = run.from_viewer.as_deref() == Some(text.as_str());
                run.from_viewer = None;
                run.clipboard = Some(text);
                if echo {
                    return;
                }
                self.each_session(|session, host| session.clipboard_changed(host));
            }
            SinkEvent::Ended(error) => {
                self.fail(error.unwrap_or_else(|| "The desktop capture stopped".into()));
            }
        }
    }

    fn each_session(&mut self, mut action: impl FnMut(&mut Session, &mut Host<'_>)) {
        let ids: Vec<u64> = self.sessions.keys().copied().collect();
        for id in ids {
            if let Some(session) = self.sessions.get_mut(&id) {
                action(session, &mut host!(self));
            }
            self.settle(id);
        }
    }

    fn bad_tile(&mut self, tile: TileRect) {
        self.fail(format!(
            "The desktop capture sent an invalid tile at {},{} ({}x{})",
            tile.x, tile.y, tile.width, tile.height
        ));
    }

    fn fail(&mut self, error: String) {
        if self.run.is_none() {
            return;
        }
        if let Some(hook) = &self.on_error {
            hook(&error);
        }
        self.stop();
        let ids: Vec<u64> = self.sessions.keys().copied().collect();
        for id in ids {
            if let Some(session) = self.sessions.get_mut(&id) {
                session.close(&mut host!(self), Some(error.clone()));
            }
            self.settle(id);
        }
    }

    fn stop(&mut self) {
        if let Some(mut run) = self.run.take() {
            run.capture.stop();
        }
    }

    /// Applies what a session call left behind: removal once closed, and a
    /// new capture quality when its JPEG support changed.
    fn settle(&mut self, id: u64) {
        let Some(session) = self.sessions.get_mut(&id) else {
            return;
        };
        if session.closed() {
            self.sessions.remove(&id);
            if self.sessions.is_empty() {
                self.stop();
            } else {
                self.update_quality();
            }
            return;
        }
        if std::mem::take(&mut session.quality_changed) {
            self.update_quality();
        }
    }

    fn update_quality(&mut self) {
        let Some(run) = self.run.as_mut() else {
            return;
        };
        let accepted: Vec<JpegSupport> = self
            .sessions
            .values()
            .map(Session::jpeg_support)
            .filter(|support| *support != JpegSupport::Unknown)
            .collect();
        if accepted.is_empty() {
            return;
        }
        let quality = if accepted.contains(&JpegSupport::None) {
            None
        } else {
            accepted
                .iter()
                .filter_map(|support| match support {
                    JpegSupport::Quality(quality) => Some(*quality),
                    _ => None,
                })
                .min()
        };
        if quality == run.quality {
            return;
        }
        let was_lossy = run.quality.is_some();
        run.quality = quality;
        run.capture.set_quality(quality);
        // Tiles already sent as JPEG cannot reach a viewer that takes none.
        if was_lossy && quality.is_none() {
            run.capture.refresh();
        }
    }
}
