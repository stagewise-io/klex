//! Bearer token checks for MCP requests that arrive through the Cloud proxy:
//! protected resource metadata, a remote JWKS cached like jose's
//! `createRemoteJWKSet`, and `jwtVerify` with issuer and audience checks.
//! EdDSA (Ed25519) and ES256 signatures are supported.

use std::time::{Duration, Instant};

use axum::http::HeaderMap;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use serde_json::{Map, Value};

use super::http;

const JWKS_TIMEOUT: Duration = Duration::from_secs(5);
const JWKS_COOLDOWN: Duration = Duration::from_secs(30);
const JWKS_MAX_AGE: Duration = Duration::from_secs(600);

pub struct ProtectedResource {
    pub issuer: String,
    pub resource: String,
}

pub async fn load_protected_resource(
    metadata_url: &str,
    expected_resource: &str,
) -> Result<ProtectedResource, String> {
    let response = http::client()
        .get(metadata_url)
        .header("accept", "application/json")
        .send()
        .await
        .map_err(http::fetch_failed)?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "Protected resource metadata request failed ({})",
            status.as_u16()
        ));
    }
    let bytes = response.bytes().await.map_err(http::fetch_failed)?;
    let invalid = || "Protected resource metadata is invalid".to_string();
    let value: Value = serde_json::from_slice(&bytes).map_err(|error| error.to_string())?;
    let resource = value
        .get("resource")
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    let issuer = value
        .get("authorization_servers")
        .and_then(Value::as_array)
        .and_then(|servers| servers.first())
        .and_then(Value::as_str)
        .ok_or_else(invalid)?;
    if resource != expected_resource {
        return Err("Protected resource metadata does not match enrollment".into());
    }
    Ok(ProtectedResource {
        issuer: issuer.into(),
        resource: resource.into(),
    })
}

#[derive(Default)]
struct JwksCache {
    keys: Vec<Map<String, Value>>,
    fetched_at: Option<Instant>,
}

pub struct Authenticator {
    issuer: String,
    audience: String,
    jwks_url: String,
    challenge: String,
    cache: tokio::sync::Mutex<JwksCache>,
}

struct Token<'a> {
    header: Map<String, Value>,
    payload: Map<String, Value>,
    input: &'a str,
    signature: Vec<u8>,
}

fn decode_part(part: &str) -> Option<Vec<u8>> {
    URL_SAFE_NO_PAD.decode(part).ok()
}

fn parse_token(token: &str) -> Option<Token<'_>> {
    let mut parts = token.split('.');
    let (header, payload, signature) = (parts.next()?, parts.next()?, parts.next()?);
    if parts.next().is_some() {
        return None;
    }
    let header: Map<String, Value> = serde_json::from_slice(&decode_part(header)?).ok()?;
    let payload: Map<String, Value> = serde_json::from_slice(&decode_part(payload)?).ok()?;
    let input = &token[..token.rfind('.')?];
    Some(Token {
        header,
        payload,
        input,
        signature: decode_part(signature)?,
    })
}

fn verify_signature(alg: &str, jwk: &Map<String, Value>, input: &[u8], signature: &[u8]) -> bool {
    let field = |name: &str| {
        jwk.get(name)
            .and_then(Value::as_str)
            .and_then(|value| URL_SAFE_NO_PAD.decode(value).ok())
    };
    match alg {
        "EdDSA" | "Ed25519" => {
            use ed25519_dalek::Verifier;
            let (Some(x), Ok(signature)) =
                (field("x"), ed25519_dalek::Signature::from_slice(signature))
            else {
                return false;
            };
            let Ok(x) = <[u8; 32]>::try_from(x.as_slice()) else {
                return false;
            };
            ed25519_dalek::VerifyingKey::from_bytes(&x)
                .is_ok_and(|key| key.verify(input, &signature).is_ok())
        }
        "ES256" => {
            use p256::ecdsa::signature::Verifier;
            let (Some(x), Some(y)) = (field("x"), field("y")) else {
                return false;
            };
            if x.len() != 32 || y.len() != 32 {
                return false;
            }
            let mut point = vec![4u8];
            point.extend_from_slice(&x);
            point.extend_from_slice(&y);
            let (Ok(key), Ok(signature)) = (
                p256::ecdsa::VerifyingKey::from_sec1_bytes(&point),
                p256::ecdsa::Signature::from_slice(signature),
            ) else {
                return false;
            };
            key.verify(input, &signature).is_ok()
        }
        _ => false,
    }
}

