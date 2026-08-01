//! Provider param validation + block-save command.

use crate::config::*;


fn json_val_eq(a: &serde_json::Value, b: &serde_json::Value) -> bool {
    // Compare numbers by numeric equality (1 == 1.0), everything else by canonical string
    if let (Some(na), Some(nb)) = (a.as_f64(), b.as_f64()) {
        na == nb
    } else {
        serde_json::to_string(a).ok() == serde_json::to_string(b).ok()
    }
}

/// Validate all params for a single provider. Returns human-readable error lines (empty = ok).
pub fn validate_provider_params(provider_id: &str, params: &[crate::types::UserEditedTemplateParam]) -> Vec<String> {
    let mut errors = Vec::new();
    let mut seen_keys: std::collections::HashMap<&str, i32> = std::collections::HashMap::new();
    for ep in params {
        if let Some(&prev_order) = seen_keys.get(ep.key.as_str()) {
            errors.push(format!(
                "provider '{}': duplicate param key '{}' (order {} and {})",
                provider_id, ep.key, prev_order, ep.order
            ));
        } else {
            seen_keys.insert(&ep.key, ep.order);
        }
        for e in validate_user_edited_param(ep) {
            errors.push(format!("provider '{}' param '{}': {}", provider_id, ep.key, e));
        }
    }
    errors
}

fn validate_user_edited_param(ep: &crate::types::UserEditedTemplateParam) -> Vec<String> {
    let mut errors = Vec::new();

    if ep.key.is_empty() {
        errors.push("key is empty".to_string());
    }

    // values[] must be string or number
    for (i, v) in ep.values.iter().enumerate() {
        match v {
            serde_json::Value::String(_) | serde_json::Value::Number(_) => {}
            _ => errors.push(format!("values[{}] must be string or number, got {:?}", i, v)),
        }
    }

    // No duplicate values
    for i in 0..ep.values.len() {
        for j in (i + 1)..ep.values.len() {
            if json_val_eq(&ep.values[i], &ep.values[j]) {
                errors.push(format!("duplicate value {:?} at indices {} and {}", &ep.values[i], i, j));
                break;
            }
        }
    }

    // defaultValue type must match one of values
    if !ep.default_value.is_null() && !ep.values.is_empty() {
        let mut found = false;
        for v in &ep.values {
            if json_val_eq(&v, &ep.default_value) {
                found = true;
                break;
            }
        }
        if !found {
            errors.push(format!("defaultValue ({:?}) type does not match any value in values array", ep.default_value));
        }
    }

    // Valid ptype
    static VALID_PTYPES: [&str; 8] = [
        "arg_select", "arg_select_double", "slider", "switch_onoff", "switch_inverted", "path_scanner", "logic_only", "",
    ];
    if !VALID_PTYPES.contains(&ep.ptype.as_str()) {
        errors.push(format!("invalid ptype '{}' (valid: {:?})", ep.ptype, VALID_PTYPES));
    }

    // flag required for arg_select/slider, flag_pair for arg_select_double
    let needs_flag = ep.ptype == "arg_select" || ep.ptype == "slider";
    if needs_flag && ep.flag.as_deref().map_or(true, |s| s.is_empty()) {
        errors.push(format!("ptype '{}' requires a non-empty flag", ep.ptype));
    }
    if ep.ptype == "arg_select_double" && ep.flag_pair.len() != 2 {
        errors.push(format!("ptype 'arg_select_double' requires exactly 2 entries in flag_pair"));
    }

    // hiddenValues must be subset of values
    for hv in &ep.hidden_values {
        let found = ep.values.iter().any(|v| json_val_eq(v, hv));
        if !found {
            errors.push(format!("hiddenValue {:?} is not in values array", hv));
        }
    }

    // sub_params: each value must be string[], no empty strings
    if let Some(ref sp) = ep.sub_params {
        for (k, args) in sp {
            for (i, arg) in args.iter().enumerate() {
                if arg.is_empty() {
                    errors.push(format!("sub_params['{}'][{}] is empty string", k, i));
                }
            }
        }
    }

    errors
}

fn check_user_providers_meta(metas: &[crate::types::ProviderConfig]) -> Vec<String> {
    let mut all_errors: Vec<String> = Vec::new();

    // Duplicate provider IDs
    let mut seen_ids: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for meta in metas {
        if !seen_ids.insert(&meta.id) {
            all_errors.push(format!("duplicate provider id: '{}'", meta.id));
        }
        // Reuse the per-provider validator (duplicate param keys + per-param checks)
        all_errors.extend(validate_provider_params(&meta.id, &meta.user_edited_template_params));
    }

    all_errors
}

#[tauri::command]
pub fn save_user_providers_meta(metas: Vec<crate::types::ProviderConfig>) -> Result<(), String> {
    // Block-save validation — force user to correct manually
    let errors = check_user_providers_meta(&metas);
    if !errors.is_empty() {
        return Err(format!("Provider config has {} issue(s):\n{}", errors.len(), errors.join("\n")));
    }

    let config_directory = config_dir();
    std::fs::create_dir_all(&config_directory).map_err(|e| format!("Failed to create config dir: {}", e))?;

    for meta in &metas {
        save_provider_user_config(meta)?;
    }
    log::debug!("Saved {} provider(s)", metas.len());
    Ok(())
}

