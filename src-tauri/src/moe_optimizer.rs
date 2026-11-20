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


// ── MOE OVERDRIVE ──────────────────────────────────────────────────────────
// Isolated on purpose: this path may live or die on its own, so it shares only the NVML reading
// and the reserve with the rest of the optimizer.

/// Where the loaded engine's VRAM went, from its own ledger (`/memory`).
#[derive(Debug, Clone, Default, Serialize)]
pub struct OverdriveComponents {
    pub model_mib: u64,
    pub kv_mib: u64,
    pub compute_mib: u64,
    pub host_mib: u64,
}

impl OverdriveComponents {
    fn total_mib(&self) -> u64 {
        self.model_mib + self.kv_mib + self.compute_mib
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct OverdriveLedger {
    pub available: bool,
    pub components: OverdriveComponents,
    pub free_mib: u64,
    pub used_mib: u64,
}

/// Fold `/memory`'s ledger into model / KV / compute / host. Same rules as the memory log: every
/// device-side kind that is not weights or context is compute, so nothing falls on the floor.
fn read_ledger(payload: &serde_json::Value) -> Option<OverdriveComponents> {
    let ledger = payload.get("ledger")?.as_array()?;
    if ledger.is_empty() {
        return None;
    }
    let mut c = OverdriveComponents::default();
    for entry in ledger {
        let mib = entry
            .get("mib")
            .and_then(|m| m.as_f64())
            .map(|v| v.max(0.0).round() as u64)
            .unwrap_or(0);
        let kind = entry.get("kind").and_then(|k| k.as_str()).unwrap_or("");
        let device = entry.get("device").and_then(|d| d.as_str()).unwrap_or("");
        if device.eq_ignore_ascii_case("CUDA_Host") || device.eq_ignore_ascii_case("host") {
            c.host_mib += mib;
            continue;
        }
        match kind {
            "model" => c.model_mib += mib,
            "kv" | "rs" | "rotation" | "dsv4_state" => c.kv_mib += mib,
            _ => c.compute_mib += mib,
        }
    }
    if c.host_mib == 0 {
        if let Some(host) = payload.get("host_self_mib").and_then(|h| h.as_f64()) {
            c.host_mib = host.max(0.0).round() as u64;
        }
    }
    if c.total_mib() + c.host_mib == 0 {
        return None;
    }
    Some(c)
}

async fn ledger_from_port(port: u16) -> Option<OverdriveComponents> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
        .ok()?;
    let payload: serde_json::Value = client
        .get(format!("http://127.0.0.1:{port}/memory"))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()?;
    read_ledger(&payload)
}

/// The ledger of a running engine plus the card's NVML figures, for the OVERDRIVE bar.
#[tauri::command]
pub async fn moe_overdrive_ledger(port: u16, device_index: Option<u32>) -> Result<OverdriveLedger, String> {
    let device = device_index.unwrap_or(0);
    let (used_mib, free_mib) = sample_vram(device);
    let components = ledger_from_port(port).await;
    Ok(OverdriveLedger {
        available: components.is_some(),
        components: components.unwrap_or_default(),
        free_mib: free_mib.unwrap_or(0),
        used_mib: used_mib.unwrap_or(0),
    })
}

/// What the two short benchmark passes leave behind: the VRAM a real request needs on top of the
/// loaded model. Prefill grows the graph for its batch, generation grows it for the draft/verify
/// window - a cache sized on the idle reading alone spills on the first real request.
#[derive(Debug, Clone, Serialize)]
pub struct OverdriveProbe {
    pub device: u32,
    /// Free VRAM after the prefill pass (a long prompt, one token back).
    pub pp_free_mib: u64,
    /// Free VRAM after the generation pass (short prompt, a few dozen tokens).
    pub tg_free_mib: u64,
    /// The tighter of the two - what the cache must be sized against.
    pub free_after_load_mib: u64,
    pub pp_tokens: u64,
    pub tg_tokens: u64,
    pub pp_tps: Option<f64>,
    pub tg_tps: Option<f64>,
    pub reserve_mib: u64,
    /// `free_after_load - reserve`, floored at zero. The cache to write.
    pub recommended_mib: u64,
}

const PROBE_PP_CHARS: usize = 9_000;
const PROBE_TG_TOKENS: u32 = 64;

fn probe_prompt(len: usize) -> String {
    const SENTENCE: &str = "The lighthouse keeper wrote down the date, the hour and the wind, and then he stopped, because the next line would have to say what he had seen. ";
    let mut prompt = String::with_capacity(len + SENTENCE.len());
    while prompt.len() < len {
        prompt.push_str(SENTENCE);
    }
    prompt
}

/// Run a short prefill and a short generation against the *loaded* engine and report the free VRAM
/// after each. No relaunch, no extra engine: the probe uses the running server, so the numbers
/// include the real launch (weights, KV, compute, MTP/DFlash, slots).
#[tauri::command]
pub async fn moe_overdrive_probe(
    port: u16,
    device_index: Option<u32>,
    reserve_mib: Option<u64>,
) -> Result<OverdriveProbe, String> {
    let device = device_index.unwrap_or(0);
    let reserve = reserve_mib.unwrap_or(RESERVE_MIB);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(180))
        .build()
        .map_err(|e| format!("http client: {e}"))?;

