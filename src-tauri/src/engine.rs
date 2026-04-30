use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;
use tokio::sync::{broadcast, Mutex};
use tokio::sync::Mutex as TokioMutex;


use crate::engine_stack::SlotStatus;
use crate::config::AppConfig;
use crate::engine_stack::EngineStack;
use crate::log_hub::LogHub;
use crate::types::{EngineConfig, ModelEntry};
use crate::vram::{self, VramCalcConfig, VramFitResult};
use crate::fit_scanner;
use crate::telemetry;
use crate::engine_perf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StackEntryOut {
    pub idx: usize,
    pub alias: String,
    pub model_name: String,
    pub port: u16,
    pub gpu: String,
    pub status: String,
    #[serde(default)]
    pub slot_id: u32,
    #[serde(default = "default_provider_type")]
    pub provider_type: String,
    #[serde(default)]
    pub model_path: String,
    #[serde(default)]
    pub vram_mib: f64,
    #[serde(default = "default_ctx_size")]
    pub n_ctx: usize,
    /// Provider display name (e.g. "GGML Stable")
    #[serde(default)]
    pub provider_name: String,
    /// Build info for the running engine's provider (CUDA version, build date)
    #[serde(default)]
    pub build_info: Option<crate::types::BuildInfo>,
}

fn default_provider_type() -> String { "ggml-stable".to_string() }
fn default_ctx_size() -> usize { 32768 }

// ── Shared App State (Single Source of Truth) ────────────────────────
// All engine state, config, and log routing flow through this struct.
// No global variables — everything is Arc<Mutex<>> managed by Tauri.

pub struct AppContext {
    pub stack: Arc<Mutex<EngineStack>>,
    pub log_hub: LogHub,
    pub config: Arc<std::sync::Mutex<AppConfig>>,
    /// Cancellation flag for in-progress library scans.
    pub fit_scan_cancel: Arc<TokioMutex<Arc<AtomicBool>>>,
}

// ── Model Catalog (ported from tower_models.py) ─────────────────────

#[tauri::command]
pub async fn list_models(model_base: Option<String>) -> Result<Vec<ModelEntry>, String> {
    let base = model_base.unwrap_or_else(|| {
        r"C:\Users\GHOST-TOWER\.lmstudio\models".to_string()
    });

    get_model_catalog(&PathBuf::from(&base)).map_err(|e| e.to_string())
}

fn get_model_catalog(base_path: &PathBuf) -> Result<Vec<ModelEntry>, String> {
    let mut temp_catalog: std::collections::HashMap<String, crate::types::ModelEntryInternal> = std::collections::HashMap::new();

    if !base_path.exists() {
        return Ok(Vec::new());
    }

    for author_entry in std::fs::read_dir(base_path).map_err(|e| e.to_string())? {
        let author_entry = author_entry.map_err(|e| e.to_string())?;
        let author_path = author_entry.path();
        if !author_path.is_dir() {
            continue;
        }

        let author = author_path
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("unknown")
            .to_string();

        for model_dir_entry in std::fs::read_dir(&author_path).map_err(|e| e.to_string())? {
            let model_dir_entry = model_dir_entry.map_err(|e| e.to_string())?;
            let model_path = model_dir_entry.path();
            if !model_path.is_dir() {
                continue;
            }

            let model_dir_name = model_path
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("unknown")
                .to_string();

            // Find mmproj file in this folder
            let mut mmproj_file: Option<String> = None;
            let mut mmproj_size: u64 = 0;
            if let Ok(files) = std::fs::read_dir(&model_path) {
                for f_entry in files.flatten() {
                    let fname = f_entry.file_name();
                    let fname_str = fname.to_string_lossy().to_lowercase();
                    if fname_str.contains("mmproj") {
                        mmproj_file = Some(fname.to_string_lossy().to_string());
                        if let Ok(meta) = std::fs::metadata(f_entry.path()) {
                            mmproj_size = meta.len();
                        }
                    }
                }
            }

            for f_entry in std::fs::read_dir(&model_path).map_err(|e| e.to_string())? {
                let f_entry = f_entry.map_err(|e| e.to_string())?;
                let fname = f_entry.file_name();
                let fname_str = fname.to_string_lossy().to_string();

                if !fname_str.to_lowercase().ends_with(".gguf")
                    || fname_str.to_lowercase().contains("mmproj")
                {
                    continue;
                }

                // Strip shard pattern: -00001-of-00002
                let base_name = strip_shard_pattern(&fname_str);
                let file_path = f_entry.path();

                let full_id = format!("{author}/{model_dir_name}/{base_name}");

                if let Some(existing) = temp_catalog.get_mut(&full_id) {
                    // Sharded model — accumulate sizes
                    if let Ok(meta) = std::fs::metadata(&file_path) {
                        existing.model_bytes += meta.len();
                        existing.total_bytes += meta.len();
                        existing.shards += 1;
                    }
                } else {
                    let file_size = std::fs::metadata(&file_path)
                        .map(|m| m.len())
                        .unwrap_or(0);

                    let quant = extract_quant(&base_name);
                    let size_str = calc_size_str_from_bytes(file_size + mmproj_size);

                    // Store full absolute path to the GGUF file for downstream validation
                    let abs_path = file_path.to_string_lossy().to_string();

                    temp_catalog.insert(full_id, crate::types::ModelEntryInternal {
                        path: abs_path.clone(),
                        author: author.clone(),
                        name: model_dir_name.replace("-GGUF", "").replace("-gguf", ""),
                        quant,
                        size_str,
                        vision: mmproj_file.is_some(),
                        mmproj: mmproj_file.clone(),
                        model_bytes: file_size,
                        total_bytes: file_size + mmproj_size,
                        shards: 1,
                    });
                }
            }
        }
    }

    // Deduplicate: keep only the largest entry per unique key (author/name/quant).
    let mut deduped: std::collections::HashMap<String, crate::types::ModelEntryInternal> = std::collections::HashMap::new();
    for internal in temp_catalog.into_values() {
        let key = format!("{}|{}|{}", internal.author, internal.name, internal.quant);
        let total_bytes = internal.total_bytes;
        if let Some(existing) = deduped.get_mut(&key) {
            if total_bytes > existing.total_bytes {
                *existing = internal;
            }
        } else {
            deduped.insert(key, internal);
        }
    }

    let final_catalog: Vec<ModelEntry> = deduped.into_values()
        .map(|internal| {
            let size_str = calc_size_str_from_bytes(internal.total_bytes);
            ModelEntry {
                path: internal.path,
                author: internal.author,
                name: internal.name,
                quant: internal.quant,
                size_str,
                vision: internal.vision,
                mmproj: internal.mmproj,
                backend_type: String::new(), // Will be set by frontend or default to "ggml-stable"
            }
        })
        .collect();
    
    Ok(final_catalog)
}

