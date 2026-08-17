//! Provider Template System — data-driven CLI command generation.
//!
//! ProviderDefaultParam = schema for provider default configs on disk (read-only).
//! UserEditedTemplateParam = user's saved copy with runtime state (hidden, hiddenValues, etc.).
//! The build_command function iterates user params to construct the full argument list
//! without any hardcoded flag logic. Adding a new backend requires adding a provider folder to runtime/.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
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
    /// Extra verbosity flags (e.g. ggml: `["-lv","4"]`; IK: `["--verbose"]`).
    #[serde(default)]
    pub verbosity_args: Vec<String>,
    /// Value-less flags injected at launch (e.g. IK: `["--fit"]`).
    #[serde(default)]
    pub spawn_flags: Vec<String>,
    /// Borrow `llama-fit-params.exe` from this provider when absent beside our server binary (e.g. IK → `ggml-master`).
    #[serde(default)]
    pub fit_binary_provider: String,
    #[serde(default = "default_true")]
    pub enable_metrics: bool,
    #[serde(default = "default_true")]
    pub supports_fusion: bool,
    /// Fusion metrics adapter id (`ggml_master` | `ggml_tom`). Empty = auto from provider id.
    #[serde(default)]
    pub fusion_adapter: String,
    /// FIT scanner adapter id (`ggml_master` | `ggml_tom`). Empty = auto from provider id.
    #[serde(default)]
    pub fit_adapter: String,
    #[serde(default = "default_gpu_env")]
    pub gpu_env: String,
    #[serde(default = "default_ngl_flag")]
    pub ngl_flag: Vec<String>,
    #[serde(default = "default_mmproj_flag")]
    pub mmproj_flag: Vec<String>,
    /// Max concurrent engine slots when this provider is installed (global stack uses the highest value across all providers).
    #[serde(default = "default_max_engine_slots")]
    pub max_engine_slots: usize,
    /// Max leading whitespace before a `--help` flag line is treated as a catalog entry.
    /// GGML-style help uses column-0 flags (0). IK-style help indents flags (typically 2–9).
    #[serde(default = "default_help_flag_max_indent")]
    pub help_flag_max_indent: u8,
    /// Auto VRAM mode for non-power-users — simplified engine config UI.
    #[serde(default)]
    pub auto_vram: bool,
    /// `ggml_fit_params` (--fit on + --fit-ctx) | `none`
    #[serde(default)]
    pub fit_style: String,
    /// Param keys shown in Auto VRAM mode.
    #[serde(default)]
    pub simple_param_keys: Vec<String>,
    /// Param keys shown in Essentials view (engine config panel filter).
    #[serde(default, rename = "essentialParamKeys")]
    pub essential_param_keys: Vec<String>,
    /// When false, UI omits tensor/row from SPLIT chips (provider lacks stable tensor+FIT).
    #[serde(default = "default_true")]
    pub tensor_split: bool,
}

fn default_model_flag() -> Vec<String> { vec!["-m".into()] }
fn default_port_flag() -> Vec<String> { vec!["--port".into()] }
fn default_alias_flag() -> Vec<String> { vec!["--alias".into()] }
fn default_gpu_env() -> String { "CUDA_VISIBLE_DEVICES".into() }
fn default_ngl_flag() -> Vec<String> { vec!["--n-gpu-layers".into()] }
fn default_mmproj_flag() -> Vec<String> { vec!["--mmproj".into()] }
fn default_true() -> bool { true }
fn default_max_engine_slots() -> usize { 32 }
fn default_help_flag_max_indent() -> u8 { 0 }

