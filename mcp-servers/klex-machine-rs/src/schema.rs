//! Validates tool arguments against the contract JSON Schema with the issue
//! messages zod 4 produces for the TypeScript server's schemas.

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};

use regex::Regex;
use serde_json::{Map, Value};

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

struct Issue {
    path: Vec<String>,
    message: String,
}

/// Returns the arguments with unknown keys stripped, or zod's joined issues.
pub fn validate(schema: &Value, value: &Value) -> Result<Value, String> {
    let mut issues = Vec::new();
    let mut path = Vec::new();
    let output = check(schema, value, &mut path, &mut issues);
    if issues.is_empty() {
        return Ok(output);
    }
    Err(issues
        .iter()
        .map(|issue| {
            if issue.path.is_empty() {
                issue.message.clone()
            } else {
                format!("{}: {}", issue.path.join("."), issue.message)
            }
        })
        .collect::<Vec<_>>()
        .join(", "))
}

fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn push(issues: &mut Vec<Issue>, path: &[String], message: String) {
    issues.push(Issue {
        path: path.to_vec(),
        message,
    });
}

fn number(schema: &Value, key: &str) -> Option<f64> {
    schema.get(key).and_then(Value::as_f64)
}

fn format_number(value: f64) -> String {
    if value.fract() == 0.0 && value.abs() < 1e21 {
        format!("{value:.0}")
    } else {
        value.to_string()
    }
}

/// zod's length checks run even after a type mismatch when the input has a length.
fn check_length(schema: &Value, value: &Value, path: &[String], issues: &mut Vec<Issue>) {
    let (length, origin, unit) = match value {
        Value::String(text) => (crate::utf16::len(text) as f64, "string", "characters"),
        Value::Array(items) => (items.len() as f64, "array", "items"),
        Value::Object(object) => match object.get("length").and_then(Value::as_f64) {
            Some(length) => (length, "unknown", ""),
            None => return,
        },
        _ => return,
    };
    let describe = |relation: &str, bound: f64| {
        if unit.is_empty() {
            format!("expected {origin} to be {relation}{}", format_number(bound))
        } else {
            format!(
                "expected {origin} to have {relation}{} {unit}",
                format_number(bound)
            )
        }
    };
    let declared_min = number(schema, "minLength").or_else(|| number(schema, "minItems"));
    let declared_max = number(schema, "maxLength").or_else(|| number(schema, "maxItems"));
    if let Some(min) = declared_min
        && length < min
    {
        push(issues, path, format!("Too small: {}", describe(">=", min)));
    }
    if let Some(max) = declared_max
        && length > max
    {
        push(issues, path, format!("Too big: {}", describe("<=", max)));
    }
}

fn pattern(source: &str) -> Option<Regex> {
    static CACHE: LazyLock<Mutex<HashMap<String, Option<Regex>>>> = LazyLock::new(Default::default);
    let mut cache = CACHE
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    cache
        .entry(source.to_string())
        // JavaScript's `\d` is ASCII only; the regex crate's is Unicode.
        .or_insert_with(|| Regex::new(&source.replace(r"\d", "[0-9]")).ok())
        .clone()
}

