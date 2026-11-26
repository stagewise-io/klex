//! HTTP and WebSocket clients for Klex Cloud. Like Node, TLS trusts the
//! bundled Mozilla roots plus `NODE_EXTRA_CA_CERTS`, and the OS trust store
//! with `--use-system-ca`. With `--use-env-proxy`, `fetch` honours the proxy
//! environment the way undici's `EnvHttpProxyAgent` does; the `ws` WebSocket
//! still connects directly.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use rustls::RootCertStore;
use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::PemObject;
use url::Url;

/// The `NODE_OPTIONS` and `NODE_USE_*` switches the TS server honours.
#[derive(Debug, Default, PartialEq, Eq)]
struct NodeOptions {
    use_system_ca: bool,
    use_env_proxy: bool,
}

impl NodeOptions {
    fn from_env(var: impl Fn(&str) -> Option<String>) -> Self {
        let mut options = Self {
            use_system_ca: var("NODE_USE_SYSTEM_CA").as_deref() == Some("1"),
            use_env_proxy: var("NODE_USE_ENV_PROXY").as_deref() == Some("1"),
        };
        for flag in node_options_flags(&var("NODE_OPTIONS").unwrap_or_default()) {
            match flag.as_str() {
                "--use-system-ca" => options.use_system_ca = true,
                "--no-use-system-ca" => options.use_system_ca = false,
                "--use-env-proxy" => options.use_env_proxy = true,
                "--no-use-env-proxy" => options.use_env_proxy = false,
                _ => {}
            }
        }
        options
    }
}

/// Splits `NODE_OPTIONS` like Node: whitespace separates, double quotes group
/// and `\` escapes inside them. Option names accept `_` for `-`.
fn node_options_flags(value: &str) -> Vec<String> {
    let mut flags = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    let mut started = false;
    let mut chars = value.chars();
    while let Some(ch) = chars.next() {
        match ch {
            '\\' if quoted => {
                if let Some(next) = chars.next() {
                    current.push(next);
                }
            }
            '"' => {
                quoted = !quoted;
                started = true;
            }
            ch if ch.is_whitespace() && !quoted => {
                if started {
                    flags.push(std::mem::take(&mut current));
                    started = false;
                }
            }
            ch => {
                current.push(ch);
                started = true;
            }
        }
    }
    if started {
        flags.push(current);
    }
    flags
        .into_iter()
        .map(|flag| match flag.split_once('=') {
            Some((name, value)) => format!("{}={value}", name.replace('_', "-")),
            None => flag.replace('_', "-"),
        })
        .collect()
}

static NODE_OPTIONS: LazyLock<NodeOptions> =
    LazyLock::new(|| NodeOptions::from_env(|name| std::env::var(name).ok()));

static TLS: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
    let mut roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    if NODE_OPTIONS.use_system_ca {
        for certificate in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(certificate);
        }
    }
    if let Some(path) = std::env::var_os("NODE_EXTRA_CA_CERTS")
        && let Ok(certificates) = CertificateDer::pem_file_iter(&path)
    {
        for certificate in certificates.flatten() {
            let _ = roots.add(certificate);
        }
    }
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    Arc::new(
        rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .expect("ring supports the default protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth(),
    )
});

pub fn tls() -> Arc<rustls::ClientConfig> {
    TLS.clone()
}

/// undici's `EnvHttpProxyAgent`, which Node installs as the `fetch`
/// dispatcher under `--use-env-proxy` when any proxy variable is set.
#[derive(Debug)]
struct EnvProxy {
    http: Option<String>,
    https: Option<String>,
    no_proxy: NoProxy,
}

