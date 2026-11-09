//! What the engine believes about device memory, next to what NVML measures.
//!
//! On Windows/WDDM `cudaMemGetInfo` reports a budget (physical VRAM plus a shared system-memory
//! allowance), not physical occupancy, so `--fit` plans against a card other models already hold
//! and reports "no changes needed". Measured 2026-11-09 with two engines resident: NVML 3,518 MiB
//! free, a fresh llama-server on the same card 36,549 MiB free.
//!
//! `/memory` is the vendor patch that publishes the engine's own view (`foundry/patches/
//! ggml-master-memory-endpoint.patch`). This module reads it once per launch and logs the gap, so
//! the next "fit said there was room" is answered by numbers in our own console instead of by
//! reading engine stderr after the fact.

/// One device as the engine reports it, mapped onto the host index it was masked to.
#[derive(Debug, Clone, PartialEq)]
pub struct EngineDeviceView {
    pub host_index: u32,
    pub free_mib: u64,
    pub total_mib: u64,
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

/// Read `/memory` once, compare with NVML and log the gap. Never fails a launch.
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
        let Ok(response) = client.get(&url).send().await else {
            // Unpatched engine, or it is already gone. Nothing to say.
            return;
        };
        if !response.status().is_success() {
            return;
        }
        let Ok(body) = response.json::<serde_json::Value>().await else {
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
}
