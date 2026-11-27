//! App state: the machine's pairing, the supervised daemon and the status
//! shown in the window and the tray.

use std::process::Stdio;
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use klex_machine::cloud::state::load_machine_enrollment;
use klex_machine::supervised::{ConnectionState, PROTOCOL_VERSION, StatusEvent};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, Command};
use tokio::sync::{mpsc, watch};

use crate::logs::{Logs, Source};
use crate::pairing::PendingPairing;
use crate::settings::{Paths, Settings};

/// What the window and tray show. Mirrored by `DesktopStatus` in
/// `src/lib/desktop.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppStatus {
    pub paired: bool,
    pub enabled: bool,
    pub state: DisplayState,
    pub machine_id: Option<String>,
    pub organization_name: Option<String>,
    pub reason: Option<String>,
    pub autostart: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DisplayState {
    Connecting,
    Connected,
    Offline,
    Error,
    /// Not paired, or disconnected by the person.
    Stopped,
}

impl From<ConnectionState> for DisplayState {
    fn from(state: ConnectionState) -> Self {
        match state {
            ConnectionState::Connecting => Self::Connecting,
            ConnectionState::Connected => Self::Connected,
            ConnectionState::Offline => Self::Offline,
            ConnectionState::Error => Self::Error,
        }
    }
}

#[derive(Clone, Debug, Default)]
struct Link {
    state: Option<DisplayState>,
    organization_name: Option<String>,
    reason: Option<String>,
}

struct Running {
    stop: watch::Sender<bool>,
    task: tauri::async_runtime::JoinHandle<()>,
}

pub struct Desktop {
    pub app: AppHandle,
    pub paths: Paths,
    pub logs: Logs,
    pub settings: Mutex<Settings>,
    pub pending: Mutex<Option<PendingPairing>>,
    pub pending_deep_link: Mutex<Option<String>>,
    /// Set while Forget runs, so pairing links that arrive during the
    /// daemon's shutdown are kept for the pairing screen.
    pub forgetting: AtomicBool,
    link: Mutex<Link>,
    running: tokio::sync::Mutex<Option<Running>>,
}

pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

const RESTART_INITIAL: Duration = Duration::from_secs(1);
const RESTART_MAXIMUM: Duration = Duration::from_secs(60);
/// A daemon that ran this long resets the restart backoff.
const HEALTHY_RUN: Duration = Duration::from_secs(60);
const SHUTDOWN_GRACE: Duration = Duration::from_secs(10);

/// Drops the borrow `wait_for` returns, so callers stay `Send`.
async fn until_stopped(stopped: &mut watch::Receiver<bool>) {
    let _ = stopped.wait_for(|stop| *stop).await;
}

enum Outcome {
    Stopped,
    Fatal(String),
    Exited(String),
}

/// Turns the daemon's terse transport errors into something a person can act
/// on. The full reason stays in the logs.
pub fn describe_reason(reason: &str) -> String {
    if reason == "fetch failed" {
        return "Can’t reach Klex Cloud. Check the internet connection; this computer keeps retrying."
            .into();
    }
    if reason.starts_with("Proxy connection failed") {
        return "Can’t reach the Klex Cloud connection service; this computer keeps retrying."
            .into();
    }
    if reason.starts_with("Proxy connection closed") {
        return "The connection to Klex Cloud dropped. Reconnecting…".into();
    }
    reason.into()
}

impl Desktop {
    pub fn new(app: AppHandle, paths: Paths) -> Self {
        let settings = Settings::load(&paths.settings);
        let logs = Logs::new(&paths.log_dir);
        Self {
            app,
            paths,
            logs,
            settings: Mutex::new(settings),
            pending: Mutex::new(None),
            pending_deep_link: Mutex::new(None),
            forgetting: AtomicBool::new(false),
            link: Mutex::new(Link::default()),
            running: tokio::sync::Mutex::new(None),
        }
    }

    pub fn log(&self, source: Source, message: &str) {
        let line = self.logs.push(source, message);
        let _ = self.app.emit("log", line);
    }

    pub fn is_paired(&self) -> bool {
        load_machine_enrollment(&self.paths.data_dir).is_ok()
    }

