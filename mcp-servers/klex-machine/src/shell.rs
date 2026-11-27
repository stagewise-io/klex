//! Persistent PTY sessions with node-pty's observable behaviour.

use std::future::Future;
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio::sync::{Notify, watch};

use crate::paths::{MachinePathResolver, display};
use crate::platform::pty::{self, Pty, SpawnOptions};
use crate::time::iso_now;
use crate::utf16::Utf8Decoder;

const MAX_BUFFER_UNITS: usize = 1024 * 1024;
const MAX_READ_UNITS: usize = 256 * 1024;
pub const MAX_SHELL_SESSIONS: usize = 32;

#[derive(Clone, Debug)]
pub struct ShellInfo {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub pid: u32,
    pub running: bool,
    pub exit_code: Option<i64>,
    pub signal: Option<i64>,
    pub created_at: String,
}

impl ShellInfo {
    /// Exit fields are assigned after creation, so they follow `createdAt`.
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), json!(self.id));
        object.insert("shell".into(), json!(self.shell));
        object.insert("cwd".into(), json!(self.cwd));
        object.insert("pid".into(), json!(self.pid));
        object.insert("running".into(), json!(self.running));
        object.insert("createdAt".into(), json!(self.created_at));
        if let Some(exit_code) = self.exit_code {
            object.insert("exitCode".into(), json!(exit_code));
        }
        if let Some(signal) = self.signal {
            object.insert("signal".into(), json!(signal));
        }
        Value::Object(object)
    }
}

#[derive(Clone, Debug)]
pub struct Reservation {
    pub id: String,
    pub shell: String,
    pub cwd: String,
    pub created_at: String,
}

#[derive(Default, Clone)]
pub struct CreateOptions {
    pub cwd: Option<String>,
    pub shell: Option<String>,
    pub args: Option<Vec<String>>,
    pub cols: Option<f64>,
    pub rows: Option<f64>,
    pub env: Option<IndexMap<String, String>>,
}

pub struct ReadOptions {
    pub id: String,
    pub cursor: Option<f64>,
    pub wait_ms: Option<f64>,
}

pub type ExitHook = Arc<dyn Fn(ShellInfo, String) + Send + Sync>;

struct Buffer {
    output: Vec<u16>,
    start: usize,
    end: usize,
}

struct Session {
    info: Mutex<ShellInfo>,
    buffer: Mutex<Buffer>,
    changed: Notify,
    pty: Box<dyn Pty>,
    closing: AtomicBool,
}

impl Session {
    fn info(&self) -> ShellInfo {
        lock(&self.info).clone()
    }

    fn append(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        {
            let mut buffer = lock(&self.buffer);
            let units: Vec<u16> = text.encode_utf16().collect();
            buffer.end += units.len();
            buffer.output.extend_from_slice(&units);
            if buffer.output.len() > MAX_BUFFER_UNITS {
                let remove = buffer.output.len() - MAX_BUFFER_UNITS;
                buffer.output.drain(..remove);
                buffer.start += remove;
            }
        }
        self.changed.notify_waiters();
    }

    fn output(&self) -> String {
        String::from_utf16_lossy(&lock(&self.buffer).output)
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

struct Inner {
    sessions: IndexMap<String, Arc<Session>>,
    closed: bool,
    /// Creations that passed the capacity check but have not inserted yet.
    pending: usize,
    /// Exited sessions that pending creations will replace.
    evicting: Vec<String>,
}

/// A capacity reservation for one `create`, released when it is dropped.
struct Slot<'a> {
    inner: &'a Mutex<Inner>,
    exited: Option<String>,
}

impl Drop for Slot<'_> {
    fn drop(&mut self) {
        let mut inner = lock(self.inner);
        inner.pending -= 1;
        if let Some(id) = &self.exited {
            inner.evicting.retain(|evicting| evicting != id);
        }
    }
}

pub struct ShellService {
    paths: MachinePathResolver,
    max_sessions: usize,
    on_exit: Option<ExitHook>,
    inner: Mutex<Inner>,
    startups: watch::Sender<usize>,
}

fn valid_dimension(value: f64, name: &str) -> Result<u16, String> {
    if value.fract() != 0.0 || !(1.0..=1000.0).contains(&value) {
        return Err(format!("{name} must be an integer from 1 to 1000"));
    }
    Ok(value as u16)
}

