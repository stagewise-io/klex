//! Environment side of the `@klex/mcp-proxy-sdk` protocol v2: one outbound
//! WebSocket to the Cloud proxy that carries HTTP exchanges as JSON frames.
//! Reconnects with jittered exponential backoff and asks the connection
//! provider for fresh credentials on every attempt.

use std::collections::{BTreeMap, HashMap};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, Response};
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use futures::future::BoxFuture;
use futures::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot, watch};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::protocol::CloseFrame;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::{Message, http::HeaderValue};

use super::http;

pub const PROXY_PROTOCOL_VERSION: u64 = 2;
pub const MAX_PROXY_CHUNK_BYTES: usize = 64 * 1024;
const HEARTBEAT_INTERVAL: Duration = Duration::from_secs(25);
const CLOSE_TIMEOUT: Duration = Duration::from_secs(30);
const RECONNECT_INITIAL_MS: f64 = 250.0;
const RECONNECT_MAXIMUM_MS: f64 = 30_000.0;
const RECONNECT_FACTOR: f64 = 2.0;
const RECONNECT_JITTER: f64 = 0.2;

pub struct ProxyConnection {
    pub url: String,
    pub headers: Vec<(String, String)>,
}

pub type ConnectionProvider =
    Arc<dyn Fn() -> BoxFuture<'static, Result<ProxyConnection, String>> + Send + Sync>;
pub type ProxyHandler =
    Arc<dyn Fn(Request<Body>) -> BoxFuture<'static, Response<Body>> + Send + Sync>;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

pub struct ProxyDaemon {
    shutdown: watch::Sender<bool>,
    task: tokio::sync::Mutex<Option<tokio::task::JoinHandle<()>>>,
}

async fn connect(provider: &ConnectionProvider) -> Result<Socket, String> {
    let connection = provider().await?;
    let url = url::Url::parse(&connection.url).map_err(|_| "Invalid URL".to_string())?;
    if url.scheme() != "ws" && url.scheme() != "wss" {
        return Err("Proxy URL must use ws: or wss:".into());
    }
    let failed = || "Proxy connection failed".to_string();
    let mut request = url.as_str().into_client_request().map_err(|_| failed())?;
    for (name, value) in &connection.headers {
        let name = axum::http::HeaderName::from_bytes(name.as_bytes()).map_err(|_| failed())?;
        let value = HeaderValue::from_str(value).map_err(|_| failed())?;
        request.headers_mut().insert(name, value);
    }
    let connector = tokio_tungstenite::Connector::Rustls(http::tls());
    let (socket, _) =
        tokio_tungstenite::connect_async_tls_with_config(request, None, true, Some(connector))
            .await
            .map_err(|_| failed())?;
    Ok(socket)
}

async fn until_stopped(stopped: &mut watch::Receiver<bool>) {
    let _ = stopped.wait_for(|stopped| *stopped).await;
}

fn reconnect_delay(attempt: u32) -> Duration {
    let base = RECONNECT_MAXIMUM_MS
        .min(RECONNECT_INITIAL_MS * RECONNECT_FACTOR.powi(attempt.min(64) as i32));
    let mut bytes = [0u8; 8];
    let _ = getrandom::fill(&mut bytes);
    let random = (u64::from_le_bytes(bytes) >> 11) as f64 / (1u64 << 53) as f64;
    let delay = (base + base * RECONNECT_JITTER * (random * 2.0 - 1.0))
        .round()
        .max(0.0);
    Duration::from_millis(delay as u64)
}

/// What the daemon's link to the Cloud proxy is doing right now.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum LinkState {
    /// The first connection attempt is in flight.
    Connecting,
    Connected,
    /// Disconnected and retrying with backoff; holds the last failure.
    Offline(String),
}

pub type LinkStatus = watch::Sender<LinkState>;

impl ProxyDaemon {
    /// Connects once and fails if that first connection cannot be opened.
    pub async fn start(
        connection: ConnectionProvider,
        handler: ProxyHandler,
    ) -> Result<Self, String> {
        let socket = connect(&connection).await?;
        Ok(Self::spawn(connection, handler, Some(socket), None))
    }

