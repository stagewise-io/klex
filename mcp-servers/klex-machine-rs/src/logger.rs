//! Log lines on stderr in the shapes tslog writes for the TS server: pretty
//! text on a terminal, JSON otherwise.

use std::io::{IsTerminal, Write};
use std::panic::Location;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::time::iso_now;
use crate::utf16;

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Debug)]
pub enum LogLevel {
    Trace = 1,
    Debug = 2,
    Info = 3,
    Warn = 4,
    Error = 5,
    Fatal = 6,
}

pub const LOG_LEVELS: [&str; 6] = ["trace", "debug", "info", "warn", "error", "fatal"];

impl LogLevel {
    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "trace" => Self::Trace,
            "debug" => Self::Debug,
            "info" => Self::Info,
            "warn" => Self::Warn,
            "error" => Self::Error,
            "fatal" => Self::Fatal,
            _ => return None,
        })
    }

    fn name(self) -> &'static str {
        match self {
            Self::Trace => "TRACE",
            Self::Debug => "DEBUG",
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
            Self::Fatal => "FATAL",
        }
    }
}

const MASKED_KEYS: [&str; 6] = [
    "password",
    "apikey",
    "authorization",
    "token",
    "secret",
    "prompt",
];

#[derive(Clone)]
pub struct Logger {
    min_level: Option<LogLevel>,
    pretty: bool,
    sink: Arc<dyn Fn(&str) + Send + Sync>,
}

impl Logger {
    pub fn stderr(min_level: LogLevel) -> Self {
        Self {
            min_level: Some(min_level),
            pretty: std::io::stderr().is_terminal(),
            sink: Arc::new(|line| {
                let mut stderr = std::io::stderr().lock();
                let _ = writeln!(stderr, "{line}");
            }),
        }
    }

    pub fn silent() -> Self {
        Self {
            min_level: None,
            pretty: false,
            sink: Arc::new(|_| {}),
        }
    }

    #[track_caller]
    pub fn log(&self, level: LogLevel, fields: Value, message: &str) {
        let Some(min_level) = self.min_level else {
            return;
        };
        if level < min_level {
            return;
        }
        let fields = match mask(fields) {
            Value::Object(fields) => fields,
            _ => Map::new(),
        };
        let time = iso_now();
        if self.pretty {
            (self.sink)(&pretty_line(
                &time,
                level,
                Location::caller(),
                &fields,
                message,
            ));
            return;
        }
        let mut record = Map::new();
        record.insert("message".into(), json!(message));
        record.insert("level".into(), json!(level.name()));
        record.insert("levelId".into(), json!(level as u8));
        record.insert("time".into(), json!(time));
        record.extend(fields);
        record.insert(
            "_logMeta".into(),
            json!({
                "v": 5,
                "runtime": "rust",
                "runtimeVersion": crate::VERSION,
                "hostname": crate::platform::host::hostname(),
                "date": time,
                "logLevelId": level as u8,
                "logLevelName": level.name(),
                "name": crate::SERVICE_NAME,
            }),
        );
        (self.sink)(&Value::Object(record).to_string());
    }

    #[track_caller]
    pub fn info(&self, fields: Value, message: &str) {
        self.log(LogLevel::Info, fields, message);
    }

    #[track_caller]
    pub fn warn(&self, fields: Value, message: &str) {
        self.log(LogLevel::Warn, fields, message);
    }

    #[track_caller]
    pub fn error(&self, fields: Value, message: &str) {
        self.log(LogLevel::Error, fields, message);
    }
}

/// tslog's default pretty template with styling off, followed by
/// `util.formatWithOptions({ compact: false, depth: Infinity }, fields, message)`.
fn pretty_line(
    time: &str,
    level: LogLevel,
    location: &Location<'_>,
    fields: &Map<String, Value>,
    message: &str,
) -> String {
    let date = time.replacen('T', " ", 1).replacen('Z', "", 1);
    let file = location.file().replace('\\', "/");
    let file = file
        .find("/src/")
        .map_or(&*file, |index| &file[index + 1..]);
    let mut line = format!(
        "{date}\t{}\t{file}:{}\t{}\t",
        level.name(),
        location.line(),
        crate::SERVICE_NAME,
    );
    if !fields.is_empty() {
        inspect_object(fields, 0, &mut line);
        line.push(' ');
    }
    line.push_str(message);
    line
}

const INSPECT_BREAK_LENGTH: usize = 128;
const INSPECT_MIN_LINE_WIDTH: usize = 16;
const INSPECT_MAX_ARRAY_LENGTH: usize = 100;
const INSPECT_MAX_STRING_LENGTH: usize = 10_000;

