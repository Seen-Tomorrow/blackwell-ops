use std::fs;
use crate::features::reactor::core::RodHandle;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct ReactorState {
    pub rods: Vec<RodHandle>,
    #[serde(default)]
    pub tier_enabled: bool,
    pub saved_at: String,
}

impl Default for ReactorState {
    fn default() -> Self {
        Self::new()
    }
}

impl ReactorState {
    pub fn new() -> Self {
        Self {
            rods: Vec::new(),
            tier_enabled: false,
            saved_at: chrono::Local::now().to_rfc3339(),
        }
    }

    pub fn from_rods(rods: &[RodHandle], tier_enabled: bool) -> Self {
        Self {
            rods: rods.to_vec(),
            tier_enabled,
            saved_at: chrono::Local::now().to_rfc3339(),
        }
    }

    pub fn load() -> Option<Self> {
        let path = state_path()?;
        if !path.exists() { return None; }
        let content = fs::read_to_string(&path).ok()?;
        serde_json::from_str(&content).ok()
    }

    pub fn save(&self) {
        let path = match state_path() {
            Some(p) => p,
            None => return,
        };
        if let Some(dir) = path.parent() {
            let _ = fs::create_dir_all(dir);
        }
        if let Ok(json) = serde_json::to_string_pretty(self) {
            let _ = fs::write(&path, json);
        }
    }

    pub fn delete() {
        if let Some(path) = state_path() {
            let _ = fs::remove_file(&path);
        }
    }
}

fn state_path() -> Option<std::path::PathBuf> {
    dirs::config_dir().map(|p| p.join("blackwell-ops").join("reactor_state.json"))
}