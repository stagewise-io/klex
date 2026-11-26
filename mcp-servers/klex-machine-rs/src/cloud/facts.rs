//! Machine facts sent to Cloud in `x-klex-machine-facts` when the proxy
//! connection opens. Optional probes share a one-second budget, and each
//! stays single-flight across connections until it settles.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde::Serialize;

use crate::device_type::DeviceType;

pub const MACHINE_FACTS_HEADER: &str = "x-klex-machine-facts";
pub const MAX_MACHINE_FACTS_HEADER_BYTES: usize = 4096;
const MAX_OS_RELEASE_BYTES: usize = 16_384;
const PROBE_BUDGET: Duration = Duration::from_secs(1);

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Os {
    pub platform: String,
    pub arch: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub release: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Cpu {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub logical_cores: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub total_bytes: Option<u64>,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Host {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub hostname: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub workspace_volume_total_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub device_type: Option<&'static str>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MachineFacts {
    pub v: u8,
    pub machine_version: String,
    pub os: Os,
    pub cpu: Cpu,
    pub memory: Memory,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<Host>,
}

/// JS `value?.trim().slice(0, 256).trim() || undefined`.
fn text(value: Option<&str>) -> Option<String> {
    let value = value?.trim();
    let mut units = 0;
    let end = value
        .char_indices()
        .find(|(_, character)| {
            units += character.len_utf16();
            units > 256
        })
        .map_or(value.len(), |(index, _)| index);
    let value = value[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

const MAX_SAFE_INTEGER: u64 = (1 << 53) - 1;

fn positive_integer(value: u64) -> Option<u64> {
    (value > 0 && value <= MAX_SAFE_INTEGER).then_some(value)
}

fn device_type_name(value: DeviceType) -> &'static str {
    match value {
        DeviceType::Laptop => "laptop",
        DeviceType::Desktop => "desktop",
        DeviceType::Server => "server",
        DeviceType::Vm => "vm",
        DeviceType::Container => "container",
    }
}

pub fn node_arch() -> &'static str {
    match std::env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        "x86" => "ia32",
        other => other,
    }
}

/// Parses os-release as inert data, never shell syntax.
pub fn pretty_os_name(source: &str) -> Option<String> {
    if source.len() > MAX_OS_RELEASE_BYTES {
        return None;
    }
    let raw = source
        .split('\n')
        .find_map(|line| line.strip_prefix("PRETTY_NAME="))?
        .trim();
    if raw.is_empty() {
        return None;
    }
    if let Some(rest) = raw.strip_prefix('"') {
        let inner = rest.strip_suffix('"')?;
        let mut unescaped = String::with_capacity(inner.len());
        let mut characters = inner.chars().peekable();
        while let Some(character) = characters.next() {
            if character == '\\'
                && let Some(&next) = characters.peek()
                && "\"\\$`".contains(next)
            {
                unescaped.push(next);
                characters.next();
            } else {
                unescaped.push(character);
            }
        }
        return text(Some(&unescaped));
    }
    if let Some(rest) = raw.strip_prefix('\'') {
        return text(Some(rest.strip_suffix('\'')?));
    }
    text(Some(raw))
}

fn read_os_release(path: &Path) -> Option<String> {
    use std::io::Read;
    let file = std::fs::File::open(path).ok()?;
    let mut buffer = Vec::new();
    file.take(MAX_OS_RELEASE_BYTES as u64 + 1)
        .read_to_end(&mut buffer)
        .ok()?;
    if buffer.len() > MAX_OS_RELEASE_BYTES {
        return None;
    }
    Some(String::from_utf8_lossy(&buffer).into_owned())
}

fn os_name() -> Option<String> {
    match crate::platform::host::PLATFORM {
        "darwin" => Some("macOS".into()),
        "win32" => Some("Windows".into()),
        "linux" => ["/etc/os-release", "/usr/lib/os-release"]
            .iter()
            .find_map(|path| {
                read_os_release(Path::new(path)).and_then(|source| pretty_os_name(&source))
            }),
        _ => None,
    }
}

pub struct MachineFactsOptions {
    pub cwd: PathBuf,
    pub omit_host_details: bool,
    pub version: String,
}

pub struct MachineFactsCollector {
    options: MachineFactsOptions,
    name_pending: Arc<AtomicBool>,
    disk_pending: Arc<AtomicBool>,
    device_pending: Arc<AtomicBool>,
}

/// Clears a probe's in-flight flag when the probe finishes, fails or panics.
struct InFlight(Arc<AtomicBool>);

impl Drop for InFlight {
    fn drop(&mut self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

/// Runs `probe` unless its previous run is still in flight. Like the
/// TypeScript collector, a probe that outlives the budget keeps running and
/// holds the flag until it settles; every probe is bounded or a single
/// filesystem call.
fn single_flight<T, F>(
    pending: &Arc<AtomicBool>,
    probe: F,
) -> Option<tokio::task::JoinHandle<Option<T>>>
where
    T: Send + 'static,
    F: Future<Output = Option<T>> + Send + 'static,
{
    if pending.swap(true, Ordering::SeqCst) {
        return None;
    }
    let in_flight = InFlight(pending.clone());
    Some(tokio::spawn(async move {
        let _in_flight = in_flight;
        probe.await
    }))
}

async fn settle<T>(
    handle: Option<tokio::task::JoinHandle<Option<T>>>,
    deadline: tokio::time::Instant,
) -> Option<T> {
    tokio::time::timeout_at(deadline, handle?)
        .await
        .ok()?
        .ok()?
}

impl MachineFactsCollector {
    pub fn new(options: MachineFactsOptions) -> Self {
        Self {
            options,
            name_pending: Arc::default(),
            disk_pending: Arc::default(),
            device_pending: Arc::default(),
        }
    }

    pub async fn collect(&self) -> MachineFacts {
        let deadline = tokio::time::Instant::now() + PROBE_BUDGET;
        let mut facts = MachineFacts {
            v: 1,
            machine_version: text(Some(&self.options.version)).unwrap_or_else(|| "unknown".into()),
            os: Os {
                platform: crate::platform::host::PLATFORM.into(),
                arch: node_arch().into(),
                release: text(probes::release().as_deref()),
                name: None,
            },
            cpu: Cpu {
                model: text(probes::cpu_model().as_deref()),
                logical_cores: std::thread::available_parallelism()
                    .ok()
                    .and_then(|cores| positive_integer(cores.get() as u64)),
            },
            memory: Memory {
                total_bytes: probes::total_memory().and_then(positive_integer),
            },
            host: None,
        };
        let name = single_flight(&self.name_pending, async {
            tokio::task::spawn_blocking(os_name).await.ok().flatten()
        });
        let (disk, device) = if self.options.omit_host_details {
            (None, None)
        } else {
            let workspace = crate::paths::display(&self.options.cwd);
            let length = crate::utf16::len(&workspace);
            facts.host = Some(Host {
                hostname: text(probes::hostname().as_deref()),
                workspace_path: (length > 0 && length <= 1024).then_some(workspace),
                ..Host::default()
            });
            let cwd = self.options.cwd.clone();
            let disk = single_flight(&self.disk_pending, async move {
                tokio::task::spawn_blocking(move || probes::volume_bytes(&cwd))
                    .await
                    .ok()
                    .flatten()
            });
            let device = single_flight(&self.device_pending, crate::device_type::detect());
            (disk, device)
        };
        let (name, disk, device) = tokio::join!(
            settle(name, deadline),
            settle(disk, deadline),
            settle(device, deadline)
        );
        facts.os.name = name;
        if let Some(host) = &mut facts.host {
            host.workspace_volume_total_bytes = disk.and_then(positive_integer);
            host.device_type = device.map(device_type_name);
        }
        facts
    }
}

pub fn encode_machine_facts_header(facts: &MachineFacts) -> Option<String> {
    let json = serde_json::to_string(facts).ok()?;
    let header = URL_SAFE_NO_PAD.encode(json);
    (header.len() <= MAX_MACHINE_FACTS_HEADER_BYTES).then_some(header)
}

#[cfg(unix)]
mod probes {
    use std::ffi::CStr;
    use std::path::Path;

    fn uname_release() -> Option<String> {
        let mut name: libc::utsname = unsafe { std::mem::zeroed() };
        // SAFETY: `name` is a valid, writable utsname.
        if unsafe { libc::uname(&mut name) } != 0 {
            return None;
        }
        // SAFETY: uname NUL-terminates each field.
        let release = unsafe { CStr::from_ptr(name.release.as_ptr()) };
        Some(release.to_string_lossy().into_owned())
    }

    pub fn release() -> Option<String> {
        uname_release()
    }

    pub fn hostname() -> Option<String> {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is writable for its full length.
        if unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) } != 0 {
            return None;
        }
        let end = buffer
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(buffer.len());
        Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
    }

    pub fn volume_bytes(path: &Path) -> Option<u64> {
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

    #[cfg(target_os = "linux")]
    pub fn cpu_model() -> Option<String> {
        let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").ok()?;
        cpuinfo.lines().find_map(|line| {
            let (key, value) = line.split_once(':')?;
            (key.trim() == "model name" && !value.trim().is_empty())
                .then(|| value.trim().to_string())
        })
    }

    #[cfg(target_os = "linux")]
    pub fn total_memory() -> Option<u64> {
        let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
        // SAFETY: `info` is writable.
        if unsafe { libc::sysinfo(&mut info) } != 0 {
            return None;
        }
        #[allow(clippy::unnecessary_cast)]
        (info.totalram as u64).checked_mul(info.mem_unit as u64)
    }

    #[cfg(target_os = "macos")]
    fn sysctl(name: &CStr, buffer: &mut [u8]) -> Option<usize> {
        let mut length = buffer.len();
        // SAFETY: `buffer` is writable for `length` bytes.
        let result = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                buffer.as_mut_ptr().cast(),
                &mut length,
                std::ptr::null_mut(),
                0,
            )
        };
        (result == 0).then_some(length)
    }

    #[cfg(target_os = "macos")]
    pub fn cpu_model() -> Option<String> {
        let mut buffer = [0u8; 256];
        let length = sysctl(c"machdep.cpu.brand_string", &mut buffer)?;
        let end = buffer[..length]
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(length);
        Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
    }

    #[cfg(target_os = "macos")]
    pub fn total_memory() -> Option<u64> {
        let mut buffer = [0u8; 8];
        (sysctl(c"hw.memsize", &mut buffer)? == 8).then(|| u64::from_ne_bytes(buffer))
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub fn cpu_model() -> Option<String> {
        None
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    pub fn total_memory() -> Option<u64> {
        None
    }
}

#[cfg(windows)]
mod probes {
    use std::os::windows::ffi::OsStrExt;
    use std::path::Path;

    use windows_sys::Win32::Foundation::ERROR_SUCCESS;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows_sys::Win32::System::Registry::{
        HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RegGetValueW,
    };
    use windows_sys::Win32::System::SystemInformation::{
        ComputerNameDnsHostname, GetComputerNameExW, GlobalMemoryStatusEx, MEMORYSTATUSEX,
    };

    fn wide(text: &str) -> Vec<u16> {
        text.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn registry_string(key: &str, value: &str) -> Option<String> {
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

    const CURRENT_VERSION: &str = r"SOFTWARE\Microsoft\Windows NT\CurrentVersion";

    pub fn release() -> Option<String> {
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
        let mut status: MEMORYSTATUSEX = unsafe { std::mem::zeroed() };
        status.dwLength = size_of::<MEMORYSTATUSEX>() as u32;
        // SAFETY: `status` is writable and its length is set.
        (unsafe { GlobalMemoryStatusEx(&mut status) } != 0).then_some(status.ullTotalPhys)
    }

    pub fn hostname() -> Option<String> {
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

    pub fn volume_bytes(path: &Path) -> Option<u64> {
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
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_panicking_probe_releases_its_flag() {
        let pending = Arc::new(AtomicBool::new(false));
        let handle = single_flight(&pending, async { panic!("probe") as Option<()> }).unwrap();
        assert!(handle.await.is_err());
        assert!(!pending.load(Ordering::SeqCst));
    }

    #[test]
    fn parses_os_release_like_ts() {
        assert_eq!(
            pretty_os_name("NAME=x\nPRETTY_NAME=\"Ubuntu 24.04 LTS\"\n").as_deref(),
            Some("Ubuntu 24.04 LTS")
        );
        assert_eq!(
            pretty_os_name(r#"PRETTY_NAME="a \"b\" \$c""#).as_deref(),
            Some(r#"a "b" $c"#)
        );
        assert_eq!(
            pretty_os_name("PRETTY_NAME='Arch'").as_deref(),
            Some("Arch")
        );
        assert_eq!(
            pretty_os_name("PRETTY_NAME=Plain Name ").as_deref(),
            Some("Plain Name")
        );
        assert_eq!(pretty_os_name("PRETTY_NAME=\"unterminated"), None);
        assert_eq!(pretty_os_name("PRETTY_NAME="), None);
        assert_eq!(
            text(Some(&"x".repeat(300))).map(|value| value.len()),
            Some(256)
        );
    }

    #[tokio::test]
    async fn collects_bounded_facts() {
        let collector = MachineFactsCollector::new(MachineFactsOptions {
            cwd: std::env::temp_dir(),
            omit_host_details: false,
            version: " 1.2.3 ".into(),
        });
        let facts = collector.collect().await;
        assert_eq!(facts.machine_version, "1.2.3");
        assert_eq!(facts.os.platform, crate::platform::host::PLATFORM);
        assert!(facts.host.as_ref().unwrap().workspace_path.is_some());
        let header = encode_machine_facts_header(&facts).unwrap();
        let decoded: serde_json::Value =
            serde_json::from_slice(&URL_SAFE_NO_PAD.decode(header).unwrap()).unwrap();
        assert_eq!(decoded["v"], 1);

        let omitted = MachineFactsCollector::new(MachineFactsOptions {
            cwd: std::env::temp_dir(),
            omit_host_details: true,
            version: String::new(),
        })
        .collect()
        .await;
        assert_eq!(omitted.machine_version, "unknown");
        assert!(omitted.host.is_none());
    }
}
