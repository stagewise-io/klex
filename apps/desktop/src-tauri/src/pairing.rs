//! Pairing: the person enters a code (or a `klex://pair` link brings one),
//! the app previews it with Cloud and asks for consent, and only then
//! enrolls. The code stays in this process between the two steps, so the
//! consent always covers the code that gets redeemed, and it reaches the
//! daemon on stdin, never in argv.

use std::sync::Arc;

use klex_machine::cloud::enrollment::{EnrollmentPreview, PreviewError, preview_enrollment};
use klex_machine::supervised::StatusEvent;
use serde::Serialize;
use tauri_plugin_autostart::ManagerExt;
use tokio::io::AsyncWriteExt;

use crate::desktop::{AppStatus, Desktop, lock};
use crate::logs::Source;
use crate::settings::cloud_base_url;

pub struct PendingPairing {
    code: String,
    preview: EnrollmentPreview,
}

/// Mirrored by `PairingError` in `src/lib/desktop.ts`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "message", rename_all = "camelCase")]
pub enum PairingError {
    InvalidCode,
    RateLimited,
    AlreadyPaired,
    NoPendingCode,
    Unreachable(String),
    Failed(String),
}

impl From<PreviewError> for PairingError {
    fn from(error: PreviewError) -> Self {
        match error {
            PreviewError::InvalidCode => Self::InvalidCode,
            PreviewError::RateLimited => Self::RateLimited,
            PreviewError::Unreachable(message) => Self::Unreachable(message),
            PreviewError::Failed(message) => Self::Failed(message),
        }
    }
}

/// Classifies the daemon's enrollment error messages.
fn enroll_error(message: String) -> PairingError {
    if message.starts_with("Enrollment code is invalid") {
        PairingError::InvalidCode
    } else if message == "fetch failed" {
        PairingError::Unreachable(message)
    } else if message.contains("HTTP 429") {
        PairingError::RateLimited
    } else {
        PairingError::Failed(message)
    }
}

/// Extracts the code from `klex://pair?code=XXXX-XXXX-XXXX`.
pub fn code_from_deep_link(url: &url::Url) -> Option<String> {
    if url.scheme() != "klex" || url.host_str() != Some("pair") {
        return None;
    }
    url.query_pairs()
        .find(|(key, _)| key == "code")
        .map(|(_, value)| value.trim().to_string())
        .filter(|code| !code.is_empty())
}

pub async fn preview(desktop: &Desktop, code: String) -> Result<EnrollmentPreview, PairingError> {
    if desktop.is_paired() {
        return Err(PairingError::AlreadyPaired);
    }
    *lock(&desktop.pending) = None;
    desktop.log(Source::App, "Checking enrollment code with Klex Cloud");
    let preview = preview_enrollment(&cloud_base_url(), &code).await?;
    desktop.log(
        Source::App,
        &format!(
            "Code belongs to {} (machine {})",
            preview.organization_name, preview.machine_name
        ),
    );
    *lock(&desktop.pending) = Some(PendingPairing {
        code,
        preview: preview.clone(),
    });
    Ok(preview)
}

pub fn cancel(desktop: &Desktop) {
    if lock(&desktop.pending).take().is_some() {
        desktop.log(Source::App, "Pairing cancelled");
    }
}

pub async fn confirm(desktop: &Arc<Desktop>) -> Result<AppStatus, PairingError> {
    let pending = lock(&desktop.pending)
        .take()
        .ok_or(PairingError::NoPendingCode)?;
    if desktop.is_paired() {
        return Err(PairingError::AlreadyPaired);
    }
    let machine_id = enroll(desktop, &pending.code).await?;
    desktop.log(Source::App, &format!("Enrolled as machine {machine_id}"));
    let organization_name = pending.preview.organization_name;
    desktop
        .save_settings(|settings| {
            settings.enabled = true;
            settings.organization_name = Some(organization_name);
        })
        .map_err(PairingError::Failed)?;
    if let Err(error) = desktop.app.autolaunch().enable() {
        desktop.log(
            Source::App,
            &format!("Could not turn on start at sign-in: {error}"),
        );
    }
    desktop.start().await;
    Ok(desktop.broadcast())
}

async fn enroll(desktop: &Desktop, code: &str) -> Result<String, PairingError> {
    let data_dir = desktop.paths.data_dir.to_string_lossy().into_owned();
    let cloud = cloud_base_url();
    let args = [
        "cloud",
        "enroll",
        "--code-stdin",
        "--no-serve",
        "--supervised",
        "--cloud-base-url",
        &cloud,
        "--data-dir",
        &data_dir,
    ];
    let failed = |error: std::io::Error| PairingError::Failed(error.to_string());
    let mut child = desktop.spawn_daemon(&args).map_err(failed)?;
    if let Some(mut stdin) = child.stdin.take() {
        stdin
            .write_all(format!("{code}\n").as_bytes())
            .await
            .map_err(failed)?;
    }
    let mut events = desktop.read_events(&mut child);
    let mut result = Err(PairingError::Failed(
        "Enrollment ended without a result".into(),
    ));
    while let Some(event) = events.recv().await {
        match event {
            StatusEvent::Enrolled { machine_id, .. } => result = Ok(machine_id),
            StatusEvent::Error { message, .. } => result = Err(enroll_error(message)),
            _ => {}
        }
    }
    let _ = child.wait().await;
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_codes_from_pair_links_only() {
        let code = |link: &str| code_from_deep_link(&url::Url::parse(link).unwrap());
        assert_eq!(
            code("klex://pair?code=ABCD-EFGH-JKMN").as_deref(),
            Some("ABCD-EFGH-JKMN")
        );
        assert_eq!(
            code("klex://pair/?code=%20abcd-efgh-jkmn%20").as_deref(),
            Some("abcd-efgh-jkmn")
        );
        assert_eq!(code("klex://pair"), None);
        assert_eq!(code("klex://pair?code="), None);
        assert_eq!(code("klex://other?code=ABCD"), None);
        assert_eq!(code("https://pair?code=ABCD"), None);
    }

    #[test]
    fn classifies_enrollment_errors() {
        assert_eq!(
            enroll_error(
                "Enrollment code is invalid, expired, or already used. Generate a new code in Cloud."
                    .into()
            ),
            PairingError::InvalidCode
        );
        assert_eq!(
            enroll_error("fetch failed".into()),
            PairingError::Unreachable("fetch failed".into())
        );
        assert_eq!(
            enroll_error("Machine enrollment failed with HTTP 429".into()),
            PairingError::RateLimited
        );
        assert_eq!(
            serde_json::to_value(PairingError::InvalidCode).unwrap(),
            serde_json::json!({ "kind": "invalidCode" })
        );
    }
}
