//! Unix implementations, shared by macOS and Linux.

pub mod fs {
    use std::fs::{self, File, Metadata};
    use std::io;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    /// Node's replace path renames over the destination outside win32.
    pub const REPLACE_NEEDS_BACKUP: bool = false;

    /// `stat.mode` permission bits as Node reports them.
    pub fn mode(metadata: &Metadata) -> u32 {
        metadata.mode()
    }

    /// `fs.chmod`.
    pub fn chmod(path: &Path, mode: u32) -> io::Result<()> {
        fs::set_permissions(path, fs::Permissions::from_mode(mode & 0o7777))
    }

    /// Device and inode of a path without following a final symlink.
    pub fn identity(path: &Path) -> Option<(u64, u64)> {
        fs::symlink_metadata(path)
            .ok()
            .map(|metadata| (metadata.dev(), metadata.ino()))
    }

    /// Opens a new file for writing, failing if it exists.
    pub fn create_new_file(path: &Path, mode: u32) -> io::Result<File> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(path)
    }

    pub fn create_dir(path: &Path, mode: u32) -> io::Result<()> {
        fs::DirBuilder::new().mode(mode).create(path)
    }

    pub fn create_dir_all(path: &Path, mode: u32) -> io::Result<()> {
        fs::DirBuilder::new()
            .recursive(true)
            .mode(mode)
            .create(path)
    }

    pub fn remove_file_or_link(path: &Path, _metadata: &Metadata) -> io::Result<()> {
        fs::remove_file(path)
    }

    /// Creates `link` pointing at `target`, of the same kind as the symlink
    /// at `source`.
    pub fn symlink_like(_source: &Path, target: &Path, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    /// Total size of the volume holding `path`.
    pub fn volume_total_bytes(path: &Path) -> Option<u64> {
        use std::os::unix::ffi::OsStrExt;
        let path = std::ffi::CString::new(path.as_os_str().as_bytes()).ok()?;
        let mut volume: libc::statfs = unsafe { std::mem::zeroed() };
        // SAFETY: `path` is NUL-terminated and `volume` is writable.
        if unsafe { libc::statfs(path.as_ptr(), &mut volume) } != 0 {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        (volume.f_bsize as u64).checked_mul(volume.f_blocks as u64)
    }

    /// The Node error code for an OS error.
    pub fn error_code(error: &io::Error) -> Option<&'static str> {
        Some(match error.raw_os_error()? {
            libc::EACCES => "EACCES",
            libc::EBUSY => "EBUSY",
            libc::EEXIST => "EEXIST",
            libc::EINVAL => "EINVAL",
            libc::EIO => "EIO",
            libc::EISDIR => "EISDIR",
            libc::ELOOP => "ELOOP",
            libc::EMFILE => "EMFILE",
            libc::ENAMETOOLONG => "ENAMETOOLONG",
            libc::ENOENT => "ENOENT",
            libc::ENOSPC => "ENOSPC",
            libc::ENOTDIR => "ENOTDIR",
            libc::ENOTEMPTY => "ENOTEMPTY",
            libc::EPERM => "EPERM",
            libc::EROFS => "EROFS",
            libc::EXDEV => "EXDEV",
            libc::ETXTBSY => "ETXTBSY",
            libc::EFBIG => "EFBIG",
            _ => return None,
        })
    }
}

pub mod host {
    use crate::device_type::DeviceType;

