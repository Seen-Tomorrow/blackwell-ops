//! Provider Templates — data-driven CLI command generation.
//!
//! Templates define what parameters exist, their valid values, and how they map to CLI flags.
//! The build_command function loops through template params and constructs the full argument list
//! without any hardcoded flag logic. Adding a new backend or parameter requires editing genesis_template.json only.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::types::EngineConfig;

fn resolve_auto_value(config_key: &str, model_path: &str) -> Option<String> {
    match config_key {
        "yarn_orig_ctx" => {
            let cache = crate::model_cache::load_cache();
            if let Some(entry) = cache.get(model_path) {
                if let Some(gguf) = &entry.gguf_meta {
                    if gguf.n_ctx_train > 0 {
                        return Some(gguf.n_ctx_train.to_string());
                    }
                }
            }
            None
        }
        "rope_freq_base" => {
            let cache = crate::model_cache::load_cache();
            if let Some(entry) = cache.get(model_path) {
                if let Some(gguf) = &entry.gguf_meta {
                    if gguf.rope_freq_base > 0.0 {
                        return Some(format!("{}", gguf.rope_freq_base as u32));
                    }
                }
            }
            None
        }
        _ => None,
    }
}

// ── Template Types ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderTemplate {
    pub binary_name: String,
    pub description: String,
    #[serde(default)]
    pub params: Vec<TemplateParam>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateParam {
    pub key: String,
    pub label: String,
    #[serde(default)]
    pub config_key: String,
    /// CLI flag string. null for logic_only params.
    #[serde(default)]
    pub flag: Option<String>,
    /// CLI parameter type (arg_select, mapper, switch_onoff, etc.).
    #[serde(default = "default_ptype")]
    pub ptype: String,
    /// Named transformer ID (e.g., "CTX_TO_INT", "OFFLOAD_MAP").
    #[serde(default)]
    pub map_id: Option<String>,
    /// Available choices for this parameter.
    #[serde(default)]
    pub values: Vec<serde_json::Value>,
    /// Default value shown as green in UI.
    #[serde(default)]
    pub default: serde_json::Value,
    /// UI grouping label (e.g., "Core", "Performance", "Feature Flags").
    #[serde(default)]
    pub ui_group: String,
    /// Tooltip/help text for the parameter.
    #[serde(default)]
    pub note: String,
    /// File scan pattern for path_scanner type (e.g., "*mmproj*").
    #[serde(default)]
    pub pattern: String,
    /// Additional flags to inject based on the selected value.
    /// Key is the user-facing value ("ON", "MOE_OPTIMAL"), value is a flat array of extra args.
    #[serde(default)]
    pub sub_params: Option<serde_json::Value>,
    /// Dock key — when set, param renders in a docked block above PARAMETERS instead of its ui_group.
    #[serde(default)]
    pub dock: String,
    /// Hidden by default — param is excluded from catalog UI and launch command until user toggles it on.
    #[serde(default)]
    pub hidden_default: bool,
}

fn default_ptype() -> String {
    "arg_select".to_string()
}

// ── Template Loading ────────────────────────────────────────────────

/// Recovery default template embedded in binary. Used when templates.json is missing/corrupt.
pub const RECOVERY_DEFAULT: &str = include_str!("../config/genesis_template.json");

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TemplateBundle {
    pub version: u32,
    #[serde(flatten)]
    pub templates: HashMap<String, ProviderTemplate>,
}

impl Default for TemplateBundle {
    fn default() -> Self {
        serde_json::from_str(RECOVERY_DEFAULT).unwrap()
    }
}

impl ProviderTemplate {
    pub fn load() -> Self {
        let bundle: TemplateBundle = serde_json::from_str(RECOVERY_DEFAULT)
            .expect("Embedded genesis_template.json must be valid");
        bundle.templates
            .get("ggml-stable")
            .cloned()
            .unwrap_or_else(|| panic!("Missing ggml-stable template in embedded genesis"))
    }

    pub fn known_ids() -> Vec<String> {
        let bundle: TemplateBundle = serde_json::from_str(RECOVERY_DEFAULT)
            .expect("Embedded genesis_template.json must be valid");
        bundle.templates.keys().cloned().collect()
    }

    pub fn template_type_for_id(id: &str) -> String {
        if id.to_lowercase().contains("ik") {
            "ik-llama".to_string()
        } else {
            "ggml-llama".to_string()
        }
    }

    #[deprecated(note = "use config::template_key_for_type() instead")]
    pub fn template_key_for_id(id: &str) -> String {
        match id {
            "ik-extreme" => "ik-extreme".to_string(),
            _ => "ggml-stable".to_string(),
        }
    }