/// jose's JWKS key selection for a JWS header.
fn candidate(jwk: &Map<String, Value>, alg: &str, kid: Option<&str>) -> bool {
    let text = |name: &str| jwk.get(name).and_then(Value::as_str);
    let family = match alg {
        "EdDSA" => text("kty") == Some("OKP") && text("crv") == Some("Ed25519"),
        "Ed25519" => text("kty") == Some("OKP") && text("crv") == Some("Ed25519"),
        "ES256" => text("kty") == Some("EC") && text("crv") == Some("P-256"),
        _ => false,
    };
    family
        && kid.is_none_or(|kid| text("kid") == Some(kid))
        && text("alg").is_none_or(|key_alg| key_alg == alg)
        && text("use").is_none_or(|key_use| key_use == "sig")
        && jwk.get("key_ops").is_none_or(|ops| {
            ops.as_array()
                .is_some_and(|ops| ops.iter().any(|op| op.as_str() == Some("verify")))
        })
}

impl Authenticator {
    pub fn new(
        issuer: String,
        audience: String,
        jwks_url: String,
        protected_resource_metadata_url: &str,
    ) -> Self {
        Self {
            issuer,
            audience,
            jwks_url,
            challenge: format!(
                "Bearer resource_metadata=\"{protected_resource_metadata_url}\", scope=\"mcp:use\""
            ),
            cache: tokio::sync::Mutex::new(JwksCache::default()),
        }
    }

    pub fn challenge(&self) -> &str {
        &self.challenge
    }

    async fn fetch_jwks(&self) -> Option<Vec<Map<String, Value>>> {
        let response = http::manual_redirect_client()
            .get(&self.jwks_url)
            .header("accept", "application/json")
            .timeout(JWKS_TIMEOUT)
            .send()
            .await
            .ok()?;
        if response.status() != 200 {
            return None;
        }
        let value: Value = serde_json::from_slice(&response.bytes().await.ok()?).ok()?;
        Some(
            value
                .get("keys")?
                .as_array()?
                .iter()
                .filter_map(|key| key.as_object().cloned())
                .collect(),
        )
    }

    async fn keys(&self, alg: &str, kid: Option<&str>) -> Vec<Map<String, Value>> {
        let mut cache = self.cache.lock().await;
        let stale = cache
            .fetched_at
            .is_none_or(|fetched| fetched.elapsed() >= JWKS_MAX_AGE);
        let select = |cache: &JwksCache| -> Vec<Map<String, Value>> {
            cache
                .keys
                .iter()
                .filter(|jwk| candidate(jwk, alg, kid))
                .cloned()
                .collect()
        };
        if !stale {
            let found = select(&cache);
            let cooling = cache
                .fetched_at
                .is_some_and(|fetched| fetched.elapsed() < JWKS_COOLDOWN);
            if !found.is_empty() || cooling {
                return found;
            }
        }
        if let Some(keys) = self.fetch_jwks().await {
            cache.keys = keys;
            cache.fetched_at = Some(Instant::now());
        }
        select(&cache)
    }

    /// Returns the `client_id` of a valid MCP access token.
    pub async fn authenticate(&self, headers: &HeaderMap) -> Option<String> {
        let authorization = headers.get("authorization")?.to_str().ok()?;
        let (scheme, token) = authorization.split_at_checked(6)?;
        if !scheme.eq_ignore_ascii_case("bearer")
            || !token.starts_with(char::is_whitespace)
            || token.trim().is_empty()
        {
            return None;
        }
        let token = token.trim_start();
        let parsed = parse_token(token)?;
        let alg = parsed.header.get("alg")?.as_str()?;
        if parsed.header.contains_key("crit")
            || parsed.header.get("b64") == Some(&Value::Bool(false))
        {
            return None;
        }
        let kid = match parsed.header.get("kid") {
            None => None,
            Some(Value::String(kid)) => Some(kid.as_str()),
            Some(_) => return None,
        };
        let keys = self.keys(alg, kid).await;
        if !keys
            .iter()
            .any(|jwk| verify_signature(alg, jwk, parsed.input.as_bytes(), &parsed.signature))
        {
            return None;
        }
        self.validate_claims(&parsed.payload)
    }

