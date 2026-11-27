// Release builds have no console window on Windows. CI sets
// KLEX_DESKTOP_GUI_SUBSYSTEM so debug builds match them (see build.rs).
#![cfg_attr(
    any(not(debug_assertions), gui_subsystem),
    windows_subsystem = "windows"
)]

use std::process::ExitCode;

fn main() -> ExitCode {
    let mut args = std::env::args().skip(1);
    if args.next().as_deref() == Some(klex_desktop::DAEMON_FLAG) {
        attach_parent_console();
        return klex_machine::daemon::main(args.collect());
    }
    klex_desktop::run();
    ExitCode::SUCCESS
}

/// A GUI-subsystem process started from a terminal gets no standard handles,
/// so `klex-desktop --daemon --version` would print nothing. Redirected
/// handles, such as the pipes the app gives its daemon, are left alone.
#[cfg(windows)]
fn attach_parent_console() {
    use windows_sys::Win32::System::Console::{
        ATTACH_PARENT_PROCESS, AttachConsole, GetStdHandle, STD_OUTPUT_HANDLE,
    };
    // SAFETY: both calls take plain values and only touch this process's
    // console state.
    unsafe {
        if GetStdHandle(STD_OUTPUT_HANDLE).is_null() {
            AttachConsole(ATTACH_PARENT_PROCESS);
        }
    }
}

#[cfg(not(windows))]
fn attach_parent_console() {}
