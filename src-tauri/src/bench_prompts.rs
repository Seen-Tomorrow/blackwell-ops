//! Shared synthetic prompts for TG + PP benchmarks — single source of truth for Unique/Repetitive.
//!
//! **Unique** — cycles a large technical vocabulary (diverse tokens, low cross-request predictability).
//! **Repetitive** — cycles a fixed short phrase (highly predictable prefill + temp-0 decode continuation).
//!
//! Both modes calibrate via the engine `/tokenize` endpoint so prefill token counts match targets.

use crate::bench_cancel;

/// TG bench: fixed prefill size for warmup and measured runs (decode length = `n_predict` only).
pub const TG_PREFILL_TARGET_TOKENS: usize = 512;

/// Leave free room in each slot so a full-CTX PP target never trips "out of context".
/// (~2% of slot n_ctx, clamped 256–512) covers specials + calibration overshoot.
pub fn pp_prompt_budget_for_slot_ctx(slot_n_ctx: usize) -> usize {
    if slot_n_ctx == 0 {
        return usize::MAX;
    }
    let reserve = (slot_n_ctx / 50).clamp(256, 512);
    slot_n_ctx.saturating_sub(reserve)
}

/// Cap a user PP target to what can safely fit in one slot.
pub fn clamp_pp_target_to_slot_ctx(target: usize, slot_n_ctx: usize) -> usize {
    let budget = pp_prompt_budget_for_slot_ctx(slot_n_ctx);
    if budget == usize::MAX {
        return target;
    }
    target.min(budget).max(64)
}

/// Large vocabulary of diverse English words for unique-mode bursts.
pub const UNIQUE_WORDS: &[&str] = &[
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
    "barren-plateau", "gradient-vanishing", "expressibility", "entanglement-capacity",
    "shadow-tomography", "randomized-benchmarking", "gate-fidelity", "coherence-time",
    "relaxation", "dephasing", "cross-resonance", "echo-sequence", "dynamical-decoupling",
    "pulse-shaping", "optimal-control", "gradient-ascent", "pulse-optimization",
    "krotov-method", "crab-algorithm", "closed-loop-learning", "reinforcement-pulse-design",
];

/// Short phrase cycled for repetitive mode — predictable for MTP / speculative decode benches.
pub const REPETITIVE_PATTERN: &str =
    "the cat sat on the mat and then walked away because it was tired so the dog ran after the cat but the cat jumped over the fence";

pub fn is_repetitive_mode(bench_prompt_mode: &str) -> bool {
    match bench_prompt_mode.to_ascii_lowercase().as_str() {
        "repetitive" => true,
        "unique" => false,
        other => {
            log::warn!(
                "[BENCH] unknown prompt mode {:?} — defaulting to unique",
                other
            );
            false
        }
    }
}