pub fn strip_shard_pattern(filename: &str) -> String {
    if !filename.ends_with(".gguf") {
        return filename.to_string();
    }

    let without_ext = &filename[..filename.len() - 5];

    if let Some(of_pos) = find_case_insensitive_rfind(without_ext, "-of-") {
        let after_of = &without_ext[of_pos + 4..];
        if !after_of.is_empty() && after_of.chars().all(|c| c.is_ascii_digit()) {
            let before_of = &without_ext[..of_pos];
            if let Some(shard_pos) = before_of.rfind('-') {
                let shard_num = &before_of[shard_pos + 1..];
                if shard_num.chars().all(|c| c.is_ascii_digit()) && shard_num.len() >= 3 {
                    return format!("{}.gguf", &before_of[..shard_pos]);
                }
            }
            return format!("{}.gguf", before_of);
        }
    }

    if let Some(part_pos) = find_case_insensitive_rfind(without_ext, "-part-") {
        let after_part = &without_ext[part_pos + 6..];
        if !after_part.is_empty() && after_part.chars().all(|c| c.is_ascii_digit()) {
            return format!("{}.gguf", &without_ext[..part_pos]);
        }
    }

    let parts: Vec<&str> = without_ext.rsplitn(2, '-').collect();
    if parts.len() >= 2 {
        let suffix = parts[0];
        if suffix.chars().all(|c| c.is_ascii_digit()) && suffix.len() >= 3 {
            return format!("{}.gguf", &without_ext[..without_ext.len() - suffix.len() - 1]);
        }
    }

    filename.to_string()
}

/// Find the last occurrence of `pattern` in `s`, case-insensitive.
fn find_case_insensitive_rfind(s: &str, pattern: &str) -> Option<usize> {
    let s_lower = s.to_lowercase();
    let p_lower = pattern.to_lowercase();
    if pattern.is_empty() || pattern.len() > s_lower.len() {
        return None;
    }
    for i in (0..=s_lower.len() - pattern.len()).rev() {
        if &s_lower[i..i + pattern.len()] == p_lower {
            return Some(i);
        }
    }
    None
}

fn extract_quant(filename: &str) -> String {
    if !filename.ends_with(".gguf") {
        return fallback_quant(filename);
    }

    let without_ext = &filename[..filename.len() - 5];
    let lower = filename.to_lowercase();

    if lower.contains("bf16") {
        return "BF16".to_string();
    }
    if lower.contains("f16") && !lower.contains("q8_0") && !lower.contains("q4_") {
        let parts: Vec<&str> = filename.split('.').collect();
        for part in parts.iter().rev() {
            if part.to_lowercase() == "f16" || part.to_lowercase() == "bf16" {
                return part.to_string();
            }
        }
    }

    if lower.contains("mxfp4") {
        return "MXFP4".to_string();
    }

    let chars: Vec<char> = without_ext.chars().collect();
    for i in (1..chars.len()).rev() {
        if chars[i] == 'B' || chars[i] == 'b' {
            if i > 0 && chars[i - 1].is_ascii_digit() {
                if i + 1 < chars.len() && (chars[i + 1] == '-' || chars[i + 1] == '.') {
                    let suffix = &without_ext[i + 2..];
                    if !suffix.is_empty() {
                        let known_quants = [
                            "Q8_0", "Q8_K", "Q6_K", 
                            "Q5_0", "Q5_1", "Q5_K_M", "Q5_K_S",
                            "Q4_0", "Q4_1", "Q4_K_M", "Q4_K_S",
                            "Q3_K_M", "Q3_K_S", "Q2_K",
                            "IQ4_NL", "IQ3_S", "IQ3_M", "IQ3_XS", "IQ3_XXS",
                            "IQ2_S", "IQ2_XS", "IQ2_MS", "IQ2_L",
                            "IQ1_S", "IQ1_NL",
                            "FP8_E4M3", "FP8_E5M2",
                        ];

                        let suffix_lower = suffix.to_lowercase();
                        for pattern in &known_quants {
                            if suffix_lower.contains(&pattern.to_lowercase()) {
                                return pattern.to_string();
                            }
                        }

                        return fallback_quant(filename);
                    }
                }
            }
        }
    }

    fallback_quant(filename)
}

fn fallback_quant(filename: &str) -> String {
    let lower = filename.to_lowercase();

    if lower.contains("bf16") {
        return "BF16".to_string();
    }
    if lower.contains("f16") && !lower.contains("q8_0") && !lower.contains("q4_") {
        let parts: Vec<&str> = filename.split('.').collect();
        for part in parts.iter().rev() {
            if part.to_lowercase() == "f16" || part.to_lowercase() == "bf16" {
                return part.to_string();
            }
        }
    }

    if lower.contains("mxfp4") {
        return "MXFP4".to_string();
    }

    let without_ext = filename.trim_end_matches(".gguf");
    
    let segments: Vec<&str> = without_ext.split(|c: char| c == '-' || c == '.').collect();
    
    let known_quants = [
        "Q8_0", "Q8_K", "Q6_K", 
        "Q5_0", "Q5_1", "Q5_K_M", "Q5_K_S",
        "Q4_0", "Q4_1", "Q4_K_M", "Q4_K_S",
        "Q3_K_M", "Q3_K_S", "Q2_K",
        "IQ4_NL", "IQ3_S", "IQ3_M", "IQ3_XS", "IQ3_XXS",
        "IQ2_S", "IQ2_XS", "IQ2_MS", "IQ2_L",
        "IQ1_S", "IQ1_NL",
        "FP8_E4M3", "FP8_E5M2",
    ];

    let mut best_match: Option<&str> = None;
    let mut best_len = 0;
    
    for seg in &segments {
        if seg.is_empty() || seg.len() < 3 { continue; }
        let seg_lower = seg.to_lowercase();
        
        for pattern in &known_quants {
            if seg_lower.contains(&pattern.to_lowercase()) {
                if seg.len() > best_len {
                    best_match = Some(pattern);
                    best_len = seg.len();
                }
                break;
            }
        }
    }

    if let Some(m) = best_match {
        return m.to_string();
    }

    if let Some(last_seg) = segments.last() {
        if !last_seg.is_empty() && last_seg.len() >= 3 {
            if lower.contains("q") || lower.contains("iq") {
                return last_seg.to_string();
            }
        }
    }

    "GGUF".to_string()
}

fn calc_size_str_from_bytes(total_bytes: u64) -> String {
    format!("{:.1}GB", total_bytes as f64 / (1024.0_f64.powi(3)))
}

// ── Engine Management Commands ──────────────────────────────────────

