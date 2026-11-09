//! What the engine believes about device memory, next to what NVML measures.
//!
//! On Windows/WDDM `cudaMemGetInfo` reports a budget (physical VRAM plus a shared system-memory
//! allowance), not physical occupancy, so `--fit` plans against a card other models already hold
//! and reports "no changes needed". Measured 2026-11-09 with two engines resident: NVML 3,518 MiB
//! free, a fresh llama-server on the same card 36,549 MiB free.
//!
//! `/memory` is the vendor patch that publishes the engine's own view (`foundry/patches/
//! ggml-master-memory-endpoint.patch` and `-memory-ledger`). This module reads it once per launch,
//! logs the gap, and hands the ledger to the recording path so a patched engine measures itself
//! instead of being parsed out of stderr.


use crate::fit_scanner::GpuComponentMib;
use crate::launch_memory_parse::LaunchMemorySnapshot;

/// One device as the engine reports it, mapped onto the host index it was masked to.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineDeviceView {
    pub host_index: u32,
    pub free_mib: u64,
    pub total_mib: u64,
}

/// Which measurement fed a learned row.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MemorySource {
    /// Engine-reported via `/memory` (patched build).
    Core,
    /// Parsed from the engine's stderr (any build).
    Stderr,
}

impl MemorySource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Core => "core",
            Self::Stderr => "stderr",
        }
    }
}

/// Map the engine's device list onto host indices through the `CUDA_VISIBLE_DEVICES` mask.
///
/// A masked engine numbers its devices from zero, so with mask "1" its CUDA0 is host GPU-1. Without
/// the mapping the comparison would silently pair the wrong cards.
pub fn map_engine_devices(mask: &str, engine: &[EngineDeviceView]) -> Vec<EngineDeviceView> {
    let hosts: Vec<u32> = mask
        .split(',')
        .filter_map(|part| part.trim().parse::<u32>().ok())
        .collect();
    engine
        .iter()
        .enumerate()
        .filter_map(|(position, device)| {
            let host_index = if hosts.is_empty() {
                device.host_index
            } else {
                *hosts.get(position)?
            };
            Some(EngineDeviceView {
                host_index,
                free_mib: device.free_mib,
                total_mib: device.total_mib,
            })
        })
        .collect()
}

/// The console line for one launch, or `None` when the engine's view and NVML agree.
///
/// A gap is only interesting when the engine thinks it has more room than the card actually has:
/// that is fit planning against the budget. A negative gap (engine sees less than NVML) is normal
/// and left to the log at info level.
pub fn describe_memory_gap(engine: &[EngineDeviceView], nvml_free_mib: &[(u32, u64)]) -> Option<String> {
    let mut parts = Vec::new();
    for device in engine {
        let Some((_, nvml_free)) = nvml_free_mib.iter().find(|(index, _)| *index == device.host_index)
        else {
            continue;
        };
        let gap = device.free_mib.saturating_sub(*nvml_free);
        if gap < 1024 {
            continue;
        }
        parts.push(format!(
            "GPU-{}: engine sees {:.1} GiB free, NVML {:.1} GiB (gap {:.1} GiB)",
            device.host_index,
            device.free_mib as f64 / 1024.0,
            *nvml_free as f64 / 1024.0,
            gap as f64 / 1024.0
        ));
    }
    if parts.is_empty() {
        return None;
    }
    Some(format!(
        "[fit] {} - fit planned against the WDDM budget, not physical occupancy",
        parts.join("; ")
    ))
}

