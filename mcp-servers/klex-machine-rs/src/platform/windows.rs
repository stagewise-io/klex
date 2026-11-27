//! Windows implementations.

pub mod fs {
    use std::fs::{self, File, Metadata};
    use std::io;
    use std::os::windows::fs::FileTypeExt;
    use std::path::Path;

    /// Node's replace path backs up the destination on win32 instead of
    /// renaming over it.
    pub const REPLACE_NEEDS_BACKUP: bool = true;

    /// `stat.mode` as Node synthesizes it from the read-only attribute.
    pub fn mode(metadata: &Metadata) -> u32 {
        let base = if metadata.permissions().readonly() {
            0o444
        } else {
            0o666
        };
        if metadata.is_dir() {
            base | 0o111
        } else {
            base
        }
    }

    /// `fs.chmod`. Only the owner-write bit maps to read-only.
    pub fn chmod(path: &Path, mode: u32) -> io::Result<()> {
        let mut permissions = fs::metadata(path)?.permissions();
        permissions.set_readonly(mode & 0o200 == 0);
        fs::set_permissions(path, permissions)
    }

    /// Volume serial and file index of a path without following a final
    /// symlink.
    pub fn identity(path: &Path) -> Option<(u64, u64)> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
        use windows_sys::Win32::Storage::FileSystem::{
            BY_HANDLE_FILE_INFORMATION, CreateFileW, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
            GetFileInformationByHandle, OPEN_EXISTING,
        };
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        // SAFETY: `wide` is NUL-terminated and outlives the call; the handle is
        // closed before returning.
        unsafe {
            let handle = CreateFileW(
                wide.as_ptr(),
                0,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                std::ptr::null(),
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                std::ptr::null_mut(),
            );
            if handle == INVALID_HANDLE_VALUE {
                return None;
            }
            let mut info: BY_HANDLE_FILE_INFORMATION = std::mem::zeroed();
            let ok = GetFileInformationByHandle(handle, &mut info);
            CloseHandle(handle);
            if ok == 0 {
                return None;
            }
            Some((
                u64::from(info.dwVolumeSerialNumber),
                (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow),
            ))
        }
    }

    /// Opens a new file for writing, failing if it exists. Windows has no
    /// mode bits, so `mode` is ignored.
    pub fn create_new_file(path: &Path, _mode: u32) -> io::Result<File> {
        fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
    }

    pub fn create_dir(path: &Path, _mode: u32) -> io::Result<()> {
        fs::DirBuilder::new().create(path)
    }

    pub fn create_dir_all(path: &Path, _mode: u32) -> io::Result<()> {
        fs::DirBuilder::new().recursive(true).create(path)
    }

    /// Directory symlinks must be removed as directories.
    pub fn remove_file_or_link(path: &Path, metadata: &Metadata) -> io::Result<()> {
        if metadata.file_type().is_symlink_dir() {
            fs::remove_dir(path)
        } else {
            fs::remove_file(path)
        }
    }

    /// Creates `link` pointing at `target`, of the same kind as the symlink
    /// at `source`.
    pub fn symlink_like(source: &Path, target: &Path, link: &Path) -> io::Result<()> {
        use std::os::windows::fs::{symlink_dir, symlink_file};
        let directory = fs::symlink_metadata(source)
            .map(|metadata| metadata.file_type().is_symlink_dir())
            .unwrap_or(false);
        if directory {
            symlink_dir(target, link)
        } else {
            symlink_file(target, link)
        }
    }

    /// Total size of the volume holding `path`.
    pub fn volume_total_bytes(path: &Path) -> Option<u64> {
        use std::os::windows::ffi::OsStrExt;
        use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
        let path: Vec<u16> = path
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect();
        let mut total = 0u64;
        // SAFETY: `path` is NUL-terminated; unused outputs may be null.
        let ok = unsafe {
            GetDiskFreeSpaceExW(
                path.as_ptr(),
                std::ptr::null_mut(),
                &mut total,
                std::ptr::null_mut(),
            )
        };
        (ok != 0).then_some(total)
    }

    /// The Node error code for an OS error, as libuv's
    /// `uv_translate_sys_error` maps the codes filesystem calls produce.
    pub fn error_code(error: &io::Error) -> Option<&'static str> {
        Some(match error.raw_os_error()? {
            2 | 3 | 15 | 53 | 67 | 123 | 161 | 1392 => "ENOENT",
            5 | 19 | 1314 => "EPERM",
            17 => "EXDEV",
            32 | 33 | 170 => "EBUSY",
            80 | 183 => "EEXIST",
            87 => "EINVAL",
            112 | 39 => "ENOSPC",
            145 => "ENOTEMPTY",
            206 => "ENAMETOOLONG",
            267 => "ENOTDIR",
            1921 => "ELOOP",
            4 => "EMFILE",
            _ => return None,
        })
    }
}

