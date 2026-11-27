//! Starting apps: bundles through Launch Services, anything else as a
//! detached process.

use std::os::unix::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

use block2::RcBlock;
use objc2_app_kit::{NSRunningApplication, NSWorkspace, NSWorkspaceOpenConfiguration};
use objc2_foundation::{NSArray, NSError, NSString, NSURL};

use crate::desktop::provider::LaunchOptions;

/// How long Launch Services may take to start an app.
pub const OPEN_TIMEOUT: Duration = Duration::from_secs(30);

pub fn is_bundle(command: &str) -> bool {
    let trimmed = command.strip_suffix('/').unwrap_or(command);
    let bytes = trimmed.as_bytes();
    bytes.len() >= 4 && bytes[bytes.len() - 4..].eq_ignore_ascii_case(b".app")
}

/// Spawns in its own session, like Node's `detached: true`, and reaps the
/// child when it exits.
pub fn spawn(options: &LaunchOptions) -> Result<u32, String> {
    let mut command = Command::new(&options.command);
    command
        .args(&options.args)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    if let Some(cwd) = &options.cwd {
        command.current_dir(cwd);
    }
    // SAFETY: setsid is async-signal-safe.
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| format!("spawn {} failed: {error}", options.command))?;
    let pid = child.id();
    let _ = std::thread::Builder::new()
        .name("klex-launch-reaper".into())
        .spawn(move || {
            let _ = child.wait();
        });
    Ok(pid)
}

/// `target` is a bundle path or a bundle name such as `Safari.app`, found
/// in the standard application folders.
fn application_url(target: &str) -> Option<objc2::rc::Retained<NSURL>> {
    if target.contains('/') {
        return Path::new(target)
            .exists()
            .then(|| NSURL::fileURLWithPath(&NSString::from_str(target)));
    }
    let home = std::env::var("HOME").unwrap_or_default();
    let directories = [
        "/Applications".to_string(),
        "/Applications/Utilities".into(),
        "/System/Applications".into(),
        "/System/Applications/Utilities".into(),
        format!("{home}/Applications"),
    ];
    for directory in directories {
        let path = format!("{directory}/{target}");
        if Path::new(&path).exists() {
            return Some(NSURL::fileURLWithPath(&NSString::from_str(&path)));
        }
    }
    None
}

/// Opens an app bundle and returns its PID. Blocking.
pub fn open_application(target: &str, arguments: &[String]) -> Result<u32, String> {
    let url = application_url(target).ok_or_else(|| format!("No application named {target}"))?;
    let configuration = NSWorkspaceOpenConfiguration::configuration();
    let arguments: Vec<_> = arguments
        .iter()
        .map(|argument| NSString::from_str(argument))
        .collect();
    configuration.setArguments(&NSArray::from_retained_slice(&arguments));
    configuration.setActivates(true);
    let (sender, receiver) = mpsc::channel::<Result<i32, String>>();
    let handler = RcBlock::new(move |app: *mut NSRunningApplication, error: *mut NSError| {
        // SAFETY: the pointers are valid for the duration of the callback.
        let result = match (unsafe { app.as_ref() }, unsafe { error.as_ref() }) {
            (_, Some(error)) => Err(error.localizedDescription().to_string()),
            (Some(app), None) => Ok(app.processIdentifier()),
            (None, None) => Ok(0),
        };
        let _ = sender.send(result);
    });
    NSWorkspace::sharedWorkspace().openApplicationAtURL_configuration_completionHandler(
        &url,
        &configuration,
        Some(&handler),
    );
    let pid = match receiver.recv_timeout(OPEN_TIMEOUT) {
        Ok(result) => result?,
        Err(_) => return Err(format!("Timed out opening {target}")),
    };
    if pid <= 0 {
        return Err(format!("{target} opened without a process id"));
    }
    Ok(pid as u32)
}
