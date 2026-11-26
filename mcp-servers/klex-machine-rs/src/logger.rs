//! JSON log lines on stderr in the shape tslog writes for the TS server.

use std::io::Write;
use std::sync::Arc;

use serde_json::{Map, Value, json};

use crate::time::iso_now;

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
    sink: Arc<dyn Fn(&str) + Send + Sync>,
}

impl Logger {
    pub fn stderr(min_level: LogLevel) -> Self {
        Self {
            min_level: Some(min_level),
            sink: Arc::new(|line| {
                let mut stderr = std::io::stderr().lock();
                let _ = writeln!(stderr, "{line}");
            }),
        }
    }

    pub fn silent() -> Self {
        Self {
            min_level: None,
            sink: Arc::new(|_| {}),
        }
    }

    pub fn log(&self, level: LogLevel, fields: Value, message: &str) {
        let Some(min_level) = self.min_level else {
            return;
        };
        if level < min_level {
            return;
        }
        let time = iso_now();
        let mut record = Map::new();
        record.insert("message".into(), json!(message));
        record.insert("level".into(), json!(level.name()));
        record.insert("levelId".into(), json!(level as u8));
        record.insert("time".into(), json!(time));
        if let Value::Object(fields) = fields {
            for (key, value) in fields {
                record.insert(key, mask(value));
            }
        }
        record.insert(
            "_logMeta".into(),
            json!({
                "v": 5,
                "runtime": "rust",
                "runtimeVersion": crate::VERSION,
                "hostname": hostname(),
                "date": time,
                "logLevelId": level as u8,
                "logLevelName": level.name(),
                "name": crate::SERVICE_NAME,
            }),
        );
        (self.sink)(&Value::Object(record).to_string());
    }

    pub fn info(&self, fields: Value, message: &str) {
        self.log(LogLevel::Info, fields, message);
    }

    pub fn warn(&self, fields: Value, message: &str) {
        self.log(LogLevel::Warn, fields, message);
    }

    pub fn error(&self, fields: Value, message: &str) {
        self.log(LogLevel::Error, fields, message);
    }
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

fn hostname() -> String {
    #[cfg(unix)]
    {
        let mut buffer = [0u8; 256];
        // SAFETY: the buffer is valid for its length and NUL-terminated on success.
        let result = unsafe { libc::gethostname(buffer.as_mut_ptr().cast(), buffer.len()) };
        if result == 0 {
            let end = buffer
                .iter()
                .position(|byte| *byte == 0)
                .unwrap_or(buffer.len());
            return String::from_utf8_lossy(&buffer[..end]).into_owned();
        }
        String::new()
    }
    #[cfg(not(unix))]
    {
        std::env::var("COMPUTERNAME").unwrap_or_default()
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
            sink: Arc::new(move |line| sink.lock().unwrap().push(line.to_string())),
        };
        logger.log(LogLevel::Debug, json!({}), "hidden");
        logger.info(json!({ "port": 1, "nested": { "Token": "x" } }), "hello");
        let lines = lines.lock().unwrap();
        assert_eq!(lines.len(), 1);
        let record: Value = serde_json::from_str(&lines[0]).unwrap();
        assert_eq!(record["message"], "hello");
        assert_eq!(record["level"], "INFO");
        assert_eq!(record["levelId"], 3);
        assert_eq!(record["port"], 1);
        assert_eq!(record["nested"]["Token"], "[***]");
        assert_eq!(record["_logMeta"]["name"], "klex-machine");
    }
}
