//! Push Notifications extension: capability checks and `subscriptions/listen`
//! streams, intercepted before requests reach the MCP transport.

use std::collections::HashMap;
use std::convert::Infallible;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, Weak};
use std::time::Duration;

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use bytes::Bytes;
use serde_json::{Map, Value, json};
use tokio::sync::mpsc;

pub const PUSH_EXTENSION: &str = "io.stagewise/push-notifications";
pub const GET_METHOD: &str = "io.stagewise/push-notifications/get";
pub const ACK_METHOD: &str = "io.stagewise/push-notifications/ack";
pub const EVENT_METHOD: &str = "io.stagewise/push-notifications/event";
pub const LISTEN_METHOD: &str = "subscriptions/listen";
pub const ACKNOWLEDGED_METHOD: &str = "notifications/subscriptions/acknowledged";
pub const CLIENT_CAPABILITIES_META_KEY: &str = "io.modelcontextprotocol/clientCapabilities";
pub const MISSING_CAPABILITY_CODE: i32 = -32003;
const SUBSCRIPTION_ID_META_KEY: &str = "io.modelcontextprotocol/subscriptionId";
const KEEP_ALIVE: Duration = Duration::from_secs(15);
const MAX_SUBSCRIPTIONS: usize = 128;

/// `hasPerRequestPushNotificationsCapability` over a request's `_meta`.
pub fn has_push_capability(meta: Option<&Map<String, Value>>) -> bool {
    meta.and_then(|meta| meta.get(CLIENT_CAPABILITIES_META_KEY))
        .and_then(Value::as_object)
        .and_then(|capabilities| capabilities.get("extensions"))
        .and_then(Value::as_object)
        .is_some_and(|extensions| extensions.contains_key(PUSH_EXTENSION))
}

pub fn missing_capability_message() -> &'static str {
    "Missing required client capability"
}

pub fn missing_capability_data() -> Value {
    json!({ "requiredCapabilities": { "extensions": { PUSH_EXTENSION: {} } } })
}

fn json_rpc_error(id: Value, code: i32, message: &str, data: Option<Value>) -> Response {
    let mut error = Map::new();
    error.insert("code".into(), json!(code));
    error.insert("message".into(), json!(message));
    if let Some(data) = data {
        error.insert("data".into(), data);
    }
    (
        StatusCode::OK,
        axum::Json(json!({ "jsonrpc": "2.0", "id": id, "error": error })),
    )
        .into_response()
}

/// The request is a `subscriptions/listen` whose filter names this extension.
pub fn is_push_listen(body: &Value) -> bool {
    body.get("method").and_then(Value::as_str) == Some(LISTEN_METHOD)
        && body
            .get("params")
            .and_then(Value::as_object)
            .and_then(|params| params.get("notifications"))
            .and_then(Value::as_object)
            .is_some_and(|notifications| notifications.contains_key(PUSH_EXTENSION))
}

fn request_id(body: &Value) -> Value {
    match body.get("id") {
        Some(id @ (Value::String(_) | Value::Number(_))) => id.clone(),
        _ => Value::Null,
    }
}

struct Subscriber {
    token: u64,
    id: Value,
    sender: mpsc::UnboundedSender<Bytes>,
    keep_alive: tokio::task::JoinHandle<()>,
}

struct Inner {
    subscribers: HashMap<String, Subscriber>,
    closed: bool,
}

pub struct SubscriptionManager {
    inner: Mutex<Inner>,
    next_token: AtomicU64,
    keep_alive: Duration,
    max_subscriptions: usize,
}

fn frame(message: &Value) -> Bytes {
    Bytes::from(format!("event: message\ndata: {message}\n\n"))
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Removes its subscriber when the client goes away.
struct StreamGuard {
    manager: Weak<SubscriptionManager>,
    consumer_key: String,
    token: u64,
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if let Some(manager) = self.manager.upgrade() {
            manager.close_subscriber(&self.consumer_key, self.token, false);
        }
    }
}

impl SubscriptionManager {
    pub fn new() -> Arc<Self> {
        Self::with_options(KEEP_ALIVE, MAX_SUBSCRIPTIONS)
    }

    pub fn with_options(keep_alive: Duration, max_subscriptions: usize) -> Arc<Self> {
        Arc::new(Self {
            inner: Mutex::new(Inner {
                subscribers: HashMap::new(),
                closed: false,
            }),
            next_token: AtomicU64::new(1),
            keep_alive,
            max_subscriptions,
        })
    }

    pub fn subscriber_count(&self) -> usize {
        lock(&self.inner).subscribers.len()
    }

