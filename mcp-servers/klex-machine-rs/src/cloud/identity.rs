//! The machine's Ed25519 identity in `identity/private-key.pem`. Keys are
//! written as unencrypted PKCS#8 v1 PEM, as WebCrypto exports them, and the
//! key ID is the base64url SHA-256 of `kty:crv:x`.

use std::fs;
use std::io::Write;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use ed25519_dalek::SigningKey;
use ed25519_dalek::pkcs8::DecodePrivateKey;
use serde::Serialize;
use sha2::{Digest, Sha256};

use super::state::{create_private_file, temporary_path};
use crate::fs_error;

/// DER prefix of a PKCS#8 v1 Ed25519 private key; the 32-byte seed follows.
const PKCS8_PREFIX: [u8; 16] = [
    0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20,
];

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct PublicJwk {
    pub kty: String,
    pub crv: String,
    pub x: String,
    pub kid: String,
    pub alg: String,
    #[serde(rename = "use")]
    pub use_: String,
}

#[derive(Clone)]
pub struct MachineIdentity {
    pub signing_key: SigningKey,
    pub key_id: String,
    pub public_jwk: PublicJwk,
}

impl MachineIdentity {
    fn from_signing_key(signing_key: SigningKey) -> Self {
        let x = URL_SAFE_NO_PAD.encode(signing_key.verifying_key().as_bytes());
        let key_id = URL_SAFE_NO_PAD.encode(Sha256::digest(format!("OKP:Ed25519:{x}")));
        let public_jwk = PublicJwk {
            kty: "OKP".into(),
            crv: "Ed25519".into(),
            x,
            kid: key_id.clone(),
            alg: "EdDSA".into(),
            use_: "sig".into(),
        };
        Self {
            signing_key,
            key_id,
            public_jwk,
        }
    }

    pub fn generate() -> Result<Self, String> {
        let mut seed = [0u8; 32];
        getrandom::fill(&mut seed).map_err(|error| error.to_string())?;
        Ok(Self::from_signing_key(SigningKey::from_bytes(&seed)))
    }

    fn pem(&self) -> String {
        let mut der = PKCS8_PREFIX.to_vec();
        der.extend_from_slice(self.signing_key.as_bytes());
        let body = STANDARD.encode(der);
        let lines: Vec<&str> = body
            .as_bytes()
            .chunks(64)
            .map(|chunk| std::str::from_utf8(chunk).expect("base64 is ASCII"))
            .collect();
        format!(
            "-----BEGIN PRIVATE KEY-----\n{}\n-----END PRIVATE KEY-----\n",
            lines.join("\n")
        )
    }
}

fn from_pem(pem: &str) -> Option<SigningKey> {
    let body: String = pem
        .replacen("-----BEGIN PRIVATE KEY-----", "", 1)
        .replacen("-----END PRIVATE KEY-----", "", 1)
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if body.is_empty() {
        return None;
    }
    let der = base64::engine::GeneralPurpose::new(
        &base64::alphabet::STANDARD,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent),
    )
    .decode(body)
    .ok()?;
    SigningKey::from_pkcs8_der(&der).ok()
}

pub fn load_machine_identity(path: &Path) -> Result<MachineIdentity, String> {
    let pem = fs::read_to_string(path).map_err(|error| fs_error::message(&error, "open", path))?;
    from_pem(&pem)
        .map(MachineIdentity::from_signing_key)
        .ok_or_else(|| format!("Machine private key is corrupt: {}", path.display()))
}

/// Writes the key without ever replacing an existing one: the file is
/// written and synced under a temporary name, then hard-linked into place.
pub fn save_machine_identity(path: &Path, identity: &MachineIdentity) -> Result<(), String> {
    let directory = path.parent().expect("identity path has a parent");
    crate::notifications::create_private_dir_all(directory)
        .map_err(|error| fs_error::message(&error, "mkdir", directory))?;
    let temporary = temporary_path(path);
    let result = (|| {
        let mut file = create_private_file(&temporary)
            .map_err(|error| fs_error::message(&error, "open", &temporary))?;
        file.write_all(identity.pem().as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| fs_error::message(&error, "write", &temporary))?;
        drop(file);
        fs::hard_link(&temporary, path).map_err(|error| {
            if fs_error::is(&error, "EEXIST") {
                format!(
                    "Refusing to replace existing machine private key: {}",
                    path.display()
                )
            } else {
                fs_error::message2(&error, "link", &temporary, path)
            }
        })
    })();
    let _ = fs::remove_file(&temporary);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected values computed with Node's WebCrypto for the seed [7; 32].
    const SEED: [u8; 32] = [7; 32];
    const X: &str = "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw";
    const KID: &str = "nlJuejKWmfNZhRXjNgmmbtRFEt0TGVPecAADGNKGJJE";
    const PEM: &str = "-----BEGIN PRIVATE KEY-----\nMC4CAQAwBQYDK2VwBCIEIAcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcH\n-----END PRIVATE KEY-----\n";

    #[test]
    fn matches_webcrypto_export_and_key_id() {
        let identity = MachineIdentity::from_signing_key(SigningKey::from_bytes(&SEED));
        assert_eq!(identity.public_jwk.x, X);
        assert_eq!(identity.key_id, KID);
        assert_eq!(identity.pem(), PEM);
        assert_eq!(from_pem(PEM).unwrap().as_bytes(), &SEED);
        assert_eq!(
            serde_json::to_string(&identity.public_jwk).unwrap(),
            format!(
                r#"{{"kty":"OKP","crv":"Ed25519","x":"{X}","kid":"{KID}","alg":"EdDSA","use":"sig"}}"#
            )
        );
    }

    #[test]
    fn refuses_to_replace_a_key() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("identity").join("private-key.pem");
        let identity = MachineIdentity::generate().unwrap();
        save_machine_identity(&path, &identity).unwrap();
        let loaded = load_machine_identity(&path).unwrap();
        assert_eq!(loaded.key_id, identity.key_id);
        let error =
            save_machine_identity(&path, &MachineIdentity::generate().unwrap()).unwrap_err();
        assert!(error.starts_with("Refusing to replace existing machine private key: "));
        assert_eq!(fs::read_dir(path.parent().unwrap()).unwrap().count(), 1);
        fs::write(&path, "garbage").unwrap();
        assert_eq!(
            load_machine_identity(&path).err(),
            Some(format!(
                "Machine private key is corrupt: {}",
                path.display()
            ))
        );
    }
}
