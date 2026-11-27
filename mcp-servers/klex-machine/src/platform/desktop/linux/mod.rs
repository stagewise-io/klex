//! The Linux desktop. On X11: computer use on the display from `DISPLAY`,
//! the accessibility tree over AT-SPI, and the stream from a VNC server's
//! Unix socket (`KLEX_MACHINE_VNC_SOCKET`), or from the display itself when
//! no socket was configured and none answers. Computer use needs a reachable
//! display with XTEST. On Wayland, everything goes through xdg-desktop-portal
//! (see `wayland`), unless a VNC socket was configured.

mod atspi;
mod keys;
mod pipewire;
mod portal;
mod wayland;
mod x11;
mod x11_clipboard;
mod x11_stream;

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::FutureExt;
use futures::future::BoxFuture;
use tokio::io::DuplexStream;
use tokio::net::UnixStream;

use atspi::{AtspiClient, AtspiConnector};
use x11::{COMMAND_TIMEOUT, Display, Session};

use crate::desktop::Warn;
use crate::desktop::rfb::RfbServer;

use crate::desktop::provider::{
    AccessibilityElement, AccessibilityProvider, AccessibilityQuery, AccessibilityTree,
    CaptureOptions, DesktopCapabilities, DesktopFuture, DesktopProvider, DesktopWindow,
    LaunchOptions, MouseButton, Point, ScreenSize, ScrollDirection,
};

pub const DEFAULT_VNC_SOCKET_PATH: &str = "/run/klex/vnc.sock";
const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(2);
const PROPERTY_TIMEOUT: Duration = Duration::from_secs(2);
const TYPE_CHUNK_CHARACTERS: usize = 200;
const STREAM_BUFFER_BYTES: usize = 64 * 1024;

const NO_TREE_HINT: &str = "GTK and Qt apps expose one once accessibility is on, but only if they were started after it was enabled; Chrome and Electron apps also need --force-renderer-accessibility. Use desktop_screenshot instead.";