pub mod host {
    use serde_json::Value;

    use crate::device_type::{DeviceType, chassis_type, virtual_model};

    /// Node's `process.platform`.
    pub const PLATFORM: &str = "win32";

    /// `os.homedir()`.
    pub fn home_dir() -> Option<std::path::PathBuf> {
        std::env::var_os("USERPROFILE")
            .filter(|value| !value.is_empty())
            .map(Into::into)
    }

    /// `os.hostname()`.
    /// `os.hostname()`: libuv asks Winsock, which answers with the DNS name.
    pub fn hostname() -> String {
        dns_hostname().unwrap_or_default()
    }

    /// The hostname reported in machine facts.
    pub fn dns_hostname() -> Option<String> {
        use windows_sys::Win32::System::SystemInformation::{
            ComputerNameDnsHostname, GetComputerNameExW,
        };
        let mut buffer = [0u16; 256];
        let mut size = buffer.len() as u32;
        // SAFETY: the buffer is writable for `size` characters.
        if unsafe { GetComputerNameExW(ComputerNameDnsHostname, buffer.as_mut_ptr(), &mut size) }
            == 0
        {
            return None;
        }
        Some(String::from_utf16_lossy(&buffer[..size as usize]))
    }

    const CURRENT_VERSION: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    /// `os.release()`.
    pub fn kernel_release() -> Option<String> {
        let major = registry_dword(CURRENT_VERSION, "CurrentMajorVersionNumber")?;
        let minor = registry_dword(CURRENT_VERSION, "CurrentMinorVersionNumber")?;
        let build = registry_string(CURRENT_VERSION, "CurrentBuildNumber")?;
        Some(format!("{major}.{minor}.{build}"))
    }

    pub fn cpu_model() -> Option<String> {
        registry_string(
            r"HARDWARE\DESCRIPTION\System\CentralProcessor\0",
            "ProcessorNameString",
        )
    }

    pub fn total_memory() -> Option<u64> {
        use windows_sys::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: `status` is writable and its length is set.
        (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.ullTotalPhys)
    }

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn registry_string(key: &str, value: &str) -> Option<String> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{
            HKEY_LOCAL_MACHINE, RRF_RT_REG_SZ, RegGetValueW,
        };
        let (key, value) = (wide(key), wide(value));
        let mut buffer = [0u16; 512];
        let mut size = (buffer.len() * 2) as u32;
        // SAFETY: the key and value names are NUL-terminated and the buffer
        // is writable for `size` bytes.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_SZ,
                std::ptr::null_mut(),
                buffer.as_mut_ptr().cast(),
                &mut size,
            )
        };
        if status != ERROR_SUCCESS {
            return None;
        }
        let units = (size as usize / 2).min(buffer.len());
        let end = buffer[..units]
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(units);
        Some(String::from_utf16_lossy(&buffer[..end]))
    }

    fn registry_dword(key: &str, value: &str) -> Option<u32> {
        use windows_sys::Win32::Foundation::ERROR_SUCCESS;
        use windows_sys::Win32::System::Registry::{
            HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RegGetValueW,
        };
        let (key, value) = (wide(key), wide(value));
        let mut data = 0u32;
        let mut size = 4u32;
        // SAFETY: as above, with a four-byte buffer.
        let status = unsafe {
            RegGetValueW(
                HKEY_LOCAL_MACHINE,
                key.as_ptr(),
                value.as_ptr(),
                RRF_RT_REG_DWORD,
                std::ptr::null_mut(),
                (&mut data as *mut u32).cast(),
                &mut size,
            )
        };
        (status == ERROR_SUCCESS).then_some(data)
    }

    pub async fn detect_device_type() -> Option<DeviceType> {
        let output = super::super::probe(
            "powershell.exe",
            &[
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                "$s = Get-CimInstance Win32_ComputerSystem; $c = Get-CimInstance Win32_SystemEnclosure; @{model=$s.Model; chassis=@($c.ChassisTypes)} | ConvertTo-Json -Compress",
            ],
        )
        .await?;
        let parsed: Value = serde_json::from_str(&output).ok()?;
        let model = parsed.get("model")?.as_str()?;
        let chassis = parsed.get("chassis")?.as_array()?;
        if virtual_model(model) {
            return Some(DeviceType::Vm);
        }
        chassis
            .iter()
            .filter_map(Value::as_i64)
            .find_map(chassis_type)
    }
}

pub mod path {
    /// Whether absolute paths start with a drive letter instead of `/`.
    pub const DRIVE_ROOTS: bool = true;
}

pub mod process {
    use std::io;
    use std::process::Stdio;

    use tokio::process::Command;