    /// Get a specific provider template by ID from the embedded genesis_template.json.
    pub fn load_by_id(id: &str) -> Option<Self> {
        Self::load();
        let bundle: TemplateBundle = serde_json::from_str(RECOVERY_DEFAULT).ok()?;
        bundle.templates.get(id).cloned()
    }

    /// Extract the selected value for a param from extra_params (user choice), then fall back to param_defs, then template defaults.
    /// All key lookups are case-insensitive.
    pub fn get_value(
        &self,
        config: &EngineConfig,
        key: &str,
        param_defs: Option<&[crate::types::ParamDef]>,
    ) -> serde_json::Value {
        let key_lower = key.to_lowercase();

        // Priority 1: extra_params (user-selected value, case-insensitive lookup)
        if !config.extra_params.is_empty() {
            // Direct key match first
            if let Some(v) = config.extra_params.get(key) {
                return v.clone();
            }
            // Case-insensitive match
            if let Some(v) = config.extra_params.iter().find(|(k, _)| k.to_lowercase() == key_lower) {
                return v.1.clone();
            }
        }

        // Priority 2: param_definitions from disk (user overrides)
        if let Some(defs) = param_defs {
            for def in defs {
                if def.key.to_lowercase() == key_lower || (!def.config_key.is_empty() && def.config_key.to_lowercase() == key_lower) {
                    if !def.default_value.is_null() {
                        return def.default_value.clone();
                    }
                }
            }
        }

        // Priority 3: embedded template defaults
        self.params.iter()
            .find(|p| p.key.to_lowercase() == key_lower || p.config_key.to_lowercase() == key_lower)
            .map(|p| p.default.clone())
            .unwrap_or_else(|| serde_json::Value::String(String::new()))
    }

    /// Build the full CLI command from template + user config.
    pub fn build_command(
        &self,
        config: &EngineConfig,
        _gpu_mask: &str,
        param_defs: Option<&[crate::types::ParamDef]>,
    ) -> Vec<String> {
        let mut args = Vec::new();

        // Always add model path and port (these are not in the template)
        args.extend(["-m".into(), config.model_path.clone()]);
        args.extend(["--port".into(), config.port.to_string()]);

        // Add alias for llama-server API identification — sanitize spaces/commas
        let cli_alias = config.alias.replace(' ', "-").replace(',', "-");
        if !cli_alias.is_empty() {
            args.extend(["--alias".into(), cli_alias]);
        }

        // Force TRACE-level logging (-lv 4) — required for log-based prefill metrics
        // (prompt processing progress, prompt eval time TPS) which are at LOG_LEVEL_TRACE
        // since llama.cpp PR #17630 (Dec 2025) and PR #23021 (May 2026)
        args.extend(["-lv".into(), "4".to_string()]);

        // ── TEST MODE (REPLACE): bypass all params, use only raw test flags ───────────
        if let Some(test_args) = config.extra_params.get("__test_args") {
            if let Some(args_arr) = test_args.as_array() {
                for arg in args_arr {
                    if let Some(s) = arg.as_str() {
                        args.push(s.to_string());
                    }
                }
                // Log and return immediately — no template params processed
                let full_cmd = format!("{} {}", self.binary_name, args.join(" "));
                eprintln!("[LAUNCH_CMD][TEST] {}", full_cmd);
                if let Ok(log_dir) = std::env::var("APPDATA") {
                    let log_path = PathBuf::from(&log_dir).join("..").join("Local").join("Temp").join("blackwell-launch.log");
                    let _ = std::fs::write(&log_path, &full_cmd);
                }
                return args;
            }
        }

        for param in &self.params {
            // Resolve the active value: use ParamDef's resolve_launch_value() which
            // auto-selects first visible when default is hidden (so launch can never be "blind").
            let mut value = self.get_value(config, &param.key, param_defs);

            if let Some(defs) = param_defs {
                if let Some(def) = defs.iter().find(|d| d.key == param.key || (!d.config_key.is_empty() && d.config_key == param.config_key)) {
                    // Skip entire param if row is hidden
                    if def.hidden { continue; }
                    // If selected value is hidden, switch to first visible (auto-repair)
                    let current = value.as_str().unwrap_or("");
                    if def.is_value_hidden(current) {
                        if let Some(fallback) = def.effective_default() {
                            log::debug!("[build_cmd] param '{}': default '{}' is hidden — using visible fallback '{}'", def.key, current, fallback);
                            value = fallback.clone();
                        } else {
                            // No visible value at all — skip injecting this param
                            continue;
                        }
                    }
                }
            }
            let value_str = value.as_str().map(String::from).unwrap_or(value.to_string());

            // Resolve "auto" from GGUF metadata cache — llama.cpp needs numbers, not "auto"
            let final_value_str = if value_str == "auto" {
                match resolve_auto_value(&param.config_key, &config.model_path) {
                    Some(resolved) => {
                        log::debug!("[build_cmd] resolved auto for '{}': '{}' -> '{}'", param.key, value_str, resolved);
                        resolved
                    }
                    None => {
                        log::debug!("[build_cmd] cannot resolve auto for '{}', skipping flag", param.key);
                        Self::inject_sub_params(&mut args, param, &value_str, param_defs);
                        continue;
                    }
                }
            } else {
                value_str
            };

            match param.ptype.as_str() {
                "arg_select" => Self::inject_arg_select(&mut args, param, &final_value_str),
                "mapper" => Self::inject_mapper(&mut args, param, &final_value_str),
                "switch_onoff" => Self::inject_switch_onoff(&mut args, param, &final_value_str),
                "switch_inverted" => Self::inject_switch_inverted(&mut args, param, &final_value_str),
                "path_scanner" => {
                    if let Some(path) = Self::scan_path(config, param, &final_value_str) {
                        args.extend([param.flag.clone().unwrap_or_default(), path]);
                    }
                },
                _ => {}
            }

            // Inject sub_params for ALL ptypes — checks disk state first, then template defaults
            Self::inject_sub_params(&mut args, param, &final_value_str, param_defs);
        }

        // ── TEST MODE (ADD): append raw test flags after all template params ───────────
        if let Some(test_args_add) = config.extra_params.get("__test_args_add") {
            if let Some(args_arr) = test_args_add.as_array() {
                for arg in args_arr {
                    if let Some(s) = arg.as_str() {
                        args.push(s.to_string());
                    }
                }
            }
        }

        if !config.model_path.is_empty() {
            let full_cmd = format!("{} {}", self.binary_name, args.join(" "));
            eprintln!("[LAUNCH_CMD] {}", full_cmd);

            if let Ok(log_dir) = std::env::var("APPDATA") {
                let log_path = PathBuf::from(&log_dir).join("..").join("Local").join("Temp").join("blackwell-launch.log");
                if let Err(e) = std::fs::write(&log_path, &full_cmd) {
                    eprintln!("[LAUNCH_CMD] Failed to write log: {}", e);
                }
            }
        }

        args
    }