/// Build a unique-vocabulary prompt by cycling UNIQUE_WORDS in coherent-ish sentences.
pub fn build_unique_prompt(target_words: usize) -> String {
    let mut words = Vec::with_capacity(target_words);
    let template_verbs = [
        "demonstrates",
        "utilizes",
        "transforms",
        "optimizes",
        "accelerates",
        "enables",
        "facilitates",
        "orchestrates",
    ];
    let template_connectors = [
        "which",
        "that",
        "whereby",
        "through which",
        "by means of which",
    ];

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

/// Build a repetitive prompt by cycling REPETITIVE_PATTERN until `target_words`.
pub fn build_repetitive_prompt(target_words: usize) -> String {
    let pattern_words: Vec<&str> = REPETITIVE_PATTERN.split_whitespace().collect();
    let mut words = Vec::with_capacity(target_words);

    while words.len() < target_words {
        for &word in &pattern_words {
            if words.len() >= target_words {
                break;
            }
            words.push(word);
        }
    }

    words.join(" ")
}

fn token_target_tolerance(target: usize) -> i64 {
    (target as i64 / 25).max(256)
}

async fn count_prompt_tokens(client: &reqwest::Client, port: u16, content: &str) -> Option<usize> {
    let url = format!("http://127.0.0.1:{port}/tokenize");
    let body = serde_json::json!({
        "content": content,
        "add_special": false,
        "parse_special": false,
    });
    let resp = client.post(&url).json(&body).send().await.ok()?;
    if !resp.status().is_success() {
        return None;
    }
    let parsed: serde_json::Value = resp.json().await.ok()?;
    parsed
        .get("tokens")
        .and_then(|t| t.as_array())
        .map(|a| a.len())
}

/// Build prompt text so `/tokenize` count is within tolerance of `target_tokens`.
/// When `max_tokens` is set (slot CTX budget), never return a prompt over that ceiling.
pub async fn build_prompt_for_token_target(
    client: &reqwest::Client,
    port: u16,
    target_tokens: usize,
    repetitive: bool,
    log_tag: &str,
) -> Result<String, String> {
    build_prompt_for_token_target_capped(client, port, target_tokens, repetitive, log_tag, None)
        .await
}

/// Like [`build_prompt_for_token_target`], with an optional hard tokenize ceiling.
pub async fn build_prompt_for_token_target_capped(
    client: &reqwest::Client,
    port: u16,
    target_tokens: usize,
    repetitive: bool,
    log_tag: &str,
    max_tokens: Option<usize>,
) -> Result<String, String> {
    if bench_cancel::stop_after_current_requested(port) {
        return Err("Stopped".to_string());
    }

    let target_tokens = match max_tokens {
        Some(max) if max > 0 => target_tokens.min(max),
        _ => target_tokens,
    };

    if target_tokens == 0 {
        return Ok(String::new());
    }

    let build = |words: usize| -> String {
        if repetitive {
            build_repetitive_prompt(words)
        } else {
            build_unique_prompt(words)
        }
    };

    let mode_label = if repetitive { "repetitive" } else { "unique" };
    let mut words = if repetitive {
        target_tokens
    } else {
        target_tokens.saturating_mul(11) / 10
    };

    let mut best_text = build(words);
    let mut best_err = i64::MAX;
    let mut best_actual = 0usize;
    // Prefer undershoot when we have a hard ceiling (never pick an over-budget "best").
    let mut best_under_text: Option<String> = None;
    let mut best_under_err = i64::MAX;

    for _ in 0..8 {
        if bench_cancel::stop_after_current_requested(port) {
            return Err("Stopped".to_string());
        }

        let text = build(words);
        let Some(actual) = count_prompt_tokens(client, port, &text).await else {
            log::debug!(
                "{log_tag} /tokenize unavailable — using word estimate {} ({mode_label})",
                words
            );
            return Ok(text);
        };

        if let Some(max) = max_tokens {
            if actual > max {
                // Force shrink — do not accept over-budget prompts.
                words = ((words as f64) * (max as f64 / actual as f64) * 0.97)
                    .round()
                    .max(64.0) as usize;
                continue;
            }
            let err = (actual as i64 - target_tokens as i64).abs();
            if err < best_under_err {
                best_under_err = err;
                best_under_text = Some(text.clone());
            }
        }

        let err = (actual as i64 - target_tokens as i64).abs();
        if err < best_err {
            best_err = err;
            best_text = text.clone();
            best_actual = actual;
        }

        let within_tol = err <= token_target_tolerance(target_tokens);
        let under_cap = max_tokens.map(|m| actual <= m).unwrap_or(true);
        if within_tol && under_cap {
            log::info!(
                "{log_tag} prompt calibrated: mode={mode_label} target={} actual={} words={} max={:?}",
                target_tokens,
                actual,
                words,
                max_tokens
            );
            return Ok(text);
        }
        if actual == 0 {
            break;
        }

        words = ((words as f64) * (target_tokens as f64 / actual as f64)).round() as usize;
        words = words.clamp(64, target_tokens.saturating_mul(3));
    }

    let chosen = best_under_text.unwrap_or(best_text);
    if let Some(actual) = count_prompt_tokens(client, port, &chosen).await {
        log::info!(
            "{log_tag} prompt best-effort: mode={mode_label} target={} tokenize={} err={} words={} max={:?} (last_best_actual={})",
            target_tokens,
            actual,
            best_err,
            words,
            max_tokens,
            best_actual
        );
    } else {
        log::info!(
            "{log_tag} prompt best-effort: mode={mode_label} target={} err={} words={} max={:?}",
            target_tokens,
            best_err,
            words,
            max_tokens
        );
    }
    Ok(chosen)
}

/// Min per-slot `n_ctx` from `/slots` (0 if unknown / empty).
pub async fn probe_min_slot_n_ctx(client: &reqwest::Client, port: u16) -> usize {
    let url = format!("http://127.0.0.1:{port}/slots");
    let Ok(resp) = client.get(&url).send().await else {
        return 0;
    };
    if !resp.status().is_success() {
        return 0;
    }
    let Ok(slots) = resp.json::<Vec<serde_json::Value>>().await else {
        return 0;
    };
    slots
        .iter()
        .filter_map(|s| s.get("n_ctx").and_then(|v| v.as_u64()).map(|n| n as usize))
        .filter(|n| *n > 0)
        .min()
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unique_prompt_near_word_budget() {
        let text = build_unique_prompt(120);
        let n = text.split_whitespace().count();
        assert!((120..=125).contains(&n));
        assert!(text.contains("transformer"));
    }

    #[test]
    fn repetitive_prompt_cycles_fixed_pattern() {
        let text = build_repetitive_prompt(80);
        let words: Vec<&str> = text.split_whitespace().collect();
        assert_eq!(words.len(), 80);
        assert_eq!(words[0], "the");
        assert_eq!(words[1], "cat");
        let pattern_len = REPETITIVE_PATTERN.split_whitespace().count();
        assert_eq!(words[pattern_len], "the");
        assert_eq!(words[pattern_len + 1], "cat");
    }

    #[test]
    fn mode_parsing() {
        assert!(!is_repetitive_mode("unique"));
        assert!(is_repetitive_mode("repetitive"));
        assert!(is_repetitive_mode("Repetitive"));
        assert!(is_repetitive_mode("REPETITIVE"));
    }
}