    pub fn status(&self) -> AppStatus {
        let enrollment = load_machine_enrollment(&self.paths.data_dir).ok();
        let settings = lock(&self.settings).clone();
        let link = lock(&self.link).clone();
        let paired = enrollment.is_some();
        let (state, reason) = match link.state {
            Some(state) if paired => (state, link.reason),
            _ => (DisplayState::Stopped, None),
        };
        AppStatus {
            paired,
            enabled: settings.enabled,
            state,
            machine_id: enrollment.as_ref().map(|value| value.machine_id.clone()),
            organization_name: link
                .organization_name
                .or_else(|| enrollment.and_then(|value| value.organization_name))
                .or(settings.organization_name),
            reason,
            autostart: self.app.autolaunch().is_enabled().unwrap_or(false),
        }
    }

    /// Sends the current status to the window and the tray.
    pub fn broadcast(&self) -> AppStatus {
        let status = self.status();
        let _ = self.app.emit("status", &status);
        crate::tray::update(&self.app, &status);
        status
    }

    fn set_link(&self, state: Option<DisplayState>, reason: Option<String>) {
        {
            let mut link = lock(&self.link);
            if state.is_none() {
                // Once the daemon stops, its organization name is no longer
                // current; Forget relies on this to drop the previous one.
                link.organization_name = None;
            }
            link.state = state;
            link.reason = reason.map(|reason| describe_reason(&reason));
        }
        self.broadcast();
    }

    pub fn save_settings(&self, update: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let mut settings = lock(&self.settings);
        update(&mut settings);
        settings.save(&self.paths.settings)
    }

    /// Starts supervising the daemon unless it already runs.
    pub async fn start(self: &Arc<Self>) {
        let mut running = self.running.lock().await;
        if running.is_some() {
            return;
        }
        let (stop, stopped) = watch::channel(false);
        let desktop = self.clone();
        let task = tauri::async_runtime::spawn(async move { desktop.supervise(stopped).await });
        *running = Some(Running { stop, task });
    }

    /// Stops the daemon gracefully and waits for it to exit. Holds the
    /// supervisor lock throughout, so a concurrent `start` cannot spawn a
    /// second daemon on the same identity before this one has exited.
    pub async fn stop(&self) {
        let mut running = self.running.lock().await;
        if let Some(current) = running.take() {
            current.stop.send_replace(true);
            let _ = current.task.await;
        }
        self.set_link(None, None);
    }

    async fn supervise(self: Arc<Self>, mut stopped: watch::Receiver<bool>) {
        let mut delay = RESTART_INITIAL;
        loop {
            if *stopped.borrow() {
                return;
            }
            self.set_link(Some(DisplayState::Connecting), None);
            let started = Instant::now();
            match self.run_daemon(&mut stopped).await {
                Outcome::Stopped => return,
                Outcome::Fatal(message) => {
                    self.log(Source::App, &format!("Daemon stopped: {message}"));
                    self.set_link(Some(DisplayState::Error), Some(message));
                    until_stopped(&mut stopped).await;
                    return;
                }
                Outcome::Exited(message) => {
                    if started.elapsed() >= HEALTHY_RUN {
                        delay = RESTART_INITIAL;
                    }
                    self.log(
                        Source::App,
                        &format!("Daemon {message}; restarting in {} s", delay.as_secs()),
                    );
                    self.set_link(
                        Some(DisplayState::Offline),
                        Some("The connection stopped unexpectedly. Restarting…".into()),
                    );
                    tokio::select! {
                        () = tokio::time::sleep(delay) => {}
                        () = until_stopped(&mut stopped) => return,
                    }
                    delay = (delay * 2).min(RESTART_MAXIMUM);
                }
            }
        }
    }

