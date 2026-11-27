//! Klex Desktop: a tray app that pairs this computer with Klex Cloud and
//! keeps it connected. It links the `klex-machine` crate and runs it as a
//! child process by re-executing itself with [`DAEMON_FLAG`], supervising the
//! child over the crate's `--supervised` status channel.
//!
//! The product name and identifier live only in `tauri.conf.json`.

mod desktop;
mod logs;
mod pairing;
mod settings;
mod tray;

use std::sync::Arc;

use klex_machine::cloud::enrollment::EnrollmentPreview;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_autostart::{MacosLauncher, ManagerExt};
use tauri_plugin_deep_link::DeepLinkExt;
use tauri_plugin_opener::OpenerExt;

use crate::desktop::{AppStatus, Desktop, lock};
use crate::logs::{LogLine, Source};
use crate::pairing::PairingError;
use crate::settings::Paths;

/// First argument that turns this executable into the `klex-machine` daemon.
pub const DAEMON_FLAG: &str = "--daemon";
/// Passed by the login item, so the app starts in the tray without a window.
const AUTOSTART_FLAG: &str = "--autostart";
pub(crate) const WINDOW_LABEL: &str = "main";

type State<'a> = tauri::State<'a, Arc<Desktop>>;

#[tauri::command]
fn status(desktop: State<'_>) -> AppStatus {
    desktop.status()
}

#[tauri::command]
async fn preview_code(desktop: State<'_>, code: String) -> Result<EnrollmentPreview, PairingError> {
    pairing::preview(&desktop, code).await
}

#[tauri::command]
async fn confirm_pairing(desktop: State<'_>) -> Result<AppStatus, PairingError> {
    let desktop = desktop.inner().clone();
    pairing::confirm(&desktop).await
}

#[tauri::command]
fn cancel_pairing(desktop: State<'_>) {
    pairing::cancel(&desktop);
}

#[tauri::command]
fn take_pending_pair_code(desktop: State<'_>) -> Option<String> {
    lock(&desktop.pending_deep_link).take()
}

pub(crate) async fn set_enabled_inner(
    desktop: &Arc<Desktop>,
    enabled: bool,
) -> Result<AppStatus, String> {
    desktop.save_settings(|settings| settings.enabled = enabled)?;
    if enabled && desktop.is_paired() {
        desktop.log(Source::App, "Connecting");
        desktop.start().await;
    } else {
        desktop.log(Source::App, "Disconnecting");
        desktop.stop().await;
    }
    Ok(desktop.broadcast())
}

#[tauri::command]
async fn set_enabled(desktop: State<'_>, enabled: bool) -> Result<AppStatus, String> {
    let desktop = desktop.inner().clone();
    set_enabled_inner(&desktop, enabled).await
}

#[tauri::command]
async fn forget(desktop: State<'_>) -> Result<AppStatus, String> {
    let desktop = desktop.inner().clone();
    desktop.stop().await;
    match std::fs::remove_dir_all(&desktop.paths.data_dir) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Could not remove this computer’s identity: {error}"
            ));
        }
    }
    desktop.save_settings(|settings| {
        settings.enabled = true;
        settings.organization_name = None;
    })?;
    if let Err(error) = desktop.app.autolaunch().disable() {
        desktop.log(
            Source::App,
            &format!("Could not turn off start at sign-in: {error}"),
        );
    }
    desktop.log(Source::App, "Forgot this computer’s identity");
    Ok(desktop.broadcast())
}

#[tauri::command]
fn set_autostart(desktop: State<'_>, enabled: bool) -> Result<AppStatus, String> {
    let autolaunch = desktop.app.autolaunch();
    let result = if enabled {
        autolaunch.enable()
    } else {
        autolaunch.disable()
    };
    result.map_err(|error| error.to_string())?;
    Ok(desktop.broadcast())
}

#[tauri::command]
fn logs(desktop: State<'_>) -> Vec<LogLine> {
    desktop.logs.snapshot()
}

