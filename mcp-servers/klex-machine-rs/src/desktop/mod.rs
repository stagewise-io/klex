//! Computer use: screenshots and input on the machine's graphical desktop,
//! the control lease shared with Cloud viewers, and the RFB stream.

pub mod fake;
pub mod image;
pub mod lease;
pub mod provider;
pub mod rfb;
pub mod service;
pub mod tools;

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, LazyLock, Mutex};

use fake::{FakeDesktopMode, FakeDesktopProvider};
use provider::DesktopProvider;
use service::DesktopService;

/// Receives desktop hints and helper logs.
pub type Warn = Arc<dyn Fn(&str) + Send + Sync>;

static SHARED: LazyLock<Mutex<HashMap<String, Arc<DesktopService>>>> =
    LazyLock::new(Mutex::default);

fn env(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

/// The desktop provider for this platform, or none where klex-machine has
/// no desktop support. `KLEX_MACHINE_DESKTOP=off` never offers one; the
/// `fake*` modes select the deterministic test desktop. What a provider can
/// actually do is left to its probe. `data_dir` keeps what a provider must
/// remember across runs, such as a screen sharing permission.
pub fn create_provider(warn: Warn, data_dir: Option<&Path>) -> Option<Arc<dyn DesktopProvider>> {
    let mode = env("KLEX_MACHINE_DESKTOP").map(|mode| mode.to_lowercase());
    if mode.as_deref() == Some("off") {
        return None;
    }
    if let Some(fake) = mode.as_deref().and_then(FakeDesktopMode::parse) {
        let log = env("KLEX_MACHINE_DESKTOP_FAKE_LOG").filter(|path| !path.is_empty());
        return Some(Arc::new(FakeDesktopProvider::new(
            fake,
            log.map(Into::into),
        )));
    }
    crate::platform::desktop::provider(warn, data_dir)
}

/// The desktop for this process. Instances are shared per desktop mode,
/// display and VNC socket so every principal's actions are serialized
/// against one screen.
pub fn desktop_from_environment(
    warn: Warn,
    data_dir: Option<&Path>,
) -> Option<Arc<DesktopService>> {
    let key = [
        env("KLEX_MACHINE_DESKTOP")
            .unwrap_or_default()
            .to_lowercase(),
        env("DISPLAY").unwrap_or_default().trim().to_string(),
        env("KLEX_MACHINE_VNC_SOCKET").unwrap_or_default(),
        env("WAYLAND_DISPLAY").unwrap_or_default(),
        env("XDG_SESSION_TYPE").unwrap_or_default(),
        data_dir
            .map(|path| path.display().to_string())
            .unwrap_or_default(),
    ]
    .join("\0");
    let mut shared = SHARED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    if let Some(service) = shared.get(&key) {
        return Some(service.clone());
    }
    let service = Arc::new(DesktopService::new(create_provider(warn, data_dir)?));
    shared.insert(key, service.clone());
    Some(service)
}
