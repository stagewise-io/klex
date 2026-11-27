//! The daemon's outbound desktop link to Cloud: one control WebSocket for
//! the control lease and stream requests, and one WebSocket per viewer
//! stream that relays RFB to the provider's stream source. The desktop is
//! offered only while the provider reports `stream`.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use futures::{SinkExt, StreamExt};
use regex::Regex;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot, watch};
use tokio::task::JoinHandle;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, WebSocketConfig};
use tokio_tungstenite::tungstenite::{Error as WsError, Message};

use super::http;
use super::token_client::TokenClient;
use crate::desktop::rfb::filter::RfbClientFilter;
use crate::desktop::service::DesktopService;
use crate::logger::{LogLevel, Logger};

pub const MAX_DESKTOP_STREAMS: usize = 4;
const PROTOCOL_VERSION: u64 = 1;
const MAX_CONTROL_MESSAGE_BYTES: usize = 64 * 1024;
const PING: Duration = Duration::from_secs(30);
const PONG_TIMEOUT: Duration = Duration::from_secs(60);
const RECONNECT_MIN_MS: f64 = 1_000.0;
const RECONNECT_MAX_MS: f64 = 30_000.0;
const STABLE_CONNECTION: Duration = Duration::from_secs(60);
const AVAILABILITY_POLL: Duration = Duration::from_secs(10);
const STREAM_CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_EARLY_VNC_BYTES: usize = 64 * 1024;
const CLOSE_TIMEOUT: Duration = Duration::from_secs(2);
const RELAY_CHUNK_BYTES: usize = 64 * 1024;
/// Messages queued toward a stream socket before reading the source pauses.
const STREAM_QUEUE: usize = 64;

static STREAM_ID: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
        .expect("valid stream id pattern")
});

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub struct DesktopLinkOptions {
    pub cloud_base_url: String,
    pub tokens: Arc<TokenClient>,
    pub desktop: Arc<DesktopService>,
    pub machine_version: String,
    pub logger: Logger,
}

struct StreamEntry {
    close: Option<oneshot::Sender<u16>>,
    done: JoinHandle<()>,
}

struct Shared {
    options: DesktopLinkOptions,
    base: Result<String, String>,
    streams: Mutex<HashMap<String, StreamEntry>>,
    /// Control messages from stream tasks; sent while a control socket is open.
    outgoing: mpsc::UnboundedSender<Value>,
    /// Bumped on every withdrawal; a version counter, so a withdrawal that
    /// lands while the control session is busy elsewhere is not lost.
    withdrawals: watch::Sender<u64>,
    closed: AtomicBool,
    shutdown: watch::Sender<bool>,
}

pub struct DesktopLink {
    shared: Arc<Shared>,
    task: tokio::sync::Mutex<Option<JoinHandle<()>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn to_websocket_base(cloud_base_url: &str) -> Result<String, String> {
    let mut url =
        url::Url::parse(cloud_base_url).map_err(|_| "Invalid Cloud base URL".to_string())?;
    let scheme = match url.scheme() {
        "https" => "wss",
        "http" => "ws",
        _ => return Err("Cloud base URL must use http or https".into()),
    };
    url.set_scheme(scheme)
        .map_err(|()| "Invalid Cloud base URL".to_string())?;
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn random() -> f64 {
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64
}

fn reconnect_delay(attempt: &mut u32) -> Duration {
    let ceiling = RECONNECT_MAX_MS.min(RECONNECT_MIN_MS * 2f64.powi((*attempt).min(32) as i32));
    *attempt += 1;
    Duration::from_millis((ceiling / 2.0 + random() * ceiling / 2.0).round() as u64)
}

enum ConnectError {
    Refused(u16),
    Failed(String),
}

async fn connect(
    url: &str,
    token: &str,
    max_message: Option<usize>,
) -> Result<Socket, ConnectError> {
    let mut request = url
        .into_client_request()
        .map_err(|error| ConnectError::Failed(error.to_string()))?;
    let authorization = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|error| ConnectError::Failed(error.to_string()))?;
    request.headers_mut().insert("authorization", authorization);
    let config = max_message.map(|limit| {
        WebSocketConfig::default()
            .max_message_size(Some(limit))
            .max_frame_size(Some(limit))
    });
    let connector = tokio_tungstenite::Connector::Rustls(http::tls());
    match tokio_tungstenite::connect_async_tls_with_config(request, config, true, Some(connector))
        .await
    {
        Ok((socket, _)) => Ok(socket),
        Err(WsError::Http(response)) => Err(ConnectError::Refused(response.status().as_u16())),
        Err(error) => Err(ConnectError::Failed(error.to_string())),
    }
}

fn close_frame(code: u16) -> Message {
    Message::Close(Some(CloseFrame {
        code: CloseCode::from(code),
        reason: "".into(),
    }))
}

/// Pings the peer and reports when it stopped answering.
struct KeepAlive {
    interval: tokio::time::Interval,
    last_pong: Instant,
}

impl KeepAlive {
    fn new() -> Self {
        let mut interval = tokio::time::interval_at(tokio::time::Instant::now() + PING, PING);
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        Self {
            interval,
            last_pong: Instant::now(),
        }
    }