#[tauri::command]
pub async fn launch_engine(
    config: EngineConfig,
    _model_base: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<StackEntryOut, String> {
    // Resolve backend provider by type (falls back to "ggml-stable" if empty/missing)
    let backend_type = if config.backend_type.is_empty() {
        "ggml-stable".to_string()
    } else {
        config.backend_type.clone()
    };

    // Load app config for binary path resolution — drop lock before async await
    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    // Resolve binary path from config — check providers list first, then fallback to llama_path
    let binary_path = find_provider_binary(&cfg, &backend_type);

    // Load template for this provider and apply data-driven defaults
    let template = crate::templates::ProviderTemplate::load_by_id(&backend_type)
        .unwrap_or_else(crate::templates::ProviderTemplate::load);

    // Find the matching provider's params JSON for default resolution
    let provider_opt2 = cfg.providers.iter().find(|p| p.id == backend_type);
    let provider_params = provider_opt2.map(|p| &p.params);

    // Also grab param_definitions — these are the source of truth for user-selected values
    // (per AGENTS.md: no delta/overlay, param_definitions IS the selected-value store)
    let param_defs_ref: Option<&[crate::types::ParamDef]> =
        provider_opt2.map(|p| p.param_definitions.as_slice());

    // Merge provider default params into the user's EngineConfig (data-driven from template).
    // User selections in the catalog override these defaults; missing keys fall back here.
    let mut config = template.apply_provider_defaults(&config, provider_params);

    // Determine GPU mask early — needed for template command building.
    // Also check __test_args (DEV shortcut raw flags) for split-mode indicators.
    let test_has_split = config.extra_params.get("__test_args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.windows(2).any(|w| {
                w[0].as_str().map(|s| s == "-sm" || s == "--split-mode").unwrap_or(false)
                    && w.get(1).and_then(|s| s.as_str()).map(|v| {
                        !matches!(v.to_uppercase().as_str(), "NONE" | "0")
                    }).unwrap_or(false)
            })
        }).unwrap_or(false);

    let gpu_mask = if config.device == "GPU-1" {
        "1".to_string()
    } else if (!config.split_mode.is_empty() && config.split_mode.to_uppercase() != "NONE") || test_has_split {
        "0,1".to_string()
    } else {
        "0".to_string()
    };

    eprintln!("[GPU_MASK] provider={} split_mode=\"{}\" test_has_split={} -> CUDA_VISIBLE_DEVICES={}", backend_type, config.split_mode, test_has_split, gpu_mask);

    // Validate the resolved binary path exists
    crate::config::validate_provider_binary(binary_path.to_str().unwrap_or(""))?;

    // Hardware guardrail: validate model file exists before attempting launch
    crate::config::validate_model_path(&config.model_path)?;

    let stack = app.stack.lock().await;

    // Find first idle slot
    let slot_idx = stack.find_idle_slot().ok_or("All 4 slots are occupied")?;

    // Use pre-assigned port from EngineStack if config.port is 0
    let slot_port = if config.port == 0 {
        stack.get_slot(slot_idx).map(|s| s.port).unwrap_or(config.port)
    } else {
        config.port
    };

    // Resolve port into config BEFORE building command args
    config.port = slot_port;

    // Pre-launch port cleanup: kill any zombie process holding this slot's port
    drop(stack);

    let ps_script = format!(
        r"$pids = netstat -ano | Select-String ':{0} ' | ForEach-Object {{ ($_ -split '\s+')[-1] }}; $pids | Where-Object {{ $_.Length -gt 0 -and $_ -ne '0' }} | ForEach-Object {{ taskkill /F /PID $_ 2>$null }}",
        slot_port
    );
    let _ = tokio::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
        .output()
        .await;

    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut stack = app.stack.lock().await;

    let provider_display_name = backend_type.clone();

    // Build CLI args from template — param_defs passed so get_value() can use user-selected values
    let cmd_args = template.build_command(&config, &gpu_mask, param_defs_ref);

    // Print launch command to stderr for debugging (visible in console)
    let launch_cmd = format!("{} {}", binary_path.display(), cmd_args.join(" "));
    eprintln!("\n========== [LAUNCH_CMD] slot={} ==========", slot_idx);
    eprintln!("{}", launch_cmd);
    eprintln!("==========================================\n");
    
    // Write launch command to temp file as fallback for debugging
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(r"C:\tmp\blackwell-launch.log") {
        use std::io::Write;
        let _ = writeln!(f, "\n[{}] slot={} CMD:\n{}\n", chrono::Local::now().format("%H:%M:%S%.3f"), slot_idx, launch_cmd);
    }

    // Emit launch system event — visible even if process crashes instantly
    app.log_hub.emit_system_event(slot_idx, &config.alias, "Engine launching...").await;

    // Spawn process into the slot via provider strategy (both locks held briefly)
    // config.port is already resolved to slot_port at this point
    stack.load_slot_with_args(slot_idx, &config, &binary_path, gpu_mask.clone(), cmd_args.clone(), provider_display_name.clone(), backend_type.clone()).await?;

    // Pipe combined stdout+stderr to Engine Performance Pulse via ConPTY mpsc channel
    let combined_rx = stack.take_combined_output(slot_idx).await;
    
    let ctx_size_int = crate::templates::ProviderTemplate::ctx_to_int_str(&config.ctx_size)
        .parse::<usize>().unwrap_or(32768);
    
    if combined_rx.is_some() {
        eprintln!("[LAUNCH] slot={} ConPTY combined output captured", slot_idx);
        
        let perf_log_hub = app.log_hub.clone();
        let perf_alias = config.alias.clone();
        let perf_slot = slot_idx;
        
        tokio::spawn(async move {
            engine_perf::start_perf_reader_from_channel(
                perf_log_hub, perf_slot, perf_alias, combined_rx.unwrap(), ctx_size_int
            ).await;
        });
    } else {
        eprintln!("[LAUNCH] slot={} ConPTY output was None — process may have already exited", slot_idx);
    }

    // Spawn background health checker with panic protection
    let stack_arc = app.stack.clone();
    let hp_port = slot_port;
    tokio::spawn(async move {
        let mut attempts = 0u32;
        loop {
            if attempts >= 45 { break; }
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

            {
                let s = stack_arc.lock().await;
                match s.get_slot(slot_idx) {
                    None => break,
                    Some(slot) => match &slot.status {
                        SlotStatus::Running | SlotStatus::Error(_) => break,
                        SlotStatus::Loading => {}
                        SlotStatus::Idle => break,
                    },
                }
            }

            let mut s = stack_arc.lock().await;
            let mut crashed = false;

            if let Some(slot) = s.get_slot_mut(slot_idx) {
                if let Some(ref mut conpty_proc) = slot.conpty_proc {
                    if !conpty_proc.is_alive() {
                        let exit_code = conpty_proc.wait(None).unwrap_or(u32::MAX);
                        log::error!("slot={} ConPTY process exited while Loading — crashed (exit code: {})", slot_idx, exit_code);
                        slot.status = SlotStatus::Error(format!("process exited unexpectedly (code={})", exit_code));
                        crashed = true;
                    }
                }
            }

            if crashed { break; }
            drop(s);

            let health_url = format!("http://127.0.0.1:{}/health", hp_port);
            match reqwest::get(&health_url).await {
                Ok(resp) if resp.status().is_success() => {
                    let mut s = stack_arc.lock().await;
                    if let Some(slot) = s.get_slot_mut(slot_idx) {
                        slot.status = SlotStatus::Running;
                    }
                    break;
                }
                Err(e) => {
                    log::debug!("slot={} health check attempt {} failed: {}", slot_idx, attempts + 1, e);
                }
                _ => {}
            }
            attempts += 1;
        }
    });

    let model_name = config.model_path.rsplit('/').next().unwrap_or("unknown").to_string();

    Ok(StackEntryOut {
        idx: slot_idx,
        alias: config.alias.clone(),
        model_name,
        port: slot_port,
        gpu: gpu_mask,
        status: "LOADING".to_string(),
        slot_id: slot_idx as u32,
        provider_type: backend_type,
        model_path: config.model_path.clone(),
        vram_mib: 0.0,
        n_ctx: ctx_size_int,
        provider_name: provider_display_name,
        build_info: None,
    })
}