/// Build the launch snapshot the stderr parser would have produced, from the ledger itself.
///
/// Categories follow the parser so the two can be compared one to one: model weights, KV (+RS,
/// which the engine's breakdown calls "context"), and compute. Host buffers are summed separately
/// because they never count as device memory.
pub fn snapshot_from_memory_payload(body: &serde_json::Value) -> Option<LaunchMemorySnapshot> {
    let ledger = body.get("ledger")?.as_array()?;
    if ledger.is_empty() {
        return None;
    }

    let device_count = body
        .get("devices")
        .and_then(|v| v.as_array())
        .map(|devices| {
            devices
                .iter()
                .filter(|d| d.get("type").and_then(|t| t.as_str()) == Some("GPU"))
                .count()
        })
        .unwrap_or(0)
        .max(1);

    let mut per_gpu = vec![GpuComponentMib { model_mib: 0.0, ctx_mib: 0.0, compute_mib: 0.0 }; device_count];
    let mut host = GpuComponentMib { model_mib: 0.0, ctx_mib: 0.0, compute_mib: 0.0 };

    for item in ledger {
        let device = item.get("device").and_then(|v| v.as_str()).unwrap_or("");
        let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("");
        let mib = item.get("mib").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let is_host = device == "CUDA_Host" || device == "CPU" || device == "Host";
        let index = device
            .strip_prefix("CUDA")
            .and_then(|rest| rest.parse::<usize>().ok());

        let target = if is_host {
            Some(&mut host)
        } else {
            index.and_then(|i| per_gpu.get_mut(i))
        };
        let Some(target) = target else {
            continue;
        };

        match kind {
            "model" => target.model_mib += mib,
            "kv" | "rs" | "dsv4_state" => target.ctx_mib += mib,
            // layer input and h_nextn are graph buffers the sched_reserve line does not fold in.
            _ => target.compute_mib += mib,
        }
    }

    let gpu_breakdown_mib: Vec<f64> = per_gpu
        .iter()
        .map(|c| c.model_mib + c.ctx_mib + c.compute_mib)
        .collect();
    let vram_mib: f64 = gpu_breakdown_mib.iter().sum();
    let host_mib = host.model_mib + host.ctx_mib + host.compute_mib;

    let effective_ctx = body
        .get("params")
        .and_then(|p| p.get("n_ctx"))
        .and_then(|v| v.as_u64())
        .map(|v| v as u32);

    Some(LaunchMemorySnapshot {
        parser_id: "core:memory-endpoint".to_string(),
        requested_ctx: effective_ctx,
        effective_ctx,
        vram_mib,
        gpu_breakdown_mib,
        gpu_components_mib: Some(per_gpu),
        host_mib,
        host_components_mib: Some(host),
        host_pinned_mib: host_mib,
        ..Default::default()
    })
}

/// Read `/memory` once: capture the ledger for the recorder, log the free-memory gap. Never fails a
/// launch, and silently does nothing for an unpatched engine.
pub fn spawn_probe(port: u16, gpu_mask: &str) {
    let mask = gpu_mask.to_string();
    tokio::spawn(async move {
        let url = format!("http://127.0.0.1:{port}/memory");
        let client = match reqwest::Client::builder()
            .timeout(std::time::Duration::from_secs(2))
            .build()
        {
            Ok(client) => client,
            Err(_) => return,
        };
        // `/health` can answer before the model finishes loading, and the ledger only fills as the
        // buffers are allocated. Poll until it is populated instead of probing once.
        let mut payload: Option<serde_json::Value> = None;
        for attempt in 0..60 {
            if attempt > 0 {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
            }
            let Ok(response) = client.get(&url).send().await else {
                break;
            };
            if !response.status().is_success() {
                break;
            }
            let Ok(body) = response.json::<serde_json::Value>().await else {
                break;
            };
            let has_ledger = body
                .get("ledger")
                .and_then(|v| v.as_array())
                .map(|entries| !entries.is_empty())
                .unwrap_or(false);
            payload = Some(body);
            if has_ledger {
                break;
            }
        }
        let Some(body) = payload else {
            return;
        };



        let Some(devices) = body.get("devices").and_then(|v| v.as_array()) else {
            return;
        };
        let engine: Vec<EngineDeviceView> = devices
            .iter()
            .filter(|d| d.get("type").and_then(|t| t.as_str()) == Some("GPU"))
            .enumerate()
            .map(|(position, d)| EngineDeviceView {
                host_index: position as u32,
                free_mib: d.get("free_mib").and_then(|v| v.as_u64()).unwrap_or(0),
                total_mib: d.get("total_mib").and_then(|v| v.as_u64()).unwrap_or(0),
            })
            .collect();
        let mapped = map_engine_devices(&mask, &engine);
        let nvml_free: Vec<(u32, u64)> = crate::nvml_metrics::scan()
            .unwrap_or_default()
            .iter()
            .map(|gpu| (gpu.index, gpu.memory_free_mib))
            .collect();
        let Some(line) = describe_memory_gap(&mapped, &nvml_free) else {
            return;
        };
        log::warn!("{line}");
        if let Some(handle) = crate::nvram_snapshot::app_handle() {
            use tauri::Manager;
            let ctx = handle.state::<crate::engine::AppContext>();
            ctx.blackwell_output_console_manager.emit_line_to_category(
                crate::output_console::BlackwellOutputConsoleCategory::Engines,
                line,
                crate::output_console::BlackwellOutputConsoleLineStyle::Warning,
            );
        }
    });
}

