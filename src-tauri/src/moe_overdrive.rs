//! MOE OVERDRIVE records: one calibration per shape, reused by later launches.
//!
//! The knobs live in the provider config already; this file keeps the *evidence* that justified
//! them (free VRAM after the calibration launch, the cache chosen, the before/after speed) so a
//! later launch can skip the two loads, the screen can show what it learned, and RESET has
//! something concrete to discard.

use serde::{Deserialize, Serialize};

/// One measured calibration. Anything that changes the footprint must change the identity, so a
/// stale record can never be applied to a different launch shape.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MoeOverdriveRecord {
    pub model_path: String,
    pub model_size_bytes: u64,
    pub ctx_size: u64,
    pub kv_quant: String,
    pub split_mode: String,
    /// The launch's GPU set, resolved from the panel's device/split config — never the selected
    /// slot. A record must survive stopping the engine that measured it.
    pub gpu_mask: String,
    /// Spec/draft identity and its verify window: both move the footprint (n-max costs ~0.5 GiB
    /// between 6 and 12 on the measured model).
    #[serde(default)]
    pub draft: String,
    #[serde(default)]
    pub draft_n_max: u64,
    /// Free VRAM after the calibration launch, per probe pass. The tighter one sized the cache.
    pub free_pp_mib: u64,
    pub free_tg_mib: u64,
    pub free_after_load_mib: u64,
    pub reserve_mib: u64,
    pub cache_mib: u64,
    /// Decode speed and memory footprint measured on the calibration launch (cache 0) and on the
    /// tuned launch (this cache). The screen prints the pair; `None` when that run was not measured.
    #[serde(default)]
    pub tps_before: Option<f64>,
    #[serde(default)]
    pub tps_after: Option<f64>,
    #[serde(default)]
    pub device_mib_before: Option<u64>,
    #[serde(default)]
    pub device_mib_after: Option<u64>,
    #[serde(default)]
    pub host_mib_before: Option<u64>,
    #[serde(default)]
    pub host_mib_after: Option<u64>,
    #[serde(default)]
    pub engine_build: Option<String>,
    #[serde(default)]
    pub driver_version: Option<String>,
    pub measured_at: String,
}

/// FNV-1a: a short stable filename without a hashing dependency.
fn record_key(identity: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in identity.bytes() {
        hash ^= byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

/// Everything that changes what the calibration measured. The engine build and driver are *not*
/// here: they are recorded with the result, and the caller decides whether a different build makes
/// an old measurement stale (it usually does, but that is a policy, not identity).
pub fn record_identity(
    model_path: &str,
    model_size_bytes: u64,
    ctx_size: u64,
    kv_quant: &str,
    split_mode: &str,
    gpu_mask: &str,
    draft: &str,
    draft_n_max: u64,
) -> String {
    format!(
        "v1|{}|{}|ctx={}|kv={}|split={}|gpu={}|draft={}|nmax={}",
        model_path,
        model_size_bytes,
        ctx_size,
        kv_quant.trim().to_lowercase(),
        split_mode.trim().to_lowercase(),
        gpu_mask.trim(),
        draft.trim(),
        draft_n_max
    )
}

pub fn record_path(identity: &str) -> std::path::PathBuf {
    crate::config::cache_dir()
        .join("moe-overdrive")
        .join(format!("{}.json", record_key(identity)))
}

#[derive(Debug, Clone, Serialize)]
pub struct OverdriveRecordView {
    pub identity: String,
    pub record: MoeOverdriveRecord,
}

fn read_record(identity: &str) -> Option<MoeOverdriveRecord> {
    let path = record_path(identity);
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

#[tauri::command]
pub async fn moe_overdrive_record(
    model_path: String,
    ctx_size: u64,
    kv_quant: String,
    split_mode: String,
    gpu_mask: String,
    draft: Option<String>,
    draft_n_max: Option<u64>,
) -> Result<Option<OverdriveRecordView>, String> {
    let size = std::fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0);
    let identity = record_identity(
        &model_path,
        size,
        ctx_size,
        &kv_quant,
        &split_mode,
        &gpu_mask,
        draft.as_deref().unwrap_or(""),
        draft_n_max.unwrap_or(0),
    );
    Ok(read_record(&identity).map(|record| OverdriveRecordView { identity, record }))
}

#[tauri::command]
pub async fn moe_overdrive_record_save(
    mut record: MoeOverdriveRecord,
) -> Result<OverdriveRecordView, String> {
    // The caller does not have to know the file size: derive it from the path, so the record lands
    // under the same identity the read path computes.
    if let Ok(meta) = std::fs::metadata(&record.model_path) {
        record.model_size_bytes = meta.len();
    }
    let identity = record_identity(
        &record.model_path,
        record.model_size_bytes,
        record.ctx_size,
        &record.kv_quant,
        &record.split_mode,
        &record.gpu_mask,
        &record.draft,
        record.draft_n_max,
    );
    let path = record_path(&identity);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("cannot create {}: {e}", parent.display()))?;
    }
    crate::fs_util::write_json_atomic(&path, &record)?;
    Ok(OverdriveRecordView { identity, record })
}

/// RESET: the record goes away, so the next calibration starts from nothing.
#[tauri::command]
pub async fn moe_overdrive_record_clear(
    model_path: String,
    ctx_size: u64,
    kv_quant: String,
    split_mode: String,
    gpu_mask: String,
    draft: Option<String>,
    draft_n_max: Option<u64>,
) -> Result<bool, String> {
    let size = std::fs::metadata(&model_path).map(|m| m.len()).unwrap_or(0);
    let identity = record_identity(
        &model_path,
        size,
        ctx_size,
        &kv_quant,
        &split_mode,
        &gpu_mask,
        draft.as_deref().unwrap_or(""),
        draft_n_max.unwrap_or(0),
    );
    let path = record_path(&identity);
    if path.exists() {
        std::fs::remove_file(&path).map_err(|e| format!("cannot remove {}: {e}", path.display()))?;
        Ok(true)
    } else {
        Ok(false)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn identity_separates_shapes_and_keeps_a_plain_launch_alone() {
        let base = record_identity("m", 100, 32768, "q4_0", "none", "0", "", 0);
        assert_eq!(base, record_identity("m", 100, 32768, "Q4_0", "NONE", "0", "", 0));
        // A different context, KV, draft or verify window is a different shape.
        assert_ne!(base, record_identity("m", 100, 65536, "q4_0", "none", "0", "", 0));
        assert_ne!(base, record_identity("m", 100, 32768, "q8_0", "none", "0", "", 0));
        assert_ne!(base, record_identity("m", 100, 32768, "q4_0", "none", "0", "dflash2", 12));
        // A different file size is different weights.
        assert_ne!(base, record_identity("m", 101, 32768, "q4_0", "none", "0", "", 0));
    }
}