#[tauri::command]
fn open_log_folder(desktop: State<'_>) -> Result<(), String> {
    let directory = desktop.logs.directory().to_string_lossy().into_owned();
    desktop
        .app
        .opener()
        .open_path(directory, None::<&str>)
        .map_err(|error| error.to_string())
}

fn handle_deep_links(app: &AppHandle, urls: impl IntoIterator<Item = url::Url>) {
    let Some(code) = urls
        .into_iter()
        .find_map(|url| pairing::code_from_deep_link(&url))
    else {
        return;
    };
    let desktop = app.state::<Arc<Desktop>>();
    desktop.log(Source::App, "Received a pairing link");
    *lock(&desktop.pending_deep_link) = Some(code.clone());
    let _ = app.emit("pair-code", code);
    tray::show_window(app);
}

fn create_window(app: &AppHandle, visible: bool) -> tauri::Result<()> {
    let window = WebviewWindowBuilder::new(app, WINDOW_LABEL, WebviewUrl::default())
        .title(app.package_info().name.clone())
        .inner_size(440.0, 580.0)
        .min_inner_size(380.0, 480.0)
        .center()
        .visible(visible)
        .build()?;
    let hidden = window.clone();
    window.on_window_event(move |event| {
        // Closing the window keeps the app connected in the tray.
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = hidden.hide();
        }
    });
    Ok(())
}

fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let handle = app.handle().clone();
    let path = handle.path();
    let paths = Paths {
        data_dir: path.app_local_data_dir()?.join("machine"),
        settings: path.app_config_dir()?.join("settings.json"),
        log_dir: path.app_log_dir()?,
        home: path.home_dir()?,
    };
    let desktop = Arc::new(Desktop::new(handle.clone(), paths));
    app.manage(desktop.clone());
    desktop.log(
        Source::App,
        &format!(
            "{} {} started",
            handle.package_info().name,
            handle.package_info().version
        ),
    );

    #[cfg(target_os = "macos")]
    app.set_activation_policy(tauri::ActivationPolicy::Accessory);

    let autostarted = std::env::args().any(|arg| arg == AUTOSTART_FLAG);
    create_window(&handle, !autostarted)?;
    tray::create(&handle, &desktop.status())?;

    // Installers register the scheme; registering at runtime also covers
    // portable and development builds on Windows and Linux.
    #[cfg(any(windows, target_os = "linux"))]
    if let Err(error) = app.deep_link().register_all() {
        desktop.log(
            Source::App,
            &format!("Could not register klex:// links: {error}"),
        );
    }
    let links = handle.clone();
    app.deep_link()
        .on_open_url(move |event| handle_deep_links(&links, event.urls()));
    if let Ok(Some(urls)) = app.deep_link().get_current() {
        handle_deep_links(&handle, urls);
    }

    let enabled = lock(&desktop.settings).enabled;
    if enabled && desktop.is_paired() {
        tauri::async_runtime::spawn(async move { desktop.start().await });
    }
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        // Must be registered first, so a second launch exits before it
        // starts anything and only focuses this instance.
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            tray::show_window(app);
        }))
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            Some(vec![AUTOSTART_FLAG]),
        ))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            status,
            preview_code,
            confirm_pairing,
            cancel_pairing,
            take_pending_pair_code,
            set_enabled,
            forget,
            set_autostart,
            logs,
            open_log_folder,
        ])
        .setup(setup)
        .build(tauri::generate_context!())
        .expect("Klex Desktop failed to start");
    app.run(|app, event| {
        if let RunEvent::ExitRequested {
            code: None, api, ..
        } = event
        {
            // The window only hides; keep running in the tray.
            api.prevent_exit();
        } else if let RunEvent::Exit = event
            && let Some(desktop) = app.try_state::<Arc<Desktop>>()
        {
            tauri::async_runtime::block_on(desktop.stop());
        }
    });
}
