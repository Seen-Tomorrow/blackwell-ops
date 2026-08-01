//! Factory template export (admin/dev) + spawn-profile backfill.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use crate::config::*;


#[derive(Debug, Clone, Deserialize)]
pub struct ExportFactoryTemplateInput {
    #[serde(rename = "providerId")]
    pub provider_id: String,
    #[serde(rename = "userEditedTemplateParams")]
    pub user_edited_template_params: Vec<crate::types::UserEditedTemplateParam>,
    #[serde(default, rename = "groupOrder")]
    pub group_order: Vec<String>,
    #[serde(default, rename = "protectedGroups")]
    pub protected_groups: Vec<String>,
    #[serde(default, rename = "layoutDefaults")]
    pub layout_defaults: crate::types::LayoutDefaults,
    #[serde(default, rename = "essentialParamKeys")]
    pub essential_param_keys: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExportFactoryTemplateResult {
    #[serde(rename = "templateVersion")]
    pub template_version: u32,
    pub paths: Vec<String>,
}

fn user_param_to_factory_param(p: &crate::types::UserEditedTemplateParam) -> crate::templates::ProviderDefaultParam {
    let mut values = p.values.clone();
    let existing: std::collections::HashSet<String> = values.iter().map(|v| json_val_key(v)).collect();
    for uv in &p.user_added_values {
        let k = json_val_key(uv);
        if !k.is_empty() && !existing.contains(&k) {
            values.push(uv.clone());
        }
    }

    let default = if !p.default_value.is_null() {
        p.default_value.clone()
    } else if let Some(first) = values.first() {
        first.clone()
    } else if !p.factory_default.is_null() {
        p.factory_default.clone()
    } else {
        serde_json::Value::Null
    };

    let sub_params = p.sub_params.as_ref().map(|m| {
        let obj: serde_json::Map<String, serde_json::Value> = m
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    serde_json::Value::Array(
                        v.iter()
                            .map(|s| serde_json::Value::String(s.clone()))
                            .collect(),
                    ),
                )
            })
            .collect();
        serde_json::Value::Object(obj)
    });

    crate::templates::ProviderDefaultParam {
        key: p.key.clone(),
        label: p.label.clone(),
        flag: p.flag.clone().filter(|f| !f.is_empty()),
        flag_pair: p.flag_pair.clone(),
        ptype: if p.ptype.is_empty() {
            default_ptype()
        } else {
            p.ptype.clone()
        },
        values,
        step: p.step,
        default,
        ui_group: normalize_ui_group(&p.ui_group),
        note: p.note.clone(),
        pattern: p.pattern.clone(),
        sub_params,
        dock: p.dock.clone(),
        hidden_default: p.hidden || p.user_hidden,
        essentials_hidden_values: p.essentials_hidden_values.clone(),
    }
}

fn default_ptype() -> String {
    crate::types::default_ptype()
}

/// Canonical key order for factory default config JSON (identity + spawn at top).
const FACTORY_CONFIG_KEY_ORDER: &[&str] = &[
    "id",
    "display_name",
    "binary_name",
    "description",
    "git_url",
    "branch",
    "template_type",
    "templateVersion",
    "build_profile",
    "spawn_profile",
    "params",
    "groupOrder",
    "protectedGroups",
    "layoutDefaults",
];

const SYSTEM_UI_GROUP: &str = "SYSTEM";

/// Factory export: preserve saved group order, dedupe, pin protected groups last.
pub fn finalize_factory_group_order(order: Vec<String>, protected_groups: &[String]) -> Vec<String> {
    let prot: std::collections::HashSet<String> = protected_groups
        .iter()
        .map(|g| normalize_ui_group(g))
        .filter(|g| !g.is_empty())
        .collect();
    let mut seen = std::collections::HashSet::new();
    let mut normal = Vec::new();
    let mut locked = Vec::new();
    for g in &order {
        let norm = normalize_ui_group(g);
        if norm.is_empty() || !seen.insert(norm.clone()) {
            continue;
        }
        if prot.contains(&norm) || norm == SYSTEM_UI_GROUP {
            locked.push(norm);
        } else {
            normal.push(norm);
        }
    }
    for p in protected_groups {
        let norm = normalize_ui_group(p);
        if !norm.is_empty() && !seen.contains(&norm) {
            seen.insert(norm.clone());
            locked.push(norm);
        }
    }
    if !seen.contains(SYSTEM_UI_GROUP)
        && order.iter().any(|g| normalize_ui_group(g) == SYSTEM_UI_GROUP)
    {
        locked.push(SYSTEM_UI_GROUP.to_string());
    }
    normal.extend(locked);
    normal
}