    /// Never fails: retries the first connection like a reconnect and
    /// reports every change of the link on `status`.
    pub fn start_supervised(
        connection: ConnectionProvider,
        handler: ProxyHandler,
        status: LinkStatus,
    ) -> Self {
        Self::spawn(connection, handler, None, Some(status))
    }

    fn spawn(
        connection: ConnectionProvider,
        handler: ProxyHandler,
        first: Option<Socket>,
        status: Option<LinkStatus>,
    ) -> Self {
        let (shutdown, mut stopped) = watch::channel(false);
        let report = move |state: LinkState| {
            if let Some(status) = &status {
                status.send_replace(state);
            }
        };
        let task = tokio::spawn(async move {
            let mut immediate = first.is_none();
            let mut socket = first;
            if immediate {
                report(LinkState::Connecting);
            }
            loop {
                if let Some(current) = socket.take() {
                    report(LinkState::Connected);
                    run_session(current, &handler, stopped.clone()).await;
                    let stopping = *stopped.borrow();
                    if stopping {
                        return;
                    }
                    report(LinkState::Offline("Proxy connection closed".into()));
                }
                let mut attempt = 0;
                while socket.is_none() {
                    if !immediate {
                        tokio::select! {
                            () = tokio::time::sleep(reconnect_delay(attempt)) => {}
                            () = until_stopped(&mut stopped) => return,
                        }
                        attempt += 1;
                    }
                    immediate = false;
                    tokio::select! {
                        result = connect(&connection) => match result {
                            Ok(connected) => socket = Some(connected),
                            Err(error) => report(LinkState::Offline(error)),
                        },
                        () = until_stopped(&mut stopped) => return,
                    }
                }
            }
        });
        Self {
            shutdown,
            task: tokio::sync::Mutex::new(Some(task)),
        }
    }

    pub async fn close(&self) {
        self.shutdown.send_replace(true);
        if let Some(task) = self.task.lock().await.take() {
            let _ = task.await;
        }
    }
}

struct Exchange {
    generation: u64,
    _cancel: oneshot::Sender<()>,
}

type Exchanges = Arc<Mutex<HashMap<String, Exchange>>>;

fn lock(exchanges: &Exchanges) -> std::sync::MutexGuard<'_, HashMap<String, Exchange>> {
    exchanges.lock().unwrap_or_else(|error| error.into_inner())
}

/// Removes an exchange if it is still the one this task opened.
fn remove(exchanges: &Exchanges, id: &str, generation: u64) -> bool {
    let mut exchanges = lock(exchanges);
    if exchanges
        .get(id)
        .is_some_and(|exchange| exchange.generation == generation)
    {
        exchanges.remove(id);
        true
    } else {
        false
    }
}

fn is_registered(exchanges: &Exchanges, id: &str, generation: u64) -> bool {
    lock(exchanges)
        .get(id)
        .is_some_and(|exchange| exchange.generation == generation)
}