    /// Waits for the next ping; `false` once the peer is gone.
    async fn tick(&mut self) -> bool {
        self.interval.tick().await;
        self.last_pong.elapsed() <= PONG_TIMEOUT
    }
}

impl DesktopLink {
    pub fn start(options: DesktopLinkOptions) -> Self {
        let (outgoing, receiver) = mpsc::unbounded_channel();
        let base = to_websocket_base(&options.cloud_base_url);
        let shared = Arc::new(Shared {
            options,
            base,
            streams: Mutex::default(),
            outgoing,
            withdrawals: watch::channel(0).0,
            closed: AtomicBool::new(false),
            shutdown: watch::channel(false).0,
        });
        let task = tokio::spawn(run(shared.clone(), receiver));
        Self {
            shared,
            task: tokio::sync::Mutex::new(Some(task)),
        }
    }

    pub async fn close(&self) {
        if self.shared.closed.swap(true, Ordering::SeqCst) {
            return;
        }
        self.shared.shutdown.send_replace(true);
        let closing: Vec<JoinHandle<()>> = {
            let mut streams = lock(&self.shared.streams);
            streams
                .drain()
                .map(|(_, mut entry)| {
                    if let Some(close) = entry.close.take() {
                        let _ = close.send(1001);
                    }
                    entry.done
                })
                .collect()
        };
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
        for stream in closing {
            let _ = stream.await;
        }
    }
}

async fn until_shutdown(shutdown: &mut watch::Receiver<bool>) {
    let _ = shutdown.wait_for(|stopped| *stopped).await;
}

impl Shared {
    fn logger(&self) -> &Logger {
        &self.options.logger
    }

    fn close_streams(&self, code: u16) {
        for entry in lock(&self.streams).values_mut() {
            if let Some(close) = entry.close.take() {
                let _ = close.send(code);
            }
        }
    }

    /// Stops offering the desktop until a fresh probe reports `stream` again.
    fn withdraw(&self) {
        self.options.desktop.invalidate();
        self.close_streams(1001);
        self.withdrawals.send_modify(|count| *count += 1);
    }

