//! Push notification events and the persistent pending store. The on-disk
//! format (`<dataDir>/notifications/state.json`, PID `lock`) is shared with
//! the TypeScript server so either can recover the other's state.

use std::collections::HashMap;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, LazyLock, Mutex as StdMutex};

use regex::Regex;
use serde_json::{Map, Value, json};
use tokio::sync::Mutex;

use crate::fs_error;
use crate::logger::Logger;
use crate::platform;
use crate::time::{iso, now_ms, parse_iso};
use crate::utf16;

pub const NOTIFICATION_SOURCE_ID: &str = "klex-machine";
pub const OUTPUT_TAIL_CHARACTERS: usize = 4096;
pub const MAX_PENDING_EVENTS_PER_PRINCIPAL: usize = 256;
pub const PENDING_EVENT_TTL_MS: i64 = 7 * 24 * 60 * 60 * 1000;
pub const MAX_TRANSIENT_EVENTS_PER_PRINCIPAL: usize = 32;
const MAX_PAGE_SIZE: f64 = 1000.0;
const DEFAULT_PAGE_SIZE: f64 = 100.0;
const STATE_VERSION: u64 = 1;

static ANSI: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"(?:\x1b[\]PX^_]|[\x{90}\x{98}\x{9d}-\x{9f}])(?s:.)*?(?:\x07|\x1b\\|\x{9c}|$)|(?:\x1b\[|\x{9b})[0-?]*[ -/]*[@-~]|\x1b[@-Z\\-_]|\x{9c}",
    )
    .expect("valid ANSI pattern")
});

pub fn strip_ansi(text: &str) -> String {
    ANSI.replace_all(text, "").into_owned()
}

pub fn tail(text: &str) -> (String, bool) {
    let tailed = utf16::tail(text, OUTPUT_TAIL_CHARACTERS);
    (tailed.to_string(), tailed.len() != text.len())
}

pub fn format_duration(milliseconds: i64) -> String {
    let total = ((milliseconds as f64) / 1000.0).round().max(0.0) as i64;
    let (days, hours, minutes, seconds) = (
        total / 86_400,
        (total % 86_400) / 3600,
        (total % 3600) / 60,
        total % 60,
    );
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if seconds > 0 || parts.is_empty() {
        parts.push(format!("{seconds}s"));
    }
    parts.concat()
}

fn with_output(summary: String, output: &str) -> String {
    if output.is_empty() {
        summary
    } else {
        format!("{summary}\n\nLast output:\n{output}")
    }
}

fn notification(
    event_id: String,
    kind: &str,
    created_at: &str,
    text: String,
    data: Value,
) -> Value {
    json!({
        "eventId": event_id,
        "sourceId": NOTIFICATION_SOURCE_ID,
        "type": kind,
        "createdAt": created_at,
        "content": [{ "type": "text", "text": text }],
        "data": data,
    })
}

static DESKTOP_BOOT_ID: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());

pub fn desktop_control_changed_event(change: &crate::desktop::lease::ControlChange) -> Value {
    use crate::desktop::lease::ControlMode;
    let state = &change.state;
    let text = match state.mode {
        ControlMode::Human => format!(
            "{} took control of the desktop. Desktop input tools are paused until control returns; screenshots still work.",
            state.holder.as_deref().unwrap_or("A person")
        ),
        ControlMode::Agent => "Control of the desktop returned to you. Take a fresh screenshot before acting; the screen may have changed.".to_string(),
    };
    notification(
        format!("desktop:control:{}:{}", *DESKTOP_BOOT_ID, change.sequence),
        "desktop.control_changed",
        &change.changed_at,
        text,
        json!({
            "mode": state.mode.as_str(),
            "holder": state.holder,
            "expiresAt": state.expires_at,
            "reason": change.reason.as_str(),
        }),
    )
}

fn field<'a>(info: &'a Value, name: &str) -> &'a str {
    info.get(name).and_then(Value::as_str).unwrap_or_default()
}

pub struct WatcherCompletion {
    pub outcome: &'static str,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub finished_at: String,
    pub output: String,
}

