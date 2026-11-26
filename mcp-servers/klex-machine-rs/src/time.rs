use std::time::{SystemTime, UNIX_EPOCH};

use chrono::{DateTime, NaiveDate, NaiveDateTime, SecondsFormat, Utc};

pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// `Date.prototype.toISOString`.
pub fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}

pub fn iso_now() -> String {
    iso(now_ms())
}

pub fn iso_from_system_time(time: SystemTime) -> String {
    let ms = match time.duration_since(UNIX_EPOCH) {
        Ok(duration) => duration.as_millis() as i64,
        Err(error) => -(error.duration().as_millis() as i64),
    };
    iso(ms)
}

/// `Date.parse` for the ISO 8601 forms klex-machine writes and reads.
pub fn parse_iso(value: &str) -> Option<i64> {
    if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        return Some(parsed.timestamp_millis());
    }
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M:%S%.f") {
        return Some(parsed.and_utc().timestamp_millis());
    }
    if let Ok(parsed) = NaiveDateTime::parse_from_str(value, "%Y-%m-%dT%H:%M") {
        return Some(parsed.and_utc().timestamp_millis());
    }
    NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .ok()
        .and_then(|date| date.and_hms_opt(0, 0, 0))
        .map(|date| date.and_utc().timestamp_millis())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_like_javascript() {
        assert_eq!(iso(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso(1_795_000_000_123), "2026-11-18T11:06:40.123Z");
        assert_eq!(
            parse_iso("2026-11-18T11:06:40.123Z"),
            Some(1_795_000_000_123)
        );
        assert_eq!(parse_iso("nope"), None);
    }
}