/// Sort params for factory JSON: group order first, `order` within group, protected last.
pub fn sort_params_for_factory_export(
    params: &mut [crate::types::UserEditedTemplateParam],
    group_order: &[String],
) {
    let mut group_rank: std::collections::HashMap<String, usize> = std::collections::HashMap::new();
    for (i, g) in group_order.iter().enumerate() {
        let norm = normalize_ui_group(g);
        group_rank.entry(norm).or_insert(i);
    }

    params.sort_by(|a, b| {
        let ga = normalize_ui_group(&a.ui_group);
        let gb = normalize_ui_group(&b.ui_group);
        let ra = *group_rank.get(&ga).unwrap_or(&usize::MAX);
        let rb = *group_rank.get(&gb).unwrap_or(&usize::MAX);
        ra.cmp(&rb).then(a.order.cmp(&b.order))
    });
}

fn reorder_factory_config_root(obj: serde_json::Map<String, serde_json::Value>) -> serde_json::Value {
    let mut ordered = serde_json::Map::new();
    let mut rest = obj;
    for key in FACTORY_CONFIG_KEY_ORDER {
        if let Some(v) = rest.remove(*key) {
            ordered.insert(key.to_string(), v);
        }
    }
    for (k, v) in rest {
        ordered.insert(k, v);
    }
    serde_json::Value::Object(ordered)
}

/// Full `spawn_profile` from core Master factory — base for ggml-family optional forks.
pub fn load_master_spawn_profile_map() -> serde_json::Map<String, serde_json::Value> {
    let candidates = [
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("runtime")
            .join(DEFAULT_PROVIDER_ID)
            .join("config")
            .join(format!("{DEFAULT_PROVIDER_ID}-default-config.json")),
        app_root_dir()
            .join("runtime")
            .join(DEFAULT_PROVIDER_ID)
            .join("config")
            .join(format!("{DEFAULT_PROVIDER_ID}-default-config.json")),
    ];
    for path in candidates {
        if let Ok(raw) = std::fs::read_to_string(&path) {
            if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
                if let Some(sp) = v.get("spawn_profile").and_then(|s| s.as_object()) {
                    return sp.clone();
                }
            }
        }
    }
    // Last resort: typed defaults (flags / fit_style filled).
    serde_json::to_value(crate::templates::SpawnProfile::default())
        .ok()
        .and_then(|v| v.as_object().cloned())
        .unwrap_or_default()
}

/// If `spawn_profile` is missing or a stub (no fit_style), start from Master and layer existing keys.
pub fn ensure_complete_spawn_profile_map(
    existing: Option<&serde_json::Value>,
) -> serde_json::Map<String, serde_json::Value> {
    let mut base = load_master_spawn_profile_map();
    let Some(cur) = existing.and_then(|v| v.as_object()) else {
        return base;
    };
    let fit_ok = cur
        .get("fit_style")
        .and_then(|v| v.as_str())
        .map(|s| !s.trim().is_empty())
        .unwrap_or(false);
    if fit_ok {
        // Already complete enough — keep as-is (preserve fork adapters, etc.).
        return cur.clone();
    }
    // Stub seed: keep explicit keys (fit_adapter, fusion_adapter, max_engine_slots, …) on top of Master.
    for (k, v) in cur {
        base.insert(k.clone(), v.clone());
    }
    if !base
        .get("fit_style")
        .and_then(|v| v.as_str())
        .map(|s| !s.is_empty())
        .unwrap_or(false)
    {
        base.insert(
            "fit_style".into(),
            serde_json::Value::String("ggml_fit_params".into()),
        );
    }
    base
}

