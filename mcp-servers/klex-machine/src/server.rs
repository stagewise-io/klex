//! HTTP listener: `/health`, `/mcp` (push subscriptions, then rmcp), the
//! MCP Hono app's JSON and DNS-rebinding checks, and signal shutdown.

use std::path::PathBuf;
use std::process::ExitCode;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::Router;
use axum::body::Body;
use axum::extract::{Request, State};
use axum::http::{HeaderMap, Method, StatusCode, header};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::any;
use http_body_util::BodyExt;
use rmcp::transport::streamable_http_server::session::local::LocalSessionManager;
use rmcp::transport::streamable_http_server::{StreamableHttpServerConfig, StreamableHttpService};
use serde_json::{Value, json};
use tower::ServiceExt;

use crate::config::RuntimeConfig;
use crate::desktop::service::DesktopService;
use crate::logger::Logger;
use crate::mcp::{Machine, MachineHandler, MachineOptions};
use crate::notifications::NotificationStore;
use crate::platform::signals;
use crate::push::is_push_listen;

pub struct ServeOptions {
    pub config: RuntimeConfig,
    pub data_dir: PathBuf,
    pub omit_host_details: bool,
    pub desktop: Option<Arc<DesktopService>>,
}

type McpService = StreamableHttpService<MachineHandler, LocalSessionManager>;

/// One principal's MCP endpoint: push subscriptions, then rmcp.
#[derive(Clone)]
pub struct MachineEndpoint {
    machine: Arc<Machine>,
    mcp: McpService,
}

impl MachineEndpoint {
    pub fn new(machine: Arc<Machine>) -> Self {
        let handler = MachineHandler::new(machine.clone());
        let mcp = StreamableHttpService::new(
            move || Ok(handler.clone()),
            Arc::new(LocalSessionManager::default()),
            StreamableHttpServerConfig::default()
                .with_legacy_session_mode(false)
                .with_json_response(true)
                .disable_allowed_hosts()
                .with_max_request_body_bytes(usize::MAX),
        );
        Self { machine, mcp }
    }

    pub fn machine(&self) -> &Arc<Machine> {
        &self.machine
    }

    pub async fn handle(&self, request: Request) -> Response {
        let request = if request.method() == Method::POST {
            let (parts, body) = request.into_parts();
            let bytes = match body.collect().await {
                Ok(collected) => collected.to_bytes(),
                Err(_) => return invalid_json(),
            };
            if let Ok(message) = serde_json::from_slice::<Value>(&bytes)
                && message.is_object()
                && is_push_listen(&message)
            {
                return self
                    .machine
                    .subscriptions()
                    .listen(&message, self.machine.principal_id());
            }
            Request::from_parts(parts, Body::from(bytes))
        } else {
            request
        };
        self.machine.prepare_icons().await;
        match self.mcp.clone().oneshot(request).await {
            Ok(response) => response.map(Body::new),
            Err(never) => match never {},
        }
    }
}

#[derive(Clone)]
struct AppState {
    endpoint: MachineEndpoint,
    /// `createMcpHonoApp` protects these listener hosts from DNS rebinding.
    validates_local_hosts: bool,
}

const LOCAL_HOSTNAMES: [&str; 3] = ["localhost", "127.0.0.1", "[::1]"];

/// A repeated shutdown signal ends the process at once, except within this
/// window after the first. The npm launcher forwards SIGINT and SIGTERM, and
/// a terminal or a process-group kill also signals this process directly, so
/// one request can arrive twice.
pub(crate) const REPEAT_SIGNAL_WINDOW: Duration = Duration::from_millis(500);

