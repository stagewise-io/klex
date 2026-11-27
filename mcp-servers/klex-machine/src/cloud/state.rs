//! `identity/enrollment.json`, byte-compatible with `@klex/machine`.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

use crate::fs_error;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineEnrollment {
    pub version: u8,
    pub key_id: String,
    pub machine_id: String,
    pub client_id: String,
    pub cloud_base_url: String,
    pub enrolled_at: String,
    pub token_endpoint: String,
    pub proxy_connection_resource: String,
    pub proxy_connection_url: String,
    pub mcp_resource_url: String,
    pub oauth_protected_resource_url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enrollment_code_sha256: Option<String>,
    /// Display-only. `@klex/machine` ignores the key and drops it on rewrite.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub organization_name: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum EnrollmentError {
    /// Passed through unwrapped, like `UnsupportedMachineEnrollmentVersionError`.
    UnsupportedVersion(String),
    Invalid(String),
}

pub fn identity_path(data_dir: &Path) -> PathBuf {
    data_dir.join("identity").join("private-key.pem")
}

pub fn enrollment_path(data_dir: &Path) -> PathBuf {
    data_dir.join("identity").join("enrollment.json")
}

pub fn hash_enrollment_code(code: &str) -> String {
    let digest = Sha256::digest(code.trim().as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// `String(value)` for a JSON value.
pub fn js_string(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::String(text)) => text.clone(),
        Some(Value::Bool(flag)) => flag.to_string(),
        Some(Value::Number(number)) => match number.as_f64() {
            Some(float) if float.fract() == 0.0 && float.abs() < 1e21 => format!("{float:.0}"),
            _ => number.to_string(),
        },
        Some(Value::Array(items)) => items
            .iter()
            .map(|item| match item {
                Value::Null => String::new(),
                item => js_string(Some(item)),
            })
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Object(_)) => "[object Object]".into(),
    }
}

fn non_empty(record: &Map<String, Value>, key: &str) -> Result<String, EnrollmentError> {
    match record.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value.clone()),
        _ => Err(EnrollmentError::Invalid(format!(
            "Machine enrollment metadata has invalid {key}"
        ))),
    }
}

/// A non-empty string, or `None` for anything else, so a malformed
/// display-only field never invalidates the enrollment.
pub fn optional_string(record: &Map<String, Value>, key: &str) -> Option<String> {
    match record.get(key) {
        Some(Value::String(value)) if !value.trim().is_empty() => Some(value.clone()),
        _ => None,
    }
}

pub fn parse_machine_enrollment(value: &Value) -> Result<MachineEnrollment, EnrollmentError> {
    let Value::Object(record) = value else {
        return Err(EnrollmentError::Invalid(
            "Machine enrollment metadata is corrupt".into(),
        ));
    };
    if record.get("version").and_then(Value::as_f64) != Some(1.0) {
        return Err(EnrollmentError::UnsupportedVersion(format!(
            "Unsupported machine enrollment version: {}",
            js_string(record.get("version"))
        )));
    }
    let code_hash = match record.get("enrollmentCodeSha256") {
        None => None,
        Some(Value::String(hash))
            if hash.len() == 64
                && hash
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)) =>
        {
            Some(hash.clone())
        }
        Some(_) => {
            return Err(EnrollmentError::Invalid(
                "Machine enrollment metadata has invalid enrollmentCodeSha256".into(),
            ));
        }
    };
    Ok(MachineEnrollment {
        version: 1,
        key_id: non_empty(record, "keyId")?,
        machine_id: non_empty(record, "machineId")?,
        client_id: non_empty(record, "clientId")?,
        cloud_base_url: non_empty(record, "cloudBaseUrl")?,
        enrolled_at: non_empty(record, "enrolledAt")?,
        token_endpoint: non_empty(record, "tokenEndpoint")?,
        proxy_connection_resource: non_empty(record, "proxyConnectionResource")?,
        proxy_connection_url: non_empty(record, "proxyConnectionUrl")?,
        mcp_resource_url: non_empty(record, "mcpResourceUrl")?,
        oauth_protected_resource_url: non_empty(record, "oauthProtectedResourceUrl")?,
        enrollment_code_sha256: code_hash,
        organization_name: optional_string(record, "organizationName"),
    })
}

pub fn load_machine_enrollment(data_dir: &Path) -> Result<MachineEnrollment, String> {
    let path = enrollment_path(data_dir);
    let Ok(text) = fs::read_to_string(&path) else {
        return Err(format!("Machine is not enrolled: {}", path.display()));
    };
    let corrupt = || format!("Machine enrollment metadata is corrupt: {}", path.display());
    let value: Value = serde_json::from_str(&text).map_err(|_| corrupt())?;
    parse_machine_enrollment(&value).map_err(|error| match error {
        EnrollmentError::UnsupportedVersion(message) => message,
        EnrollmentError::Invalid(_) => corrupt(),
    })
}