impl ShellService {
    pub fn new(paths: MachinePathResolver, max_sessions: usize, on_exit: Option<ExitHook>) -> Self {
        assert!(max_sessions >= 1, "maxSessions must be a positive integer");
        Self {
            paths,
            max_sessions,
            on_exit,
            inner: Mutex::new(Inner {
                sessions: IndexMap::new(),
                closed: false,
                pending: 0,
                evicting: Vec::new(),
            }),
            startups: watch::Sender::new(0),
        }
    }

    pub async fn create_tracked<S, C>(
        &self,
        options: CreateOptions,
        on_start: impl FnOnce(Reservation) -> S,
        on_cancel: impl FnOnce(String) -> C,
    ) -> Result<ShellInfo, String>
    where
        S: Future<Output = Result<(), String>>,
        C: Future<Output = ()>,
    {
        if lock(&self.inner).closed {
            return Err("Shell service is closed".into());
        }
        let reservation = Reservation {
            id: uuid::Uuid::new_v4().to_string(),
            shell: options.shell.clone().unwrap_or_else(pty::default_shell),
            cwd: display(&self.paths.resolve(options.cwd.as_deref().unwrap_or("."))?),
            created_at: iso_now(),
        };
        self.startups.send_modify(|count| *count += 1);
        let result = async {
            on_start(reservation.clone()).await?;
            let created = if lock(&self.inner).closed {
                Err("Shell creation interrupted before starting".to_string())
            } else {
                self.create(
                    CreateOptions {
                        shell: Some(reservation.shell.clone()),
                        cwd: Some(reservation.cwd.clone()),
                        ..options
                    },
                    Some(&reservation),
                )
            };
            if created.is_err() {
                on_cancel(reservation.id.clone()).await;
            }
            created
        }
        .await;
        self.startups.send_modify(|count| *count -= 1);
        result
    }

