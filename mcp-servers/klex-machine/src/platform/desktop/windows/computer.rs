//! Computer-use requests, run one at a time on the DPI-aware desktop worker
//! thread. Whatever a request holds down is released when it returns,
//! fails or panics.

use std::thread::sleep;
use std::time::Duration;

use windows_sys::Win32::Foundation::{HWND, LPARAM, RECT};
use windows_sys::Win32::Graphics::Dwm::{
    DWMWA_CLOAKED, DWMWA_EXTENDED_FRAME_BOUNDS, DwmGetWindowAttribute,
};
use windows_sys::Win32::System::RemoteDesktop::ProcessIdToSessionId;
use windows_sys::Win32::System::StationsAndDesktops::{
    GetProcessWindowStation, GetUserObjectInformationW, UOI_FLAGS, USEROBJECTFLAGS,
};
use windows_sys::Win32::System::Threading::{
    AttachThreadInput, GetCurrentProcessId, GetCurrentThreadId,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, MOUSE_EVENT_FLAGS, MOUSEEVENTF_HWHEEL, MOUSEEVENTF_WHEEL, VkKeyScanW,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    BringWindowToTop, EnumWindows, GWL_EXSTYLE, GetForegroundWindow, GetWindowLongW, GetWindowRect,
    GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsIconic, IsWindow,
    IsWindowVisible, SW_RESTORE, SetForegroundWindow, ShowWindow, WS_EX_TOOLWINDOW,
};

use super::super::windows_keys::{
    ComboKey, VK_CONTROL, VK_MENU, VK_RETURN, VK_SHIFT, VK_TAB, VK_UNASSIGNED,
};
use super::win32::{
    self, Canvas, button_flags, mouse, move_to, screen_size, send, try_send, unicode, virtual_key,
};
use crate::desktop::image::RgbImage;
use crate::desktop::provider::{
    CaptureOptions, DesktopResult, DesktopWindow, MouseButton, Point, Region, ScrollDirection,
};

const WHEEL_DELTA: i32 = 120;
const MAX_WINDOWS: usize = 50;
const WSF_VISIBLE: u32 = 1;

pub struct ProbeInfo {
    pub session: Option<u32>,
    pub interactive: bool,
    pub desktop: String,
    pub width: i32,
    pub height: i32,
    pub capture: Result<(), String>,
}

pub fn probe() -> ProbeInfo {
    let mut session = 0u32;
    // SAFETY: plain call with a valid out pointer.
    let session = (unsafe { ProcessIdToSessionId(GetCurrentProcessId(), &mut session) } != 0)
        .then_some(session);
    let (width, height) = screen_size();
    ProbeInfo {
        session,
        interactive: station_visible(),
        desktop: win32::input_desktop_name(),
        width,
        height,
        capture: Canvas::new(1, 1).and_then(|mut pixel| pixel.grab(0, 0)),
    }
}

fn station_visible() -> bool {
    // SAFETY: the station handle needs no closing; `flags` outlives the call.
    unsafe {
        let station = GetProcessWindowStation();
        if station.is_null() {
            return false;
        }
        let mut flags: USEROBJECTFLAGS = std::mem::zeroed();
        let mut needed = 0u32;
        GetUserObjectInformationW(
            station,
            UOI_FLAGS,
            (&raw mut flags).cast(),
            size_of::<USEROBJECTFLAGS>() as u32,
            &mut needed,
        ) != 0
            && flags.dwFlags & WSF_VISIBLE != 0
    }
}

/// Fails while an elevated window has focus, where UIPI drops input silently.
pub fn require_input() -> DesktopResult<()> {
    match win32::elevated_foreground() {
        None => Ok(()),
        Some(name) => Err(format!(
            "An administrator window ({name}) has focus, so Windows discards all input from klex-machine, anywhere on the screen, until that window is closed or loses focus. Ask the user to close it or click another window, or run klex-machine elevated."
        )),
    }
}

