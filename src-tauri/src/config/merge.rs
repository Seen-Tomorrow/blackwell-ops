//! Factory-template <-> user-param merge logic.

use std::collections::HashMap;
use crate::config::*;


pub fn json_val_key(v: &serde_json::Value) -> String {
    if let Some(n) = v.as_f64() {
        if n.fract() == 0.0 && n.is_finite() {
            format!("{}", n as i64)
        } else {
            format!("{n}")
        }
    } else {
        v.to_string()
    }
}

/// Read `templateVersion` from the factory default config for a provider or template type.
pub fn factory_template_version_for_provider(
    provider_id: &str,
    template_type: &str,
    factory_provided: bool,
) -> u32 {
    resolve_merge_template_key(provider_id, template_type, factory_provided)
        .map(|key| crate::templates::get_template_version_for_provider(&key))
        .unwrap_or(1)
}

/// Resolve which runtime folder supplies the factory template for merge.
pub fn resolve_merge_template_key(
    provider_id: &str,
    template_type: &str,
    factory_provided: bool,
) -> Option<String> {
    if factory_provided && crate::templates::load_provider_defaults(provider_id).is_some() {
        return Some(provider_id.to_string());
    }
    template_key_for_type(template_type)
}

/// Drop duplicate/empty param keys — keeps lowest `order` entry per key.
pub fn dedupe_user_params_by_key(
    params: Vec<crate::types::UserEditedTemplateParam>,
) -> Vec<crate::types::UserEditedTemplateParam> {
    let mut sorted = params;
    sorted.sort_by_key(|p| p.order);
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::with_capacity(sorted.len());
    for p in sorted {
        if p.key.is_empty() {
            log::warn!("[config] Dropping param with empty key (order={})", p.order);
            continue;
        }
        if seen.insert(p.key.clone()) {
            out.push(p);
        } else {
            log::warn!("[config] Dropping duplicate param key '{}' (order={})", p.key, p.order);
        }
    }
    out.sort_by_key(|p| p.order);
    out
}

/// Merge user params against the correct factory template for this provider.
pub fn merge_template_for_provider(
    provider_id: &str,
    template_type: &str,
    factory_provided: bool,
    user_edited: &[crate::types::UserEditedTemplateParam],
    excluded_keys: &[String],
) -> Vec<crate::types::UserEditedTemplateParam> {
    let template_key = resolve_merge_template_key(provider_id, template_type, factory_provided);
    let merged = merge_template_into_user_params_by_key(template_key.as_deref(), user_edited, excluded_keys);
    dedupe_user_params_by_key(merged)
}


fn template_sub_params_to_map(
    sp: &serde_json::Value,
) -> Option<std::collections::HashMap<String, Vec<String>>> {
    sp.as_object().map(|obj| {
        obj.iter()
            .filter_map(|(k, v)| {
                v.as_array().and_then(|arr| {
                    Some((
                        k.clone(),
                        arr.iter()
                            .filter_map(|el| el.as_str().map(String::from))
                            .collect(),
                    ))
                })
            })
            .collect()
    })
}

fn is_numeric_literal_value(v: &serde_json::Value) -> bool {
    if v.is_number() {
        return true;
    }
    v.as_str()
        .map(|s| {
            let t = s.trim();
            !t.is_empty() && t.parse::<f64>().is_ok() && t.chars().all(|c| c.is_ascii_digit() || c == '.' || c == '-')
        })
        .unwrap_or(false)
}

fn values_all_numeric(values: &[serde_json::Value]) -> bool {
    values.len() >= 2 && values.iter().all(is_numeric_literal_value)
}

/// Preserve factory JSON order for string enums; numeric lists keep user/saved order.
fn reorder_values_to_template(
    values: &[serde_json::Value],
    tmpl_values: &[serde_json::Value],
) -> Vec<serde_json::Value> {
    if values.is_empty() || tmpl_values.is_empty() || values_all_numeric(values) {
        return values.to_vec();
    }
    let mut ordered = Vec::with_capacity(values.len());
    let mut placed = std::collections::HashSet::new();
    for tv in tmpl_values {
        let key = json_val_key(tv);
        if let Some(v) = values.iter().find(|v| json_val_key(v) == key) {
            ordered.push(v.clone());
            placed.insert(key);
        }
    }
    for v in values {
        let key = json_val_key(v);
        if !placed.contains(&key) {
            ordered.push(v.clone());
            placed.insert(key);
        }
    }
    ordered
}

