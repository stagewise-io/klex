//! `cloud enroll` and `cloud bootstrap`: exchange a one-time code for Cloud
//! credentials bound to the machine identity.

use std::io::Read;
use std::path::{Path, PathBuf};

use serde_json::{Map, Value, json};

use super::http;
use super::identity::{MachineIdentity, load_machine_identity, save_machine_identity};
use super::state::{
    MachineEnrollment, enrollment_path, hash_enrollment_code, identity_path,
    load_machine_enrollment, save_machine_enrollment,
};
use crate::{BIN_NAME, fs_error};

#[derive(Debug)]
pub struct EnrollError {
    pub status: Option<u16>,
    pub message: String,
}

impl From<String> for EnrollError {
    fn from(message: String) -> Self {
        Self {
            status: None,
            message,
        }
    }
}

fn rejection(status: u16) -> EnrollError {
    let message = match status {
        401 => {
            "Enrollment code is invalid, expired, or already used. Generate a new code in Cloud."
                .to_string()
        }
        409 => "This machine is already enrolled in Cloud. Delete it there, then run the command with a new code.".to_string(),
        _ => return format!("Machine enrollment failed with HTTP {status}").into(),
    };
    EnrollError {
        status: Some(status),
        message,
    }
}

fn required(record: &Map<String, Value>, key: &str) -> Result<String, String> {
    match record.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        _ => Err(format!("Enrollment response has invalid {key}")),
    }
}

fn parse_response(
    value: &Value,
    cloud_base_url: &str,
    key_id: &str,
) -> Result<MachineEnrollment, String> {
    let Value::Object(record) = value else {
        return Err("Enrollment response is invalid".into());
    };
    Ok(MachineEnrollment {
        version: 1,
        key_id: key_id.into(),
        machine_id: required(record, "machineId")?,
        client_id: required(record, "clientId")?,
        cloud_base_url: cloud_base_url.into(),
        enrolled_at: crate::time::iso_now(),
        token_endpoint: required(record, "tokenEndpoint")?,
        proxy_connection_resource: required(record, "proxyConnectionResource")?,
        proxy_connection_url: required(record, "proxyConnectionUrl")?,
        mcp_resource_url: required(record, "mcpResourceUrl")?,
        oauth_protected_resource_url: required(record, "oauthProtectedResourceUrl")?,
        enrollment_code_sha256: None,
    })
}

pub fn normalize_base_url(url: &str) -> String {
    url.strip_suffix('/').unwrap_or(url).to_string()
}

/// `access()` that treats only ENOENT as missing, so an unreadable data
/// directory never spends a one-time code on a fresh enrollment.
fn exists(path: &Path) -> Result<bool, String> {
    match std::fs::metadata(path) {
        Ok(_) => Ok(true),
        Err(error) if fs_error::is(&error, "ENOENT") => Ok(false),
        Err(error) => Err(fs_error::message(&error, "access", path)),
    }
}

pub async fn enroll_machine(
    cloud_base_url: &str,
    code: &str,
    data_dir: &Path,
) -> Result<MachineEnrollment, EnrollError> {
    let cloud_base_url = normalize_base_url(cloud_base_url);
    let code = code.trim();
    if code.is_empty() {
        return Err(String::from("Enrollment code is required").into());
    }
    let path = identity_path(data_dir);
    let identity = if std::fs::metadata(&path).is_ok() {
        load_machine_identity(&path)?
    } else {
        let identity = MachineIdentity::generate()?;
        save_machine_identity(&path, &identity)?;
        identity
    };
    let response = http::client()
        .post(format!("{cloud_base_url}/api/machines/enroll"))
        .header("content-type", "application/json")
        .body(
            json!({ "enrollmentCode": code, "jwks": { "keys": [identity.public_jwk] } })
                .to_string(),
        )
        .send()
        .await
        .map_err(http::fetch_failed)?;
    let status = response.status();
    if !status.is_success() {
        return Err(rejection(status.as_u16()));
    }
    let body = response.bytes().await.map_err(http::fetch_failed)?;
    let value: Value = serde_json::from_slice(&body)
        .map_err(|error| format!("Enrollment response is not valid JSON: {error}"))?;
    let mut enrollment = parse_response(&value, &cloud_base_url, &identity.key_id)?;
    enrollment.enrollment_code_sha256 = Some(hash_enrollment_code(code));
    save_machine_enrollment(data_dir, &enrollment)?;
    Ok(enrollment)
}

