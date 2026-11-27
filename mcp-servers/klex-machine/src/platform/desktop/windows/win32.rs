//! Win32 calls shared by the desktop provider and the stream: DPI awareness,
//! SendInput, GDI capture, the input desktop and UIPI checks.

use std::ffi::c_void;
use std::sync::{Mutex, OnceLock};

use windows_sys::Win32::Foundation::{
    CloseHandle, GetLastError, HANDLE, INVALID_HANDLE_VALUE, RECT,
};
use windows_sys::Win32::Graphics::Gdi::{
    BI_RGB, BITMAPINFO, BITMAPINFOHEADER, BitBlt, CLEARTYPE_QUALITY, CreateCompatibleDC,
    CreateDIBSection, CreateFontW, CreateSolidBrush, DIB_RGB_COLORS, DT_CENTER, DT_SINGLELINE,
    DT_VCENTER, DeleteDC, DeleteObject, DrawTextW, FW_NORMAL, FillRect, GdiFlush, GetDC, HBITMAP,
    HDC, HGDIOBJ, ReleaseDC, SRCCOPY, SelectObject, SetBkMode, SetTextColor, TRANSPARENT,
};
use windows_sys::Win32::Security::{
    GetSidSubAuthority, GetSidSubAuthorityCount, GetTokenInformation, TOKEN_MANDATORY_LABEL,
    TOKEN_QUERY, TokenIntegrityLevel,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
};
use windows_sys::Win32::System::StationsAndDesktops::{
    CloseDesktop, DESKTOP_READOBJECTS, GetUserObjectInformationW, OpenInputDesktop, UOI_NAME,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken,
    PROCESS_QUERY_LIMITED_INFORMATION,
};
use windows_sys::Win32::UI::HiDpi::{
    DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE, DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
    SetThreadDpiAwarenessContext,
};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{
    INPUT, INPUT_0, INPUT_KEYBOARD, INPUT_MOUSE, KEYBD_EVENT_FLAGS, KEYBDINPUT,
    KEYEVENTF_EXTENDEDKEY, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, MAPVK_VK_TO_VSC, MOUSE_EVENT_FLAGS,
    MOUSEEVENTF_ABSOLUTE, MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP, MOUSEEVENTF_MIDDLEDOWN,
    MOUSEEVENTF_MIDDLEUP, MOUSEEVENTF_MOVE, MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP, MOUSEINPUT,
    MapVirtualKeyW, SendInput,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    CURSOR_SHOWING, CURSORINFO, DI_NORMAL, DrawIconEx, GetCursorInfo, GetForegroundWindow,
    GetIconInfo, GetSystemMetrics, GetWindowThreadProcessId, ICONINFO, SM_CXSCREEN, SM_CYSCREEN,
    SM_SWAPBUTTON, SetCursorPos, SetProcessDPIAware,
};

use super::super::windows_keys::extended;
use crate::desktop::provider::MouseButton;

pub const ERROR_ACCESS_DENIED: u32 = 5;

/// Physical pixels for this thread's metrics, capture and input. Per-monitor
/// awareness is per thread, so every thread that touches the screen calls it.
pub fn init_dpi_awareness() {
    // SAFETY: plain calls with constant arguments.
    unsafe {
        if !SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2).is_null()
            || !SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE).is_null()
        {
            return;
        }
        SetProcessDPIAware();
    }
}

/// The primary monitor in physical pixels; zero when there is none.
pub fn screen_size() -> (i32, i32) {
    // SAFETY: plain calls.
    unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) }
}

/// A Windows error code as its message, without the trailing period.
pub fn error_message(code: u32) -> String {
    let text = std::io::Error::from_raw_os_error(code as i32).to_string();
    let text = text
        .rsplit_once(" (os error ")
        .map_or(text.as_str(), |(message, _)| message);
    text.trim_end().trim_end_matches('.').to_string()
}

pub fn last_error() -> u32 {
    // SAFETY: plain call.
    unsafe { GetLastError() }
}

pub fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(Some(0)).collect()
}

// MARK: Input