    /// `process.kill(pid, 0)` succeeding or failing with EPERM.
    pub fn process_alive(pid: u32) -> bool {
        use windows_sys::Win32::Foundation::{
            CloseHandle, ERROR_ACCESS_DENIED, GetLastError, STILL_ACTIVE,
        };
        use windows_sys::Win32::System::Threading::{
            GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
        };
        if pid == std::process::id() {
            return true;
        }
        // SAFETY: the handle is checked and closed before returning.
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if handle.is_null() {
                return GetLastError() == ERROR_ACCESS_DENIED;
            }
            let mut code = 0u32;
            let ok = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            ok != 0 && code == STILL_ACTIVE as u32
        }
    }

    /// `child_process.spawn(command, { shell: true, detached: true })`.
    pub fn shell_command(script: &str) -> (String, Command) {
        let file = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let mut command = Command::new(&file);
        command.raw_arg(format!("/d /s /c \"{script}\""));
        (file, command)
    }

    /// Ends a detached command and its descendants with `taskkill /T /F`.
    pub fn terminate_tree(pid: u32) -> io::Result<()> {
        let mut child = std::process::Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()?;
        std::thread::spawn(move || child.wait());
        Ok(())
    }

    /// Node's `code` and `signal` for an exited child.
    pub fn exit_details(status: std::process::ExitStatus) -> (Option<i32>, Option<String>) {
        (status.code(), None)
    }
}

pub mod pty {
    use std::io::{self, Read, Write};
    use std::path::Path;
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use portable_pty::{ChildKiller, CommandBuilder, MasterPty, PtySize, native_pty_system};

    use crate::platform::pty::{Child, CursorQuery, Pty, SpawnOptions, Spawned};

    /// node-pty waits this long for the PTY to drain after the child exits.
    pub const EXIT_DRAIN: Duration = Duration::from_millis(1000);

    pub fn default_shell() -> String {
        std::env::var("ComSpec").unwrap_or_else(|_| "powershell.exe".into())
    }

    pub fn default_shell_args() -> Vec<String> {
        Vec::new()
    }

    fn file_exists(path: &Path) -> bool {
        std::fs::metadata(path).is_ok_and(|metadata| !metadata.is_dir())
    }

    /// node-pty's winpty shell lookup, quirks included: a relative name that
    /// exists in the process directory resolves to nothing, and the `Path`
    /// entry after the last `;` is never searched.
    fn shell_path(
        shell: &str,
        path_var: Option<&str>,
        exists: impl Fn(&Path) -> bool,
    ) -> Result<String, String> {
        let bytes = shell.as_bytes();
        let relative = !(shell.starts_with('\\')
            || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'));
        let resolved = if !relative {
            shell.to_string()
        } else if exists(Path::new(shell)) {
            String::new()
        } else {
            let mut entries: Vec<&str> = path_var.unwrap_or_default().split(';').collect();
            entries.pop();
            entries
                .into_iter()
                .map(|entry| Path::new(entry).join(shell))
                .find(|candidate| exists(candidate))
                .map(|candidate| candidate.to_string_lossy().into_owned())
                .unwrap_or_default()
        };
        if resolved.is_empty() || !exists(Path::new(&resolved)) {
            return Err(format!("File not found: {resolved}"));
        }
        Ok(resolved)
    }

    pub fn spawn(options: &SpawnOptions<'_>) -> Result<Spawned, String> {
        let shell = shell_path(
            options.shell,
            std::env::var("Path").ok().as_deref(),
            file_exists,
        )?;
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: options.rows,
                cols: options.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("{error:#}"))?;
        let mut command = CommandBuilder::new(shell);
        command.args(options.args);
        command.cwd(options.cwd);
        if let Some(env) = options.env {
            for (key, value) in env {
                command.env(key, value);
            }
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("{error:#}"))?;
        drop(pair.slave);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("{error:#}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("{error:#}"))?;
        let console = Arc::new(Console {
            writer: Mutex::new(Some(writer)),
            master: Mutex::new(Some(pair.master)),
        });
        Ok(Spawned {
            pid: child.process_id().unwrap_or_default(),
            pty: Box::new(ConPty {
                console: console.clone(),
                killer: Mutex::new(child.clone_killer()),
            }),
            output: Box::new(Output {
                reader,
                console: console.clone(),
                query: CursorQuery::default(),
                chunk: vec![0u8; 64 * 1024],
                pending: Vec::new(),
                offset: 0,
                done: false,
            }),
            child: Box::new(ConPtyChild { child, console }),
            exec_failure: None,
        })
    }

    /// Both halves are dropped when the shell exits.
    struct Console {
        writer: Mutex<Option<Box<dyn Write + Send>>>,
        master: Mutex<Option<Box<dyn MasterPty + Send>>>,
    }

    impl Console {
        fn write(&self, data: &[u8]) -> io::Result<()> {
            match lock(&self.writer).as_mut() {
                Some(writer) => writer.write_all(data).and_then(|()| writer.flush()),
                None => Ok(()),
            }
        }
    }

    struct ConPty {
        console: Arc<Console>,
        killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    }

    impl Pty for ConPty {
        fn write(&self, data: &[u8]) -> io::Result<()> {
            self.console.write(data)
        }

        fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
            match lock(&self.console.master).as_ref() {
                Some(master) => master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|error| format!("{error:#}")),
                None => Ok(()),
            }
        }

        fn hangup(&self) {
            let _ = lock(&self.killer).kill();
        }
    }