fn check(schema: &Value, value: &Value, path: &mut Vec<String>, issues: &mut Vec<Issue>) -> Value {
    if let Some(options) = schema.get("enum").and_then(Value::as_array) {
        if !options.contains(value) {
            let listed = options
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("|");
            push(
                issues,
                path,
                format!("Invalid option: expected one of {listed}"),
            );
        }
        return value.clone();
    }
    match schema.get("type").and_then(Value::as_str) {
        Some("string") => {
            let Value::String(text) = value else {
                push(
                    issues,
                    path,
                    format!(
                        "Invalid input: expected string, received {}",
                        received(Some(value))
                    ),
                );
                check_length(schema, value, path, issues);
                return value.clone();
            };
            check_length(schema, value, path, issues);
            if let Some(source) = schema.get("pattern").and_then(Value::as_str)
                && !pattern(source).is_some_and(|regex| regex.is_match(text))
            {
                let message = if schema.get("format").and_then(Value::as_str) == Some("uuid") {
                    "Invalid UUID".into()
                } else {
                    format!("Invalid string: must match pattern /{source}/")
                };
                push(issues, path, message);
            }
            value.clone()
        }
        Some("boolean") => {
            if !value.is_boolean() {
                push(
                    issues,
                    path,
                    format!(
                        "Invalid input: expected boolean, received {}",
                        received(Some(value))
                    ),
                );
            }
            value.clone()
        }
        Some("integer" | "number") => {
            let Some(number_value) = value.as_f64() else {
                push(
                    issues,
                    path,
                    format!(
                        "Invalid input: expected number, received {}",
                        received(Some(value))
                    ),
                );
                return value.clone();
            };
            let integer = schema.get("type").and_then(Value::as_str) == Some("integer");
            if integer {
                if number_value.fract() != 0.0 {
                    push(
                        issues,
                        path,
                        "Invalid input: expected int, received number".into(),
                    );
                    return value.clone();
                }
                if number_value > MAX_SAFE_INTEGER {
                    push(
                        issues,
                        path,
                        format!(
                            "Too big: expected int to be <={}",
                            format_number(MAX_SAFE_INTEGER)
                        ),
                    );
                } else if number_value < -MAX_SAFE_INTEGER {
                    push(
                        issues,
                        path,
                        format!(
                            "Too small: expected int to be >=-{}",
                            format_number(MAX_SAFE_INTEGER)
                        ),
                    );
                }
            }
            if let Some(bound) = number(schema, "exclusiveMinimum")
                && number_value <= bound
            {
                push(
                    issues,
                    path,
                    format!("Too small: expected number to be >{}", format_number(bound)),
                );
            }
            if let Some(bound) = number(schema, "minimum")
                && number_value < bound
                && !(integer && bound == -MAX_SAFE_INTEGER)
            {
                push(
                    issues,
                    path,
                    format!(
                        "Too small: expected number to be >={}",
                        format_number(bound)
                    ),
                );
            }
            if let Some(bound) = number(schema, "maximum")
                && number_value > bound
                && !(integer && bound == MAX_SAFE_INTEGER)
            {
                push(
                    issues,
                    path,
                    format!("Too big: expected number to be <={}", format_number(bound)),
                );
            }
            value.clone()
        }
        Some("array") => {
            let Value::Array(items) = value else {
                push(
                    issues,
                    path,
                    format!(
                        "Invalid input: expected array, received {}",
                        received(Some(value))
                    ),
                );
                check_length(schema, value, path, issues);
                return value.clone();
            };
            let item_schema = schema.get("items").cloned().unwrap_or(Value::Null);
            let output = items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    path.push(index.to_string());
                    let checked = check(&item_schema, item, path, issues);
                    path.pop();
                    checked
                })
                .collect();
            check_length(schema, value, path, issues);
            Value::Array(output)
        }
        Some("object") => {
            let Value::Object(object) = value else {
                let kind = if schema
                    .get("additionalProperties")
                    .is_some_and(Value::is_object)
                {
                    "record"
                } else {
                    "object"
                };
                push(
                    issues,
                    path,
                    format!(
                        "Invalid input: expected {kind}, received {}",
                        received(Some(value))
                    ),
                );
                return value.clone();
            };
            if let Some(value_schema) = schema
                .get("additionalProperties")
                .filter(|schema| schema.is_object())
            {
                let mut output = Map::new();
                for (key, item) in object {
                    path.push(key.clone());
                    output.insert(key.clone(), check(value_schema, item, path, issues));
                    path.pop();
                }
                return Value::Object(output);
            }
            let required: Vec<&str> = schema
                .get("required")
                .and_then(Value::as_array)
                .map(|keys| keys.iter().filter_map(Value::as_str).collect())
                .unwrap_or_default();
            let mut output = Map::new();
            if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
                for (key, property) in properties {
                    path.push(key.clone());
                    match object.get(key) {
                        Some(item) => {
                            output.insert(key.clone(), check(property, item, path, issues));
                        }
                        None if required.contains(&key.as_str()) => {
                            let expected = match property.get("type").and_then(Value::as_str) {
                                Some("integer") => "number",
                                Some(kind) => kind,
                                None if property.get("enum").is_some() => "",
                                None => "unknown",
                            };
                            if expected.is_empty() {
                                push(issues, path, check_enum_missing(property));
                            } else {
                                push(
                                    issues,
                                    path,
                                    format!(
                                        "Invalid input: expected {expected}, received undefined"
                                    ),
                                );
                            }
                        }
                        None => {}
                    }
                    path.pop();
                }
            }
            Value::Object(output)
        }
        _ => value.clone(),
    }
}

