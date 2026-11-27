//! Clipboard sharing through the portal's Clipboard interface on the
//! RemoteDesktop session: text only, like every other stream. Access is
//! requested before `Start`; the desktop's text is read on each
//! `SelectionOwnerChanged`, and text from a viewer is offered with
//! `SetSelection` and written out on `SelectionTransfer`.

use std::collections::HashMap;
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, OwnedFd};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ashpd::desktop::Session;
use ashpd::desktop::clipboard::{Clipboard, SetSelectionOptions};
use ashpd::desktop::remote_desktop::RemoteDesktop;
use ashpd::zbus::proxy::SignalStream;
use ashpd::zbus::{OwnedObjectPath, OwnedVariant, Variant};
use futures::StreamExt;
use tokio::task::JoinHandle;

use crate::desktop::rfb::clipboard::MAX_CLIPBOARD_BYTES;

const TRANSFER_TIMEOUT: Duration = Duration::from_secs(5);
/// Offered for text from a viewer, best first.
const OFFERED: &[&str] = &["text/plain;charset=utf-8", "text/plain"];
/// Text types worth reading, best first.
const TEXT_TYPES: &[&str] = &[
    "text/plain;charset=utf-8",
    "text/plain",
    "UTF8_STRING",
    "STRING",
    "TEXT",
];
/// Tried when the portal names no types. GNOME 46 sends its list wrapped in
/// a struct, which strict clients read as empty.
const ASSUMED_TYPES: &[&str] = &["text/plain;charset=utf-8", "text/plain"];

pub const UNAVAILABLE_HINT: &str = "Clipboard sharing is unavailable: this desktop's screen sharing portal has no Clipboard interface (GNOME 45 or newer has one). The stream works without it.";
pub const NOT_ENABLED_HINT: &str = "Clipboard sharing is unavailable: the screen sharing portal did not enable it for this session. The stream works without it.";

/// Asks for clipboard access on a session that has not started yet.
pub async fn request(
    connection: &ashpd::zbus::Connection,
    session: &Session<RemoteDesktop>,
    remote_desktop_version: u32,
) -> Result<Clipboard, String> {
    // RemoteDesktop version 2 added `clipboard_enabled` to Start.
    if remote_desktop_version < 2 {
        return Err(UNAVAILABLE_HINT.into());
    }
    let proxy = Clipboard::with_connection(connection.clone())
        .await
        .map_err(|_| UNAVAILABLE_HINT.to_string())?;
    proxy
        .request(session, Default::default())
        .await
        .map_err(|error| {
            let error = error.to_string();
            if super::is_missing_service(&error) {
                UNAVAILABLE_HINT.to_string()
            } else {
                format!(
                    "Clipboard sharing is unavailable: the portal refused it ({error}). The stream works without it."
                )
            }
        })?;
    Ok(proxy)
}

#[derive(Default)]
struct State {
    /// The desktop's text, numbered by change.
    host: Option<(u64, String)>,
    changes: u64,
    /// Text from a viewer that this session offers.
    offered: Option<Arc<String>>,
    /// Counts offers, so a read that started before one is dropped.
    offers: u64,
}

struct Shared {
    proxy: Clipboard,
    session: Arc<Session<RemoteDesktop>>,
    path: String,
    state: Mutex<State>,
}

