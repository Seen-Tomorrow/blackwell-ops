//! GGUF metadata scanner — spawns llama-server -ngl 0, parses stderr output, kills before tensor load.
//!
//! Strategy: Start llama-server with the model path and -ngl 0 (no GPU layers). The server reads
//! the GGUF header, prints all KV pairs to stderr, then attempts to load tensors. We kill the
//! process as soon as we see "load_tensors:" — before any actual tensor data is read into VRAM.
//!
//! IMPORTANT: llama.cpp outputs ALL diagnostic text to stderr (not stdout). Reading stdout would
//! give an empty stream and cause the 15s timeout to fire after tensors have already loaded.

use crate::types::{BaseModelInfo, ModelMetadata};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::os::windows::process::CommandExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::Duration;

/// Global cancellation flag for batch scans. Set to true by cancel_gguf_scan_cmd().
pub static GGUF_SCAN_CANCEL: AtomicBool = AtomicBool::new(false);

/// Check if the current scan should be cancelled.
pub fn is_cancelled() -> bool {
    GGUF_SCAN_CANCEL.load(Ordering::Relaxed)
}

/// Reset the cancellation flag (called at start of each batch scan).
pub fn reset_cancel() {
    GGUF_SCAN_CANCEL.store(false, Ordering::Relaxed);
}

/// Scan a single model file and return its parsed metadata.
pub fn scan_model_metadata(model_path: &str, binary_path: &str) -> Result<ModelMetadata, String> {
    if !Path::new(model_path).exists() {
        return Err(format!("Model file not found: {}", model_path));
    }

    let mut cmd = Command::new(binary_path);
    cmd.args(["-m", model_path, "-ngl", "0", "-t", "1"]) // Single thread — reduce CPU load during scan
        .args(crate::types::LLAMA_DIAGNOSTIC_FLAGS.iter().map(|s| s.to_string()))
        .env("CUDA_VISIBLE_DEVICES", "") // Hide GPUs — forces pure CPU, zero VRAM usage
        .env("OMP_NUM_THREADS", "1")     // Single thread — reduce CPU load during scan
        .stdin(Stdio::null())
        .stdout(Stdio::null()) // stdout is empty — all output goes to stderr
        .stderr(Stdio::piped())
        .creation_flags(0x08000000); // CREATE_NO_WINDOW — prevents CMD flash in release builds
    crate::engine_utils::apply_cuda_toolchain_for_binary(&mut cmd, Path::new(binary_path))?;
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("Failed to spawn {}: {}", binary_path, e))?;

    let stderr = child.stderr.take().ok_or("Failed to capture stderr")?;
    let reader = BufReader::new(stderr);

    // Collect lines until "load_tensors:" or timeout
    let mut lines: Vec<String> = Vec::new();
    let (tx, rx) = std::sync::mpsc::channel();

    let collect_thread = thread::spawn(move || {
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if l.contains("load_tensors:") || l.contains("loading model tensors") {
                        break; // Stop before tensor loading
                    }
                    tx.send(l).ok();
                }
                Err(_) => break,
            }
        }
    });

    // Collect with timeout (15s safety net)
    let start = std::time::Instant::now();
    loop {
        match rx.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => lines.push(line),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                // Check if thread is done
                if collect_thread.is_finished() { break; }
                if start.elapsed() > Duration::from_secs(15) { break; }
                continue;
            }
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }

    // Kill the process (it may still be trying to load tensors)
    let _ = child.kill();
    let _ = child.wait();
    let _ = collect_thread.join();

    // Parse collected lines into metadata
    let mut metadata = ModelMetadata {
        architecture: String::new(),
        model_type_label: String::new(),
        n_layer: 0,
        n_ctx_train: 0,
        n_embd: 0,
        n_head: 0,
        n_head_kv: 0,
        n_expert: 0,
        n_expert_used: 0,
        rope_freq_base: 0.0,
        rope_dim: 0,
        feed_forward_length: 0,
        expert_feed_forward_length: 0,
        file_type_str: String::new(),
        bpw: 0.0,
        tensor_counts: HashMap::new(),
        total_params_str: String::new(),
        vocab_size: 0,
        general_name: String::new(),
        rope_scaling_type: String::new(),
        tokenizer_model: String::new(),
        file_size_bytes: std::fs::metadata(model_path)
            .map(|m| m.len())
            .unwrap_or(0),
        scan_timestamp: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
        file_created: std::fs::metadata(model_path)
            .and_then(|m| m.created())
            .ok()
            .map(|t| t.duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_secs())
            .unwrap_or(0),
        nextn_predict_layers: 0,
        raw_kvs: HashMap::new(),
        raw_print_info: HashMap::new(),
        general_author: String::new(),
        general_repo_url: String::new(),
        general_basename: String::new(),
        general_quantized_by: String::new(),
        general_license: String::new(),
        general_tags: Vec::new(),
        base_models: Vec::new(),
        chat_template: String::new(),
    };

    for line in lines {
        parse_line(&line, &mut metadata);
    }

    if metadata.architecture.is_empty() {
        return Err("Failed to parse model architecture — may not be a valid GGUF file".to_string());
    }

    Ok(metadata)
}