pub fn mouse(flags: MOUSE_EVENT_FLAGS, dx: i32, dy: i32, data: u32) -> INPUT {
    INPUT {
        r#type: INPUT_MOUSE,
        Anonymous: INPUT_0 {
            mi: MOUSEINPUT {
                dx,
                dy,
                mouseData: data,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub fn keyboard(vk: u16, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
    INPUT {
        r#type: INPUT_KEYBOARD,
        Anonymous: INPUT_0 {
            ki: KEYBDINPUT {
                wVk: vk,
                wScan: scan,
                dwFlags: flags,
                time: 0,
                dwExtraInfo: 0,
            },
        },
    }
}

pub fn scan_code(vk: u16) -> u16 {
    // SAFETY: plain call.
    unsafe { MapVirtualKeyW(vk.into(), MAPVK_VK_TO_VSC) as u16 }
}

/// A virtual key with its scan code, flagged extended where it must be.
pub fn virtual_key(vk: u16, up: bool) -> INPUT {
    let mut flags = if up { KEYEVENTF_KEYUP } else { 0 };
    if extended(vk) {
        flags |= KEYEVENTF_EXTENDEDKEY;
    }
    keyboard(vk, scan_code(vk), flags)
}

pub fn unicode(unit: u16, up: bool) -> INPUT {
    keyboard(
        0,
        unit,
        KEYEVENTF_UNICODE | if up { KEYEVENTF_KEYUP } else { 0 },
    )
}

pub fn send(inputs: &[INPUT]) -> Result<(), String> {
    // SAFETY: `inputs` is a valid slice of initialized INPUT structs.
    let sent = unsafe {
        SendInput(
            inputs.len() as u32,
            inputs.as_ptr(),
            size_of::<INPUT>() as i32,
        )
    };
    if sent as usize == inputs.len() {
        return Ok(());
    }
    Err(format!(
        "Windows blocked the input (error {}). Input cannot reach the lock screen or a UAC prompt, and no input works while a window of an elevated app has focus.",
        last_error()
    ))
}

/// For releases and other input that may be refused without consequence.
pub fn try_send(inputs: &[INPUT]) {
    let _ = send(inputs);
}

/// Moves the pointer to a physical pixel of the primary monitor.
pub fn move_to(x: i32, y: i32) -> Result<(), String> {
    let (width, height) = screen_size();
    let (width, height) = (width.max(2), height.max(2));
    let nx = (f64::from(x) * 65535.0 / f64::from(width - 1)).round() as i32;
    let ny = (f64::from(y) * 65535.0 / f64::from(height - 1)).round() as i32;
    send(&[mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE, nx, ny, 0)])?;
    // Absolute input is normalized to 0..65535; this lands on the exact pixel.
    // SAFETY: plain call.
    unsafe { SetCursorPos(x, y) };
    Ok(())
}

/// Down and up flags. SendInput buttons are physical, so swapped buttons are
/// honored.
pub fn button_flags(button: MouseButton) -> (MOUSE_EVENT_FLAGS, MOUSE_EVENT_FLAGS) {
    // SAFETY: plain call.
    let swapped = unsafe { GetSystemMetrics(SM_SWAPBUTTON) } != 0;
    match button {
        MouseButton::Middle => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
        MouseButton::Left if !swapped => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        MouseButton::Right if swapped => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
        _ => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
    }
}

// MARK: Desktop

/// The desktop receiving input: `Default` for the user's desktop,
/// `Winlogon` for the lock screen and UAC, or empty when it cannot be opened.
pub fn input_desktop_name() -> String {
    // SAFETY: the desktop handle is closed before returning; the buffer
    // outlives the call and its length is passed.
    unsafe {
        let desktop = OpenInputDesktop(0, 0, DESKTOP_READOBJECTS);
        if desktop.is_null() {
            return String::new();
        }
        let mut buffer = [0u16; 256];
        let mut needed = 0u32;
        let ok = GetUserObjectInformationW(
            desktop as HANDLE,
            UOI_NAME,
            buffer.as_mut_ptr().cast(),
            size_of_val(&buffer) as u32,
            &mut needed,
        );
        CloseDesktop(desktop);
        if ok == 0 {
            return String::new();
        }
        let units = (needed as usize / 2).min(buffer.len());
        String::from_utf16_lossy(&buffer[..units])
            .trim_end_matches('\0')
            .to_string()
    }
}

// MARK: Integrity

#[derive(Clone, Copy, PartialEq, Eq)]
enum Integrity {
    Unknown,
    Denied,
    /// The integrity RID: 0x2000 medium, 0x3000 high, 0x4000 system.
    Level(u32),
}

fn integrity_of(process: HANDLE) -> Integrity {
    // SAFETY: the token handle is closed before returning; the label buffer
    // is sized by the first call and outlives every read of the SID in it.
    unsafe {
        let mut token: HANDLE = std::ptr::null_mut();
        if OpenProcessToken(process, TOKEN_QUERY, &mut token) == 0 {
            return if last_error() == ERROR_ACCESS_DENIED {
                Integrity::Denied
            } else {
                Integrity::Unknown
            };
        }
        let mut needed = 0u32;
        GetTokenInformation(
            token,
            TokenIntegrityLevel,
            std::ptr::null_mut(),
            0,
            &mut needed,
        );
        let result = if needed == 0 {
            Integrity::Unknown
        } else {
            // u64 words keep the label's pointer field aligned.
            let mut label = vec![0u64; (needed as usize).div_ceil(8)];
            if GetTokenInformation(
                token,
                TokenIntegrityLevel,
                label.as_mut_ptr().cast(),
                needed,
                &mut needed,
            ) == 0
            {
                Integrity::Unknown
            } else {
                let sid = (*label.as_ptr().cast::<TOKEN_MANDATORY_LABEL>()).Label.Sid;
                let count = *GetSidSubAuthorityCount(sid);
                if count == 0 {
                    Integrity::Unknown
                } else {
                    Integrity::Level(*GetSidSubAuthority(sid, u32::from(count) - 1))
                }
            }
        };
        CloseHandle(token);
        result
    }
}

fn own_integrity() -> Integrity {
    static OWN: OnceLock<Integrity> = OnceLock::new();
    // SAFETY: the pseudo handle needs no closing.
    *OWN.get_or_init(|| integrity_of(unsafe { GetCurrentProcess() }))
}

fn process_name(pid: u32) -> String {
    // SAFETY: the snapshot handle is closed before returning; the entry is
    // initialized with its size as the API requires.
    unsafe {
        let snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if snapshot != INVALID_HANDLE_VALUE {
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = size_of::<PROCESSENTRY32W>() as u32;
            let mut ok = Process32FirstW(snapshot, &mut entry);
            while ok != 0 {
                if entry.th32ProcessID == pid {
                    CloseHandle(snapshot);
                    let length = entry
                        .szExeFile
                        .iter()
                        .position(|unit| *unit == 0)
                        .unwrap_or(entry.szExeFile.len());
                    let name = String::from_utf16_lossy(&entry.szExeFile[..length]);
                    return match name.rsplit_once('.') {
                        Some((stem, extension)) if extension.eq_ignore_ascii_case("exe") => {
                            stem.to_string()
                        }
                        _ => name,
                    };
                }
                ok = Process32NextW(snapshot, &mut entry);
            }
            CloseHandle(snapshot);
        }
    }
    format!("process {pid}")
}

/// Windows discards all injected input, anywhere on the screen, while the
/// foreground window belongs to a process of higher integrity (UIPI), and
/// SendInput still reports success. Returns that process's name, or `None`
/// when input can reach the desktop.
pub fn elevated_foreground() -> Option<String> {
    static ELEVATED: Mutex<Option<(u32, String)>> = Mutex::new(None);
    let Integrity::Level(own) = own_integrity() else {
        return None;
    };
    // SAFETY: the process handle is closed before returning.
    let (pid, level) = unsafe {
        let window = GetForegroundWindow();
        if window.is_null() {
            return None;
        }
        let mut pid = 0u32;
        GetWindowThreadProcessId(window, &mut pid);
        if pid == 0 || pid == GetCurrentProcessId() {
            return None;
        }
        let process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        let level = if process.is_null() {
            if last_error() == ERROR_ACCESS_DENIED {
                Integrity::Denied
            } else {
                Integrity::Unknown
            }
        } else {
            let level = integrity_of(process);
            CloseHandle(process);
            level
        };
        (pid, level)
    };
    match level {
        Integrity::Unknown => return None,
        Integrity::Level(level) if level <= own => return None,
        _ => {}
    }
    let mut cached = ELEVATED
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    match &*cached {
        Some((cached_pid, name)) if *cached_pid == pid => Some(name.clone()),
        _ => {
            let name = process_name(pid);
            *cached = Some((pid, name.clone()));
            Some(name)
        }
    }
}

// MARK: Capture

/// A top-down 32-bit DIB with its own memory DC. Pixels are BGRX.
pub struct Canvas {
    dc: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
    bits: *mut u8,
    pub width: i32,
    pub height: i32,
}

impl Canvas {
    pub fn new(width: i32, height: i32) -> Result<Self, String> {
        if width <= 0 || height <= 0 {
            return Err("The capture region is empty".into());
        }
        // SAFETY: every handle created here is owned by the returned canvas
        // or released on the error paths; `bits` points into the DIB, which
        // lives as long as the canvas.
        unsafe {
            let dc = CreateCompatibleDC(std::ptr::null_mut());
            if dc.is_null() {
                return Err(format!(
                    "CreateCompatibleDC failed: {}",
                    error_message(last_error())
                ));
            }
            let mut info: BITMAPINFO = std::mem::zeroed();
            info.bmiHeader = BITMAPINFOHEADER {
                biSize: size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB,
                ..std::mem::zeroed()
            };
            let mut bits: *mut c_void = std::ptr::null_mut();
            let bitmap = CreateDIBSection(
                dc,
                &info,
                DIB_RGB_COLORS,
                &mut bits,
                std::ptr::null_mut(),
                0,
            );
            if bitmap.is_null() || bits.is_null() {
                let error = last_error();
                DeleteDC(dc);
                return Err(format!("CreateDIBSection failed: {}", error_message(error)));
            }
            let previous = SelectObject(dc, bitmap);
            Ok(Self {
                dc,
                bitmap,
                previous,
                bits: bits.cast(),
                width,
                height,
            })
        }
    }

    /// Copies the screen area at `(x, y)`. Fails on secure desktops and in
    /// minimized or disconnected Remote Desktop sessions.
    pub fn grab(&mut self, x: i32, y: i32) -> Result<(), String> {
        // SAFETY: the screen DC is released before returning; the canvas DC
        // is valid for its lifetime.
        unsafe {
            let screen = GetDC(std::ptr::null_mut());
            if screen.is_null() {
                return Err(error_message(last_error()));
            }
            let ok = BitBlt(
                self.dc,
                0,
                0,
                self.width,
                self.height,
                screen,
                x,
                y,
                SRCCOPY,
            );
            let error = last_error();
            ReleaseDC(std::ptr::null_mut(), screen);
            if ok == 0 {
                // BitBlt often fails without setting an error code.
                return Err(if error == 0 {
                    "Windows could not copy the screen".into()
                } else {
                    error_message(error)
                });
            }
        }
        Ok(())
    }

    /// The pixels, once pending GDI drawing has landed.
    pub fn bgrx(&self) -> &[u8] {
        // SAFETY: the DIB holds width * height 32-bit pixels and outlives
        // the borrow; GdiFlush completes drawing before the bits are read.
        unsafe {
            GdiFlush();
            std::slice::from_raw_parts(self.bits, self.width as usize * self.height as usize * 4)
        }
    }

    /// Draws the pointer where it is, as the screen shows it.
    pub fn draw_cursor(&mut self) {
        // SAFETY: the icon bitmaps GetIconInfo creates are deleted here.
        unsafe {
            let mut info: CURSORINFO = std::mem::zeroed();
            info.cbSize = size_of::<CURSORINFO>() as u32;
            if GetCursorInfo(&mut info) == 0
                || info.flags & CURSOR_SHOWING == 0
                || info.hCursor.is_null()
            {
                return;
            }
            let mut icon: ICONINFO = std::mem::zeroed();
            if GetIconInfo(info.hCursor, &mut icon) == 0 {
                return;
            }
            DrawIconEx(
                self.dc,
                info.ptScreenPos.x - icon.xHotspot as i32,
                info.ptScreenPos.y - icon.yHotspot as i32,
                info.hCursor,
                0,
                0,
                0,
                std::ptr::null_mut(),
                DI_NORMAL,
            );
            if !icon.hbmMask.is_null() {
                DeleteObject(icon.hbmMask);
            }
            if !icon.hbmColor.is_null() {
                DeleteObject(icon.hbmColor);
            }
        }
    }

    /// Fills `area` with `background` and centers one line of white text.
    pub fn draw_text(&mut self, area: RECT, background: (u8, u8, u8), text: &str, size: i32) {
        let text = wide(text);
        // SAFETY: the brush and font are deleted before returning, and the
        // DC's previous font is restored first.
        unsafe {
            let brush = CreateSolidBrush(rgb(background));
            FillRect(self.dc, &area, brush);
            DeleteObject(brush);
            let face = wide("Segoe UI");
            let font = CreateFontW(
                -size,
                0,
                0,
                0,
                FW_NORMAL as i32,
                0,
                0,
                0,
                0,
                0,
                0,
                u32::from(CLEARTYPE_QUALITY),
                0,
                face.as_ptr(),
            );
            let previous = SelectObject(self.dc, font);
            SetTextColor(self.dc, rgb((255, 255, 255)));
            SetBkMode(self.dc, TRANSPARENT as i32);
            let mut area = area;
            DrawTextW(
                self.dc,
                text.as_ptr(),
                -1,
                &mut area,
                DT_CENTER | DT_VCENTER | DT_SINGLELINE,
            );
            SelectObject(self.dc, previous);
            DeleteObject(font);
        }
    }
}

fn rgb((red, green, blue): (u8, u8, u8)) -> u32 {
    u32::from(red) | u32::from(green) << 8 | u32::from(blue) << 16
}

impl Drop for Canvas {
    fn drop(&mut self) {
        // SAFETY: the handles were created by `new` and are released once.
        unsafe {
            SelectObject(self.dc, self.previous);
            DeleteObject(self.bitmap);
            DeleteDC(self.dc);
        }
    }
}