/// Compare the engine-reported snapshot with the stderr parse and log the disagreement.
///
/// Both sides describe the same launch, so a difference means one of them is wrong; that is the
/// evidence needed before the parser can be deleted (or the endpoint trusted blindly).
pub fn log_source_comparison(
    slot: usize,
    core: &LaunchMemorySnapshot,
    parsed: &LaunchMemorySnapshot,
) -> bool {
    let device_delta = (core.vram_mib - parsed.vram_mib).abs();
    let host_delta = (core.host_mib - parsed.host_mib).abs();

    let component_delta = {
        let mut worst = 0.0_f64;
        if let (Some(a), Some(b)) = (core.gpu_components_mib.as_ref(), parsed.gpu_components_mib.as_ref()) {
            for (x, y) in a.iter().zip(b.iter()) {
                worst = worst
                    .max((x.model_mib - y.model_mib).abs())
                    .max((x.ctx_mib - y.ctx_mib).abs())
                    .max((x.compute_mib - y.compute_mib).abs());
            }
        }
        worst
    };

    if device_delta <= 32.0 && host_delta <= 64.0 && component_delta <= 32.0 {
        log::info!(
            "[memory] slot={} source=core (endpoint and stderr agree: GPU {:.0} MiB, host {:.0} MiB)",
            slot,
            core.vram_mib,
            core.host_mib
        );
        return true;
    }

    log::warn!(
        "[memory] slot={} endpoint vs stderr: GPU {:.0}/{:.0} MiB (delta {:.0}), host {:.0}/{:.0} MiB (delta {:.0}), worst component delta {:.0} MiB - recording the endpoint",
        slot,
        core.vram_mib,
        parsed.vram_mib,
        device_delta,
        core.host_mib,
        parsed.host_mib,
        host_delta,
        component_delta
    );
    false
}

/// Ask a loaded engine for its ledger and turn it into a launch snapshot.
///
/// Called by the recorder itself: at that point the model is loaded and the ledger is complete, so
/// there is no race with the ready hook.
pub async fn fetch_core_snapshot(port: u16) -> Option<LaunchMemorySnapshot> {
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(2))
        .build()
        .ok()?;
    let response = client
        .get(format!("http://127.0.0.1:{port}/memory"))
        .send()
        .await
        .ok()?;
    if !response.status().is_success() {
        return None;
    }
    let body = response.json::<serde_json::Value>().await.ok()?;
    snapshot_from_memory_payload(&body)
}