fn env(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

#[derive(Debug, PartialEq, Eq)]
enum Kind {
    /// With the built-in stream as a fallback when no VNC socket answers.
    X11 {
        builtin_stream: bool,
    },
    Wayland,
}

/// A configured VNC socket means a sandbox serving X11; otherwise the
/// session type decides.
fn kind(
    vnc_socket: Option<&str>,
    wayland_display: Option<&str>,
    session_type: Option<&str>,
) -> Kind {
    if vnc_socket.is_some() {
        return Kind::X11 {
            builtin_stream: false,
        };
    }
    if wayland_display.is_some()
        || session_type.is_some_and(|kind| kind.eq_ignore_ascii_case("wayland"))
    {
        return Kind::Wayland;
    }
    Kind::X11 {
        builtin_stream: true,
    }
}

pub fn provider(warn: Warn, data_dir: Option<&Path>) -> Arc<dyn DesktopProvider> {
    let vnc_socket = env("KLEX_MACHINE_VNC_SOCKET");
    match kind(
        vnc_socket.as_deref(),
        env("WAYLAND_DISPLAY").as_deref(),
        env("XDG_SESSION_TYPE").as_deref(),
    ) {
        Kind::Wayland => Arc::new(wayland::WaylandDesktopProvider::new(
            wayland::portal(
                data_dir.map(|dir| dir.join(portal::TOKEN_FILE)),
                warn.clone(),
            ),
            env("DISPLAY"),
            warn,
        )),
        Kind::X11 { builtin_stream } => Arc::new(X11DesktopProvider::new(
            env("DISPLAY"),
            vnc_socket
                .unwrap_or_else(|| DEFAULT_VNC_SOCKET_PATH.to_string())
                .into(),
            builtin_stream.then_some(warn),
            env("AT_SPI_BUS_ADDRESS"),
            env("DBUS_SESSION_BUS_ADDRESS"),
            Arc::new(atspi::connect_zbus),
        )),
    }
}

pub struct X11DesktopProvider {
    display: Option<String>,
    x: Arc<Display>,
    vnc_socket: PathBuf,
    /// Set when the display may stream itself; logs go here.
    builtin_stream: Option<Warn>,
    stream: Mutex<Option<Arc<RfbServer>>>,
    atspi: AtspiClient,
}

impl X11DesktopProvider {
    fn new(
        display: Option<String>,
        vnc_socket: PathBuf,
        builtin_stream: Option<Warn>,
        atspi_address: Option<String>,
        session_bus: Option<String>,
        connect: AtspiConnector,
    ) -> Self {
        let x = Arc::new(Display::new(display.clone().unwrap_or_default()));
        let resolver_x = x.clone();
        let resolver_connect = connect.clone();
        let address: atspi::AddressResolver = Arc::new(move || {
            let x = resolver_x.clone();
            let connect = resolver_connect.clone();
            let (from_env, session) = (atspi_address.clone(), session_bus.clone());
            async move { atspi_address_of(&x, from_env, session, connect).await }.boxed()
        });
        Self {
            display,
            x,
            vnc_socket,
            builtin_stream,
            stream: Mutex::new(None),
            atspi: AtspiClient::new(address, connect),
        }
    }

    fn stream_server(&self, warn: &Warn) -> Arc<RfbServer> {
        let mut stream = self
            .stream
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        stream
            .get_or_insert_with(|| {
                let errors = warn.clone();
                Arc::new(
                    RfbServer::new(
                        Arc::new(x11_stream::X11StreamBackend::new(
                            self.display.clone().unwrap_or_default(),
                            warn.clone(),
                        )),
                        crate::platform::host::hostname(),
                    )
                    .on_error(Arc::new(move |error: &str| {
                        errors(error.trim_end_matches('.'))
                    })),
                )
            })
            .clone()
    }

    async fn run<T, F>(&self, op: F) -> Result<T, String>
    where
        T: Send + 'static,
        F: FnOnce(&Session) -> x11::XResult<T> + Send + 'static,
    {
        if self.display.is_none() {
            return Err("No desktop is available".into());
        }
        self.x.run(COMMAND_TIMEOUT, op).await
    }

    async fn connect_stream(&self) -> Result<UnixStream, String> {
        match tokio::time::timeout(
            STREAM_CONNECT_TIMEOUT,
            UnixStream::connect(&self.vnc_socket),
        )
        .await
        {
            Ok(Ok(socket)) => Ok(socket),
            Ok(Err(error)) => Err(format!(
                "connect {} {}",
                crate::platform::fs::error_code(&error).unwrap_or("EIO"),
                self.vnc_socket.display()
            )),
            Err(_) => Err("VNC socket connect timed out".into()),
        }
    }

    async fn window_id(&self, window: Option<String>) -> Result<u32, String> {
        let id = match window {
            Some(id) => id,
            None => {
                let (reported, active) = self
                    .run(|session| Ok((session.reports_active_window()?, session.active_window()?)))
                    .await?;
                if !reported {
                    return Err(
                        "No window is focused: no window manager reports the active \
                                window. Pass a window id from desktop_list_windows."
                            .into(),
                    );
                }
                active.map(|id| id.to_string()).unwrap_or_default()
            }
        };
        if id.is_empty() || !id.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err("No window is focused".into());
        }
        id.parse().map_err(|_| "No window is focused".to_string())
    }
}

/// The accessibility bus: `AT_SPI_BUS_ADDRESS`, the `AT_SPI_BUS` property the
/// bus launcher sets on the root window, or the session bus launcher. The
/// root window works for daemons started outside the desktop session.
async fn atspi_address_of(
    x: &Display,
    from_env: Option<String>,
    session: Option<String>,
    connect: AtspiConnector,
) -> Result<String, String> {
    if let Some(address) = from_env {
        return Ok(address);
    }
    if let Ok(Some(address)) = x.run(PROPERTY_TIMEOUT, |session| session.atspi_bus()).await {
        return Ok(address);
    }
    let session = session.ok_or("No accessibility bus was found")?;
    let bus = connect(session).await?;
    let address = atspi::with_timeout(
        bus.a11y_address(),
        "The accessibility bus launcher did not answer",
    )
    .await;
    bus.close().await;
    let address = address?;
    if address.is_empty() {
        return Err("The accessibility bus launcher returned no address".into());
    }
    Ok(address)
}

/// Relays a VNC socket through the in-process stream the desktop link reads.
fn bridge(socket: UnixStream) -> DuplexStream {
    let (ours, theirs) = tokio::io::duplex(STREAM_BUFFER_BYTES);
    tokio::spawn(async move {
        let (mut socket_read, mut socket_write) = socket.into_split();
        let (mut read, mut write) = tokio::io::split(theirs);
        tokio::select! {
            _ = tokio::io::copy(&mut read, &mut socket_write) => {}
            _ = tokio::io::copy(&mut socket_read, &mut write) => {}
        }
    });
    ours
}