fn find_provider_binary(cfg: &AppConfig, provider_id: &str) -> PathBuf {
    // Check registered providers first
    for p in &cfg.providers {
        if p.id == provider_id && !p.binary_path.is_empty() {
            return PathBuf::from(&p.binary_path);
        }
    }

    // Ultimate fallback — use the first registered provider's binary or default path
    if let Some(first) = cfg.providers.first() {
        PathBuf::from(&first.binary_path)
    } else {
        cfg.llama_path.clone()
    }
}

#[tauri::command]
pub async fn stop_engine(alias: String, app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let slot_idx = {
        let mut stack = app.stack.lock().await;
        let slot_count = stack.slots.len();
        let idx = (0..slot_count).find(|&i| {
            stack.get_slot(i).map_or(false, |s| s.alias == alias)
        }).ok_or(format!("Engine '{}' not found", alias))?;
        stack.stop_slot(idx).await?;
        idx
    }; // Lock released before emitting
    app.log_hub.emit("slot-cleared", &serde_json::json!({ "slot": slot_idx }));

    Ok(format!("Engine {} stopped", alias))
}

pub async fn stop_engine_by_alias(
    alias: String,
    stack: Arc<Mutex<EngineStack>>,
) -> Result<usize, String> {
    let mut s = stack.lock().await;
    let slot_count = s.slots.len();
    let idx = (0..slot_count)
        .find(|&i| s.get_slot(i).map_or(false, |sl| sl.alias == alias))
        .ok_or_else(|| format!("Engine '{}' not found", alias))?;
    s.stop_slot(idx).await?;
    Ok(idx)
}

#[tauri::command]
pub async fn stop_all_engines(app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let stopped_slots = {
        let mut stack = app.stack.lock().await;
        let slot_count = stack.slots.len();
        let count = (0..slot_count).filter(|&i| {
            stack.get_slot(i).map_or(false, |s| !matches!(s.status, SlotStatus::Idle))
        }).count();

        let mut stopped = Vec::new();
        for i in 0..slot_count {
            if count > 0 && !stack.get_slot(i).map_or(true, |s| matches!(s.status, SlotStatus::Idle)) {
                let _ = stack.stop_slot(i).await;
                stopped.push(i);
            }
        }
        stopped
    }; // Lock released before emitting events

    for i in &stopped_slots {
        app.log_hub.emit("slot-cleared", &serde_json::json!({ "slot": *i }));
    }

    Ok(format!("All {} engines stopped", stopped_slots.len()))
}

/// Stops all running engines for a specific provider (by backend_type).
#[tauri::command]
pub async fn stop_engines_by_provider(provider_id: String, app: tauri::State<'_, AppContext>) -> Result<String, String> {
    let stopped_slots = {
        let mut stack = app.stack.lock().await;
        stack.stop_slots_by_provider(&provider_id).await
    };

    for slot_idx in &stopped_slots {
        app.log_hub.emit("slot-cleared", &serde_json::json!({ "slot": slot_idx }));
    }

    Ok(format!("Stopped {} engine(s) for '{}'", stopped_slots.len(), provider_id))
}

#[tauri::command]
pub async fn get_stack_status(app: tauri::State<'_, AppContext>) -> Result<Vec<StackEntryOut>, String> {
    let stack = app.stack.lock().await;
    let engine_entries = stack.get_status();

    // Build a lookup map from provider id → build_info
    let cfg_guard = app.config.lock().map_err(|e| e.to_string())?;
    let build_map: std::collections::HashMap<String, &crate::types::BuildInfo> = cfg_guard.providers.iter()
        .filter(|p| !p.build_info_per_env.is_empty())
        .flat_map(|p| {
            p.build_info_per_env.iter().map(move |(env_label, info)| {
                (format!("{}:{}", p.id, env_label), info)
            }).collect::<Vec<_>>()
        })
        .chain(cfg_guard.providers.iter().filter_map(|p| {
            // Also allow lookup by provider id alone if it has build info
            if !p.build_info_per_env.is_empty() {
                let first = p.build_info_per_env.values().next();
                first.map(|info| (p.id.clone(), info))
            } else {
                None
            }
        }))
        .collect();

    let entries: Vec<StackEntryOut> = engine_entries.into_iter()
        .map(|e| {
            let build_info = if e.status == "RUNNING" && !e.provider_type.is_empty() {
                build_map.get(&e.provider_type).cloned().cloned()
                    .or_else(|| build_map.get(&format!("{}:stable", e.provider_type)).cloned().cloned())
            } else {
                None
            };
            StackEntryOut {
                idx: e.idx,
                alias: e.alias.clone(),
                model_name: e.model_name.clone(),
                port: e.port,
                gpu: e.gpu.clone(),
                status: e.status.clone(),
                slot_id: e.slot_id,
                provider_type: e.provider_type.clone(),
                model_path: e.model_path.clone(),
                vram_mib: e.vram_mib,
                n_ctx: e.n_ctx,
                provider_name: e.provider_name.clone(),
                build_info,
            }
        })
        .collect();

    Ok(entries)
}

#[tauri::command]
pub async fn clean_exit(app: tauri::State<'_, AppContext>) -> Result<(), String> {
    log::info!("Clean exit requested — killing all orphaned processes");

    let mut stack = app.stack.lock().await;
    stack.kill_all().await;
    Ok(())
}

