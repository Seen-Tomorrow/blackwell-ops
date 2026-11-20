//! MOE optimizer: where the expert cache should sit, measured from a real launch.
//!
//! There is no predictive formula worth trusting here - the cache is a cliff, not a curve, and the
//! launch's own footprint (weights, KV, compute, MTP/DFlash, slots) moves it. So the optimizer runs
//! the real configuration with the cache off, reads what the card has left, keeps a reserve and
//! writes the difference. That is the manual loop, automated.

use serde::Serialize;

/// VRAM kept free on top of the launch, on NVML: filling to the last hundred MiB costs speed even
/// when the engine "fits" (measured on a 16 GB card: 14.6 GB used lost to 14.2).
const RESERVE_MIB: u64 = 512;

/// NVML `used`/`free` for one card. `used` is process-attributed, so an idle card reads 0.
fn sample_vram(index: u32) -> (Option<u64>, Option<u64>) {
    let Some(samples) = crate::nvml_metrics::scan() else {
        return (None, None);
    };
    match samples.iter().find(|s| s.index == index) {
        Some(s) => (Some(s.memory_used_mib), Some(s.memory_free_mib)),
        None => (None, None),
    }
}

/// Where the expert cache should be sized from a *running* engine: whatever NVML says is free on
/// the card right now, minus the reserve.
#[derive(Debug, Clone, Serialize)]
pub struct MoeCacheSizing {
    pub device: u32,
    pub free_mib: u64,
    pub used_mib: u64,
    pub reserve_mib: u64,
    /// `free - reserve`, floored at 0. The value to put in `--moe-cache-mib`.
    pub recommended_mib: u64,
    /// False when the card looks idle - launch the model (cache off) before sizing.
    pub engine_loaded: bool,
}

/// Cache size from a card's free VRAM: the leftover after the reserve, or nothing when the engine
/// is not loaded (an idle card says nothing about this launch's footprint).
pub fn resolve_cache_mib(free_mib: u64, engine_loaded: bool) -> u64 {
    if engine_loaded {
        free_mib.saturating_sub(RESERVE_MIB)
    } else {
        0
    }
}

/// Size the cache off a running launch, the way a manual search does it: load with no cache, look
/// at what the card has left, keep a reserve. No extra launches, and the reading includes whatever
/// the real launch carries (weights, KV, compute, MTP/draft, slots).
#[tauri::command]
pub async fn moe_cache_autosize(device_index: Option<u32>) -> Result<MoeCacheSizing, String> {
    let device = device_index.unwrap_or(0);
    let (used_mib, free_mib) = sample_vram(device);
    let (used_mib, free_mib) = (used_mib.unwrap_or(0), free_mib.unwrap_or(0));
    if free_mib == 0 && used_mib == 0 {
        return Err(format!("NVML has no reading for GPU-{device}"));
    }
    // Under ~1 GiB in use the model is not loaded; sizing now would hand out the whole card.
    let engine_loaded = used_mib >= 1024;
    let recommended_mib = resolve_cache_mib(free_mib, engine_loaded);
    Ok(MoeCacheSizing {
        device,
        free_mib,
        used_mib,
        reserve_mib: RESERVE_MIB,
        recommended_mib,
        engine_loaded,
    })
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reserve_is_a_real_margin_not_a_rounding() {
        // 8,432 free on a loaded card leaves 7,920 for the cache.
        assert_eq!(resolve_cache_mib(8_432, true), 8_432 - RESERVE_MIB);
        // An idle card cannot size anything: the launch is what defines the leftover.
        assert_eq!(resolve_cache_mib(96_573, false), 0);
        // Never negative.
        assert_eq!(resolve_cache_mib(200, true), 0);
    }
}