async fn run_session(socket: Socket, handler: &ProxyHandler, mut stopped: watch::Receiver<bool>) {
    let (mut sink, mut stream) = socket.split();
    let (outgoing, mut queue) = mpsc::channel::<(Message, Option<oneshot::Sender<bool>>)>(64);
    let writer = tokio::spawn(async move {
        while let Some((message, sent)) = queue.recv().await {
            let closing = matches!(message, Message::Close(_));
            let ok = sink.send(message).await.is_ok();
            if let Some(sent) = sent {
                let _ = sent.send(ok);
            }
            if !ok || closing {
                break;
            }
        }
    });
    let exchanges: Exchanges = Arc::default();
    let generations = AtomicU64::new(0);
    let mut heartbeat = tokio::time::interval_at(
        tokio::time::Instant::now() + HEARTBEAT_INTERVAL,
        HEARTBEAT_INTERVAL,
    );
    let mut close_deadline: Option<tokio::time::Instant> = None;
    let protocol_error = || {
        Message::Close(Some(CloseFrame {
            code: CloseCode::Protocol,
            reason: "Protocol error".into(),
        }))
    };
    loop {
        let deadline = async {
            match close_deadline {
                Some(deadline) => tokio::time::sleep_until(deadline).await,
                None => std::future::pending().await,
            }
        };
        tokio::select! {
            () = deadline => break,
            () = until_stopped(&mut stopped), if close_deadline.is_none() => {
                let _ = outgoing.send((Message::Close(None), None)).await;
                close_deadline = Some(tokio::time::Instant::now() + CLOSE_TIMEOUT);
            }
            _ = heartbeat.tick(), if close_deadline.is_none() => {
                if outgoing.send((Message::Ping(Default::default()), None)).await.is_err() {
                    break;
                }
            }
            message = stream.next() => {
                let Some(Ok(message)) = message else { break };
                if close_deadline.is_some() {
                    continue;
                }
                let frame = match message {
                    Message::Text(text) => decode_frame(text.as_str()),
                    Message::Binary(_) => Err(()),
                    Message::Close(_) => break,
                    _ => continue,
                };
                match frame {
                    Ok(Frame::Open(open)) => {
                        let generation = generations.fetch_add(1, Ordering::Relaxed);
                        let (cancel, cancelled) = oneshot::channel();
                        let duplicate = {
                            let mut map = lock(&exchanges);
                            let duplicate = map.contains_key(&open.exchange_id);
                            if !duplicate {
                                map.insert(open.exchange_id.clone(), Exchange { generation, _cancel: cancel });
                            }
                            duplicate
                        };
                        if duplicate {
                            let _ = outgoing.send((protocol_error(), None)).await;
                            close_deadline = Some(tokio::time::Instant::now() + CLOSE_TIMEOUT);
                            continue;
                        }
                        tokio::spawn(serve_exchange(open, generation, cancelled, handler.clone(), exchanges.clone(), outgoing.clone()));
                    }
                    Ok(Frame::Close(id)) => {
                        lock(&exchanges).remove(&id);
                    }
                    Err(()) => {
                        let _ = outgoing.send((protocol_error(), None)).await;
                        close_deadline = Some(tokio::time::Instant::now() + CLOSE_TIMEOUT);
                    }
                }
            }
        }
    }
    lock(&exchanges).clear();
    drop(outgoing);
    writer.abort();
}

async fn send(
    outgoing: &mpsc::Sender<(Message, Option<oneshot::Sender<bool>>)>,
    frame: Value,
) -> Result<(), String> {
    let closed = || "Proxy connection is closed".to_string();
    let (sent, result) = oneshot::channel();
    outgoing
        .send((Message::text(frame.to_string()), Some(sent)))
        .await
        .map_err(|_| closed())?;
    match result.await {
        Ok(true) => Ok(()),
        _ => Err(closed()),
    }
}

async fn serve_exchange(
    open: OpenFrame,
    generation: u64,
    mut cancelled: oneshot::Receiver<()>,
    handler: ProxyHandler,
    exchanges: Exchanges,
    outgoing: mpsc::Sender<(Message, Option<oneshot::Sender<bool>>)>,
) {
    let id = open.exchange_id.clone();
    let result: Result<(), String> = async {
        let mut builder = Request::builder()
            .method(open.method.as_str())
            .uri(open.url.as_str());
        for (name, value) in &open.headers {
            builder = builder.header(name.as_str(), value.as_str());
        }
        let request = builder
            .body(open.body.map(Body::from).unwrap_or_else(Body::empty))
            .map_err(|error| error.to_string())?;
        let response = tokio::select! {
            response = handler(request) => response,
            _ = &mut cancelled => return Ok(()),
        };
        if !is_registered(&exchanges, &id, generation) {
            return Ok(());
        }
        let mut headers = BTreeMap::<String, String>::new();
        for (name, value) in response.headers() {
            let value = String::from_utf8_lossy(value.as_bytes()).into_owned();
            headers
                .entry(name.as_str().to_ascii_lowercase())
                .and_modify(|existing| {
                    existing.push_str(", ");
                    existing.push_str(&value);
                })
                .or_insert(value);
        }
        send(
            &outgoing,
            json!({
                "version": PROXY_PROTOCOL_VERSION,
                "type": "exchange.opened",
                "exchangeId": id,
                "status": response.status().as_u16(),
                "statusText": "",
                "headers": headers,
            }),
        )
        .await?;
        let mut body = response.into_body();
        while is_registered(&exchanges, &id, generation) {
            let frame = tokio::select! {
                frame = body.frame() => frame,
                _ = &mut cancelled => return Ok(()),
            };
            let Some(frame) = frame else { break };
            let frame = frame.map_err(|error| error.to_string())?;
            let Ok(data) = frame.into_data() else {
                continue;
            };
            for chunk in data.chunks(MAX_PROXY_CHUNK_BYTES) {
                send(
                    &outgoing,
                    json!({
                        "version": PROXY_PROTOCOL_VERSION,
                        "type": "exchange.chunk",
                        "exchangeId": id,
                        "data": STANDARD.encode(chunk),
                    }),
                )
                .await?;
            }
        }
        if remove(&exchanges, &id, generation) {
            send(
                &outgoing,
                json!({
                    "version": PROXY_PROTOCOL_VERSION,
                    "type": "exchange.close",
                    "exchangeId": id,
                }),
            )
            .await?;
        }
        Ok(())
    }
    .await;
    if let Err(reason) = result
        && remove(&exchanges, &id, generation)
    {
        let mut frame = json!({
            "version": PROXY_PROTOCOL_VERSION,
            "type": "exchange.close",
            "exchangeId": id,
        });
        if !reason.is_empty() {
            frame["reason"] = Value::String(reason);
        }
        let _ = send(&outgoing, frame).await;
    }
}

