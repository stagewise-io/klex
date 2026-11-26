//! HTTP and WebSocket clients for Klex Cloud. Like Node, TLS trusts the
//! bundled Mozilla roots plus `NODE_EXTRA_CA_CERTS`, and proxy environment
//! variables are ignored.

use std::sync::{Arc, LazyLock};
use std::time::Duration;

use rustls::RootCertStore;
use rustls_pki_types::CertificateDer;
use rustls_pki_types::pem::PemObject;

static TLS: LazyLock<Arc<rustls::ClientConfig>> = LazyLock::new(|| {
    let mut roots = RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
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

fn build(redirects: reqwest::redirect::Policy) -> reqwest::Client {
    reqwest::Client::builder()
        .use_preconfigured_tls((*tls()).clone())
        .no_proxy()
        .redirect(redirects)
        .user_agent(concat!("klex-machine-rs/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(30))
        .build()
        .expect("HTTP client configuration is valid")
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