/// Promote live UI config to factory default JSON (admin). Bumps `templateVersion` automatically.
pub fn export_provider_factory_template(
    input: ExportFactoryTemplateInput,
) -> Result<ExportFactoryTemplateResult, String> {
    if !cfg!(debug_assertions) {
        return Err(
            "Factory export is only available in dev builds — user config cannot write factory files"
                .to_string(),
        );
    }

    let path = factory_default_config_path(&input.provider_id);
    // First export for a newly added provider: seed a factory shell if missing (dev only).
    if !path.exists() {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| {
                format!("Failed to create factory dir {}: {e}", parent.display())
            })?;
        }
        let seed = serde_json::json!({
            "id": input.provider_id,
            "display_name": input.provider_id,
            "description": format!("Optional engine plugin ({})", input.provider_id),
            "binary_name": "llama-server.exe",
            "git_url": "",
            "branch": "master",
            "build_profile": "",
            "template_type": "ggml-llama",
            "optionalDownload": true,
            "templateVersion": 0,
            "groupOrder": [],
            "layoutDefaults": {
                "groupDisplayZone": {},
                "groupColumn": {},
                "configColumnCount": 2,
                "configColumnWidths": [],
                "aboveColumnWidths": []
            },
            "params": [],
            "spawn_profile": {
                "essentialParamKeys": [],
                "simple_param_keys": []
            }
        });
        let seed_txt = serde_json::to_string_pretty(&seed)
            .map_err(|e| format!("Failed to seed factory JSON: {e}"))?;
        std::fs::write(&path, &seed_txt)
            .map_err(|e| format!("Failed to create {}: {}", path.display(), e))?;
        log::info!(
            "[config] Seeded new factory template for '{}' at {}",
            input.provider_id,
            path.display()
        );
    }

    let content = std::fs::read_to_string(&path)
        .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
    let mut root: serde_json::Value = serde_json::from_str(&content)
        .map_err(|e| format!("Invalid factory JSON at {}: {}", path.display(), e))?;

    let current_tv = root
        .get("templateVersion")
        .and_then(|v| v.as_u64())
        .unwrap_or(1) as u32;
    let new_tv = current_tv.saturating_add(1);

    let validation_errors =
        validate_provider_params(&input.provider_id, &input.user_edited_template_params);
    if !validation_errors.is_empty() {
        return Err(validation_errors.join("\n"));
    }

    let protected_groups: Vec<String> = {
        let mut seen = std::collections::HashSet::new();
        let mut out = Vec::new();
        for g in &input.protected_groups {
            let norm = normalize_ui_group(g);
            if norm.is_empty() || !seen.insert(norm.clone()) {
                continue;
            }
            out.push(norm);
        }
        if out.is_empty() {
            out.push(SYSTEM_UI_GROUP.to_string());
        }
        out
    };

    let group_order = finalize_factory_group_order(
        input
            .group_order
            .iter()
            .map(|g| normalize_ui_group(g))
            .collect(),
        &protected_groups,
    );

    let mut sorted = input.user_edited_template_params.clone();
    sort_params_for_factory_export(&mut sorted, &group_order);
    let factory_params: Vec<crate::templates::ProviderDefaultParam> =
        sorted.iter().map(user_param_to_factory_param).collect();

    let layout = input.layout_defaults.clone();
    let pretty = serde_json::to_string_pretty(&factory_params)
        .map_err(|e| format!("Failed to serialize params: {e}"))?;
    let params_value: serde_json::Value =
        serde_json::from_str(&pretty).map_err(|e| format!("Failed to encode params: {e}"))?;

    let essential_keys = input.essential_param_keys.clone();

    if let Some(obj) = root.as_object_mut() {
        obj.insert("params".to_string(), params_value);
        obj.insert(
            "groupOrder".to_string(),
            serde_json::to_value(&group_order).map_err(|e| e.to_string())?,
        );
        obj.insert(
            "protectedGroups".to_string(),
            serde_json::to_value(&protected_groups).map_err(|e| e.to_string())?,
        );
        obj.insert(
            "layoutDefaults".to_string(),
            serde_json::to_value(&layout).map_err(|e| e.to_string())?,
        );
        obj.insert(
            "templateVersion".to_string(),
            serde_json::Value::Number(new_tv.into()),
        );

        // Full spawn_profile for forks: backfill from ggml-master when stub/missing
        // (EXPORT used to only write essentialParamKeys → empty fit_style / flags).
        let mut sp = ensure_complete_spawn_profile_map(obj.get("spawn_profile"));
        sp.insert(
            "essentialParamKeys".to_string(),
            serde_json::to_value(&essential_keys).map_err(|e| e.to_string())?,
        );
        sp.insert(
            "simple_param_keys".to_string(),
            serde_json::to_value(&essential_keys).map_err(|e| e.to_string())?,
        );
        obj.insert(
            "spawn_profile".to_string(),
            serde_json::Value::Object(sp),
        );
    } else {
        return Err("Factory config root must be a JSON object".to_string());
    }

    root = root
        .as_object()
        .map(|o| reorder_factory_config_root(o.clone()))
        .unwrap_or(root);

    // Author bumped factory — sync user meta version so reload won't show attention banner.
    if let Some(mut meta) = load_user_providers_meta()
        .into_iter()
        .find(|m| m.id == input.provider_id)
    {
        meta.template_version = new_tv;
        for p in &mut meta.user_edited_template_params {
            p.essential = None;
        }
        let _ = save_provider_user_config(&meta);
    }

    let output = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    let mut written = Vec::new();

    std::fs::write(&path, &output)
        .map_err(|e| format!("Failed to write {}: {}", path.display(), e))?;
    written.push(path.display().to_string());

    #[cfg(debug_assertions)]
    {
        // Always mirror into src-tauri/runtime (create if first export for a new provider).
        let src = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("runtime")
            .join(&input.provider_id)
            .join("config")
            .join(format!("{}-default-config.json", input.provider_id));
        if let Some(parent) = src.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        std::fs::write(&src, &output)
            .map_err(|e| format!("Failed to write dev source {}: {}", src.display(), e))?;
        written.push(src.display().to_string());
    }

    log::info!(
        "[config] Exported factory template for '{}' → templateVersion={} essentials={} ({} file(s))",
        input.provider_id,
        new_tv,
        essential_keys.len(),
        written.len()
    );

    Ok(ExportFactoryTemplateResult {
        template_version: new_tv,
        paths: written,
    })
}

#[tauri::command]
pub fn reset_provider_user_config(provider_id: String) -> Result<(), String> {
    let path = provider_user_config_path(&provider_id);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("Failed to delete {}: {}", path.display(), e))?;
        log::info!("[config] Deleted user config for '{}' — will regenerate from factory on next load", provider_id);
    } else {
        log::warn!("[config] No user config found at {} for '{}'", path.display(), provider_id);
    }
    Ok(())
}

