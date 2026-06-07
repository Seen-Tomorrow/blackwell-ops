//! Live `llama-server --help` parser.
//!
//! Runs the provider's binary with `--help`, parses plain text output,
//! and returns structured catalog entries for UI discovery.
//! No caching — always fresh on every open.

use serde::Serialize;
use std::os::windows::process::CommandExt;
use std::process::Command;
use std::sync::Arc;

use crate::config::AppConfig;

/// A single parseable parameter from `llama-server --help` output.
#[derive(Debug, Clone, Serialize)]
pub struct LlamaCatalogEntry {
    /// The primary long flag (e.g. "--temp")
    pub flag: String,
    /// Short alias if any (e.g. "-t")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub short: Option<String>,
    /// Alternate long flags (e.g. "--n-predict" for "-n, --predict, --n-predict N")
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alternates: Option<Vec<String>>,
    /// Derived parameter key (flag stripped of dashes, hyphens → camelCase)
    pub key: String,
    /// Human-readable label (PascalCase of key)
    pub label: String,
    /// Parameter type inferred from help text
    pub ptype: String,
    /// Parsed default value
    #[serde(skip_serializing_if = "Option::is_none")]
    pub default_value: Option<serde_json::Value>,
    /// Allowed/discrete values extracted from help text
    #[serde(skip_serializing_if = "Option::is_none")]
    pub values: Option<Vec<serde_json::Value>>,
    /// 5 smart presets for numeric parameters
    #[serde(skip_serializing_if = "Option::is_none")]
    pub presets: Option<Vec<serde_json::Value>>,
    /// Description text (first line of help)
    pub description: String,
    /// Environment variable override, if documented
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_var: Option<String>,
}

/// Skip list — flags that should never appear in the catalog UI.
/// These are server config, model loading, deprecated, or meta params.
const SKIP_PREFIXES: &[&str] = &[
    // Meta / help
    "--help", "--usage", "--version", "--license", "--cache-list", "--completion-",
    // Model loading
    "-m", "--model", "--lora", "--control-", "--hf-", "--ngl", "--tensor-split",
    "--mmap", "--numa", "--gpu-device", "--mmproj", "-ngl",
    // Server config
    "--host", "--port", "--api-", "--ssl-", "--timeout", "--threads-http",
    "--webui", "--ui-", "--tools", "--embedding", "--rerank", "--cache-prompt",
    "--metrics", "--props", "--slots", "--slot-", "--models-", "--sleep-idle-",
    "--api-prefix", "--path", "--reuse-port", "--media-path",
    // Chat template
    "--chat-template", "--jinja", "--skip-chat-parsing", "--prefill-assistant",
    "--reasoning-format",
    // Model presets (auto-download)
    "--embd-gemma-", "--fim-qwen-", "--gpt-oss-", "--vision-gemma-", "--spec-default",
    // Prompt / interactive mode
    "--prompt", "--prompt-template", "-in-prefix", "--reverse-prompt",
    "--interactive-first", "--log-disable", "--suppress-grammar-warning",
    // Vision / image
    "--image-min-tokens", "--image-max-tokens",
    // Alias / tags
    "-a", "--alias", "--tags",
    // TTS / audio
    "--model-vocoder", "--tts-use-guide",
    // LoRA init
    "--lora-init",
];

/// Check whether a flag should be skipped.
fn should_skip(flag: &str) -> bool {
    let f = flag.trim_start_matches('-');
    SKIP_PREFIXES.iter().any(|&p| {
        let p_trimmed = p.trim_start_matches('-');
        f == p_trimmed || f.starts_with(p_trimmed)
    })
}

/// True when a line is a primary flag definition (column 0), not an indented continuation.
fn is_primary_flag_line(line: &str) -> bool {
    line.starts_with('-')
}

/// Drop duplicate keys and empty keys while preserving first-seen order.
fn dedupe_catalog_entries(entries: Vec<LlamaCatalogEntry>) -> Vec<LlamaCatalogEntry> {
    let mut seen = std::collections::HashSet::new();
    let mut deduped = Vec::with_capacity(entries.len());

    for entry in entries {
        if entry.key.is_empty() || !seen.insert(entry.key.clone()) {
            continue;
        }
        deduped.push(entry);
    }

    deduped
}

