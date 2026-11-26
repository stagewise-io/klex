use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use serde_json::{Value, json};

use crate::device_type::DeviceType;

const SERVER: &str = r#"<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6.5h.01M8 17.5h.01m5-11h3m-3 11h3"/>"#;

fn shape(device_type: Option<DeviceType>) -> &'static str {
    match device_type {
        Some(DeviceType::Laptop) => {
            r#"<rect x="5" y="4" width="14" height="11" rx="1.5"/><path d="M3 18h18l-1.5 2h-15Z"/>"#
        }
        Some(DeviceType::Desktop) => {
            r#"<rect x="3" y="3" width="18" height="13" rx="2"/><path d="M12 16v5m-4 0h8"/>"#
        }
        Some(DeviceType::Server | DeviceType::Vm) => SERVER,
        Some(DeviceType::Container) => {
            r#"<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M7 9v6m5-6v6m5-6v6"/>"#
        }
        None => r#"<rect x="4" y="4" width="16" height="13" rx="2"/><path d="M8 21h8"/>"#,
    }
}

/// Self-contained images: no external requests, HTML, or inherited CSS colors.
pub fn machine_icons(device_type: Option<DeviceType>) -> Value {
    let icons: Vec<Value> = ["light", "dark"]
        .into_iter()
        .map(|theme| {
            let color = if theme == "dark" { "#eeece8" } else { "#383633" };
            let svg = format!(
                r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="{color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">{}</svg>"#,
                shape(device_type)
            );
            json!({
                "src": format!("data:image/svg+xml;base64,{}", BASE64.encode(svg)),
                "mimeType": "image/svg+xml",
                "sizes": ["any"],
                "theme": theme,
            })
        })
        .collect();
    Value::Array(icons)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_contract_generic_icon() {
        let contract: Value =
            serde_json::from_str(include_str!("../../klex-machine/contract/server.json")).unwrap();
        assert_eq!(machine_icons(None), contract["serverInfo"]["icons"]);
        assert_eq!(
            machine_icons(Some(DeviceType::Vm)),
            machine_icons(Some(DeviceType::Server))
        );
    }
}