pub fn watcher_completed_event(info: &Value, completion: &WatcherCompletion) -> Value {
    let (output, truncated) = tail(&strip_ansi(&completion.output));
    let started = parse_iso(field(info, "createdAt")).unwrap_or(0);
    let finished = parse_iso(&completion.finished_at).unwrap_or(started);
    let duration = format_duration(finished - started);
    let status = match completion.outcome {
        "condition_met" => "condition met".to_string(),
        "timed_out" => "timed out".to_string(),
        _ => match (&completion.signal, completion.exit_code) {
            (Some(signal), _) => format!("failed (signal {signal})"),
            (None, Some(code)) => format!("failed (exit {code})"),
            (None, None) => "failed (exit unknown)".to_string(),
        },
    };
    let watcher_id = field(info, "watcherId");
    notification(
        format!("watcher:{watcher_id}:completed"),
        "watcher.completed",
        &completion.finished_at,
        with_output(
            format!(
                "Watcher \"{}\" {status} after {duration}.",
                field(info, "title")
            ),
            &output,
        ),
        json!({
            "watcherId": watcher_id,
            "title": field(info, "title"),
            "command": field(info, "command"),
            "cwd": field(info, "cwd"),
            "outcome": completion.outcome,
            "exitCode": completion.exit_code,
            "signal": completion.signal,
            "createdAt": field(info, "createdAt"),
            "finishedAt": completion.finished_at,
            "outputTail": output,
            "outputTruncated": truncated,
        }),
    )
}

pub fn watcher_lost_event(info: &Value, lost_at: &str) -> Value {
    let watcher_id = field(info, "watcherId");
    notification(
        format!("watcher:{watcher_id}:lost"),
        "watcher.lost",
        lost_at,
        format!(
            "Watcher \"{}\" was lost because klex-machine restarted; it will not fire. Recreate it if still needed.",
            field(info, "title")
        ),
        json!({
            "watcherId": watcher_id,
            "title": field(info, "title"),
            "command": field(info, "command"),
            "cwd": field(info, "cwd"),
            "createdAt": field(info, "createdAt"),
            "lostAt": lost_at,
        }),
    )
}

pub struct ShellExit {
    pub exit_code: Option<i64>,
    pub signal: Option<i64>,
    pub exited_at: String,
    pub output: String,
}

pub fn shell_exited_event(info: &Value, exit: &ShellExit) -> Value {
    let (output, truncated) = tail(&strip_ansi(&exit.output));
    let status = match exit.signal {
        Some(signal) if signal != 0 => format!("signal {signal}"),
        _ => match exit.exit_code {
            Some(code) => format!("code {code}"),
            None => "code unknown".to_string(),
        },
    };
    let session_id = field(info, "sessionId");
    notification(
        format!("shell:{session_id}:exited"),
        "shell.exited",
        &exit.exited_at,
        with_output(
            format!("Shell session {session_id} exited ({status})."),
            &output,
        ),
        json!({
            "sessionId": session_id,
            "shell": field(info, "shell"),
            "cwd": field(info, "cwd"),
            "exitCode": exit.exit_code,
            "signal": exit.signal,
            "createdAt": field(info, "createdAt"),
            "exitedAt": exit.exited_at,
            "outputTail": output,
            "outputTruncated": truncated,
        }),
    )
}

pub fn shell_lost_event(info: &Value, lost_at: &str) -> Value {
    let session_id = field(info, "sessionId");
    notification(
        format!("shell:{session_id}:lost"),
        "shell.lost",
        lost_at,
        format!("Shell session {session_id} was lost because klex-machine restarted."),
        json!({
            "sessionId": session_id,
            "shell": field(info, "shell"),
            "cwd": field(info, "cwd"),
            "createdAt": field(info, "createdAt"),
            "lostAt": lost_at,
        }),
    )
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum RecordKind {
    Watcher,
    Shell,
}

impl RecordKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Watcher => "watcher",
            Self::Shell => "shell",
        }
    }
}

#[derive(Clone, Debug)]
pub struct TrackedItem {
    pub id: String,
    pub principal_id: String,
    pub kind: RecordKind,
    pub info: Value,
}