    pub fn listen(self: &Arc<Self>, body: &Value, consumer_key: &str) -> Response {
        if lock(&self.inner).closed {
            return json_rpc_error(Value::Null, -32603, "Subscription manager is closed", None);
        }
        let id = request_id(body);
        let invalid = || {
            json_rpc_error(
                id.clone(),
                -32602,
                "Invalid Push Notifications subscription",
                None,
            )
        };
        let params = body.get("params").and_then(Value::as_object);
        let valid_request = body.get("jsonrpc").and_then(Value::as_str) == Some("2.0")
            && !id.is_null()
            && params.is_some();
        let Some(params) = params.filter(|_| valid_request) else {
            return invalid();
        };
        let subscription = params
            .get("notifications")
            .and_then(|notifications| notifications.get(PUSH_EXTENSION));
        let Some(subscription) = subscription
            .and_then(Value::as_object)
            .filter(|subscription| subscription.is_empty())
        else {
            return invalid();
        };
        let subscription = Value::Object(subscription.clone());
        let meta = params.get("_meta").and_then(Value::as_object);
        if !has_push_capability(meta) {
            return json_rpc_error(
                id,
                MISSING_CAPABILITY_CODE,
                missing_capability_message(),
                Some(missing_capability_data()),
            );
        }
        let progress_token = meta
            .and_then(|meta| meta.get("progressToken"))
            .filter(|token| token.is_string() || token.is_number())
            .cloned();

        let (sender, receiver) = mpsc::unbounded_channel::<Bytes>();
        let token = self.next_token.fetch_add(1, Ordering::SeqCst);
        {
            let mut inner = lock(&self.inner);
            if !inner.subscribers.contains_key(consumer_key)
                && inner.subscribers.len() >= self.max_subscriptions
            {
                return json_rpc_error(id, -32603, "Subscription limit reached", None);
            }
            if let Some(previous) = inner.subscribers.remove(consumer_key) {
                end(previous, true);
            }
            let _ = sender.send(frame(&json!({
                "jsonrpc": "2.0",
                "method": ACKNOWLEDGED_METHOD,
                "params": {
                    "notifications": { PUSH_EXTENSION: subscription },
                    "_meta": { SUBSCRIPTION_ID_META_KEY: id },
                },
            })));
            let keep_alive = self.spawn_keep_alive(
                consumer_key.to_string(),
                token,
                sender.clone(),
                progress_token,
            );
            inner.subscribers.insert(
                consumer_key.to_string(),
                Subscriber {
                    token,
                    id: id.clone(),
                    sender,
                    keep_alive,
                },
            );
        }

        let guard = StreamGuard {
            manager: Arc::downgrade(self),
            consumer_key: consumer_key.to_string(),
            token,
        };
        let stream =
            futures::stream::unfold((receiver, guard), |(mut receiver, guard)| async move {
                let chunk = receiver.recv().await?;
                Some((Ok::<_, Infallible>(chunk), (receiver, guard)))
            });
        let mut response = Response::new(Body::from_stream(stream));
        let headers = response.headers_mut();
        headers.insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/event-stream"),
        );
        headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
        headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
        headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
        response
    }

    fn spawn_keep_alive(
        self: &Arc<Self>,
        consumer_key: String,
        token: u64,
        sender: mpsc::UnboundedSender<Bytes>,
        progress_token: Option<Value>,
    ) -> tokio::task::JoinHandle<()> {
        let manager = Arc::downgrade(self);
        let period = self.keep_alive;
        tokio::spawn(async move {
            if period.is_zero() {
                return;
            }
            let mut interval =
                tokio::time::interval_at(tokio::time::Instant::now() + period, period);
            loop {
                interval.tick().await;
                let chunk = match &progress_token {
                    None => Bytes::from_static(b": keepalive\n\n"),
                    Some(progress_token) => frame(&json!({
                        "jsonrpc": "2.0",
                        "method": "notifications/progress",
                        "params": { "progressToken": progress_token, "progress": crate::time::now_ms() },
                    })),
                };
                if sender.send(chunk).is_err() {
                    if let Some(manager) = manager.upgrade() {
                        manager.close_subscriber(&consumer_key, token, false);
                    }
                    return;
                }
            }
        })
    }

    fn close_subscriber(&self, consumer_key: &str, token: u64, graceful: bool) {
        let removed = {
            let mut inner = lock(&self.inner);
            match inner.subscribers.get(consumer_key) {
                Some(subscriber) if subscriber.token == token => {
                    inner.subscribers.remove(consumer_key)
                }
                _ => None,
            }
        };
        if let Some(subscriber) = removed {
            end(subscriber, graceful);
        }
    }

    pub fn publish(&self, consumer_key: &str, event: Value) {
        let failed = {
            let inner = lock(&self.inner);
            let Some(subscriber) = inner.subscribers.get(consumer_key) else {
                return;
            };
            let message = json!({
                "jsonrpc": "2.0",
                "method": EVENT_METHOD,
                "params": { "event": event, "_meta": { SUBSCRIPTION_ID_META_KEY: subscriber.id } },
            });
            subscriber
                .sender
                .send(frame(&message))
                .is_err()
                .then_some(subscriber.token)
        };
        if let Some(token) = failed {
            self.close_subscriber(consumer_key, token, false);
        }
    }

    pub fn close(&self) {
        let subscribers: Vec<Subscriber> = {
            let mut inner = lock(&self.inner);
            if inner.closed {
                return;
            }
            inner.closed = true;
            inner
                .subscribers
                .drain()
                .map(|(_, subscriber)| subscriber)
                .collect()
        };
        for subscriber in subscribers {
            end(subscriber, true);
        }
    }
}