/// Parse a `--help` text output into structured catalog entries.
/// When `filter_system_params` is true, server/meta/model-loading flags are excluded.
pub fn parse_help_output(text: &str, filter_system_params: bool) -> Vec<LlamaCatalogEntry> {
    let lines: Vec<&str> = text.lines().collect();
    let mut entries: Vec<LlamaCatalogEntry> = Vec::new();

    let mut i = 0;
    while i < lines.len() {
        let raw = lines[i];

        // Only parse primary flag lines at column 0. Indented continuation lines often
        // mention other flags (e.g. "--logit-bias EOS-inf") and must not become entries.
        if is_primary_flag_line(raw) {
            let entry = parse_flag_line(&lines, &mut i);
            if let Some(e) = entry {
                if !e.key.is_empty() && (!filter_system_params || !should_skip(&e.flag)) {
                    entries.push(e);
                }
            }
        }

        i += 1;
    }

    dedupe_catalog_entries(entries)
}

/// Parse a single flag line and its continuation lines.
fn parse_flag_line(lines: &[&str], idx: &mut usize) -> Option<LlamaCatalogEntry> {
    let line = lines[*idx].trim();

    // Split the first segment on commas to get all flag aliases
    let parts: Vec<&str> = line.split(',')
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
        .collect();

    if parts.is_empty() {
        return None;
    }

    // Collect flags (starting with `-`) and find where description starts
    let mut flags: Vec<String> = Vec::new();
    let mut desc_start = 0;
    let mut has_arg_token = false;
    let mut arg_token: Option<String> = None; // e.g. "N", "<0|1>", "[on|off|auto]", "{a,b,c}"

    for (pi, part) in parts.iter().enumerate() {
        if part.starts_with('-') {
            let flag_token = part.split_whitespace().next().unwrap_or(part);
            if flag_token.len() >= 2 {
                flags.push(flag_token.to_string());
                desc_start = pi + 1;
            }
        } else if pi == desc_start {
            // Check if this is an argument token (single uppercase word or bracketed)
            let token = part.trim();
            if is_arg_token(token) {
                has_arg_token = true;
                arg_token = Some(token.to_string());
                desc_start = pi + 1;
            }
        }
    }

    if flags.is_empty() {
        return None;
    }

    // Build description: everything after the flags (and arg token if present)
    let desc = extract_description(&lines, idx, &flags, arg_token.as_deref());

    // Collect continuation lines for env var
    let mut continuation = String::new();
    let mut ci = *idx + 1;
    while ci < lines.len() {
        let cl = lines[ci];
        if cl.trim().is_empty() || cl.trim().starts_with('-') {
            break;
        }
        continuation.push_str(cl.trim());
        continuation.push('\n');
        ci += 1;
    }

    // Parse full text = description + continuation
    let full_text = format!("{} {}", desc, continuation.trim());

    // Extract env var
    let env_var = extract_env(&full_text);

    // Determine primary flag (prefer long form)
    let primary_flag = flags.iter()
        .find(|f| f.starts_with("--"))
        .unwrap_or(&flags[0])
        .clone();

    // Short alias
    let short = flags.iter()
        .find(|f| f.starts_with("-") && !f.starts_with("--"))
        .cloned();

    // Alternates (other long flags)
    let alternates: Vec<String> = flags.iter()
        .filter(|f| f.starts_with("--") && **f != primary_flag)
        .cloned()
        .collect();

    // Build key and label from primary flag
    let key = flag_to_key(&primary_flag);
    let label = key_to_label(&key);

    // Extract default value
    let default_value = extract_default(&full_text, &primary_flag);

    // Determine ptype and values
    let (ptype, values, presets) = determine_ptype(
        &primary_flag, &full_text, arg_token.as_deref(), has_arg_token, &default_value,
    );

    Some(LlamaCatalogEntry {
        flag: primary_flag,
        short,
        alternates: if alternates.is_empty() { None } else { Some(alternates) },
        key,
        label,
        ptype,
        default_value,
        values: if values.is_empty() { None } else { Some(values) },
        presets: if presets.is_empty() { None } else { Some(presets) },
        description: desc,
        env_var,
    })
}

