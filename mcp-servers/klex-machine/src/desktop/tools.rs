//! The desktop_* MCP tools and the desktop://screen resource, with the
//! schemas, descriptions and results of `definitions/desktop-tools.json`.

use std::sync::LazyLock;

use base64::Engine;
use serde_json::{Value, json};

use super::provider::{ImageFormat, MouseButton, Point, Region, ScrollDirection};
use super::service::{DesktopAction, DesktopError, DesktopService, Screenshot, TreeOptions};

pub const DESKTOP_SCREEN_RESOURCE_URI: &str = "desktop://screen";
const LAUNCH_SETTLE_MS: u64 = 2_000;

pub static DESKTOP_DEFINITIONS: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../definitions/desktop-tools.json"))
        .expect("valid desktop definitions")
});

/// The desktop tools in registration order.
pub fn tools(accessibility: bool) -> &'static [Value] {
    let key = if accessibility {
        "accessibilityTools"
    } else {
        "tools"
    };
    DESKTOP_DEFINITIONS[key]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or_default()
}

pub fn resources() -> &'static Value {
    &DESKTOP_DEFINITIONS["resources"]
}

pub fn capabilities() -> &'static Value {
    &DESKTOP_DEFINITIONS["capabilities"]
}

pub fn instruction(key: &str) -> &'static str {
    DESKTOP_DEFINITIONS["instructions"][key]
        .as_str()
        .unwrap_or_default()
}

fn base64(data: &[u8]) -> String {
    base64::engine::general_purpose::STANDARD.encode(data)
}

fn text(value: String) -> Value {
    json!({ "type": "text", "text": value })
}

fn image_content(shot: &Screenshot) -> [Value; 2] {
    [
        json!({ "type": "image", "data": base64(&shot.data), "mimeType": shot.mime_type }),
        text(
            json!({ "width": shot.width, "height": shot.height, "screen": shot.screen })
                .to_string(),
        ),
    ]
}

fn error_result(error: &DesktopError) -> Value {
    let message = match error {
        DesktopError::Denied(denied) => {
            let mut body = json!({ "code": denied.code, "message": denied.message });
            if let Some(holder) = &denied.holder {
                body["holder"] = json!(holder);
            }
            json!({ "error": body }).to_string()
        }
        DesktopError::Failed(message) => format!("Error: {message}"),
    };
    json!({ "content": [text(message)], "isError": true })
}

fn ok_result(content: Vec<Value>) -> Value {
    json!({ "content": content })
}

fn int(args: &Value, key: &str) -> i64 {
    args.get(key).and_then(Value::as_i64).unwrap_or(0)
}

fn point(args: &Value) -> Point {
    Point {
        x: int(args, "x"),
        y: int(args, "y"),
    }
}

