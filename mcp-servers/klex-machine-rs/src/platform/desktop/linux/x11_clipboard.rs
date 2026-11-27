//! Clipboard sharing for the built-in X11 stream, on its own thread and
//! connection. XFIXES reports each new owner of the CLIPBOARD selection,
//! whose text is then converted and sent to viewers. Text from a viewer
//! makes this client the owner, answering requests until another client
//! takes over. Text only, like every other stream.

use std::os::fd::AsRawFd;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, TryRecvError};
use std::time::{Duration, Instant};

use x11rb::connection::{Connection, RequestConnection};
use x11rb::protocol::Event;
use x11rb::protocol::xfixes::{ConnectionExt as _, SelectionEventMask};
use x11rb::protocol::xproto::{
    Atom, AtomEnum, ConnectionExt as _, CreateWindowAux, EventMask, PropMode, Property,
    SELECTION_NOTIFY_EVENT, SelectionNotifyEvent, SelectionRequestEvent, Timestamp, Window,
    WindowClass,
};
use x11rb::rust_connection::RustConnection;
use x11rb::wrapper::ConnectionExt as _;
use x11rb::{COPY_DEPTH_FROM_PARENT, CURRENT_TIME, NONE};

use crate::desktop::Warn;
use crate::desktop::rfb::StreamSink;
use crate::desktop::rfb::clipboard::MAX_CLIPBOARD_BYTES;

const CONVERSION_TIMEOUT: Duration = Duration::from_secs(5);
const TICK_MS: i32 = 50;
/// Each conversion lands on the next of these properties, so replies to one
/// that was given up on can't be taken for the current one.
const PROPERTIES: usize = 8;

struct Atoms {
    clipboard: Atom,
    targets: Atom,
    utf8: Atom,
    string: Atom,
    text: Atom,
    plain_utf8: Atom,
    plain: Atom,
    incr: Atom,
    /// Where converted text lands on this client's window.
    properties: Vec<Atom>,
}

impl Atoms {
    fn intern(conn: &RustConnection) -> Result<Self, String> {
        let names: [&[u8]; 7] = [
            b"CLIPBOARD",
            b"TARGETS",
            b"UTF8_STRING",
            b"TEXT",
            b"text/plain;charset=utf-8",
            b"text/plain",
            b"INCR",
        ];
        let properties: Vec<Vec<u8>> = (0..PROPERTIES)
            .map(|index| format!("KLEX_CLIPBOARD_{index}").into_bytes())
            .collect();
        let cookies = names
            .iter()
            .copied()
            .chain(properties.iter().map(Vec::as_slice))
            .map(|name| conn.intern_atom(false, name))
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        let mut atoms = Vec::new();
        for cookie in cookies {
            atoms.push(cookie.reply().map_err(|error| error.to_string())?.atom);
        }
        Ok(Self {
            clipboard: atoms[0],
            targets: atoms[1],
            utf8: atoms[2],
            string: AtomEnum::STRING.into(),
            text: atoms[3],
            plain_utf8: atoms[4],
            plain: atoms[5],
            incr: atoms[6],
            properties: atoms[7..].to_vec(),
        })
    }
}

/// A conversion of the current selection that has not finished.
struct Reading {
    target: Atom,
    property: Atom,
    /// When the selection got the owner this reads from.
    time: Timestamp,
    started: Instant,
    /// Chunks so far of a transfer the owner sends in parts.
    incremental: Option<Vec<u8>>,
}

struct Clipboard<'a> {
    conn: RustConnection,
    atoms: Atoms,
    window: Window,
    sink: &'a StreamSink,
    /// Text from a viewer while this client owns the selection.
    owned: Option<String>,
    reading: Option<Reading>,
    conversions: usize,
    /// When the selection changed, if it did since the last conversion
    /// started.
    changed: Option<Timestamp>,
}