    pub fn create(
        &self,
        options: CreateOptions,
        reservation: Option<&Reservation>,
    ) -> Result<ShellInfo, String> {
        let slot = {
            let mut inner = lock(&self.inner);
            if inner.closed {
                return Err("Shell service is closed".into());
            }
            let evicting = inner
                .evicting
                .iter()
                .filter(|id| inner.sessions.contains_key(*id))
                .count();
            let exited = if inner.sessions.len() + inner.pending - evicting >= self.max_sessions {
                let exited = inner
                    .sessions
                    .values()
                    .map(|session| session.info())
                    .find(|info| !info.running && !inner.evicting.contains(&info.id))
                    .map(|info| info.id);
                if exited.is_none() {
                    return Err(format!(
                        "Shell session limit reached: {}",
                        self.max_sessions
                    ));
                }
                exited
            } else {
                None
            };
            inner.pending += 1;
            inner.evicting.extend(exited.clone());
            Slot {
                inner: &self.inner,
                exited,
            }
        };
        let cwd = display(&self.paths.resolve(options.cwd.as_deref().unwrap_or("."))?);
        let shell = options.shell.clone().unwrap_or_else(pty::default_shell);
        let args = options.args.clone().unwrap_or_else(pty::default_shell_args);
        let cols = valid_dimension(options.cols.unwrap_or(120.0), "cols")?;
        let rows = valid_dimension(options.rows.unwrap_or(30.0), "rows")?;

        let spawned = pty::spawn(&SpawnOptions {
            shell: &shell,
            args: &args,
            cwd: &cwd,
            env: options.env.as_ref(),
            cols,
            rows,
        })?;

        let info = ShellInfo {
            id: reservation
                .map(|reservation| reservation.id.clone())
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string()),
            shell,
            cwd,
            pid: spawned.pid,
            running: true,
            exit_code: None,
            signal: None,
            created_at: reservation
                .map(|reservation| reservation.created_at.clone())
                .unwrap_or_else(iso_now),
        };
        let session = Arc::new(Session {
            info: Mutex::new(info.clone()),
            buffer: Mutex::new(Buffer {
                output: Vec::new(),
                start: 0,
                end: 0,
            }),
            changed: Notify::new(),
            pty: spawned.pty,
            closing: AtomicBool::new(false),
        });
        if let Some(reason) = spawned.exec_failure {
            // Buffered directly: output written just before a PTY hangup can
            // be lost.
            session.append(&format!("execvp(3) failed.: {reason}\r\n"));
        }
        let (drained_tx, drained_rx) = std::sync::mpsc::channel::<()>();
        spawn_reader(session.clone(), spawned.output, drained_tx);
        spawn_exit_watcher(
            session.clone(),
            spawned.child,
            drained_rx,
            self.on_exit.clone(),
        );
        let replaced = {
            let mut inner = lock(&self.inner);
            if inner.closed {
                Err(())
            } else {
                let evicted = slot
                    .exited
                    .as_ref()
                    .and_then(|id| inner.sessions.shift_remove(id));
                inner.sessions.insert(info.id.clone(), session.clone());
                Ok(evicted)
            }
        };
        drop(slot);
        match replaced {
            Err(()) => {
                session.closing.store(true, Ordering::SeqCst);
                kill(&session);
                Err("Shell service is closed".into())
            }
            Ok(evicted) => {
                if let Some(evicted) = evicted {
                    evicted.closing.store(true, Ordering::SeqCst);
                    if lock(&evicted.info).running {
                        kill(&evicted);
                    }
                }
                Ok(info)
            }
        }
    }

    fn get(&self, id: &str) -> Result<Arc<Session>, String> {
        lock(&self.inner)
            .sessions
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Unknown shell session: {id}"))
    }

    pub fn write(&self, id: &str, data: &str) -> Result<(), String> {
        let session = self.get(id)?;
        if !lock(&session.info).running {
            return Err(format!("Shell session has exited: {id}"));
        }
        session
            .pty
            .write(data.as_bytes())
            .map_err(|error| error.to_string())
    }

    pub fn resize(&self, id: &str, cols: f64, rows: f64) -> Result<(), String> {
        let session = self.get(id)?;
        let cols = valid_dimension(cols, "cols")?;
        let rows = valid_dimension(rows, "rows")?;
        session.pty.resize(cols, rows)
    }

    pub async fn read(&self, options: ReadOptions) -> Result<Value, String> {
        let session = self.get(&options.id)?;
        let (start, end) = {
            let buffer = lock(&session.buffer);
            (buffer.start, buffer.end)
        };
        let requested = options.cursor.unwrap_or(start as f64);
        if requested.fract() != 0.0 || requested < 0.0 {
            return Err("cursor must be a non-negative integer".into());
        }
        if requested > end as f64 {
            return Err("cursor is beyond the available shell output".into());
        }
        let requested = requested as usize;
        let wait_ms = options.wait_ms.unwrap_or(0.0);
        if wait_ms.fract() != 0.0 || !(0.0..=30_000.0).contains(&wait_ms) {
            return Err("waitMs must be an integer from 0 to 30000".into());
        }
        if wait_ms > 0.0 {
            let notified = session.changed.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            let idle = requested >= lock(&session.buffer).end && lock(&session.info).running;
            if idle {
                let _ = tokio::time::timeout(Duration::from_millis(wait_ms as u64), notified).await;
            }
        }
        let info = session.info();
        let buffer = lock(&session.buffer);
        let cursor = requested.max(buffer.start);
        let available = &buffer.output[cursor - buffer.start..];
        let output = &available[..available.len().min(MAX_READ_UNITS)];
        let mut result = Map::new();
        result.insert("id".into(), json!(options.id));
        result.insert("output".into(), json!(String::from_utf16_lossy(output)));
        result.insert("cursor".into(), json!(cursor + output.len()));
        result.insert(
            "truncated".into(),
            json!(requested < buffer.start || available.len() > MAX_READ_UNITS),
        );
        result.insert("running".into(), json!(info.running));
        if let Some(exit_code) = info.exit_code {
            result.insert("exitCode".into(), json!(exit_code));
        }
        if let Some(signal) = info.signal {
            result.insert("signal".into(), json!(signal));
        }
        Ok(Value::Object(result))
    }

    pub fn close(&self, id: &str) -> Result<(), String> {
        let session = self.get(id)?;
        session.closing.store(true, Ordering::SeqCst);
        if lock(&session.info).running {
            kill(&session);
        }
        lock(&self.inner).sessions.shift_remove(id);
        Ok(())
    }

    pub fn list(&self) -> Vec<ShellInfo> {
        let mut sessions: Vec<ShellInfo> = lock(&self.inner)
            .sessions
            .values()
            .map(|session| session.info())
            .collect();
        sessions.sort_by(|left, right| {
            crate::collate::locale_compare(&left.created_at, &right.created_at)
        });
        sessions
    }

    pub async fn close_all(&self) {
        let ids: Vec<String> = {
            let mut inner = lock(&self.inner);
            inner.closed = true;
            inner.sessions.keys().cloned().collect()
        };
        for id in ids {
            let _ = self.close(&id);
        }
        let mut startups = self.startups.subscribe();
        let _ = startups.wait_for(|count| *count == 0).await;
    }
}

fn kill(session: &Session) {
    session.pty.hangup();
}