    fn sanitize_arg_value(value: &str, _map_id: Option<&str>) -> String {
        // Values are already normalized by TS normalizeValue() — pass through unchanged.
        value.to_string()
    }

    fn inject_arg_select(args: &mut Vec<String>, param: &TemplateParam, value: &str) {
        if let Some(flag) = &param.flag {
            let sanitized = Self::sanitize_arg_value(value, param.map_id.as_deref());
            args.extend([flag.clone(), sanitized]);
        }
    }

    fn inject_mapper(args: &mut Vec<String>, param: &TemplateParam, value: &str) {
        let transformed = Self::apply_mapper(param.map_id.as_deref(), value);
        if let Some(flag) = &param.flag {
            let sanitized = Self::sanitize_arg_value(&transformed, param.map_id.as_deref());
            args.extend([flag.clone(), sanitized]);
        }
    }

    fn inject_switch_onoff(args: &mut Vec<String>, param: &TemplateParam, value: &str) {
        if value.to_lowercase() == "on" {
            if let Some(flag) = &param.flag {
                args.push(flag.clone());
            }
        }
    }

    fn inject_switch_inverted(args: &mut Vec<String>, _param: &TemplateParam, value: &str) {
        if value.to_lowercase() == "off" {
            args.push("--no-mmap".to_string());
        }
    }

    fn scan_path(config: &EngineConfig, param: &TemplateParam, value: &str) -> Option<String> {
        let val_lower = value.to_lowercase();
        if !matches!(val_lower.as_str(), "auto" | "on") {
            return None;
        }

        let pattern = &param.pattern;
        let model_dir = PathBuf::from(&config.model_path);
        let parent = model_dir.parent()?;

        let entries = std::fs::read_dir(parent).ok()?;
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let fname_lower = fname.to_string_lossy().to_lowercase();

            // Check if filename matches pattern (simple glob matching)
            if Self::matches_pattern(&fname_lower, pattern) {
                return Some(entry.path().to_string_lossy().to_string());
            }
        }