/// Check if a token looks like an argument placeholder: `N`, `M`, `PATH`, `URL`, `<0|1>`, `[on|off|auto]`, `{a,b,c}`
fn is_arg_token(token: &str) -> bool {
    let t = token.trim();
    if t.is_empty() {
        return false;
    }
    // All-caps single word (N, M, PATH, URL, HOST, PORT, STRING, JSON, FORMAT, etc.)
    if t.chars().all(|c| c.is_ascii_alphabetic() || c == '_') && t.chars().all(|c| c.is_uppercase() || c == '_') {
        return true;
    }
    // Bracketed: <...>, [...]
    if (t.starts_with('<') && t.ends_with('>')) || (t.starts_with('[') && t.ends_with(']')) {
        return true;
    }
    // Curly: {...}
    if t.starts_with('{') && t.ends_with('}') {
        return true;
    }
    false
}

/// Extract description text from the flag line.
fn extract_description(lines: &[&str], idx: &usize, _flags: &[String], _arg_token: Option<&str>) -> String {
    let line = lines[*idx];

    // Find the first segment that doesn't start with `-` and isn't an arg token
    // Strategy: split on whitespace, skip flag-like and arg-token-like tokens
    let words: Vec<&str> = line.split_whitespace().collect();
    let mut desc_start = 0;
    for (wi, word) in words.iter().enumerate() {
        if word.starts_with('-') {
            desc_start = wi + 1;
            continue;
        }
        if is_arg_token(word) {
            desc_start = wi + 1;
            continue;
        }
        // First non-flag, non-arg-token word starts the description
        desc_start = wi;
        break;
    }

    if desc_start >= words.len() {
        return String::new();
    }

    // Reconstruct description from the remaining part of the line
    let desc = line[words[desc_start].as_bytes().len()
        + (" ".repeat(desc_start).len())..]
        .trim();

    // Fallback: just take everything after the last flag segment
    if desc.is_empty() || desc.starts_with('-') || is_arg_token(desc) {
        // Find the byte offset of the first descriptive word
        let mut byte_offset = 0;
        for wi in 0..desc_start {
            byte_offset += words[wi].len() + 1; // +1 for space
        }
        if byte_offset < line.len() {
            return line[byte_offset..].trim().to_string();
        }
        return String::new();
    }

    desc.to_string()
}

/// Extract `(env: VAR_NAME)` from text.
fn extract_env(text: &str) -> Option<String> {
    let lower = text.to_lowercase();
    if let Some(pos) = lower.find("(env: ") {
        let rest = &text[pos + 6..];
        if let Some(end) = rest.find(')') {
            let var = rest[..end].trim();
            if !var.is_empty() {
                return Some(var.to_string());
            }
        }
    }
    None
}

/// Extract default value from help text.
fn extract_default(text: &str, _flag: &str) -> Option<serde_json::Value> {
    let lower = text.to_lowercase();

    // Pattern: (default: VALUE)
    if let Some(pos) = lower.find("(default: ") {
        let rest = &text[pos + 9..];
        let val = extract_default_value(rest);
        if let Some(v) = val {
            return Some(v);
        }
    }

    // Pattern: "default: VALUE" without parens
    if let Some(pos) = lower.find("default: ") {
        let rest = &text[pos + 9..];
        let val = extract_default_value(rest);
        if let Some(v) = val {
            return Some(v);
        }
    }

    // "defaults to VALUE unless"
    if let Some(pos) = lower.find("defaults to ") {
        let rest = &text[pos + 10..];
        let val = extract_default_value(rest);
        if let Some(v) = val {
            return Some(v);
        }
    }

    None
}