/// Tell the UI which measurement path this slot is on (`memory-source` event).
pub fn emit_source(slot: usize, source: MemorySource, agrees: bool) {
    let Some(handle) = crate::nvram_snapshot::app_handle() else {
        return;
    };
    use tauri::Emitter;
    let _ = handle.emit(
        "memory-source",
        serde_json::json!({ "slot": slot, "source": source.as_str(), "agrees": agrees }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_masked_engine_maps_back_to_the_host_card() {
        // Masked to host GPU-1, the engine calls it CUDA0.
        let engine = vec![EngineDeviceView {
            host_index: 0,
            free_mib: 36_549,
            total_mib: 97_859,
        }];
        let mapped = map_engine_devices("1", &engine);
        assert_eq!(mapped.len(), 1);
        assert_eq!(mapped[0].host_index, 1);
    }

    #[test]
    fn an_inflated_free_number_is_reported_with_both_values() {
        let engine = vec![EngineDeviceView {
            host_index: 1,
            free_mib: 36_549,
            total_mib: 97_859,
        }];
        let line = describe_memory_gap(&engine, &[(1, 3_518)]).expect("gap is reported");
        assert!(line.contains("GPU-1"));
        assert!(line.contains("engine sees 35.7 GiB free"));
        assert!(line.contains("NVML 3.4 GiB"));
        assert!(line.contains("WDDM budget"));
    }

    #[test]
    fn agreement_or_a_smaller_engine_view_is_not_reported() {
        let engine = vec![EngineDeviceView {
            host_index: 0,
            free_mib: 4_000,
            total_mib: 97_859,
        }];
        assert!(describe_memory_gap(&engine, &[(0, 4_200)]).is_none());
        assert!(describe_memory_gap(&engine, &[(0, 3_500)]).is_none());
    }

    /// The ledger from the patched 27B build (2026-11-09), where the exit table said
    /// `9685 model + 16533 context + 2056 compute`.
    #[test]
    fn the_ledger_rebuilds_the_same_categories_the_parser_reports() {
        let body = serde_json::json!({
            "devices": [
                { "index": 0, "name": "CUDA0", "type": "GPU", "total_mib": 97859, "free_mib": 61625 },
                { "index": 1, "name": "CPU", "type": "CPU", "total_mib": 252976, "free_mib": 216767 },
            ],
            "params": { "n_ctx": 262144 },
            "ledger": [
                { "device": "CUDA0", "tag": "load_tensors", "kind": "model", "mib": 9685.21 },
                { "device": "CUDA_Host", "tag": "load_tensors", "kind": "model", "mib": 397.85 },
                { "device": "CUDA_Host", "tag": "llama_context", "kind": "output", "mib": 0.95 },
                { "device": "CUDA0", "tag": "llama_kv_cache", "kind": "kv", "mib": 16384.0 },
                { "device": "CUDA0", "tag": "llama_memory_recurrent", "kind": "rs", "mib": 149.62 },
                { "device": "CUDA0", "tag": "sched_reserve", "kind": "compute", "mib": 6528.31 },
                { "device": "CUDA_Host", "tag": "sched_reserve", "kind": "compute", "mib": 4736.38 },
            ],
        });

        let snapshot = snapshot_from_memory_payload(&body).expect("ledger present");
        assert_eq!(snapshot.parser_id, "core:memory-endpoint");
        assert_eq!(snapshot.effective_ctx, Some(262_144));

        let gpu = &snapshot.gpu_components_mib.as_ref().unwrap()[0];
        assert!((gpu.model_mib - 9_685.21).abs() < 0.01);
        assert!((gpu.ctx_mib - 16_533.62).abs() < 0.01);
        assert!((gpu.compute_mib - 6_528.31).abs() < 0.01);

        let host = snapshot.host_components_mib.as_ref().unwrap();
        assert!((host.model_mib - 397.85).abs() < 0.01);
        assert!((host.compute_mib - 4_737.33).abs() < 0.01);
        assert!((snapshot.vram_mib - 32_747.14).abs() < 0.05);
        assert!((snapshot.host_mib - 5_135.18).abs() < 0.05);
    }

    #[test]
    fn an_empty_ledger_is_not_a_snapshot() {
        let body = serde_json::json!({ "devices": [], "ledger": [] });
        assert!(snapshot_from_memory_payload(&body).is_none());
    }
}
