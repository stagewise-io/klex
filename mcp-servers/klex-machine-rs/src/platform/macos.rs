//! macOS-only implementations.

use regex::Regex;
use serde_json::Value;

use crate::device_type::{DeviceType, virtual_model};

pub async fn detect_device_type() -> Option<DeviceType> {
    let output = super::probe(
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