impl Shared {
    fn state(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

pub struct PortalClipboard {
    shared: Arc<Shared>,
    tasks: Vec<JoinHandle<()>>,
}

impl PortalClipboard {
    /// Follows the clipboard of a started session that has access to it.
    pub async fn start(
        proxy: Clipboard,
        session: Arc<Session<RemoteDesktop>>,
    ) -> Result<Self, String> {
        let failed = |error: ashpd::zbus::Error| format!("Clipboard sharing failed: {error}");
        let owners = proxy
            .receive_signal("SelectionOwnerChanged")
            .await
            .map_err(failed)?;
        let transfers = proxy
            .receive_signal("SelectionTransfer")
            .await
            .map_err(failed)?;
        let shared = Arc::new(Shared {
            proxy,
            path: session_path(&session),
            session,
            state: Mutex::default(),
        });
        Ok(Self {
            tasks: vec![
                tokio::spawn(follow_owner(shared.clone(), owners)),
                tokio::spawn(serve_transfers(shared.clone(), transfers)),
            ],
            shared,
        })
    }

    pub fn latest(&self) -> Option<(u64, String)> {
        self.shared.state().host.clone()
    }

    pub async fn offer(&self, text: String) -> Result<(), String> {
        {
            let mut state = self.shared.state();
            state.offered = Some(Arc::new(text));
            state.offers += 1;
        }
        self.shared
            .proxy
            .set_selection(
                &self.shared.session,
                SetSelectionOptions::default().set_mime_types(OFFERED),
            )
            .await
            .map_err(|error| format!("Could not share the clipboard: {error}"))
    }
}

impl Drop for PortalClipboard {
    fn drop(&mut self) {
        for task in &self.tasks {
            task.abort();
        }
    }
}

/// ashpd keeps a session's object path private, but serializes the session
/// as that path.
fn session_path(session: &Session<RemoteDesktop>) -> String {
    match serde_json::to_value(session) {
        Ok(serde_json::Value::String(path)) => path,
        _ => String::new(),
    }
}

async fn follow_owner(shared: Arc<Shared>, mut owners: SignalStream<'static>) {
    // The selection may predate the session, so read it once up front.
    read_text(&shared, &[]).await;
    while let Some(message) = owners.next().await {
        let Ok((path, details)) = message
            .body()
            .deserialize::<(OwnedObjectPath, HashMap<String, OwnedVariant>)>()
        else {
            continue;
        };
        if path.as_str() != shared.path {
            continue;
        }
        if details
            .get("session_is_owner")
            .and_then(|value| flag(value))
            == Some(true)
        {
            continue;
        }
        let types = details
            .get("mime_types")
            .map(|value| mime_types(value))
            .unwrap_or_default();
        read_text(&shared, &types).await;
    }
}

async fn read_text(shared: &Shared, types: &[String]) {
    let offers = shared.state().offers;
    for mime in readable(types) {
        let Ok(fd) = shared.proxy.selection_read(&shared.session, mime).await else {
            continue;
        };
        let fd = OwnedFd::from(fd);
        let read = tokio::task::spawn_blocking(move || {
            read_all(fd, MAX_CLIPBOARD_BYTES, TRANSFER_TIMEOUT)
        })
        .await;
        let Ok(Ok(bytes)) = read else {
            continue;
        };
        let mut state = shared.state();
        if state.offers != offers {
            return;
        }
        if let Some(text) = decode(&bytes) {
            state.changes += 1;
            state.host = Some((state.changes, text));
        }
        return;
    }
}

async fn serve_transfers(shared: Arc<Shared>, mut transfers: SignalStream<'static>) {
    while let Some(message) = transfers.next().await {
        let Ok((path, _mime, serial)) = message
            .body()
            .deserialize::<(OwnedObjectPath, String, u32)>()
        else {
            continue;
        };
        if path.as_str() != shared.path {
            continue;
        }
        let offered = shared.state().offered.clone();
        let written = match offered {
            Some(text) => write_text(&shared, serial, text).await,
            None => false,
        };
        let _ = shared
            .proxy
            .selection_write_done(&shared.session, serial, written)
            .await;
    }
}

async fn write_text(shared: &Shared, serial: u32, text: Arc<String>) -> bool {
    let Ok(fd) = shared.proxy.selection_write(&shared.session, serial).await else {
        return false;
    };
    let fd = OwnedFd::from(fd);
    tokio::task::spawn_blocking(move || write_all(fd, text.as_bytes(), TRANSFER_TIMEOUT).is_ok())
        .await
        .unwrap_or(false)
}

fn flag(value: &Variant<'_>) -> Option<bool> {
    match value {
        Variant::Bool(flag) => Some(*flag),
        Variant::Variant(inner) => flag(inner),
        _ => None,
    }
}

/// Every string in `value`, through variants, arrays and structs.
fn mime_types(value: &Variant<'_>) -> Vec<String> {
    match value {
        Variant::Str(text) => vec![text.to_string()],
        Variant::Variant(inner) => mime_types(inner),
        Variant::Array(array) => array.inner().iter().flat_map(mime_types).collect(),
        Variant::Structure(structure) => structure.fields().iter().flat_map(mime_types).collect(),
        _ => Vec::new(),
    }
}

/// The text types to try for an offer of `types`, best first.
fn readable(types: &[String]) -> Vec<&'static str> {
    if types.is_empty() {
        return ASSUMED_TYPES.to_vec();
    }
    TEXT_TYPES
        .iter()
        .copied()
        .filter(|wanted| {
            types
                .iter()
                .any(|offered| offered.eq_ignore_ascii_case(wanted))
        })
        .collect()
}

fn decode(bytes: &[u8]) -> Option<String> {
    let text = String::from_utf8_lossy(bytes);
    let text = text.trim_end_matches('\0');
    (!text.is_empty() && text.len() <= MAX_CLIPBOARD_BYTES).then(|| text.to_string())
}

fn set_nonblocking(fd: &OwnedFd) -> io::Result<()> {
    // SAFETY: fcntl on a descriptor this function borrows.
    let flags = unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_GETFL) };
    if flags < 0
        // SAFETY: as above.
        || unsafe { libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, flags | libc::O_NONBLOCK) } < 0
    {
        return Err(io::Error::last_os_error());
    }
    Ok(())
}

