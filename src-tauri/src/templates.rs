//! Genesis Template System — data-driven CLI command generation.
//!
//! GenesisTemplateParam = factory blueprint from genesis_template.json (immutable, embedded in binary).
//! UserEditedTemplateParam = user's saved copy with runtime state (hidden, hiddenValues, etc.).
//! The build_command function loops through GenesisTemplateParams and constructs the full argument list
//! without any hardcoded flag logic. Adding a new backend or parameter requires editing genesis_template.json only.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::PathBuf;

use crate::types::EngineConfig;

/// Static ctx display→tokens mapping, mirrors genesis_template.json ctx.values_to_cli.
const CTX_MAP: &[(&str, usize)] = &[
    ("8k", 8192), ("16k", 16384), ("32k", 32768), ("64k", 65536),
    ("128k", 131072), ("256k", 262144), ("512k", 524288), ("1mil", 1048576),
];

pub fn ctx_to_int_tokens(ctx: &str) -> usize {
    let upper = ctx.to_uppercase();
    for (display, tokens) in CTX_MAP {
        if upper == display.to_uppercase() {
            return *tokens;
        }
    }
    ctx.parse::<usize>().unwrap_or(32768)
}

fn resolve_auto_value(key: &str, model_path: &str) -> Option<String> {
    match key {
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
    pub params: Vec<GenesisTemplateParam>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenesisTemplateParam {
    pub key: String,
    pub label: String,
    /// CLI flag string. null for logic_only params.
    #[serde(default)]
    pub flag: Option<String>,
    /// Pair of CLI flags for arg_select_double — same value injected to both (e.g. --cache-type-k, --cache-type-v).
    #[serde(default, rename = "flag_pair")]
    pub flag_pair: Vec<String>,
    /// CLI parameter type (arg_select, mapper, switch_onoff, etc.).
    #[serde(default = "default_ptype")]
    pub ptype: String,
    /// CLI values array — for "mapper" type, same-index into values_to_cli gives the CLI value.
    #[serde(default)]
    pub values: Vec<serde_json::Value>,
    /// CLI values mapped to their actual CLI argument values (for mapper ptype).
    #[serde(default, rename = "values_to_cli")]
    pub values_to_cli: Vec<serde_json::Value>,
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

    /// Extract the selected value for a param from extra_params (user choice), then fall back to user_edited_params (disk overrides), then template defaults.
    /// All key lookups are case-insensitive.
    pub fn get_value(
        &self,
        config: &EngineConfig,
        key: &str,
        user_edited_params: Option<&[crate::types::UserEditedTemplateParam]>,
    ) -> serde_json::Value {
        let key_lower = key.to_lowercase();

        // Priority 1: extra_params (user-selected value, case-insensitive lookup)
        if !config.extra_params.is_empty() {
            if let Some(v) = config.extra_params.iter().find(|(k, _)| k.to_lowercase() == key_lower) {
                return v.1.clone();
            }
        }

        // Priority 2: user_edited_params from disk (user overrides)
        if let Some(edited) = user_edited_params {
            for ep in edited {
                if ep.key.to_lowercase() == key_lower {
                    if !ep.default_value.is_null() {
                        return ep.default_value.clone();
                    }
                }
            }
        }

        // Priority 3: embedded template defaults
        self.params.iter()
            .find(|p| p.key.to_lowercase() == key_lower)
            .map(|p| p.default.clone())
            .unwrap_or_else(|| serde_json::Value::String(String::new()))
    }

    /// Build the full CLI command from GenesisTemplate + user config.
    /// Iterates GenesisTemplateParams (factory blueprint) and checks UserEditedTemplateParam (disk state) for hidden/value overrides.
    pub fn build_command(
        &self,
        config: &EngineConfig,
        _gpu_mask: &str,
        user_edited_params: Option<&[crate::types::UserEditedTemplateParam]>,
    ) -> Vec<String> {
        let mut args = Vec::new();

        // Always add model path and port (these are not in the template)
        args.extend(["-m".into(), config.model_path.clone()]);

        // Companion mmproj file — inject right after -m for clean CMD readability
        let vision_val = self.get_value(config, "vision", user_edited_params);
        let vstr = vision_val.as_str().unwrap_or("").to_lowercase();
        if matches!(vstr.as_str(), "auto" | "on") {
            if let Some(mmproj_name) = Self::scan_mmproj(&config.model_path) {
                args.extend(["--mmproj".into(), mmproj_name]);
            }
        }

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

        // Always enable Prometheus-style /metrics endpoint for fusion monitoring
        args.push("--metrics".into());

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
            // Check hidden state: user's saved hidden flag overrides genesis hidden_default.
            // When user_edited_params is None (fresh provider), fall back to genesis hidden_default.
            if let Some(edited) = user_edited_params {
                if let Some(user_param) = edited.iter().find(|d| d.key == param.key) {
                    if user_param.hidden { continue; }
                }
            } else if param.hidden_default {
                continue;
            }

            let mut value = self.get_value(config, &param.key, user_edited_params);

            // If selected value is hidden in user edits, switch to first visible (auto-repair)
            if let Some(edited) = user_edited_params {
                if let Some(user_param) = edited.iter().find(|d| d.key == param.key) {
                    let current = value.as_str().unwrap_or("");
                    if user_param.is_value_hidden(current) {
                        if let Some(fallback) = user_param.effective_default() {
                            log::debug!("[build_cmd] param '{}': value '{}' is hidden — using visible fallback '{}'", param.key, current, fallback);
                            value = fallback.clone();
                        } else {
                            continue;
                        }
                    }
                }
            }
            let value_str = value.as_str().map(String::from).unwrap_or(value.to_string());

            // Resolve "auto" from GGUF metadata cache — llama.cpp needs numbers, not "auto"
            // path_scanner handles "auto" itself via scan_path(), so skip GGUF resolution for it
            let final_value_str = if value_str == "auto" && param.ptype != "path_scanner" {
                match resolve_auto_value(&param.key, &config.model_path) {
                    Some(resolved) => {
                        log::debug!("[build_cmd] resolved auto for '{}': '{}' -> '{}'", param.key, value_str, resolved);
                        resolved
                    }
                    None => {
                        log::debug!("[build_cmd] cannot resolve auto for '{}', skipping flag", param.key);
                        Self::inject_sub_params(&mut args, param, &value_str, user_edited_params);
                        continue;
                    }
                }
            } else {
                value_str
            };

            match param.ptype.as_str() {
                "arg_select" => Self::inject_arg_select(&mut args, param, &final_value_str),
                "arg_select_double" => Self::inject_arg_select_double(&mut args, param, &final_value_str),
                "mapper" => Self::inject_mapper(&mut args, param, &final_value_str),
                "switch_onoff" => Self::inject_switch_onoff(&mut args, param, &final_value_str),
                "switch_inverted" => Self::inject_switch_inverted(&mut args, param, &final_value_str),
                "path_scanner" => {
                    // vision/mmproj handled above right after -m — skip here
                    if param.key != "vision" {
                        if let Some(path) = Self::scan_path(config, param, &final_value_str) {
                            args.extend([param.flag.clone().unwrap_or_default(), path]);
                        }
                    }
                },
                _ => {}
            }

            // Inject sub_params for ALL ptypes — checks disk state first, then template defaults
            Self::inject_sub_params(&mut args, param, &final_value_str, user_edited_params);
        }

        // Hardcoded n_gpu_layers injection — value computed by VRAM scenario factory.
        // Not in genesis template because the user cannot meaningfully edit it;
        // it is derived from GPU topology + model architecture at runtime.
        if let Some(ngl) = config.extra_params.get("__ngl") {
            let ngl_str = ngl.as_str().map(String::from).unwrap_or(ngl.to_string());
            args.extend(["--n-gpu-layers".into(), ngl_str]);
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

    fn sanitize_arg_value(value: &str) -> String {
        value.to_string()
    }

    fn inject_arg_select(args: &mut Vec<String>, param: &GenesisTemplateParam, value: &str) {
        if let Some(flag) = &param.flag {
            let sanitized = Self::sanitize_arg_value(value);
            args.extend([flag.clone(), sanitized]);
        }
    }

    fn inject_arg_select_double(args: &mut Vec<String>, param: &GenesisTemplateParam, value: &str) {
        let sanitized = Self::sanitize_arg_value(value);
        for flag in &param.flag_pair {
            args.extend([flag.clone(), sanitized.clone()]);
        }
    }

    fn inject_mapper(args: &mut Vec<String>, param: &GenesisTemplateParam, value: &str) {
        // Template-driven mapper: find index of value in param.values,
        // use same index in param.values_to_cli for the actual CLI value.
        let cli_val = if let Some(idx) = param.values.iter().position(|v| {
            v.as_str().unwrap_or("").to_lowercase() == value.to_lowercase()
        }) {
            param.values_to_cli.get(idx)
                .and_then(|v| v.as_str().map(String::from))
                .unwrap_or_else(|| value.to_string())
        } else {
            value.to_string()
        };
        if let Some(flag) = &param.flag {
            args.extend([flag.clone(), cli_val]);
        }
    }

    fn inject_switch_onoff(args: &mut Vec<String>, param: &GenesisTemplateParam, value: &str) {
        if value.to_lowercase() == "on" {
            if let Some(flag) = &param.flag {
                args.push(flag.clone());
            }
        }
    }

    fn inject_switch_inverted(args: &mut Vec<String>, param: &GenesisTemplateParam, value: &str) {
        // "off" → emit the flag (e.g., --no-mmap, --no-kv-unified)
        // "on" → emit nothing (default behavior)
        if value.to_lowercase() == "off" {
            if let Some(flag) = &param.flag {
                args.push(flag.clone());
            }
        }
    }

    /// Scan model directory for mmproj companion file. Returns bare filename only.
    fn scan_mmproj(model_path: &str) -> Option<String> {
        let model_dir = PathBuf::from(model_path);
        let parent = model_dir.parent()?;

        let entries = std::fs::read_dir(parent).ok()?;
        for entry in entries.flatten() {
            let fname = entry.file_name();
            let fname_lower = fname.to_string_lossy().to_lowercase();
            if Self::matches_pattern(&fname_lower, "*mmproj*") {
                return Some(fname.to_string_lossy().to_string());
            }
        }

        None
    }

    fn scan_path(config: &EngineConfig, param: &GenesisTemplateParam, value: &str) -> Option<String> {
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
                return Some(fname.to_string_lossy().to_string());
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
        param: &GenesisTemplateParam,
        value: &str,
        user_edited_params: Option<&[crate::types::UserEditedTemplateParam]>,
    ) {
        // Disk state (user edits) takes precedence — if found, skip embedded template.
        let mut disk_found = false;
        if let Some(edited) = user_edited_params {
            for user_param in edited {
                if user_param.key != param.key {
                    continue;
                }
                disk_found = true;
                if let Some(ref sp) = user_param.sub_params {
                    Self::inject_from_array(args, value, sp.get(value).map(|v| v.as_slice()));
                }
            }
        }

        // Only use embedded template sub_params when no disk state exists for this key.
        if !disk_found {
            if let Some(sub) = &param.sub_params {
                if !sub.is_null() {
                    Self::inject_from_json_value(args, value, sub);
                }
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

    pub fn get_default(&self, key: &str) -> serde_json::Value {
        self.params.iter()
            .find(|p| p.key == key)
            .map(|p| p.default.clone())
            .unwrap_or_else(|| serde_json::Value::String(String::new()))
    }

    pub fn is_default(&self, key: &str, user_value: &serde_json::Value) -> bool {
        let default = self.get_default(key);
        format!("{}", default) == format!("{}", user_value)
    }

    pub fn reset_to_default(&self, key: &str) -> serde_json::Value {
        self.get_default(key)
    }

    /// Get all key values from template params (for VRAM check and other data-driven operations).
    pub fn config_keys(&self) -> Vec<&str> {
        self.params.iter().map(|p| p.key.as_str()).collect()
    }

    /// Get a param definition by key.
    pub fn find_param(&self, key: &str) -> Option<&GenesisTemplateParam> {
        self.params.iter().find(|p| p.key == key)
    }
}