/// Parse a single line from llama-server output and update metadata.
fn parse_line(line: &str, m: &mut ModelMetadata) {
    // KV lines: "kv N: key type = value" — uses .contains(), timestamp-safe
    if line.contains("llama_model_loader:") && line.contains(" kv ") {
        parse_kv_line(line, m);
    }
    // print_info lines: "print_info: key                  = value"
    // Stable builds prepend timestamps like "0.00.483.965 I", so use .find() instead of .starts_with()
    else if let Some(pi_pos) = line.find("print_info:") {
        let rest = &line[pi_pos + "print_info:".len()..];
        parse_print_info(rest.trim(), m);
    }
    // Tensor type counts: "- type  f32:  373 tensors" — timestamp-safe with .contains()
    else if line.contains("- type ") && line.contains("tensors") {
        parse_tensor_type(line, m);
    }
}

fn parse_kv_line(line: &str, m: &mut ModelMetadata) {
    // Find the "kv N:" part and extract key + value after it
    let kv_idx = if let Some(pos) = line.find(" kv ") { pos } else { return };
    let rest = &line[kv_idx + 4..];

    // Skip number: "0: general.architecture str = minimax-m2"
    let after_num = if let Some(colon_pos) = rest.find(':') {
        rest[colon_pos + 1..].trim()
    } else {
        return;
    };

    // Split on last " =" to separate key+type from value
    let eq_pos = if let Some(pos) = after_num.rfind(" =") { pos } else { return; };
    let key_type_part = &after_num[..eq_pos].trim();
    let value_raw = &after_num[eq_pos + 2..];

    // Parse key and type from "general.architecture str"
    let kt_parts: Vec<&str> = key_type_part.split_whitespace().collect();
    if kt_parts.len() < 2 { return; }

    let key = kt_parts[0];
    let value_str = clean_value(value_raw);

    // ── Skip huge tokenizer arrays (tokens, token_type, merges) — store count only ──
    let is_tokenizer_array = key == "tokenizer.ggml.tokens" || 
                              key == "tokenizer.ggml.token_type" || 
                              key == "tokenizer.ggml.merges";

    // Store raw KV for everything EXCEPT tokenizer arrays (they're megabytes)
    if !is_tokenizer_array {
        m.raw_kvs.insert(key.to_string(), value_str.clone());
    }

    match key {
        "general.architecture" => m.architecture = value_str.clone(),
        "general.name" => m.general_name = value_str.clone(),
        "general.size_label" => m.model_type_label = value_str.clone(),
        _ if key.ends_with(".block_count") || key.contains("layer_count") => {
            parse_u32(&value_str, &mut m.n_layer);
        }
        _ if key.ends_with(".context_length") => {
            parse_u32(&value_str, &mut m.n_ctx_train);
        }
        _ if key.ends_with(".embedding_length") => {
            parse_u32(&value_str, &mut m.n_embd);
        }
        _ if key.contains("attention.head_count") && !key.contains("kv") => {
            parse_u32(&value_str, &mut m.n_head);
        }
        _ if key.contains("head_count_kv") || key.ends_with(".gqa") => {
            parse_u32(&value_str, &mut m.n_head_kv);
        }
        _ if key.ends_with(".expert_count") => {
            parse_u32(&value_str, &mut m.n_expert);
        }
        _ if key.ends_with(".expert_used_count") => {
            parse_u32(&value_str, &mut m.n_expert_used);
        }
        _ if key.ends_with(".rope.freq_base") => {
            parse_f32(&value_str, &mut m.rope_freq_base);
        }
        _ if key.ends_with(".rope.dimension_count") => {
            parse_u32(&value_str, &mut m.rope_dim);
        }
        _ if key.ends_with(".feed_forward_length") && !key.contains("expert") => {
            parse_u32(&value_str, &mut m.feed_forward_length);
        }
        _ if key.ends_with(".expert_feed_forward_length") => {
            parse_u32(&value_str, &mut m.expert_feed_forward_length);
        }
        _ if key.ends_with(".rope.scaling.type") => {
            m.rope_scaling_type = value_str.clone();
        }
        _ if key.ends_with(".nextn_predict_layers") => {
            parse_u32(&value_str, &mut m.nextn_predict_layers);
        }
        "tokenizer.ggml.model" => {
            m.tokenizer_model = value_str.clone();
        }
        "tokenizer.ggml.tokens" => {
            // Extract array size from "arr[str,200064]" — don't store raw (too large)
            extract_arr_size(line, &mut m.vocab_size);
        }
        "tokenizer.chat_template" => {
            m.chat_template = value_str.clone();
        }

        // ── New convenience fields from GGUF general.* KVs ──────────────
        "general.author" => m.general_author = value_str.clone(),
        "general.basename" => m.general_basename = value_str.clone(),
        "general.quantized_by" => m.general_quantized_by = value_str.clone(),
        "general.license" => m.general_license = value_str.clone(),
        "general.repo_url" => m.general_repo_url = value_str.clone(),

        // Base models: extract index from "general.base_model.0.name" etc.
        _ if key.starts_with("general.base_model.") && key.ends_with(".name") => {
            push_base_model_field(key, &value_str, "name", m);
        }
        _ if key.contains("base_model") && key.ends_with(".organization") => {
            push_base_model_field(key, &value_str, "organization", m);
        }
        _ if key.contains("base_model") && key.ends_with(".repo_url") => {
            push_base_model_field(key, &value_str, "repo_url", m);
        }

        // Tags array: parse ["unsloth", "image-text-to-text"] from value_raw
        "general.tags" => m.general_tags = parse_json_array(value_raw),

        _ => {}
    }
}