/// Shares the clipboard until `running` clears or the viewer side closes.
pub fn run(
    display: &str,
    sink: &StreamSink,
    texts: &Receiver<String>,
    running: &AtomicBool,
    warn: &Warn,
) -> Result<(), String> {
    let (conn, screen) = RustConnection::connect(Some(display))
        .map_err(|error| format!("Can't open display: {display}: {error}"))?;
    let failed = |error: x11rb::errors::ReplyOrIdError| error.to_string();
    let root = conn.setup().roots[screen].root;
    let atoms = Atoms::intern(&conn)?;
    let window = conn.generate_id().map_err(|error| error.to_string())?;
    conn.create_window(
        COPY_DEPTH_FROM_PARENT,
        window,
        root,
        0,
        0,
        1,
        1,
        0,
        WindowClass::INPUT_ONLY,
        x11rb::COPY_FROM_PARENT,
        &CreateWindowAux::new().event_mask(EventMask::PROPERTY_CHANGE),
    )
    .map_err(|error| failed(error.into()))?;
    let watching = conn
        .xfixes_query_version(5, 0)
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some()
        && conn
            .xfixes_select_selection_input(
                window,
                atoms.clipboard,
                SelectionEventMask::SET_SELECTION_OWNER,
            )
            .is_ok();
    if !watching {
        warn(
            "This X display has no XFIXES extension, so copying on it does not reach viewers. Text copied in a viewer still reaches it.",
        );
    }
    let owner = conn
        .get_selection_owner(atoms.clipboard)
        .map_err(|error| failed(error.into()))?
        .reply()
        .map_err(|error| error.to_string())?
        .owner;
    let mut clipboard = Clipboard {
        changed: (watching && owner != NONE).then_some(CURRENT_TIME),
        conn,
        atoms,
        window,
        sink,
        owned: None,
        reading: None,
        conversions: 0,
    };
    clipboard
        .serve(texts, running)
        .map_err(|error| format!("Clipboard sharing stopped: {error}"))
}