#[derive(Clone, Debug)]
pub struct NotificationRecord {
    pub item: TrackedItem,
    /// `None` while running, the pending event once complete.
    pub event: Option<Value>,
}

impl NotificationRecord {
    fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), json!(self.item.id));
        object.insert("principalId".into(), json!(self.item.principal_id));
        object.insert("kind".into(), json!(self.item.kind.as_str()));
        object.insert("info".into(), self.item.info.clone());
        match &self.event {
            None => {
                object.insert("state".into(), json!("running"));
            }
            Some(event) => {
                object.insert("state".into(), json!("pending"));
                object.insert("event".into(), event.clone());
            }
        }
        Value::Object(object)
    }

    fn from_json(value: &Value) -> Option<Self> {
        let object = value.as_object()?;
        let info = object.get("info").filter(|info| info.is_object())?;
        let id = object.get("id")?.as_str()?;
        let principal_id = object.get("principalId")?.as_str()?;
        let (kind, fields): (RecordKind, &[&str]) = match object.get("kind")?.as_str()? {
            "watcher" => (
                RecordKind::Watcher,
                &[
                    "watcherId",
                    "title",
                    "command",
                    "cwd",
                    "createdAt",
                    "deadlineAt",
                ],
            ),
            "shell" => (
                RecordKind::Shell,
                &["sessionId", "shell", "cwd", "createdAt"],
            ),
            _ => return None,
        };
        if !fields
            .iter()
            .all(|name| info.get(*name).is_some_and(Value::is_string))
        {
            return None;
        }
        parse_iso(field(info, "createdAt"))?;
        let item = TrackedItem {
            id: id.into(),
            principal_id: principal_id.into(),
            kind,
            info: info.clone(),
        };
        match object.get("state")?.as_str()? {
            "running" => Some(Self { item, event: None }),
            "pending" => {
                let event = object.get("event").filter(|event| event.is_object())?;
                let valid = ["eventId", "createdAt", "type", "sourceId"]
                    .iter()
                    .all(|name| event.get(*name).is_some_and(Value::is_string))
                    && parse_iso(field(event, "createdAt")).is_some()
                    && event.get("content").is_some_and(Value::is_array);
                valid.then(|| Self {
                    item,
                    event: Some(event.clone()),
                })
            }
            _ => None,
        }
    }
}

pub type Listener = Arc<dyn Fn(Value) + Send + Sync>;

#[derive(Debug)]
pub struct StoreError(pub String);

impl std::fmt::Display for StoreError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

struct Inner {
    records: indexmap::IndexMap<String, NotificationRecord>,
    transient: HashMap<String, Vec<Value>>,
    lock_path: Option<PathBuf>,
    closed: bool,
}

pub struct NotificationStore {
    directory: Option<PathBuf>,
    logger: Logger,
    now: Box<dyn Fn() -> i64 + Send + Sync>,
    inner: Mutex<Inner>,
    listeners: StdMutex<HashMap<String, Vec<(u64, Listener)>>>,
    next_listener: AtomicU64,
}

impl NotificationStore {
    /// Persists to `<data_dir>/notifications/`; memory-only without one.
    pub fn new(data_dir: Option<&Path>, logger: Logger) -> Self {
        Self::with_clock(data_dir, logger, Box::new(now_ms))
    }