fn strings(args: &Value, key: &str) -> Vec<String> {
    args.get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

fn format(args: &Value) -> ImageFormat {
    match args.get("format").and_then(Value::as_str) {
        Some("png") => ImageFormat::Png,
        _ => ImageFormat::Jpeg,
    }
}

fn button(args: &Value) -> MouseButton {
    args.get("button")
        .and_then(Value::as_str)
        .and_then(MouseButton::parse)
        .unwrap_or(MouseButton::Left)
}

fn count(args: &Value) -> u32 {
    args.get("count").and_then(Value::as_u64).unwrap_or(1) as u32
}

async fn action(
    desktop: &DesktopService,
    args: &Value,
    settle_ms: Option<u64>,
    action: DesktopAction,
) -> Value {
    let value_text = |value: Value| {
        text(if value.is_null() {
            json!({ "ok": true }).to_string()
        } else {
            value.to_string()
        })
    };
    if args.get("screenshot").and_then(Value::as_bool) != Some(true) {
        return match desktop.perform(action).await {
            Ok(value) => ok_result(vec![value_text(value)]),
            Err(error) => error_result(&error),
        };
    }
    let settle = settle_ms
        .or_else(|| args.get("settleMs").and_then(Value::as_u64))
        .unwrap_or(super::service::DEFAULT_SETTLE_MS);
    match desktop
        .perform_with_screenshot(action, settle, ImageFormat::Jpeg)
        .await
    {
        Ok((value, shot)) => {
            let mut content = vec![value_text(value)];
            content.extend(image_content(&shot));
            ok_result(content)
        }
        Err(error) => error_result(&error),
    }
}

/// Runs one desktop tool with validated arguments; `None` when `name` is not
/// a desktop tool.
pub async fn call(
    desktop: &DesktopService,
    name: &str,
    args: &Value,
    accessibility: bool,
    resolve_path: impl Fn(&str) -> Result<String, String>,
) -> Option<Value> {
    let result = match name {
        "desktop_screenshot" => match desktop.screenshot(format(args)).await {
            Ok(shot) => ok_result(image_content(&shot).to_vec()),
            Err(error) => error_result(&error),
        },
        "desktop_zoom" => {
            let region = Region {
                x: int(args, "x"),
                y: int(args, "y"),
                width: int(args, "width"),
                height: int(args, "height"),
            };
            match desktop.zoom(region, format(args)).await {
                Ok(zoom) => ok_result(vec![
                    json!({ "type": "image", "data": base64(&zoom.shot.data), "mimeType": zoom.shot.mime_type }),
                    text(
                        json!({ "region": zoom.region, "width": zoom.shot.width, "height": zoom.shot.height })
                            .to_string(),
                    ),
                ]),
                Err(error) => error_result(&error),
            }
        }
        "desktop_click" => {
            let modifiers = strings(args, "modifiers");
            let reference = args.get("ref").and_then(Value::as_str);
            if accessibility {
                let by_point = args.get("x").is_some() && args.get("y").is_some();
                let any_point = args.get("x").is_some() || args.get("y").is_some();
                if (reference.is_none() && !by_point) || (reference.is_some() && any_point) {
                    return Some(error_result(&"Pass either x and y, or ref".into()));
                }
            }
            let operation = match reference.filter(|_| accessibility) {
                Some(reference) => DesktopAction::ClickElement {
                    reference: reference.to_string(),
                    button: button(args),
                    count: count(args),
                    modifiers,
                },
                None => DesktopAction::Click {
                    point: point(args),
                    button: button(args),
                    count: count(args),
                    modifiers,
                },
            };
            action(desktop, args, None, operation).await
        }
        "desktop_accessibility_tree" if accessibility => {
            let options = TreeOptions {
                window: args
                    .get("window")
                    .and_then(Value::as_str)
                    .map(str::to_string),
                reference: args.get("ref").and_then(Value::as_str).map(str::to_string),
                interactive_only: args.get("interactiveOnly").and_then(Value::as_bool),
                max_depth: args.get("maxDepth").and_then(Value::as_f64),
                max_nodes: args.get("maxNodes").and_then(Value::as_f64),
            };
            match desktop.accessibility_tree(options).await {
                Ok(tree) => ok_result(vec![text(tree.text)]),
                Err(error) => error_result(&error),
            }
        }
        "desktop_drag" => {
            let from = args.get("from").map(point).unwrap_or(Point { x: 0, y: 0 });
            let to = args.get("to").map(point).unwrap_or(Point { x: 0, y: 0 });
            let operation = DesktopAction::Drag {
                from,
                to,
                button: button(args),
            };
            action(desktop, args, None, operation).await
        }
        "desktop_move" => {
            action(
                desktop,
                args,
                None,
                DesktopAction::Move { point: point(args) },
            )
            .await
        }
        "desktop_scroll" => {
            let direction = args
                .get("direction")
                .and_then(Value::as_str)
                .and_then(ScrollDirection::parse)
                .unwrap_or(ScrollDirection::Down);
            let amount = args.get("amount").and_then(Value::as_u64).unwrap_or(3) as u32;
            let operation = DesktopAction::Scroll {
                point: point(args),
                direction,
                amount,
            };
            action(desktop, args, None, operation).await
        }
        "desktop_type" => {
            let text = args
                .get("text")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            action(desktop, args, None, DesktopAction::Type { text }).await
        }
        "desktop_key" => {
            let keys = strings(args, "keys");
            action(desktop, args, None, DesktopAction::Key { keys }).await
        }
        "desktop_list_windows" => {
            action(desktop, &json!({}), None, DesktopAction::ListWindows).await
        }
        "desktop_focus_window" => {
            let id = args
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            action(desktop, args, None, DesktopAction::FocusWindow { id }).await
        }
        "desktop_launch" => {
            let cwd = args.get("cwd").and_then(Value::as_str).unwrap_or(".");
            let cwd = match resolve_path(cwd) {
                Ok(cwd) => cwd,
                Err(error) => return Some(error_result(&error.into())),
            };
            let settle = args
                .get("settleMs")
                .and_then(Value::as_u64)
                .unwrap_or(LAUNCH_SETTLE_MS);
            let operation = DesktopAction::Launch {
                command: args
                    .get("command")
                    .and_then(Value::as_str)
                    .unwrap_or_default()
                    .to_string(),
                args: strings(args, "args"),
                cwd: Some(cwd),
            };
            action(desktop, args, Some(settle), operation).await
        }
        _ => return None,
    };
    Some(result)
}

/// The desktop://screen resource contents.
pub async fn read_screen(desktop: &DesktopService) -> Result<Value, String> {
    let shot = desktop
        .screenshot(ImageFormat::Jpeg)
        .await
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "contents": [{
            "uri": DESKTOP_SCREEN_RESOURCE_URI,
            "mimeType": shot.mime_type,
            "blob": base64(&shot.data),
        }],
    }))
}
