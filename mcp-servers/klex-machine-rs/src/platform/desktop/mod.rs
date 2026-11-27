//! Native desktop providers: screenshots, input and the RFB stream source.

use std::sync::Arc;

use crate::desktop::Warn;
use crate::desktop::provider::DesktopProvider;

#[cfg(windows)]
mod windows;
#[cfg(any(windows, test))]
mod windows_keys;

/// The signed-in user's desktop on this platform, or `None` where
/// klex-machine has no native desktop support.
#[cfg(windows)]
pub fn provider(warn: Warn) -> Option<Arc<dyn DesktopProvider>> {
    Some(Arc::new(windows::WindowsDesktopProvider::new(warn)))
}

/// The signed-in user's desktop on this platform, or `None` where
/// klex-machine has no native desktop support.
#[cfg(not(windows))]
pub fn provider(_warn: Warn) -> Option<Arc<dyn DesktopProvider>> {
    None
}