    struct ConPtyChild {
        child: Box<dyn portable_pty::Child + Send + Sync>,
        console: Arc<Console>,
    }

    impl Child for ConPtyChild {
        fn wait(&mut self) -> (Option<i64>, Option<i64>) {
            let code = self
                .child
                .wait()
                .map(|status| i64::from(status.exit_code()))
                .ok();
            // ConPTY only flushes and closes its output pipe when released.
            drop(lock(&self.console.writer).take());
            drop(lock(&self.console.master).take());
            (code, None)
        }
    }

    /// ConPTY output with the cursor query answered and removed.
    struct Output {
        reader: Box<dyn Read + Send>,
        console: Arc<Console>,
        query: CursorQuery,
        chunk: Vec<u8>,
        pending: Vec<u8>,
        offset: usize,
        done: bool,
    }

    impl Read for Output {
        fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
            loop {
                if self.offset < self.pending.len() {
                    let count = buffer.len().min(self.pending.len() - self.offset);
                    buffer[..count]
                        .copy_from_slice(&self.pending[self.offset..self.offset + count]);
                    self.offset += count;
                    return Ok(count);
                }
                if self.done {
                    return Ok(0);
                }
                self.pending = match self.reader.read(&mut self.chunk) {
                    Ok(0) => {
                        self.done = true;
                        self.query.end()
                    }
                    Ok(count) => {
                        let (kept, asked) = self.query.filter(&self.chunk[..count]);
                        if asked {
                            let _ = self.console.write(b"\x1b[1;1R");
                        }
                        kept
                    }
                    Err(error) if error.kind() == io::ErrorKind::Interrupted => {
                        return Err(error);
                    }
                    Err(_) => {
                        self.done = true;
                        self.query.end()
                    }
                };
                self.offset = 0;
            }
        }
    }

    fn lock<T: ?Sized>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
        mutex
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    #[cfg(test)]
    mod tests {
        use std::path::Path;

        use super::shell_path;

        #[test]
        fn resolves_shells_like_node_pty() {
            let exists = |path: &Path| {
                matches!(
                    path.to_str(),
                    Some("C:\\Windows\\cmd.exe" | "C:\\Tools\\pwsh.exe" | "here.exe")
                )
            };
            let path_var = Some("C:\\Windows;C:\\Tools");
            assert_eq!(
                shell_path("C:\\Windows\\cmd.exe", path_var, exists),
                Ok("C:\\Windows\\cmd.exe".into())
            );
            assert_eq!(
                shell_path("C:\\missing\\shell.exe", path_var, exists),
                Err("File not found: C:\\missing\\shell.exe".into())
            );
            assert_eq!(
                shell_path("cmd.exe", path_var, exists),
                Ok("C:\\Windows\\cmd.exe".into())
            );
            assert_eq!(
                shell_path("pwsh.exe", path_var, exists),
                Err("File not found: ".into())
            );
            assert_eq!(
                shell_path("pwsh.exe", Some("C:\\Windows;C:\\Tools;"), exists),
                Ok("C:\\Tools\\pwsh.exe".into())
            );
            assert_eq!(
                shell_path("here.exe", path_var, exists),
                Err("File not found: ".into())
            );
        }
    }
}

pub mod signals {
    /// Waits for Ctrl+C and reports it as SIGINT, like Node. The handler is
    /// installed by this call, before the future is first polled.
    pub fn shutdown() -> impl Future<Output = &'static str> + Send + 'static {
        let ctrl_c = tokio::signal::windows::ctrl_c();
        async move {
            let Ok(mut ctrl_c) = ctrl_c else {
                return std::future::pending().await;
            };
            if ctrl_c.recv().await.is_none() {
                return std::future::pending().await;
            }
            "SIGINT"
        }
    }

    /// The default Ctrl+C action Node falls back to once no listener remains.
    pub fn terminate_by(_signal: &str) -> ! {
        const STATUS_CONTROL_C_EXIT: u32 = 0xC000_013A;
        std::process::exit(STATUS_CONTROL_C_EXIT as i32)
    }
}