fn parse_print_info(line: &str, m: &mut ModelMetadata) {
    // Format: "key                  = value" or "key = value (comment)"
    let eq_pos = if let Some(pos) = line.find('=') { pos } else { return; };
    let key = line[..eq_pos].trim();
    let value_raw = &line[eq_pos + 1..];

    // Extract BPW from parenthetical before getting main value
    let bpw_str = if let Some(start) = value_raw.find('(') {
        let end = value_raw[start..].find(')').unwrap_or(start);
        Some(&value_raw[start + 1..start + end])
    } else {
        None
    };

    // Main value: everything before '(' or the whole string
    let value_str = if let Some(paren) = value_raw.find('(') {
        value_raw[..paren].trim().to_string()
    } else {
        value_raw.trim().to_string()
    };

    // Store raw print_info line for future use
    m.raw_print_info.insert(key.to_string(), value_str.clone());

    // Parse BPW from file size line
    if key == "file size" {
        if let Some(bpw_part) = bpw_str {
            if let Some(bpw_end) = bpw_part.find("BPW") {
                parse_f32(&bpw_part[..bpw_end].trim(), &mut m.bpw);
            }
        }
    }

    match key {
        "arch" => m.architecture = value_str.clone(),
        "model type" => m.model_type_label = value_str.clone(),
        "n_layer" | "n_layers" => parse_u32(&value_str, &mut m.n_layer),
        "n_ctx_train" => parse_u32(&value_str, &mut m.n_ctx_train),
        "n_embd" => parse_u32(&value_str, &mut m.n_embd),
        "n_head" => parse_u32(&value_str, &mut m.n_head),
        "n_head_kv" => parse_u32(&value_str, &mut m.n_head_kv),
        "n_gqa" => {
            // n_gqa is the GQA group ratio: n_head_kv = n_head / n_gqa
            if let Ok(gqa) = value_str.parse::<u32>() {
                if gqa > 0 && m.n_head > 0 {
                    m.n_head_kv = m.n_head / gqa;
                }
            }
        }
        "n_expert" => parse_u32(&value_str, &mut m.n_expert),
        "n_expert_used" => parse_u32(&value_str, &mut m.n_expert_used),
        "ffn_hidden" | "feed_forward_length" => parse_u32(&value_str, &mut m.feed_forward_length),
        "expert_ffn_hidden" | "expert_feed_forward_length" => parse_u32(&value_str, &mut m.expert_feed_forward_length),
        "file type" => m.file_type_str = value_str.clone(),
        "model params" => m.total_params_str = value_str.clone(),
        "n_vocab" => parse_u32(&value_str, &mut m.vocab_size),
        _ => {}
    }
}