    pub fn with_clock(
        data_dir: Option<&Path>,
        logger: Logger,
        now: Box<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            directory: data_dir.map(|directory| directory.join("notifications")),
            logger,
            now,
            inner: Mutex::new(Inner {
                records: indexmap::IndexMap::new(),
                transient: HashMap::new(),
                lock_path: None,
                closed: false,
            }),
            listeners: StdMutex::new(HashMap::new()),
            next_listener: AtomicU64::new(1),
        }
    }

    pub async fn persistent(&self) -> bool {
        self.inner.lock().await.lock_path.is_some()
    }

    /// Acquires the state lock, loads persisted records and turns records
    /// left running by a previous process into `*.lost` events.
    pub async fn ready(&self) -> Result<(), StoreError> {
        let Some(directory) = self.directory.clone() else {
            return Ok(());
        };
        let mut inner = self.inner.lock().await;
        create_private_dir_all(&directory)
            .map_err(|error| StoreError(fs_error::message(&error, "mkdir", &directory)))?;
        let Some(lock_path) = self.acquire_lock(&directory)? else {
            return Ok(());
        };
        inner.lock_path = Some(lock_path.clone());
        let result = (|| {
            self.load(&mut inner, &directory)?;
            let lost_at = iso((self.now)());
            for record in inner.records.values_mut() {
                if record.event.is_some() {
                    continue;
                }
                record.event = Some(match record.item.kind {
                    RecordKind::Watcher => watcher_lost_event(&record.item.info, &lost_at),
                    RecordKind::Shell => shell_lost_event(&record.item.info, &lost_at),
                });
            }
            self.drop_expired(&mut inner);
            self.persist(&inner)
        })();
        if let Err(error) = result {
            let _ = fs::remove_file(&lock_path);
            inner.lock_path = None;
            return Err(error);
        }
        Ok(())
    }

    pub async fn track(&self, item: TrackedItem) -> Result<(), StoreError> {
        let mut inner = self.open().await?;
        self.drop_expired(&mut inner);
        if inner.records.contains_key(&item.id) {
            return Err(StoreError(format!(
                "Duplicate notification record: {}",
                item.id
            )));
        }
        if pending_for(&inner, &item.principal_id, false).len() >= MAX_PENDING_EVENTS_PER_PRINCIPAL
        {
            return Err(StoreError("Too many unacknowledged notifications".into()));
        }
        let id = item.id.clone();
        inner
            .records
            .insert(id.clone(), NotificationRecord { item, event: None });
        if let Err(error) = self.persist(&inner) {
            inner.records.shift_remove(&id);
            return Err(error);
        }
        Ok(())
    }

    /// Moves a running record to pending, persists, then notifies listeners.
    pub async fn complete(&self, id: &str, event: Value) -> Result<(), StoreError> {
        let mut inner = self.open().await?;
        let Some(record) = inner.records.get_mut(id) else {
            return Ok(());
        };
        if record.event.is_some() {
            return Ok(());
        }
        record.event = Some(event.clone());
        let principal = record.item.principal_id.clone();
        if let Err(error) = self.persist(&inner) {
            self.logger.error(
                json!({ "eventId": event.get("eventId"), "error": error.0 }),
                "Failed to persist notification",
            );
            return Ok(());
        }
        drop(inner);
        self.notify(&principal, &event);
        Ok(())
    }

    /// Queues an event that only matters while this process runs.
    pub async fn publish(&self, principal_id: &str, event: Value) -> Result<(), StoreError> {
        let mut inner = self.open().await?;
        let events = inner.transient.entry(principal_id.to_string()).or_default();
        events.push(event.clone());
        if events.len() > MAX_TRANSIENT_EVENTS_PER_PRINCIPAL {
            events.remove(0);
        }
        drop(inner);
        self.notify(principal_id, &event);
        Ok(())
    }

    pub async fn forget(&self, id: &str) -> Result<(), StoreError> {
        let mut inner = self.open().await?;
        let Some(index) = inner.records.get_index_of(id) else {
            return Ok(());
        };
        let (key, record) = inner
            .records
            .shift_remove_index(index)
            .expect("index exists");
        if let Err(error) = self.persist(&inner) {
            let index = index.min(inner.records.len());
            inner.records.shift_insert(index, key, record);
            return Err(error);
        }
        Ok(())
    }

    pub async fn pending(
        &self,
        principal_id: &str,
        limit: Option<f64>,
    ) -> Result<Value, StoreError> {
        let mut inner = self.open().await?;
        self.drop_expired_and_persist(&mut inner);
        let size = limit
            .unwrap_or(DEFAULT_PAGE_SIZE)
            .floor()
            .clamp(1.0, MAX_PAGE_SIZE) as usize;
        let events = pending_for(&inner, principal_id, true);
        let has_more = events.len() > size;
        let page: Vec<Value> = events.into_iter().take(size).collect();
        Ok(json!({ "events": page, "hasMore": has_more }))
    }

    pub async fn acknowledge(
        &self,
        principal_id: &str,
        event_ids: &[String],
    ) -> Result<(), StoreError> {
        let mut inner = self.open().await?;
        let ids: std::collections::HashSet<&str> = event_ids.iter().map(String::as_str).collect();
        if let Some(transient) = inner.transient.get_mut(principal_id) {
            transient.retain(|event| !ids.contains(field(event, "eventId")));
            if transient.is_empty() {
                inner.transient.remove(principal_id);
            }
        }
        let before = inner.records.clone();
        inner.records.retain(|_, record| {
            !(record.item.principal_id == principal_id
                && record
                    .event
                    .as_ref()
                    .is_some_and(|event| ids.contains(field(event, "eventId"))))
        });
        if inner.records.len() != before.len()
            && let Err(error) = self.persist(&inner)
        {
            inner.records = before;
            return Err(error);
        }
        Ok(())
    }

    pub async fn records(&self, principal_id: &str) -> Vec<NotificationRecord> {
        let inner = self.inner.lock().await;
        inner
            .records
            .values()
            .filter(|record| record.item.principal_id == principal_id)
            .cloned()
            .collect()
    }

    pub fn on_event(
        self: &Arc<Self>,
        principal_id: &str,
        listener: Listener,
    ) -> impl FnOnce() + Send + 'static {
        let id = self.next_listener.fetch_add(1, Ordering::Relaxed);
        self.listeners
            .lock()
            .unwrap()
            .entry(principal_id.to_string())
            .or_default()
            .push((id, listener));
        let store = Arc::downgrade(self);
        let principal = principal_id.to_string();
        move || {
            if let Some(store) = store.upgrade() {
                let mut listeners = store.listeners.lock().unwrap();
                if let Some(entries) = listeners.get_mut(&principal) {
                    entries.retain(|(candidate, _)| *candidate != id);
                    if entries.is_empty() {
                        listeners.remove(&principal);
                    }
                }
            }
        }
    }

    /// Fails like `rm(lockPath, { force: true })` when the lock cannot be removed.
    pub async fn close(&self) -> Result<(), String> {
        let mut inner = self.inner.lock().await;
        if inner.closed {
            return Ok(());
        }
        inner.closed = true;
        self.listeners.lock().unwrap().clear();
        inner.transient.clear();
        let Some(lock_path) = inner.lock_path.take() else {
            return Ok(());
        };
        match fs::remove_file(&lock_path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(error) => Err(format!(
                "Failed to remove {}: {error}",
                crate::paths::display(&lock_path)
            )),
        }
    }

    async fn open(&self) -> Result<tokio::sync::MutexGuard<'_, Inner>, StoreError> {
        let inner = self.inner.lock().await;
        if inner.closed {
            return Err(StoreError("Notification store is closed".into()));
        }
        Ok(inner)
    }

    fn notify(&self, principal_id: &str, event: &Value) {
        let listeners: Vec<Listener> = self
            .listeners
            .lock()
            .unwrap()
            .get(principal_id)
            .map(|entries| {
                entries
                    .iter()
                    .map(|(_, listener)| listener.clone())
                    .collect()
            })
            .unwrap_or_default();
        for listener in listeners {
            listener(event.clone());
        }
    }

    fn acquire_lock(&self, directory: &Path) -> Result<Option<PathBuf>, StoreError> {
        let lock_path = directory.join("lock");
        match write_lock(&lock_path) {
            Ok(()) => return Ok(Some(lock_path)),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
            Err(error) => return Err(StoreError(fs_error::message(&error, "open", &lock_path))),
        }
        let lock = match fs::read_to_string(&lock_path) {
            Ok(lock) => lock,
            Err(error) if fs_error::is(&error, "ENOENT") => return self.retry_lock(&lock_path),
            Err(error) => return Err(StoreError(fs_error::message(&error, "open", &lock_path))),
        };
        let holder = parse_pid(&lock);
        if holder.is_none_or(platform::process::process_alive) {
            self.logger.warn(
                json!({ "lockPath": lock_path.to_string_lossy(), "pid": holder }),
                "Notification state is locked or its owner is unknown; notifications are memory-only",
            );
            return Ok(None);
        }
        let holder = holder.expect("checked above");
        let recovery_path = directory.join("lock-recovery");
        if let Err(error) = create_private_dir(&recovery_path) {
            if error.kind() != std::io::ErrorKind::AlreadyExists {
                return Err(StoreError(fs_error::message(
                    &error,
                    "mkdir",
                    &recovery_path,
                )));
            }
            self.logger.warn(
                json!({ "recoveryPath": recovery_path.to_string_lossy() }),
                "Notification lock recovery is locked; notifications are memory-only",
            );
            return Ok(None);
        }
        let result = (|| {
            let current = match fs::read_to_string(&lock_path) {
                Ok(current) => current,
                Err(error) if fs_error::is(&error, "ENOENT") => return self.retry_lock(&lock_path),
                Err(error) => {
                    return Err(StoreError(fs_error::message(&error, "open", &lock_path)));
                }
            };
            if current == lock && !platform::process::process_alive(holder) {
                let _ = fs::remove_file(&lock_path);
                match write_lock(&lock_path) {
                    Ok(()) => return Ok(Some(lock_path.clone())),
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                    Err(error) => {
                        return Err(StoreError(fs_error::message(&error, "open", &lock_path)));
                    }
                }
            }
            self.logger.warn(
                json!({ "lockPath": lock_path.to_string_lossy() }),
                "Could not acquire notification state lock; notifications are memory-only",
            );
            Ok(None)
        })();
        let _ = fs::remove_dir_all(&recovery_path);
        result
    }

    fn retry_lock(&self, lock_path: &Path) -> Result<Option<PathBuf>, StoreError> {
        match write_lock(lock_path) {
            Ok(()) => Ok(Some(lock_path.to_path_buf())),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.logger.warn(
                    json!({ "lockPath": lock_path.to_string_lossy() }),
                    "Notification lock changed owners; notifications are memory-only",
                );
                Ok(None)
            }
            Err(error) => Err(StoreError(fs_error::message(&error, "open", lock_path))),
        }
    }

    fn load(&self, inner: &mut Inner, directory: &Path) -> Result<(), StoreError> {
        let path = directory.join("state.json");
        let text = match fs::read_to_string(&path) {
            Ok(text) => text,
            Err(error) if fs_error::is(&error, "ENOENT") => return Ok(()),
            Err(error) => return Err(StoreError(fs_error::message(&error, "open", &path))),
        };
        let parsed = serde_json::from_str::<Value>(&text)
            .map_err(|error| error.to_string())
            .and_then(|parsed| {
                let records = parsed
                    .as_object()
                    .filter(|object| object.get("version") == Some(&json!(STATE_VERSION)))
                    .and_then(|object| object.get("records"))
                    .and_then(Value::as_array)
                    .ok_or("Unsupported notification state format")?;
                records
                    .iter()
                    .map(|record| {
                        NotificationRecord::from_json(record)
                            .ok_or_else(|| "Invalid notification record".to_string())
                    })
                    .collect::<Result<Vec<_>, _>>()
            });
        match parsed {
            Ok(records) => {
                for record in records {
                    inner.records.insert(record.item.id.clone(), record);
                }
            }
            Err(error) => {
                inner.records.clear();
                let quarantine =
                    PathBuf::from(format!("{}.corrupt-{}", path.display(), (self.now)()));
                fs::rename(&path, &quarantine).map_err(|rename| {
                    StoreError(fs_error::message2(&rename, "rename", &path, &quarantine))
                })?;
                self.logger.error(
                    json!({ "path": path.to_string_lossy(), "quarantine": quarantine.to_string_lossy(), "error": error }),
                    "Notification state is corrupt; starting empty",
                );
            }
        }
        Ok(())
    }

    fn persist(&self, inner: &Inner) -> Result<(), StoreError> {
        let Some(lock_path) = &inner.lock_path else {
            return Ok(());
        };
        let directory = lock_path
            .parent()
            .expect("lock lives in the state directory");
        let records: Vec<Value> = inner
            .records
            .values()
            .map(NotificationRecord::to_json)
            .collect();
        let snapshot = format!(
            "{}\n",
            serde_json::to_string_pretty(&json!({ "version": STATE_VERSION, "records": records }))
                .expect("serializable state")
        );
        write_state(&directory.join("state.json"), &snapshot).map_err(StoreError)
    }

    fn drop_expired(&self, inner: &mut Inner) -> bool {
        let cutoff = (self.now)() - PENDING_EVENT_TTL_MS;
        let mut changed = false;
        let logger = &self.logger;
        inner.records.retain(|_, record| {
            let Some(event) = &record.event else { return true };
            if parse_iso(field(event, "createdAt")).is_some_and(|created| created >= cutoff) {
                return true;
            }
            changed = true;
            logger.warn(
                json!({ "eventId": event.get("eventId"), "type": event.get("type"), "principalId": record.item.principal_id }),
                "Dropped unacknowledged notification older than 7 days",
            );
            false
        });
        changed
    }

    fn drop_expired_and_persist(&self, inner: &mut Inner) {
        if self.drop_expired(inner)
            && let Err(error) = self.persist(inner)
        {
            self.logger.error(
                json!({ "error": error.0 }),
                "Failed to persist notification state",
            );
        }
    }
}