fn inspect(value: &Value, level: usize, out: &mut String) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(value) => out.push_str(if *value { "true" } else { "false" }),
        Value::Number(number) => out.push_str(&js_number(number)),
        Value::String(text) => inspect_string(text, level, out),
        Value::Array(items) => {
            let shown = items.len().min(INSPECT_MAX_ARRAY_LENGTH);
            let mut entries: Vec<String> = items[..shown]
                .iter()
                .map(|item| {
                    let mut entry = String::new();
                    inspect(item, level + 2, &mut entry);
                    entry
                })
                .collect();
            let remaining = items.len() - shown;
            if remaining > 0 {
                entries.push(format!("... {remaining} more item{}", plural(remaining)));
            }
            write_container(['[', ']'], &entries, level, out);
        }
        Value::Object(object) => inspect_object(object, level, out),
    }
}

fn inspect_object(object: &Map<String, Value>, level: usize, out: &mut String) {
    let entries: Vec<String> = object
        .iter()
        .map(|(key, value)| {
            let mut entry = if is_identifier(key) {
                key.clone()
            } else {
                quote(key)
            };
            entry.push_str(": ");
            inspect(value, level + 2, &mut entry);
            entry
        })
        .collect();
    write_container(['{', '}'], &entries, level, out);
}

fn write_container(braces: [char; 2], entries: &[String], level: usize, out: &mut String) {
    out.push(braces[0]);
    if !entries.is_empty() {
        let indentation = format!("\n{}", " ".repeat(level));
        for (index, entry) in entries.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            out.push_str(&indentation);
            out.push_str("  ");
            out.push_str(entry);
        }
        out.push_str(&indentation);
    }
    out.push(braces[1]);
}

fn inspect_string(text: &str, level: usize, out: &mut String) {
    let length = utf16::len(text);
    let (text, trailer) = if length > INSPECT_MAX_STRING_LENGTH {
        let mut units = 0;
        let end = text
            .char_indices()
            .find(|(_, ch)| {
                units += ch.len_utf16();
                units > INSPECT_MAX_STRING_LENGTH
            })
            .map_or(text.len(), |(index, _)| index);
        let remaining = length - utf16::len(&text[..end]);
        (
            &text[..end],
            format!("... {remaining} more character{}", plural(remaining)),
        )
    } else {
        (text, String::new())
    };
    let shown = utf16::len(text);
    if shown > INSPECT_MIN_LINE_WIDTH && shown + level + 4 > INSPECT_BREAK_LENGTH {
        let separator = format!(" +\n{}", " ".repeat(level + 2));
        let pieces: Vec<String> = text.split_inclusive('\n').map(quote).collect();
        out.push_str(&pieces.join(&separator));
    } else {
        out.push_str(&quote(text));
    }
    out.push_str(&trailer);
}

/// Node's `strEscape`: prefer a quote that needs no escaping.
fn quote(text: &str) -> String {
    let quote = if !text.contains('\'') {
        '\''
    } else if !text.contains('"') {
        '"'
    } else if !text.contains('`') && !text.contains("${") {
        '`'
    } else {
        '\''
    };
    let mut out = String::with_capacity(text.len() + 2);
    out.push(quote);
    for ch in text.chars() {
        match ch {
            '\'' if quote == '\'' => out.push_str("\\'"),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            '\u{0}'..='\u{1f}' | '\u{7f}'..='\u{9f}' => {
                out.push_str(&format!("\\x{:02X}", ch as u32));
            }
            ch => out.push(ch),
        }
    }
    out.push(quote);
    out
}

fn is_identifier(key: &str) -> bool {
    let mut chars = key.chars();
    chars
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == '_')
        && chars.all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

/// `Number.prototype.toString`.
fn js_number(number: &serde_json::Number) -> String {
    if number.is_i64() || number.is_u64() {
        return number.to_string();
    }
    let value = number.as_f64().unwrap_or(0.0);
    let magnitude = value.abs();
    if magnitude != 0.0 && !(1e-6..1e21).contains(&magnitude) {
        let formatted = format!("{value:e}");
        return match formatted.split_once('e') {
            Some((mantissa, exponent)) if !exponent.starts_with('-') => {
                format!("{mantissa}e+{exponent}")
            }
            _ => formatted,
        };
    }
    if value.fract() == 0.0 {
        return format!("{value:.0}");
    }
    value.to_string()
}

fn plural(count: usize) -> &'static str {
    if count > 1 { "s" } else { "" }
}