pub fn merge_user_params_with_template(
    template: &crate::templates::ProviderTemplate,
    user_edited: &[crate::types::UserEditedTemplateParam],
    excluded_keys: &[String],
) -> Vec<crate::types::UserEditedTemplateParam> {
    let excluded: std::collections::HashSet<&str> = excluded_keys.iter().map(|k| k.as_str()).collect();
    let tmpl_map: std::collections::HashMap<_, _> = template
        .params
        .iter()
        .map(|p| (p.key.as_str(), p))
        .collect();

    let mut merged = Vec::with_capacity(user_edited.len());

    for user_param in user_edited {
        let mut m = user_param.clone();
        if let Some(tmpl) = tmpl_map.get(user_param.key.as_str()) {
            // ── Values: user-owned catalog — only backfill when empty (never re-append deleted factory values) ──
            if m.values.is_empty() && !tmpl.values.is_empty() {
                m.values = tmpl.values.clone();
            } else if !m.values.is_empty() && !tmpl.values.is_empty() {
                m.values = reorder_values_to_template(&m.values, &tmpl.values);
            }

            // ── factoryDefault: always sync from fresh template — keeps bubble styling correct ──
            m.factory_default = tmpl.default.clone();

            // ── defaultValue: if current value still in merged array → keep. If orphaned → force reset to new factory default ──
            let user_default_key = json_val_key(&m.default_value);
            if !m.values.iter().any(|v| json_val_key(v) == user_default_key) {
                log::warn!("[config] Param '{}' default '{:?}' no longer in values — resetting to factory default {:?}",
                    m.key, m.default_value, tmpl.default);
                m.default_value = tmpl.default.clone();
            }

            // ── Structural fields: sync from template (source of truth) ──
            // label: preserve user rename from ConfigPage — backfill only when empty
            if m.label.is_empty() {
                m.label = tmpl.label.clone();
            }
            if m.flag.is_none() || m.flag.as_deref().map_or(false, |s| s.is_empty()) {
                m.flag = tmpl.flag.clone();
            }
            if m.flag_pair.is_empty() && !tmpl.flag_pair.is_empty() {
                m.flag_pair = tmpl.flag_pair.clone();
            }

            // ptype: only backfill if still default "arg_select" and template differs
            if m.ptype == "arg_select" && tmpl.ptype != "arg_select" {
                m.ptype = tmpl.ptype.clone();
            }

            // Spec profiles: always take factory group (repairs SYSTEM mis-pin from old migrate).
            let tmpl_g = normalize_ui_group(&tmpl.ui_group);
            let is_profile = tmpl_g == "SPECULATIVE-MTP"
                || tmpl_g == "SPECULATIVE-DFLASH"
                || m.key.starts_with("mtp_")
                || m.key.starts_with("dflash_");
            if m.ui_group.is_empty() || is_profile {
                if normalize_ui_group(&m.ui_group) != tmpl_g {
                    m.ui_group = tmpl_g;
                } else if m.ui_group.is_empty() {
                    m.ui_group = tmpl_g;
                }
            }
            if m.note.is_empty() {
                m.note = tmpl.note.clone();
            }
            if m.pattern.is_empty() {
                m.pattern = tmpl.pattern.clone();
            }

            // Backfill step (slider)
            if m.step.is_none() && tmpl.step.is_some() {
                m.step = tmpl.step;
            }

            // Per-key sub_params merge — backfill missing keys from template, preserve user keys
            if let Some(tmpl_sp) = tmpl.sub_params.as_ref().and_then(template_sub_params_to_map) {
                let mut merged_sp = m.sub_params.clone().unwrap_or_default();
                for (k, v) in tmpl_sp {
                    merged_sp.entry(k).or_insert(v);
                }
                if !merged_sp.is_empty() {
                    m.sub_params = Some(merged_sp);
                }
            }

            if m.dock.is_empty() && !tmpl.dock.is_empty() {
                m.dock = tmpl.dock.clone();
            }

            // Factory-curated Essentials values — backfill when user has none (ships with templates).
            if m.essentials_hidden_values.is_empty() && !tmpl.essentials_hidden_values.is_empty() {
                m.essentials_hidden_values = tmpl.essentials_hidden_values.clone();
            }

            // Assisted Full expansion chips: ensure factory essentialsHidden values exist in
            // the values list even when the catalog is user-owned (no re-delete of other chips).
            // Without this, only providers that already shipped the high-end list (historically
            // ggml-master) show extra Agents/batch/spec chips in ASSISTED Full.
            if !tmpl.essentials_hidden_values.is_empty() {
                let mut changed = false;
                for tv in &tmpl.essentials_hidden_values {
                    let key = json_val_key(tv);
                    if !m.values.iter().any(|v| json_val_key(v) == key) {
                        m.values.push(tv.clone());
                        changed = true;
                    }
                }
                if changed && !tmpl.values.is_empty() {
                    m.values = reorder_values_to_template(&m.values, &tmpl.values);
                }
            }
        }
        merged.push(m);
    }

    merged.retain(|p| !excluded.contains(p.key.as_str()));

    // Append new params from template that don't exist in user config
    for (i, tmpl) in template.params.iter().enumerate() {
        if excluded.contains(tmpl.key.as_str()) {
            continue;
        }
        if !merged.iter().any(|p| p.key == tmpl.key) {
            let param = crate::types::UserEditedTemplateParam {
                key: tmpl.key.clone(),
                label: tmpl.label.clone(),
                values: tmpl.values.clone(),
                order: (user_edited.len() + i as usize) as i32,
                hidden: tmpl.hidden_default,
                user_hidden: false,
                hidden_values: Vec::new(),
                essentials_hidden_values: tmpl.essentials_hidden_values.clone(),
                flag: tmpl.flag.clone(),
                flag_pair: tmpl.flag_pair.clone(),
                ptype: tmpl.ptype.clone(),
                step: tmpl.step,
                ui_group: normalize_ui_group(&tmpl.ui_group),
                note: tmpl.note.clone(),
                pattern: tmpl.pattern.clone(),
                default_value: tmpl.default.clone(),
                user_added_values: Vec::new(),
                factory_default: tmpl.default.clone(),
                sub_params: tmpl.sub_params.as_ref().and_then(|sp| {
                    sp.as_object().map(|obj| {
                        obj.iter()
                            .filter_map(|(k, v)| {
                                v.as_array().and_then(|arr| {
                                    Some((k.clone(), arr.iter().filter_map(|el| el.as_str().map(String::from)).collect()))
                                })
                            })
                            .collect::<std::collections::HashMap<_, _>>()
                    })
                }),
                dock: tmpl.dock.clone(),
                essential: None,
            };
            merged.push(param);
        }
    }

    merged
}

