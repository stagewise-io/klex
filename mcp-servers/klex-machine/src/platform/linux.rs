//! Linux-only implementations.

use crate::device_type::{DeviceType, chassis_type, virtual_model};

/// `os.cpus()[0].model` as libuv's `uv_cpu_info` reads it.
pub fn cpu_model() -> Option<String> {
    std::fs::metadata("/proc/stat").ok()?;
    let cpuinfo = std::fs::read_to_string("/proc/cpuinfo").unwrap_or_default();
    Some(libuv_cpu_model(&cpuinfo, MODEL_MARKERS, cfg!(target_arch = "aarch64")).to_string())
}

#[cfg(target_arch = "aarch64")]
const MODEL_MARKERS: &[&str] = &["CPU part\t: "];
#[cfg(target_arch = "arm")]
const MODEL_MARKERS: &[&str] = &["model name\t: ", "Processor\t: "];
#[cfg(not(any(target_arch = "aarch64", target_arch = "arm")))]
const MODEL_MARKERS: &[&str] = &["model name\t: "];

/// libuv's arm64 `CPU part` names.
const ARM64_PARTS: &[(&str, &str)] = &[
    ("0x811", "ARM810"),
    ("0x920", "ARM920"),
    ("0x922", "ARM922"),
    ("0x926", "ARM926"),
    ("0x940", "ARM940"),
    ("0x946", "ARM946"),
    ("0x966", "ARM966"),
    ("0xa20", "ARM1020"),
    ("0xa22", "ARM1022"),
    ("0xa26", "ARM1026"),
    ("0xb02", "ARM11 MPCore"),
    ("0xb36", "ARM1136"),
    ("0xb56", "ARM1156"),
    ("0xb76", "ARM1176"),
    ("0xc05", "Cortex-A5"),
    ("0xc07", "Cortex-A7"),
    ("0xc08", "Cortex-A8"),
    ("0xc09", "Cortex-A9"),
    ("0xc0d", "Cortex-A17"),
    ("0xc0f", "Cortex-A15"),
    ("0xc0e", "Cortex-A17"),
    ("0xc14", "Cortex-R4"),
    ("0xc15", "Cortex-R5"),
    ("0xc17", "Cortex-R7"),
    ("0xc18", "Cortex-R8"),
    ("0xc20", "Cortex-M0"),
    ("0xc21", "Cortex-M1"),
    ("0xc23", "Cortex-M3"),
    ("0xc24", "Cortex-M4"),
    ("0xc27", "Cortex-M7"),
    ("0xc60", "Cortex-M0+"),
    ("0xd01", "Cortex-A32"),
    ("0xd03", "Cortex-A53"),
    ("0xd04", "Cortex-A35"),
    ("0xd05", "Cortex-A55"),
    ("0xd06", "Cortex-A65"),
    ("0xd07", "Cortex-A57"),
    ("0xd08", "Cortex-A72"),
    ("0xd09", "Cortex-A73"),
    ("0xd0a", "Cortex-A75"),
    ("0xd0b", "Cortex-A76"),
    ("0xd0c", "Neoverse-N1"),
    ("0xd0d", "Cortex-A77"),
    ("0xd0e", "Cortex-A76AE"),
    ("0xd13", "Cortex-R52"),
    ("0xd20", "Cortex-M23"),
    ("0xd21", "Cortex-M33"),
    ("0xd41", "Cortex-A78"),
    ("0xd42", "Cortex-A78AE"),
    ("0xd4a", "Neoverse-E1"),
    ("0xd4b", "Cortex-A78C"),
    ("0xd4f", "Neoverse-V2"),
];

/// The first model marker after the first `processor` line, translated on
/// arm64. libuv reports `unknown` without one and keeps at most 63 bytes.
fn libuv_cpu_model<'a>(cpuinfo: &'a str, markers: &[&str], arm64_parts: bool) -> &'a str {
    let mut lines = cpuinfo.lines();
    let first_block = lines
        .next()
        .and_then(|line| line.strip_prefix("processor\t: "))
        .is_some_and(|number| number.trim().parse::<u32>().is_ok());
    if !first_block {
        return "unknown";
    }
    let Some(value) =
        lines.find_map(|line| markers.iter().find_map(|marker| line.strip_prefix(marker)))
    else {
        return "unknown";
    };
    let model = if arm64_parts {
        ARM64_PARTS
            .iter()
            .find_map(|(part, name)| (*part == value).then_some(*name))
            .unwrap_or("unknown")
    } else {
        value
    };
    let mut end = model.len().min(63);
    while !model.is_char_boundary(end) {
        end -= 1;
    }
    &model[..end]
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

#[cfg(test)]
mod tests {
    use super::*;

    const GRAVITON: &str = "processor\t: 0\nBogoMIPS\t: 243.75\nFeatures\t: fp asimd\nCPU implementer\t: 0x41\nCPU architecture: 8\nCPU variant\t: 0x3\nCPU part\t: 0xd0c\nCPU revision\t: 1\n\nprocessor\t: 1\nCPU part\t: 0xd40\n\n";

    #[test]
    fn reads_cpu_models_like_libuv() {
        assert_eq!(
            libuv_cpu_model(GRAVITON, &["CPU part\t: "], true),
            "Neoverse-N1"
        );
        assert_eq!(
            libuv_cpu_model(
                "processor\t: 0\nCPU part\t: 0xd40\n\n",
                &["CPU part\t: "],
                true
            ),
            "unknown"
        );
        assert_eq!(
            libuv_cpu_model(
                "processor\t: 0\nvendor_id\t: AuthenticAMD\nmodel name\t: AMD EPYC 9V74 80-Core Processor\n\n",
                &["model name\t: "],
                false
            ),
            "AMD EPYC 9V74 80-Core Processor"
        );
        assert_eq!(
            libuv_cpu_model(
                "processor\t: 0\n\nprocessor\t: 1\nmodel name\t: Later\n\n",
                &["model name\t: "],
                false
            ),
            "Later"
        );
        assert_eq!(
            libuv_cpu_model(GRAVITON, &["model name\t: "], false),
            "unknown"
        );
        assert_eq!(libuv_cpu_model("", &["model name\t: "], false), "unknown");
        let long = format!("processor\t: 0\nmodel name\t: {}\n", "x".repeat(80));
        assert_eq!(libuv_cpu_model(&long, &["model name\t: "], false).len(), 63);
    }
}