    /// Node's `process.platform`.
    pub const PLATFORM: &str = if cfg!(target_os = "macos") {
        "darwin"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else if cfg!(target_os = "freebsd") {
        "freebsd"
    } else {
        "unknown"
    };

    /// `os.homedir()`.
    pub fn home_dir() -> Option<std::path::PathBuf> {
        std::env::var_os("HOME")
            .filter(|value| !value.is_empty())
            .map(Into::into)
    }

    /// `os.hostname()`.
    pub fn hostname() -> String {
        dns_hostname().unwrap_or_default()
    }

    /// The hostname reported in machine facts.
    pub fn dns_hostname() -> Option<String> {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is valid for its length and NUL-terminated on success.
        if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0 {
            return None;
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
    }

    /// `os.release()`.
    pub fn kernel_release() -> Option<String> {
        let mut name: libc::utsname = unsafe { std::mem::zeroed() };
        // SAFETY: `name` is a valid, writable utsname.
        if unsafe { libc::uname(&mut name) } != 0 {
            return None;
        }
        // SAFETY: uname NUL-terminates each field.
        let release = unsafe { std::ffi::CStr::from_ptr(name.release.as_ptr()) };
        Some(release.to_string_lossy().into_owned())
    }

    #[cfg(target_os = "linux")]
    pub use super::super::linux::{cpu_model, total_memory};
    #[cfg(target_os = "macos")]
    pub use super::super::macos::{cpu_model, total_memory};

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub fn cpu_model() -> Option<String> {
        None
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub fn total_memory() -> Option<u64> {
        None
    }

    #[cfg(target_os = "linux")]
    pub async fn detect_device_type() -> Option<DeviceType> {
        super::super::linux::detect_device_type().await
    }

    #[cfg(target_os = "macos")]
    pub async fn detect_device_type() -> Option<DeviceType> {
        super::super::macos::detect_device_type().await
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub async fn detect_device_type() -> Option<DeviceType> {
        None
    }
}

pub mod path {
    /// Whether absolute paths start with a drive letter instead of `/`.
    pub const DRIVE_ROOTS: bool = false;
}

pub mod process {
    use std::io;
    use std::os::unix::process::ExitStatusExt;
    use std::time::Duration;

    use tokio::process::Command;

    /// `process.kill(pid, 0)` succeeding or failing with EPERM.
    pub fn process_alive(pid: u32) -> bool {
        if pid == std::process::id() {
            return true;
        }
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: signal 0 only checks for existence and permission.
        let result = unsafe { libc::kill(pid, 0) };
        result == 0 || io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }

    /// `child_process.spawn(command, { shell: true, detached: true })`.
    pub fn shell_command(script: &str) -> (String, Command) {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        // SAFETY: setsid is async-signal-safe; Node's `detached` does the same.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        ("/bin/sh".into(), command)
    }

    /// Ends a detached command and its descendants: SIGTERM to the process
    /// group, then SIGKILL after five seconds. Groups that already exited are
    /// ignored.
    pub fn terminate_tree(pid: u32) -> io::Result<()> {
        if !kill_group(pid, libc::SIGTERM) {
            return Ok(());
        }
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(5)).await;
            kill_group(pid, libc::SIGKILL);
        });
        Ok(())
    }

    /// Node's `code` and `signal` for an exited child.
    pub fn exit_details(status: std::process::ExitStatus) -> (Option<i32>, Option<String>) {
        (status.code(), status.signal().map(signal_name))
    }

    fn kill_group(pid: u32, signal: i32) -> bool {
        let Ok(pid) = libc::pid_t::try_from(pid) else {
            return false;
        };
        // SAFETY: a negative pid addresses the process group led by `pid`.
        unsafe { libc::kill(-pid, signal) == 0 }
    }

    /// Node's signal names, e.g. `SIGTERM`.
    fn signal_name(signal: i32) -> String {
        let names: &[(i32, &str)] = &[
            (libc::SIGHUP, "SIGHUP"),
            (libc::SIGINT, "SIGINT"),
            (libc::SIGQUIT, "SIGQUIT"),
            (libc::SIGILL, "SIGILL"),
            (libc::SIGTRAP, "SIGTRAP"),
            (libc::SIGABRT, "SIGABRT"),
            (libc::SIGBUS, "SIGBUS"),
            (libc::SIGFPE, "SIGFPE"),
            (libc::SIGKILL, "SIGKILL"),
            (libc::SIGUSR1, "SIGUSR1"),
            (libc::SIGSEGV, "SIGSEGV"),
            (libc::SIGUSR2, "SIGUSR2"),
            (libc::SIGPIPE, "SIGPIPE"),
            (libc::SIGALRM, "SIGALRM"),
            (libc::SIGTERM, "SIGTERM"),
            (libc::SIGCHLD, "SIGCHLD"),
            (libc::SIGCONT, "SIGCONT"),
            (libc::SIGSTOP, "SIGSTOP"),
            (libc::SIGTSTP, "SIGTSTP"),
            (libc::SIGTTIN, "SIGTTIN"),
            (libc::SIGTTOU, "SIGTTOU"),
            (libc::SIGURG, "SIGURG"),
            (libc::SIGXCPU, "SIGXCPU"),
            (libc::SIGXFSZ, "SIGXFSZ"),
            (libc::SIGVTALRM, "SIGVTALRM"),
            (libc::SIGPROF, "SIGPROF"),
            (libc::SIGWINCH, "SIGWINCH"),
            (libc::SIGIO, "SIGIO"),
            (libc::SIGSYS, "SIGSYS"),
        ];
        names
            .iter()
            .find(|(number, _)| *number == signal)
            .map(|(_, name)| (*name).to_string())
            .unwrap_or_else(|| format!("SIG{signal}"))
    }
}

pub mod pty {
    use std::ffi::CString;
    use std::io::{self, Write};
    use std::path::{Path, PathBuf};
    use std::sync::Mutex;
    use std::time::Duration;

    use indexmap::IndexMap;
    use portable_pty::{CommandBuilder, MasterPty, PtySize, native_pty_system};

    use crate::platform::pty::{Child, Pty, SpawnOptions, Spawned};

    /// node-pty waits this long for the PTY to drain after the child exits.
    pub const EXIT_DRAIN: Duration = Duration::from_millis(200);

    pub fn default_shell() -> String {
        std::env::var("SHELL").unwrap_or_else(|_| "/bin/sh".into())
    }

    pub fn default_shell_args() -> Vec<String> {
        vec!["-i".into()]
    }

