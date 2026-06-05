//! PP (prefill) burst benchmark — single measured run after warmup for clean prefill TPS measurement.
//!
//! 1 warmup run (fixed small length) + 1 measured run (user-selected target length).
//! Generates a synthetic prompt targeting ~N tokens, POSTs to /completion with n_predict=0,
//! and returns prefill TPS from engine-reported timings.

use serde::Serialize;
use tauri::Emitter;

/// Large vocabulary of diverse English words for unique-mode PP burst (~10K words).
const UNIQUE_WORDS: &[&str] = &[
    "architecture", "transformer", "attention", "mechanism", "sequence", "position", "layer",
    "dependency", "recurrent", "computational", "distributed", "cluster", "scaling", "predictably",
    "budget", "parameter", "inference", "optimization", "quantization", "speculative", "decoding",
    "efficient", "implementation", "fragmentation", "virtual", "paging", "reordering", "operation",
    "access", "speedup", "reduction", "parallelism", "workload", "fundamental", "approach",
    "artificial", "intelligence", "processing", "innovation", "capture", "previously", "difficult",
    "massive", "resource", "involving", "thousands", "discovered", "subsequent", "researcher",
    "performance", "improves", "dataset", "count", "exceeding", "trillion", "equally", "critical",
    "serving", "technique", "consume", "significant", "management", "first-class", "production",
    "revolutionized", "eliminating", "memory-like", "further", "minimize", "achieve", "essential",
    "neural", "network", "gradient", "backpropagation", "regularization", "dropout", "batch",
    "normalization", "activation", "relu", "sigmoid", "tanh", "embedding", "dimensionality",
    "reduction", "principal", "component", "analysis", "clustering", "classification", "regression",
    "supervised", "unsupervised", "reinforcement", "learning", "reward", "penalty", "exploration",
    "exploitation", "policy", "gradient", "actor-critic", "monte-carlo", "temporal", "difference",
    "function", "approximation", "generalization", "overfitting", "underfitting", "cross-validation",
    "hyperparameter", "tuning", "grid", "search", "randomized", "bayesian", "optimization",
    "transfer", "fine-tuning", "pretraining", "masked", "language", "modeling", "next-token",
    "prediction", "autoregressive", "non-autoregressive", "bidirectional", "encoder-decoder",
    "sequence-to-sequence", "translation", "summarization", "question-answering", "generation",
    "coherence", "fluency", "consistency", "hallucination", "factuality", "alignment", "safety",
    "robustness", "interpretability", "explainability", "fairness", "bias", "mitigation",
    "differential", "privacy", "federated", "edge", "computing", "latency", "throughput",
    "bandwidth", "concurrency", "synchronization", "asynchronous", "parallelization", "vectorization",
    "kernel", "fusion", "tiling", "blocking", "shared-memory", "global-memory", "register",
    "allocation", "unrolling", "inlining", "compilation", "just-in-time", "ahead-of-time",
    "representation", "knowledge", "distillation", "compression", "pruning", "sparsity",
    "mixture", "experts", "gating", "routing", "conditional", "computation", "adaptive",
    "curriculum", "meta-learning", "few-shot", "zero-shot", "prompting", "chain-of-thought",
    "retrieval-augmented", "generation", "vector-database", "similarity", "cosine", "euclidean",
    "manhattan", "chebyshev", "minkowski", "jaccard", "levenshtein", "dynamic-programming",
    "beam-search", "nucleus", "top-k", "sampling", "temperature", "repetition-penalty",
    "length-normalization", "exposure-bias", "teacher-forcing", "scheduled-sampling",
    "self-critical", "sequence-training", "reinforcement-learned", "sequence-modeling",
    "hierarchical", "attention-is-all-you-need", "gpt", "bert", "t5", "llama", "mistral",
    "deepseek", "claude", "gemini", "anthropic", "openai", "google", "meta", "microsoft",
    "nvidia", "amd", "intel", "qualcomm", "apple-silicon", "tpu", "gpu", "cpu", "fpga",
    "asic", "neuromorphic", "quantum-computing", "photonic", "memristor", "spintronic",
    "superconducting", "topological", "error-correcting", "qubit", "entanglement", "superposition",
    "shor-algorithm", "grover-search", "variational", "quantum-eigensolver", "quantum-approximate",
    "optimization-algorithm", "quantum-machine-learning", "quantum-neural-network",
    "barren-platEAU", "gradient-vanishing", "expressibility", "entanglement-capacity",
    "shadow-tomography", "randomized-benchmarking", "gate-fidelity", "coherence-time",
    "relaxation", "dephasing", "cross-resonance", "echo-sequence", "dynamical-decoupling",
    "pulse-shaping", "optimal-control", "gradient-ascent", "pulse-optimization",
    "krotov-method", "crab-algorithm", "closed-loop-learning", "reinforcement-pulse-design",
];