#[derive(Debug, PartialEq)]
struct OpenFrame {
    exchange_id: String,
    method: String,
    url: String,
    headers: Vec<(String, String)>,
    body: Option<Vec<u8>>,
}

#[derive(Debug, PartialEq)]
enum Frame {
    Open(OpenFrame),
    Close(String),
}

fn is_token(name: &str) -> bool {
    !name.is_empty()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"!#$%&'*+.^_`|~-".contains(&byte))
}

/// Canonical base64 as `btoa(atob(value)) === value` accepts it.
fn canonical_base64(value: &str) -> Option<Vec<u8>> {
    let bytes = STANDARD.decode(value).ok()?;
    (STANDARD.encode(&bytes) == value).then_some(bytes)
}

fn only_keys(record: &Map<String, Value>, allowed: &[&str]) -> bool {
    record.keys().all(|key| allowed.contains(&key.as_str()))
}

/// `decodeProxyToEnvironmentFrame`: strict zod schemas for the two frames a
/// proxy may send.
fn decode_frame(input: &str) -> Result<Frame, ()> {
    let Ok(Value::Object(record)) = serde_json::from_str::<Value>(input) else {
        return Err(());
    };
    if record.get("version").and_then(Value::as_f64) != Some(PROXY_PROTOCOL_VERSION as f64) {
        return Err(());
    }
    let exchange_id = match record.get("exchangeId") {
        Some(Value::String(id)) if !id.is_empty() && id.trim() == id => id.clone(),
        _ => return Err(()),
    };
    match record.get("type").and_then(Value::as_str) {
        Some("exchange.open") => {
            if !only_keys(
                &record,
                &[
                    "version",
                    "type",
                    "exchangeId",
                    "method",
                    "url",
                    "headers",
                    "body",
                ],
            ) {
                return Err(());
            }
            let method = record.get("method").and_then(Value::as_str).ok_or(())?;
            if method.is_empty() || !method.bytes().all(|byte| byte.is_ascii_uppercase()) {
                return Err(());
            }
            let url = record.get("url").and_then(Value::as_str).ok_or(())?;
            url::Url::parse(url).map_err(|_| ())?;
            let Some(Value::Object(raw_headers)) = record.get("headers") else {
                return Err(());
            };
            let mut headers = Vec::with_capacity(raw_headers.len());
            for (name, value) in raw_headers {
                let value = value.as_str().ok_or(())?;
                if !is_token(name) || value.contains(['\r', '\n']) {
                    return Err(());
                }
                headers.push((name.clone(), value.to_string()));
            }
            let body = match record.get("body") {
                None => None,
                Some(Value::String(body)) => Some(canonical_base64(body).ok_or(())?),
                Some(_) => return Err(()),
            };
            Ok(Frame::Open(OpenFrame {
                exchange_id,
                method: method.into(),
                url: url.into(),
                headers,
                body: body.filter(|body| !body.is_empty()),
            }))
        }
        Some("exchange.close") => {
            if !only_keys(&record, &["version", "type", "exchangeId", "reason"]) {
                return Err(());
            }
            match record.get("reason") {
                None => {}
                Some(Value::String(reason)) if !reason.is_empty() => {}
                Some(_) => return Err(()),
            }
            Ok(Frame::Close(exchange_id))
        }
        _ => Err(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_frames_strictly() {
        let open = r#"{"version":2,"type":"exchange.open","exchangeId":"e1","method":"POST","url":"https://proxy.example/machines/m/mcp","headers":{"content-type":"application/json"},"body":"e30="}"#;
        assert_eq!(
            decode_frame(open),
            Ok(Frame::Open(OpenFrame {
                exchange_id: "e1".into(),
                method: "POST".into(),
                url: "https://proxy.example/machines/m/mcp".into(),
                headers: vec![("content-type".into(), "application/json".into())],
                body: Some(b"{}".to_vec()),
            }))
        );
        assert_eq!(
            decode_frame(r#"{"version":2,"type":"exchange.close","exchangeId":"e1"}"#),
            Ok(Frame::Close("e1".into()))
        );
        for invalid in [
            r#"{"version":1,"type":"exchange.close","exchangeId":"e1"}"#,
            r#"{"version":2,"type":"exchange.close","exchangeId":" e1"}"#,
            r#"{"version":2,"type":"exchange.close","exchangeId":"e1","reason":""}"#,
            r#"{"version":2,"type":"exchange.close","exchangeId":"e1","extra":1}"#,
            r#"{"version":2,"type":"exchange.chunk","exchangeId":"e1","data":""}"#,
            r#"{"version":2,"type":"exchange.open","exchangeId":"e1","method":"post","url":"https://x","headers":{}}"#,
            r#"{"version":2,"type":"exchange.open","exchangeId":"e1","method":"GET","url":"nope","headers":{}}"#,
            r#"{"version":2,"type":"exchange.open","exchangeId":"e1","method":"GET","url":"https://x","headers":{"a b":"c"}}"#,
            r#"{"version":2,"type":"exchange.open","exchangeId":"e1","method":"GET","url":"https://x","headers":{"a":"c\r\n"}}"#,
            r#"{"version":2,"type":"exchange.open","exchangeId":"e1","method":"GET","url":"https://x","headers":{},"body":"e30"}"#,
            "[]",
            "not json",
        ] {
            assert_eq!(decode_frame(invalid), Err(()), "{invalid}");
        }
    }

    #[tokio::test]
    async fn supervised_start_retries_and_reports_the_link() {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!(
            "ws://{}/machine-connections",
            listener.local_addr().unwrap()
        );
        tokio::spawn(async move {
            let (stream, _) = listener.accept().await.unwrap();
            let mut socket = tokio_tungstenite::accept_async(stream).await.unwrap();
            while let Some(Ok(_)) = socket.next().await {}
        });
        let attempts = Arc::new(AtomicU64::new(0));
        let counter = attempts.clone();
        let connection: ConnectionProvider = Arc::new(move || {
            let (counter, url) = (counter.clone(), url.clone());
            Box::pin(async move {
                if counter.fetch_add(1, Ordering::Relaxed) == 0 {
                    return Err("fetch failed".to_string());
                }
                Ok(ProxyConnection {
                    url,
                    headers: Vec::new(),
                })
            })
        });
        let handler: ProxyHandler = Arc::new(|_| Box::pin(async { Response::new(Body::empty()) }));
        let (status, mut states) = watch::channel(LinkState::Offline(String::new()));
        let daemon = ProxyDaemon::start_supervised(connection, handler, status);
        let mut seen = Vec::new();
        while seen.last() != Some(&LinkState::Connected) {
            states.changed().await.unwrap();
            let state = states.borrow_and_update().clone();
            if seen.last() != Some(&state) {
                seen.push(state);
            }
        }
        assert!(
            seen.contains(&LinkState::Offline("fetch failed".into())),
            "{seen:?}"
        );
        assert_eq!(attempts.load(Ordering::Relaxed), 2);
        daemon.close().await;
    }

    #[test]
    fn backs_off_with_jitter() {
        for attempt in 0..20 {
            let delay = reconnect_delay(attempt).as_millis() as f64;
            let base = (250.0 * 2f64.powi(attempt as i32)).min(30_000.0);
            assert!(
                delay >= (base * 0.8).floor() && delay <= (base * 1.2).ceil(),
                "{attempt}: {delay}"
            );
        }
    }
}
