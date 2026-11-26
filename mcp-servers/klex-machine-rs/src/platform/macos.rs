//! macOS-only implementations.

use std::ffi::CStr;

use regex::Regex;
use serde_json::Value;

use crate::device_type::{DeviceType, virtual_model};

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

pub fn cpu_model() -> Option<String> {
    let mut buffer = [0u8; 256];
    let length = sysctl(c"machdep.cpu.brand_string", &mut buffer)?;
    let end = buffer[..length]
        .iter()
        .position(|byte| *byte == 0)
        .unwrap_or(length);
    Some(String::from_utf8_lossy(&buffer[..end]).into_owned())
}

pub fn total_memory() -> Option<u64> {
    let mut buffer = [0u8; 8];
    (sysctl(c"hw.memsize", &mut buffer)? == 8).then(|| u64::from_ne_bytes(buffer))
}

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