fn mask(value: Value) -> Value {
    match value {
        Value::Object(object) => Value::Object(
            object
                .into_iter()
                .map(|(key, value)| {
                    let masked = if MASKED_KEYS.contains(&key.to_lowercase().as_str()) {
                        json!("[***]")
                    } else {
                        mask(value)
                    };
                    (key, masked)
                })
                .collect(),
        ),
        Value::Array(items) => Value::Array(items.into_iter().map(mask).collect()),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn writes_tslog_shaped_lines_and_masks_secrets() {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let logger = Logger {
            min_level: Some(LogLevel::Info),
            pretty: false,
            sink: Arc::new(move |line| sink.lock().unwrap().push(line.to_string())),
        };
        logger.log(LogLevel::Debug, json!({}), "hidden");
        logger.info(
            json!({ "port": 1, "secret": "s", "nested": { "Token": "x" } }),
            "hello",
        );
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 1);
        let record: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(record["message"], "hello");
        assert_eq!(record["level"], "INFO");
        assert_eq!(record["levelId"], 3);
        assert_eq!(record["port"], 1);
        assert_eq!(record["secret"], "[***]");
        assert_eq!(record["nested"]["Token"], "[***]");
        assert_eq!(record["_logMeta"]["name"], "klex-machine");
    }

    #[test]
    fn writes_tslog_pretty_lines_on_a_terminal() {
        let lines = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let logger = Logger {
            min_level: Some(LogLevel::Info),
            pretty: true,
            sink: Arc::new(move |line| sink.lock().unwrap().push(line.to_string())),
        };
        logger.info(json!({ "port": 1, "token": "x" }), "listening");
        logger.warn(json!({}), "plain");
        let lines = lines.lock().unwrap();
        let parts: Vec<&str> = lines[0].split('\t').collect();
        assert_eq!(parts.len(), 5);
        assert_eq!(parts[0].len(), "2026-11-26 17:12:43.883".len());
        assert!(!parts[0].contains(['T', 'Z']));
        assert_eq!(parts[1], "INFO");
        assert!(parts[2].starts_with("src/logger.rs:"), "{}", parts[2]);
        assert_eq!(parts[3], "klex-machine");
        assert_eq!(parts[4], "{\n  port: 1,\n  token: '[***]'\n} listening");
        assert_eq!(lines[1].split('\t').nth(4), Some("plain"));
    }

    fn inspected(value: Value) -> String {
        let mut out = String::new();
        inspect(&value, 0, &mut out);
        out
    }

    #[test]
    fn inspects_values_like_node() {
        // Expected strings are Node 26 `util.formatWithOptions({ compact: false,
        // depth: Infinity, colors: false }, value)` output.
        assert_eq!(
            inspected(json!({
                "a": "it's",
                "b-c": "x\"y'z",
                "z\u{1}": "\t\u{1b}\\",
                "n": 1.5,
                "i": 2,
                "big": 1e21,
                "neg": -3,
                "nul": null,
                "t": true,
                "e": {},
                "ea": [],
                "long": "line one is long enough\nline two is also long enough to break the width limit of the thing and more more more more more more more more",
            })),
            "{\n  a: \"it's\",\n  'b-c': `x\"y'z`,\n  'z\\x01': '\\t\\x1B\\\\',\n  n: 1.5,\n  i: 2,\n  big: 1e+21,\n  neg: -3,\n  nul: null,\n  t: true,\n  e: {},\n  ea: [],\n  long: 'line one is long enough\\n' +\n    'line two is also long enough to break the width limit of the thing and more more more more more more more more'\n}"
        );
        assert_eq!(
            inspected(json!({ "1a": 1, "_ok": 2, "$d": 3, "é": 4, "": 5 })),
            "{\n  '1a': 1,\n  _ok: 2,\n  '$d': 3,\n  'é': 4,\n  '': 5\n}"
        );
        assert_eq!(
            inspected(json!({ "s": "back`tick'\"q", "u": "\u{7f}\u{85}\u{2028}" })),
            "{\n  s: 'back`tick\\'\"q',\n  u: '\\x7F\\x85\u{2028}'\n}"
        );
        assert_eq!(
            inspected(json!({ "nested": { "arr": [{ "x": 1 }, [2, 3]], "deep": "short\nnl" } })),
            "{\n  nested: {\n    arr: [\n      {\n        x: 1\n      },\n      [\n        2,\n        3\n      ]\n    ],\n    deep: 'short\\nnl'\n  }\n}"
        );
        assert_eq!(inspected(json!(1.0)), "1");
        assert_eq!(inspected(json!(1e-7)), "1e-7");
        assert_eq!(inspected(json!(0.000_001)), "0.000001");
        let items: Vec<u32> = (0..102).collect();
        assert!(inspected(json!(items)).ends_with("  99,\n  ... 2 more items\n]"));
        assert!(inspected(json!("x".repeat(10_001))).ends_with("x'... 1 more character"));
    }
}