fn launch(display: Option<&str>, options: LaunchOptions) -> Result<u32, String> {
    use std::os::unix::process::CommandExt;

    let mut command = std::process::Command::new(&options.command);
    command
        .args(&options.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    match display {
        Some(display) => command.env("DISPLAY", display),
        None => command.env_remove("DISPLAY"),
    };
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    // SAFETY: setsid is async-signal-safe and touches no parent state.
    unsafe {
        command.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let mut child = tokio::process::Command::from(command)
        .spawn()
        .map_err(|error| {
            let code = crate::platform::fs::error_code(&error).unwrap_or("EUNKNOWN");
            format!("spawn {} {code}", options.command)
        })?;
    let pid = child.id().ok_or("Process has no PID")?;
    tokio::spawn(async move {
        let _ = child.wait().await;
    });
    Ok(pid)
}

impl AccessibilityProvider for X11DesktopProvider {
    fn tree(&self, query: AccessibilityQuery) -> DesktopFuture<'_, AccessibilityTree> {
        async move {
            if self.display.is_none() {
                return Err("No desktop is available".into());
            }
            if let Some(root) = &query.root {
                return self.atspi.tree(root, &query).await;
            }
            let id = self.window_id(query.window.clone()).await?;
            let (title, pid) = futures::join!(
                self.run(move |session| session.window_name(id)),
                self.run(move |session| session.window_pid(id)),
            );
            let title = title?;
            let pid = pid.ok().flatten();
            let Some(handle) = self.atspi.find_window(pid, &title).await? else {
                return Err(format!(
                    "Window \"{title}\" exposes no accessibility tree. {NO_TREE_HINT}"
                ));
            };
            self.atspi.wake(&handle).await?;
            let tree = self.atspi.tree(&handle, &query).await?;
            Ok(AccessibilityTree {
                window: Some(title),
                ..tree
            })
        }
        .boxed()
    }

    fn element(&self, handle: String) -> DesktopFuture<'_, Option<AccessibilityElement>> {
        async move {
            if self.display.is_none() {
                return Err("No desktop is available".into());
            }
            self.atspi.element(&handle).await
        }
        .boxed()
    }
}