pub fn capture(options: CaptureOptions) -> DesktopResult<Vec<u8>> {
    let (width, height) = screen_size();
    let region = options.region.unwrap_or(Region {
        x: 0,
        y: 0,
        width: width.into(),
        height: height.into(),
    });
    let fits = |value: i64| i32::try_from(value).map_err(|_| format!("Invalid number: {value}"));
    if region.width <= 0 || region.height <= 0 {
        return Err("The capture region is empty".into());
    }
    let mut canvas = Canvas::new(fits(region.width)?, fits(region.height)?)?;
    canvas.grab(fits(region.x)?, fits(region.y)?)?;
    let mut image = RgbImage::from_bgrx(
        canvas.width as u32,
        canvas.height as u32,
        canvas.width as usize * 4,
        canvas.bgrx(),
    );
    drop(canvas);
    if let Some(size) = options.size {
        if size.width <= 0 || size.height <= 0 {
            return Err("The output size is empty".into());
        }
        image = image.resized(size);
    }
    image.encode(options.format)
}

fn coordinate(value: i64) -> DesktopResult<i32> {
    i32::try_from(value).map_err(|_| format!("Invalid number: {value}"))
}

/// Keys pressed so far, let go in reverse order on drop.
#[derive(Default)]
struct HeldKeys(Vec<u16>);

impl HeldKeys {
    fn press(&mut self, vk: u16) -> DesktopResult<()> {
        send(&[virtual_key(vk, false)])?;
        self.0.push(vk);
        Ok(())
    }
}

impl Drop for HeldKeys {
    fn drop(&mut self) {
        for vk in self.0.drain(..).rev() {
            try_send(&[virtual_key(vk, true)]);
        }
    }
}

/// A mouse button that goes up on drop unless released first.
struct HeldButton(Option<MOUSE_EVENT_FLAGS>);

impl HeldButton {
    /// Disarms only once the button is up, so a failed send is retried on drop.
    fn release(mut self) -> DesktopResult<()> {
        if let Some(up) = self.0 {
            send(&[mouse(up, 0, 0, 0)])?;
            self.0 = None;
        }
        Ok(())
    }
}

impl Drop for HeldButton {
    fn drop(&mut self) {
        if let Some(up) = self.0.take() {
            try_send(&[mouse(up, 0, 0, 0)]);
        }
    }
}

pub fn click(
    point: Point,
    button: MouseButton,
    count: u32,
    modifiers: &[u16],
) -> DesktopResult<()> {
    let (down, up) = button_flags(button);
    move_to(coordinate(point.x)?, coordinate(point.y)?)?;
    let mut held = HeldKeys::default();
    for vk in modifiers {
        held.press(*vk)?;
    }
    for i in 0..count {
        if i > 0 {
            sleep(Duration::from_millis(40));
        }
        send(&[mouse(down, 0, 0, 0), mouse(up, 0, 0, 0)])?;
    }
    Ok(())
}

pub fn drag(from: Point, to: Point, button: MouseButton) -> DesktopResult<()> {
    let (down, up) = button_flags(button);
    let (fx, fy, tx, ty) = (
        coordinate(from.x)?,
        coordinate(from.y)?,
        coordinate(to.x)?,
        coordinate(to.y)?,
    );
    move_to(fx, fy)?;
    send(&[mouse(down, 0, 0, 0)])?;
    let held = HeldButton(Some(up));
    sleep(Duration::from_millis(50));
    for step in 1..=10 {
        move_to(fx + (tx - fx) * step / 10, fy + (ty - fy) * step / 10)?;
        sleep(Duration::from_millis(15));
    }
    sleep(Duration::from_millis(50));
    held.release()
}

pub fn move_pointer(point: Point) -> DesktopResult<()> {
    move_to(coordinate(point.x)?, coordinate(point.y)?)
}

pub fn wheel(direction: ScrollDirection) -> INPUT {
    let (flag, delta) = match direction {
        ScrollDirection::Up => (MOUSEEVENTF_WHEEL, WHEEL_DELTA),
        ScrollDirection::Down => (MOUSEEVENTF_WHEEL, -WHEEL_DELTA),
        ScrollDirection::Left => (MOUSEEVENTF_HWHEEL, -WHEEL_DELTA),
        ScrollDirection::Right => (MOUSEEVENTF_HWHEEL, WHEEL_DELTA),
    };
    mouse(flag, 0, 0, delta as u32)
}

