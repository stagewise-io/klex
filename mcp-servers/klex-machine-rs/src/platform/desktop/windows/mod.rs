//! The Windows desktop: GDI capture, SendInput and window management on
//! the primary monitor, in physical pixels.
//!
//! Session 0 (services) and non-interactive window stations have no desktop.
//! The lock screen and the UAC secure desktop belong to Winlogon and cannot be
//! captured or driven. While one is up the probe reports no computer use, but
//! the stream stays up and shows a placeholder until the user is back.
//! Accessibility is not implemented yet.

mod computer;
mod stream;
mod win32;

use std::os::windows::process::CommandExt;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::process::{Command, Stdio};
use std::sync::mpsc::{Sender, channel};
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use tokio::io::DuplexStream;
use tokio::sync::oneshot;
use windows_sys::Win32::System::Threading::{CREATE_NEW_PROCESS_GROUP, DETACHED_PROCESS};

use super::windows_keys::{self, ComboKey};
use crate::desktop::Warn;
use crate::desktop::provider::{
    CaptureOptions, DesktopCapabilities, DesktopFuture, DesktopProvider, DesktopResult,
    DesktopWindow, LaunchOptions, MouseButton, Point, ScreenSize, ScrollDirection,
};
use crate::desktop::rfb::RfbServer;

const TYPE_CHUNK_UNITS: usize = 200;

type Job = Box<dyn FnOnce() + Send>;

/// Runs desktop requests one at a time on a thread with per-monitor DPI
/// awareness, so metrics, capture and input are in physical pixels.
struct Worker {
    jobs: Mutex<Sender<Job>>,
}

impl Worker {
    fn start() -> Self {
        let (jobs, receiver) = channel::<Job>();
        std::thread::Builder::new()
            .name("klex-desktop".into())
            .spawn(move || {
                win32::init_dpi_awareness();
                while let Ok(job) = receiver.recv() {
                    job();
                }
            })
            .expect("spawn the desktop worker thread");
        Self {
            jobs: Mutex::new(jobs),
        }
    }

    fn run<T: Send + 'static>(
        &self,
        job: impl FnOnce() -> DesktopResult<T> + Send + 'static,
    ) -> DesktopFuture<'_, T> {
        let (reply, result) = oneshot::channel();
        let sent = self
            .jobs
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .send(Box::new(move || {
                let outcome = catch_unwind(AssertUnwindSafe(job))
                    .unwrap_or_else(|_| Err("The desktop request failed unexpectedly".into()));
                let _ = reply.send(outcome);
            }));
        async move {
            sent.map_err(|_| "The desktop worker stopped".to_string())?;
            result
                .await
                .map_err(|_| "The desktop worker stopped".to_string())?
        }
        .boxed()
    }
}

pub struct WindowsDesktopProvider {
    worker: Arc<Worker>,
    warn: Warn,
    state: Mutex<ProbeState>,
    stream: Mutex<Option<Arc<RfbServer>>>,
}

#[derive(Default)]
struct ProbeState {
    /// Set once the session can never have a desktop, so probes stop asking.
    permanent: Option<DesktopCapabilities>,
    last_hint: Option<String>,
}

impl WindowsDesktopProvider {
    pub fn new(warn: Warn) -> Self {
        Self {
            worker: Arc::new(Worker::start()),
            warn,
            state: Mutex::default(),
            stream: Mutex::new(None),
        }
    }

    fn state(&self) -> std::sync::MutexGuard<'_, ProbeState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    async fn check(&self) -> DesktopCapabilities {
        let info = match self.worker.run(|| Ok(computer::probe())).await {
            Ok(info) => info,
            Err(error) => return DesktopCapabilities::unavailable(error),
        };
        if info.session == Some(0) {
            return self.unavailable_forever(
                "klex-machine is running in Session 0, where Windows services run, which has no interactive desktop. Run it in the signed-in user's session, for example from a logon task or the Startup folder, to use the desktop.",
            );
        }
        if !info.interactive {
            return self.unavailable_forever(
                "klex-machine's window station is not interactive, as in an SSH session or a task set to run whether or not the user is signed in. Run it in the signed-in user's desktop session to use the desktop.",
            );
        }
        if info.width <= 0 || info.height <= 0 {
            return DesktopCapabilities::unavailable("Windows reported no primary screen.");
        }
        let screen = ScreenSize {
            width: info.width.into(),
            height: info.height.into(),
        };
        if !info.desktop.eq_ignore_ascii_case("default") {
            let desktop = if info.desktop.is_empty() {
                "not accessible".to_string()
            } else {
                format!("\"{}\"", info.desktop)
            };
            return DesktopCapabilities {
                computer_use: false,
                stream: true,
                accessibility: false,
                screen: Some(screen),
                hint: Some(format!(
                    "The input desktop is {desktop}: Windows is locked, or the sign-in screen or a UAC prompt is showing. These secure desktops cannot be captured or driven; computer use returns once the user is back on their desktop, and until then the stream shows a placeholder."
                )),
            };
        }
        if let Err(error) = info.capture {
            return DesktopCapabilities::unavailable(format!(
                "Screen capture failed: {error}. A minimized or disconnected Remote Desktop session has no screen to capture."
            ));
        }
        DesktopCapabilities {
            computer_use: true,
            stream: true,
            accessibility: false,
            screen: Some(screen),
            hint: None,
        }
    }

    fn unavailable_forever(&self, hint: &str) -> DesktopCapabilities {
        let capabilities = DesktopCapabilities::unavailable(hint);
        self.state().permanent = Some(capabilities.clone());
        capabilities
    }

    async fn probe_now(&self) -> DesktopCapabilities {
        let permanent = self.state().permanent.clone();
        let capabilities = match permanent {
            Some(capabilities) => capabilities,
            None => self.check().await,
        };
        let changed = {
            let mut state = self.state();
            let changed = capabilities.hint.is_some() && capabilities.hint != state.last_hint;
            state.last_hint = capabilities.hint.clone();
            changed
        };
        if changed && let Some(hint) = &capabilities.hint {
            (self.warn)(hint);
        }
        capabilities
    }

    fn input<T: Send + 'static>(
        &self,
        job: impl FnOnce() -> DesktopResult<T> + Send + 'static,
    ) -> DesktopFuture<'_, T> {
        self.worker.run(move || {
            computer::require_input()?;
            job()
        })
    }

    fn stream_server(&self) -> Arc<RfbServer> {
        let mut stream = self
            .stream
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        stream
            .get_or_insert_with(|| {
                let warn = self.warn.clone();
                Arc::new(
                    RfbServer::new(
                        Arc::new(stream::WindowsStreamBackend::new(self.warn.clone())),
                        crate::platform::host::hostname(),
                    )
                    .on_error(Arc::new(move |error: &str| {
                        warn(error.trim_end_matches('.'))
                    })),
                )
            })
            .clone()
    }
}

