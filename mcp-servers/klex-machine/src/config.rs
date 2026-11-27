use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};
use std::path::{Path, PathBuf};

use crate::logger::{LOG_LEVELS, LogLevel};
use crate::paths::resolve_from;

#[derive(Clone, Debug)]
pub struct RuntimeConfig {
    pub cwd: PathBuf,
    pub host: String,
    pub port: u16,
    pub log_level: LogLevel,
    pub warns_about_remote_access: bool,
}

#[derive(Default, Debug)]
pub struct RawRuntimeConfig {
    pub cwd: Option<String>,
    pub host: Option<String>,
    pub port: Option<String>,
    pub log_level: Option<String>,
}

pub fn resolve_runtime_config(
    raw: &RawRuntimeConfig,
    process_cwd: &Path,
) -> Result<RuntimeConfig, String> {
    let cwd = match &raw.cwd {
        Some(cwd) => resolve_from(process_cwd, Path::new(cwd)),
        None => resolve_from(process_cwd, Path::new(".")),
    };
    if !std::fs::metadata(&cwd).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(format!(
            "Working directory does not exist or is not a directory: {}",
            cwd.display()
        ));
    }

    let host = raw
        .host
        .as_deref()
        .map(str::trim)
        .filter(|host| !host.is_empty())
        .unwrap_or("127.0.0.1")
        .to_string();
    let port_input = raw.port.as_deref().unwrap_or("3123");
    let port = js_number(port_input);
    let valid = raw
        .port
        .as_deref()
        .is_none_or(|port| !port.trim().is_empty())
        && port.fract() == 0.0
        && (0.0..=65_535.0).contains(&port);
    if !valid {
        let shown = raw.port.clone().unwrap_or_else(|| format_js_number(port));
        return Err(format!(
            "Invalid port: {shown}. Expected an integer from 0 to 65535."
        ));
    }

    let log_level_input = raw.log_level.clone().unwrap_or_else(|| "info".into());
    let Some(log_level) = LogLevel::parse(&log_level_input.to_lowercase()) else {
        return Err(format!(
            "Invalid log level: {}. Expected {}.",
            raw.log_level.as_deref().unwrap_or("undefined"),
            LOG_LEVELS.join(", ")
        ));
    };

    Ok(RuntimeConfig {
        cwd,
        warns_about_remote_access: !is_loopback_host(&host),
        host,
        port: port as u16,
        log_level,
    })
}

/// JavaScript's `Number(string)` for the inputs a port flag can carry.
pub fn js_number(input: &str) -> f64 {
    let trimmed =
        input.trim_matches(|character: char| character.is_whitespace() || character == '\u{feff}');
    if trimmed.is_empty() {
        return 0.0;
    }
    let radix = |prefix: &str, radix: u32| {
        trimmed
            .strip_prefix(prefix)
            .or_else(|| trimmed.strip_prefix(&prefix.to_uppercase()))
            .map(|digits| {
                u64::from_str_radix(digits, radix)
                    .map(|value| value as f64)
                    .unwrap_or(f64::NAN)
            })
    };
    if let Some(value) = radix("0x", 16)
        .or_else(|| radix("0o", 8))
        .or_else(|| radix("0b", 2))
    {
        return value;
    }
    match trimmed {
        "Infinity" | "+Infinity" => return f64::INFINITY,
        "-Infinity" => return f64::NEG_INFINITY,
        _ => {}
    }
    let valid = trimmed
        .trim_start_matches(['+', '-'])
        .chars()
        .all(|character| {
            character.is_ascii_digit() || matches!(character, '.' | 'e' | 'E' | '+' | '-')
        });
    if !valid {
        return f64::NAN;
    }
    trimmed.parse::<f64>().unwrap_or(f64::NAN)
}

