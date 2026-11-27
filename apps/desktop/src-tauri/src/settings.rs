//! `settings.json` in the app config directory: what the person chose, as
//! opposed to the machine identity, which the daemon owns in its data
//! directory.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const DEFAULT_CLOUD_BASE_URL: &str = "https://cloud.klex.bot";
/// Points pairing at another Cloud deployment, for development and staging.
pub const CLOUD_URL_ENV: &str = "KLEX_DESKTOP_CLOUD_URL";

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub version: u8,
    /// Whether the machine should be connected. Disconnect clears it, so the
    /// app stays offline across restarts until the person connects again.
    pub enabled: bool,
    /// Shown until the daemon reports its own, from the confirmed preview.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub organization_name: Option<String>,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            version: 1,
            enabled: true,
            organization_name: None,
        }
    }
}

impl Settings {
    /// Missing or unreadable settings fall back to the defaults; they hold
    /// only preferences, never anything the connection depends on.
    pub fn load(path: &Path) -> Self {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|text| serde_json::from_str::<Settings>(&text).ok())
            .filter(|settings| settings.version == 1)
            .unwrap_or_default()
    }

    pub fn save(&self, path: &Path) -> Result<(), String> {
        let directory = path.parent().ok_or("settings path has no parent")?;
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
        let mut text = serde_json::to_string_pretty(self).map_err(|error| error.to_string())?;
        text.push('\n');
        let temporary = path.with_extension("json.tmp");
        std::fs::write(&temporary, text).map_err(|error| error.to_string())?;
        std::fs::rename(&temporary, path).map_err(|error| error.to_string())
    }
}

pub fn cloud_base_url() -> String {
    std::env::var(CLOUD_URL_ENV)
        .ok()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_CLOUD_BASE_URL.into())
}

pub struct Paths {
    /// The daemon's `--data-dir`: identity, enrollment and notification state.
    pub data_dir: PathBuf,
    pub settings: PathBuf,
    pub log_dir: PathBuf,
    /// The daemon's default working directory for shell tools.
    pub home: PathBuf,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_falls_back_to_defaults() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("nested").join("settings.json");
        assert_eq!(Settings::load(&path), Settings::default());
        let settings = Settings {
            version: 1,
            enabled: false,
            organization_name: Some("Kanzlei Müller".into()),
        };
        settings.save(&path).unwrap();
        assert_eq!(Settings::load(&path), settings);
        std::fs::write(&path, "{\"version\":2,\"enabled\":false}").unwrap();
        assert_eq!(Settings::load(&path), Settings::default());
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(Settings::load(&path), Settings::default());
    }
}