fn end(subscriber: Subscriber, graceful: bool) {
    subscriber.keep_alive.abort();
    if graceful {
        let _ = subscriber.sender.send(frame(&json!({
            "jsonrpc": "2.0",
            "id": subscriber.id,
            "result": { "resultType": "complete", "_meta": { SUBSCRIPTION_ID_META_KEY: subscriber.id } },
        })));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use http_body_util::BodyExt;

    fn listen_body(id: Value) -> Value {
        json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": LISTEN_METHOD,
            "params": {
                "notifications": { PUSH_EXTENSION: {} },
                "_meta": { CLIENT_CAPABILITIES_META_KEY: { "extensions": { PUSH_EXTENSION: {} } } },
            },
        })
    }

    async fn next_frame(body: &mut Body) -> String {
        let frame = body.frame().await.unwrap().unwrap();
        String::from_utf8(frame.into_data().unwrap().to_vec()).unwrap()
    }

    async fn json_body(response: Response) -> Value {
        let bytes = response.into_body().collect().await.unwrap().to_bytes();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[tokio::test]
    async fn streams_events_and_replaces_subscribers() {
        let manager = SubscriptionManager::new();
        let mut first = manager.listen(&listen_body(json!(1)), "local").into_body();
        assert!(next_frame(&mut first).await.contains(ACKNOWLEDGED_METHOD));
        manager.publish("local", json!({ "eventId": "e" }));
        let published = next_frame(&mut first).await;
        assert!(published.starts_with("event: message\ndata: "));
        assert!(published.contains(r#""eventId":"e""#));

        let mut second = manager
            .listen(&listen_body(json!("two")), "local")
            .into_body();
        let closing = next_frame(&mut first).await;
        assert!(closing.contains(r#""resultType":"complete""#) && closing.contains(r#""id":1"#));
        assert!(first.frame().await.is_none());
        assert!(
            next_frame(&mut second)
                .await
                .contains(r#""io.modelcontextprotocol/subscriptionId":"two""#)
        );
        drop(second);
        assert_eq!(manager.subscriber_count(), 0);
    }

    #[tokio::test]
    async fn validates_requests() {
        let manager = SubscriptionManager::new();
        let mut body = listen_body(json!(3));
        body["params"]["notifications"][PUSH_EXTENSION] = json!({ "x": 1 });
        let error = json_body(manager.listen(&body, "local")).await;
        assert_eq!(error["error"]["code"], -32602);
        assert_eq!(error["id"], 3);
        let mut body = listen_body(json!(4));
        body["params"]["_meta"] = json!({});
        let error = json_body(manager.listen(&body, "local")).await;
        assert_eq!(error["error"]["code"], -32003);
        assert_eq!(error["error"]["data"], missing_capability_data());
        manager.close();
        let error = json_body(manager.listen(&listen_body(json!(5)), "local")).await;
        assert_eq!(error["error"]["message"], "Subscription manager is closed");
        assert_eq!(error["id"], Value::Null);
    }

    #[tokio::test(start_paused = true)]
    async fn sends_keep_alives() {
        let manager = SubscriptionManager::new();
        let mut body = manager.listen(&listen_body(json!(1)), "local").into_body();
        next_frame(&mut body).await;
        tokio::time::advance(KEEP_ALIVE).await;
        assert_eq!(next_frame(&mut body).await, ": keepalive\n\n");
    }
}