/// Extract the actual value after "default: " — handles quoted strings, booleans, numbers.
fn extract_default_value(rest: &str) -> Option<serde_json::Value> {
    let trimmed = rest.trim_start();

    // Quoted string: 'value' or "value"
    if let Some(first) = trimmed.chars().next() {
        if first == '\'' || first == '"' {
            let quote = first;
            if let Some(end) = trimmed[1..].find(quote) {
                let val = trimmed[1..1 + end].trim();
                // Check for "same as --flag" patterns
                if val.starts_with("same as") || val.starts_with("loaded from") || val.starts_with("read from") {
                    return None;
                }
                return Some(serde_json::json!(val));
            }
        }
    }

    // "disabled" → false
    if trimmed.starts_with("disabled") {
        return Some(serde_json::json!(false));
    }
    // "enabled" → true
    if trimmed.starts_with("enabled") {
        return Some(serde_json::json!(true));
    }
    // "none" → null string
    if trimmed.starts_with("none") && !trimmed.starts_with("none)") {
        // Check if next char is punctuation or space
        let after = trimmed[4..].chars().next();
        if after.map(|c| c.is_whitespace() || c == ')' || c == ',').unwrap_or(false) {
            return Some(serde_json::json!("none"));
        }
    }
    // "infinity" / "unlimited" → special
    if trimmed.starts_with("infinity") || trimmed.starts_with("unlimited") {
        return Some(serde_json::json!("-1"));
    }
    // "auto" → string
    if trimmed.starts_with("auto") && !trimmed.starts_with("automatically") {
        let after = trimmed[4..].chars().next();
        if after.map(|c| c.is_whitespace() || c == ')' || c == ',').unwrap_or(false) {
            return Some(serde_json::json!("auto"));
        }
    }
    // "false" → false
    if trimmed.starts_with("false") {
        let after = trimmed[5..].chars().next();
        if after.map(|c| c.is_whitespace() || c == ')' || c == ',' || c == ';').unwrap_or(true) {
            return Some(serde_json::json!(false));
        }
    }
    // "true" → true
    if trimmed.starts_with("true") {
        let after = trimmed[4..].chars().next();
        if after.map(|c| c.is_whitespace() || c == ')' || c == ',' || c == ';').unwrap_or(true) {
            return Some(serde_json::json!(true));
        }
    }

    // Number: parse up to first non-numeric char (but allow negative, decimal)
    let num_str: String = trimmed.chars()
        .take_while(|c| c.is_ascii_digit() || (*c == '-' && trimmed.starts_with('-')) || *c == '.')
        .collect();
    if !num_str.is_empty() {
        // Integer
        if let Ok(n) = num_str.parse::<i64>() {
            return Some(serde_json::json!(n));
        }
        // Float
        if let Ok(f) = num_str.parse::<f64>() {
            return Some(serde_json::json!(f));
        }
    }

    // Fallback: take first word
    if let Some(word) = trimmed.split(|c: char| c.is_whitespace() || c == ')' || c == ',').next() {
        let word = word.trim();
        if !word.is_empty() && !word.starts_with("same") && !word.starts_with("loaded") && !word.starts_with("read") {
            return Some(serde_json::json!(word));
        }
    }

    None
}

/// Determine ptype, values, and presets from help text and arg token.
fn determine_ptype(
    flag: &str,
    text: &str,
    arg_token: Option<&str>,
    has_arg: bool,
    default_value: &Option<serde_json::Value>,
) -> (String, Vec<serde_json::Value>, Vec<serde_json::Value>) {
    let lower = text.to_lowercase();

    // ── Switch types ──

    // [on|off|auto] → switch_onoff
    if let Some(token) = arg_token {
        let t = token.trim();
        if t.contains("on|off") || t.contains("on/off") {
            let vals = if t.contains("auto") {
                vec!["on", "off", "auto"]
            } else {
                vec!["on", "off"]
            };
            return ("switch_onoff".to_string(),
                vals.iter().map(|v| serde_json::json!(v)).collect(),
                Vec::new());
        }
        // <0|1> → switch_onoff
        if t == "<0|1>" || t == "<0...1>" {
            return ("switch_onoff".to_string(),
                vec![serde_json::json!(0), serde_json::json!(1)],
                Vec::new());
        }
        // {a,b,c} → arg_select with discrete values
        if t.starts_with('{') && t.ends_with('}') {
            let vals: Vec<serde_json::Value> = t[1..t.len()-1].split(',')
                .map(|v| serde_json::json!(v.trim()))
                .collect();
            return ("arg_select".to_string(), vals, Vec::new());
        }
    }

    // --flag, --no-flag pattern → switch_inverted
    if lower.contains("--no-") || flag.contains("--no-") {
        return ("switch_inverted".to_string(),
            vec![serde_json::json!(true), serde_json::json!(false)],
            Vec::new());
    }

    // "default: false" / "default: true" without arg → switch_onoff
    if !has_arg && default_value.is_some() {
        let dv = default_value.as_ref().unwrap();
        if dv == &serde_json::json!(true) || dv == &serde_json::json!(false) {
            return ("switch_onoff".to_string(),
                vec![serde_json::json!(true), serde_json::json!(false)],
                Vec::new());
        }
    }

    // ── Numeric types — generate smart presets ──
    if let Some(dv) = default_value {
        if let Some(num) = dv.as_i64() {
            let presets = generate_numeric_presets(flag, num);
            return ("arg_select".to_string(), Vec::new(), presets);
        }
        if let Some(num) = dv.as_f64() {
            let presets = generate_numeric_presets_f64(flag, num);
            return ("arg_select".to_string(), Vec::new(), presets);
        }
    }

    // ── String arg types ──
    if has_arg {
        // If arg token is like PATH, URL, STRING, JSON, FORMAT → arg_select
        if let Some(token) = arg_token {
            let t = token.to_uppercase();
            if ["PATH", "URL", "STRING", "JSON", "FORMAT", "FNAME", "PREFIX", "HOST", "PORT", "SIMILARITY", "SECONDS", "MESSAGE"].iter().any(|&s| t.contains(s)) {
                return ("arg_select".to_string(), Vec::new(), Vec::new());
            }
        }
        // Generic N → numeric arg (no default found)
        if let Some(token) = arg_token {
            if token == "N" || token == "M" {
                return ("arg_select".to_string(), Vec::new(),
                    vec![serde_json::json!(0), serde_json::json!(1), serde_json::json!(10), serde_json::json!(100)]);
            }
        }
    }

    // ── Fallback ──
    ("arg_select".to_string(), Vec::new(), Vec::new())
}

