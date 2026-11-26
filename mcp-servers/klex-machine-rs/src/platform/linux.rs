//! Linux-only implementations.

use crate::device_type::{DeviceType, chassis_type, virtual_model};

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