impl Default for SpawnProfile {
    fn default() -> Self {
        Self {
            model_flag: default_model_flag(),
            port_flag: default_port_flag(),
            alias_flag: default_alias_flag(),
            // Product default: -lv 3 keeps print_timing / draft / eval belt without tokenizer KV spam.
            // Cockpit can raise to 4 via __log_verbosity (see build_command).
            verbosity_args: vec!["-lv".into(), "3".into()],
            spawn_flags: Vec::new(),
            fit_binary_provider: String::new(),
            enable_metrics: true,
            supports_fusion: true,
            fusion_adapter: String::new(),
            fit_adapter: String::new(),
            gpu_env: default_gpu_env(),
            ngl_flag: default_ngl_flag(),
            mmproj_flag: default_mmproj_flag(),
            max_engine_slots: default_max_engine_slots(),
            help_flag_max_indent: default_help_flag_max_indent(),
            auto_vram: false,
            fit_style: String::new(),
            simple_param_keys: Vec::new(),
            essential_param_keys: Vec::new(),
            tensor_split: true,
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
    /// Values hidden only in engine Essentials / Full Auto cockpit (Full Assisted still shows).
    #[serde(
        default,
        rename = "essentialsHiddenValues",
        skip_serializing_if = "Vec::is_empty"
    )]
    pub essentials_hidden_values: Vec<serde_json::Value>,
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

fn factory_default_config_path(provider_id: &str) -> std::path::PathBuf {
    crate::config::app_root_dir()
        .join("runtime")
        .join(provider_id)
        .join("config")
        .join(format!("{provider_id}-default-config.json"))
}

/// Read factory `groupOrder` + `layoutDefaults` + `protectedGroups` from default config JSON.
pub fn load_factory_layout_supplement(
    provider_id: &str,
) -> (Vec<String>, crate::types::LayoutDefaults, Vec<String>) {
    let path = factory_default_config_path(provider_id);
    if !path.exists() {
        return (Vec::new(), crate::types::LayoutDefaults::default(), Vec::new());
    }
    let content = match std::fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return (Vec::new(), crate::types::LayoutDefaults::default(), Vec::new()),
    };
    #[derive(Deserialize, Default)]
    struct Supplement {
        #[serde(default, rename = "groupOrder")]
        group_order: Vec<String>,
        #[serde(default, rename = "layoutDefaults")]
        layout_defaults: crate::types::LayoutDefaults,
        #[serde(default, rename = "protectedGroups")]
        protected_groups: Vec<String>,
    }
    match serde_json::from_str::<Supplement>(&content) {
        Ok(s) => (s.group_order, s.layout_defaults, s.protected_groups),
        Err(_) => (Vec::new(), crate::types::LayoutDefaults::default(), Vec::new()),
    }
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
    log::info!("[engine-slots] Global engine stack capacity = {}", clamped);
    clamped
}

/// Per-provider spawn_profile belt when factory JSON is stale (dev user configs without re-sync).
fn apply_spawn_profile_overrides(provider_id: &str, tmpl: &mut ProviderTemplate) {
    if provider_id != "ggml-tom" {
        return;
    }
    let tom_verbosity = vec!["-lv".to_string(), "3".to_string()];
    if tmpl.spawn_profile.verbosity_args != tom_verbosity {
        tmpl.spawn_profile.verbosity_args = vec!["-lv".to_string(), "3".to_string()];
    }
    if tmpl.spawn_profile.fusion_adapter.is_empty() {
        tmpl.spawn_profile.fusion_adapter = "ggml_tom".into();
    }
    if tmpl.spawn_profile.fit_adapter.is_empty() {
        tmpl.spawn_profile.fit_adapter = "ggml_tom".into();
    }
}

/// Cockpit / launch override: `extra_params.__log_verbosity` = 3 or 4.
/// Rewrites existing `-lv N` (or `--verbosity N`) pairs; no-op when the provider has no lv-style args.
fn apply_log_verbosity_override(args: &mut Vec<String>, config: &EngineConfig) {
    let lv = config
        .extra_params
        .get("__log_verbosity")
        .and_then(|v| {
            v.as_u64()
                .or_else(|| v.as_i64().map(|i| i as u64))
                .or_else(|| v.as_str().and_then(|s| s.trim().parse().ok()))
        })
        .unwrap_or(0);
    if lv != 3 && lv != 4 {
        return;
    }
    let lv_s = lv.to_string();
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "-lv" || a == "--verbosity" {
            if i + 1 < args.len() {
                args[i + 1] = lv_s;
            } else {
                args.push(lv_s);
            }
            return;
        }
        i += 1;
    }
    // Don't invent -lv for providers that never shipped verbosity_args.
}