impl DesktopProvider for X11DesktopProvider {
    fn probe(&self) -> BoxFuture<'_, DesktopCapabilities> {
        async move {
            if self.display.is_none() {
                return DesktopCapabilities::none();
            }
            let (screen, stream, accessibility) = futures::join!(
                self.run(|session| Ok((session.screen_size()?, session.has_xtest()))),
                self.connect_stream(),
                self.atspi.available(),
            );
            let screen = screen.ok();
            DesktopCapabilities {
                computer_use: screen.is_some_and(|(_, xtest)| xtest),
                stream: stream.is_ok() || (self.builtin_stream.is_some() && screen.is_some()),
                accessibility,
                screen: screen.map(|(size, _)| size),
                hint: None,
            }
        }
        .boxed()
    }

    fn screen_size(&self) -> DesktopFuture<'_, ScreenSize> {
        self.run(|session| session.screen_size()).boxed()
    }

    fn capture(&self, options: CaptureOptions) -> DesktopFuture<'_, Vec<u8>> {
        self.run(move |session| session.capture(options)).boxed()
    }

    fn click(
        &self,
        point: Point,
        button: MouseButton,
        count: u32,
        modifiers: Vec<String>,
    ) -> DesktopFuture<'_, ()> {
        async move {
            let held = modifiers
                .iter()
                .map(|modifier| keys::to_xdotool_modifier(modifier))
                .collect::<Result<Vec<_>, _>>()?;
            let release = held.iter().rev().cloned().collect::<Vec<_>>();
            let pressed = self
                .run(move |session| session.modifiers(&held, true))
                .await;
            let clicked = match pressed {
                Ok(()) => {
                    self.run(move |session| {
                        session.move_to(point.x, point.y)?;
                        session.click(
                            Session::button_for(button),
                            count,
                            Duration::from_millis(80),
                        )
                    })
                    .await
                }
                Err(error) => Err(error),
            };
            // A separate call, so a failed or timed-out press or click (which
            // resets the connection) still releases every modifier.
            let released = self
                .run(move |session| session.modifiers(&release, false))
                .await;
            clicked.and(released)
        }
        .boxed()
    }

    fn drag(&self, from: Point, to: Point, button: MouseButton) -> DesktopFuture<'_, ()> {
        let middle = Point {
            x: ((from.x + to.x) as f64 / 2.0).round() as i64,
            y: ((from.y + to.y) as f64 / 2.0).round() as i64,
        };
        self.run(move |session| {
            let pause = || std::thread::sleep(Duration::from_millis(50));
            session.move_to(from.x, from.y)?;
            session.mouse_button(button, true)?;
            let moved = (|| {
                pause();
                session.move_to(middle.x, middle.y)?;
                pause();
                session.move_to(to.x, to.y)?;
                pause();
                Ok(())
            })();
            let released = session.mouse_button(button, false);
            moved.and(released)
        })
        .boxed()
    }

    fn move_to(&self, point: Point) -> DesktopFuture<'_, ()> {
        self.run(move |session| session.move_to(point.x, point.y))
            .boxed()
    }

    fn scroll(
        &self,
        point: Point,
        direction: ScrollDirection,
        amount: u32,
    ) -> DesktopFuture<'_, ()> {
        self.run(move |session| {
            session.move_to(point.x, point.y)?;
            session.click(
                x11::scroll_button(direction),
                amount,
                Duration::from_millis(30),
            )
        })
        .boxed()
    }

    fn type_text(&self, text: String) -> DesktopFuture<'_, ()> {
        async move {
            let characters: Vec<char> = text.chars().collect();
            for chunk in characters.chunks(TYPE_CHUNK_CHARACTERS) {
                let chunk: String = chunk.iter().collect();
                self.run(move |session| session.type_text(&chunk, Duration::from_millis(12)))
                    .await?;
            }
            Ok(())
        }
        .boxed()
    }

    fn key(&self, combos: Vec<String>) -> DesktopFuture<'_, ()> {
        async move {
            let combos = combos
                .iter()
                .map(|combo| keys::to_xdotool_combo(combo))
                .collect::<Result<Vec<_>, _>>()?;
            self.run(move |session| session.key_combos(&combos, Duration::from_millis(40)))
                .await
        }
        .boxed()
    }

    fn list_windows(&self) -> DesktopFuture<'_, Vec<DesktopWindow>> {
        self.run(|session| session.list_windows()).boxed()
    }

    fn focus_window(&self, id: String) -> DesktopFuture<'_, ()> {
        async move {
            let window = id
                .parse::<u32>()
                .ok()
                .filter(|_| id.bytes().all(|byte| byte.is_ascii_digit()))
                .ok_or_else(|| format!("Invalid window id: {id}"))?;
            self.run(move |session| session.focus_window(window)).await
        }
        .boxed()
    }

    fn launch(&self, options: LaunchOptions) -> DesktopFuture<'_, u32> {
        futures::future::ready(launch(self.display.as_deref(), options)).boxed()
    }

    fn accessibility(&self) -> Option<&dyn AccessibilityProvider> {
        Some(self)
    }

    fn open_stream(&self) -> DesktopFuture<'_, DuplexStream> {
        async move {
            if self.display.is_none() {
                return Err("No X display is configured".into());
            }
            match (self.connect_stream().await, &self.builtin_stream) {
                (Ok(socket), _) => Ok(bridge(socket)),
                (Err(_), Some(warn)) => {
                    self.run(|session| session.screen_size()).await?;
                    Ok(self.stream_server(warn).open())
                }
                (Err(error), None) => Err(error),
            }
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::atspi::fake::{FakeAtspi, sample_application};
    use super::*;

    fn headless(connect: AtspiConnector) -> X11DesktopProvider {
        X11DesktopProvider::new(
            None,
            "/nonexistent/vnc.sock".into(),
            None,
            None,
            None,
            connect,
        )
    }

    #[tokio::test]
    async fn runs_nothing_on_headless_linux() {
        let fake = FakeAtspi::new(vec![sample_application()]);
        let provider = headless(fake.connector());
        assert_eq!(provider.probe().await, DesktopCapabilities::none());
        assert_eq!(
            provider.open_stream().await.unwrap_err(),
            "No X display is configured"
        );
        assert!(fake.connections.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn streams_from_the_vnc_socket_and_reports_a_missing_one() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("vnc.sock");
        let fake = FakeAtspi::new(Vec::new());
        let provider = X11DesktopProvider::new(
            Some(":99".into()),
            path.clone(),
            None,
            None,
            None,
            fake.connector(),
        );
        assert!(provider.open_stream().await.is_err());

        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            socket.write_all(b"RFB 003.008\n").await.unwrap();
            let mut reply = [0u8; 12];
            socket.read_exact(&mut reply).await.unwrap();
            socket.write_all(&reply).await.unwrap();
        });
        let mut stream = provider.open_stream().await.unwrap();
        let mut version = [0u8; 12];
        stream.read_exact(&mut version).await.unwrap();
        assert_eq!(&version, b"RFB 003.008\n");
        stream.write_all(b"RFB 003.003\n").await.unwrap();
        stream.read_exact(&mut version).await.unwrap();
        assert_eq!(&version, b"RFB 003.003\n");
        assert_eq!(stream.read(&mut version).await.unwrap(), 0);
    }

    #[tokio::test]
    async fn finds_the_accessibility_bus_from_the_session_bus() {
        let mut fake = FakeAtspi::new(vec![sample_application()]);
        fake.a11y_address = "unix:path=/run/user/1000/at-spi/bus_1".into();
        let provider = X11DesktopProvider::new(
            Some(":99".into()),
            "/nonexistent/vnc.sock".into(),
            None,
            None,
            Some("unix:path=/run/user/1000/bus".into()),
            fake.connector(),
        );
        assert!(provider.atspi.available().await);
        assert_eq!(
            *fake.connections.lock().unwrap(),
            [
                "unix:path=/run/user/1000/bus",
                "unix:path=/run/user/1000/at-spi/bus_1"
            ]
        );
    }

    #[tokio::test]
    async fn gives_up_on_a_session_bus_launcher_that_never_answers() {
        struct Silent;
        impl atspi::AtspiBus for Silent {
            fn children(
                &self,
                _: &str,
                _: &str,
            ) -> atspi::BusFuture<'static, Vec<(String, String)>> {
                futures::future::pending().boxed()
            }
            fn role_name(&self, _: &str, _: &str) -> atspi::BusFuture<'static, String> {
                futures::future::pending().boxed()
            }
            fn state(&self, _: &str, _: &str) -> atspi::BusFuture<'static, Vec<u32>> {
                futures::future::pending().boxed()
            }
            fn attributes(&self, _: &str, _: &str) -> atspi::BusFuture<'static, ()> {
                futures::future::pending().boxed()
            }
            fn string_property(
                &self,
                _: &str,
                _: &str,
                _: &str,
                _: &str,
            ) -> atspi::BusFuture<'static, String> {
                futures::future::pending().boxed()
            }
            fn number_property(
                &self,
                _: &str,
                _: &str,
                _: &str,
                _: &str,
            ) -> atspi::BusFuture<'static, f64> {
                futures::future::pending().boxed()
            }
            fn extents(&self, _: &str, _: &str) -> atspi::BusFuture<'static, (i32, i32, i32, i32)> {
                futures::future::pending().boxed()
            }
            fn text(&self, _: &str, _: &str, _: i32, _: i32) -> atspi::BusFuture<'static, String> {
                futures::future::pending().boxed()
            }
            fn unix_process_id(&self, _: &str) -> atspi::BusFuture<'static, u32> {
                futures::future::pending().boxed()
            }
            fn a11y_address(&self) -> atspi::BusFuture<'static, String> {
                futures::future::pending().boxed()
            }
            fn closed(&self) -> bool {
                false
            }
            fn close(&self) -> futures::future::BoxFuture<'static, ()> {
                futures::future::ready(()).boxed()
            }
        }
        let connect: AtspiConnector = Arc::new(|_| {
            futures::future::ready(Ok(Arc::new(Silent) as Arc<dyn atspi::AtspiBus>)).boxed()
        });
        let x = Display::new(":nonexistent-display".into());
        let started = tokio::time::Instant::now();
        let result = atspi_address_of(
            &x,
            None,
            Some("unix:path=/run/user/1000/bus".into()),
            connect,
        )
        .await;
        assert_eq!(
            result.unwrap_err(),
            "The accessibility bus launcher did not answer"
        );
        assert!(started.elapsed() < Duration::from_secs(8));
    }

    #[test]
    fn picks_the_portal_on_wayland_unless_a_vnc_socket_is_configured() {
        let x11 = |builtin_stream| Kind::X11 { builtin_stream };
        assert_eq!(kind(None, None, None), x11(true));
        assert_eq!(kind(None, None, Some("x11")), x11(true));
        assert_eq!(kind(None, Some("wayland-0"), None), Kind::Wayland);
        assert_eq!(kind(None, None, Some("wayland")), Kind::Wayland);
        assert_eq!(
            kind(
                Some("/run/klex/vnc.sock"),
                Some("wayland-0"),
                Some("wayland")
            ),
            x11(false)
        );
    }

    #[test]
    fn launches_detached_processes_and_reports_missing_commands() {
        let runtime = tokio::runtime::Runtime::new().unwrap();
        runtime.block_on(async {
            let pid = launch(
                Some(":99"),
                LaunchOptions {
                    command: "true".into(),
                    args: Vec::new(),
                    cwd: None,
                },
            )
            .unwrap();
            assert!(pid > 0);
            assert_eq!(
                launch(
                    None,
                    LaunchOptions {
                        command: "klex-no-such-command".into(),
                        args: Vec::new(),
                        cwd: None,
                    },
                )
                .unwrap_err(),
                "spawn klex-no-such-command ENOENT"
            );
        });
    }
}