    fn send(&self, message: Value) {
        let _ = self.outgoing.send(message);
    }
}

async fn run(shared: Arc<Shared>, mut outgoing: mpsc::UnboundedReceiver<Value>) {
    let mut shutdown = shared.shutdown.subscribe();
    let logger = shared.logger().clone();
    let base = match &shared.base {
        Ok(base) => base.clone(),
        Err(error) => {
            logger.warn(json!({ "error": error }), "Desktop link is disabled");
            return;
        }
    };
    let mut attempt = 0u32;
    loop {
        if shared.closed.load(Ordering::SeqCst) {
            return;
        }
        // Before the probe, so a withdrawal during it also ends the session.
        let mut withdrawn = shared.withdrawals.subscribe();
        let capabilities = tokio::select! {
            capabilities = shared.options.desktop.capabilities() => capabilities,
            () = until_shutdown(&mut shutdown) => return,
        };
        let delay = if !capabilities.stream {
            AVAILABILITY_POLL
        } else {
            match connect_control(&shared, &base, &mut shutdown).await {
                Err(None) => return,
                Err(Some(())) => reconnect_delay(&mut attempt),
                Ok(socket) => {
                    let opened_at = Instant::now();
                    while outgoing.try_recv().is_ok() {}
                    let code = control_session(
                        &shared,
                        socket,
                        &capabilities,
                        &mut outgoing,
                        &mut withdrawn,
                        &mut shutdown,
                    )
                    .await;
                    logger.info(json!({ "code": code }), "Desktop control disconnected");
                    // Cloud routes stream requests over this link and reopens them
                    // after a reconnect, so streams must not outlive it.
                    shared.close_streams(1001);
                    shared.options.desktop.lease.disconnected();
                    if shared.closed.load(Ordering::SeqCst) {
                        return;
                    }
                    if opened_at.elapsed() >= STABLE_CONNECTION {
                        attempt = 0;
                    }
                    reconnect_delay(&mut attempt)
                }
            }
        };
        tokio::select! {
            () = tokio::time::sleep(delay) => {}
            () = until_shutdown(&mut shutdown) => return,
        }
    }
}

/// `Err(None)` when the link is shutting down.
async fn connect_control(
    shared: &Arc<Shared>,
    base: &str,
    shutdown: &mut watch::Receiver<bool>,
) -> Result<Socket, Option<()>> {
    let logger = shared.logger();
    let token = tokio::select! {
        token = shared.options.tokens.get_token() => token,
        () = until_shutdown(shutdown) => return Err(None),
    };
    let token = match token {
        Ok(token) => token,
        Err(error) => {
            logger.warn(
                json!({ "error": error }),
                "Desktop link token request failed",
            );
            return Err(Some(()));
        }
    };
    let url = format!("{base}/api/machine-desktop/control");
    let result = tokio::select! {
        result = connect(&url, &token, Some(MAX_CONTROL_MESSAGE_BYTES)) => result,
        () = until_shutdown(shutdown) => return Err(None),
    };
    match result {
        Ok(socket) => Ok(socket),
        Err(ConnectError::Refused(status)) => {
            if status == 401 || status == 403 {
                shared.options.tokens.invalidate();
            }
            logger.warn(
                json!({ "status": status }),
                "Desktop control connection was refused",
            );
            Err(Some(()))
        }
        Err(ConnectError::Failed(error)) => {
            logger.log(
                LogLevel::Debug,
                json!({ "error": error }),
                "Desktop control socket error",
            );
            Err(Some(()))
        }
    }
}

/// Runs one control connection; returns its close code.
async fn control_session(
    shared: &Arc<Shared>,
    mut socket: Socket,
    capabilities: &crate::desktop::provider::DesktopCapabilities,
    outgoing: &mut mpsc::UnboundedReceiver<Value>,
    withdrawn: &mut watch::Receiver<u64>,
    shutdown: &mut watch::Receiver<bool>,
) -> u16 {
    let logger = shared.logger();
    logger.info(json!({}), "Desktop control connected");
    let mut hello = json!({ "type": "hello", "v": PROTOCOL_VERSION });
    if let Some(screen) = capabilities.screen {
        hello["screen"] = json!({ "width": screen.width, "height": screen.height });
    }
    hello["machineVersion"] = json!(shared.options.machine_version);
    hello["capabilities"] = json!(["stream", "lease", "rfb-input-filter"]);
    if socket
        .send(Message::Text(hello.to_string().into()))
        .await
        .is_err()
    {
        return 1006;
    }
    let mut keep_alive = KeepAlive::new();
    loop {
        tokio::select! {
            message = socket.next() => match message {
                Some(Ok(Message::Text(text))) => {
                    if let Ok(value) = serde_json::from_str::<Value>(&text) {
                        handle_control(shared, &value);
                    }
                }
                Some(Ok(Message::Pong(_))) => keep_alive.last_pong = Instant::now(),
                Some(Ok(Message::Close(frame))) => {
                    return frame.map_or(1005, |frame| u16::from(frame.code));
                }
                Some(Ok(_)) => {}
                Some(Err(error)) => {
                    logger.log(LogLevel::Debug, json!({ "error": error.to_string() }), "Desktop control socket error");
                    return 1006;
                }
                None => return 1006,
            },
            Some(message) = outgoing.recv() => {
                if socket.send(Message::Text(message.to_string().into())).await.is_err() {
                    return 1006;
                }
            }
            alive = keep_alive.tick() => {
                if !alive || socket.send(Message::Ping(Vec::new().into())).await.is_err() {
                    return 1006;
                }
            }
            _ = withdrawn.changed() => return 1006,
            () = until_shutdown(shutdown) => {
                // A peer that never answers the close frame must not hold shutdown.
                let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
                    let _ = socket.send(close_frame(1001)).await;
                    while let Some(Ok(message)) = socket.next().await {
                        if matches!(message, Message::Close(_)) {
                            break;
                        }
                    }
                })
                .await;
                return 1001;
            }
        }
    }
}