pub fn resolve_provider_binaries_from_meta(
    p: &mut crate::types::ProviderConfig,
    meta: Option<&ProviderMeta>,
) {
    let empty = HashMap::new();
    let source_pref = meta
        .map(|m| &m.binary_source_per_env)
        .unwrap_or(&empty);
    let saved_paths = meta
        .map(|m| &m.binary_path_per_env)
        .unwrap_or(&empty);
    if let Some(m) = meta {
        p.binary_source_per_env = m.binary_source_per_env.clone();
        p.downloaded_version_per_env = m.downloaded_version_per_env.clone();
    }
    crate::profile_binaries::resolve_provider_binaries(
        p,
        crate::profile_binaries::ResolveContext {
            source_pref,
            saved_paths,
        },
    );
}

fn merge_template_into_user_params_by_key(
    template_key: Option<&str>,
    user_edited: &[crate::types::UserEditedTemplateParam],
    excluded_keys: &[String],
) -> Vec<crate::types::UserEditedTemplateParam> {
    let Some(key) = template_key else {
        let excluded: std::collections::HashSet<&str> = excluded_keys.iter().map(|k| k.as_str()).collect();
        return user_edited
            .iter()
            .filter(|p| !excluded.contains(p.key.as_str()))
            .cloned()
            .collect();
    };
    let Some(template) = crate::templates::load_provider_defaults(key) else {
        let excluded: std::collections::HashSet<&str> = excluded_keys.iter().map(|k| k.as_str()).collect();
        return user_edited
            .iter()
            .filter(|p| !excluded.contains(p.key.as_str()))
            .cloned()
            .collect();
    };
    merge_user_params_with_template(&template, user_edited, excluded_keys)
}
