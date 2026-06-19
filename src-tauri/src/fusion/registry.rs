//! Resolve fusion adapter per provider + per-slot registration for log_hub.

use std::collections::HashMap;

use crate::fusion::adapters::FusionAdapterId;

static SLOT_ADAPTERS: std::sync::LazyLock<parking_lot::Mutex<HashMap<usize, FusionAdapterId>>> =
    std::sync::LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Resolve adapter: factory spawn_profile override → provider id → template_type.
pub fn resolve_adapter(
    provider_id: &str,
    template_type: &str,
    spawn_fusion_adapter: Option<&str>,
) -> FusionAdapterId {
    if let Some(id) = spawn_fusion_adapter.and_then(|s| {
        let t = s.trim();
        if t.is_empty() {
            None
        } else {
            FusionAdapterId::from_config_str(t)
        }
    }) {
        return id;
    }
    if let Some(id) = FusionAdapterId::from_config_str(provider_id) {
        return id;
    }
    match template_type {
        "ik-llama" => FusionAdapterId::IkLlama,
        "ggml-llama" => FusionAdapterId::GgmlMaster,
        _ if provider_id.eq_ignore_ascii_case("ggml-tom") => FusionAdapterId::GgmlTom,
        _ if provider_id.to_lowercase().contains("ik") => FusionAdapterId::IkLlama,
        _ => FusionAdapterId::GgmlMaster,
    }
}

pub fn register_slot_adapter(slot_idx: usize, adapter: FusionAdapterId) {
    SLOT_ADAPTERS.lock().insert(slot_idx, adapter);
}

pub fn unregister_slot_adapter(slot_idx: usize) {
    SLOT_ADAPTERS.lock().remove(&slot_idx);
}

pub fn slot_adapter(slot_idx: usize) -> FusionAdapterId {
    SLOT_ADAPTERS
        .lock()
        .get(&slot_idx)
        .copied()
        .unwrap_or(FusionAdapterId::GgmlMaster)
}

pub fn clear_slot_adapters() {
    SLOT_ADAPTERS.lock().clear();
}