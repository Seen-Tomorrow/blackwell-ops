//! Provider Template System — data-driven CLI command generation.
//!
//! ProviderDefaultParam = schema for provider default configs on disk (read-only).
//! UserEditedTemplateParam = user's saved copy with runtime state (hidden, hiddenValues, etc.).
//! The build_command function iterates user params to construct the full argument list
//! without any hardcoded flag logic. Adding a new backend requires adding a provider folder to runtime/.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::types::EngineConfig;

fn resolve_auto_value(key: &str, model_path: &str) -> Option<String> {
    let cache = crate::model_cache::load_cache();
    match key {
        "yarn_orig_ctx" => {
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

/// Per-provider launch contract — flags injected before user params.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpawnProfile {
    #[serde(default = "default_model_flag")]
    pub model_flag: Vec<String>,
    #[serde(default = "default_port_flag")]
    pub port_flag: Vec<String>,
    #[serde(default = "default_alias_flag")]
    pub alias_flag: Vec<String>,
    /// Extra verbosity flags (e.g. ggml: `["-lv","4"]`; IK: `[]`).
    #[serde(default)]
    pub verbosity_args: Vec<String>,
    #[serde(default = "default_true")]
    pub enable_metrics: bool,
    #[serde(default = "default_true")]
    pub supports_fusion: bool,
    #[serde(default = "default_gpu_env")]
    pub gpu_env: String,
    #[serde(default = "default_ngl_flag")]
    pub ngl_flag: Vec<String>,
    #[serde(default = "default_mmproj_flag")]
    pub mmproj_flag: Vec<String>,
    /// Max concurrent engine slots when this provider is installed (global stack uses the highest value across all providers).
    #[serde(default = "default_max_engine_slots")]
    pub max_engine_slots: usize,
}

fn default_model_flag() -> Vec<String> { vec!["-m".into()] }
fn default_port_flag() -> Vec<String> { vec!["--port".into()] }
fn default_alias_flag() -> Vec<String> { vec!["--alias".into()] }
fn default_gpu_env() -> String { "CUDA_VISIBLE_DEVICES".into() }
fn default_ngl_flag() -> Vec<String> { vec!["--n-gpu-layers".into()] }
fn default_mmproj_flag() -> Vec<String> { vec!["--mmproj".into()] }
fn default_true() -> bool { true }
fn default_max_engine_slots() -> usize { 32 }

impl Default for SpawnProfile {
    fn default() -> Self {
        Self {
            model_flag: default_model_flag(),
            port_flag: default_port_flag(),
            alias_flag: default_alias_flag(),
            verbosity_args: vec!["-lv".into(), "4".into()],
            enable_metrics: true,
            supports_fusion: true,
            gpu_env: default_gpu_env(),
            ngl_flag: default_ngl_flag(),
            mmproj_flag: default_mmproj_flag(),
            max_engine_slots: default_max_engine_slots(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderTemplate {
    pub binary_name: String,
    pub description: String,
    #[serde(default)]
    pub spawn_profile: SpawnProfile,
    #[serde(default)]
    pub params: Vec<ProviderDefaultParam>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderDefaultParam {
    pub key: String,
    pub label: String,
    /// CLI flag string. null for logic_only params.
    #[serde(default)]
    pub flag: Option<String>,
    /// Pair of CLI flags for arg_select_double — same value injected to both (e.g. --cache-type-k, --cache-type-v).
    #[serde(default, rename = "flag_pair")]
    pub flag_pair: Vec<String>,
    /// CLI parameter type (arg_select, slider, switch_onoff, etc.).
    #[serde(default = "crate::types::default_ptype")]
    pub ptype: String,
    /// CLI values array — for "arg_select" type, user selects from this list.
    #[serde(default)]
    pub values: Vec<serde_json::Value>,
    /// Slider step increment (for ptype="slider"). Range is derived from values[0]..values[last].
    #[serde(default)]
    pub step: Option<f64>,
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

// ── Provider Default Config Loading (disk-based) ────────────────────

/// Read templateVersion from provider's default config JSON. Returns 1 if field missing/unparseable.
pub fn get_template_version_for_provider(provider_id: &str) -> u32 {
    let app_root = crate::config::app_root_dir();
    let config_path = app_root.join("runtime").join(provider_id).join("config")
        .join(format!("{}-default-config.json", provider_id));

    if !config_path.exists() { return 1; }
    let content = match std::fs::read_to_string(&config_path) { Ok(c) => c, Err(_) => return 1 };
    #[derive(Deserialize)]
    struct TvOnly { #[serde(default, rename = "templateVersion")] tv: u32 }
    serde_json::from_str::<TvOnly>(&content).ok().map(|o| o.tv).unwrap_or(1)
}

/// Load provider default config from disk: runtime/{id}/config/{id}-default-config.json
pub fn load_provider_defaults(provider_id: &str) -> Option<ProviderTemplate> {
    let app_root = crate::config::app_root_dir();
    let config_path = app_root.join("runtime").join(provider_id).join("config")
        .join(format!("{}-default-config.json", provider_id));

    if !config_path.exists() {
        log::debug!("[template] Default config not found at {}", config_path.display());
        return None;
    }

    let content = match std::fs::read_to_string(&config_path) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[template] Failed to read provider defaults {}: {}", config_path.display(), e);
            return None;
        }
    };

    #[derive(Deserialize)]
    struct DefaultConfig {
        id: String,
        #[allow(dead_code)]
        display_name: String,
        binary_name: String,
        description: String,
        #[allow(dead_code)]
        git_url: String,
        #[allow(dead_code)]
        branch: String,
        #[allow(dead_code)]
        template_type: String,
        #[serde(default)]
        spawn_profile: SpawnProfile,
        params: Vec<ProviderDefaultParam>,
    }

    let cfg = match serde_json::from_str::<DefaultConfig>(&content) {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[template] Invalid provider defaults {}: {}", config_path.display(), e);
            return None;
        }
    };

    if cfg.id != provider_id {
        log::warn!("[template] Provider ID mismatch: expected '{}', got '{}' in {}", provider_id, cfg.id, config_path.display());
    }

    Some(ProviderTemplate {
        binary_name: cfg.binary_name,
        description: cfg.description,
        spawn_profile: cfg.spawn_profile,
        params: cfg.params,
    })
}

/// Resolve global engine stack capacity from provider factory `spawn_profile.max_engine_slots`.
/// Uses the maximum across all discovered runtime providers, clamped to [`crate::config::ABSOLUTE_MAX_ENGINE_SLOTS`].
pub fn resolve_engine_slot_count() -> usize {
    use crate::config::ABSOLUTE_MAX_ENGINE_SLOTS;

    let app_root = crate::config::app_root_dir();
    let binaries_dir = app_root.join("runtime");
    let mut max_slots = 0usize;

    if binaries_dir.exists() {
        for entry in std::fs::read_dir(&binaries_dir).into_iter().flatten().filter_map(|e| e.ok()) {
            if !entry.file_type().map(|ft| ft.is_dir()).unwrap_or(false) {
                continue;
            }
            let pid = entry.file_name().to_string_lossy().to_string();
            if let Some(template) = load_provider_defaults(&pid) {
                let n = template.spawn_profile.max_engine_slots;
                if n > max_slots {
                    log::info!(
                        "[engine-slots] Provider '{}' spawn_profile.max_engine_slots={}",
                        pid,
                        n
                    );
                    max_slots = n;
                }
            }
        }
    }

    if max_slots == 0 {
        max_slots = default_max_engine_slots();
        log::warn!(
            "[engine-slots] No provider spawn_profile found — using default {}",
            max_slots
        );
    }

    let clamped = max_slots.clamp(1, ABSOLUTE_MAX_ENGINE_SLOTS);
    if clamped != max_slots {
        log::warn!(
            "[engine-slots] Requested {} slots — clamped to absolute ceiling {}",
            max_slots,
            ABSOLUTE_MAX_ENGINE_SLOTS
        );
    }
    clamped
}

impl ProviderTemplate {
    pub fn load(provider_id: &str) -> Result<Self, String> {
        load_provider_defaults(provider_id)
            .ok_or_else(|| format!("Provider defaults not found for '{}'. Check runtime/{}/config/{}-default-config.json exists.", provider_id, provider_id, provider_id))
    }

    pub fn template_type_for_id(id: &str) -> String {
        // Try to load from disk defaults first (has explicit template_type field)
        #[derive(Deserialize)]
        struct TypeOnly {
            template_type: String,
        }
        let app_root = crate::config::app_root_dir();
        let config_path = app_root.join("runtime").join(id).join("config")
            .join(format!("{}-default-config.json", id));
        if config_path.exists() {
            if let Ok(content) = std::fs::read_to_string(&config_path) {
                if let Ok(cfg) = serde_json::from_str::<TypeOnly>(&content) {
                    if !cfg.template_type.is_empty() {
                        return cfg.template_type;
                    }
                }
            }
        }
        // Fallback: guess from ID
        if id.to_lowercase().contains("ik") {
            "ik-llama".to_string()
        } else {
            "ggml-llama".to_string()
        }
    }

    /// Get a specific provider template by ID from disk.
    pub fn load_by_id(id: &str) -> Option<Self> {
        load_provider_defaults(id)
    }

    /// Resolve a param value from extra_params override, then user's saved default_value.
    pub fn resolve_param_value(
        config: &EngineConfig,
        param: &crate::types::UserEditedTemplateParam,
    ) -> serde_json::Value {
        let key_lower = param.key.to_lowercase();

        // Priority 1: extra_params (user-selected value at launch time)
        if !config.extra_params.is_empty() {
            if let Some(v) = config.extra_params.iter().find(|(k, _)| k.to_lowercase() == key_lower) {
                return v.1.clone();
            }
        }

        // Priority 2: user's saved default_value (THE value — no further fallback needed)
        if !param.default_value.is_null() {
            return param.default_value.clone();
        }

        serde_json::Value::String(String::new())
    }

    /// Build the full CLI command from user's merged provider config.
    /// Iterates UserEditedTemplateParams — single source of truth after startup merge.
    pub fn build_command(
        &self,
        config: &EngineConfig,
        _gpu_mask: &str,
        user_params: &[crate::types::UserEditedTemplateParam],
    ) -> Vec<String> {
        let mut args = Vec::new();
        let sp = &self.spawn_profile;

        // Model path — provider-owned flag pair from spawn_profile
        if let Some(flag) = sp.model_flag.first() {
            args.extend([flag.clone(), config.model_path.clone()]);
        }

        // Companion mmproj file — inject right after model for clean CMD readability
        let vision_param = user_params.iter().find(|p| p.key == "vision");
        if let Some(vp) = vision_param {
            let vval = Self::resolve_param_value(config, vp);
            let vstr = vval.as_str().unwrap_or("").to_lowercase();
            if matches!(vstr.as_str(), "auto" | "on") {
                if let Some(mmproj_flag) = sp.mmproj_flag.first() {
                    if let Some((mmproj_name, _)) = crate::model_catalog::find_largest_mmproj(
                        std::path::Path::new(&config.model_path).parent().unwrap_or(std::path::Path::new(""))
                    ) {
                        args.extend([mmproj_flag.clone(), mmproj_name]);
                    }
                }
            }
        }

        if let Some(flag) = sp.port_flag.first() {
            args.extend([flag.clone(), config.port.to_string()]);
        }

        // Alias for server API identification — sanitize spaces/commas
        let cli_alias = config.alias.replace(' ', "-").replace(',', "-");
        if !cli_alias.is_empty() {
            if let Some(flag) = sp.alias_flag.first() {
                args.extend([flag.clone(), cli_alias]);
            }
        }

        args.extend(sp.verbosity_args.clone());

        if sp.enable_metrics {
            args.push("--metrics".into());
        }

        // ── TEST MODE (REPLACE): bypass all params, use only raw test flags ───────────
        if let Some(test_args) = config.extra_params.get("__test_args") {
            if let Some(args_arr) = test_args.as_array() {
                for arg in args_arr {
                    if let Some(s) = arg.as_str() {
                        args.push(s.to_string());
                    }
                }
                let full_cmd = format!("{} {}", self.binary_name, args.join(" "));
                // Launch command test now routed to Blackwell Output Console
                let log_path = std::env::temp_dir().join("blackwell-launch.log");
                let _ = std::fs::write(&log_path, &full_cmd);
                return args;
            }
        }

        // ── Iterate user params (sorted by order) — single source of truth ────────────
        let mut sorted_params = user_params.to_vec();
        sorted_params.sort_by(|a, b| a.order.cmp(&b.order));

        for param in &sorted_params {
            if param.hidden { continue; }

            // Resolve value: extra_params override > saved default_value
            let mut value = Self::resolve_param_value(config, param);

            // Auto-repair: if selected value is hidden, use first visible fallback
            let current_str = value.as_str().unwrap_or("");
            if param.is_value_hidden(current_str) {
                if let Some(fallback) = param.effective_default() {
                    log::debug!("[build_cmd] param '{}': value '{}' is hidden — using visible fallback '{}'", param.key, current_str, fallback);
                    value = fallback.clone();
                } else {
                    continue;
                }
            }

            let value_str = value.as_str().map(String::from).unwrap_or(value.to_string());

            // Resolve "auto" from GGUF metadata cache — llama.cpp needs numbers, not "auto"
            let final_value_str = if value_str == "auto" && param.ptype != "path_scanner" {
                match resolve_auto_value(&param.key, &config.model_path) {
                    Some(resolved) => {
                        log::debug!("[build_cmd] resolved auto for '{}': '{}' -> '{}'", param.key, value_str, resolved);
                        resolved
                    }
                    None => {
                        log::debug!("[build_cmd] cannot resolve auto for '{}', skipping flag", param.key);
                        Self::inject_sub_params_user(&mut args, param, &value_str);
                        continue;
                    }
                }
            } else {
                value_str
            };

            // Dispatch by ptype — inject CLI flags
            match param.ptype.as_str() {
                "arg_select" => Self::inject_arg_select_user(&mut args, param, &final_value_str),
                "arg_select_double" => Self::inject_arg_select_double_user(&mut args, param, &final_value_str),
                "slider" => Self::inject_slider_user(&mut args, param, &final_value_str),
                "switch_onoff" => Self::inject_switch_onoff_user(&mut args, param, &final_value_str),
                "switch_inverted" => Self::inject_switch_inverted_user(&mut args, param, &final_value_str),
                "path_scanner" => {
                    if param.key != "vision" {
                        if let Some(path) = Self::scan_path_user(config, param, &final_value_str) {
                            args.extend([param.flag.clone().unwrap_or_default(), path]);
                        }
                    }
                },
                "logic_only" => {},
                _ => { log::debug!("[build_cmd] unknown ptype '{}' for '{}', skipping", param.ptype, param.key); }
            }

            // Inject sub_params — user's saved state is authoritative
            Self::inject_sub_params_user(&mut args, param, &final_value_str);
        }

        // n_gpu_layers injection — computed by VRAM scenario factory at runtime.
        if let Some(ngl) = config.extra_params.get("__ngl") {
            if let Some(flag) = sp.ngl_flag.first() {
                let ngl_str = ngl.as_str().map(String::from).unwrap_or(ngl.to_string());
                args.extend([flag.clone(), ngl_str]);
            }
        }

        // ── TEST MODE (ADD): append raw test flags after all params ────────────────────
        if let Some(test_args_add) = config.extra_params.get("__test_args_add") {
            if let Some(args_arr) = test_args_add.as_array() {
                for arg in args_arr {
                    if let Some(s) = arg.as_str() {
                        args.push(s.to_string());
                    }
                }
            }
        }

        normalize_ik_cli_args(&mut args);

        if !config.model_path.is_empty() {
            let full_cmd = format!("{} {}", self.binary_name, args.join(" "));
            // Launch command now routed to Blackwell Output Console

            let log_path = std::env::temp_dir().join("blackwell-launch.log");
            if let Err(e) = std::fs::write(&log_path, &full_cmd) {
                log::warn!("[LAUNCH_CMD] Failed to write log: {}", e);
            }
        }

        args
    }

    // ── Inject functions for UserEditedTemplateParam (user params are source of truth) ─

    fn inject_arg_select_user(args: &mut Vec<String>, param: &crate::types::UserEditedTemplateParam, value: &str) {
        if let Some(flag) = &param.flag {
            args.extend([flag.clone(), value.to_string()]);
        }
    }

    fn inject_arg_select_double_user(args: &mut Vec<String>, param: &crate::types::UserEditedTemplateParam, value: &str) {
        for flag in &param.flag_pair {
            args.extend([flag.clone(), value.to_string()]);
        }
    }

    /// Slider values are already numeric — pass directly to CLI (same as arg_select).
    fn inject_slider_user(args: &mut Vec<String>, param: &crate::types::UserEditedTemplateParam, value: &str) {
        if let Some(flag) = &param.flag {
            args.extend([flag.clone(), value.to_string()]);
        }
    }

    fn inject_switch_onoff_user(args: &mut Vec<String>, param: &crate::types::UserEditedTemplateParam, value: &str) {
        if value.to_lowercase() == "on" {
            if let Some(flag) = &param.flag { args.push(flag.clone()); }
        }
    }

    fn inject_switch_inverted_user(args: &mut Vec<String>, param: &crate::types::UserEditedTemplateParam, value: &str) {
        if value.to_lowercase() == "off" {
            if let Some(flag) = &param.flag { args.push(flag.clone()); }
        }
    }

    fn scan_path_user(config: &EngineConfig, param: &crate::types::UserEditedTemplateParam, value: &str) -> Option<String> {
        let val_lower = value.to_lowercase();
        if !matches!(val_lower.as_str(), "auto" | "on") { return None; }

        let model_dir = PathBuf::from(&config.model_path);
        let parent = model_dir.parent()?;
        let entries = std::fs::read_dir(parent).ok()?;

        for entry in entries.flatten() {
            let fname = entry.file_name();
            let fname_lower = fname.to_string_lossy().to_lowercase();
            if Self::matches_pattern(&fname_lower, &param.pattern) {
                return Some(fname.to_string_lossy().to_string());
            }
        }
        None
    }

    /// Inject sub_params from user's saved state (authoritative — no defaults fallback).
    fn inject_sub_params_user(
        args: &mut Vec<String>,
        param: &crate::types::UserEditedTemplateParam,
        value: &str,
    ) {
        if let Some(ref sp) = param.sub_params {
            if let Some(entry_args) = sp.get(value) {
                for arg in entry_args { args.push(arg.clone()); }
            }
        }
    }

    fn matches_pattern(filename: &str, pattern: &str) -> bool {
        let pat_lower = pattern.to_lowercase();

        // Handle glob-style wildcard patterns (e.g., "*.gguf", "*mmproj*")
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

}

/// IK llama.cpp flags that were previously emitted as `-flag 0|1` but are now boolean-only.
fn normalize_ik_cli_args(args: &mut Vec<String>) {
    if !args.iter().any(|a| {
        matches!(
            a.as_str(),
            "-sas" | "-khad" | "-vhad" | "-smf16" | "-smf32" | "-dio"
        )
    }) {
        return;
    }

    const BOOL_FLAGS: &[&str] = &["-sas", "-gr", "-khad", "-vhad", "-smf16", "-smf32", "-no-gr"];

    let mut out = Vec::with_capacity(args.len());
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].as_str();

        if arg == "-dio" {
            out.push("--simple-io".into());
            i += 1;
            continue;
        }

        if arg == "--split-mode" && i + 1 < args.len() && args[i + 1] == "row" {
            out.push(args[i].clone());
            out.push("graph".into());
            i += 2;
            continue;
        }

        if BOOL_FLAGS.contains(&arg) && i + 1 < args.len() && (args[i + 1] == "0" || args[i + 1] == "1") {
            let val = args[i + 1].as_str();
            if arg == "-smf16" {
                if val == "1" {
                    out.push("-smf16".into());
                } else {
                    out.push("-smf32".into());
                }
            } else if val == "1" {
                out.push(args[i].clone());
            }
            i += 2;
            continue;
        }

        out.push(args[i].clone());
        i += 1;
    }

    *args = out;
}

#[cfg(test)]
mod tests {
    use super::normalize_ik_cli_args;

    fn norm(input: &[&str]) -> Vec<String> {
        let mut args: Vec<String> = input.iter().map(|s| s.to_string()).collect();
        normalize_ik_cli_args(&mut args);
        args
    }

    #[test]
    fn ik_normalize_strips_legacy_bool_values() {
        let out = norm(&[
            "-sas", "1", "-gr", "1", "-khad", "1", "-vhad", "1", "-mla", "3", "-smf16", "1",
        ]);
        assert_eq!(
            out,
            vec![
                "-sas", "-gr", "-khad", "-vhad", "-mla", "3", "-smf16",
            ]
        );
    }

    #[test]
    fn ik_normalize_balanced_profile() {
        let out = norm(&["-sas", "0", "-gr", "1", "-khad", "0", "-vhad", "0", "-mla", "1"]);
        assert_eq!(out, vec!["-gr", "-mla", "1"]);
    }

    #[test]
    fn ik_normalize_smf16_zero_maps_to_smf32() {
        let out = norm(&["-smf16", "0"]);
        assert_eq!(out, vec!["-smf32"]);
    }

    #[test]
    fn ik_normalize_dio_maps_to_simple_io() {
        let out = norm(&["-fa", "on", "-dio"]);
        assert_eq!(out, vec!["-fa", "on", "--simple-io"]);
    }

    #[test]
    fn ik_normalize_skips_non_ik_commands() {
        let mut args = vec!["--port".into(), "8080".into(), "-gr".into(), "1".into()];
        normalize_ik_cli_args(&mut args);
        assert_eq!(args, vec!["--port", "8080", "-gr", "1"]);
    }
}
