//! Best-effort form factor, never inferred from an editable hostname.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;
#[cfg(any(target_os = "macos", windows))]
use serde_json::Value;
use tokio::process::Command;

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeviceType {
    Laptop,
    Desktop,
    Server,
    Vm,
    Container,
}

static VIRTUAL_MODEL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?i)\b(virtual|virtualmac|vmware|virtualbox|kvm|qemu|xen|hvm|bochs|parallels)(?:\b|\d)",
    )
    .expect("valid pattern")
});

pub fn virtual_model(model: &str) -> bool {
    VIRTUAL_MODEL.is_match(model)
}

pub fn chassis_type(value: i64) -> Option<DeviceType> {
    match value {
        8 | 9 | 10 | 14 | 31 | 32 => Some(DeviceType::Laptop),
        3 | 4 | 5 | 6 | 7 | 13 | 15 | 16 | 24 | 35 | 36 => Some(DeviceType::Desktop),
        17 | 23 | 28 | 29 => Some(DeviceType::Server),
        _ => None,
    }
}

async fn run(file: &str, args: &[&str]) -> Option<String> {
    let mut command = Command::new(file);
    command
        .args(args)
        .stdin(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .kill_on_drop(true);
    #[cfg(windows)]
    command.creation_flags(0x0800_0000);
    let output = tokio::time::timeout(Duration::from_millis(900), command.output())
        .await
        .ok()?
        .ok()?;
    if !output.status.success() || output.stdout.len() > 64 * 1024 {
        return None;
    }
    Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Detects the device type within one second, like the TS icon provider.
pub async fn detect() -> Option<DeviceType> {
    tokio::time::timeout(Duration::from_secs(1), detect_platform())
        .await
        .ok()
        .flatten()
}

#[cfg(target_os = "macos")]
async fn detect_platform() -> Option<DeviceType> {
    let output = run(
        "/usr/sbin/system_profiler",
        &["SPHardwareDataType", "-json"],
    )
    .await?;
    let parsed: Value = serde_json::from_str(&output).ok()?;
    let items = parsed.get("SPHardwareDataType")?.as_array()?;
    let model = items
        .iter()
        .map(|item| {
            let name = item
                .get("machine_name")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let model = item
                .get("machine_model")
                .and_then(Value::as_str)
                .unwrap_or_default();
            format!("{name} {model}")
        })
        .collect::<Vec<_>>()
        .join(" ");
    if virtual_model(&model) {
        return Some(DeviceType::Vm);
    }
    let matches = |pattern: &str| Regex::new(pattern).is_ok_and(|regex| regex.is_match(&model));
    if matches("(?i)MacBook") {
        Some(DeviceType::Laptop)
    } else if matches("(?i)iMac|Mac (mini|Studio|Pro)|Macmini|MacPro|MacStudio") {
        Some(DeviceType::Desktop)
    } else if matches("(?i)Xserve") {
        Some(DeviceType::Server)
    } else {
        None
    }
}

#[cfg(windows)]
async fn detect_platform() -> Option<DeviceType> {
    let output = run(
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

#[cfg(target_os = "linux")]
async fn detect_platform() -> Option<DeviceType> {
    // Containers can expose their host's DMI data. Detect them before chassis.
    for marker in [
        "/.dockerenv",
        "/run/.containerenv",
        "/run/systemd/container",
    ] {
        if tokio::fs::read(marker).await.is_ok() {
            return Some(DeviceType::Container);
        }
    }
    if let Some(container) = run("systemd-detect-virt", &["--container"]).await
        && !container.is_empty()
        && container != "none"
    {
        return Some(DeviceType::Container);
    }
    if let Some(vm) = run("systemd-detect-virt", &["--vm"]).await
        && !vm.is_empty()
        && vm != "none"
    {
        return Some(DeviceType::Vm);
    }
    let model = tokio::fs::read_to_string("/sys/class/dmi/id/product_name")
        .await
        .unwrap_or_default();
    let chassis = tokio::fs::read_to_string("/sys/class/dmi/id/chassis_type")
        .await
        .unwrap_or_default();
    if virtual_model(&model) {
        return Some(DeviceType::Vm);
    }
    chassis.trim().parse::<i64>().ok().and_then(chassis_type)
}

#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
async fn detect_platform() -> Option<DeviceType> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_models_and_chassis() {
        assert!(virtual_model("VMware Virtual Platform"));
        assert!(virtual_model("VirtualMac2,1"));
        assert!(virtual_model("KVM"));
        assert!(!virtual_model("ThinkPad X1"));
        assert_eq!(chassis_type(10), Some(DeviceType::Laptop));
        assert_eq!(chassis_type(3), Some(DeviceType::Desktop));
        assert_eq!(chassis_type(23), Some(DeviceType::Server));
        assert_eq!(chassis_type(1), None);
    }
}
