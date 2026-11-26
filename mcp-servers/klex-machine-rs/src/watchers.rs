//! One-shot background shell commands that report a single outcome.

use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures::future::BoxFuture;
use indexmap::IndexMap;
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::watch;

use crate::notifications::WatcherCompletion;
use crate::paths::{MachinePathResolver, display};
use crate::time::{iso, now_ms, parse_iso};
use crate::utf16::Utf8Decoder;

pub const MAX_WATCHERS: usize = 32;
pub const MAX_WATCHER_LIFETIME_MS: f64 = 604_800_000.0;
const BUFFER_UNITS: usize = 64 * 1024;
/// Output still buffered after the command exits gets this long to drain.
pub const WATCHER_OUTPUT_DRAIN: Duration = Duration::from_millis(2000);

#[derive(Clone, Debug)]
pub struct WatcherInfo {
    pub id: String,
    pub title: String,
    pub command: String,
    pub cwd: String,
    pub pid: Option<u32>,
    pub created_at: String,
    pub deadline_at: String,
}

impl WatcherInfo {
    pub fn to_json(&self) -> Value {
        let mut object = Map::new();
        object.insert("id".into(), json!(self.id));
        object.insert("watcherId".into(), json!(self.id));
        object.insert("title".into(), json!(self.title));
        object.insert("command".into(), json!(self.command));
        object.insert("cwd".into(), json!(self.cwd));
        object.insert("pid".into(), json!(self.pid));
        object.insert("status".into(), json!("running"));
        object.insert("createdAt".into(), json!(self.created_at));
        object.insert("deadlineAt".into(), json!(self.deadline_at));
        Value::Object(object)
    }
}

pub struct CreateOptions {
    pub command: String,
    pub title: String,
    pub timeout_ms: f64,
    pub cwd: Option<String>,
    pub env: Option<IndexMap<String, String>>,
}

type Hook<T> = Arc<dyn Fn(T) -> BoxFuture<'static, Result<(), String>> + Send + Sync>;

pub struct WatcherHooks {
    pub on_start: Hook<Value>,
    pub on_finish: Hook<(Value, WatcherCompletion)>,
    pub on_cancel: Hook<String>,
    pub on_error: Arc<dyn Fn(String) + Send + Sync>,
}