fn pending_for(inner: &Inner, principal_id: &str, include_transient: bool) -> Vec<Value> {
    let mut events: Vec<Value> = inner
        .records
        .values()
        .filter(|record| record.item.principal_id == principal_id)
        .filter_map(|record| record.event.clone())
        .collect();
    if include_transient && let Some(transient) = inner.transient.get(principal_id) {
        events.extend(transient.iter().cloned());
    }
    events.sort_by(|left, right| field(left, "createdAt").cmp(field(right, "createdAt")));
    events
}

fn parse_pid(lock: &str) -> Option<u32> {
    let digits = lock.strip_suffix('\n')?;
    if digits.is_empty()
        || digits.starts_with('0')
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    digits.parse::<u32>().ok().filter(|pid| *pid > 0)
}

fn write_lock(path: &Path) -> std::io::Result<()> {
    let mut file = private_file(path)?;
    if let Err(error) = file.write_all(format!("{}\n", std::process::id()).as_bytes()) {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error);
    }
    Ok(())
}

fn write_state(path: &Path, snapshot: &str) -> Result<(), String> {
    let temporary = PathBuf::from(format!(
        "{}.{}.{}.tmp",
        path.display(),
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    let result = (|| {
        let mut file = private_file(&temporary)
            .map_err(|error| fs_error::message(&error, "open", &temporary))?;
        file.write_all(snapshot.as_bytes())
            .map_err(|error| fs_error::message(&error, "write", &temporary))?;
        drop(file);
        platform::fs::chmod(&temporary, 0o600)
            .map_err(|error| fs_error::message(&error, "chmod", &temporary))?;
        fs::rename(&temporary, path)
            .map_err(|error| fs_error::message2(&error, "rename", &temporary, path))
    })();
    let _ = fs::remove_file(&temporary);
    result
}

fn private_file(path: &Path) -> std::io::Result<fs::File> {
    platform::fs::create_new_file(path, 0o600)
}

fn create_private_dir(path: &Path) -> std::io::Result<()> {
    platform::fs::create_dir(path, 0o700)
}

pub(crate) fn create_private_dir_all(path: &Path) -> std::io::Result<()> {
    platform::fs::create_dir_all(path, 0o700)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn formats_durations_and_strips_ansi() {
        assert_eq!(format_duration(0), "0s");
        assert_eq!(format_duration(61_400), "1m1s");
        assert_eq!(format_duration(90_061_000), "1d1h1m1s");
        assert_eq!(format_duration(3_600_000), "1h");
        assert_eq!(
            strip_ansi("\u{1b}[31mred\u{1b}[0m \u{1b}]0;title\u{7}ok"),
            "red ok"
        );
    }

    #[test]
    fn parses_lock_pids_strictly() {
        assert_eq!(parse_pid("123\n"), Some(123));
        assert_eq!(parse_pid("0123\n"), None);
        assert_eq!(parse_pid("123"), None);
        assert_eq!(parse_pid("\n"), None);
    }
}