fn check_enum_missing(schema: &Value) -> String {
    let listed = schema
        .get("enum")
        .and_then(Value::as_array)
        .map(|options| {
            options
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("|")
        })
        .unwrap_or_default();
    format!("Invalid option: expected one of {listed}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_server_messages() {
        let tools: Vec<Value> =
            serde_json::from_str(include_str!("../../klex-machine/contract/tools/push.json"))
                .unwrap();
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../klex-machine/contract/validation.json"))
                .unwrap();
        let mut checked = 0;
        for case in cases {
            let Some(result) = case.get("result") else {
                continue;
            };
            let name = case["name"].as_str().unwrap();
            let tool = tools.iter().find(|tool| tool["name"] == name).unwrap();
            let expected = result["content"][0]["text"].as_str().unwrap();
            let actual = validate(&tool["inputSchema"], &case["arguments"]).unwrap_err();
            assert_eq!(
                format!("Input validation error: Invalid arguments for tool {name}: {actual}"),
                expected,
                "{case}"
            );
            checked += 1;
        }
        assert!(checked > 50);
    }

    #[test]
    fn matches_the_typescript_desktop_messages() {
        let contract: Value =
            serde_json::from_str(include_str!("../../klex-machine/contract/desktop.json")).unwrap();
        let cases: Vec<Value> = serde_json::from_str(include_str!(
            "../../klex-machine/contract/desktop-validation.json"
        ))
        .unwrap();
        let mut checked = 0;
        for case in cases {
            let Some(expected) = case["result"]["content"][0]["text"].as_str() else {
                continue;
            };
            let Some(issues) =
                expected.strip_prefix(&format!("Input validation error: Invalid arguments for tool {}: ", case["name"].as_str().unwrap()))
            else {
                continue;
            };
            let tools = if case["desktop"] == "fake" {
                &contract["accessibilityTools"]
            } else {
                &contract["tools"]
            };
            let tool = tools
                .as_array()
                .unwrap()
                .iter()
                .find(|tool| tool["name"] == case["name"])
                .unwrap();
            let actual = validate(&tool["inputSchema"], &case["arguments"]).unwrap_err();
            assert_eq!(actual, issues, "{case}");
            checked += 1;
        }
        assert!(checked > 50);
    }

    #[test]
    fn strips_unknown_keys_and_reports_root_type() {
        let schema = serde_json::json!({
            "type": "object",
            "properties": { "a": { "type": "array", "items": { "type": "object", "properties": { "x": { "type": "string" } } } } }
        });
        let output = validate(
            &schema,
            &serde_json::json!({ "a": [{ "x": "1", "y": 2 }], "b": 1 }),
        )
        .unwrap();
        assert_eq!(output, serde_json::json!({ "a": [{ "x": "1" }] }));
        assert_eq!(
            validate(&schema, &serde_json::json!([])).unwrap_err(),
            "Invalid input: expected object, received array"
        );
    }
}