/// Generate 5 smart presets for an integer parameter based on its known purpose.
fn generate_numeric_presets(flag: &str, default: i64) -> Vec<serde_json::Value> {
    let fl = flag.trim_start_matches('-');

    // Known params with specific sane ranges
    match fl {
        "temp" | "temperature" => vec![
            serde_json::json!(0.1), serde_json::json!(0.5), serde_json::json!(0.8),
            serde_json::json!(1.0), serde_json::json!(1.5),
        ],
        "top-k" | "top_k" => vec![
            serde_json::json!(0), serde_json::json!(10), serde_json::json!(40),
            serde_json::json!(50), serde_json::json!(100),
        ],
        "top-p" | "top_p" | "typical-p" => vec![
            serde_json::json!(0.5), serde_json::json!(0.8), serde_json::json!(0.9),
            serde_json::json!(0.95), serde_json::json!(1.0),
        ],
        "min-p" | "min_p" => vec![
            serde_json::json!(0.0), serde_json::json!(0.01), serde_json::json!(0.05),
            serde_json::json!(0.1), serde_json::json!(0.2),
        ],
        "threads" if !fl.contains("batch") => {
            let logical_cpus = std::thread::available_parallelism()
                .map(|n| n.get() as i64)
                .unwrap_or(8);
            let half = logical_cpus / 2;
            vec![
                serde_json::json!(1), serde_json::json!(half.max(2)), serde_json::json!(logical_cpus),
                serde_json::json!(logical_cpus * 2), serde_json::json!(-1),
            ]
        },
        "threads-batch" | "threads_batch" => {
            let logical_cpus = std::thread::available_parallelism()
                .map(|n| n.get() as i64)
                .unwrap_or(8);
            let half = logical_cpus / 2;
            vec![
                serde_json::json!(1), serde_json::json!(half.max(2)), serde_json::json!(logical_cpus),
                serde_json::json!(logical_cpus * 2), serde_json::json!(-1),
            ]
        },
        "ctx-size" | "ctx_size" | "n-predict" | "n_predict" => vec![
            serde_json::json!(2048), serde_json::json!(4096), serde_json::json!(8192),
            serde_json::json!(16384), serde_json::json!(32768),
        ],
        "batch-size" | "batch_size" | "batch" => vec![
            serde_json::json!(256), serde_json::json!(1024), serde_json::json!(2048),
            serde_json::json!(4096), serde_json::json!(8192),
        ],
        "ubatch-size" | "ubatch_size" => vec![
            serde_json::json!(512), serde_json::json!(1024), serde_json::json!(2048),
            serde_json::json!(4096), serde_json::json!(8192),
        ],
        "parallel" => vec![
            serde_json::json!(1), serde_json::json!(2), serde_json::json!(4),
            serde_json::json!(8), serde_json::json!(16),
        ],
        "gpu-layers" | "n-gpu-layers" | "ngl" => vec![
            serde_json::json!(1), serde_json::json!(20), serde_json::json!(50),
            serde_json::json!(100), serde_json::json!(9999),
        ],
        "flash-attn" | "flash_attn" => vec![
            serde_json::json!(0), serde_json::json!(1),
        ],
        "prio" => vec![
            serde_json::json!(-1), serde_json::json!(0), serde_json::json!(1),
            serde_json::json!(2), serde_json::json!(3),
        ],
        "poll" => vec![
            serde_json::json!(0), serde_json::json!(25), serde_json::json!(50),
            serde_json::json!(75), serde_json::json!(100),
        ],
        "reasoning-budget" | "think-budget" => vec![
            serde_json::json!(-1), serde_json::json!(0), serde_json::json!(1024),
            serde_json::json!(4096), serde_json::json!(8192),
        ],
        "cache-reuse" => vec![
            serde_json::json!(0), serde_json::json!(64), serde_json::json!(256),
            serde_json::json!(512), serde_json::json!(1024),
        ],
        "slot-prompt-similarity" | "sps" => vec![
            serde_json::json!(0.0), serde_json::json!(0.1), serde_json::json!(0.3),
            serde_json::json!(0.5), serde_json::json!(1.0),
        ],
        _ => {
            // Generic: default/2, default, default*2, default*4, default*8
            // But handle special defaults like -1 (means "auto/infinite")
            if default < 0 {
                vec![
                    serde_json::json!(default), serde_json::json!(0), serde_json::json!(1),
                    serde_json::json!(10), serde_json::json!(100),
                ]
            } else if default == 0 {
                vec![
                    serde_json::json!(0), serde_json::json!(1), serde_json::json!(10),
                    serde_json::json!(100), serde_json::json!(1000),
                ]
            } else {
                let d = default as f64;
                vec![
                    serde_json::json!((d / 2.0).max(1.0) as i64),
                    serde_json::json!(default),
                    serde_json::json!(default * 2),
                    serde_json::json!(default * 4),
                    serde_json::json!(default * 8),
                ]
            }
        }
    }
}