/// Hot-swaps a model in an existing slot using template-driven CLI args.
#[tauri::command]
pub async fn hot_swap_engine(
    alias: String,
    config: EngineConfig,
    app: tauri::State<'_, AppContext>,
) -> Result<StackEntryOut, String> {
    // Resolve backend provider by type (falls back to "ggml-stable" if empty/missing)
    let backend_type = if config.backend_type.is_empty() {
        "ggml-stable".to_string()
    } else {
        config.backend_type.clone()
    };

    // Load app config for binary path resolution — drop lock before async await
    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    // Resolve binary path from config
    let binary_path = find_provider_binary(&cfg, &backend_type);

    // Load template for this provider and apply data-driven defaults
    let template = crate::templates::ProviderTemplate::load_by_id(&backend_type)
        .unwrap_or_else(crate::templates::ProviderTemplate::load);

    let provider_opt_hs = cfg.providers.iter().find(|p| p.id == backend_type);
    let provider_params_hs = provider_opt_hs.map(|p| &p.params);
    let param_defs_hs: Option<&[crate::types::ParamDef]> =
        provider_opt_hs.map(|p| p.param_definitions.as_slice());

    let config = template.apply_provider_defaults(&config, provider_params_hs);

    // Determine GPU mask — also check __test_args for split-mode indicators
    let test_has_split = config.extra_params.get("__test_args")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.windows(2).any(|w| {
                w[0].as_str().map(|s| s == "-sm" || s == "--split-mode").unwrap_or(false)
                    && w.get(1).and_then(|s| s.as_str()).map(|v| {
                        !matches!(v.to_uppercase().as_str(), "NONE" | "0")
                    }).unwrap_or(false)
            })
        }).unwrap_or(false);

    let gpu_mask = if config.device == "GPU-1" {
        "1".to_string()
    } else if (!config.split_mode.is_empty() && config.split_mode.to_uppercase() != "NONE") || test_has_split {
        "0,1".to_string()
    } else {
        "0".to_string()
    };

    eprintln!("[GPU_MASK][HOTSWAP] provider={} split_mode=\"{}\" test_has_split={} -> CUDA_VISIBLE_DEVICES={}", backend_type, config.split_mode, test_has_split, gpu_mask);

    // Validate paths
    crate::config::validate_provider_binary(binary_path.to_str().unwrap_or(""))?;
    crate::config::validate_model_path(&config.model_path)?;

    let stack = app.stack.lock().await;

    // Find slot by alias
    let slot_count = stack.slots.len();
    let slot_idx = (0..slot_count).find(|&i| {
        stack.get_slot(i).map_or(false, |s| s.alias == alias)
    }).ok_or(format!("Engine '{}' not found", alias))?;

    // Pre-launch port cleanup: kill any zombie process holding this slot's port
    let hotswap_port = stack.get_slot(slot_idx).map(|s| s.port).unwrap_or(config.port);
    drop(stack);
    
    let ps_script = format!(
        r"$pids = netstat -ano | Select-String ':{0} ' | ForEach-Object {{ ($_ -split '\s+')[-1] }}; $pids | Where-Object {{ $_.Length -gt 0 -and $_ -ne '0' }} | ForEach-Object {{ taskkill /F /PID $_ 2>$null }}",
        hotswap_port
    );
    let _ = tokio::process::Command::new("powershell")
        .args(&["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", &ps_script])
        .output()
        .await;
    
    tokio::time::sleep(Duration::from_millis(300)).await;

    let mut stack = app.stack.lock().await;

    let provider_display_name = backend_type.clone();

    // Build CLI args from template — param_defs passed so get_value() can use user-selected values
    let cmd_args = template.build_command(&config, &gpu_mask, param_defs_hs);

    // Print launch command to stderr for debugging (visible in console)
    let launch_cmd = format!("{} {}", binary_path.display(), cmd_args.join(" "));
    eprintln!("\n========== [HOTSWAP_CMD] slot={} ==========", slot_idx);
    eprintln!("{}", launch_cmd);
    eprintln!("==========================================\n");

    // Emit before swapping — visible even if process crashes
    app.log_hub.emit_system_event(slot_idx, &config.alias, "Hot-swap launching...").await;

    // Use hot_swap_with_args (template-driven, consistent with launch_engine)
    let load_config = config.clone();
    stack.hot_swap_with_args(slot_idx, &load_config, &binary_path, gpu_mask.clone(), cmd_args.clone(), provider_display_name.clone(), backend_type.clone()).await?;

    // Pipe combined stdout+stderr to Engine Performance Pulse via ConPTY mpsc channel
    let combined_rx = stack.take_combined_output(slot_idx).await;
    
    let ctx_size_int = crate::templates::ProviderTemplate::ctx_to_int_str(&config.ctx_size)
        .parse::<usize>().unwrap_or(32768);
    
    if combined_rx.is_some() {
        eprintln!("[LAUNCH] slot={} ConPTY combined output captured (hot-swap)", slot_idx);
        
        // ── Engine Performance Pulse: reads --verbose output for TPS/TTFT/FuelTank + log display ──
        let perf_log_hub = app.log_hub.clone();
        let perf_alias = config.alias.clone();
        let perf_slot = slot_idx;
        
        tokio::spawn(async move {
            engine_perf::start_perf_reader_from_channel(
                perf_log_hub, perf_slot, perf_alias, combined_rx.unwrap(), ctx_size_int
            ).await;
        });
    } else {
        eprintln!("[LAUNCH] slot={} ConPTY output was None (hot-swap)", slot_idx);
    }

    // Spawn background health checker (same as launch_engine)
    let slot_arc = app.stack.clone();
    let hp_port = load_config.port;
    tokio::spawn(async move {
        let mut attempts = 0u32;
        loop {
            if attempts >= 45 { break; }
            tokio::time::sleep(tokio::time::Duration::from_secs(1)).await;

            {
                let s = slot_arc.lock().await;
                match s.get_slot(slot_idx) {
                    None => break,
                    Some(slot) => match &slot.status {
                        SlotStatus::Running | SlotStatus::Error(_) => break,
                        SlotStatus::Loading => {}
                        SlotStatus::Idle => break,
                    },
                }
            }

            let mut s = slot_arc.lock().await;
            if let Some(slot) = s.get_slot_mut(slot_idx) {
                if let Some(ref mut conpty_proc) = slot.conpty_proc {
                    if !conpty_proc.is_alive() {
                        let exit_code = conpty_proc.wait(None).unwrap_or(u32::MAX);
                        log::error!("slot={} hot-swap crashed (exit code: {})", slot_idx, exit_code);
                        slot.status = SlotStatus::Error(format!("process exited unexpectedly (code={})", exit_code));
                        break;
                    }
                }
            }

            let health_url = format!("http://127.0.0.1:{}/health", hp_port);
            match reqwest::get(&health_url).await {
                Ok(resp) if resp.status().is_success() => {
                    let mut s = slot_arc.lock().await;
                    if let Some(slot) = s.get_slot_mut(slot_idx) {
                        slot.status = SlotStatus::Running;
                    }
                    break;
                }
                Ok(_) => {} // Non-success response — keep polling
                Err(_) => {} // Connection error — keep polling
            }
            attempts += 1;
        }
    });

    let model_name = config.model_path.rsplit('/').next().unwrap_or("unknown").to_string();

    Ok(StackEntryOut {
        idx: slot_idx,
        alias: config.alias.clone(),
        model_name,
        port: load_config.port,
        gpu: gpu_mask,
        status: "LOADING".to_string(),
        slot_id: slot_idx as u32,
        provider_type: backend_type,
        model_path: config.model_path.clone(),
        vram_mib: 0.0,
        n_ctx: ctx_size_int,
        provider_name: provider_display_name,
        build_info: None,
    })
}