fn format_js_number(value: f64) -> String {
    if value.is_nan() {
        "NaN".into()
    } else if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// Hostnames and addresses that only accept local connections.
pub fn is_loopback_host(host: &str) -> bool {
    let normalized = host
        .trim_start_matches('[')
        .trim_end_matches(']')
        .to_lowercase();
    if normalized == "localhost" {
        return true;
    }
    if let Ok(address) = normalized.parse::<Ipv6Addr>() {
        if address == Ipv6Addr::LOCALHOST {
            return true;
        }
        return address
            .to_ipv4_mapped()
            .is_some_and(|mapped| mapped.is_loopback());
    }
    parse_whatwg_ipv4(&normalized).is_some_and(|address| IpAddr::V4(address).is_loopback())
}

/// WHATWG URL host parsing accepts shorthand and hex/octal IPv4 forms.
pub fn parse_whatwg_ipv4(host: &str) -> Option<Ipv4Addr> {
    let parts: Vec<&str> = host.strip_suffix('.').unwrap_or(host).split('.').collect();
    if parts.is_empty() || parts.len() > 4 {
        return None;
    }
    let mut numbers = Vec::new();
    for part in &parts {
        let value = if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            if hex.is_empty() {
                0
            } else {
                u64::from_str_radix(hex, 16).ok()?
            }
        } else if part.len() > 1 && part.starts_with('0') {
            u64::from_str_radix(&part[1..], 8).ok()?
        } else {
            part.parse::<u64>().ok()?
        };
        numbers.push(value);
    }
    let last = numbers.pop()?;
    if numbers.iter().any(|value| *value > 255) || last >= 256u64.pow(4 - numbers.len() as u32) {
        return None;
    }
    let mut address = last;
    for (index, value) in numbers.iter().enumerate() {
        address += value << (8 * (3 - index));
    }
    Some(Ipv4Addr::from(address as u32))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_loopback_hosts() {
        for host in [
            "localhost",
            "127.0.0.1",
            "127.1.2.3",
            "::1",
            "[::1]",
            "::ffff:127.0.0.1",
            "0x7f.1",
            "LOCALHOST",
        ] {
            assert!(is_loopback_host(host), "{host}");
        }
        for host in [
            "0.0.0.0",
            "192.168.1.1",
            "::",
            "example.com",
            "::ffff:10.0.0.1",
        ] {
            assert!(!is_loopback_host(host), "{host}");
        }
    }

    #[test]
    fn parses_numbers_like_javascript() {
        assert_eq!(js_number("3123"), 3123.0);
        assert_eq!(js_number(" 42 "), 42.0);
        assert_eq!(js_number("0x10"), 16.0);
        assert_eq!(js_number("1e3"), 1000.0);
        assert!(js_number("abc").is_nan());
        assert_eq!(js_number("1.5"), 1.5);
    }

    #[test]
    fn validates_like_the_typescript_server() {
        let cwd = std::env::temp_dir();
        let error = |raw: RawRuntimeConfig| resolve_runtime_config(&raw, &cwd).unwrap_err();
        assert_eq!(
            error(RawRuntimeConfig {
                port: Some("abc".into()),
                ..Default::default()
            }),
            "Invalid port: abc. Expected an integer from 0 to 65535."
        );
        assert_eq!(
            error(RawRuntimeConfig {
                port: Some("".into()),
                ..Default::default()
            }),
            "Invalid port: . Expected an integer from 0 to 65535."
        );
        assert_eq!(
            error(RawRuntimeConfig {
                log_level: Some("loud".into()),
                ..Default::default()
            }),
            "Invalid log level: loud. Expected trace, debug, info, warn, error, fatal."
        );
        let config = resolve_runtime_config(
            &RawRuntimeConfig {
                port: Some("0".into()),
                log_level: Some("DEBUG".into()),
                host: Some(" 0.0.0.0 ".into()),
                ..Default::default()
            },
            &cwd,
        )
        .unwrap();
        assert_eq!(config.port, 0);
        assert_eq!(config.host, "0.0.0.0");
        assert!(config.warns_about_remote_access);
        assert_eq!(config.log_level, LogLevel::Debug);
    }
}
