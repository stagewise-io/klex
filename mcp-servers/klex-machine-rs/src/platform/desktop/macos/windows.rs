//! On-screen windows from the window server, and raising one through the
//! Accessibility API.

use std::ptr::NonNull;
use std::time::{Duration, Instant};

use objc2_app_kit::{NSApplicationActivationOptions, NSRunningApplication, NSWorkspace};
use objc2_application_services::{AXError, AXUIElement, AXValue, AXValueType};
use objc2_core_foundation::{
    CFArray, CFBoolean, CFDictionary, CFNumber, CFRetained, CFString, CFType, CGPoint, CGRect,
    CGSize,
};
use objc2_core_graphics::{
    CGDisplayBounds, CGMainDisplayID, CGRectMakeWithDictionaryRepresentation,
    CGWindowListCopyWindowInfo, CGWindowListOption, kCGNullWindowID, kCGWindowAlpha,
    kCGWindowBounds, kCGWindowLayer, kCGWindowName, kCGWindowNumber, kCGWindowOwnerName,
    kCGWindowOwnerPID,
};

use super::threads::on_main_blocking;

const MAIN_THREAD_TIMEOUT: Duration = Duration::from_secs(5);
const FRONT_TIMEOUT: Duration = Duration::from_secs(2);

pub struct WindowInfo {
    pub id: String,
    pub app: String,
    pub title: String,
    pub bounds: CGRect,
    pub focused: bool,
}

struct Entry {
    dictionary: CFRetained<CFDictionary<CFString, CFType>>,
}

impl Entry {
    fn get(&self, key: &CFString) -> Option<CFRetained<CFType>> {
        self.dictionary.get(key)
    }

    fn integer(&self, key: &CFString) -> Option<i64> {
        self.get(key)?.downcast_ref::<CFNumber>()?.as_i64()
    }

    fn float(&self, key: &CFString) -> Option<f64> {
        self.get(key)?.downcast_ref::<CFNumber>()?.as_f64()
    }

    fn string(&self, key: &CFString) -> String {
        self.get(key)
            .and_then(|value| value.downcast_ref::<CFString>().map(ToString::to_string))
            .unwrap_or_default()
    }

    fn bounds(&self) -> Option<CGRect> {
        let value = self.get(unsafe { kCGWindowBounds })?;
        let dictionary = value.downcast_ref::<CFDictionary>()?;
        let mut rect = CGRect::default();
        // SAFETY: `rect` is a valid out pointer.
        unsafe { CGRectMakeWithDictionaryRepresentation(Some(dictionary), &mut rect) }
            .then_some(rect)
    }
}

/// Front to back.
fn on_screen() -> Vec<Entry> {
    let options =
        CGWindowListOption::OptionOnScreenOnly | CGWindowListOption::ExcludeDesktopElements;
    let Some(list) = CGWindowListCopyWindowInfo(options, kCGNullWindowID) else {
        return Vec::new();
    };
    // SAFETY: the window list is an array of dictionaries keyed by CFString.
    let list: &CFArray<CFDictionary<CFString, CFType>> = unsafe { list.cast_unchecked() };
    list.iter().map(|dictionary| Entry { dictionary }).collect()
}

fn frontmost_pid() -> Option<i32> {
    on_main_blocking(MAIN_THREAD_TIMEOUT, || {
        NSWorkspace::sharedWorkspace()
            .frontmostApplication()
            .map(|app| app.processIdentifier())
    })
    .flatten()
}

fn intersects(a: &CGRect, b: &CGRect) -> bool {
    a.size.width > 0.0
        && a.size.height > 0.0
        && b.size.width > 0.0
        && b.size.height > 0.0
        && a.origin.x < b.origin.x + b.size.width
        && b.origin.x < a.origin.x + a.size.width
        && a.origin.y < b.origin.y + b.size.height
        && b.origin.y < a.origin.y + a.size.height
}

/// Normal windows on the main display, the one the provider captures.
pub fn list() -> Vec<WindowInfo> {
    let screen = CGDisplayBounds(CGMainDisplayID());
    let frontmost = frontmost_pid();
    let mut focused_seen = false;
    let mut windows = Vec::new();
    // SAFETY: the keys are static CFStrings.
    let (layer, number, pid, alpha, owner, name) = unsafe {
        (
            kCGWindowLayer,
            kCGWindowNumber,
            kCGWindowOwnerPID,
            kCGWindowAlpha,
            kCGWindowOwnerName,
            kCGWindowName,
        )
    };
    for entry in on_screen() {
        if entry.integer(layer) != Some(0) {
            continue;
        }
        let (Some(id), Some(owner_pid), Some(bounds)) =
            (entry.integer(number), entry.integer(pid), entry.bounds())
        else {
            continue;
        };
        if entry.float(alpha).is_some_and(|alpha| alpha <= 0.0) {
            continue;
        }
        // The first window of the frontmost app has focus.
        let focused = !focused_seen && frontmost == Some(owner_pid as i32);
        if focused {
            focused_seen = true;
        }
        if !intersects(&bounds, &screen) {
            continue;
        }
        windows.push(WindowInfo {
            id: id.to_string(),
            app: entry.string(owner),
            title: entry.string(name),
            bounds,
            focused,
        });
    }
    windows
}

