//! Permanent benchmark archive.
//!
//! Every bench run is written here at the moment it is measured, so the speed history
//! exists as structured data instead of being scraped back out of logs later. One JSON
//! file per run plus an append-only `index.jsonl` for cheap listing.
//!
//! Design notes that matter:
//!
//! * **Capture never fails the bench.** A missing GPU, an unreachable `/props`, a read-only
//!   disk — all are logged and the bench result still returns to the UI.
//! * **Enrichment is engine-side truth.** The bench commands only know port and inputs; the
//!   model, build and context come from the engine's own `/props`, and the hardware from
//!   telemetry. Logs are never parsed.
//! * **A run is only comparable to runs with the same `comparability` hash**, which covers
//!   model path, engine build, ctx, slots, source and the bench inputs. That is what makes
//!   the published graph defensible.
//! * **Quality is recorded, not hidden.** Obviously impossible numbers (e.g. speculative
//!   accounting producing 84k tok/s) are tagged `rejected` with reasons, and the raw metrics
//!   are kept for audit.

use std::io::Write;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

const SCHEMA: u32 = 1;

/// Runs below this generation length are too short to trust as a throughput number.
const MIN_TG_TOKENS: usize = 32;
/// Thresholds are heuristics, deliberately generous: flag, never silently drop.
const TG_SUSPECT: f64 = 2_000.0;
const TG_REJECT: f64 = 5_000.0;
const PP_SUSPECT: f64 = 100_000.0;
const PP_REJECT: f64 = 500_000.0;
const MIN_PP_TOKENS: usize = 256;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Quality {
    Ok,
    Suspect,
    Rejected,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct EngineSnapshot {
    pub port: u16,
    pub model_path: Option<String>,
    pub model_alias: Option<String>,
    pub model_ftype: Option<String>,
    pub build_info: Option<String>,
    pub total_slots: Option<u64>,
    pub n_ctx: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GpuLine {
    pub index: u32,
    pub name: String,
    pub memory_total_mb: u64,
    pub driver: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct HardwareSnapshot {
    pub gpus: Vec<GpuLine>,
    pub cpu: Option<String>,
    pub ram_mib: Option<u64>,
    pub nvidia_driver: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BenchRun {
    pub schema: u32,
    pub id: String,
    pub ts: String,
    pub source: String,
    pub app_version: String,
    pub debug_build: bool,
    /// Engine instance (launch) this measurement belongs to.
    pub session: Option<String>,
    /// Exact engine launch command, when this process launched that port.
    pub command: Option<String>,
    pub engine: EngineSnapshot,
    pub hw: HardwareSnapshot,
    pub params: serde_json::Value,
    pub metrics: serde_json::Value,
    pub comparability: String,
    pub quality: Quality,
    pub quality_reasons: Vec<String>,
}

/// `{config_dir}/bench` — app data, not the repo.
///
/// `BLACKWELL_BENCH_DIR` overrides the root (used by the live smoke test, and by anyone
/// who wants the archive somewhere else, e.g. a network share or a benchmark repo).
pub fn archive_root() -> PathBuf {
    if let Ok(dir) = std::env::var("BLACKWELL_BENCH_DIR") {
        if !dir.trim().is_empty() {
            return PathBuf::from(dir);
        }
    }
    crate::config::config_dir().join("bench")
}

pub fn runs_dir() -> PathBuf {
    archive_root().join("runs")
}

pub fn index_path() -> PathBuf {
    archive_root().join("index.jsonl")
}

/// Engine-side speculative-decode counters: (accepted draft tokens, draft tokens proposed).
/// Global per port, so a delta around one bench run is that run's acceptance.
pub async fn spec_counters(port: u16) -> Option<(u64, u64)> {
    let url = format!("http://127.0.0.1:{port}/metrics");
    let text = reqwest::get(&url).await.ok()?.text().await.ok()?;
    let (mut acc, mut draft) = (0u64, 0u64);
    for line in text.lines() {
        if let Some(v) = line.strip_prefix("llamacpp:spec_decode_num_accepted_tokens_total ") {
            acc = v.trim().parse().unwrap_or(0);
        } else if let Some(v) = line.strip_prefix("llamacpp:spec_decode_num_draft_tokens_total ") {
            draft = v.trim().parse().unwrap_or(0);
        }
    }
    if draft > 0 { Some((acc, draft)) } else { None }
}

/// Classify one measurement. Pure so the rules are testable without an engine.
pub fn classify(source: &str, metrics: &serde_json::Value) -> (Quality, Vec<String>) {
    let mut reasons = Vec::new();
    let success = metrics.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
    if !success {
        if let Some(err) = metrics.get("error").and_then(|v| v.as_str()) {
            reasons.push(format!("bench reported failure: {err}"));
        } else {
            reasons.push("bench reported failure".to_string());
        }
        return (Quality::Rejected, reasons);
    }

    if source == "tg_burst" {
        let gen_tokens = metrics.get("gen_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let gen_tps = metrics.get("gen_tps").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if gen_tokens < MIN_TG_TOKENS {
            reasons.push(format!("generation too short ({gen_tokens} < {MIN_TG_TOKENS} tokens)"));
        }
        if !gen_tps.is_finite() || gen_tps <= 0.0 {
            reasons.push(format!("non-positive gen_tps ({gen_tps})"));
        }
        if gen_tps > TG_REJECT {
            reasons.push(format!("gen_tps {gen_tps:.1} above plausible ceiling {TG_REJECT:.0}"));
        } else if gen_tps > TG_SUSPECT {
            reasons.push(format!("gen_tps {gen_tps:.1} unusually high (> {TG_SUSPECT:.0})"));
        }
    } else if source == "pp_burst" {
        let tokens = metrics.get("prompt_tokens").and_then(|v| v.as_u64()).unwrap_or(0) as usize;
        let tps = metrics.get("prompt_tps").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if tokens < MIN_PP_TOKENS {
            reasons.push(format!("prefill too short ({tokens} < {MIN_PP_TOKENS} tokens)"));
        }
        if !tps.is_finite() || tps <= 0.0 {
            reasons.push(format!("non-positive prompt_tps ({tps})"));
        }
        if tps > PP_REJECT {
            reasons.push(format!("prompt_tps {tps:.0} above plausible ceiling {PP_REJECT:.0}"));
        } else if tps > PP_SUSPECT {
            reasons.push(format!("prompt_tps {tps:.0} unusually high (> {PP_SUSPECT:.0})"));
        }
    }

    if reasons.iter().any(|r| r.contains("ceiling") || r.contains("non-positive") || r.contains("too short")) {
        (Quality::Rejected, reasons)
    } else if reasons.is_empty() {
        (Quality::Ok, reasons)
    } else {
        (Quality::Suspect, reasons)
    }
}

/// Launch flags that actually explain a speed change. Canonical long names only, so a
/// short-flag launch and a long-flag launch hash the same.
fn canonical_flag(tok: &str) -> Option<&'static str> {
    match tok.split('=').next().unwrap_or(tok) {
        "-c" | "--ctx-size" => Some("ctx-size"),
        "-np" | "--parallel" => Some("parallel"),
        "-b" | "--batch-size" => Some("batch-size"),
        "-ub" | "--ubatch-size" => Some("ubatch-size"),
        "-fa" | "--flash-attn" => Some("flash-attn"),
        "-ctk" | "--cache-type-k" => Some("cache-type-k"),
        "-ctv" | "--cache-type-v" => Some("cache-type-v"),
        "--spec-type" => Some("spec-type"),
        "-md" | "--spec-draft-model" => Some("spec-draft-model"),
        "--spec-draft-n-max" => Some("spec-draft-n-max"),
        "--spec-draft-n-min" => Some("spec-draft-n-min"),
        "--spec-draft-p-min" => Some("spec-draft-p-min"),
        "-t" | "--threads" => Some("threads"),
        "-ngl" | "--n-gpu-layers" => Some("n-gpu-layers"),
        "-sm" | "--split-mode" => Some("split-mode"),
        "--tensor-split" => Some("tensor-split"),
        _ => None,
    }
}

/// Split a command line into tokens, honouring double quotes.
fn tokenize(cmd: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_quotes = false;
    for ch in cmd.chars() {
        match ch {
            '"' => in_quotes = !in_quotes,
            c if c.is_whitespace() && !in_quotes => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

/// Extract the tracked flags from a launch command. Pure and order-stable (BTreeMap).
pub fn parse_launch_flags(cmd: &str) -> serde_json::Value {
    let tokens = tokenize(cmd);
    let mut out = std::collections::BTreeMap::new();
    let mut i = 0;
    while i < tokens.len() {
        let tok = &tokens[i];
        if let Some(name) = canonical_flag(tok) {
            let value = if let Some(eq) = tok.find('=') {
                tok[eq + 1..].to_string()
            } else if i + 1 < tokens.len() && !tokens[i + 1].starts_with('-') {
                i += 1;
                tokens[i].clone()
            } else {
                "true".to_string()
            };
            out.insert(name.to_string(), serde_json::Value::String(value));
        }
        i += 1;
    }
    serde_json::Value::Object(out.into_iter().collect())
}

/// Stable hash of everything that must match for two runs to be comparable.
pub fn comparability_hash(source: &str, engine: &EngineSnapshot, params: &serde_json::Value) -> String {
    let canonical = format!(
        "{}|{}|{}|{}|{}|{}|{}|{}|{}",
        source,
        engine.model_path.as_deref().unwrap_or(""),
        engine.build_info.as_deref().unwrap_or(""),
        engine.n_ctx.map(|v| v.to_string()).unwrap_or_default(),
        engine.total_slots.map(|v| v.to_string()).unwrap_or_default(),
        params.get("prompt_mode").and_then(|v| v.as_str()).unwrap_or(""),
        params.get("n_predict").and_then(|v| v.as_u64()).map(|v| v.to_string()).unwrap_or_default(),
        params.get("parallel_requests").and_then(|v| v.as_u64()).map(|v| v.to_string()).unwrap_or_default(),
        // Launch flags: a run with MTP on is not comparable to one with it off.
        params.get("flags").map(|v| v.to_string()).unwrap_or_default(),
    );
    let digest = Sha256::digest(canonical.as_bytes());
    hex::encode(&digest[..8])
}

async fn engine_snapshot(port: u16) -> EngineSnapshot {
    let mut snap = EngineSnapshot { port, ..Default::default() };
    let url = format!("http://127.0.0.1:{port}/props");
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(3))
        .build()
    {
        Ok(c) => c,
        Err(e) => {
            log::warn!("[bench-archive] http client: {e}");
            return snap;
        }
    };
    let value: serde_json::Value = match client.get(&url).send().await {
        Ok(resp) => match resp.json().await {
            Ok(v) => v,
            Err(e) => {
                log::warn!("[bench-archive] /props parse: {e}");
                return snap;
            }
        },
        Err(e) => {
            log::warn!("[bench-archive] /props fetch: {e}");
            return snap;
        }
    };
    let s = |k: &str| value.get(k).and_then(|v| v.as_str()).map(|v| v.to_string());
    snap.model_path = s("model_path");
    snap.model_alias = s("model_alias");
    snap.model_ftype = s("model_ftype");
    snap.build_info = s("build_info");
    snap.total_slots = value.get("total_slots").and_then(|v| v.as_u64());
    snap.n_ctx = value
        .get("default_generation_settings")
        .and_then(|g| g.get("n_ctx"))
        .and_then(|v| v.as_u64());
    snap
}

async fn hardware_snapshot() -> HardwareSnapshot {
    let mut hw = HardwareSnapshot::default();
    if let Ok(gpus) = crate::telemetry::scan_gpus().await {
        hw.gpus = gpus
            .into_iter()
            .map(|g| GpuLine {
                index: g.index,
                name: g.name,
                memory_total_mb: g.memory_total_manufactured.max(g.memory_total),
                driver: g.driver_version,
            })
            .collect();
    }
    if let Ok(cpu) = crate::telemetry::scan_cpu().await {
        hw.cpu = Some(format!("{} ({}C/{}T)", cpu.name, cpu.cores, cpu.threads));
    }
    if let Ok(sys) = crate::telemetry::scan_system_info().await {
        hw.ram_mib = Some(sys.total_memory_manufactured_mib.max(sys.total_memory_mib));
    }
    if let Ok(driver) = crate::telemetry::get_nvidia_driver_version().await {
        hw.nvidia_driver = driver;
    }
    hw
}

fn timestamp_parts() -> (String, String, String) {
    let now = chrono::Utc::now();
    (now.to_rfc3339_opts(chrono::SecondsFormat::Secs, true), now.format("%Y-%m-%d").to_string(), now.format("%Y%m%dT%H%M%SZ").to_string())
}

fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Capture a finished bench run. Returns the written path on success.
///
/// Never returns an error to the caller's bench path: log and continue.
pub async fn capture(
    source: &str,
    port: u16,
    mut params: serde_json::Value,
    metrics: serde_json::Value,
) -> Result<PathBuf, String> {
    let (ts, day, stamp) = timestamp_parts();
    let engine = engine_snapshot(port).await;

    if !params.is_object() {
        params = serde_json::json!({});
    }
    if let Some(obj) = params.as_object_mut() {
        obj.insert("port".into(), serde_json::json!(port));
        obj.insert("n_ctx".into(), serde_json::json!(engine.n_ctx));
        obj.insert("total_slots".into(), serde_json::json!(engine.total_slots));
    }

    // The flags that actually caused a speed change (flash-attn, KV types, MTP, threads).
    // Without these a run is not comparable to the one before it.
    let command = crate::session_log::launch_cmd_for_port(port);
    let session = crate::session_log::engine_session_for_port(port);
    if let Some(cmd) = command.as_deref() {
        let flags = parse_launch_flags(cmd);
        if let Some(obj) = params.as_object_mut() {
            obj.insert("flags".into(), flags);
        }
    }

    let (quality, quality_reasons) = classify(source, &metrics);
    let comparability = comparability_hash(source, &engine, &params);
    let id = format!("{stamp}_{source}_{}", &comparability[..6.min(comparability.len())]);

    let run = BenchRun {
        schema: SCHEMA,
        id: id.clone(),
        ts: ts.clone(),
        source: source.to_string(),
        app_version: app_version(),
        debug_build: cfg!(debug_assertions),
        session,
        command,
        engine,
        hw: hardware_snapshot().await,
        params,
        metrics,
        comparability,
        quality: quality.clone(),
        quality_reasons,
    };

    let dir = runs_dir().join(&day);
    std::fs::create_dir_all(&dir).map_err(|e| format!("bench dir: {e}"))?;
    let path = dir.join(format!("{id}.json"));
    let body = serde_json::to_string_pretty(&run).map_err(|e| format!("bench json: {e}"))?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, &body).map_err(|e| format!("bench write: {e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("bench rename: {e}"))?;

    // Append-only index for cheap listing without walking the tree.
    if let Ok(mut idx) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(index_path())
    {
        let line = serde_json::json!({
            "id": run.id,
            "ts": run.ts,
            "source": run.source,
            "comparability": run.comparability,
            "quality": run.quality,
            "model": run.engine.model_path,
        });
        let _ = writeln!(idx, "{line}");
    }

    log::info!("[bench-archive] {} {} → {}", run.source, run.id, path.display());
    Ok(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tg(gen_tokens: u64, gen_tps: f64) -> serde_json::Value {
        serde_json::json!({ "success": true, "gen_tokens": gen_tokens, "gen_tps": gen_tps })
    }

    #[test]
    fn plausible_runs_are_ok() {
        let (q, r) = classify("tg_burst", &tg(512, 145.0));
        assert_eq!(q, Quality::Ok);
        assert!(r.is_empty());

        let (q, r) = classify("pp_burst", &serde_json::json!({ "success": true, "prompt_tokens": 8192, "prompt_tps": 3100.0 }));
        assert_eq!(q, Quality::Ok);
        assert!(r.is_empty());
    }

    #[test]
    fn impossible_speeds_are_rejected_not_hidden() {
        // The real outlier: speculative accounting reported ~84k tok/s.
        let (q, r) = classify("tg_burst", &tg(47885, 84_363.6));
        assert_eq!(q, Quality::Rejected);
        assert!(r.iter().any(|x| x.contains("ceiling")));

        let (q, _) = classify("pp_burst", &serde_json::json!({ "success": true, "prompt_tokens": 4096, "prompt_tps": 0.0 }));
        assert_eq!(q, Quality::Rejected);
    }

    #[test]
    fn short_or_high_runs_are_flagged() {
        let (q, r) = classify("tg_burst", &tg(8, 120.0));
        assert_eq!(q, Quality::Rejected);
        assert!(r.iter().any(|x| x.contains("too short")));

        let (q, r) = classify("tg_burst", &tg(512, 3_000.0));
        assert_eq!(q, Quality::Suspect);
        assert!(r.iter().any(|x| x.contains("unusually high")));
    }

    #[test]
    fn failed_benches_are_rejected_with_the_reason() {
        let (q, r) = classify("tg_burst", &serde_json::json!({ "success": false, "error": "Stopped" }));
        assert_eq!(q, Quality::Rejected);
        assert!(r[0].contains("Stopped"));
    }

    #[test]
    fn comparability_changes_when_context_or_build_changes() {
        let engine = EngineSnapshot {
            port: 8889,
            model_path: Some("m.gguf".into()),
            build_info: Some("b1095-84e66d032".into()),
            n_ctx: Some(65536),
            total_slots: Some(4),
            ..Default::default()
        };
        let params = serde_json::json!({ "prompt_mode": "repetitive", "n_predict": 512, "parallel_requests": 1 });
        let a = comparability_hash("tg_burst", &engine, &params);

        let mut other = engine.clone();
        other.n_ctx = Some(32768);
        let b = comparability_hash("tg_burst", &other, &params);
        assert_ne!(a, b, "ctx must be part of comparability");

        let mut same = engine.clone();
        same.total_slots = Some(4);
        assert_eq!(a, comparability_hash("tg_burst", &same, &params));
    }

    #[test]
    fn launch_flags_are_parsed_from_the_command_line() {
        let cmd = r#"C:\bin\llama-server.exe -m "C:\models\a b\m.gguf" -c 8192 -np 8 -b 2048 -ub 512 -fa on -ctk q8_0 -ctv q8_0 --spec-type draft-mtp -md "C:\d\draft.gguf" --spec-draft-n-max 6 -t 16 -ngl 99 --split-mode layer"#;
        let flags = parse_launch_flags(cmd);
        assert_eq!(flags["ctx-size"], "8192");
        assert_eq!(flags["parallel"], "8");
        assert_eq!(flags["flash-attn"], "on");
        assert_eq!(flags["cache-type-k"], "q8_0");
        assert_eq!(flags["spec-type"], "draft-mtp");
        assert_eq!(flags["spec-draft-model"], r"C:\d\draft.gguf");
        assert_eq!(flags["spec-draft-n-max"], "6");
        assert_eq!(flags["split-mode"], "layer");
        // Quoted paths must not leak into the next flag's value.
        assert_eq!(flags["batch-size"], "2048");
    }

    #[test]
    fn comparability_separates_runs_with_different_flags() {
        let engine = EngineSnapshot {
            port: 8889,
            model_path: Some("m.gguf".into()),
            build_info: Some("b1".into()),
            n_ctx: Some(8192),
            total_slots: Some(8),
            ..Default::default()
        };
        let base = serde_json::json!({ "prompt_mode": "repetitive", "n_predict": 4096, "parallel_requests": 8 });
        let mut with_mtp = base.clone();
        with_mtp["flags"] = serde_json::json!({ "spec-type": "draft-mtp" });
        let mut without = base.clone();
        without["flags"] = serde_json::json!({});
        assert_ne!(
            comparability_hash("tg_burst", &engine, &with_mtp),
            comparability_hash("tg_burst", &engine, &without),
            "MTP on/off must not share a series"
        );
    }

    /// End-to-end smoke: real `/props`, real telemetry, real file on disk.
    ///
    /// `#[ignore]` on purpose — it talks to a live engine and writes to the archive.
    /// Run it explicitly: `cargo test -- --ignored live_capture_smoke --nocapture`
    /// with `BLACKWELL_BENCH_DIR` pointed at a scratch directory.
    #[tokio::test]
    #[ignore]
    async fn live_capture_smoke() {
        let metrics = serde_json::json!({
            "success": true,
            "prompt_tokens": 512,
            "gen_tokens": 128,
            "prompt_tps": 3100.0,
            "gen_tps": 145.0,
            "itl_ms": 6.9,
            "parallel_requests": 1,
        });
        let params = serde_json::json!({
            "prompt_mode": "repetitive",
            "n_predict": 128,
            "parallel_requests": 1,
        });
        let path = capture("tg_burst", 8889, params, metrics).await.expect("capture");
        assert!(path.is_file(), "archive file written");
        let body = std::fs::read_to_string(&path).expect("read back");
        let run: BenchRun = serde_json::from_str(&body).expect("valid schema");
        assert_eq!(run.source, "tg_burst");
        assert!(!run.comparability.is_empty());
        println!("captured: {}", path.display());
        println!(
            "engine: build={:?} model={:?} ctx={:?} slots={:?}",
            run.engine.build_info, run.engine.model_alias, run.engine.n_ctx, run.engine.total_slots
        );
        println!("hw: {:?}", run.hw.gpus);
        println!("quality: {:?} {:?}", run.quality, run.quality_reasons);
    }
}