fn parse_tensor_type(line: &str, m: &mut ModelMetadata) {
    // "- type  f32:  373 tensors" or "  - type q4_K:  375 tensors"
    let cleaned = line.trim_start_matches(' ').trim_start_matches('-').trim();
    if !cleaned.starts_with("type ") { return; }

    let rest = &cleaned[5..]; // after "type "
    let colon_pos = if let Some(pos) = rest.find(':') { pos } else { return; };
    let type_name = rest[..colon_pos].trim().to_string();
    let count_part = rest[colon_pos + 1..].trim();

    // Extract number from "373 tensors"
    if let Some(space_pos) = count_part.find(' ') {
        if let Ok(count) = count_part[..space_pos].parse::<u32>() {
            m.tensor_counts.insert(type_name, count);
        }
    }
}

// ── Helpers ────────────────────────────────────────────────────────────────

fn clean_value(s: &str) -> String {
    s.trim().trim_end_matches(',').to_string()
}

fn parse_u32(s: &str, target: &mut u32) {
    if let Ok(v) = s.trim().parse::<u32>() { *target = v; }
}

fn parse_f32(s: &str, target: &mut f32) {
    if let Ok(v) = s.trim().parse::<f32>() { *target = v; }
}

fn extract_arr_size(line: &str, target: &mut u32) {
    // "arr[str,200064]" → extract 200064
    if let Some(start) = line.find("arr[") {
        let arr_part = &line[start + 4..];
        if let Some(end) = arr_part.find(']') {
            let inner = &arr_part[..end];
            if let Some(comma) = inner.rfind(',') {
                if let Ok(v) = inner[comma + 1..].trim().parse::<u32>() {
                    *target = v;
                }
            }
        }
    }
}

/// Push a field value into the base_models vec at the correct index.
/// Extracts index from key like "general.base_model.0.name" → 0.
fn push_base_model_field(key: &str, value: &str, field: &str, m: &mut ModelMetadata) {
    let parts: Vec<&str> = key.split('.').collect();
    if let Some(idx_str) = parts.iter().find(|s| s.chars().all(char::is_numeric)).copied() {
        if let Ok(idx) = idx_str.parse::<usize>() {
            while m.base_models.len() <= idx {
                m.base_models.push(BaseModelInfo { 
                    name: String::new(), organization: String::new(), repo_url: String::new() });
            }
            match field {
                "name" => m.base_models[idx].name = value.to_string(),
                "organization" => m.base_models[idx].organization = value.to_string(),
                "repo_url" => m.base_models[idx].repo_url = value.to_string(),
                _ => {}
            }
        }
    }
}

/// Parse a JSON-like string array: '["unsloth", "image-text-to-text"]' → Vec<String>
fn parse_json_array(raw: &str) -> Vec<String> {
    let trimmed = raw.trim();
    if !trimmed.starts_with('[') || !trimmed.ends_with(']') { return vec![]; }
    let inner = &trimmed[1..trimmed.len()-1];
    inner.split(',')
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
        .collect()
}