impl EnvProxy {
    fn from_env(var: impl Fn(&str) -> Option<String>) -> Option<Self> {
        let set = |name: &str| var(name).is_some_and(|value| !value.is_empty());
        if !["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]
            .into_iter()
            .any(set)
        {
            return None;
        }
        let http = var("http_proxy")
            .or_else(|| var("HTTP_PROXY"))
            .filter(|value| !value.is_empty());
        let https = var("https_proxy")
            .or_else(|| var("HTTPS_PROXY"))
            .filter(|value| !value.is_empty())
            .or_else(|| http.clone());
        let no_proxy = var("no_proxy")
            .or_else(|| var("NO_PROXY"))
            .unwrap_or_default();
        Some(Self {
            http,
            https,
            no_proxy: NoProxy::parse(&no_proxy),
        })
    }

    fn proxy_for(&self, url: &Url) -> Option<Url> {
        let host = url.host_str()?;
        let host = host
            .strip_prefix('[')
            .and_then(|host| host.strip_suffix(']'))
            .unwrap_or(host)
            .to_lowercase();
        let port = url.port_or_known_default().unwrap_or(0);
        if !self.no_proxy.should_proxy(&host, port) {
            return None;
        }
        let proxy = match url.scheme() {
            "https" => self.https.as_deref(),
            "http" => self.http.as_deref(),
            _ => None,
        }?;
        Url::parse(proxy).ok()
    }
}

#[derive(Debug)]
struct NoProxy {
    wildcard: bool,
    entries: Vec<(String, u16)>,
}

impl NoProxy {
    fn parse(value: &str) -> Self {
        let entries = value
            .split(|ch: char| ch == ',' || ch.is_whitespace())
            .filter(|entry| !entry.is_empty())
            .map(|entry| {
                let (host, port) = split_host_port(entry);
                let host = host
                    .strip_prefix("*.")
                    .or_else(|| host.strip_prefix('.'))
                    .unwrap_or(host);
                (host.to_lowercase(), port)
            })
            .collect();
        Self {
            wildcard: value == "*",
            entries,
        }
    }