pub fn scroll(point: Point, direction: ScrollDirection, amount: u32) -> DesktopResult<()> {
    move_to(coordinate(point.x)?, coordinate(point.y)?)?;
    for i in 0..amount {
        if i > 0 {
            sleep(Duration::from_millis(30));
        }
        send(&[wheel(direction)])?;
    }
    Ok(())
}

fn tap(vk: u16) -> DesktopResult<()> {
    send(&[virtual_key(vk, false), virtual_key(vk, true)])
}

pub fn type_text(text: &str) -> DesktopResult<()> {
    let units: Vec<u16> = text.encode_utf16().collect();
    let mut i = 0;
    while i < units.len() {
        let unit = units[i];
        match unit {
            0x0d => {
                if units.get(i + 1) != Some(&0x0a) {
                    tap(VK_RETURN)?;
                }
            }
            0x0a => tap(VK_RETURN)?,
            0x09 => tap(VK_TAB)?,
            0xd800..=0xdbff if i + 1 < units.len() => {
                i += 1;
                let low = units[i];
                send(&[
                    unicode(unit, false),
                    unicode(unit, true),
                    unicode(low, false),
                    unicode(low, true),
                ])?;
            }
            _ => send(&[unicode(unit, false), unicode(unit, true)])?,
        }
        // A skipped CR before LF types nothing, so it needs no pause.
        if !(unit == 0x0d && units.get(i + 1) == Some(&0x0a)) {
            sleep(Duration::from_millis(8));
        }
        i += 1;
    }
    Ok(())
}

/// Virtual keys for a combo, with the shift state the layout needs for
/// characters, each once.
fn combo_keys(combo: &[ComboKey]) -> DesktopResult<Vec<u16>> {
    let mut keys = Vec::new();
    let mut add = |vk: u16| {
        if !keys.contains(&vk) {
            keys.push(vk);
        }
    };
    for key in combo {
        match *key {
            ComboKey::Virtual(vk) => add(vk),
            ComboKey::Character(unit) => {
                // SAFETY: plain call.
                let scan = unsafe { VkKeyScanW(unit) };
                if scan == -1 {
                    let character = char::from_u32(unit.into()).unwrap_or('\u{fffd}');
                    return Err(format!("The keyboard layout has no key for '{character}'"));
                }
                let shift_state = (scan >> 8) & 0xff;
                if shift_state & 1 != 0 {
                    add(VK_SHIFT);
                }
                if shift_state & 2 != 0 {
                    add(VK_CONTROL);
                }
                if shift_state & 4 != 0 {
                    add(VK_MENU);
                }
                add((scan & 0xff) as u16);
            }
        }
    }
    Ok(keys)
}

pub fn keys(combos: &[Vec<ComboKey>]) -> DesktopResult<()> {
    for (i, combo) in combos.iter().enumerate() {
        if i > 0 {
            sleep(Duration::from_millis(40));
        }
        let keys = combo_keys(combo)?;
        let mut held = HeldKeys::default();
        for vk in keys {
            held.press(vk)?;
        }
    }
    Ok(())
}

fn cloaked(window: HWND) -> bool {
    let mut value = 0u32;
    // SAFETY: `value` is a valid 4-byte out buffer.
    unsafe {
        DwmGetWindowAttribute(
            window,
            DWMWA_CLOAKED as u32,
            (&raw mut value).cast(),
            size_of::<u32>() as u32,
        ) == 0
            && value != 0
    }
}

/// Extended frame bounds leave out the invisible resize border.
fn bounds(window: HWND) -> Option<RECT> {
    let mut rect = RECT {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0,
    };
    // SAFETY: `rect` is a valid out buffer of the size passed.
    unsafe {
        if DwmGetWindowAttribute(
            window,
            DWMWA_EXTENDED_FRAME_BOUNDS as u32,
            (&raw mut rect).cast(),
            size_of::<RECT>() as u32,
        ) == 0
            || GetWindowRect(window, &mut rect) != 0
        {
            Some(rect)
        } else {
            None
        }
    }
}

