//! Every OS-specific API the server uses. Code outside this module stays
//! portable; `tests/platform_boundary.rs` rejects OS `cfg`s, `libc`,
//! `windows_sys`, `std::os` and `portable_pty` anywhere else in `src/`.
//!
//! `unix.rs` and `windows.rs` provide the same modules with the same
//! signatures; `macos.rs` and `linux.rs` hold what differs between Unixes.

pub mod desktop;
pub mod pty;

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "macos")]
mod macos;
#[cfg(unix)]
mod unix;
#[cfg(windows)]
mod windows;

#[cfg(unix)]
use unix as os;
#[cfg(windows)]
use windows as os;

pub use os::{fs, host, path, process, signals};

/// Runs a short hardware probe, returning trimmed stdout on success.
#[cfg_attr(
    not(any(target_os = "macos", target_os = "linux", windows)),
    allow(dead_code)
)]
async fn probe(file: &str, args: &[&str]) -> Option<String> {
    let mut command = tokio::process::Command::new(file);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(std::time::Duration::from_millis(900), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}