impl ProviderTemplate {
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
        // Fallback: GGML family
        "ggml-llama".to_string()
    }

    /// Minimal spawn shell for custom providers (no factory JSON): model/port/alias only.
    /// No verbosity, metrics, FIT, or master param catalog — user owns the param set.
    pub fn bare_custom_shell() -> Self {
        Self {
            binary_name: "llama-server.exe".into(),
            description: "Custom provider (manual params)".into(),
            spawn_profile: SpawnProfile {
                model_flag: default_model_flag(),
                port_flag: default_port_flag(),
                alias_flag: default_alias_flag(),
                verbosity_args: Vec::new(),
                spawn_flags: Vec::new(),
                fit_binary_provider: String::new(),
                enable_metrics: false,
                supports_fusion: false,
                fusion_adapter: String::new(),
                fit_adapter: String::new(),
                gpu_env: default_gpu_env(),
                ngl_flag: default_ngl_flag(),
                mmproj_flag: default_mmproj_flag(),
                max_engine_slots: default_max_engine_slots(),
                help_flag_max_indent: default_help_flag_max_indent(),
                auto_vram: false,
                fit_style: String::new(),
                simple_param_keys: Vec::new(),
                essential_param_keys: Vec::new(),
                tensor_split: true,
            },
            params: Vec::new(),
        }
    }

    /// Apply custom-provider capability toggles onto a bare spawn profile.
    pub fn apply_custom_capabilities(
        sp: &mut SpawnProfile,
        caps: &crate::types::CustomProviderCapabilities,
    ) {
        sp.supports_fusion = caps.fusion;
        // Respect an explicit adapter (e.g. `ggml_quiet` for silent server builds); otherwise
        // default custom providers to the full master log belt.
        if caps.fusion && !caps.fusion_adapter.trim().is_empty() {
            sp.fusion_adapter = caps.fusion_adapter.trim().to_string();
        } else if caps.fusion && sp.fusion_adapter.is_empty() {
            sp.fusion_adapter = "ggml_master".into();
        }
        sp.enable_metrics = caps.metrics;
        if caps.verbose {
            let raw = if caps.verbose_args.trim().is_empty() {
                "-lv 3"
            } else {
                caps.verbose_args.trim()
            };
            sp.verbosity_args = raw
                .split_whitespace()
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
                .collect();
        } else {
            sp.verbosity_args.clear();
        }
    }

    /// Load template for CLI launch.
    /// Factory providers: their JSON (+ spawn overrides). No silent fallback to master flags.
    /// Missing factory → bare custom shell + optional user capability toggles from meta.
    pub fn load_for_provider(provider_id: &str) -> Result<Self, String> {
        if let Some(mut tmpl) = load_provider_defaults(provider_id) {
            apply_spawn_profile_overrides(provider_id, &mut tmpl);
            return Ok(tmpl);
        }
        // Custom / unknown id: do NOT inherit ggml-master -lv/--metrics/params.
        log::info!(
            "[template] No factory defaults for '{}' — using bare custom launch shell",
            provider_id
        );
        let mut shell = Self::bare_custom_shell();
        if let Some(meta) = crate::config::load_user_providers_meta()
            .into_iter()
            .find(|m| m.id == provider_id)
        {
            Self::apply_custom_capabilities(&mut shell.spawn_profile, &meta.custom_capabilities);
        }
        Ok(shell)
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
        // Cockpit LV 3/4 toggle (and any future launch override). Only rewrites `-lv N` tokens.
        apply_log_verbosity_override(&mut args, config);

        // Auto VRAM launch — frontend sets extra_params.__auto_vram; power users can disable.
        let auto_vram_launch = config
            .extra_params
            .get("__auto_vram")
            .and_then(|v| v.as_bool())
            .unwrap_or(false);

        let moe_optimal_launch = extra_param_eq_ignore_ascii(config, "offload_mode", "moe_optimal");
        let external_draft_spec = external_draft_spec_needs_fit_off(config);

        if auto_vram_launch {
            if moe_optimal_launch || external_draft_spec {
                // MOE_OPTIMAL owns expert placement — --fit on fights eviction/tensor offload strategy.
                // External draft specs (dflash/eagle3/…) probe draft VRAM before ctx_other exists — hard-fail.
                args.extend(["--fit".into(), "off".into()]);
            } else {
                args.extend(sp.spawn_flags.clone());
                if sp.fit_style.as_str() == "ggml_fit_params" {
                    let ctx = resolve_launch_ctx_tokens(config, user_params);
                    args.extend(["--fit".into(), "on".into()]);
                    args.extend(["--fit-ctx".into(), ctx.to_string()]);
                }
            }
        }

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
                finalize_launch_cli_args(&mut args);
                #[cfg(debug_assertions)]
                {
                    let full_cmd = format!("{} {}", self.binary_name, args.join(" "));
                    let log_path = std::env::temp_dir().join("blackwell-launch.log");
                    let _ = std::fs::write(&log_path, &full_cmd);
                }
                return args;
            }
        }

        // ── Iterate user params (sorted by order) — single source of truth ────────────
        // Spec profile / CLI flags always emit last so they group together on the CLI.
        let mut sorted_params = user_params.to_vec();
        sorted_params.sort_by(|a, b| {
            let is_spec = |p: &crate::types::UserEditedTemplateParam| {
                let g = p.ui_group.as_str();
                g.eq_ignore_ascii_case("SPECULATIVE-MTP")
                    || g.eq_ignore_ascii_case("SPECULATIVE-DFLASH")
                    || g.eq_ignore_ascii_case("SPECULATIVE-DECODING")
                    || p.key.starts_with("mtp_")
                    || p.key.starts_with("dflash_")
                    || p.key.eq_ignore_ascii_case("spec_type")
                    || p.key.starts_with("spec_draft")
            };
            match (is_spec(a), is_spec(b)) {
                (false, true) => std::cmp::Ordering::Less,
                (true, false) => std::cmp::Ordering::Greater,
                _ => a.order.cmp(&b.order),
            }
        });

        for param in &sorted_params {
            let key_in_extra = config
                .extra_params
                .keys()
                .any(|k| k.eq_ignore_ascii_case(&param.key));

            // Hidden params are skipped unless launch explicitly overrides via extra_params
            // (e.g. cockpit parallel). Profile knobs (mtp_*/dflash_*) that the user hid must
            // never re-enter CLI just because Boost put a stale value in extra_params.
            let is_draft_key = param.key.eq_ignore_ascii_case("spec_draft_model")
                || param.key.eq_ignore_ascii_case("dflash_draft_model");
            let is_spec_profile_knob = param.key.starts_with("mtp_")
                || param.key.starts_with("dflash_");
            if param.hidden {
                if is_spec_profile_knob && !is_draft_key {
                    continue;
                }
                if !is_draft_key && !key_in_extra {
                    continue;
                }
            }

            // Whitelist launch — AUTO_FIT always; MANUAL when frontend sent a filtered extra_params
            // set (Essentials vs Full). Without user keys in extra_params, emit all visible params.
            if launch_uses_extra_params_whitelist(config) {
                if !key_in_extra {
                    continue;
                }
            }

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
                "logic_only" => {
                    // Draft path: legacy key or profile key `dflash_draft_model`
                    let is_draft_key = param.key.eq_ignore_ascii_case("spec_draft_model")
                        || param.key.eq_ignore_ascii_case("dflash_draft_model");
                    if is_draft_key {
                        let st = config.get_param_str("spec_type").unwrap_or_default();
                        if crate::spec_draft::spec_type_needs_external_draft(&st) {
                            Self::inject_spec_draft_model_user(
                                &mut args,
                                param,
                                &config.model_path,
                                &final_value_str,
                            );
                        }
                    }
                },
                _ => { log::debug!("[build_cmd] unknown ptype '{}' for '{}', skipping", param.ptype, param.key); }
            }

            // Inject sub_params — user's saved state is authoritative
            Self::inject_sub_params_user(&mut args, param, &final_value_str);
        }

        // --spec-type from launch payload (no template row after profile rewrite)
        if !args.iter().any(|a| a == "--spec-type") {
            if let Some(st) = config.get_param_str("spec_type") {
                let t = st.trim();
                if !t.is_empty() && !t.eq_ignore_ascii_case("none") {
                    args.extend(["--spec-type".into(), t.to_string()]);
                }
            }
        }

        // Picker-driven draft path — profile or legacy key in extra_params
        if external_draft_spec
            && !args.iter().any(|a| a == "--spec-draft-model")
        {
            let draft_val = config
                .get_param_str("dflash_draft_model")
                .or_else(|| config.get_param_str("spec_draft_model"));
            if let Some(draft_val) = draft_val {
                let spec_lower = config
                    .get_param_str("spec_type")
                    .unwrap_or_default()
                    .to_lowercase();
                let pattern = if spec_lower.contains("eagle3") {
                    "*eagle3*"
                } else if spec_lower.contains("dspark") {
                    "*dspark*"
                } else {
                    "*dflash*"
                };
                if let Some(path) = crate::spec_draft::resolve_spec_draft_model_path(
                    &config.model_path,
                    &draft_val,
                    pattern,
                ) {
                    args.extend(["--spec-draft-model".into(), path]);
                } else if draft_val.to_lowercase().ends_with(".gguf")
                    && std::path::Path::new(&draft_val).is_file()
                {
                    args.extend(["--spec-draft-model".into(), draft_val]);
                }
            }
        }

        // Belt-and-suspenders: emit n-max/n-min/p-min from extra if template rows were skipped.
        // Never resurrect a row the user hid in Config (hidden / user_hidden).
        for (key, flag) in [
            ("spec_draft_n_max", "--spec-draft-n-max"),
            ("spec_draft_n_min", "--spec-draft-n-min"),
            ("spec_draft_p_min", "--spec-draft-p-min"),
            ("mtp_n_max", "--spec-draft-n-max"),
            ("mtp_n_min", "--spec-draft-n-min"),
            ("mtp_p_min", "--spec-draft-p-min"),
            ("dflash_n_max", "--spec-draft-n-max"),
            ("dflash_n_min", "--spec-draft-n-min"),
            ("dflash_p_min", "--spec-draft-p-min"),
        ] {
            if args.iter().any(|a| a == flag) {
                continue;
            }
            if let Some(param) = user_params
                .iter()
                .find(|p| p.key.eq_ignore_ascii_case(key))
            {
                if param.hidden || param.user_hidden {
                    continue;
                }
            }
            if let Some(v) = config
                .extra_params
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
                .map(|(_, v)| v)
            {
                let s = v.as_str().map(String::from).unwrap_or_else(|| {
                    if let Some(n) = v.as_f64() {
                        // Keep integers clean (3 not 3.0)
                        if (n - n.trunc()).abs() < f64::EPSILON {
                            format!("{}", n as i64)
                        } else {
                            format!("{}", n)
                        }
                    } else {
                        v.to_string()
                    }
                });
                if !s.is_empty() && s != "null" {
                    args.extend([flag.to_string(), s]);
                }
            }
        }

        // n_gpu_layers injection — computed by VRAM scenario factory at runtime.
        // Skip when Auto VRAM launch handles offload (--fit / --fit on).
        let fit_handles_offload =
            auto_vram_launch && !moe_optimal_launch && sp.fit_style.as_str() == "ggml_fit_params";
        if !fit_handles_offload {
            if let Some(ngl) = config.extra_params.get("__ngl") {
                if let Some(flag) = sp.ngl_flag.first() {
                    let ngl_str = ngl.as_str().map(String::from).unwrap_or(ngl.to_string());
                    args.extend([flag.clone(), ngl_str]);
                }
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
        // X3D / CCD pin: compute CCD, physical cores, modest -t (ggml/llama only).
        // Skip when user already set cpu-mask/range or __cpu_affinity=off.
        if provider_supports_cpu_mask(self) {
            crate::cpu_topology::apply_to_launch_args(&mut args, config);
        }

        // Desktop default: llama-server warns when CORS is * (default) with no API key.
        // Localhost reflection is enough for the app / local agents.
        if !args.iter().any(|a| a == "--cors-origins") {
            args.extend([
                "--cors-origins".into(),
                "localhost".into(),
            ]);
        }

        finalize_launch_cli_args(&mut args);

        #[cfg(debug_assertions)]
        if !config.model_path.is_empty() {
            let full_cmd = format!("{} {}", self.binary_name, args.join(" "));
            let log_path = std::env::temp_dir().join("blackwell-launch.log");
            if let Err(e) = std::fs::write(&log_path, &full_cmd) {
                log::warn!("[LAUNCH_CMD] Failed to write log: {}", e);
            }
        }

        args
    }

    // ── Inject functions for UserEditedTemplateParam (user params are source of truth) ─

    fn inject_arg_select_user(args: &mut Vec<String>, param: &crate::types::UserEditedTemplateParam, value: &str) {
        let val_lower = value.to_lowercase();
        // Omit --split-mode when split is inactive (matches fit scanner / manual solo-GPU path).
        if param.key.eq_ignore_ascii_case("split")
            && (val_lower.is_empty() || val_lower == "none")
        {
            return;
        }
        // When this value carries sub_params, only those args go to CLI — omit parent flag+value.
        if Self::value_has_nonempty_sub_params(param, value) {
            return;
        }
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

    fn inject_spec_draft_model_user(
        args: &mut Vec<String>,
        param: &crate::types::UserEditedTemplateParam,
        model_path: &str,
        value: &str,
    ) {
        if let Some(path) = crate::spec_draft::resolve_spec_draft_model_path(model_path, value, &param.pattern) {
            let flag = param.flag.clone().unwrap_or_else(|| "--spec-draft-model".into());
            args.extend([flag, path]);
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

    fn sub_params_entry<'a>(
        sp: &'a HashMap<String, Vec<String>>,
        value: &str,
    ) -> Option<&'a Vec<String>> {
        if let Some(entry) = sp.get(value) {
            return Some(entry);
        }
        sp.iter()
            .find(|(k, _)| k.eq_ignore_ascii_case(value))
            .map(|(_, v)| v)
    }

    fn value_has_nonempty_sub_params(
        param: &crate::types::UserEditedTemplateParam,
        value: &str,
    ) -> bool {
        param
            .sub_params
            .as_ref()
            .and_then(|sp| Self::sub_params_entry(sp, value))
            .is_some_and(|args| !args.is_empty())
    }

    /// Merge argv tokens split by naive whitespace inside quoted values (legacy sub_params saves).
    fn repair_quoted_arg_fragments(entry_args: &[String]) -> Vec<String> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < entry_args.len() {
            let arg = &entry_args[i];
            let starts_quoted = arg.starts_with('"') && !arg.ends_with('"');
            if starts_quoted {
                let mut parts = vec![arg.trim_start_matches('"').to_string()];
                i += 1;
                while i < entry_args.len() && !entry_args[i].ends_with('"') {
                    parts.push(entry_args[i].clone());
                    i += 1;
                }
                if i < entry_args.len() {
                    parts.push(entry_args[i].trim_end_matches('"').to_string());
                    i += 1;
                }
                out.push(parts.join(" "));
            } else {
                out.push(arg.clone());
                i += 1;
            }
        }
        out
    }

    /// Inject sub_params from user's saved state (authoritative — no defaults fallback).
    fn inject_sub_params_user(
        args: &mut Vec<String>,
        param: &crate::types::UserEditedTemplateParam,
        value: &str,
    ) {
        if let Some(ref sp) = param.sub_params {
            if let Some(entry_args) = Self::sub_params_entry(sp, value) {
                for arg in Self::repair_quoted_arg_fragments(entry_args) {
                    args.push(arg);
                }
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

fn flag_pair_value<'a>(args: &'a [String], flag: &str) -> Option<&'a str> {
    let mut last = None;
    let mut i = 0;
    while i + 1 < args.len() {
        if args[i] == flag {
            last = Some(args[i + 1].as_str());
            i += 2;
        } else {
            i += 1;
        }
    }
    last
}

fn remove_all_flag_pairs(args: &mut Vec<String>, flag: &str) {
    let mut i = 0;
    while i < args.len() {
        if args.get(i).map(|s| s.as_str()) == Some(flag) && i + 1 < args.len() {
            args.remove(i + 1);
            args.remove(i);
        } else {
            i += 1;
        }
    }
}

/// Keep only the last `--flag value` occurrence — later custom flags win over auto-VRAM defaults.
fn dedupe_flag_pair_last_wins(args: &mut Vec<String>, flag: &str) {
    let Some(value) = flag_pair_value(args, flag).map(|s| s.to_string()) else {
        return;
    };
    remove_all_flag_pairs(args, flag);
    args.push(flag.to_string());
    args.push(value);
}

fn provider_supports_cpu_mask(template: &ProviderTemplate) -> bool {
    let fa = template.spawn_profile.fusion_adapter.to_ascii_lowercase();
    let fit = template.spawn_profile.fit_adapter.to_ascii_lowercase();
    // Factory ggml providers set these. Bare test templates / non-ggml custom stay unpinned.
    fa.contains("ggml") || fit.contains("ggml")
}

/// Collapse duplicate paired flags; drop `--fit-ctx` when final `--fit` is `off`.
fn finalize_launch_cli_args(args: &mut Vec<String>) {
    dedupe_flag_pair_last_wins(args, "--fit");
    if flag_pair_value(args, "--fit")
        .map(|v| v.eq_ignore_ascii_case("off"))
        .unwrap_or(false)
    {
        remove_all_flag_pairs(args, "--fit-ctx");
    }
}

/// Resolve user ctx for `--fit-ctx` from extra_params or saved user params.
fn resolve_launch_ctx_tokens(
    config: &EngineConfig,
    user_params: &[crate::types::UserEditedTemplateParam],
) -> usize {
    if let Some(v) = config.extra_params.get("ctx") {
        if let Some(n) = v.as_u64() {
            return n as usize;
        }
        if let Some(s) = v.as_str() {
            return parse_ctx_token_str(s);
        }
    }
    for p in user_params {
        if p.key == "ctx" && !p.default_value.is_null() {
            if let Some(n) = p.default_value.as_u64() {
                return n as usize;
            }
            if let Some(s) = p.default_value.as_str() {
                return parse_ctx_token_str(s);
            }
        }
    }
    32768
}

fn parse_ctx_token_str(raw: &str) -> usize {
    let s = raw.trim().to_lowercase();
    if let Some(num) = s.strip_suffix('k') {
        return num.parse::<usize>().unwrap_or(32) * 1024;
    }
    if let Some(num) = s.strip_suffix('m') {
        return num.parse::<usize>().unwrap_or(1) * 1024 * 1024;
    }
    s.parse::<usize>().unwrap_or(32768)
}

fn spec_types_in_launch(config: &EngineConfig) -> Vec<String> {
    let mut types = Vec::new();
    if let Some(t) = config.get_param_str("spec_type") {
        let trimmed = t.trim();
        if !trimmed.is_empty() && !trimmed.eq_ignore_ascii_case("none") {
            types.push(trimmed.to_string());
        }
    }
    for key in ["__test_args", "__test_args_add"] {
        let Some(arr) = config.extra_params.get(key).and_then(|v| v.as_array()) else {
            continue;
        };
        let items: Vec<&str> = arr.iter().filter_map(|v| v.as_str()).collect();
        for w in items.windows(2) {
            if matches!(w[0], "--spec-type" | "-spec-type") {
                types.push(w[1].to_string());
            }
        }
    }
    types
}

/// Draft models loaded from `--spec-draft-model` (dflash, eagle3, …) need the target ctx first.
/// llama-server's `--fit on` path probes draft memory without `ctx_other` and aborts load.
fn external_draft_spec_needs_fit_off(config: &EngineConfig) -> bool {
    let has_draft_model_flag = config
        .extra_params
        .keys()
        .any(|k| k.eq_ignore_ascii_case("spec_draft_model"))
        || config.get_param_str("spec_draft_model").is_some_and(|s| !s.trim().is_empty())
        || launch_args_contain_flag(config, "--spec-draft-model")
        || launch_args_contain_flag(config, "--model-draft");

    for spec in spec_types_in_launch(config) {
        let lower = spec.to_lowercase();
        if lower.contains("dflash") || lower.contains("eagle3") || lower.contains("dspark") {
            return true;
        }
        // MTP reuses the target weights — fit probe skips full draft-model load.
        if lower == "draft-mtp" {
            continue;
        }
        if lower.starts_with("draft-") && has_draft_model_flag {
            return true;
        }
    }
    false
}

fn launch_args_contain_flag(config: &EngineConfig, flag: &str) -> bool {
    for key in ["__test_args", "__test_args_add"] {
        let Some(arr) = config.extra_params.get(key).and_then(|v| v.as_array()) else {
            continue;
        };
        if arr.iter().any(|v| v.as_str() == Some(flag)) {
            return true;
        }
    }
    false
}

fn extra_param_eq_ignore_ascii(config: &EngineConfig, key: &str, expected: &str) -> bool {
    config
        .extra_params
        .get(key)
        .and_then(|v| v.as_str())
        .is_some_and(|s| s.eq_ignore_ascii_case(expected))
}

/// AUTO_FIT always whitelists; MANUAL whitelists when extra_params carries user param keys.
fn launch_uses_extra_params_whitelist(config: &EngineConfig) -> bool {
    if config
        .extra_params
        .get("__auto_vram")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        return true;
    }
    config
        .extra_params
        .keys()
        .any(|k| !k.starts_with("__"))
}

#[cfg(test)]
mod build_cmd_tests {
    use super::*;
    use std::collections::HashMap;

    fn sample_template() -> ProviderTemplate {
        ProviderTemplate {
            binary_name: "llama-server.exe".to_string(),
            description: "test".to_string(),
            spawn_profile: SpawnProfile {
                fit_style: "none".to_string(),
                enable_metrics: false,
                ..Default::default()
            },
            params: Vec::new(),
        }
    }

    fn arg_param(key: &str, flag: &str, default: &str) -> crate::types::UserEditedTemplateParam {
        crate::types::UserEditedTemplateParam {
            key: key.to_string(),
            label: key.to_string(),
            values: vec![serde_json::json!(default)],
            order: 0,
            hidden: false,
            user_hidden: false,
            hidden_values: Vec::new(),
            essentials_hidden_values: Vec::new(),
            flag: Some(flag.to_string()),
            flag_pair: Vec::new(),
            ptype: "arg_select".to_string(),
            step: None,
            ui_group: "CORE".to_string(),
            note: String::new(),
            pattern: String::new(),
            default_value: serde_json::json!(default),
            user_added_values: Vec::new(),
            factory_default: serde_json::json!(default),
            sub_params: None,
            dock: String::new(),
            essential: None,
        }
    }

    #[test]
    fn manual_whitelist_skips_params_missing_from_extra_params() {
        let mut ctx = arg_param("ctx", "--ctx-size", "32768");
        ctx.order = 0;
        let mut batch = arg_param("batch", "--batch-size", "2048");
        batch.order = 1;

        let mut extra = HashMap::new();
        extra.insert("ctx".to_string(), serde_json::json!("32768"));

        let config = EngineConfig {
            alias: "test".to_string(),
            model_path: "model.gguf".to_string(),
            port: 8080,
            backend_type: "ggml-master".to_string(),
            binary_profile: String::new(),
            extra_params: extra,
        };

        let args = sample_template().build_command(&config, "", &[ctx, batch]);
        let joined = args.join(" ");
        assert!(joined.contains("--ctx-size"));
        assert!(!joined.contains("--batch-size"));
    }

    #[test]
    fn external_draft_dflash_forces_fit_off() {
        let mut sp = SpawnProfile::default();
        sp.fit_style = "ggml_fit_params".to_string();

        let template = ProviderTemplate {
            binary_name: "llama-server.exe".to_string(),
            description: "test".to_string(),
            spawn_profile: sp,
            params: Vec::new(),
        };

        let mut extra = HashMap::new();
        extra.insert("__auto_vram".to_string(), serde_json::json!(true));
        extra.insert("spec_type".to_string(), serde_json::json!("draft-dflash"));
        extra.insert(
            "spec_draft_model".to_string(),
            serde_json::json!("models/draft"),
        );

        let config = EngineConfig {
            alias: String::new(),
            model_path: "model.gguf".to_string(),
            port: 8888,
            backend_type: "ggml-master".to_string(),
            binary_profile: String::new(),
            extra_params: extra,
        };

        let args = template.build_command(&config, "", &[]);
        assert!(
            args.windows(2).any(|w| w[0] == "--fit" && w[1] == "off"),
            "draft-dflash must launch with --fit off: {args:?}"
        );
        assert!(
            !args.windows(2).any(|w| w[0] == "--fit" && w[1] == "on"),
            "draft-dflash must not launch with --fit on: {args:?}"
        );
    }

    #[test]
    fn custom_fit_off_overrides_auto_vram_fit_on() {
        let mut sp = SpawnProfile::default();
        sp.fit_style = "ggml_fit_params".to_string();

        let template = ProviderTemplate {
            binary_name: "llama-server.exe".to_string(),
            description: "test".to_string(),
            spawn_profile: sp,
            params: Vec::new(),
        };

        let mut extra = HashMap::new();
        extra.insert("__auto_vram".to_string(), serde_json::json!(true));
        extra.insert("ctx".to_string(), serde_json::json!("131072"));
        extra.insert(
            "__test_args_add".to_string(),
            serde_json::json!(["--fit", "off"]),
        );

        let config = EngineConfig {
            alias: String::new(),
            model_path: "model.gguf".to_string(),
            port: 8888,
            backend_type: "ggml-master".to_string(),
            binary_profile: String::new(),
            extra_params: extra,
        };

        let mut ctx_param = arg_param("ctx", "--ctx-size", "131072");
        ctx_param.order = 0;

        let args = template.build_command(&config, "", &[ctx_param]);
        let fit_pairs: Vec<_> = args
            .windows(2)
            .filter(|w| w[0] == "--fit")
            .map(|w| w[1].as_str())
            .collect();
        assert_eq!(fit_pairs, vec!["off"], "last --fit must win: {args:?}");
        assert!(
            !args.windows(2).any(|w| w[0] == "--fit-ctx"),
            "--fit-ctx must be dropped when --fit off wins: {args:?}"
        );
    }

    #[test]
    fn auto_vram_moe_optimal_uses_fit_off_not_fit_on() {
        let mut sp = SpawnProfile::default();
        sp.fit_style = "ggml_fit_params".to_string();

        let template = ProviderTemplate {
            binary_name: "llama-server.exe".to_string(),
            description: "test".to_string(),
            spawn_profile: sp,
            params: Vec::new(),
        };

        let mut extra = HashMap::new();
        extra.insert("__auto_vram".to_string(), serde_json::json!(true));
        extra.insert("offload_mode".to_string(), serde_json::json!("moe_optimal"));

        let config = EngineConfig {
            alias: String::new(),
            model_path: "model.gguf".to_string(),
            port: 8080,
            backend_type: "ggml-master".to_string(),
            binary_profile: String::new(),
            extra_params: extra,
        };

        let args = template.build_command(&config, "", &[]);
        let fit_on = args
            .windows(2)
            .any(|w| w[0] == "--fit" && w[1] == "on");
        let fit_off = args
            .windows(2)
            .any(|w| w[0] == "--fit" && w[1] == "off");
        assert!(!fit_on, "MOE_OPTIMAL must not launch with --fit on: {args:?}");
        assert!(fit_off, "MOE_OPTIMAL must launch with --fit off: {args:?}");
    }

    #[test]
    fn manual_without_user_extra_params_emits_all_visible() {
        let batch = arg_param("batch", "--batch-size", "2048");
        let config = EngineConfig {
            alias: String::new(),
            model_path: "model.gguf".to_string(),
            port: 8080,
            backend_type: String::new(),
            binary_profile: String::new(),
            extra_params: HashMap::new(),
        };

        let args = sample_template().build_command(&config, "", &[batch]);
        assert!(args.iter().any(|a| a == "--batch-size"));
    }

    #[test]
    fn arg_select_omits_parent_flag_when_value_has_nonempty_sub_params() {
        let mut reasoning = arg_param("reasoning", "--reasoning", "off");
        reasoning.sub_params = Some(HashMap::from([
            (
                "off".to_string(),
                vec![
                    "--reasoning-budget".to_string(),
                    "0".to_string(),
                    "--reasoning-budget-message".to_string(),
                    "Proceed to final answer.".to_string(),
                ],
            ),
            ("on".to_string(), vec![]),
        ]));

        let config = EngineConfig {
            alias: String::new(),
            model_path: "model.gguf".to_string(),
            port: 8080,
            backend_type: String::new(),
            binary_profile: String::new(),
            extra_params: HashMap::new(),
        };

        let args = sample_template().build_command(&config, "", &[reasoning]);
        assert!(
            !args.iter().any(|a| a == "--reasoning"),
            "parent flag must be omitted when sub_params carry the CLI: {args:?}"
        );
        assert!(args.windows(2).any(|w| w[0] == "--reasoning-budget" && w[1] == "0"));
        assert!(args
            .windows(2)
            .any(|w| w[0] == "--reasoning-budget-message" && w[1] == "Proceed to final answer."));
    }

    #[test]
    fn repair_quoted_arg_fragments_merges_legacy_splits() {
        let broken = vec![
            "--reasoning-budget".to_string(),
            "0".to_string(),
            "--reasoning-budget-message".to_string(),
            "\"Proceed".to_string(),
            "to".to_string(),
            "final".to_string(),
            "answer.\"".to_string(),
        ];
        let repaired = ProviderTemplate::repair_quoted_arg_fragments(&broken);
        assert_eq!(
            repaired,
            vec![
                "--reasoning-budget".to_string(),
                "0".to_string(),
                "--reasoning-budget-message".to_string(),
                "Proceed to final answer.".to_string(),
            ]
        );
    }

    #[test]
    fn arg_select_keeps_parent_flag_when_sub_params_empty() {
        let mut reasoning = arg_param("reasoning", "--reasoning", "off");
        reasoning.sub_params = Some(HashMap::from([
            ("off".to_string(), vec![]),
            (
                "on".to_string(),
                vec![
                    "--reasoning-budget".to_string(),
                    "4096".to_string(),
                ],
            ),
        ]));

        let config = EngineConfig {
            alias: String::new(),
            model_path: "model.gguf".to_string(),
            port: 8080,
            backend_type: String::new(),
            binary_profile: String::new(),
            extra_params: HashMap::new(),
        };

        let args = sample_template().build_command(&config, "", &[reasoning]);
        assert!(
            args.windows(2).any(|w| w[0] == "--reasoning" && w[1] == "off"),
            "empty sub_params must still emit parent flag+value: {args:?}"
        );
    }
}


