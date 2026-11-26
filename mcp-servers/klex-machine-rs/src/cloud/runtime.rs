//! Connects an enrolled machine to the Cloud proxy with a fresh access token
//! and machine facts on every connection.

use std::path::Path;
use std::sync::Arc;

use serde_json::json;

use super::facts::{
    MACHINE_FACTS_HEADER, MachineFactsCollector, MachineFactsOptions, encode_machine_facts_header,
};
use super::identity::load_machine_identity;
use super::proxy_daemon::{ConnectionProvider, ProxyConnection, ProxyDaemon, ProxyHandler};
use super::state::{identity_path, load_machine_enrollment};
use super::token_client::{TokenClient, TokenClientOptions};
use crate::logger::Logger;

pub struct CloudRuntime {
    daemon: ProxyDaemon,
    token_client: Arc<TokenClient>,
}

pub async fn start_cloud_runtime(
    data_dir: &Path,
    handler: ProxyHandler,
    facts: Option<MachineFactsOptions>,
    logger: Logger,
) -> Result<CloudRuntime, String> {
    let enrollment = load_machine_enrollment(data_dir)?;
    let identity = load_machine_identity(&identity_path(data_dir))?;
    if identity.key_id != enrollment.key_id {
        return Err("Machine private key does not match enrollment metadata".into());
    }
    let token_client = Arc::new(TokenClient::new(TokenClientOptions {
        client_id: enrollment.client_id.clone(),
        identity,
        token_endpoint: enrollment.token_endpoint.clone(),
        resource: enrollment.proxy_connection_resource.clone(),
    }));
    let collector = facts.map(|options| Arc::new(MachineFactsCollector::new(options)));
    let url = enrollment.proxy_connection_url.clone();
    let tokens = token_client.clone();
    let connection: ConnectionProvider = Arc::new(move || {
        let (tokens, collector, url, logger) = (
            tokens.clone(),
            collector.clone(),
            url.clone(),
            logger.clone(),
        );
        Box::pin(async move {
            tokens.invalidate();
            let token = tokens.get_token().await?;
            let mut headers = vec![("authorization".to_string(), format!("Bearer {token}"))];
            if let Some(collector) = collector {
                match encode_machine_facts_header(&collector.collect().await) {
                    Some(header) => headers.push((MACHINE_FACTS_HEADER.into(), header)),
                    None => logger.warn(json!({}), "Machine facts exceed header size limit"),
                }
            }
            Ok(ProxyConnection { url, headers })
        })
    });
    match ProxyDaemon::start(connection, handler).await {
        Ok(daemon) => Ok(CloudRuntime {
            daemon,
            token_client,
        }),
        Err(error) => {
            token_client.close();
            Err(error)
        }
    }
}

impl CloudRuntime {
    pub async fn close(&self) {
        self.token_client.close();
        self.daemon.close().await;
    }
}
