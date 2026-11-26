//! Linux-only implementations.

use crate::device_type::{DeviceType, chassis_type, virtual_model};

/// The first `model name` in `/proc/cpuinfo`.
pub fn cpu_model() -> Option<String> {
    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").ok()?;
    cpuinfo.lines().find_map(|line| {
        let (key, value) = line.split_once(':')?;
        (key.trim() == "model name" && !value.trim().is_empty()).then(|| value.trim().to_string())
    })
}

pub fn total_memory() -> Option<u64> {
    let mut info: libc::sysinfo = unsafe { std::mem::zeroed() };
    // SAFETY: `info` is writable.
    if unsafe { libc::sysinfo(&mut info) } != 0 {
        return None;
    }
    #[allow(clippy::unnecessary_cast)]
    (info.totalram as u64).checked_mul(info.mem_unit as u64)
}

pub async fn detect_device_type() -> Option<DeviceType> {
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
    if let Some(container) = super::probe("systemd-detect-virt", &["--container"]).await
        && !container.is_empty()
        && container != "none"
    {
        return Some(DeviceType::Container);
    }
    if let Some(vm) = super::probe("systemd-detect-virt", &["--vm"]).await
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