pub fn validate_enrollment_identity(
    data_dir: &Path,
    enrollment: &MachineEnrollment,
) -> Result<(), String> {
    let identity = load_machine_identity(&identity_path(data_dir))?;
    if identity.key_id != enrollment.key_id {
        return Err("Machine identity does not match enrollment metadata".into());
    }
    Ok(())
}

pub struct ConnectResult {
    pub enrollment: MachineEnrollment,
    pub reused: bool,
}

/// Enrolls unless the same code was already used for the same deployment,
/// so re-running the copied command restarts the machine. The existing
/// identity key is always reused.
pub async fn connect_machine(
    cloud_base_url: &str,
    code: &str,
    data_dir: &Path,
) -> Result<ConnectResult, String> {
    let cloud_base_url = normalize_base_url(cloud_base_url);
    let code = code.trim();
    if code.is_empty() {
        return Err("Enrollment code is required".into());
    }
    let has_identity = exists(&identity_path(data_dir))?;
    let has_enrollment = exists(&enrollment_path(data_dir))?;
    if has_enrollment && !has_identity {
        return Err("Machine state is incomplete: private key is missing".into());
    }
    let existing = if has_enrollment {
        let enrollment = load_machine_enrollment(data_dir)?;
        validate_enrollment_identity(data_dir, &enrollment)?;
        Some(enrollment)
    } else {
        None
    };
    if let Some(existing) = &existing
        && existing.cloud_base_url == cloud_base_url
        && existing.enrollment_code_sha256.as_deref() == Some(&hash_enrollment_code(code))
    {
        return Ok(ConnectResult {
            enrollment: existing.clone(),
            reused: true,
        });
    }
    match enroll_machine(&cloud_base_url, code, data_dir).await {
        Ok(enrollment) => Ok(ConnectResult {
            enrollment,
            reused: false,
        }),
        Err(EnrollError {
            status: Some(401),
            message,
        }) if existing.is_some() => Err(format!(
            "{message} Existing enrollment for machine {} is unchanged; start it with: {BIN_NAME}",
            existing.expect("checked").machine_id
        )),
        Err(error) => Err(error.message),
    }
}

fn consume_enrollment_code(path: &str) -> Result<String, String> {
    if path == "-" {
        let mut text = String::new();
        std::io::stdin()
            .read_to_string(&mut text)
            .map_err(|error| error.to_string())?;
        return Ok(text);
    }
    let path = PathBuf::from(path);
    let result = std::fs::read(&path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|error| fs_error::message(&error, "open", &path));
    let _ = std::fs::remove_file(&path);
    result
}

pub async fn bootstrap_managed_machine(
    cloud_base_url: &str,
    data_dir: &Path,
    enrollment_code_file: &str,
) -> Result<MachineEnrollment, String> {
    let has_identity = std::fs::metadata(identity_path(data_dir)).is_ok();
    let has_enrollment = std::fs::metadata(enrollment_path(data_dir)).is_ok();
    if has_enrollment && !has_identity {
        return Err("Managed machine state is incomplete: private key is missing".into());
    }
    if has_identity && !has_enrollment {
        return Err("Managed machine state is incomplete: enrollment metadata is missing".into());
    }
    if has_enrollment {
        let existing = load_machine_enrollment(data_dir)?;
        validate_enrollment_identity(data_dir, &existing)?;
        if existing.cloud_base_url != normalize_base_url(cloud_base_url) {
            return Err(
                "Managed machine enrollment belongs to a different cloud deployment".into(),
            );
        }
        if enrollment_code_file != "-" {
            let _ = std::fs::remove_file(enrollment_code_file);
        }
        return Ok(existing);
    }
    let code = consume_enrollment_code(enrollment_code_file)?;
    let enrollment = enroll_machine(cloud_base_url, &code, data_dir)
        .await
        .map_err(|error| error.message)?;
    validate_enrollment_identity(data_dir, &enrollment)?;
    Ok(enrollment)
}
