//! Routes authenticated proxy requests to one Machine per principal. All
//! principals share the notification store; subscriptions stay isolated by
//! principal ID.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use axum::body::Body;
use axum::extract::Request;
use axum::http::{StatusCode, header};
use axum::response::{IntoResponse, Response};

use super::auth::Authenticator;
use crate::logger::Logger;
use crate::mcp::{Machine, MachineOptions};
use crate::notifications::NotificationStore;
use crate::server::MachineEndpoint;

pub struct PrincipalRouterOptions {
    pub authenticator: Authenticator,
    pub default_cwd: PathBuf,
    pub store: Arc<NotificationStore>,
    pub logger: Logger,
    pub omit_host_details: bool,
}

pub struct PrincipalRouter {
    options: PrincipalRouterOptions,
    principals: Mutex<HashMap<String, MachineEndpoint>>,
    closed: AtomicBool,
}

fn text_response(status: StatusCode, body: &'static str) -> Response {
    (
        status,
        [(header::CONTENT_TYPE, "text/plain;charset=UTF-8")],
        body,
    )
        .into_response()
}

impl PrincipalRouter {
    pub fn new(options: PrincipalRouterOptions) -> Self {
        Self {
            options,
            principals: Mutex::default(),
            closed: AtomicBool::new(false),
        }
    }

    fn unavailable() -> Response {
        text_response(StatusCode::SERVICE_UNAVAILABLE, "Service unavailable")
    }

    pub async fn fetch(&self, request: Request<Body>) -> Response {
        if self.closed.load(Ordering::SeqCst) {
            return Self::unavailable();
        }
        let Some(principal_id) = self
            .options
            .authenticator
            .authenticate(request.headers())
            .await
        else {
            let mut response = text_response(StatusCode::UNAUTHORIZED, "Unauthorized");
            if let Ok(challenge) = self.options.authenticator.challenge().parse() {
                response
                    .headers_mut()
                    .insert(header::WWW_AUTHENTICATE, challenge);
            }
            return response;
        };
        let endpoint = {
            let mut principals = self
                .principals
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.closed.load(Ordering::SeqCst) {
                return Self::unavailable();
            }
            principals
                .entry(principal_id.clone())
                .or_insert_with(|| {
                    MachineEndpoint::new(Machine::new(MachineOptions {
                        default_cwd: self.options.default_cwd.clone(),
                        principal_id,
                        store: self.options.store.clone(),
                        owns_store: false,
                        logger: self.options.logger.clone(),
                        omit_host_details: self.options.omit_host_details,
                    }))
                })
                .clone()
        };
        endpoint.handle(request).await
    }

    pub async fn close(&self) {
        let endpoints: Vec<MachineEndpoint> = {
            let mut principals = self
                .principals
                .lock()
                .unwrap_or_else(|error| error.into_inner());
            if self.closed.swap(true, Ordering::SeqCst) {
                return;
            }
            principals.drain().map(|(_, endpoint)| endpoint).collect()
        };
        futures::future::join_all(endpoints.iter().map(|endpoint| endpoint.machine().close()))
            .await;
    }
}