        None
    }

    fn matches_pattern(filename: &str, pattern: &str) -> bool {
        let pat_lower = pattern.to_lowercase();

        // Handle *mmproj* style patterns
        if pat_lower.contains('*') {
            let parts: Vec<&str> = pat_lower.split('*').collect();
            if parts.len() == 2 && parts[0].is_empty() && parts[1].is_empty() {
                return true; // Just "*" matches everything
            }
            for part in &parts {
                if !part.is_empty() && !filename.contains(part) {
                    return false;
                }
            }
            return true;
        }

        filename.contains(&pat_lower)
    }

    /// Inject extra CLI args from sub_params mapping.
    fn inject_sub_params(
        args: &mut Vec<String>,
        param: &TemplateParam,
        value: &str,
        param_defs: Option<&[crate::types::ParamDef]>,
    ) {
        // Priority: disk state first, then embedded template
        if let Some(defs) = param_defs {
            for def in defs {
                // Match by key OR config_key (same dual-key lookup as get_value)
                if def.key != param.key && !(!def.config_key.is_empty() && def.config_key == param.config_key) {
                    continue;
                }
                if let Some(ref sp) = def.sub_params {
                    Self::inject_from_array(args, value, sp.get(value).map(|v| v.as_slice()));
                }
            }
        }

        // Fall back to embedded template's sub_params
        if let Some(sub) = &param.sub_params {
            if !sub.is_null() {
                Self::inject_from_json_value(args, value, sub);
            } else {
                // Template param has no sub_params at all — nothing to inject
            }
        }
    }

    fn inject_from_array(
        args: &mut Vec<String>,
        _value: &str,
        entry: Option<&[String]>,
    ) {
        if let Some(arr) = entry {
            for v in arr {
                args.push(v.clone());
            }
        }
    }

    fn inject_from_json_value(args: &mut Vec<String>, value: &str, json: &serde_json::Value) {
        if let Some(extra_arr) = json.get(value) {
            if let Some(arr) = extra_arr.as_array() {
                for v in arr {
                    args.push(v.as_str().unwrap_or("").to_string());
                }
            }
        }
    }

    fn apply_mapper(map_id: Option<&str>, value: &str) -> String {
        match map_id {
            Some("CTX_TO_INT") => Self::ctx_to_int_str(value),
            Some("OFFLOAD_MAP") => Self::offload_map(value),
            _ => value.to_string(), // Unknown mapper — pass through unchanged
        }
    }

    pub fn ctx_to_int_str(ctx: &str) -> String {
        let upper = ctx.to_uppercase();
        match upper.as_str() {
            "4K" => "4096".to_string(),
            "8K" => "8192".to_string(),
            "16K" => "16384".to_string(),
            "32K" => "32768".to_string(),
            "64K" => "65536".to_string(),
            "128K" => "131072".to_string(),
            "256K" => "262144".to_string(),
            "512K" => "524288".to_string(),
            "1M" | "1MIL" => "1048576".to_string(),
            _ => ctx.parse::<usize>().map(|n| n.to_string()).unwrap_or_else(|_| "32768".to_string()),
        }
    }

    fn offload_map(offload: &str) -> String {
        if offload.to_uppercase() == "ALL" || offload == "999" {
            "999".to_string()
        } else {
            offload.to_string()
        }
    }

    pub fn get_default(&self, config_key: &str) -> serde_json::Value {
        self.params.iter()
            .find(|p| p.config_key == config_key || p.key == config_key)
            .map(|p| p.default.clone())
            .unwrap_or_else(|| serde_json::Value::String(String::new()))
    }

    pub fn is_default(&self, config_key: &str, user_value: &serde_json::Value) -> bool {
        let default = self.get_default(config_key);
        // Normalize for comparison: convert both to strings
        format!("{}", default) == format!("{}", user_value)
    }

    pub fn reset_to_default(&self, config_key: &str) -> serde_json::Value {
        self.get_default(config_key)
    }

    // ── Data-Driven Provider Defaults (removed) ─────────────────────────
    // Provider defaults are now resolved purely from genesis_template.json
    // via get_value() -> param_defs -> template defaults priority chain.
    // No more hardcoded match arms or case-sensitive guards.

    /// Get all config_key values from template params (for VRAM check and other data-driven operations).
    pub fn config_keys(&self) -> Vec<&str> {
        self.params.iter().map(|p| p.config_key.as_str()).collect()
    }

    /// Get a param definition by config_key.
    pub fn find_param(&self, config_key: &str) -> Option<&TemplateParam> {
        self.params.iter().find(|p| p.config_key == config_key || p.key == config_key)
    }
}