pub fn temporary_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_owned();
    name.push(format!(
        ".{}.{}.tmp",
        std::process::id(),
        uuid::Uuid::new_v4()
    ));
    PathBuf::from(name)
}

/// Opens a new file with mode 0600, failing if it exists (`'wx'`).
pub fn create_private_file(path: &Path) -> std::io::Result<fs::File> {
    crate::platform::fs::create_new_file(path, 0o600)
}

pub fn save_machine_enrollment(
    data_dir: &Path,
    enrollment: &MachineEnrollment,
) -> Result<(), String> {
    let path = enrollment_path(data_dir);
    let directory = path.parent().expect("enrollment path has a parent");
    crate::notifications::create_private_dir_all(directory)
        .map_err(|error| fs_error::message(&error, "mkdir", directory))?;
    let temporary = temporary_path(&path);
    let result = (|| {
        let mut text = serde_json::to_string_pretty(enrollment).expect("serializable enrollment");
        text.push('\n');
        let mut file = create_private_file(&temporary)
            .map_err(|error| fs_error::message(&error, "open", &temporary))?;
        file.write_all(text.as_bytes())
            .map_err(|error| fs_error::message(&error, "write", &temporary))?;
        drop(file);
        crate::platform::fs::chmod(&temporary, 0o600)
            .map_err(|error| fs_error::message(&error, "chmod", &temporary))?;
        fs::rename(&temporary, &path)
            .map_err(|error| fs_error::message2(&error, "rename", &temporary, &path))
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn record() -> Value {
        json!({
            "version": 1,
            "keyId": "kid",
            "machineId": "machine-1",
            "clientId": "client-1",
            "cloudBaseUrl": "https://cloud.example",
            "enrolledAt": "2026-11-26T00:00:00.000Z",
            "tokenEndpoint": "https://cloud.example/api/auth/oauth2/token",
            "proxyConnectionResource": "https://cloud.example/machine-connections",
            "proxyConnectionUrl": "wss://cloud.example/machine-connections",
            "mcpResourceUrl": "https://cloud.example/machines/machine-1/mcp",
            "oauthProtectedResourceUrl": "https://cloud.example/api/machines/machine-1/oauth-protected-resource",
        })
    }

    #[test]
    fn round_trips_like_json_stringify() {
        let mut value = record();
        value["enrollmentCodeSha256"] = json!(hash_enrollment_code(" code\n"));
        let enrollment = parse_machine_enrollment(&value).unwrap();
        assert_eq!(serde_json::to_value(&enrollment).unwrap(), value);
        assert_eq!(
            serde_json::to_string(&enrollment).unwrap(),
            serde_json::to_string(&value).unwrap()
        );
        assert_eq!(
            hash_enrollment_code("code"),
            "5694d08a2e53ffcae0c3103e5ad6f6076abd960eb1f8a56577040bc1028f702b"
        );
    }

    #[test]
    fn rejects_invalid_records_like_typescript() {
        let mut value = record();
        value["version"] = json!(2);
        assert_eq!(
            parse_machine_enrollment(&value),
            Err(EnrollmentError::UnsupportedVersion(
                "Unsupported machine enrollment version: 2".into()
            ))
        );
        value.as_object_mut().unwrap().remove("version");
        assert_eq!(
            parse_machine_enrollment(&value),
            Err(EnrollmentError::UnsupportedVersion(
                "Unsupported machine enrollment version: undefined".into()
            ))
        );
        let mut value = record();
        value["clientId"] = json!("");
        assert_eq!(
            parse_machine_enrollment(&value),
            Err(EnrollmentError::Invalid(
                "Machine enrollment metadata has invalid clientId".into()
            ))
        );
        let mut value = record();
        value["enrollmentCodeSha256"] = json!("ABC");
        assert!(parse_machine_enrollment(&value).is_err());
    }

    #[test]
    fn keeps_a_display_only_organization_name() {
        let mut value = record();
        value["organizationName"] = json!("Kanzlei Müller");
        let enrollment = parse_machine_enrollment(&value).unwrap();
        assert_eq!(
            enrollment.organization_name.as_deref(),
            Some("Kanzlei Müller")
        );
        assert_eq!(serde_json::to_value(&enrollment).unwrap(), value);
        value["organizationName"] = json!(42);
        let enrollment = parse_machine_enrollment(&value).unwrap();
        assert_eq!(enrollment.organization_name, None);
        assert!(
            serde_json::to_value(&enrollment)
                .unwrap()
                .get("organizationName")
                .is_none()
        );
    }
}