fn spawn_reader(
    session: Arc<Session>,
    mut reader: Box<dyn Read + Send>,
    drained: std::sync::mpsc::Sender<()>,
) {
    std::thread::spawn(move || {
        let mut decoder = Utf8Decoder::default();
        let mut chunk = vec![0u8; 64 * 1024];
        loop {
            match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => session.append(&decoder.write(&chunk[..count])),
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        session.append(&decoder.end());
        let _ = drained.send(());
    });
}

fn spawn_exit_watcher(
    session: Arc<Session>,
    mut child: Box<dyn pty::Child>,
    drained: std::sync::mpsc::Receiver<()>,
    on_exit: Option<ExitHook>,
) {
    std::thread::spawn(move || {
        let (exit_code, signal) = child.wait();
        let _ = drained.recv_timeout(pty::EXIT_DRAIN);
        drop(child);
        let info = {
            let mut info = lock(&session.info);
            info.running = false;
            info.exit_code = exit_code;
            info.signal = signal;
            info.clone()
        };
        session.changed.notify_waiters();
        if !session.closing.load(Ordering::SeqCst)
            && let Some(on_exit) = on_exit
        {
            on_exit(info, session.output());
        }
    });
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn service() -> (tempfile::TempDir, ShellService) {
        let directory = tempfile::tempdir().unwrap();
        let service = ShellService::new(MachinePathResolver::new(directory.path()), 2, None);
        (directory, service)
    }

    #[tokio::test]
    async fn runs_commands_and_reports_exit() {
        let (_directory, service) = service();
        let info = service
            .create(
                CreateOptions {
                    shell: Some("/bin/sh".into()),
                    args: Some(vec![]),
                    ..Default::default()
                },
                None,
            )
            .unwrap();
        service
            .write(&info.id, "printf 'hi%s\\n' there; exit 3\n")
            .unwrap();
        let mut output = String::new();
        let mut cursor = 0.0;
        for _ in 0..50 {
            let result = service
                .read(ReadOptions {
                    id: info.id.clone(),
                    cursor: Some(cursor),
                    wait_ms: Some(200.0),
                })
                .await
                .unwrap();
            output.push_str(result["output"].as_str().unwrap());
            cursor = result["cursor"].as_f64().unwrap();
            if result["running"] == false {
                assert_eq!(result["exitCode"], 3);
                assert_eq!(result["signal"], 0);
                break;
            }
        }
        assert!(output.contains("hithere"), "{output}");
        assert_eq!(
            service
                .read(ReadOptions {
                    id: info.id.clone(),
                    cursor: Some(cursor + 1.0),
                    wait_ms: None
                })
                .await
                .unwrap_err(),
            "cursor is beyond the available shell output"
        );
        assert_eq!(
            service.write(&info.id, "x").unwrap_err(),
            format!("Shell session has exited: {}", info.id)
        );
    }

    #[tokio::test]
    async fn enforces_limits_and_validation() {
        let (_directory, service) = service();
        let options = CreateOptions {
            shell: Some("/bin/sh".into()),
            args: Some(vec![]),
            ..Default::default()
        };
        assert_eq!(
            service
                .create(
                    CreateOptions {
                        cols: Some(0.0),
                        ..options.clone()
                    },
                    None
                )
                .unwrap_err(),
            "cols must be an integer from 1 to 1000"
        );
        let first = service.create(options.clone(), None).unwrap();
        service.create(options.clone(), None).unwrap();
        assert_eq!(
            service.create(options.clone(), None).unwrap_err(),
            "Shell session limit reached: 2"
        );
        assert_eq!(
            service.resize(&first.id, 80.0, 1001.0).unwrap_err(),
            "rows must be an integer from 1 to 1000"
        );
        service.close(&first.id).unwrap();
        assert_eq!(
            service.close(&first.id).unwrap_err(),
            format!("Unknown shell session: {}", first.id)
        );
        service.close_all().await;
        assert_eq!(
            service.create(options, None).unwrap_err(),
            "Shell service is closed"
        );
    }

    #[test]
    fn concurrent_creates_respect_the_session_limit() {
        let (_directory, service) = service();
        let created = std::thread::scope(|scope| {
            let handles: Vec<_> = (0..8)
                .map(|_| {
                    scope.spawn(|| {
                        service.create(
                            CreateOptions {
                                shell: Some("/bin/sh".into()),
                                args: Some(vec!["-c".into(), "sleep 5".into()]),
                                ..CreateOptions::default()
                            },
                            None,
                        )
                    })
                })
                .collect();
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(Result::is_ok)
                .count()
        });
        assert_eq!(created, 2);
        assert_eq!(service.list().len(), 2);
        for info in service.list() {
            service.close(&info.id).unwrap();
        }
    }
}
