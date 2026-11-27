//! OAuth client credentials grant with `private_key_jwt`, matching the
//! requests and response checks oauth4webapi makes for `@klex/machine`.

use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use ed25519_dalek::Signer;
use serde_json::{Value, json};

use super::http;
use super::identity::MachineIdentity;

const REFRESH_SAFETY_MS: i64 = 60_000;
const CLOSED: &str = "Machine token client is closed";

/// The token endpoint refused the machine's credentials, which usually means
/// the machine was deleted in Cloud.
pub const OAUTH_ERROR_RESPONSE: &str = "server responded with an error in the response body";

pub struct TokenClientOptions {
    pub client_id: String,
    pub identity: MachineIdentity,
    pub token_endpoint: String,
    pub resource: String,
}

#[derive(Clone)]
struct Cached {
    value: String,
    expires_at: i64,
}

pub struct TokenClient {
    options: TokenClientOptions,
    cached: Mutex<Option<Cached>>,
    flight: tokio::sync::Mutex<()>,
    closed: AtomicBool,
    closing: tokio::sync::watch::Sender<bool>,
}

fn base64url_json(value: &Value) -> String {
    URL_SAFE_NO_PAD.encode(value.to_string())
}

fn random_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("system random source is available");
    URL_SAFE_NO_PAD.encode(bytes)
}

fn json_string(record: &serde_json::Map<String, Value>, key: &str) -> Result<String, String> {
    match record.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        Some(Value::String(_)) => Err(format!(
            "\"response\" body \"{key}\" property must not be empty"
        )),
        _ => Err(format!(
            "\"response\" body \"{key}\" property must be a string"
        )),
    }
}

async fn until_closed(closing: &mut tokio::sync::watch::Receiver<bool>) {
    let _ = closing.wait_for(|closed| *closed).await;
}

impl TokenClient {
    pub fn new(options: TokenClientOptions) -> Self {
        Self {
            options,
            cached: Mutex::new(None),
            flight: tokio::sync::Mutex::new(()),
            closed: AtomicBool::new(false),
            closing: tokio::sync::watch::channel(false).0,
        }
    }

    fn fresh(&self) -> Option<String> {
        let cached = self
            .cached
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        cached
            .as_ref()
            .filter(|cached| cached.expires_at > crate::time::now_ms() + REFRESH_SAFETY_MS)
            .map(|cached| cached.value.clone())
    }

    pub async fn get_token(&self) -> Result<String, String> {
        if self.closed.load(Ordering::SeqCst) {
            return Err(CLOSED.into());
        }
        if let Some(token) = self.fresh() {
            return Ok(token);
        }
        let mut closing = self.closing.subscribe();
        let _flight = tokio::select! {
            guard = self.flight.lock() => guard,
            () = until_closed(&mut closing) => return Err(CLOSED.into()),
        };
        if let Some(token) = self.fresh() {
            return Ok(token);
        }
        let cached = tokio::select! {
            result = self.request() => result?,
            () = until_closed(&mut closing) => return Err(CLOSED.into()),
        };
        let value = cached.value.clone();
        *self
            .cached
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = Some(cached);
        Ok(value)
    }

    pub fn invalidate(&self) {
        *self
            .cached
            .lock()
            .unwrap_or_else(|error| error.into_inner()) = None;
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        self.invalidate();
        self.closing.send_replace(true);
    }

    fn assertion(&self, issuer: &str) -> String {
        let now = crate::time::now_ms().div_euclid(1000);
        let client_id = &self.options.client_id;
        let header = json!({ "alg": "EdDSA", "kid": self.options.identity.key_id });
        let payload = json!({
            "jti": random_token(),
            "aud": issuer,
            "exp": now + 60,
            "iat": now,
            "nbf": now,
            "iss": client_id,
            "sub": client_id,
        });
        let input = format!("{}.{}", base64url_json(&header), base64url_json(&payload));
        let signature = self.options.identity.signing_key.sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    async fn request(&self) -> Result<Cached, String> {
        let endpoint = url::Url::parse(&self.options.token_endpoint).map_err(|_| {
            "authorization server metadata does not contain a valid \"as.token_endpoint\""
                .to_string()
        })?;
        if endpoint.scheme() != "https" {
            return Err("only requests to HTTPS are allowed".into());
        }
        let issuer = format!("{}/api/auth", endpoint.origin().ascii_serialization());
        let body = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("grant_type", "client_credentials")
            .append_pair("scope", "machine:connect")
            .append_pair("resource", &self.options.resource)
            .append_pair("client_id", &self.options.client_id)
            .append_pair(
                "client_assertion_type",
                "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
            )
            .append_pair("client_assertion", &self.assertion(&issuer))
            .finish();
        let response = http::manual_redirect_client()
            .post(endpoint)
            .header("accept", "application/json")
            .header(
                "content-type",
                "application/x-www-form-urlencoded;charset=UTF-8",
            )
            .body(body)
            .send()
            .await
            .map_err(http::fetch_failed)?;
        let status = response.status().as_u16();
        let challenged = response.headers().contains_key("www-authenticate");
        let json_content = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.split(';').next())
            .is_some_and(|media| media.trim().eq_ignore_ascii_case("application/json"));
        let bytes = response.bytes().await.map_err(http::fetch_failed)?;
        let parsed = serde_json::from_slice::<Value>(&bytes);
        if status != 200 {
            if challenged {
                return Err(
                    "server responded with a challenge in the WWW-Authenticate HTTP Header".into(),
                );
            }
            let oauth_error = (400..500).contains(&status)
                && json_content
                && parsed.as_ref().is_ok_and(|value| {
                    value
                        .get("error")
                        .and_then(Value::as_str)
                        .is_some_and(|error| !error.is_empty())
                });
            return Err(if oauth_error {
                OAUTH_ERROR_RESPONSE.into()
            } else {
                "\"response\" is not a conform Token Endpoint response (unexpected HTTP status code)"
                    .into()
            });
        }
        let value = parsed.map_err(|_| {
            if json_content {
                "failed to parse \"response\" body as JSON".to_string()
            } else {
                "\"response\" content-type must be application/json".to_string()
            }
        })?;
        let Value::Object(record) = value else {
            return Err("\"response\" body must be a top level object".into());
        };
        let access_token = json_string(&record, "access_token")?;
        json_string(&record, "token_type")?;
        let expires_in = match record.get("expires_in") {
            None => 3600.0,
            Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
            Some(Value::String(text)) => text.trim().parse::<f64>().unwrap_or(f64::NAN),
            Some(_) => f64::NAN,
        };
        if !expires_in.is_finite() || expires_in < 0.0 {
            return Err("\"response\" body \"expires_in\" property must be a number".into());
        }
        Ok(Cached {
            value: access_token,
            expires_at: crate::time::now_ms() + (expires_in * 1000.0) as i64,
        })
    }
}