    fn should_proxy(&self, host: &str, port: u16) -> bool {
        if self.entries.is_empty() {
            return true;
        }
        if self.wildcard {
            return false;
        }
        !self.entries.iter().any(|(entry, entry_port)| {
            (*entry_port == 0 || *entry_port == port)
                && (host == entry
                    || (host.len() > entry.len()
                        && host.ends_with(entry.as_str())
                        && host.as_bytes()[host.len() - entry.len() - 1] == b'.'))
        })
    }
}

/// undici's `NO_PROXY` entry forms: `[v6]:port`, `[v6]`, bare v6, `host:port`.
fn split_host_port(entry: &str) -> (&str, u16) {
    if let Some((host, port)) = entry
        .strip_prefix('[')
        .and_then(|rest| rest.split_once("]:"))
        && let Some(port) = parse_port(port)
    {
        return (host, port);
    }
    let unbracketed = entry
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(entry);
    if unbracketed.matches(':').count() == 1
        && let Some((host, port)) = unbracketed.split_once(':')
        && !host.is_empty()
        && let Some(port) = parse_port(port)
    {
        return (host, port);
    }
    (unbracketed, 0)
}

fn parse_port(port: &str) -> Option<u16> {
    if port.is_empty() || !port.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    port.parse().ok()
}

static ENV_PROXY: LazyLock<Option<Arc<EnvProxy>>> = LazyLock::new(|| {
    if !NODE_OPTIONS.use_env_proxy {
        return None;
    }
    EnvProxy::from_env(|name| std::env::var(name).ok()).map(Arc::new)
});

fn build(redirects: reqwest::redirect::Policy) -> reqwest::Client {
    let builder = reqwest::Client::builder()
        .use_preconfigured_tls((*tls()).clone())
        .redirect(redirects)
        .user_agent(concat!("klex-machine-rs/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30));
    let builder = match ENV_PROXY.clone() {
        Some(proxy) => builder.proxy(reqwest::Proxy::custom(move |url| proxy.proxy_for(url))),
        None => builder.no_proxy(),
    };
    builder.build().expect("HTTP client configuration is valid")
}

static FOLLOW: LazyLock<reqwest::Client> =
    LazyLock::new(|| build(reqwest::redirect::Policy::limited(20)));
static MANUAL: LazyLock<reqwest::Client> =
    LazyLock::new(|| build(reqwest::redirect::Policy::none()));

/// `fetch` with its default redirect handling.
pub fn client() -> &'static reqwest::Client {
    &FOLLOW
}

/// `fetch` with `redirect: 'manual'`, as oauth4webapi sends token requests.
pub fn manual_redirect_client() -> &'static reqwest::Client {
    &MANUAL
}

/// Node's fetch reports every transport failure as `fetch failed`.
pub fn fetch_failed(_: reqwest::Error) -> String {
    "fetch failed".into()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn env(pairs: &[(&str, &str)]) -> impl Fn(&str) -> Option<String> {
        let map: HashMap<String, String> = pairs
            .iter()
            .map(|(key, value)| (key.to_string(), value.to_string()))
            .collect();
        move |name| map.get(name).cloned()
    }

    #[test]
    fn reads_node_runtime_switches() {
        assert_eq!(NodeOptions::from_env(env(&[])), NodeOptions::default());
        assert_eq!(
            NodeOptions::from_env(env(&[
                ("NODE_USE_SYSTEM_CA", "1"),
                ("NODE_USE_ENV_PROXY", "true"),
            ])),
            NodeOptions {
                use_system_ca: true,
                use_env_proxy: false,
            }
        );
        assert_eq!(
            NodeOptions::from_env(env(&[(
                "NODE_OPTIONS",
                "--max-old-space-size=512 --use_system_ca \"--use-env-proxy\""
            )])),
            NodeOptions {
                use_system_ca: true,
                use_env_proxy: true,
            }
        );
        assert_eq!(
            NodeOptions::from_env(env(&[
                ("NODE_USE_ENV_PROXY", "1"),
                ("NODE_OPTIONS", "--no-use-env-proxy"),
            ])),
            NodeOptions::default()
        );
    }

    fn proxied(proxy: &EnvProxy, url: &str) -> Option<String> {
        proxy
            .proxy_for(&Url::parse(url).unwrap())
            .map(|url| url.to_string())
    }

    #[test]
    fn selects_proxies_like_undici() {
        assert!(EnvProxy::from_env(env(&[("NO_PROXY", "*")])).is_none());
        assert!(EnvProxy::from_env(env(&[("HTTP_PROXY", "")])).is_none());

        let proxy = EnvProxy::from_env(env(&[("HTTP_PROXY", "http://proxy:3128")])).unwrap();
        assert_eq!(
            proxied(&proxy, "https://cloud.example/api").as_deref(),
            Some("http://proxy:3128/")
        );

        let proxy = EnvProxy::from_env(env(&[
            ("http_proxy", ""),
            ("HTTP_PROXY", "http://upper:1"),
            ("HTTPS_PROXY", "http://secure:2"),
        ]))
        .unwrap();
        assert_eq!(proxied(&proxy, "http://cloud.example/"), None);
        assert_eq!(
            proxied(&proxy, "https://cloud.example/").as_deref(),
            Some("http://secure:2/")
        );
    }

    #[test]
    fn bypasses_no_proxy_hosts_like_undici() {
        let proxy = EnvProxy::from_env(env(&[
            ("HTTP_PROXY", "http://proxy:3128"),
            (
                "NO_PROXY",
                "internal.example, *.corp.example .lan localhost:8080 [::1]:443 10.0.0.1",
            ),
        ]))
        .unwrap();
        for bypassed in [
            "http://internal.example/",
            "http://api.internal.example/",
            "http://a.corp.example/",
            "http://corp.example/",
            "http://box.lan/",
            "http://localhost:8080/",
            "https://[::1]/",
            "http://10.0.0.1/",
        ] {
            assert_eq!(proxied(&proxy, bypassed), None, "{bypassed}");
        }
        for proxied_url in [
            "http://notinternal.example/",
            "http://localhost:8081/",
            "http://[::1]/",
            "http://10.0.0.10/",
        ] {
            assert!(proxied(&proxy, proxied_url).is_some(), "{proxied_url}");
        }

        let all = EnvProxy::from_env(env(&[
            ("HTTPS_PROXY", "http://proxy:3128"),
            ("no_proxy", "*"),
            ("NO_PROXY", "nothing"),
        ]))
        .unwrap();
        assert_eq!(proxied(&all, "https://cloud.example/"), None);
    }
}