/// Generate 5 smart presets for a float parameter.
fn generate_numeric_presets_f64(flag: &str, default: f64) -> Vec<serde_json::Value> {
    let fl = flag.trim_start_matches('-');

    match fl {
        "temp" | "temperature" => vec![
            serde_json::json!(0.1), serde_json::json!(0.5), serde_json::json!(0.8),
            serde_json::json!(1.0), serde_json::json!(1.5),
        ],
        "rope-scale" | "rope-freq-scale" => vec![
            serde_json::json!(0.5), serde_json::json!(1.0), serde_json::json!(1.2),
            serde_json::json!(1.5), serde_json::json!(2.0),
        ],
        "yarn-ext-factor" => vec![
            serde_json::json!(-1.0), serde_json::json!(0.0), serde_json::json!(0.5),
            serde_json::json!(1.0), serde_json::json!(2.0),
        ],
        "yarn-attn-factor" => vec![
            serde_json::json!(0.5), serde_json::json!(0.8), serde_json::json!(1.0),
            serde_json::json!(1.2), serde_json::json!(1.5),
        ],
        _ => {
            if default < 0.0 {
                vec![
                    serde_json::json!(default), serde_json::json!(0.0), serde_json::json!(1.0),
                    serde_json::json!(10.0), serde_json::json!(100.0),
                ]
            } else if default == 0.0 {
                vec![
                    serde_json::json!(0.0), serde_json::json!(0.1), serde_json::json!(0.5),
                    serde_json::json!(1.0), serde_json::json!(2.0),
                ]
            } else {
                vec![
                    serde_json::json!(default / 2.0),
                    serde_json::json!(default),
                    serde_json::json!(default * 2.0),
                    serde_json::json!(default * 4.0),
                    serde_json::json!(default * 8.0),
                ]
            }
        }
    }
}

/// Convert flag like `--threads-batch` → key `"threads_batch"`.
fn flag_to_key(flag: &str) -> String {
    let cleaned = flag.trim_start_matches('-').replace(['-', '_'], "_");
    cleaned
}

