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
use crate::platform::host;

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
    match host::PLATFORM {
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
                platform: host::PLATFORM.into(),
                arch: node_arch().into(),
                release: text(host::kernel_release().as_deref()),
                name: None,
            },
            cpu: Cpu {
                model: text(host::cpu_model().as_deref()),
                logical_cores: std::thread::available_parallelism()
                    .ok()
                    .and_then(|cores| positive_integer(cores.get() as u64)),
            },
            memory: Memory {
                total_bytes: host::total_memory().and_then(positive_integer),
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
                hostname: text(host::dns_hostname().as_deref()),
                workspace_path: (length > 0 && length <= 1024).then_some(workspace),
                ..Host::default()
            });
            let cwd = self.options.cwd.clone();
            let disk = single_flight(&self.disk_pending, async move {
                tokio::task::spawn_blocking(move || crate::platform::fs::volume_total_bytes(&cwd))
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
        assert_eq!(facts.os.platform, host::PLATFORM);
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