    async fn run_daemon(&self, stopped: &mut watch::Receiver<bool>) -> Outcome {
        let data_dir = self.paths.data_dir.to_string_lossy().into_owned();
        let home = self.paths.home.to_string_lossy().into_owned();
        let args = [
            "serve",
            "--mode",
            "enrolled",
            "--supervised",
            "--data-dir",
            &data_dir,
            "--cwd",
            &home,
        ];
        let mut child = match self.spawn_daemon(&args) {
            Ok(child) => child,
            Err(error) => return Outcome::Exited(format!("could not start: {error}")),
        };
        self.log(Source::App, "Daemon started");
        let mut stdin = child.stdin.take();
        let mut events = self.read_events(&mut child);
        let mut fatal: Option<String> = None;
        loop {
            tokio::select! {
                event = events.recv() => match event {
                    Some(event) => {
                        if let Some(message) = self.handle_event(event) {
                            fatal = Some(message);
                        }
                    }
                    None => break,
                },
                () = until_stopped(stopped) => {
                    if let Some(mut stdin) = stdin.take() {
                        let _ = stdin.write_all(b"{\"type\":\"shutdown\"}\n").await;
                    }
                    if tokio::time::timeout(SHUTDOWN_GRACE, child.wait()).await.is_err() {
                        self.log(Source::App, "Daemon did not stop in time; killing it");
                        let _ = child.kill().await;
                    }
                    self.log(Source::App, "Daemon stopped");
                    return Outcome::Stopped;
                }
            }
        }
        let status = child.wait().await;
        if let Some(message) = fatal {
            return Outcome::Fatal(message);
        }
        Outcome::Exited(match status {
            Ok(status) => format!("exited with {status}"),
            Err(error) => format!("failed: {error}"),
        })
    }

    /// Returns the message of a fatal error.
    fn handle_event(&self, event: StatusEvent) -> Option<String> {
        match event {
            StatusEvent::Hello { protocol, .. } if protocol != PROTOCOL_VERSION => Some(format!(
                "The connection service speaks protocol {protocol}; this app needs {PROTOCOL_VERSION}."
            )),
            StatusEvent::Hello { .. } | StatusEvent::Enrolled { .. } => None,
            StatusEvent::State {
                state,
                organization_name,
                reason,
                ..
            } => {
                if organization_name.is_some() {
                    lock(&self.link).organization_name = organization_name;
                }
                let message = match &reason {
                    Some(reason) => format!("Connection: {state:?} ({reason})"),
                    None => format!("Connection: {state:?}"),
                };
                self.log(Source::App, &message);
                self.set_link(Some(state.into()), reason);
                None
            }
            StatusEvent::Error { message, fatal } => fatal.then_some(message),
        }
    }

    /// Re-executes this app as the daemon, with stdio piped for the
    /// supervised status channel.
    pub fn spawn_daemon(&self, args: &[&str]) -> std::io::Result<Child> {
        let executable = std::env::current_exe()?;
        let mut command = Command::new(executable);
        command
            .arg(crate::DAEMON_FLAG)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        #[cfg(windows)]
        {
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }
        command.spawn()
    }

    /// Forwards stderr to the logs and parses stdout into status events.
    /// The channel closes once stdout does.
    pub fn read_events(&self, child: &mut Child) -> mpsc::UnboundedReceiver<StatusEvent> {
        if let Some(stderr) = child.stderr.take() {
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    if let Some(desktop) = app.try_state::<Arc<Desktop>>() {
                        desktop.log(Source::Daemon, &line);
                    }
                }
            });
        }
        let (sender, receiver) = mpsc::unbounded_channel();
        if let Some(stdout) = child.stdout.take() {
            let app = self.app.clone();
            tauri::async_runtime::spawn(async move {
                let mut lines = BufReader::new(stdout).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    match serde_json::from_str::<StatusEvent>(&line) {
                        Ok(event) => {
                            if sender.send(event).is_err() {
                                return;
                            }
                        }
                        Err(_) => {
                            if let Some(desktop) = app.try_state::<Arc<Desktop>>() {
                                desktop.log(Source::Daemon, &line);
                            }
                        }
                    }
                }
            });
        }
        receiver
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_transport_errors() {
        assert!(describe_reason("fetch failed").starts_with("Can’t reach Klex Cloud"));
        assert!(
            describe_reason("Proxy connection closed: closed by Klex Cloud (code 1001)")
                .starts_with("The connection to Klex Cloud dropped")
        );
        assert!(
            describe_reason("Proxy connection failed: Cloud answered HTTP 401")
                .starts_with("Can’t reach the Klex Cloud connection service")
        );
        assert_eq!(describe_reason("something else"), "something else");
    }

    #[test]
    fn maps_daemon_states() {
        assert_eq!(
            DisplayState::from(ConnectionState::Error),
            DisplayState::Error
        );
        assert_eq!(
            serde_json::to_value(DisplayState::Stopped).unwrap(),
            "stopped"
        );
    }
}