    let ask = |prompt: String, n_predict: u32| {
        let client = client.clone();
        async move {
            let body = serde_json::json!({
                "prompt": prompt,
                "n_predict": n_predict,
                "temperature": 0.0,
                "top_k": 1,
                "cache_prompt": false,
                "stream": false,
                "ignore_eos": true,
            });
            let resp = client
                .post(format!("http://127.0.0.1:{port}/completion"))
                .json(&body)
                .send()
                .await
                .map_err(|e| format!("probe request failed: {e}"))?;
            if !resp.status().is_success() {
                return Err(format!("probe returned {}", resp.status()));
            }
            let json: serde_json::Value = resp
                .json()
                .await
                .map_err(|e| format!("probe response was not JSON: {e}"))?;
            let timings = json.get("timings").cloned().unwrap_or_default();
            Ok::<_, String>((timings, n_predict))
        }
    };

    // Prefill pass: a long prompt answered with one token.
    let (pp_timings, _) = ask(probe_prompt(PROBE_PP_CHARS), 1).await?;
    let (_, pp_free) = sample_vram(device);
    let pp_free_mib = pp_free.unwrap_or(0);
    let pp_tokens = pp_timings
        .get("prompt_n")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let pp_tps = pp_timings.get("prompt_per_second").and_then(|v| v.as_f64());

    // Generation pass: small prompt, a few dozen tokens, so the draft/verify graphs grow.
    let (tg_timings, _) = ask(
        "Write one short paragraph about a lighthouse.".to_string(),
        PROBE_TG_TOKENS,
    )
    .await?;
    let (_, tg_free) = sample_vram(device);
    let tg_free_mib = tg_free.unwrap_or(0);
    let tg_tokens = tg_timings
        .get("predicted_n")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    let tg_tps = tg_timings.get("predicted_per_second").and_then(|v| v.as_f64());

    // A zero reading means the probe raced a stopped engine; treat it as "nothing measured".
    if pp_free_mib == 0 && tg_free_mib == 0 {
        return Err("the engine did not answer the probe (no NVML reading after it)".to_string());
    }
    let free_after_load_mib = match (pp_free_mib, tg_free_mib) {
        (0, tg) => tg,
        (pp, 0) => pp,
        (pp, tg) => pp.min(tg),
    };
    Ok(OverdriveProbe {
        device,
        pp_free_mib,
        tg_free_mib,
        free_after_load_mib,
        pp_tokens,
        tg_tokens,
        pp_tps,
        tg_tps,
        reserve_mib: reserve,
        recommended_mib: free_after_load_mib.saturating_sub(reserve),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ledger_folds_kinds_and_takes_the_tighter_probe() {
        let payload = serde_json::json!({
            "host_self_mib": 1234,
            "ledger": [
                { "device": "CUDA0", "kind": "model", "mib": 3900.4 },
                { "device": "CUDA0", "kind": "kv", "mib": 1200 },
                { "device": "CUDA0", "kind": "compute", "mib": 400 },
                { "device": "CUDA0", "kind": "layer_input", "mib": 32 },
                { "device": "CUDA_Host", "kind": "model", "mib": 26800 }
            ]
        });
        let c = read_ledger(&payload).expect("ledger");
        assert_eq!(c.model_mib, 3900);
        assert_eq!(c.kv_mib, 1200);
        // compute includes the layer_input line: nothing falls on the floor.
        assert_eq!(c.compute_mib, 432);
        assert_eq!(c.host_mib, 26800);
        assert_eq!(c.total_mib(), 5532);

        // An empty ledger is "unknown", not zero.
        assert!(read_ledger(&serde_json::json!({ "ledger": [] })).is_none());
    }

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