    fn validate_claims(&self, payload: &Map<String, Value>) -> Option<String> {
        let now = (crate::time::now_ms().div_euclid(1000)) as f64;
        if payload.get("iss").and_then(Value::as_str) != Some(self.issuer.as_str()) {
            return None;
        }
        let audience_ok = match payload.get("aud") {
            Some(Value::String(audience)) => audience == &self.audience,
            Some(Value::Array(audiences)) => audiences
                .iter()
                .any(|audience| audience.as_str() == Some(self.audience.as_str())),
            _ => false,
        };
        if !audience_ok {
            return None;
        }
        for (claim, check) in [
            (
                "exp",
                (|value: f64, now: f64| value > now) as fn(f64, f64) -> bool,
            ),
            ("nbf", |value, now| value <= now),
            ("iat", |_, _| true),
        ] {
            match payload.get(claim) {
                None => {}
                Some(Value::Number(number)) => {
                    if !check(number.as_f64()?, now) {
                        return None;
                    }
                }
                Some(_) => return None,
            }
        }
        let scope_ok = match payload.get("scope") {
            Some(Value::String(scope)) => scope.split_whitespace().any(|scope| scope == "mcp:use"),
            Some(Value::Array(scopes)) => {
                scopes.iter().any(|scope| scope.as_str() == Some("mcp:use"))
            }
            _ => false,
        };
        if !scope_ok {
            return None;
        }
        match payload.get("client_id") {
            Some(Value::String(client_id)) if !client_id.trim().is_empty() => {
                Some(client_id.clone())
            }
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::Signer;
    use serde_json::json;

    fn sign(key: &ed25519_dalek::SigningKey, header: Value, payload: Value) -> String {
        let input = format!(
            "{}.{}",
            URL_SAFE_NO_PAD.encode(header.to_string()),
            URL_SAFE_NO_PAD.encode(payload.to_string())
        );
        let signature = key.sign(input.as_bytes());
        format!("{input}.{}", URL_SAFE_NO_PAD.encode(signature.to_bytes()))
    }

    #[tokio::test]
    async fn verifies_tokens_like_jose() {
        let key = ed25519_dalek::SigningKey::from_bytes(&[3; 32]);
        let jwk = json!({
            "kty": "OKP", "crv": "Ed25519", "kid": "k1", "alg": "EdDSA",
            "x": URL_SAFE_NO_PAD.encode(key.verifying_key().as_bytes()),
        });
        let authenticator = Authenticator::new(
            "https://cloud.example/api/auth".into(),
            "https://cloud.example/machines/m/mcp".into(),
            "http://127.0.0.1:9/jwks".into(),
            "https://cloud.example/prm",
        );
        {
            let mut cache = authenticator.cache.lock().await;
            cache.keys = vec![jwk.as_object().unwrap().clone()];
            cache.fetched_at = Some(Instant::now());
        }
        let now = crate::time::now_ms() / 1000;
        let claims = json!({
            "iss": "https://cloud.example/api/auth",
            "aud": ["https://cloud.example/machines/m/mcp"],
            "exp": now + 60, "iat": now, "scope": "openid mcp:use", "client_id": "agent-1",
        });
        let header = json!({ "alg": "EdDSA", "kid": "k1" });
        let headers = |token: &str| {
            let mut headers = HeaderMap::new();
            headers.insert("authorization", format!("bearer  {token}").parse().unwrap());
            headers
        };
        let token = sign(&key, header.clone(), claims.clone());
        assert_eq!(
            authenticator
                .authenticate(&headers(&token))
                .await
                .as_deref(),
            Some("agent-1")
        );

        for (field, value) in [
            ("exp", json!(now)),
            ("nbf", json!(now + 60)),
            ("scope", json!("openid")),
            ("client_id", json!(" ")),
            ("aud", json!("https://other.example")),
            ("iss", json!("https://other.example")),
        ] {
            let mut claims = claims.clone();
            claims[field] = value;
            let token = sign(&key, header.clone(), claims);
            assert_eq!(
                authenticator.authenticate(&headers(&token)).await,
                None,
                "{field}"
            );
        }
        let other = ed25519_dalek::SigningKey::from_bytes(&[4; 32]);
        let forged = sign(&other, header, claims);
        assert_eq!(authenticator.authenticate(&headers(&forged)).await, None);
        assert_eq!(authenticator.authenticate(&HeaderMap::new()).await, None);
    }
}
