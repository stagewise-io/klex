//! Screen sharing and remote input on Wayland through xdg-desktop-portal: one
//! RemoteDesktop session with a ScreenCast monitor stream, frames over
//! PipeWire and input through the portal's Notify calls.
//!
//! Starting a session can wait on a consent dialog, so it runs in the
//! background and probes report a hint until it is ready. The portal returns
//! a restore token after each start; it is kept in the data directory so the
//! next run starts without asking again.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use ashpd::desktop::remote_desktop::{
    Axis, DeviceType, KeyState, RemoteDesktop, SelectDevicesOptions, StartOptions,
};
use ashpd::desktop::screencast::{CursorMode, Screencast, SelectSourcesOptions, SourceType};
use ashpd::desktop::{PersistMode, ResponseError, Session};
use futures::future::BoxFuture;
use futures::{FutureExt, StreamExt};

use super::pipewire::{Frame, VideoStream};
use crate::desktop::Warn;

pub const TOKEN_FILE: &str = "desktop-portal-token";
const FIRST_FRAME_TIMEOUT: Duration = Duration::from_secs(10);
const RETRY_MISSING: Duration = Duration::from_secs(60);
const RETRY_FAILED: Duration = Duration::from_secs(30);

pub const WAITING_HINT: &str = "Waiting for screen sharing to be allowed: choose Share in the dialog on this computer's screen. Once allowed, klex-machine remembers it.";
pub const STARTING_HINT: &str = "Screen sharing is starting.";
pub const DECLINED_HINT: &str = "Screen sharing was declined in the dialog on this computer. Restart klex-machine to be asked again.";
pub const STOPPED_HINT: &str =
    "Screen sharing was stopped on this computer. Restart klex-machine to share again.";
pub const NO_PORTAL_HINT: &str = "This Wayland session has no screen sharing portal. Install xdg-desktop-portal with its GNOME or KDE backend (xdg-desktop-portal-gnome or xdg-desktop-portal-kde), or log in to an X11 session.";
pub const NO_BUS_HINT: &str = "No D-Bus session bus was found, so the screen sharing portal is unreachable. Start klex-machine from inside the desktop session, or set DBUS_SESSION_BUS_ADDRESS.";

/// Input in the portal's terms; positions are framebuffer pixels.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Input {
    Motion(f64, f64),
    /// A Linux evdev button code such as `BTN_LEFT`.
    Button(i32, bool),
    /// Discrete wheel steps; positive is down or right.
    Axis {
        vertical: bool,
        steps: i32,
    },
    Keysym(u32, bool),
    /// A Linux evdev key code.
    Keycode(i32, bool),
}

pub const BTN_LEFT: i32 = 0x110;
pub const BTN_RIGHT: i32 = 0x111;
pub const BTN_MIDDLE: i32 = 0x112;

/// Why a running share ended.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Ended {
    /// The user stopped sharing; do not ask again until restart.
    Stopped,
    Lost(String),
}