struct Running {
    info: Mutex<WatcherInfo>,
    output: Mutex<String>,
    done: AtomicBool,
    killed: AtomicBool,
    exited_at: Mutex<Option<String>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

impl Running {
    fn append(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        let mut output = lock(&self.output);
        output.push_str(text);
        let kept = crate::utf16::tail(&output, BUFFER_UNITS).len();
        let remove = output.len() - kept;
        output.drain(..remove);
    }
}

struct Inner {
    running: IndexMap<String, Arc<Running>>,
    closed: bool,
}

pub struct WatcherService {
    paths: MachinePathResolver,
    hooks: WatcherHooks,
    max_watchers: usize,
    drain: Duration,
    inner: Mutex<Inner>,
    startups: watch::Sender<usize>,
}

impl WatcherService {
    pub fn new(
        paths: MachinePathResolver,
        hooks: WatcherHooks,
        max_watchers: usize,
        drain: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            paths,
            hooks,
            max_watchers,
            drain,
            inner: Mutex::new(Inner {
                running: IndexMap::new(),
                closed: false,
            }),
            startups: watch::Sender::new(0),
        })
    }

    pub async fn create(self: &Arc<Self>, options: CreateOptions) -> Result<Value, String> {
        let watcher = {
            let mut inner = lock(&self.inner);
            if inner.closed {
                return Err("Watcher service is closed".into());
            }
            if inner.running.len() >= self.max_watchers {
                return Err(format!("Watcher limit reached: {}", self.max_watchers));
            }
            let command_length = crate::utf16::len(&options.command);
            if command_length == 0 || command_length > 16384 {
                return Err("command must contain 1 to 16384 characters".into());
            }
            let title_length = crate::utf16::len(&options.title);
            if title_length == 0 || title_length > 200 {
                return Err("title must contain 1 to 200 characters".into());
            }
            if options.timeout_ms.fract() != 0.0
                || !(1000.0..=MAX_WATCHER_LIFETIME_MS).contains(&options.timeout_ms)
            {
                return Err("timeoutMs must be an integer from 1000 to 604800000".into());
            }
            let created = now_ms();
            let info = WatcherInfo {
                id: uuid::Uuid::new_v4().to_string(),
                title: options.title.clone(),
                command: options.command.clone(),
                cwd: display(&self.paths.resolve(options.cwd.as_deref().unwrap_or("."))?),
                pid: None,
                created_at: iso(created),
                deadline_at: iso(created + options.timeout_ms as i64),
            };
            let watcher = Arc::new(Running {
                info: Mutex::new(info.clone()),
                output: Mutex::new(String::new()),
                done: AtomicBool::new(false),
                killed: AtomicBool::new(false),
                exited_at: Mutex::new(None),
            });
            // Reserve before awaiting persistence so concurrent creates respect the bound.
            inner.running.insert(info.id, watcher.clone());
            watcher
        };
        self.startups.send_modify(|count| *count += 1);
        let result = self.start(&watcher, &options).await;
        self.startups.send_modify(|count| *count -= 1);
        result?;
        Ok(lock(&watcher.info).to_json())
    }

    async fn start(
        self: &Arc<Self>,
        watcher: &Arc<Running>,
        options: &CreateOptions,
    ) -> Result<(), String> {
        let info = lock(&watcher.info).clone();
        if let Err(error) = (self.hooks.on_start)(info.to_json()).await {
            lock(&self.inner).running.shift_remove(&info.id);
            return Err(error);
        }
        if lock(&self.inner).closed || watcher.done.load(Ordering::SeqCst) {
            (self.hooks.on_cancel)(info.id.clone()).await?;
            return Err("Watcher creation interrupted before starting".into());
        }
        let deadline = parse_iso(&info.deadline_at).unwrap_or(0);
        if now_ms() >= deadline {
            self.finish(watcher, "timed_out", None, None).await;
            return Ok(());
        }
        let (file, mut command) = shell_command(&options.command);
        command
            .current_dir(&info.cwd)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(env) = &options.env {
            command.envs(env);
        }
        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                let code =
                    crate::fs_error::code(&error).map_or_else(|| error.to_string(), str::to_string);
                watcher.append(&format!("spawn {file} {code}"));
                let service = self.clone();
                let watcher = watcher.clone();
                tokio::spawn(async move { service.finish(&watcher, "failed", None, None).await });
                return Ok(());
            }
        };
        lock(&watcher.info).pid = child.id();
        let readers = [
            child
                .stdout
                .take()
                .map(|stream| spawn_reader(watcher.clone(), stream)),
            child
                .stderr
                .take()
                .map(|stream| spawn_reader(watcher.clone(), stream)),
        ];
        let service = self.clone();
        let watcher = watcher.clone();
        tokio::spawn(async move {
            let status = loop {
                let remaining = deadline - now_ms();
                let checking = !watcher.done.load(Ordering::SeqCst);
                tokio::select! {
                    status = child.wait() => break status,
                    () = tokio::time::sleep(Duration::from_millis(remaining.clamp(0, 5000) as u64)), if checking => {
                        if now_ms() >= deadline {
                            service.finish(&watcher, "timed_out", None, None).await;
                        }
                    }
                }
            };
            *lock(&watcher.exited_at) = Some(iso(now_ms()));
            // Descendants may keep stdout/stderr open after the command exits.
            // Stop them now, then let the pipes drain without reclassifying exit.
            service.kill(&watcher);
            let drained = async {
                for reader in readers.into_iter().flatten() {
                    let _ = reader.await;
                }
            };
            let _ = tokio::time::timeout(service.drain, drained).await;
            let (code, signal) = match status {
                Ok(status) => exit_details(status),
                Err(_) => (None, None),
            };
            let outcome = if code == Some(0) && signal.is_none() {
                "condition_met"
            } else {
                "failed"
            };
            service.finish(&watcher, outcome, code, signal).await;
        });
        Ok(())
    }

    pub fn list(&self) -> Vec<Value> {
        lock(&self.inner)
            .running
            .values()
            .map(|watcher| lock(&watcher.info).to_json())
            .collect()
    }

    pub fn contains(&self, id: &str) -> bool {
        lock(&self.inner).running.contains_key(id)
    }

    pub async fn cancel(&self, id: &str) -> Result<(), String> {
        let watcher = lock(&self.inner)
            .running
            .get(id)
            .cloned()
            .ok_or_else(|| format!("Unknown watcher: {id}"))?;
        self.stop(&watcher);
        (self.hooks.on_cancel)(id.to_string()).await
    }

    pub async fn close_all(&self) {
        let watchers: Vec<Arc<Running>> = {
            let mut inner = lock(&self.inner);
            inner.closed = true;
            inner.running.values().cloned().collect()
        };
        for watcher in &watchers {
            self.stop(watcher);
        }
        // Interrupted creates must remove their reservations before store shutdown.
        let mut startups = self.startups.subscribe();
        let _ = startups.wait_for(|count| *count == 0).await;
    }

    fn stop(&self, watcher: &Running) {
        watcher.done.store(true, Ordering::SeqCst);
        let id = lock(&watcher.info).id.clone();
        lock(&self.inner).running.shift_remove(&id);
        self.kill(watcher);
    }

    async fn finish(
        &self,
        watcher: &Running,
        outcome: &'static str,
        exit_code: Option<i32>,
        signal: Option<String>,
    ) {
        if watcher.done.swap(true, Ordering::SeqCst) {
            return;
        }
        let info = lock(&watcher.info).clone();
        lock(&self.inner).running.shift_remove(&info.id);
        // Also clean up descendants left behind by a completed shell command.
        self.kill(watcher);
        let completion = WatcherCompletion {
            outcome,
            exit_code,
            signal,
            finished_at: lock(&watcher.exited_at)
                .clone()
                .unwrap_or_else(|| iso(now_ms())),
            output: lock(&watcher.output).clone(),
        };
        if let Err(error) = (self.hooks.on_finish)((info.to_json(), completion)).await {
            (self.hooks.on_error)(error);
        }
    }

    fn kill(&self, watcher: &Running) {
        let Some(pid) = lock(&watcher.info).pid else {
            return;
        };
        if watcher.killed.swap(true, Ordering::SeqCst) {
            return;
        }
        #[cfg(windows)]
        {
            let spawned = std::process::Command::new("taskkill")
                .args(["/pid", &pid.to_string(), "/T", "/F"])
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
            match spawned {
                Ok(mut child) => {
                    std::thread::spawn(move || child.wait());
                }
                Err(error) => (self.hooks.on_error)(error.to_string()),
            }
        }
        #[cfg(unix)]
        {
            if !crate::platform::kill_group(pid, libc::SIGTERM) {
                return;
            }
            tokio::spawn(async move {
                tokio::time::sleep(Duration::from_secs(5)).await;
                crate::platform::kill_group(pid, libc::SIGKILL);
            });
        }
    }
}