fn wait(fd: &impl AsRawFd, events: i16, deadline: Instant) -> io::Result<()> {
    let left = deadline.saturating_duration_since(Instant::now());
    let mut poll = libc::pollfd {
        fd: fd.as_raw_fd(),
        events,
        revents: 0,
    };
    // SAFETY: one valid pollfd.
    match unsafe { libc::poll(&mut poll, 1, left.as_millis().min(i32::MAX as u128) as i32) } {
        0 => Err(io::Error::new(
            io::ErrorKind::TimedOut,
            "The clipboard transfer timed out",
        )),
        ready if ready > 0 => Ok(()),
        _ => {
            let error = io::Error::last_os_error();
            if error.kind() == io::ErrorKind::Interrupted {
                Ok(())
            } else {
                Err(error)
            }
        }
    }
}

/// Reads until the writer closes, failing past `limit` bytes or `timeout`.
fn read_all(fd: OwnedFd, limit: usize, timeout: Duration) -> io::Result<Vec<u8>> {
    set_nonblocking(&fd)?;
    let deadline = Instant::now() + timeout;
    let mut file = std::fs::File::from(fd);
    let mut data = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        match file.read(&mut buffer) {
            Ok(0) => return Ok(data),
            Ok(count) => {
                data.extend_from_slice(&buffer[..count]);
                if data.len() > limit {
                    return Err(io::Error::other("The clipboard text is too large"));
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait(&file, libc::POLLIN, deadline)?;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
}

fn write_all(fd: OwnedFd, mut data: &[u8], timeout: Duration) -> io::Result<()> {
    set_nonblocking(&fd)?;
    let deadline = Instant::now() + timeout;
    let mut file = std::fs::File::from(fd);
    while !data.is_empty() {
        match file.write(data) {
            Ok(0) => return Err(io::ErrorKind::WriteZero.into()),
            Ok(count) => data = &data[count..],
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                wait(&file, libc::POLLOUT, deadline)?;
            }
            Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
            Err(error) => return Err(error),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use ashpd::zbus::wire::StructureBuilder;
    use ashpd::zbus::{Array, Signature, Structure};
    use std::os::unix::net::UnixStream;

    fn strings(values: &[&str]) -> Variant<'static> {
        let mut array = Array::new(&Signature::Str);
        for value in values {
            array.append(Variant::from(value.to_string())).unwrap();
        }
        Variant::Array(array)
    }

    #[test]
    fn reads_mime_lists_plain_or_wrapped_in_a_struct_as_gnome_46_sends_them() {
        let plain = strings(&["image/png", "text/plain;charset=utf-8"]);
        assert_eq!(
            mime_types(&Variant::Variant(Box::new(plain))),
            ["image/png", "text/plain;charset=utf-8"]
        );
        let wrapped: Structure<'static> = StructureBuilder::new()
            .append_field(strings(&["text/plain"]))
            .build()
            .unwrap();
        assert_eq!(
            mime_types(&Variant::Variant(Box::new(Variant::Structure(wrapped)))),
            ["text/plain"]
        );
        assert_eq!(
            flag(&Variant::Variant(Box::new(Variant::Bool(true)))),
            Some(true)
        );
    }

    #[test]
    fn picks_text_types_and_assumes_text_when_none_are_named() {
        let named = |types: &[&str]| types.iter().map(|t| t.to_string()).collect::<Vec<_>>();
        assert_eq!(
            readable(&named(&[
                "text/plain",
                "TEXT/PLAIN;CHARSET=UTF-8",
                "image/png"
            ])),
            ["text/plain;charset=utf-8", "text/plain"]
        );
        assert!(readable(&named(&["image/png"])).is_empty());
        assert_eq!(readable(&[]), ASSUMED_TYPES);
    }

    #[test]
    fn decodes_text_without_trailing_nuls_and_skips_empty_or_oversized_text() {
        assert_eq!(decode(b"caf\xc3\xa9\0").as_deref(), Some("café"));
        assert_eq!(decode(b"\0"), None);
        assert_eq!(decode(&vec![b'a'; MAX_CLIPBOARD_BYTES + 1]), None);
    }

    #[test]
    fn transfers_through_descriptors_with_limits_and_timeouts() {
        let (ours, theirs) = UnixStream::pair().unwrap();
        let writer = std::thread::spawn(move || {
            write_all(
                OwnedFd::from(theirs),
                &[7u8; 200_000],
                Duration::from_secs(5),
            )
        });
        let data = read_all(OwnedFd::from(ours), 1 << 20, Duration::from_secs(5)).unwrap();
        writer.join().unwrap().unwrap();
        assert_eq!(data.len(), 200_000);

        let (ours, theirs) = UnixStream::pair().unwrap();
        (&theirs).write_all(&[1u8; 64]).unwrap();
        let error = read_all(OwnedFd::from(ours), 10, Duration::from_secs(5)).unwrap_err();
        assert!(error.to_string().contains("too large"));
        drop(theirs);

        let (ours, _theirs) = UnixStream::pair().unwrap();
        let error = read_all(OwnedFd::from(ours), 10, Duration::from_millis(20)).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::TimedOut);
    }
}
