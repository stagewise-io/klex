//! Background updates for release builds. The release overlay config adds
//! `plugins.updater` (public key and channel manifest); builds without it,
//! such as development and CI builds, never check for updates.
//!
//! An update downloads in the background and installs only when the person
//! chooses "Restart to update", so the daemon is never cut off mid-session.

use std::sync::Arc;
use std::time::Duration;

use tauri::{AppHandle, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};

use crate::desktop::{Desktop, lock};
use crate::logs::Source;

const FIRST_CHECK: Duration = Duration::from_secs(30);
const CHECK_INTERVAL: Duration = Duration::from_secs(4 * 60 * 60);

pub struct ReadyUpdate {
    update: Update,
    bytes: Vec<u8>,
}

impl ReadyUpdate {
    pub fn version(&self) -> &str {
        &self.update.version
    }
}

pub fn is_configured(config: &tauri::Config) -> bool {
    config.plugins.0.contains_key("updater")
}

/// Only an AppImage or a .deb install can replace itself on Linux.
fn can_self_update() -> bool {
    if cfg!(target_os = "linux") {
        return std::env::var_os("APPIMAGE").is_some()
            || tauri::utils::platform::bundle_type()
                == Some(tauri::utils::config::BundleType::Deb);
    }
    true
}

pub fn spawn(desktop: Arc<Desktop>) {
    if !can_self_update() {
        desktop.log(
            Source::App,
            "Automatic updates are off: this install can’t update itself",
        );
        return;
    }
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(FIRST_CHECK).await;
        loop {
            if let Err(error) = check(&desktop).await {
                desktop.log(Source::App, &format!("Update check failed: {error}"));
            }
            tokio::time::sleep(CHECK_INTERVAL).await;
        }
    });
}

async fn check(desktop: &Arc<Desktop>) -> Result<(), tauri_plugin_updater::Error> {
    let Some(update) = desktop.app.updater()?.check().await? else {
        return Ok(());
    };
    let already_ready = lock(&desktop.ready_update)
        .as_ref()
        .is_some_and(|ready| ready.version() == update.version);
    if already_ready {
        return Ok(());
    }
    desktop.log(
        Source::App,
        &format!("Downloading Klex Desktop {}", update.version),
    );
    let bytes = update.download(|_, _| {}, || {}).await?;
    desktop.log(
        Source::App,
        &format!("Klex Desktop {} is ready to install", update.version),
    );
    *lock(&desktop.ready_update) = Some(ReadyUpdate { update, bytes });
    desktop.broadcast();
    Ok(())
}

/// Stops the daemon, installs the downloaded update and relaunches. On
/// Windows the installer takes over and the process exits during `install`.
pub async fn install(app: &AppHandle) -> Result<(), String> {
    let desktop = app.state::<Arc<Desktop>>().inner().clone();
    let Some(ready) = lock(&desktop.ready_update).take() else {
        return Err("No update is ready to install".into());
    };
    desktop.log(
        Source::App,
        &format!("Installing Klex Desktop {}", ready.version()),
    );
    desktop.stop().await;
    if let Err(error) = ready.update.install(&ready.bytes) {
        let message = format!("Could not install the update: {error}");
        desktop.log(Source::App, &message);
        lock(&desktop.ready_update).get_or_insert(ready);
        let enabled = lock(&desktop.settings).enabled;
        if enabled && desktop.is_paired() {
            desktop.start().await;
        }
        desktop.broadcast();
        return Err(message);
    }
    app.restart();
}