fn window_title(window: HWND) -> Option<String> {
    // SAFETY: the buffer holds `length + 1` units, as passed.
    unsafe {
        let length = GetWindowTextLengthW(window);
        if length <= 0 {
            return None;
        }
        let mut buffer = vec![0u16; length as usize + 1];
        let copied = GetWindowTextW(window, buffer.as_mut_ptr(), buffer.len() as i32);
        (copied > 0).then(|| String::from_utf16_lossy(&buffer[..copied as usize]))
    }
}

struct Listing {
    windows: Vec<DesktopWindow>,
    foreground: HWND,
    screen: (i32, i32),
}

unsafe extern "system" fn visit(window: HWND, state: LPARAM) -> i32 {
    // SAFETY: `state` is the `Listing` that `list_windows` passed, alive for
    // the whole enumeration.
    let listing = unsafe { &mut *(state as *mut Listing) };
    if listing.windows.len() >= MAX_WINDOWS {
        return 0;
    }
    // SAFETY: plain calls on a window handle from the enumeration.
    let hidden = unsafe {
        IsWindowVisible(window) == 0
            || IsIconic(window) != 0
            || cloaked(window)
            || GetWindowLongW(window, GWL_EXSTYLE) as u32 & WS_EX_TOOLWINDOW != 0
    };
    if hidden {
        return 1;
    }
    let (Some(title), Some(rect)) = (window_title(window), bounds(window)) else {
        return 1;
    };
    // Capture and input cover the primary monitor only, so clip to it.
    let (left, top) = (rect.left.max(0), rect.top.max(0));
    let width = rect.right.min(listing.screen.0) - left;
    let height = rect.bottom.min(listing.screen.1) - top;
    if width <= 1 || height <= 1 {
        return 1;
    }
    listing.windows.push(DesktopWindow {
        id: (window as usize).to_string(),
        title,
        bounds: Region {
            x: left.into(),
            y: top.into(),
            width: width.into(),
            height: height.into(),
        },
        focused: window == listing.foreground,
    });
    1
}

pub fn list_windows() -> Vec<DesktopWindow> {
    let mut listing = Listing {
        windows: Vec::new(),
        // SAFETY: plain call.
        foreground: unsafe { GetForegroundWindow() },
        screen: screen_size(),
    };
    // SAFETY: `listing` outlives the synchronous enumeration.
    unsafe { EnumWindows(Some(visit), (&raw mut listing) as LPARAM) };
    listing.windows
}

fn is_foreground(window: HWND) -> bool {
    for _ in 0..10 {
        // SAFETY: plain call.
        if unsafe { GetForegroundWindow() } == window {
            return true;
        }
        sleep(Duration::from_millis(20));
    }
    false
}

pub fn focus(id: &str) -> DesktopResult<()> {
    let value = id
        .bytes()
        .all(|b| b.is_ascii_digit())
        .then(|| id.parse::<usize>().ok())
        .flatten()
        .ok_or_else(|| format!("Invalid window id: {id}"))?;
    let window = value as HWND;
    // SAFETY: plain calls; Windows validates the handle.
    unsafe {
        if IsWindow(window) == 0 {
            return Err(format!("No window has id {id}"));
        }
        if IsIconic(window) != 0 {
            ShowWindow(window, SW_RESTORE);
        }
        if SetForegroundWindow(window) != 0 && is_foreground(window) {
            return Ok(());
        }
        // Foreground lock: borrow the foreground thread's input state.
        let foreground_thread =
            GetWindowThreadProcessId(GetForegroundWindow(), std::ptr::null_mut());
        let thread = GetCurrentThreadId();
        let attached = foreground_thread != 0
            && foreground_thread != thread
            && AttachThreadInput(thread, foreground_thread, 1) != 0;
        BringWindowToTop(window);
        SetForegroundWindow(window);
        if attached {
            AttachThreadInput(thread, foreground_thread, 0);
        }
        if is_foreground(window) {
            return Ok(());
        }
        // Holding Alt lifts the lock; an unassigned key keeps the release
        // from opening a menu.
        let mut held = HeldKeys::default();
        held.press(VK_MENU)?;
        SetForegroundWindow(window);
        try_send(&[
            virtual_key(VK_UNASSIGNED, false),
            virtual_key(VK_UNASSIGNED, true),
        ]);
        drop(held);
        if !is_foreground(window) {
            return Err(format!("Windows kept window {id} in the background"));
        }
    }
    Ok(())
}
