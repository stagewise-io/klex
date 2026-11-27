//! Native desktop providers: screenshots, input and the RFB stream source.

use std::sync::Arc;

use crate::desktop::Warn;
use crate::desktop::provider::DesktopProvider;

/// The signed-in user's desktop on this platform, or `None` where
/// klex-machine has no native desktop support.
pub fn provider(_warn: Warn) -> Option<Arc<dyn DesktopProvider>> {
    None
}