/// Startup failures are errors; a failed shutdown is logged and exits 1.
pub async fn serve(options: ServeOptions, logger: Logger) -> Result<ExitCode, String> {
    let ServeOptions {
        config,
        data_dir,
        omit_host_details,
        desktop,
    } = options;
    let store = Arc::new(NotificationStore::new(Some(&data_dir), logger.clone()));
    store.ready().await.map_err(|error| error.0)?;
    let machine = Machine::new(MachineOptions {
        default_cwd: config.cwd.clone(),
        principal_id: "local".into(),
        store: store.clone(),
        owns_store: false,
        logger: logger.clone(),
        omit_host_details,
        desktop,
    });

    let listener = match tokio::net::TcpListener::bind((config.host.as_str(), config.port)).await {
        Ok(listener) => listener,
        Err(error) => {
            let _ = machine.close().await;
            let _ = store.close().await;
            return Err(listen_error(&error, &config.host, config.port));
        }
    };
    let port = listener
        .local_addr()
        .map(|address| address.port())
        .unwrap_or(config.port);

    let state = AppState {
        endpoint: MachineEndpoint::new(machine.clone()),
        validates_local_hosts: ["127.0.0.1", "localhost", "::1"].contains(&config.host.as_str()),
    };
    let app = Router::new()
        .route("/health", any(health))
        .route("/mcp", any(mcp_endpoint))
        .fallback(not_found)
        .layer(middleware::from_fn_with_state(state.clone(), hono_checks))
        .with_state(state);

    // Before the ready log: whoever waits for it may signal right away.
    let first_signal = signals::shutdown();
    if config.warns_about_remote_access {
        logger.warn(
            json!({ "host": config.host, "port": port }),
            "UNRESTRICTED, UNAUTHENTICATED machine access is exposed on a non-loopback interface",
        );
    }
    logger.info(
        json!({ "cwd": crate::paths::display(&config.cwd), "host": config.host, "port": port }),
        "klex-machine MCP server listening",
    );

    let shutdown_machine = machine.clone();
    let shutdown_logger = logger.clone();
    let (closed_tx, closed_rx) =
        tokio::sync::oneshot::channel::<(&'static str, Result<(), String>)>();
    let shutdown = async move {
        let signal = first_signal.await;
        let received = Instant::now();
        shutdown_logger.info(
            json!({ "signal": signal }),
            "Shutting down klex-machine MCP server",
        );
        // Any further signal ends the process at once, except a copy of this
        // one inside the repeat window.
        tokio::spawn(async move {
            loop {
                let repeat = signals::shutdown().await;
                if repeat != signal || received.elapsed() >= REPEAT_SIGNAL_WINDOW {
                    signals::terminate_by(repeat);
                }
            }
        });
        // Close SSE streams before waiting for the listener; open subscription
        // responses would otherwise block graceful shutdown.
        tokio::spawn(async move {
            let closed = shutdown_machine.close().await;
            let _ = closed_tx.send((signal, closed));
        });
    };
    let served = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
        .map_err(|error| error.to_string());
    let (signal, machine_closed) = match closed_rx.await {
        Ok((signal, closed)) => (Some(signal), closed),
        Err(_) => (None, Ok(())),
    };
    let store_closed = store.close().await;
    let Some(error) = store_closed.err().or(served.err()).or(machine_closed.err()) else {
        return Ok(ExitCode::SUCCESS);
    };
    logger.error(
        json!({ "error": error, "signal": signal }),
        "Failed to shut down klex-machine",
    );
    Ok(ExitCode::FAILURE)
}

fn listen_error(error: &std::io::Error, host: &str, port: u16) -> String {
    let (code, description) = match error.kind() {
        std::io::ErrorKind::AddrInUse => ("EADDRINUSE", "address already in use"),
        std::io::ErrorKind::PermissionDenied => ("EACCES", "permission denied"),
        std::io::ErrorKind::AddrNotAvailable => ("EADDRNOTAVAIL", "address not available"),
        _ => return format!("listen {error} {host}:{port}"),
    };
    format!("listen {code}: {description} {host}:{port}")
}

async fn health(method: Method) -> Response {
    if method == Method::GET || method == Method::HEAD {
        return axum::Json(json!({ "status": "ok", "service": crate::SERVICE_NAME }))
            .into_response();
    }
    not_found().await
}

async fn not_found() -> Response {
    (
        StatusCode::NOT_FOUND,
        [(header::CONTENT_TYPE, "text/plain; charset=UTF-8")],
        "404 Not Found",
    )
        .into_response()
}

fn is_json_content_type(headers: &HeaderMap) -> bool {
    headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.split(';').next())
        .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"))
}

fn forbidden(message: String) -> Response {
    (StatusCode::FORBIDDEN, axum::Json(json!({ "jsonrpc": "2.0", "error": { "code": -32000, "message": message }, "id": null })))
        .into_response()
}

