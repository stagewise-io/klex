//! Window server session, display geometry and permission checks.

use objc2_application_services::AXIsProcessTrusted;
use objc2_core_graphics::{
    CGDisplayBounds, CGDisplayCopyDisplayMode, CGDisplayMode, CGDisplayRotation, CGMainDisplayID,
    CGPreflightScreenCaptureAccess, CGSessionCopyCurrentDictionary,
};

use super::super::macos_display::Display;

pub const ACCESSIBILITY_MISSING: &str =
    "Accessibility permission is missing; input events would be dropped";
pub const SCREEN_RECORDING_MISSING: &str = "Screen Recording permission is missing";

pub struct Probe {
    pub session: bool,
    pub screen_recording: bool,
    pub accessibility: bool,
    /// Only read with a session; without one the geometry is meaningless.
    pub display: Option<Display>,
}

pub fn has_session() -> bool {
    CGSessionCopyCurrentDictionary().is_some()
}

pub fn accessibility_trusted() -> bool {
    // SAFETY: takes no arguments and only reads the process's TCC state.
    unsafe { AXIsProcessTrusted() }
}

pub fn screen_recording_allowed() -> bool {
    CGPreflightScreenCaptureAccess()
}

pub fn require_accessibility() -> Result<(), String> {
    if accessibility_trusted() {
        Ok(())
    } else {
        Err(ACCESSIBILITY_MISSING.into())
    }
}

pub fn probe() -> Probe {
    let session = has_session();
    Probe {
        session,
        screen_recording: screen_recording_allowed(),
        accessibility: accessibility_trusted(),
        display: session.then(main_display),
    }
}

/// The main display, the one klex-machine captures and drives.
pub fn main_display() -> Display {
    let id = CGMainDisplayID();
    let bounds = CGDisplayBounds(id);
    let mut pixel_width = bounds.size.width;
    let mut pixel_height = bounds.size.height;
    if let Some(mode) = CGDisplayCopyDisplayMode(id) {
        pixel_width = CGDisplayMode::pixel_width(Some(&mode)) as f64;
        pixel_height = CGDisplayMode::pixel_height(Some(&mode)) as f64;
        // Modes are unrotated; bounds follow the rotation.
        if (CGDisplayRotation(id) as i64) % 180 == 90 {
            std::mem::swap(&mut pixel_width, &mut pixel_height);
        }
    }
    Display {
        x: bounds.origin.x,
        y: bounds.origin.y,
        width: bounds.size.width,
        height: bounds.size.height,
        pixel_width,
        pixel_height,
    }
}

pub fn read_display() -> Result<Display, String> {
    let display = main_display();
    if display.valid() {
        Ok(display)
    } else {
        Err(format!(
            "Unexpected display geometry: {}x{} points, {}x{} pixels",
            display.width, display.height, display.pixel_width, display.pixel_height
        ))
    }
}