// ── VRAM Fit Check (pre-launch validation) ──────────────────────────

#[tauri::command]
pub async fn check_vram_fit(
    config: EngineConfig,
    gpus: Vec<crate::telemetry::GpuInfo>,
) -> Result<VramFitResult, String> {
    // Use template's data-driven ctx_to_int_str — single source of truth for all context size conversions
    let ctx_size = crate::templates::ProviderTemplate::ctx_to_int_str(&config.ctx_size).parse::<usize>().unwrap_or(32768);

    let model_path_str = if !config.model_path.is_empty() {
        config.model_path.clone()
    } else {
        return Err("Model path is required for VRAM check".to_string());
    };

    let file_metadata = std::fs::metadata(&model_path_str).map_err(|e| {
        format!("Cannot access model file '{}': {}", model_path_str, e)
    })?;
    let model_bytes = file_metadata.len();

    let (mmproj_bytes, has_mmproj) = detect_mmproj(&model_path_str);

    let vision_enabled = has_mmproj && config.vision != "OFF";

    let vram_config = VramCalcConfig {
        model_bytes,
        mmproj_bytes,
        vision_enabled,
        offload_layers: 999,
        ctx: ctx_size,
        kv_quant: config.kv_quant.clone(),
        parallel: config.parallel as u32,
        batch: config.batch as u32,
    };

    let vram_result = vram::calculate_vram_with_fallback(&model_path_str, &vram_config, "REGULAR");
    let fit_result = vram::check_vram_fit(&gpus, &vram_result);

    Ok(fit_result)
}

// ── Provider Management Commands ────────────────────────────────────

/// Lists all registered backend providers with their binary paths.
#[tauri::command]
pub async fn list_providers(app: tauri::State<'_, AppContext>) -> Result<Vec<crate::types::ProviderConfig>, String> {
    // Providers already have correct state from overlay merge at startup.
    // Return as-is — admin deletions, modifications, and custom params are preserved.
    let providers = {
        let cfg = app.config.lock().map_err(|e| e.to_string())?;
        cfg.providers.clone()
    };

    let mut result = providers;

    Ok(result)
}

/// Adds or updates a backend provider in the config.
#[tauri::command]
pub async fn save_provider(provider: crate::types::ProviderConfig, app: tauri::State<'_, AppContext>) -> Result<(), String> {
    log::debug!("[SAVE_PROVIDER] ENTER id='{}' param_count={}", provider.id, provider.param_definitions.len());
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;

    // TODO: Re-enable binary validation once Foundry build flow is stable
    // if !provider.binary_path.is_empty() {
    //     crate::config::validate_provider_binary(&provider.binary_path)?;
    // }

    // If editing and the ID changed, remove the old entry first.
    if let Some(original_id) = &provider._original_id {
        if original_id != &provider.id {
            cfg.providers.retain(|p| p.id != *original_id);
        }
    }

    // Determine template_type: use provided value or auto-detect from ID (case-insensitive)
    let mut save_provider = provider.clone();
    if save_provider.template_type.is_empty() {
        let lower_id = save_provider.id.to_lowercase();
        if lower_id.contains("ik") {
            save_provider.template_type = "ik-llama".to_string();
        } else {
            save_provider.template_type = "ggml-llama".to_string();
        }
    }

    // New provider with empty param_definitions — populate from correct template by type
    if save_provider.param_definitions.is_empty() {
        let tmpl_key = if save_provider.template_type == "ik-llama" || save_provider.id == "ik-extreme" { "ik-extreme" } else { "ggml-stable" };
        save_provider.param_definitions = crate::config::params_for_provider(tmpl_key);
    }
    // Existing provider: preserve admin state as-is (deletions, modifications, custom params).
    // New genesis params will be added on next startup via overlay merge.

    // Check if provider with this (new) ID already exists — update in place or push new.
    if let Some(existing) = cfg.providers.iter_mut().find(|p| p.id == save_provider.id) {
        *existing = save_provider.clone();
    } else {
        cfg.providers.push(save_provider);
    }

    drop(cfg);

    // Persist param_definitions directly to provider_meta.json (no delta computation needed).
    // On next startup, load_config reads these back — Genesis is only the fallback.
    let cfg_for_meta = app.config.lock().map_err(|e| e.to_string())?;
    crate::config::persist_provider_meta(&cfg_for_meta.providers)?;

    Ok(())
}

/// Removes a backend provider by ID.
#[tauri::command]
pub async fn remove_provider(id: String, app: tauri::State<'_, AppContext>) -> Result<(), String> {
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;

    let before = cfg.providers.len();
    cfg.providers.retain(|p| p.id != id);

    if cfg.providers.len() == before {
        return Err(format!("Provider '{}' not found", id));
    }

    drop(cfg);

    // Persist provider metadata to disk
    let cfg_for_meta = app.config.lock().map_err(|e| e.to_string())?;
    crate::config::persist_provider_meta(&cfg_for_meta.providers)?;

    Ok(())
}

// ── Helpers ─────────────────────────────────────────────────────────

/// Returns the template for a given provider ID.
#[tauri::command]
pub fn get_template(provider_id: Option<String>) -> Result<crate::templates::ProviderTemplate, String> {
    let id = provider_id.unwrap_or_else(|| "ggml-stable".to_string());
    
    // Try loading by specific ID first
    if let Some(template) = crate::templates::ProviderTemplate::load_by_id(&id) {
        return Ok(template);
    }
    
    // Fallback: load default template (ggml-stable)
    Ok(crate::templates::ProviderTemplate::load())
}