fn handle_control(shared: &Arc<Shared>, value: &Value) {
    let Some(message) = value.as_object() else {
        return;
    };
    let kind = message.get("type").and_then(Value::as_str);
    let logger = shared.logger();
    match kind {
        Some("lease") => {
            use crate::desktop::lease::{ControlMode, LeaseHolder, LeaseUpdate};
            let mode = match message.get("mode").and_then(Value::as_str) {
                Some("human") => ControlMode::Human,
                Some("agent") => ControlMode::Agent,
                _ => return,
            };
            let holder = message
                .get("holder")
                .and_then(Value::as_object)
                .map(|holder| LeaseHolder {
                    name: holder
                        .get("name")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                    stream_id: holder
                        .get("streamId")
                        .and_then(Value::as_str)
                        .map(str::to_string),
                });
            let lease = &shared.options.desktop.lease;
            lease.apply(LeaseUpdate {
                mode,
                holder,
                expires_at: message
                    .get("expiresAt")
                    .and_then(Value::as_str)
                    .map(str::to_string),
            });
            let revision = message.get("revision").cloned().unwrap_or(Value::Null);
            // An already-expired human lease is not enforced, so it is not acknowledged.
            if lease.state().mode != mode {
                logger.warn(json!({ "revision": revision }), "Ignored an expired lease");
                return;
            }
            logger.info(
                json!({ "revision": revision, "mode": mode.as_str() }),
                "Desktop lease applied",
            );
            if revision.is_number() {
                shared.send(json!({ "type": "lease.applied", "revision": revision }));
            }
        }
        Some("stream.open") => {
            if let Some(stream_id) = message.get("streamId").and_then(Value::as_str) {
                open_stream(shared, stream_id.to_string());
            }
        }
        Some("stream.close") => {
            if let Some(stream_id) = message.get("streamId").and_then(Value::as_str)
                && let Some(entry) = lock(&shared.streams).get_mut(stream_id)
                && let Some(close) = entry.close.take()
            {
                let _ = close.send(1000);
            }
        }
        _ => {}
    }
}

fn open_stream(shared: &Arc<Shared>, stream_id: String) {
    let fail = |reason: &str| {
        shared.send(json!({ "type": "stream.failed", "streamId": stream_id, "reason": reason }));
    };
    if !STREAM_ID.is_match(&stream_id) {
        return fail("invalid_stream_id");
    }
    let mut streams = lock(&shared.streams);
    // Under the lock: shutdown sets `closed` and then drains this map, so a
    // stream inserted after the check is still drained and joined.
    if shared.closed.load(Ordering::SeqCst) {
        return;
    }
    if streams.contains_key(&stream_id) {
        return;
    }
    if streams.len() >= MAX_DESKTOP_STREAMS {
        drop(streams);
        return fail("too_many_streams");
    }
    let (close, closing) = oneshot::channel();
    let done = tokio::spawn(run_stream(shared.clone(), stream_id.clone(), closing));
    streams.insert(
        stream_id,
        StreamEntry {
            close: Some(close),
            done,
        },
    );
}

struct Finish {
    code: u16,
    reason: Option<&'static str>,
}

fn finish(code: u16, reason: Option<&'static str>) -> Finish {
    Finish { code, reason }
}

async fn run_stream(shared: Arc<Shared>, stream_id: String, mut closing: oneshot::Receiver<u16>) {
    let mut filter = RfbClientFilter::new();
    let (outcome, socket) = relay_stream(&shared, &stream_id, &mut closing, &mut filter).await;
    lock(&shared.streams).remove(&stream_id);
    let logger = shared.logger();
    if let Some(reason) = outcome.reason {
        shared.send(json!({ "type": "stream.failed", "streamId": stream_id, "reason": reason }));
    }
    let mut fields = json!({ "streamId": stream_id, "code": outcome.code });
    if let Some(reason) = outcome.reason {
        fields["reason"] = json!(reason);
    }
    fields["input"] =
        json!({ "forwarded": filter.input.forwarded, "dropped": filter.input.dropped });
    logger.info(fields, "Desktop stream closed");
    if let Some(socket) = socket {
        socket.close(outcome.code).await;
    }
}

/// The stream socket's write half runs in its own task so a slow viewer
/// never stalls input from Cloud.
struct StreamSocket {
    out: mpsc::Sender<Message>,
    writer: JoinHandle<()>,
    reader: futures::stream::SplitStream<Socket>,
}