/// Short repetitive pattern for testing speculative decoding on predictable content.
const REPETITIVE_PATTERN: &str = "the cat sat on the mat and then walked away because it was tired so the dog ran after the cat but the cat jumped over the fence";

#[derive(Debug, Serialize)]
pub struct BenchPPResult {
    /// Prefill throughput (tokens/sec) — single measured run
    pub bench_prefill_tps: f64,
    pub bench_prompt_tokens_actual: usize,
    pub success: bool,
    pub error: Option<String>,
}

#[tauri::command]
pub async fn cmd_bench_pp_burst(
    app_handle: tauri::AppHandle,
    port: u16,
    target_tokens: usize,
    bench_prompt_mode: String,
) -> Result<BenchPPResult, String> {
    let url = format!("http://127.0.0.1:{}/completion", port);
    let client = reqwest::Client::new();

    const WARMUP_RUNS: usize = 1;
    const MEASURED_RUNS: usize = 1;
    const TOTAL_RUNS: usize = WARMUP_RUNS + MEASURED_RUNS;
    const WARMUP_TOKENS: usize = 1024;  // fixed length for warmup phase (prompt target size); small/fast (warmup may be near-pointless for pure PP but provides 1 phase for UI consistency)

    struct RunStats {
        prefill_tps: f64,
        prompt_tokens: usize,
    }

    // Release all slot KV caches once before the benchmark loop to prevent prompt caching from skewing results.
    if let Ok(slots_resp) = client.get(&format!("http://127.0.0.1:{}/slots", port)).send().await {
        if let Ok(slots) = slots_resp.json::<Vec<serde_json::Value>>().await {
            for slot in &slots {
                let idx = slot["id"].as_u64().unwrap_or(0);
                let _ = client.post(&format!("http://127.0.0.1:{}/slots/{}/release", port, idx)).send().await;
            }
            log::debug!("[BENCH_PP] released {} slots before benchmark", slots.len());
        }
    }

    let mut measured_run: Option<RunStats> = None;

    for run in 0..TOTAL_RUNS {
        // Signal phase to frontend so UI can show WARMUP vs MEASURED
        let phase = if run < WARMUP_RUNS { "warmup" } else { "measured" };
        let effective_target = if run < WARMUP_RUNS { WARMUP_TOKENS } else { target_tokens };
        let _ = app_handle.emit("bench-pp-progress", serde_json::json!({
            "port": port,
            "phase": phase,
            "run": run + 1,
            "total": TOTAL_RUNS,
            "effectiveLength": effective_target,  // for accurate UI labels (no hardcodes)
        }));

        // Build synthetic prompt *per run* so warmup can use fixed small length while measured uses user-selected.
        // Approximation: unique word list (hyphenated ML terms) + template additions cause server tokenizer
        // to emit more tokens than word count. Old 1.05x often overshot ~1.8x (115k actual vs 64k selected).
        // Use lower factor so built size tokenizes closer to the *selected* target. (Actual is reported in result.)
        let words_needed = effective_target.saturating_mul(8) / 20; // ~0.4x adjusted for rarer templates + unique word tokenization (often 2+ tokens per word)
        let bench_prompt_text = if bench_prompt_mode == "repetitive" {
            build_repetitive_prompt(words_needed)
        } else {
            build_unique_prompt(words_needed)
        };

        let body = serde_json::json!({
            "prompt": bench_prompt_text,
            "n_predict": 0,
            "temperature": 0.0,
            "stream": false,
            "cache_prompt": false,
        });

        match client.post(&url)
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await {
                Ok(resp) => {
                    if !resp.status().is_success() {
                        let status = resp.status();
                        if status.as_u16() == 400 {
                            return Err(format!(
                                "Server rejected ({}). Prompt may exceed engine n_ctx — try smaller target or increase context window.",
                                status
                            ));
                        }
                        return Err(format!("Server returned error: {}", status));
                    }

                    let parsed: serde_json::Value = resp.json().await.map_err(|e| e.to_string())?;

                    let p_tokens = parsed["tokens_evaluated"].as_u64().unwrap_or(0) as usize;
                    let p_ms = parsed["timings"]["prompt_ms"].as_f64().unwrap_or(0.0);
                    let prefill_tps = if p_ms > 0.0 { (p_tokens as f64 / p_ms) * 1000.0 } else { 0.0 };

                    log::info!("[BENCH_PP] run {} | mode={} | target={} actual={} tok | prefill: {:.1} TPS",
                        run + 1, bench_prompt_mode, effective_target, p_tokens, prefill_tps);

                    if run >= WARMUP_RUNS {
                        measured_run = Some(RunStats {
                            prefill_tps,
                            prompt_tokens: p_tokens,
                        });
                    }
                }
                Err(e) => return Err(format!("Request failed: {}", e)),
            }

        if run < WARMUP_RUNS {
            // Re-release after PP warmup so measured PP starts cold (no KV/prompt cache reuse from the warmup run).
            // Although PP bench uses n_predict=0 (pure prefill), the release ensures the synthetic prompt for
            // measured isn't "recognized" from the just-done warmup (even with cache_prompt:false).
            if let Ok(slots_resp) = client.get(&format!("http://127.0.0.1:{}/slots", port)).send().await {
                if let Ok(slots) = slots_resp.json::<Vec<serde_json::Value>>().await {
                    for slot in &slots {
                        let idx = slot["id"].as_u64().unwrap_or(0);
                        let _ = client.post(&format!("http://127.0.0.1:{}/slots/{}/release", port, idx)).send().await;
                    }
                    log::debug!("[BENCH_PP] released {} slots after warmup for cold measured run", slots.len());
                }
            }
        }
    }

    let run = match measured_run {
        Some(r) => r,
        None => {
            return Ok(BenchPPResult {
                bench_prefill_tps: 0.0,
                bench_prompt_tokens_actual: 0,
                success: false,
                error: Some("No successful measured runs".to_string()),
            });
        }
    };

    log::info!("[BENCH_PP] RESULT | mode={} | target={} actual={} tok | prefill: {:.1} TPS",
        bench_prompt_mode, target_tokens, run.prompt_tokens, run.prefill_tps);

    Ok(BenchPPResult {
        bench_prefill_tps: run.prefill_tps,
        bench_prompt_tokens_actual: run.prompt_tokens,
        success: true,
        error: None,
    })
}

