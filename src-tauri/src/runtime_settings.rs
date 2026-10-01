//! Host runtime policy — not a provider template.
//!
//! `{config_dir}/runtime_settings.json`. Session log applies immediately.
//! CPU affinity applies on the next llama launch (running engines keep their mask).

use serde::{Deserialize, Serialize};

use crate::cpu_topology::AffinityMode;

const FILE_NAME: &str = "runtime_settings.json";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RuntimeSettings {
    /// File capture under `config/logs/sessions`. Env `BLACKWELL_SESSION_LOG` still wins.
    #[serde(default = "default_true")]
    pub session_log: bool,
    /// `auto` = V-Cache pin. `off` = do not inject `--cpu-mask` / `--threads`.
    #[serde(default = "default_affinity")]
    pub cpu_affinity: String,
}

fn default_true() -> bool {
    true
}

fn default_affinity() -> String {
    "auto".to_string()
}

impl Default for RuntimeSettings {
    fn default() -> Self {
        Self {
            session_log: true,
            cpu_affinity: default_affinity(),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct RuntimeSettingsStatus {
    pub session_log: bool,
    pub session_log_active: bool,
    /// `Some` when `BLACKWELL_SESSION_LOG` forces on (`true`) or off (`false`).
    pub session_log_env: Option<bool>,
    pub session_dir: Option<String>,
    pub cpu_affinity: String,
}

fn settings_path() -> std::path::PathBuf {
    crate::config::config_dir().join(FILE_NAME)
}

pub fn normalize_affinity(raw: &str) -> String {
    if AffinityMode::parse(raw) == AffinityMode::Off {
        "off".to_string()
    } else {
        "auto".to_string()
    }
}

pub fn load() -> RuntimeSettings {
    let path = settings_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        return RuntimeSettings::default();
    };
    match serde_json::from_str::<RuntimeSettings>(&text) {
        Ok(mut s) => {
            s.cpu_affinity = normalize_affinity(&s.cpu_affinity);
            s
        }
        Err(e) => {
            log::warn!("[runtime] bad {}: {e} — using defaults", path.display());
            RuntimeSettings::default()
        }
    }
}

pub fn save(settings: &RuntimeSettings) -> Result<(), String> {
    let dir = crate::config::config_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("runtime settings dir: {e}"))?;
    let mut stored = settings.clone();
    stored.cpu_affinity = normalize_affinity(&stored.cpu_affinity);
    let json = serde_json::to_string_pretty(&stored)
        .map_err(|e| format!("runtime settings serialize: {e}"))?;
    std::fs::write(settings_path(), json).map_err(|e| format!("runtime settings write: {e}"))?;
    Ok(())
}

pub fn affinity_bypassed() -> bool {
    normalize_affinity(&load().cpu_affinity) == "off"
}

/// Apply the saved session-log bit after the config dir exists.
/// Env lock is not overwritten.
pub fn apply_saved_session_log() {
    if crate::session_log::env_lock().is_some() {
        return;
    }
    crate::session_log::set_runtime_enabled(load().session_log);
}

pub fn status() -> RuntimeSettingsStatus {
    let settings = load();
    RuntimeSettingsStatus {
        session_log: settings.session_log,
        session_log_active: crate::session_log::is_active(),
        session_log_env: crate::session_log::env_lock(),
        session_dir: crate::session_log::current_dir().map(|p| p.to_string_lossy().to_string()),
        cpu_affinity: settings.cpu_affinity,
    }
}

#[tauri::command]
pub fn get_runtime_settings() -> RuntimeSettingsStatus {
    status()
}

#[tauri::command]
pub fn set_runtime_settings(session_log: bool, cpu_affinity: String) -> Result<RuntimeSettingsStatus, String> {
    let settings = RuntimeSettings {
        session_log,
        cpu_affinity: normalize_affinity(&cpu_affinity),
    };
    save(&settings)?;
    if crate::session_log::env_lock().is_none() {
        crate::session_log::set_runtime_enabled(settings.session_log);
    }
    log::info!(
        "[runtime] session_log={} cpu_affinity={} (env_lock={:?})",
        settings.session_log,
        settings.cpu_affinity,
        crate::session_log::env_lock()
    );
    Ok(status())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn affinity_off_aliases_normalize() {
        assert_eq!(normalize_affinity("off"), "off");
        assert_eq!(normalize_affinity("false"), "off");
        assert_eq!(normalize_affinity("auto"), "auto");
        assert_eq!(normalize_affinity("compute"), "auto");
        assert_eq!(normalize_affinity(""), "auto");
    }

    #[test]
    fn missing_fields_default_on() {
        let s: RuntimeSettings = serde_json::from_str("{}").unwrap();
        assert!(s.session_log);
        assert_eq!(s.cpu_affinity, "auto");
    }
}