/// WHATWG `new URL(...).hostname` for the host forms MCP clients send.
fn url_hostname(authority: &str) -> Option<String> {
    let authority = authority.trim();
    if authority.is_empty()
        || authority
            .contains(|character: char| character.is_whitespace() || "/?#@".contains(character))
    {
        return None;
    }
    let host = if let Some(rest) = authority.strip_prefix('[') {
        let end = rest.find(']')?;
        let address: std::net::Ipv6Addr = rest[..end].parse().ok()?;
        let port = &rest[end + 1..];
        if !(port.is_empty()
            || port
                .strip_prefix(':')
                .is_some_and(|port| port.chars().all(|c| c.is_ascii_digit())))
        {
            return None;
        }
        return Some(format!("[{address}]"));
    } else {
        match authority.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|character| character.is_ascii_digit()) => host,
            Some(_) => return None,
            None => authority,
        }
    };
    if host.is_empty() {
        return None;
    }
    let host = host.to_ascii_lowercase();
    let looks_numeric = host.split('.').next_back().is_some_and(|last| {
        !last.is_empty() && (last.chars().all(|c| c.is_ascii_digit()) || last.starts_with("0x"))
    });
    if looks_numeric {
        return crate::config::parse_whatwg_ipv4(&host).map(|address| address.to_string());
    }
    Some(host)
}

fn origin_hostname(origin: &str) -> Option<String> {
    let (scheme, rest) = origin.split_once("://")?;
    if scheme.is_empty()
        || !scheme
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "+-.".contains(c))
    {
        return None;
    }
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let authority = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    url_hostname(authority)
}

async fn hono_checks(State(state): State<AppState>, request: Request, next: Next) -> Response {
    let request = if is_json_content_type(request.headers()) {
        let (parts, body) = request.into_parts();
        let Ok(collected) = body.collect().await else {
            return invalid_json();
        };
        let bytes = collected.to_bytes();
        if serde_json::from_slice::<serde::de::IgnoredAny>(&bytes).is_err() {
            return invalid_json();
        }
        Request::from_parts(parts, Body::from(bytes))
    } else {
        request
    };
    if state.validates_local_hosts {
        let host = request
            .headers()
            .get(header::HOST)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if host.is_empty() {
            return forbidden("Missing Host header".into());
        }
        match url_hostname(&host) {
            None => return forbidden(format!("Invalid Host header: {host}")),
            Some(hostname) if !LOCAL_HOSTNAMES.contains(&hostname.as_str()) => {
                return forbidden(format!("Invalid Host: {hostname}"));
            }
            Some(_) => {}
        }
        let origin = request
            .headers()
            .get(header::ORIGIN)
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_string();
        if !origin.is_empty() {
            match origin_hostname(&origin) {
                None => return forbidden(format!("Invalid Origin header: {origin}")),
                Some(hostname) if !LOCAL_HOSTNAMES.contains(&hostname.as_str()) => {
                    return forbidden(format!("Invalid Origin: {hostname}"));
                }
                Some(_) => {}
            }
        }
    }
    next.run(request).await
}

fn invalid_json() -> Response {
    (
        StatusCode::BAD_REQUEST,
        [(header::CONTENT_TYPE, "text/plain; charset=UTF-8")],
        "Invalid JSON",
    )
        .into_response()
}

async fn mcp_endpoint(State(state): State<AppState>, request: Request) -> Response {
    state.endpoint.handle(request).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_hostnames_like_whatwg_url() {
        assert_eq!(url_hostname("localhost:3123").as_deref(), Some("localhost"));
        assert_eq!(url_hostname("LOCALHOST").as_deref(), Some("localhost"));
        assert_eq!(url_hostname("127.1:80").as_deref(), Some("127.0.0.1"));
        assert_eq!(url_hostname("[::1]:3123").as_deref(), Some("[::1]"));
        assert_eq!(url_hostname("[0:0::1]").as_deref(), Some("[::1]"));
        assert_eq!(
            url_hostname("evil.example").as_deref(),
            Some("evil.example")
        );
        assert_eq!(url_hostname("a b"), None);
        assert_eq!(
            origin_hostname("http://localhost:5173").as_deref(),
            Some("localhost")
        );
        assert_eq!(
            origin_hostname("https://evil.example").as_deref(),
            Some("evil.example")
        );
        assert_eq!(origin_hostname("null"), None);
    }
}