    pub fn spawn(options: &SpawnOptions<'_>) -> Result<Spawned, String> {
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: options.rows,
                cols: options.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("{error:#}"))?;
        let exec_failure = exec_failure(options.shell, options.env);
        let mut command = match exec_failure {
            Some(_) => {
                let mut command = CommandBuilder::new("/bin/sh");
                command.args(["-c", "exit 1"]);
                command
            }
            None => {
                let mut command = CommandBuilder::new(options.shell);
                command.args(options.args);
                command
            }
        };
        command.cwd(options.cwd);
        if let Some(env) = options.env {
            for (key, value) in env {
                command.env(key, value);
            }
        }
        command.env("TERM", "xterm-256color");
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("{error:#}"))?;
        drop(pair.slave);
        let output = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("{error:#}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("{error:#}"))?;
        let pid = child.process_id().unwrap_or_default();
        Ok(Spawned {
            pid,
            pty: Box::new(UnixPty {
                pid,
                writer: Mutex::new(writer),
                master: Mutex::new(pair.master),
            }),
            output,
            child: Box::new(UnixChild { child }),
            exec_failure,
        })
    }

    struct UnixPty {
        pid: u32,
        writer: Mutex<Box<dyn Write + Send>>,
        master: Mutex<Box<dyn MasterPty + Send>>,
    }

    impl Pty for UnixPty {
        fn write(&self, data: &[u8]) -> io::Result<()> {
            let mut writer = lock(&self.writer);
            writer.write_all(data).and_then(|()| writer.flush())
        }

        fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
            lock(&self.master)
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|error| format!("{error:#}"))
        }

        /// node-pty sends SIGHUP to the shell process only.
        fn hangup(&self) {
            if let Ok(pid) = libc::pid_t::try_from(self.pid) {
                // SAFETY: plain signal delivery to the child's pid.
                unsafe { libc::kill(pid, libc::SIGHUP) };
            }
        }
    }

    struct UnixChild {
        child: Box<dyn portable_pty::Child + Send + Sync>,
    }

    impl Child for UnixChild {
        fn wait(&mut self) -> (Option<i64>, Option<i64>) {
            let pid = self.child.process_id().unwrap_or_default() as libc::pid_t;
            let mut status = 0;
            loop {
                // SAFETY: waits for our own child; the status pointer is valid.
                let result = unsafe { libc::waitpid(pid, &mut status, 0) };
                if result == -1 && io::Error::last_os_error().kind() == io::ErrorKind::Interrupted {
                    continue;
                }
                break;
            }
            let exit_code = if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else {
                0
            };
            let signal = if libc::WIFSIGNALED(status) {
                libc::WTERMSIG(status)
            } else {
                0
            };
            (Some(i64::from(exit_code)), Some(i64::from(signal)))
        }
    }

    fn lock<T: ?Sized>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The strerror text execvp(3) would fail with for `shell`, if any.
    fn exec_failure(shell: &str, env: Option<&IndexMap<String, String>>) -> Option<&'static str> {
        const ENOENT: &str = "No such file or directory";
        const EACCES: &str = "Permission denied";
        let check = |path: &Path| -> Result<(), &'static str> {
            let metadata = std::fs::metadata(path).map_err(|_| ENOENT)?;
            if metadata.is_dir() {
                return Err(EACCES);
            }
            let path = CString::new(path.as_os_str().as_encoded_bytes()).map_err(|_| ENOENT)?;
            // SAFETY: `path` is a valid NUL-terminated string for the call's duration.
            if unsafe { libc::access(path.as_ptr(), libc::X_OK) } == 0 {
                Ok(())
            } else {
                Err(EACCES)
            }
        };
        if shell.is_empty() {
            return Some(ENOENT);
        }
        if shell.contains('/') {
            return check(Path::new(shell)).err();
        }
        let search = env
            .and_then(|env| env.get("PATH").cloned())
            .or_else(|| std::env::var("PATH").ok())
            .unwrap_or_else(|| "/bin:/usr/bin".into());
        let mut failure = ENOENT;
        for directory in search.split(':') {
            let directory = if directory.is_empty() { "." } else { directory };
            match check(&PathBuf::from(directory).join(shell)) {
                Ok(()) => return None,
                Err(EACCES) => failure = EACCES,
                Err(_) => {}
            }
        }
        Some(failure)
    }
}

pub mod signals {
    use tokio::signal::unix::{SignalKind, signal};

    /// Waits for SIGINT or SIGTERM and returns its name.
    pub async fn shutdown() -> &'static str {
        let (Ok(mut interrupt), Ok(mut terminate)) = (
            signal(SignalKind::interrupt()),
            signal(SignalKind::terminate()),
        ) else {
            return std::future::pending().await;
        };
        tokio::select! {
            _ = interrupt.recv() => "SIGINT",
            _ = terminate.recv() => "SIGTERM",
        }
    }

    /// Node's default action once no listener remains: die by the signal.
    pub fn terminate_by(signal: &str) -> ! {
        let number = if signal == "SIGTERM" {
            libc::SIGTERM
        } else {
            libc::SIGINT
        };
        // SAFETY: restoring the default disposition and signalling ourselves
        // touches no Rust-managed state.
        unsafe {
            libc::signal(number, libc::SIG_DFL);
            libc::kill(libc::getpid(), number);
        }
        std::process::exit(128 + number)
    }
}