fn launch(options: LaunchOptions) -> DesktopResult<u32> {
    let mut command = Command::new(&options.command);
    command
        .args(&options.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP);
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    match command.spawn() {
        Ok(child) => Ok(child.id()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Err(format!("spawn {} ENOENT", options.command))
        }
        Err(error) => Err(format!("spawn {}: {error}", options.command)),
    }
}

fn parse_combos(combos: &[String]) -> DesktopResult<Vec<Vec<ComboKey>>> {
    combos
        .iter()
        .map(|combo| windows_keys::parse_combo(combo))
        .collect()
}

impl DesktopProvider for WindowsDesktopProvider {
    fn probe(&self) -> BoxFuture<'_, DesktopCapabilities> {
        self.probe_now().boxed()
    }

    fn screen_size(&self) -> DesktopFuture<'_, ScreenSize> {
        self.worker.run(|| {
            let (width, height) = win32::screen_size();
            if width <= 0 || height <= 0 {
                return Err(format!("Unexpected screen size: {width} {height}"));
            }
            Ok(ScreenSize {
                width: width.into(),
                height: height.into(),
            })
        })
    }

    fn capture(&self, options: CaptureOptions) -> DesktopFuture<'_, Vec<u8>> {
        self.worker.run(move || computer::capture(options))
    }

    fn click(
        &self,
        point: Point,
        button: MouseButton,
        count: u32,
        modifiers: Vec<String>,
    ) -> DesktopFuture<'_, ()> {
        let modifiers = match modifiers
            .iter()
            .map(|name| windows_keys::modifier(name))
            .collect::<DesktopResult<Vec<u16>>>()
        {
            Ok(modifiers) => modifiers,
            Err(error) => return futures::future::ready(Err(error)).boxed(),
        };
        self.input(move || computer::click(point, button, count, &modifiers))
    }

    fn drag(&self, from: Point, to: Point, button: MouseButton) -> DesktopFuture<'_, ()> {
        self.input(move || computer::drag(from, to, button))
    }

    fn move_to(&self, point: Point) -> DesktopFuture<'_, ()> {
        self.input(move || computer::move_pointer(point))
    }

    fn scroll(
        &self,
        point: Point,
        direction: ScrollDirection,
        amount: u32,
    ) -> DesktopFuture<'_, ()> {
        self.input(move || computer::scroll(point, direction, amount))
    }

    fn type_text(&self, text: String) -> DesktopFuture<'_, ()> {
        let worker = self.worker.clone();
        async move {
            let units: Vec<u16> = text.encode_utf16().collect();
            let mut start = 0;
            while start < units.len() {
                let mut end = (start + TYPE_CHUNK_UNITS).min(units.len());
                // Keep surrogate pairs in one chunk.
                if end < units.len() && (0xd800..=0xdbff).contains(&units[end - 1]) {
                    end += 1;
                }
                let chunk = String::from_utf16_lossy(&units[start..end]);
                worker
                    .run(move || {
                        computer::require_input()?;
                        computer::type_text(&chunk)
                    })
                    .await?;
                start = end;
            }
            Ok(())
        }
        .boxed()
    }

    fn key(&self, combos: Vec<String>) -> DesktopFuture<'_, ()> {
        if combos.is_empty() {
            return futures::future::ready(Ok(())).boxed();
        }
        let combos = match parse_combos(&combos) {
            Ok(combos) => combos,
            Err(error) => return futures::future::ready(Err(error)).boxed(),
        };
        self.input(move || computer::keys(&combos))
    }

    fn list_windows(&self) -> DesktopFuture<'_, Vec<DesktopWindow>> {
        self.worker.run(|| Ok(computer::list_windows()))
    }

    fn focus_window(&self, id: String) -> DesktopFuture<'_, ()> {
        self.worker.run(move || computer::focus(&id))
    }

    fn launch(&self, options: LaunchOptions) -> DesktopFuture<'_, u32> {
        futures::future::ready(launch(options)).boxed()
    }

    fn open_stream(&self) -> DesktopFuture<'_, DuplexStream> {
        async move {
            let capabilities = self.probe_now().await;
            if !capabilities.stream {
                return Err(capabilities
                    .hint
                    .unwrap_or_else(|| "The Windows desktop cannot stream".into()));
            }
            Ok(self.stream_server().open())
        }
        .boxed()
    }
}