/// A running share: the latest frames and an input channel.
pub trait Remote: Send + Sync {
    fn latest(&self) -> Option<Frame>;
    /// Blocks until a frame newer than `after` arrives, the share ends
    /// (`Err`), or `timeout` passes (`Ok(None)`).
    fn wait_newer(&self, after: u64, timeout: Duration) -> Result<Option<Frame>, String>;
    fn input(&self, input: Input) -> BoxFuture<'_, Result<(), String>>;
    fn ended(&self) -> Option<Ended>;
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Retry {
    After(Duration),
    /// Only a restart asks again.
    Never,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Failure {
    pub hint: String,
    pub retry: Retry,
}

impl Failure {
    fn new(hint: impl Into<String>, retry: Retry) -> Self {
        Self {
            hint: hint.into(),
            retry,
        }
    }
}

pub struct Established {
    pub remote: Arc<dyn Remote>,
    pub token: Option<String>,
}

/// Starts a share, given the saved restore token.
pub type Connector =
    Arc<dyn Fn(Option<String>) -> BoxFuture<'static, Result<Established, Failure>> + Send + Sync>;

enum State {
    Idle,
    /// With the hint of the failure being retried, if any.
    Starting(Option<String>),
    Ready(Arc<dyn Remote>),
    Failed {
        failure: Failure,
        at: Instant,
    },
}

pub struct Portal {
    token_path: Option<PathBuf>,
    connect: Connector,
    warn: Warn,
    state: Mutex<State>,
    /// A token was found, so starting should not need the dialog.
    restoring: AtomicBool,
    warned_no_token: AtomicBool,
}

impl Portal {
    pub fn new(token_path: Option<PathBuf>, connect: Connector, warn: Warn) -> Arc<Self> {
        Arc::new(Self {
            token_path,
            connect,
            warn,
            state: Mutex::new(State::Idle),
            restoring: AtomicBool::new(false),
            warned_no_token: AtomicBool::new(false),
        })
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The running share, or why there is none. Starts one in the background
    /// when none is running or due, so this never waits on the dialog.
    pub fn remote(self: &Arc<Self>) -> Result<Arc<dyn Remote>, String> {
        let mut state = self.lock();
        if let State::Ready(remote) = &*state {
            match remote.ended() {
                None => return Ok(remote.clone()),
                Some(Ended::Stopped) => {
                    (self.warn)("Screen sharing was stopped on this computer.");
                    *state = State::Failed {
                        failure: Failure::new(STOPPED_HINT, Retry::Never),
                        at: Instant::now(),
                    };
                }
                Some(Ended::Lost(reason)) => {
                    (self.warn)(&format!("Screen sharing ended: {reason}. Restarting it."));
                    *state = State::Idle;
                }
            }
        }
        let due = match &*state {
            State::Idle => true,
            State::Failed { failure, at } => match failure.retry {
                Retry::After(delay) => at.elapsed() >= delay,
                Retry::Never => false,
            },
            State::Starting(_) | State::Ready(_) => false,
        };
        if due {
            let previous = match &*state {
                State::Failed { failure, .. } => Some(failure.hint.clone()),
                _ => None,
            };
            *state = State::Starting(previous);
            self.spawn_start();
        }
        Err(match &*state {
            State::Failed { failure, .. } => failure.hint.clone(),
            State::Starting(Some(hint)) => hint.clone(),
            _ if self.restoring.load(Ordering::SeqCst) => STARTING_HINT.into(),
            _ => WAITING_HINT.into(),
        })
    }

    fn spawn_start(self: &Arc<Self>) {
        let token = self.read_token();
        self.restoring.store(token.is_some(), Ordering::SeqCst);
        let portal = self.clone();
        let start = (self.connect)(token);
        tokio::spawn(async move {
            let outcome = start.await;
            let mut state = portal.lock();
            *state = match outcome {
                Ok(established) => {
                    portal.save_token(established.token.as_deref());
                    State::Ready(established.remote)
                }
                Err(failure) => {
                    (portal.warn)(&failure.hint);
                    State::Failed {
                        failure,
                        at: Instant::now(),
                    }
                }
            };
        });
    }

    fn read_token(&self) -> Option<String> {
        let path = self.token_path.as_ref()?;
        std::fs::read_to_string(path)
            .ok()
            .map(|token| token.trim().to_string())
            .filter(|token| !token.is_empty())
    }

    /// Tokens are single-use, so each start replaces the saved one.
    fn save_token(&self, token: Option<&str>) {
        let Some(path) = &self.token_path else {
            return;
        };
        let Some(token) = token else {
            let _ = std::fs::remove_file(path);
            if !self.warned_no_token.swap(true, Ordering::SeqCst) {
                (self.warn)(
                    "The screen sharing portal did not offer to remember this permission, so it will ask again next time klex-machine starts.",
                );
            }
            return;
        };
        if let Err(error) = write_private(path, token) {
            (self.warn)(&format!(
                "Could not save the screen sharing permission to {}: {error}",
                path.display()
            ));
        }
    }
}

fn write_private(path: &std::path::Path, contents: &str) -> std::io::Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;

    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let temporary = path.with_extension("tmp");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(&temporary)?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()?;
    std::fs::rename(&temporary, path)
}

// MARK: xdg-desktop-portal

pub fn portal_connector() -> Connector {
    Arc::new(|token| establish(token).boxed())
}

fn portal_failure(error: ashpd::Error, step: &str, consented: bool) -> Failure {
    match error {
        ashpd::Error::Response(ResponseError::Cancelled) => {
            Failure::new(DECLINED_HINT, Retry::Never)
        }
        ashpd::Error::PortalNotFound(_) => {
            Failure::new(NO_PORTAL_HINT, Retry::After(RETRY_MISSING))
        }
        // Without any portal service, ashpd only notices once a call fails.
        error if is_missing_service(&error.to_string()) => {
            Failure::new(NO_PORTAL_HINT, Retry::After(RETRY_MISSING))
        }
        error => {
            // Retrying after the user already answered the dialog would ask
            // again; only a restart should do that.
            let retry = if consented {
                Retry::Never
            } else {
                Retry::After(RETRY_FAILED)
            };
            Failure::new(format!("Screen sharing failed to {step}: {error}"), retry)
        }
    }
}

fn is_missing_service(error: &str) -> bool {
    [
        "org.freedesktop.DBus.Error.ServiceUnknown",
        "org.freedesktop.DBus.Error.NameHasNoOwner",
        "org.freedesktop.DBus.Error.UnknownInterface",
        "org.freedesktop.DBus.Error.UnknownMethod",
        "org.freedesktop.DBus.Error.UnknownObject",
    ]
    .iter()
    .any(|name| error.contains(name))
}

async fn establish(token: Option<String>) -> Result<Established, Failure> {
    let connection = zbus::Connection::session()
        .await
        .map_err(|_| Failure::new(NO_BUS_HINT, Retry::After(RETRY_MISSING)))?;
    let proxy = RemoteDesktop::with_connection(connection.clone())
        .await
        .map_err(|error| portal_failure(error, "reach the portal", false))?;
    let screencast = Screencast::with_connection(connection)
        .await
        .map_err(|error| portal_failure(error, "reach the portal", false))?;
    let session = proxy
        .create_session(Default::default())
        .await
        .map_err(|error| portal_failure(error, "create a session", false))?;
    let mut devices =
        SelectDevicesOptions::default().set_devices(DeviceType::KEYBOARD | DeviceType::POINTER);
    // Version 2 added persistence.
    if proxy.version() >= 2 {
        devices = devices
            .set_persist_mode(PersistMode::ExplicitlyRevoked)
            .set_restore_token(token.as_deref());
    }
    proxy
        .select_devices(&session, devices)
        .await
        .and_then(|request| request.response())
        .map_err(|error| portal_failure(error, "select input devices", false))?;
    let cursor = match screencast.available_cursor_modes().await {
        Ok(modes) if modes.contains(CursorMode::EMBEDDED) => CursorMode::EMBEDDED,
        _ => CursorMode::HIDDEN,
    };
    screencast
        .select_sources(
            &session,
            SelectSourcesOptions::default()
                .set_cursor_mode(cursor)
                .set_sources(SourceType::MONITOR)
                .set_multiple(false),
        )
        .await
        .and_then(|request| request.response())
        .map_err(|error| portal_failure(error, "select the screen", false))?;
    let selected = proxy
        .start(&session, None, StartOptions::default())
        .await
        .and_then(|request| request.response())
        .map_err(|error| portal_failure(error, "start", false))?;
    let missing = DeviceType::KEYBOARD | DeviceType::POINTER;
    if !selected.devices().contains(missing) {
        let _ = session.close().await;
        return Err(Failure::new(
            "Screen sharing was allowed without keyboard and mouse control. Restart klex-machine and allow remote control in the dialog.",
            Retry::Never,
        ));
    }
    let Some(stream) = selected.streams().first() else {
        let _ = session.close().await;
        return Err(Failure::new(
            "Screen sharing was allowed without choosing a screen. Restart klex-machine and choose one in the dialog.",
            Retry::Never,
        ));
    };
    let node = stream.pipe_wire_node_id();
    let logical = stream
        .size()
        .filter(|&(width, height)| width > 0 && height > 0);
    let token = selected.restore_token().map(str::to_string);
    let fd = screencast
        .open_pipe_wire_remote(&session, Default::default())
        .await
        .map_err(|error| portal_failure(error, "open the screen stream", true))?;
    let video =
        VideoStream::connect(fd, node).map_err(|error| Failure::new(error, Retry::Never))?;
    let deadline = tokio::time::Instant::now() + FIRST_FRAME_TIMEOUT;
    let first = loop {
        if video.latest().is_some() {
            break Ok(true);
        }
        if let Some(error) = video.ended() {
            break Err(error);
        }
        if tokio::time::Instant::now() >= deadline {
            break Ok(false);
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    };
    match first {
        Ok(true) => {}
        Ok(false) => {
            let _ = session.close().await;
            return Err(Failure::new(
                "The screen stream sent no picture. Restart klex-machine to try again.",
                Retry::Never,
            ));
        }
        Err(error) => {
            let _ = session.close().await;
            return Err(Failure::new(error, Retry::Never));
        }
    }
    let session = Arc::new(session);
    let stopped = Arc::new(AtomicBool::new(false));
    let watched = (session.clone(), stopped.clone());
    let watcher = tokio::spawn(async move {
        let (session, stopped) = watched;
        if let Ok(mut closed) = session.receive_closed().await
            && closed.next().await.is_some()
        {
            stopped.store(true, Ordering::SeqCst);
        }
    });
    Ok(Established {
        remote: Arc::new(PortalRemote {
            proxy,
            session,
            node,
            logical,
            video,
            stopped,
            watcher,
        }),
        token,
    })
}

struct PortalRemote {
    proxy: RemoteDesktop,
    session: Arc<Session<RemoteDesktop>>,
    node: u32,
    /// The stream size in the compositor's logical pixels, which pointer
    /// positions are in. GNOME reports the frame size here; KDE reports the
    /// scaled-down size on HiDPI screens.
    logical: Option<(i32, i32)>,
    video: VideoStream,
    stopped: Arc<AtomicBool>,
    watcher: tokio::task::JoinHandle<()>,
}

impl Drop for PortalRemote {
    fn drop(&mut self) {
        self.watcher.abort();
    }
}

impl PortalRemote {
    fn to_logical(&self, x: f64, y: f64) -> (f64, f64) {
        match (self.logical, self.video.latest()) {
            (Some((width, height)), Some(frame)) if frame.width > 0 && frame.height > 0 => (
                x * f64::from(width) / f64::from(frame.width),
                y * f64::from(height) / f64::from(frame.height),
            ),
            _ => (x, y),
        }
    }
}

fn state(down: bool) -> KeyState {
    if down {
        KeyState::Pressed
    } else {
        KeyState::Released
    }
}

impl Remote for PortalRemote {
    fn latest(&self) -> Option<Frame> {
        self.video.latest()
    }

    fn wait_newer(&self, after: u64, timeout: Duration) -> Result<Option<Frame>, String> {
        self.video.wait_newer(after, timeout)
    }

    fn input(&self, input: Input) -> BoxFuture<'_, Result<(), String>> {
        async move {
            let session = &*self.session;
            let sent = match input {
                Input::Motion(x, y) => {
                    let (x, y) = self.to_logical(x, y);
                    self.proxy
                        .notify_pointer_motion_absolute(
                            session,
                            self.node,
                            x,
                            y,
                            Default::default(),
                        )
                        .await
                }
                Input::Button(button, down) => {
                    self.proxy
                        .notify_pointer_button(session, button, state(down), Default::default())
                        .await
                }
                Input::Axis { vertical, steps } => {
                    let axis = if vertical {
                        Axis::Vertical
                    } else {
                        Axis::Horizontal
                    };
                    self.proxy
                        .notify_pointer_axis_discrete(session, axis, steps, Default::default())
                        .await
                }
                Input::Keysym(keysym, down) => {
                    self.proxy
                        .notify_keyboard_keysym(
                            session,
                            keysym as i32,
                            state(down),
                            Default::default(),
                        )
                        .await
                }
                Input::Keycode(code, down) => {
                    self.proxy
                        .notify_keyboard_keycode(session, code, state(down), Default::default())
                        .await
                }
            };
            sent.map_err(|error| format!("The screen sharing portal refused input: {error}"))
        }
        .boxed()
    }

    fn ended(&self) -> Option<Ended> {
        if self.stopped.load(Ordering::SeqCst) {
            return Some(Ended::Stopped);
        }
        self.video.ended().map(Ended::Lost)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fake {
        ended: Mutex<Option<Ended>>,
    }

    impl Remote for Fake {
        fn latest(&self) -> Option<Frame> {
            None
        }
        fn wait_newer(&self, _: u64, _: Duration) -> Result<Option<Frame>, String> {
            Ok(None)
        }
        fn input(&self, _: Input) -> BoxFuture<'_, Result<(), String>> {
            futures::future::ready(Ok(())).boxed()
        }
        fn ended(&self) -> Option<Ended> {
            self.ended.lock().unwrap().clone()
        }
    }

    type Script = Arc<Mutex<Vec<Result<Option<String>, Failure>>>>;

    /// A connector that answers from `script` in order, recording the token
    /// each start was given.
    fn connector(
        script: Script,
        tokens: Arc<Mutex<Vec<Option<String>>>>,
        remotes: Arc<Mutex<Vec<Arc<Fake>>>>,
    ) -> Connector {
        Arc::new(move |token| {
            tokens.lock().unwrap().push(token);
            let next = script.lock().unwrap().remove(0);
            let remotes = remotes.clone();
            async move {
                let token = next?;
                let remote = Arc::new(Fake {
                    ended: Mutex::new(None),
                });
                remotes.lock().unwrap().push(remote.clone());
                Ok(Established {
                    remote: remote as Arc<dyn Remote>,
                    token,
                })
            }
            .boxed()
        })
    }

    async fn settle() {
        for _ in 0..10 {
            tokio::task::yield_now().await;
        }
    }

    #[tokio::test]
    async fn waits_in_the_background_and_keeps_the_restore_token() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(TOKEN_FILE);
        let script: Script = Arc::new(Mutex::new(vec![
            Ok(Some("first".into())),
            Ok(Some("second".into())),
        ]));
        let tokens = Arc::default();
        let remotes = Arc::default();
        let warnings = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = warnings.clone();
        let portal = Portal::new(
            Some(path.clone()),
            connector(script, Arc::clone(&tokens), Arc::clone(&remotes)),
            Arc::new(move |message: &str| log.lock().unwrap().push(message.into())),
        );
        assert_eq!(portal.remote().err().unwrap(), WAITING_HINT);
        settle().await;
        assert!(portal.remote().is_ok());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "first");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }

        // A lost stream restarts with the saved token, which is replaced.
        *remotes.lock().unwrap()[0].ended.lock().unwrap() =
            Some(Ended::Lost("PipeWire went away".into()));
        assert_eq!(portal.remote().err().unwrap(), STARTING_HINT);
        settle().await;
        assert!(portal.remote().is_ok());
        assert_eq!(*tokens.lock().unwrap(), [None, Some("first".into())]);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "second");
        assert!(warnings.lock().unwrap()[0].contains("PipeWire went away"));

        // Stopping the share from the desktop is final until restart.
        *remotes.lock().unwrap()[1].ended.lock().unwrap() = Some(Ended::Stopped);
        assert_eq!(portal.remote().err().unwrap(), STOPPED_HINT);
        settle().await;
        assert_eq!(portal.remote().err().unwrap(), STOPPED_HINT);
        assert_eq!(tokens.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn reports_a_declined_dialog_until_restart_and_retries_a_missing_portal() {
        let script: Script = Arc::new(Mutex::new(vec![
            Err(Failure::new(NO_PORTAL_HINT, Retry::After(Duration::ZERO))),
            Err(Failure::new(DECLINED_HINT, Retry::Never)),
        ]));
        let tokens = Arc::new(Mutex::new(Vec::new()));
        let portal = Portal::new(
            None,
            connector(script, tokens.clone(), Arc::default()),
            Arc::new(|_: &str| {}),
        );
        assert_eq!(portal.remote().err().unwrap(), WAITING_HINT);
        settle().await;
        // Due again at once: this probe starts the second attempt.
        assert_eq!(portal.remote().err().unwrap(), NO_PORTAL_HINT);
        settle().await;
        assert_eq!(portal.remote().err().unwrap(), DECLINED_HINT);
        settle().await;
        assert_eq!(portal.remote().err().unwrap(), DECLINED_HINT);
        assert_eq!(tokens.lock().unwrap().len(), 2);
    }

    #[tokio::test]
    async fn forgets_the_token_when_the_portal_offers_none() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join(TOKEN_FILE);
        std::fs::write(&path, "stale\n").unwrap();
        let script: Script = Arc::new(Mutex::new(vec![Ok(None)]));
        let tokens = Arc::new(Mutex::new(Vec::new()));
        let warnings = Arc::new(Mutex::new(Vec::<String>::new()));
        let log = warnings.clone();
        let portal = Portal::new(
            Some(path.clone()),
            connector(script, tokens.clone(), Arc::default()),
            Arc::new(move |message: &str| log.lock().unwrap().push(message.into())),
        );
        assert_eq!(portal.remote().err().unwrap(), STARTING_HINT);
        settle().await;
        assert!(portal.remote().is_ok());
        assert_eq!(*tokens.lock().unwrap(), [Some("stale".into())]);
        assert!(!path.exists());
        assert!(warnings.lock().unwrap()[0].contains("ask again"));
    }
}
