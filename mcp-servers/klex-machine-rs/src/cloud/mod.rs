//! Klex Cloud modes: enrollment, managed bootstrap, and serving principals
//! through the Cloud proxy.

pub mod auth;
pub mod desktop_link;
pub mod enrollment;
pub mod facts;
pub mod http;
pub mod identity;
pub mod principal_router;
pub mod proxy_daemon;
pub mod runtime;
pub mod state;
pub mod token_client;

pub fn machine_live_message(machine_id: &str) -> String {
    format!(
        "Machine {machine_id} is live. You can now assign it to Klex Bots.\nKeep this process running; press Ctrl+C to stop."
    )
}