/// Preview the full launch command for a given config without actually launching.
#[tauri::command]
pub async fn preview_launch_command(
    config: EngineConfig,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<String, String> {
    let backend_type = provider_id.unwrap_or_else(|| {
        if config.backend_type.is_empty() { "ggml-stable".to_string() } else { config.backend_type.clone() }
    });

    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let binary_path = find_provider_binary(&cfg, &backend_type);
    let template = crate::templates::ProviderTemplate::load_by_id(&backend_type)
        .unwrap_or_else(crate::templates::ProviderTemplate::load);

    let provider_opt_prev = cfg.providers.iter().find(|p| p.id == backend_type);
    let provider_params_pv = provider_opt_prev.map(|p| &p.params);
    let param_defs_pv: Option<&[crate::types::ParamDef]> =
        provider_opt_prev.map(|p| p.param_definitions.as_slice());

    let config = template.apply_provider_defaults(&config, provider_params_pv);

    let gpu_mask = if config.device == "GPU-1" {
        "1".to_string()
    } else if !config.split_mode.is_empty() && config.split_mode.to_uppercase() != "NONE" {
        "0,1".to_string()
    } else {
        "0".to_string()
    };

    let cmd_args = template.build_command(&config, &gpu_mask, param_defs_pv);
    Ok(format!("{} {}", binary_path.display(), cmd_args.join(" ")))
}

// ── File Dialog (rfd native dialog) ───────────────────────────────

/// Opens a native file picker dialog and returns the selected path.
#[tauri::command]
pub async fn open_file_dialog(title: Option<String>, _filter: Option<String>) -> Result<Option<String>, String> {
    let title = title.unwrap_or_else(|| "Select File".to_string());

    // Run the blocking file dialog on a background thread.
    // No filter — shows all files so user can see everything including .exe.
    // User can type "*.exe" in the filename field to narrow down if needed.
    let result = tokio::task::spawn_blocking(move || {
        rfd::FileDialog::new()
            .set_title(&title)
            .pick_file()
    })
    .await
    .map_err(|e| format!("File dialog panicked: {}", e))?;

    Ok(result.map(|p| p.to_string_lossy().to_string()))
}

fn detect_mmproj(model_path: &str) -> (u64, bool) {
    let p = PathBuf::from(model_path);
    if let Some(dir) = p.parent() {
        if let Ok(entries) = std::fs::read_dir(dir) {
            for entry in entries.flatten() {
                let fname = entry.file_name();
                let fname_str = fname.to_string_lossy().to_lowercase();
                if fname_str.contains("mmproj") && !fname_str.ends_with(".gguf") {
                    if let Ok(meta) = std::fs::metadata(entry.path()) {
                        return (meta.len(), true);
                    }
                }
            }
        }
    }
    (0, false)
}

// ── FIT Scanner Commands ────────────────────────────────────────────

/// Scan a single model using llama-fit-params.exe to get exact VRAM requirements.
#[tauri::command]
pub async fn fit_scan_model(
    model_path: String,
    provider_id: Option<String>,
    ctx_size: String,
    kv_quant: String,
    device: String,
    split_mode: String,
    app: tauri::State<'_, AppContext>,
) -> Result<fit_scanner::FitScanResult, String> {
    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let backend_type = provider_id.unwrap_or_else(|| "ggml-stable".to_string());
    let binary_path = find_provider_binary(&cfg, &backend_type);

    let fit_binary = fit_scanner::find_fit_binary(binary_path.to_str().unwrap_or(""))
        .ok_or_else(|| "llama-fit-params.exe not found in provider directory".to_string())?;

    // Load template and build EngineConfig from provider defaults (same as engine launch)
    let template = crate::templates::ProviderTemplate::load_by_id(&backend_type)
        .unwrap_or_else(crate::templates::ProviderTemplate::load);

    let provider_params = cfg.providers.iter()
        .find(|p| p.id == backend_type)
        .map(|p| &p.params);

    let mut config = crate::types::EngineConfig {
        alias: String::new(),
        model_path: model_path.clone(),
        port: 0, // not used for fit scan
        device,
        kv_quant,
        ctx_size,
        batch: 2048,
        ubatch: 512,
        parallel: 1,
        offload: "ALL".to_string(),
        offload_mode: "REGULAR".to_string(),
        split_mode,
        vision: "AUTO".to_string(),
        flash_attn: true,
        jinja: false,
        cont_batching: false,
        metrics: false,
        reasoning: false,
        mmap: true,
        verbose: false,
        log_timestamps: true,
        unified_kv: true,
        provider_type: backend_type.clone(),
        n_gpu_layers: -1,
        backend_type: backend_type.clone(),
        extra_params: std::collections::HashMap::new(),
    };
    config = template.apply_provider_defaults(&config, provider_params);

    // Derive GPU mask from config — same logic as launch_engine
    let gpu_mask = if config.device == "GPU-1" {
        "1".to_string()
    } else if !config.split_mode.is_empty() && config.split_mode.to_uppercase() != "NONE" {
        "0,1".to_string()
    } else {
        "0".to_string()
    };

    let args = fit_scanner::build_fit_args_from_template(&template, &config, &model_path, &gpu_mask);
    let vram_mib = fit_scanner::scan_single_anchor(&fit_binary, &args, &gpu_mask).await?;

    // Save single scan result to cache (smart: complements existing profile)
    let ctx_int = crate::templates::ProviderTemplate::ctx_to_int_str(&config.ctx_size).parse::<usize>().unwrap_or(32768);
    fit_scanner::save_single_scan_to_cache(&model_path, ctx_int, &config.kv_quant, vram_mib);

    let gpus = telemetry::scan_gpus().await.unwrap_or_default();
    let total_gpu_mib: f64 = gpus.iter().map(|g| g.memory_total as f64).sum();

    Ok(fit_scanner::FitScanResult {
        model_path,
        vram_mib,
        ctx: ctx_int,
        kv_quant: config.kv_quant.clone(),
        fits: vram_mib <= total_gpu_mib,
    })
}

/// Batch-scan an entire library of models using llama-fit-params.exe.
#[tauri::command]
pub async fn fit_scan_library(
    provider_id: String,
    model_base: String,
    parallel_count: u32,
    _batch: u32,
    _ubatch: u32,
    _flash_attn: bool,
    app: tauri::State<'_, AppContext>,
) -> Result<fit_scanner::FitScanComplete, String> {
    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    let binary_path = find_provider_binary(&cfg, &provider_id);
    let fit_binary = fit_scanner::find_fit_binary(binary_path.to_str().unwrap_or(""))
        .ok_or_else(|| "llama-fit-params.exe not found in provider directory".to_string())?;

    // Load template and build base EngineConfig from provider defaults (same as engine launch)
    let template = crate::templates::ProviderTemplate::load_by_id(&provider_id)
        .unwrap_or_else(crate::templates::ProviderTemplate::load);

    let provider_params = cfg.providers.iter()
        .find(|p| p.id == provider_id)
        .map(|p| &p.params);

    let mut base_config = crate::types::EngineConfig {
        alias: String::new(),
        model_path: String::new(), // set per-model in scan loop
        port: 0, // not used for fit scan
        device: "GPU-0".to_string(),
        kv_quant: "q4_0".to_string(),
        ctx_size: "32K".to_string(),
        batch: 2048,
        ubatch: 512,
        parallel: 1,
        offload: "ALL".to_string(),
        offload_mode: "REGULAR".to_string(),
        split_mode: "NONE".to_string(),
        vision: "AUTO".to_string(),
        flash_attn: true,
        jinja: false,
        cont_batching: false,
        metrics: false,
        reasoning: false,
        mmap: true,
        verbose: false,
        log_timestamps: true,
        unified_kv: true,
        provider_type: provider_id.clone(),
        n_gpu_layers: -1,
        backend_type: provider_id.clone(),
        extra_params: std::collections::HashMap::new(),
    };
    base_config = template.apply_provider_defaults(&base_config, provider_params);

    // Get total GPU VRAM for fit checking
    let gpus = telemetry::scan_gpus().await.unwrap_or_default();
    let total_gpu_mib: f64 = gpus.iter().map(|g| g.memory_total as f64).sum::<f64>() + (gpus.len() as f64 * fit_scanner::FIT_OVERHEAD_PER_GPU);

    // Create broadcast channel for real-time progress events
    let (progress_tx, _progress_rx) = broadcast::channel::<fit_scanner::FitScanProgress>(64);
    let log_hub_clone = app.log_hub.clone();

    let prog_for_spawn = progress_tx.clone();

    tokio::spawn(async move {
        let mut rx = prog_for_spawn.subscribe();
        while let Ok(evt) = rx.recv().await {
            log_hub_clone.emit("fit-scan-progress", &evt);
        }
    });

    // Create cancellation flag and store in AppContext
    let cancel_flag = Arc::new(AtomicBool::new(false));
    {
        let mut guard = app.fit_scan_cancel.lock().await;
        *guard = cancel_flag.clone();
    }

    // Run library scan — template-driven, same logic as engine launch
    let result = fit_scanner::scan_library(
        &fit_binary, &model_base, parallel_count.max(1), total_gpu_mib,
        provider_id.clone(), template, base_config, Some(progress_tx), cancel_flag,
    ).await;

    Ok(result)
}

/// Stop a running library scan by setting the cancellation flag.
#[tauri::command]
pub async fn fit_stop_scan(app: tauri::State<'_, AppContext>) -> Result<(), String> {
    let guard = app.fit_scan_cancel.lock().await;
    guard.store(true, Ordering::Relaxed);
    Ok(())
}

/// Get cached VRAM profile for a model. Returns None if not in cache.
#[tauri::command]
pub fn fit_get_cached_profile(model_path: String) -> Result<Option<fit_scanner::VramProfile>, String> {
    let cache = fit_scanner::load_fit_cache().unwrap_or_default();
    Ok(fit_scanner::get_cached_profile(&cache, &model_path))
}

/// Estimate VRAM for a model at given context/KV using cached anchor data.
#[tauri::command]
pub fn fit_estimate_vram(
    model_path: String,
    ctx: usize,
    kv_quant: String,
) -> Result<Option<f64>, String> {
    let cache = fit_scanner::load_fit_cache().unwrap_or_default();
    Ok(fit_scanner::estimate_from_cache(&cache, &model_path, ctx, &kv_quant))
}

/// Clear the entire FIT cache.
#[tauri::command]
pub fn fit_clear_cache() -> Result<bool, String> {
    Ok(fit_scanner::clear_fit_cache())
}

/// Get mmproj file size in MiB for a model path.
#[tauri::command]
pub fn get_mmproj_size_mib(model_path: String) -> f64 {
    fit_scanner::get_mmproj_size_mib(&model_path)
}

/// Extract build info from a compiled binary by running --version and reading file mtime.
#[tauri::command]
pub async fn get_binary_build_info(binary_path: String) -> Result<crate::types::BuildInfo, String> {
    let path = PathBuf::from(&binary_path);

    // Check file exists and get mtime
    let metadata = tokio::fs::metadata(&path).await
        .map_err(|e| format!("Binary not found: {}", e))?;

    let mtime = metadata.modified()
        .map_err(|e| format!("Failed to read mtime: {}", e))?;

    // Convert mtime to local date string using chrono
    use chrono::{DateTime, Local};
    let datetime: DateTime<Local> = mtime.into();
    let build_date = datetime.format("%Y-%m-%d %H:%M").to_string();

    // Run binary with --version and capture both stdout and stderr
    // (some binaries write CUDA init info to stdout, version line may be on either stream)
    let output = tokio::process::Command::new(&path)
        .args(["--version"])
        .output()
        .await
        .map_err(|e| format!("Failed to run binary: {}", e))?;

    if !output.status.success() {
        return Err("Binary --version failed".to_string());
    }

    // Combine stdout + stderr and strip ANSI escape codes before parsing
    let raw = format!("{}{}", 
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    );
    // Strip ANSI escape sequences (\x1b[...m and similar) then remove non-ASCII chars
    let cleaned: String = regex::Regex::new(r"\x1b\[[0-9;?]*[a-zA-Z]")
        .map_err(|e| format!("Regex error: {}", e))?
        .replace_all(&raw, "")
        .to_string();
    // Remove any remaining non-ASCII bytes that might interfere with regex
    let cleaned: String = cleaned.chars()
        .filter(|c| *c <= '\x7F')
        .collect();

    // Parse version string — matches "version: 3 (f535774)" format
    let re = regex::Regex::new(r"version:\s*(\d+)\s*\(([^)]+)\)")
        .map_err(|e| format!("Regex error: {}", e))?;

    if let Some(caps) = re.captures(&cleaned) {
        let version = format!("{} ({})", &caps[1], &caps[2]);
        return Ok(crate::types::BuildInfo { 
            version, 
            build_date,
            cuda_version: None,
        });
    }

    Err(format!("Could not parse version from binary output (raw: {})", 
        cleaned.chars().take(200).collect::<String>()))
}

/// Save build info for a specific environment on a provider, persisting to disk.
#[tauri::command]
pub async fn set_build_info_for_env(
    provider_id: String,
    env_label: String,
    build_info: crate::types::BuildInfo,
    app: tauri::State<'_, AppContext>,
) -> Result<(), String> {
    let mut cfg = app.config.lock().map_err(|e| e.to_string())?;
    if let Some(provider) = cfg.providers.iter_mut().find(|p| p.id == provider_id) {
        provider.build_info_per_env.insert(env_label, build_info);
    }
    crate::config::persist_provider_meta(&cfg.providers).map_err(|e| e.to_string())
}