fn attribute(element: &AXUIElement, name: &str) -> Option<CFRetained<CFType>> {
    let name = CFString::from_str(name);
    let mut value: *const CFType = std::ptr::null();
    // SAFETY: `value` is a valid out pointer; a non-null result is +1.
    let error = unsafe { element.copy_attribute_value(&name, NonNull::from(&mut value)) };
    if error != AXError::Success {
        return None;
    }
    // SAFETY: the copied value is owned by the caller.
    NonNull::new(value.cast_mut()).map(|value| unsafe { CFRetained::from_raw(value) })
}

fn set_true(element: &AXUIElement, name: &str) -> AXError {
    let name = CFString::from_str(name);
    // SAFETY: a CFBoolean is a valid attribute value.
    unsafe { element.set_attribute_value(&name, CFBoolean::new(true)) }
}

fn ax_value<T: Default>(value: &CFType, kind: AXValueType) -> Option<T> {
    let value = value.downcast_ref::<AXValue>()?;
    let mut out = T::default();
    // SAFETY: `kind` matches `T` at every call site.
    unsafe { value.value(kind, NonNull::from(&mut out).cast()) }.then_some(out)
}

fn frame(window: &AXUIElement) -> Option<CGRect> {
    let position = attribute(window, "AXPosition")?;
    let size = attribute(window, "AXSize")?;
    let origin: CGPoint = ax_value(&position, AXValueType::CGPoint)?;
    let size: CGSize = ax_value(&size, AXValueType::CGSize)?;
    Some(CGRect { origin, size })
}

fn integral(rect: CGRect) -> (i64, i64, i64, i64) {
    let (x, y) = (rect.origin.x.floor(), rect.origin.y.floor());
    let right = (rect.origin.x + rect.size.width).ceil();
    let bottom = (rect.origin.y + rect.size.height).ceil();
    (x as i64, y as i64, (right - x) as i64, (bottom - y) as i64)
}

fn matching_window(
    app: &AXUIElement,
    bounds: CGRect,
    title: &str,
) -> Option<CFRetained<AXUIElement>> {
    let windows = attribute(app, "AXWindows")?;
    let windows = windows.downcast_ref::<CFArray>()?;
    // SAFETY: AXWindows is an array of AXUIElements.
    let windows: &CFArray<AXUIElement> = unsafe { windows.cast_unchecked() };
    let mut by_title = None;
    for window in windows.iter() {
        if frame(&window).is_some_and(|frame| integral(frame) == integral(bounds)) {
            return Some(window);
        }
        if by_title.is_none()
            && !title.is_empty()
            && attribute(&window, "AXTitle")
                .and_then(|value| value.downcast_ref::<CFString>().map(ToString::to_string))
                .as_deref()
                == Some(title)
        {
            by_title = Some(window);
        }
    }
    by_title
}

fn is_frontmost(app: &AXUIElement) -> bool {
    attribute(app, "AXFrontmost")
        .and_then(|value| value.downcast_ref::<CFBoolean>().map(CFBoolean::as_bool))
        .unwrap_or(false)
}

/// Raises a window and waits until its app is frontmost, so later input
/// cannot land in another app.
pub fn focus(id: &str) -> Result<(), String> {
    let number: i64 = id.parse().map_err(|_| format!("Invalid window id: {id}"))?;
    // SAFETY: static CFString keys.
    let (window_number, owner_pid, window_name) =
        unsafe { (kCGWindowNumber, kCGWindowOwnerPID, kCGWindowName) };
    let entry = on_screen()
        .into_iter()
        .find(|entry| entry.integer(window_number) == Some(number));
    let Some((entry, pid)) = entry.and_then(|entry| {
        let pid = entry.integer(owner_pid)?;
        Some((entry, pid as i32))
    }) else {
        return Err(format!("Window {id} is not on screen"));
    };
    // SAFETY: any PID is accepted; a dead one yields an inert element.
    let app = unsafe { AXUIElement::new_application(pid) };
    set_true(&app, "AXFrontmost");
    on_main_blocking(MAIN_THREAD_TIMEOUT, move || {
        if let Some(running) = NSRunningApplication::runningApplicationWithProcessIdentifier(pid) {
            #[allow(deprecated)]
            running.activateWithOptions(NSApplicationActivationOptions::ActivateIgnoringOtherApps);
        }
    });
    let window = entry
        .bounds()
        .and_then(|bounds| matching_window(&app, bounds, &entry.string(window_name)))
        .ok_or_else(|| format!("Window {id} exposes no accessibility element to raise"))?;
    set_true(&window, "AXMain");
    let action = CFString::from_str("AXRaise");
    // SAFETY: AXRaise is a standard window action.
    let raised = unsafe { window.perform_action(&action) };
    if raised != AXError::Success {
        return Err(format!(
            "Could not raise window {id} (AXError {})",
            raised.0
        ));
    }
    let deadline = Instant::now() + FRONT_TIMEOUT;
    while Instant::now() < deadline {
        if is_frontmost(&app) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    Err(format!("Window {id} did not come to the front"))
}