impl Clipboard<'_> {
    fn serve(&mut self, texts: &Receiver<String>, running: &AtomicBool) -> Result<(), String> {
        let error = |error: x11rb::errors::ConnectionError| error.to_string();
        while running.load(Ordering::SeqCst) {
            loop {
                match texts.try_recv() {
                    Ok(text) => self.own(text)?,
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => return Ok(()),
                }
            }
            while let Some(event) = self.conn.poll_for_event().map_err(error)? {
                if !self.handle(event)? {
                    return Ok(());
                }
            }
            if self
                .reading
                .as_ref()
                .is_some_and(|reading| reading.started.elapsed() > CONVERSION_TIMEOUT)
            {
                self.reading = None;
            }
            if self.reading.is_none()
                && let Some(time) = self.changed.take()
            {
                self.convert(self.atoms.utf8, time)?;
            }
            self.conn.flush().map_err(error)?;
            let mut poll = libc::pollfd {
                fd: self.conn.stream().as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one valid pollfd; a failure only shortens the wait.
            unsafe { libc::poll(&mut poll, 1, TICK_MS) };
        }
        Ok(())
    }

    fn own(&mut self, text: String) -> Result<(), String> {
        self.conn
            .set_selection_owner(self.window, self.atoms.clipboard, CURRENT_TIME)
            .map_err(|error| error.to_string())?;
        self.owned = Some(text);
        // A conversion still running would report the text this replaced.
        self.reading = None;
        self.changed = None;
        Ok(())
    }

    fn convert(&mut self, target: Atom, time: Timestamp) -> Result<(), String> {
        let property = self.atoms.properties[self.conversions % PROPERTIES];
        self.conversions = self.conversions.wrapping_add(1);
        self.conn
            .delete_property(self.window, property)
            .map_err(|error| error.to_string())?;
        self.conn
            .convert_selection(self.window, self.atoms.clipboard, target, property, time)
            .map_err(|error| error.to_string())?;
        self.reading = Some(Reading {
            target,
            property,
            time,
            started: Instant::now(),
            incremental: None,
        });
        Ok(())
    }

    /// `false` once the stream is gone.
    fn handle(&mut self, event: Event) -> Result<bool, String> {
        match event {
            Event::XfixesSelectionNotify(event) if event.selection == self.atoms.clipboard => {
                if event.owner != self.window && event.owner != NONE {
                    self.changed = Some(event.selection_timestamp);
                }
            }
            Event::SelectionNotify(event) if event.requestor == self.window => {
                let Some((target, property, time)) = self
                    .reading
                    .as_ref()
                    .map(|reading| (reading.target, reading.property, reading.time))
                else {
                    return Ok(true);
                };
                if event.target != target {
                    return Ok(true);
                }
                if event.property == NONE {
                    // Owners may answer with the current time instead of ours.
                    if event.time != time && event.time != CURRENT_TIME {
                        return Ok(true);
                    }
                    self.reading = None;
                    // Owners without UTF8_STRING may still have Latin-1 text.
                    if target == self.atoms.utf8 {
                        self.convert(self.atoms.string, time)?;
                    }
                    return Ok(true);
                }
                if event.property != property {
                    return Ok(true);
                }
                let (kind, value) = self.take_property(property)?;
                if kind == self.atoms.incr {
                    if let Some(reading) = &mut self.reading {
                        reading.incremental = Some(Vec::new());
                    }
                    return Ok(true);
                }
                self.reading = None;
                return Ok(self.report(kind, value));
            }
            Event::PropertyNotify(event)
                if event.window == self.window
                    && event.state == Property::NEW_VALUE
                    && self.reading.as_ref().is_some_and(|reading| {
                        reading.incremental.is_some() && reading.property == event.atom
                    }) =>
            {
                let (kind, value) = self.take_property(event.atom)?;
                let Some(reading) = &mut self.reading else {
                    return Ok(true);
                };
                let Some(chunks) = &mut reading.incremental else {
                    return Ok(true);
                };
                if !value.is_empty() {
                    chunks.extend_from_slice(&value);
                    if chunks.len() > MAX_CLIPBOARD_BYTES {
                        self.reading = None;
                    }
                    return Ok(true);
                }
                let chunks = std::mem::take(chunks);
                self.reading = None;
                return Ok(self.report(kind, chunks));
            }
            Event::SelectionRequest(event) => self.answer(&event)?,
            Event::SelectionClear(event) if event.selection == self.atoms.clipboard => {
                self.owned = None;
            }
            _ => {}
        }
        Ok(true)
    }

    /// Reads and deletes the conversion property; deleting it asks an
    /// incremental owner for the next chunk.
    fn take_property(&self, property: Atom) -> Result<(Atom, Vec<u8>), String> {
        let reply = self
            .conn
            .get_property(
                true,
                self.window,
                property,
                AtomEnum::ANY,
                0,
                (MAX_CLIPBOARD_BYTES / 4 + 1) as u32,
            )
            .map_err(|error| error.to_string())?
            .reply()
            .map_err(|error| error.to_string())?;
        Ok((reply.type_, reply.value))
    }

    fn report(&self, kind: Atom, bytes: Vec<u8>) -> bool {
        match decode(&bytes, kind == self.atoms.string) {
            Some(text) => self.sink.clipboard(text),
            None => true,
        }
    }

    fn answer(&self, request: &SelectionRequestEvent) -> Result<(), String> {
        // Obsolete clients name no property; the target stands in for it.
        let property = if request.property == NONE {
            request.target
        } else {
            request.property
        };
        let served = match &self.owned {
            Some(text) if request.selection == self.atoms.clipboard => {
                self.serve_target(request.requestor, property, request.target, text)?
            }
            _ => false,
        };
        let notify = SelectionNotifyEvent {
            response_type: SELECTION_NOTIFY_EVENT,
            sequence: 0,
            time: request.time,
            requestor: request.requestor,
            selection: request.selection,
            target: request.target,
            property: if served { property } else { NONE },
        };
        self.conn
            .send_event(false, request.requestor, EventMask::NO_EVENT, notify)
            .map_err(|error| error.to_string())?;
        Ok(())
    }

    fn serve_target(
        &self,
        requestor: Window,
        property: Atom,
        target: Atom,
        text: &str,
    ) -> Result<bool, String> {
        let atoms = &self.atoms;
        let failed = |error: x11rb::errors::ConnectionError| error.to_string();
        if target == atoms.targets {
            let targets = [
                atoms.targets,
                atoms.utf8,
                atoms.string,
                atoms.text,
                atoms.plain_utf8,
                atoms.plain,
            ];
            self.conn
                .change_property32(
                    PropMode::REPLACE,
                    requestor,
                    property,
                    AtomEnum::ATOM,
                    &targets,
                )
                .map_err(failed)?;
            return Ok(true);
        }
        let (kind, bytes) = if target == atoms.utf8 || target == atoms.text {
            (atoms.utf8, text.as_bytes().to_vec())
        } else if target == atoms.plain_utf8 {
            (atoms.plain_utf8, text.as_bytes().to_vec())
        } else if target == atoms.string || target == atoms.plain {
            (target, latin1(text))
        } else {
            return Ok(false);
        };
        // Text past one request would need an incremental transfer.
        if bytes.len() + 64 > self.conn.maximum_request_bytes() {
            return Ok(false);
        }
        self.conn
            .change_property8(PropMode::REPLACE, requestor, property, kind, &bytes)
            .map_err(failed)?;
        Ok(true)
    }
}

fn decode(bytes: &[u8], latin1: bool) -> Option<String> {
    let text = if latin1 {
        bytes.iter().map(|&byte| char::from(byte)).collect()
    } else {
        String::from_utf8_lossy(bytes).into_owned()
    };
    let text = text.trim_end_matches('\0');
    (!text.is_empty() && text.len() <= MAX_CLIPBOARD_BYTES).then(|| text.to_string())
}

fn latin1(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| u8::try_from(u32::from(c)).unwrap_or(b'?'))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_and_latin1_text() {
        assert_eq!(decode(b"caf\xc3\xa9\0", false).as_deref(), Some("café"));
        assert_eq!(decode(b"caf\xe9", true).as_deref(), Some("café"));
        assert_eq!(decode(b"", false), None);
        assert_eq!(decode(&vec![b'a'; MAX_CLIPBOARD_BYTES + 1], false), None);
        assert_eq!(latin1("café €"), b"caf\xe9 ?");
    }
}