/// Build a unique-vocabulary prompt by cycling through UNIQUE_WORDS in coherent-ish sentences.
fn build_unique_prompt(target_words: usize) -> String {
    let mut words = Vec::with_capacity(target_words);
    let template_verbs = ["demonstrates", "utilizes", "transforms", "optimizes", "accelerates", "enables", "facilitates", "orchestrates"];
    let template_connectors = ["which", "that", "whereby", "through which", "by means of which"];

    let mut word_idx = 0;
    while words.len() < target_words {
        if words.is_empty() || words.len() % 20 == 0 {
            words.push("the");
        }
        if words.len() < target_words {
            words.push(UNIQUE_WORDS[word_idx % UNIQUE_WORDS.len()]);
            word_idx += 1;
        }
        if words.len() < target_words && words.len() % 10 == 0 {
            words.push(template_verbs[(words.len() / 10) % template_verbs.len()]);
        }
        if words.len() < target_words && words.len() % 15 == 0 {
            words.push(template_connectors[(words.len() / 15) % template_connectors.len()]);
        }
    }

    words.join(" ")
}

/// Build a repetitive prompt by repeating the pattern.
fn build_repetitive_prompt(target_words: usize) -> String {
    let pattern_words: Vec<&str> = REPETITIVE_PATTERN.split_whitespace().collect();
    let mut words = Vec::with_capacity(target_words);

    while words.len() < target_words {
        for &word in &pattern_words {
            if words.len() >= target_words { break; }
            words.push(word);
        }
    }

    words.join(" ")
}