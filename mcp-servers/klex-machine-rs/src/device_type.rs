//! Best-effort form factor, never inferred from an editable hostname.

use std::sync::LazyLock;
use std::time::Duration;

use regex::Regex;

use crate::platform::host;

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

/// Detects the device type within one second, like the TS icon provider.
pub async fn detect() -> Option<DeviceType> {
    tokio::time::timeout(Duration::from_secs(1), host::detect_device_type())
        .await
        .ok()
        .flatten()
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