/// Convert key like `threads_batch` → label `"Threads Batch"`.
fn key_to_label(key: &str) -> String {
    key.split('_')
        .map(|word| {
            let mut chars = word.chars();
            match chars.next() {
                None => String::new(),
                Some(c) => {
                    let mut result = c.to_uppercase().to_string();
                    result.push_str(&chars.as_str().to_lowercase());
                    result
                }
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Tauri command: parse `llama-server --help` for the given provider.
/// Pass `include_all: true` (power-user mode) to bypass system/server param filtering.
#[tauri::command]
pub async fn get_llama_catalog(
    config: tauri::State<'_, Arc<std::sync::Mutex<AppConfig>>>,
    provider_id: String,
    include_all: Option<bool>,
) -> Result<Vec<LlamaCatalogEntry>, String> {
    let cfg = config.lock().map_err(|e| e.to_string())?;

    // Resolve binary path — uses shared self-healing resolver
    let binary_path = crate::engine_utils::find_provider_binary(&cfg, &provider_id, "")?;

    // Run binary --help
    let output = Command::new(&binary_path)
        .arg("--help")
        .creation_flags(0x08000000) // CREATE_NO_WINDOW — prevents CMD flash in release builds
        .output()
        .map_err(|e| format!("Failed to run {}: {}", binary_path.display(), e))?;

    // Combine stdout + stderr, decode as UTF-8 (lossy)
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    let combined = format!("{}\n{}", stdout, stderr);

    // Parse — filter server/meta params unless power-user requests full catalog
    let filter_system_params = !include_all.unwrap_or(false);
    let entries = parse_help_output(&combined, filter_system_params);
    Ok(entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_help_ignores_indented_flag_references() {
        let text = r#"
--ignore-eos                            ignore end of stream token and continue generating (implies
                                        --logit-bias EOS-inf)
-l,    --logit-bias TOKEN_ID(+/-)BIAS   modifies the likelihood of token appearing in the completion
--spec-ngram-mod-n-max N                maximum number of ngram tokens (default: 64)
--draft, --draft-n, --draft-max N       the argument has been removed. use --spec-draft-n-max or
                                        --spec-ngram-mod-n-max
--spec-ngram-mod-n-min N                minimum number of ngram tokens (default: 48)
--draft-min, --draft-n-min N            the argument has been removed. use --spec-draft-n-min or
                                        --spec-ngram-mod-n-min
"#;

        let entries = parse_help_output(text, true);
        let keys: Vec<&str> = entries.iter().map(|e| e.key.as_str()).collect();

        assert_eq!(keys.iter().filter(|&&k| k == "logit_bias").count(), 1);
        assert_eq!(keys.iter().filter(|&&k| k == "spec_ngram_mod_n_max").count(), 1);
        assert_eq!(keys.iter().filter(|&&k| k == "spec_ngram_mod_n_min").count(), 1);
        assert!(!keys.contains(&"ignore_eos") || keys.iter().filter(|&&k| k == "ignore_eos").count() <= 1);
    }

    #[test]
    fn parse_help_can_include_system_params_when_unfiltered() {
        let text = r#"
-h,    --help, --usage                  print usage and exit
--host HOST                             ip address to listen on (default: 127.0.0.1)
--temp, --temperature N                 temperature (default: 0.80)
"#;

        let filtered = parse_help_output(text, true);
        let filtered_keys: Vec<&str> = filtered.iter().map(|e| e.key.as_str()).collect();
        assert!(!filtered_keys.contains(&"help"));
        assert!(!filtered_keys.contains(&"host"));
        assert!(filtered_keys.contains(&"temp"));

        let full = parse_help_output(text, false);
        let full_keys: Vec<&str> = full.iter().map(|e| e.key.as_str()).collect();
        assert!(full_keys.contains(&"help"));
        assert!(full_keys.contains(&"host"));
        assert!(full_keys.contains(&"temp"));
    }

    #[test]
    fn dedupe_catalog_entries_drops_empty_and_duplicate_keys() {
        let entries = vec![
            LlamaCatalogEntry {
                flag: "--alpha".into(),
                short: None,
                alternates: None,
                key: "alpha".into(),
                label: "Alpha".into(),
                ptype: "slider".into(),
                default_value: None,
                values: None,
                presets: None,
                description: "first".into(),
                env_var: None,
            },
            LlamaCatalogEntry {
                flag: "--alpha".into(),
                short: None,
                alternates: None,
                key: "alpha".into(),
                label: "Alpha".into(),
                ptype: "slider".into(),
                default_value: None,
                values: None,
                presets: None,
                description: "duplicate".into(),
                env_var: None,
            },
            LlamaCatalogEntry {
                flag: "--".into(),
                short: None,
                alternates: None,
                key: "".into(),
                label: "".into(),
                ptype: "slider".into(),
                default_value: None,
                values: None,
                presets: None,
                description: "empty key".into(),
                env_var: None,
            },
        ];

        let deduped = dedupe_catalog_entries(entries);
        assert_eq!(deduped.len(), 1);
        assert_eq!(deduped[0].key, "alpha");
        assert_eq!(deduped[0].description, "first");
    }
}
