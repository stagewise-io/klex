//! Native desktop providers: screenshots, input and the RFB stream source.

#[cfg(target_os = "linux")]
mod linux;

use std::path::Path;
use std::sync::Arc;

use crate::desktop::Warn;
use crate::desktop::provider::DesktopProvider;

#[cfg(target_os = "macos")]
mod macos;
#[cfg(any(target_os = "macos", test))]
mod macos_display;
#[cfg(any(target_os = "macos", test))]
mod macos_keys;
#[cfg(windows)]
mod windows;
#[cfg(any(windows, test))]
mod windows_keys;

/// The signed-in user's desktop on this platform, or `None` where
/// klex-machine has no native desktop support.
#[cfg(windows)]
pub fn provider(warn: Warn, _data_dir: Option<&Path>) -> Option<Arc<dyn DesktopProvider>> {
    Some(Arc::new(windows::WindowsDesktopProvider::new(warn)))
}

/// The signed-in user's desktop on this platform, or `None` where
/// klex-machine has no native desktop support.
#[cfg(target_os = "macos")]
pub fn provider(warn: Warn, _data_dir: Option<&Path>) -> Option<Arc<dyn DesktopProvider>> {
    Some(macos::provider(warn))
}

/// The signed-in user's desktop on this platform, or `None` where
/// klex-machine has no native desktop support.
#[cfg(target_os = "linux")]
pub fn provider(warn: Warn, data_dir: Option<&Path>) -> Option<Arc<dyn DesktopProvider>> {
    Some(linux::provider(warn, data_dir))
}

/// The signed-in user's desktop on this platform, or `None` where
/// klex-machine has no native desktop support.
#[cfg(not(any(windows, target_os = "macos", target_os = "linux")))]
pub fn provider(_warn: Warn, _data_dir: Option<&Path>) -> Option<Arc<dyn DesktopProvider>> {
    None
}

/// Runs `work` while the main thread serves the platform's UI event loop,
/// which macOS requires for keyboard layouts and app activation. Elsewhere
/// it runs `work` directly.
pub fn host_main_thread<T: Send + 'static>(work: impl FnOnce() -> T + Send + 'static) -> T {
    #[cfg(target_os = "macos")]
    {
        macos::threads::host(work)
    }
    #[cfg(not(target_os = "macos"))]
    {
        work()
    }
}