impl StreamSocket {
    async fn close(mut self, code: u16) {
        if self.writer.is_finished() {
            return;
        }
        let _ = tokio::time::timeout(CLOSE_TIMEOUT, async {
            if self.out.send(close_frame(code)).await.is_ok() {
                while let Some(Ok(message)) = self.reader.next().await {
                    if matches!(message, Message::Close(_)) {
                        break;
                    }
                }
            }
        })
        .await;
        self.writer.abort();
    }
}

async fn relay_stream(
    shared: &Arc<Shared>,
    stream_id: &str,
    closing: &mut oneshot::Receiver<u16>,
    filter: &mut RfbClientFilter,
) -> (Finish, Option<StreamSocket>) {
    let logger = shared.logger();
    let closed = |code: Result<u16, oneshot::error::RecvError>| finish(code.unwrap_or(1001), None);
    let vnc = tokio::select! {
        vnc = shared.options.desktop.open_stream() => vnc,
        code = &mut *closing => return (closed(code), None),
    };
    let vnc = match vnc {
        Ok(vnc) => vnc,
        Err(error) => {
            logger.warn(
                json!({ "error": error }),
                "Desktop stream source is unreachable",
            );
            shared.withdraw();
            return (finish(1000, Some("desktop_unavailable")), None);
        }
    };
    let (mut vnc_read, mut vnc_write) = tokio::io::split(vnc);
    // Keep reading until the stream opens so a dropped source is noticed; it
    // only sends its 12-byte version before the viewer answers.
    let mut early = Vec::new();
    let mut buffer = vec![0u8; RELAY_CHUNK_BYTES];
    let connecting = async {
        let token = shared
            .options
            .tokens
            .get_token()
            .await
            .map_err(|_| finish(1000, Some("connect_failed")))?;
        let base = shared.base.clone().unwrap_or_default();
        let url = format!("{base}/api/machine-desktop/streams/{stream_id}");
        match tokio::time::timeout(STREAM_CONNECT_TIMEOUT, connect(&url, &token, None)).await {
            Ok(Ok(socket)) => Ok(socket),
            Ok(Err(ConnectError::Refused(status))) => {
                if status == 401 {
                    shared.options.tokens.invalidate();
                }
                Err(finish(1000, Some("connect_failed")))
            }
            Ok(Err(ConnectError::Failed(_))) | Err(_) => Err(finish(1000, Some("connect_failed"))),
        }
    };
    tokio::pin!(connecting);
    let socket = loop {
        tokio::select! {
            result = &mut connecting => match result {
                Ok(socket) => break socket,
                Err(outcome) => return (outcome, None),
            },
            read = vnc_read.read(&mut buffer) => match read {
                Ok(0) | Err(_) => return (finish(1000, Some("desktop_unavailable")), None),
                Ok(count) => {
                    early.extend_from_slice(&buffer[..count]);
                    if early.len() > MAX_EARLY_VNC_BYTES {
                        return (finish(1011, Some("rfb_protocol_error")), None);
                    }
                }
            },
            code = &mut *closing => return (closed(code), None),
        }
    };
    logger.info(json!({ "streamId": stream_id }), "Desktop stream opened");
    let (mut sink, reader) = socket.split();
    let (out, mut queue) = mpsc::channel::<Message>(STREAM_QUEUE);
    let writer = tokio::spawn(async move {
        while let Some(message) = queue.recv().await {
            let close = matches!(message, Message::Close(_));
            if sink.send(message).await.is_err() || close {
                break;
            }
        }
    });
    let mut socket = StreamSocket {
        out,
        writer,
        reader,
    };
    if !early.is_empty()
        && socket
            .out
            .send(Message::Binary(early.into()))
            .await
            .is_err()
    {
        return (finish(1000, None), Some(socket));
    }
    let (source_ended, mut source_done) = oneshot::channel::<u16>();
    let source_out = socket.out.clone();
    let source = tokio::spawn(async move {
        let mut buffer = vec![0u8; RELAY_CHUNK_BYTES];
        let code = loop {
            match vnc_read.read(&mut buffer).await {
                Ok(0) => break 1000,
                Err(_) => break 1011,
                Ok(count) => {
                    let chunk = Message::Binary(buffer[..count].to_vec().into());
                    if source_out.send(chunk).await.is_err() {
                        break 1000;
                    }
                }
            }
        };
        let _ = source_ended.send(code);
    });
    // A static desktop sends nothing, so without pings a vanished Cloud pod
    // would hold the stream source and its slot indefinitely.
    let mut keep_alive = KeepAlive::new();
    let lease = &shared.options.desktop.lease;
    let outcome = loop {
        tokio::select! {
            message = socket.reader.next() => match message {
                Some(Ok(Message::Binary(data))) => {
                    match filter.push(&data, lease.allows_stream_input(stream_id)) {
                        Ok(forward) => {
                            if !forward.is_empty() && vnc_write.write_all(&forward).await.is_err() {
                                break finish(1000, None);
                            }
                        }
                        Err(error) => {
                            logger.warn(json!({ "error": error.0 }), "Desktop stream protocol error");
                            break finish(1008, Some("rfb_protocol_error"));
                        }
                    }
                }
                Some(Ok(Message::Pong(_))) => keep_alive.last_pong = Instant::now(),
                Some(Ok(Message::Close(_))) | None => break finish(1000, None),
                Some(Ok(_)) => {}
                Some(Err(_)) => break finish(1011, None),
            },
            code = &mut source_done => break finish(code.unwrap_or(1000), None),
            alive = keep_alive.tick() => {
                if !alive || socket.out.send(Message::Ping(Vec::new().into())).await.is_err() {
                    socket.writer.abort();
                    break finish(1000, None);
                }
            }
            code = &mut *closing => break closed(code),
        }
    };
    source.abort();
    let _ = vnc_write.shutdown().await;
    (outcome, Some(socket))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cloud::identity::MachineIdentity;
    use crate::cloud::token_client::TokenClientOptions;
    use crate::desktop::fake::{FakeDesktopMode, FakeDesktopProvider};

    const STREAM: &str = "0b5e9c1a-1234-4abc-8def-0123456789ab";

    fn shared() -> Arc<Shared> {
        let options = DesktopLinkOptions {
            cloud_base_url: "http://127.0.0.1:9".into(),
            tokens: Arc::new(TokenClient::new(TokenClientOptions {
                client_id: "machine".into(),
                identity: MachineIdentity::generate().unwrap(),
                token_endpoint: "http://127.0.0.1:9/token".into(),
                resource: "http://127.0.0.1:9".into(),
            })),
            desktop: Arc::new(DesktopService::new(Arc::new(FakeDesktopProvider::new(
                FakeDesktopMode::Full,
                None,
            )))),
            machine_version: "test".into(),
            logger: Logger::silent(),
        };
        Arc::new(Shared {
            base: to_websocket_base(&options.cloud_base_url),
            options,
            streams: Mutex::default(),
            outgoing: mpsc::unbounded_channel().0,
            withdrawals: watch::channel(0).0,
            closed: AtomicBool::new(false),
            shutdown: watch::channel(false).0,
        })
    }

    #[tokio::test]
    async fn a_withdrawal_before_the_session_waits_still_ends_it() {
        let shared = shared();
        let mut withdrawn = shared.withdrawals.subscribe();
        shared.withdraw();
        tokio::time::timeout(Duration::from_secs(1), withdrawn.changed())
            .await
            .expect("withdrawal was lost")
            .unwrap();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn no_stream_starts_once_shutdown_drained_the_streams() {
        let shared = shared();
        // Shutdown's order: `closed`, then drain under the lock. The opener
        // arrives first and waits for the lock while shutdown runs.
        let streams = lock(&shared.streams);
        let opener = {
            let shared = shared.clone();
            let runtime = tokio::runtime::Handle::current();
            std::thread::spawn(move || {
                let _guard = runtime.enter();
                open_stream(&shared, STREAM.into());
            })
        };
        std::thread::sleep(Duration::from_millis(100));
        shared.closed.store(true, Ordering::SeqCst);
        drop(streams);
        opener.join().unwrap();
        assert!(lock(&shared.streams).is_empty());
    }

    #[test]
    fn websocket_base_follows_the_cloud_scheme() {
        assert_eq!(
            to_websocket_base("https://cloud.example/").unwrap(),
            "wss://cloud.example"
        );
        assert_eq!(
            to_websocket_base("http://127.0.0.1:8080/base/").unwrap(),
            "ws://127.0.0.1:8080/base"
        );
        assert!(to_websocket_base("ftp://cloud.example").is_err());
    }

    #[test]
    fn stream_ids_are_uuids() {
        assert!(STREAM_ID.is_match("0B5E9C1A-1234-4abc-8def-0123456789ab"));
        assert!(!STREAM_ID.is_match("not-a-uuid"));
    }
}