/// `child_process.spawn(command, { shell: true, detached })`.
fn shell_command(script: &str) -> (String, Command) {
    #[cfg(unix)]
    {
        let mut command = Command::new("/bin/sh");
        command.arg("-c").arg(script);
        // SAFETY: setsid is async-signal-safe; Node's `detached` does the same.
        unsafe {
            command.pre_exec(|| {
                libc::setsid();
                Ok(())
            });
        }
        ("/bin/sh".into(), command)
    }
    #[cfg(windows)]
    {
        let file = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".into());
        let mut command = Command::new(&file);
        command.raw_arg(format!("/d /s /c \"{script}\""));
        (file, command)
    }
}

fn exit_details(status: std::process::ExitStatus) -> (Option<i32>, Option<String>) {
    #[cfg(unix)]
    {
        use std::os::unix::process::ExitStatusExt;
        (
            status.code(),
            status.signal().map(crate::platform::signal_name),
        )
    }
    #[cfg(windows)]
    {
        (status.code(), None)
    }
}

fn spawn_reader(
    watcher: Arc<Running>,
    mut stream: impl AsyncRead + Unpin + Send + 'static,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut decoder = Utf8Decoder::default();
        let mut chunk = vec![0u8; 16 * 1024];
        loop {
            match stream.read(&mut chunk).await {
                Ok(0) | Err(_) => break,
                Ok(count) => watcher.append(&decoder.write(&chunk[..count])),
            }
        }
        watcher.append(&decoder.end());
    })
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use tokio::sync::mpsc;

    fn service(
        max: usize,
    ) -> (
        tempfile::TempDir,
        Arc<WatcherService>,
        mpsc::UnboundedReceiver<(Value, WatcherCompletion)>,
    ) {
        let directory = tempfile::tempdir().unwrap();
        let (sender, receiver) = mpsc::unbounded_channel();
        let hooks = WatcherHooks {
            on_start: Arc::new(|_| Box::pin(async { Ok(()) })),
            on_finish: Arc::new(move |completion| {
                let _ = sender.send(completion);
                Box::pin(async { Ok(()) })
            }),
            on_cancel: Arc::new(|_| Box::pin(async { Ok(()) })),
            on_error: Arc::new(|_| {}),
        };
        let service = WatcherService::new(
            MachinePathResolver::new(directory.path()),
            hooks,
            max,
            Duration::from_millis(200),
        );
        (directory, service, receiver)
    }

    fn options(command: &str) -> CreateOptions {
        CreateOptions {
            command: command.into(),
            title: "t".into(),
            timeout_ms: 60_000.0,
            cwd: None,
            env: None,
        }
    }

    #[tokio::test]
    async fn reports_outcomes() {
        let (_directory, service, mut completions) = service(4);
        let info = service.create(options("echo ready; exit 0")).await.unwrap();
        assert_eq!(info["status"], "running");
        assert_eq!(info["watcherId"], info["id"]);
        let (_, completion) = completions.recv().await.unwrap();
        assert_eq!(completion.outcome, "condition_met");
        assert_eq!(completion.output, "ready\n");
        service.create(options("exit 4")).await.unwrap();
        let (_, completion) = completions.recv().await.unwrap();
        assert_eq!(
            (completion.outcome, completion.exit_code),
            ("failed", Some(4))
        );
        service.create(options("kill -TERM $$")).await.unwrap();
        let (_, completion) = completions.recv().await.unwrap();
        assert_eq!(completion.signal.as_deref(), Some("SIGTERM"));
        service
            .create(CreateOptions {
                cwd: Some("missing".into()),
                ..options("true")
            })
            .await
            .unwrap();
        let (_, completion) = completions.recv().await.unwrap();
        assert_eq!(
            (completion.outcome, completion.output.as_str()),
            ("failed", "spawn /bin/sh ENOENT")
        );
        assert!(service.list().is_empty());
    }

    #[tokio::test]
    async fn validates_and_cancels() {
        let (_directory, service, _completions) = service(1);
        assert_eq!(
            service
                .create(CreateOptions {
                    timeout_ms: 999.0,
                    ..options("sleep 5")
                })
                .await
                .unwrap_err(),
            "timeoutMs must be an integer from 1000 to 604800000"
        );
        let info = service.create(options("sleep 30")).await.unwrap();
        assert_eq!(
            service.create(options("sleep 30")).await.unwrap_err(),
            "Watcher limit reached: 1"
        );
        let id = info["id"].as_str().unwrap();
        service.cancel(id).await.unwrap();
        assert_eq!(
            service.cancel(id).await.unwrap_err(),
            format!("Unknown watcher: {id}")
        );
        service.close_all().await;
        assert_eq!(
            service.create(options("true")).await.unwrap_err(),
            "Watcher service is closed"
        );
    }
}
