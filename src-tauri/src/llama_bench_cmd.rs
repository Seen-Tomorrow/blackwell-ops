//! External `llama-bench` launcher — NoBSproof-style, isolated from fusion core.
//!
//! Takes the same engine launch argv the app would spawn, keeps only flags that
//! llama-bench understands, appends bench sweep defaults from
//! `config/llama-bench/defaults.json`, writes a portable-CUDA `.cmd`, opens CMD.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::engine::{self, AppContext};
use crate::engine_utils;
use crate::foundry_toolchain;
use crate::output_console::{
    BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle,
};
use crate::types::EngineConfig;

/// User-editable bench sweep / output knobs (not model load flags).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlamaBenchDefaults {
    /// Comma-separated PP token lengths (`-p`).
    pub n_prompt: String,
    /// Comma-separated TG token lengths (`-n`).
    pub n_gen: String,
    /// Combined pp,tg tests (`-pg`). Empty = unused.
    pub pg: String,
    /// KV depth before each test (`-d`). Empty = omit.
    pub n_depth: String,
    pub repetitions: u32,
    /// md | csv | json | jsonl | sql
    pub output: String,
    pub progress: bool,
    pub no_warmup: bool,
    /// Extra raw tokens appended after mapped launch flags (advanced).
    pub extra_args: Vec<String>,
}

impl Default for LlamaBenchDefaults {
    fn default() -> Self {
        Self {
            n_prompt: "512,2048".into(),
            n_gen: "128,512".into(),
            pg: String::new(),
            n_depth: String::new(),
            repetitions: 3,
            output: "md".into(),
            progress: true,
            no_warmup: false,
            extra_args: Vec::new(),
        }
    }
}

fn bench_dir() -> PathBuf {
    crate::config::config_dir().join("llama-bench")
}

fn defaults_path() -> PathBuf {
    bench_dir().join("defaults.json")
}

/// Ensure `config/llama-bench/defaults.json` exists; return current contents.
pub fn load_or_seed_defaults() -> Result<LlamaBenchDefaults, String> {
    let path = defaults_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    if path.is_file() {
        let raw = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        serde_json::from_str(&raw).map_err(|e| format!("Invalid {}: {e}", path.display()))
    } else {
        let d = LlamaBenchDefaults::default();
        let pretty = serde_json::to_string_pretty(&d).map_err(|e| e.to_string())?;
        std::fs::write(&path, pretty + "\n")
            .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
        Ok(d)
    }
}

fn find_llama_bench_exe(server_binary: &Path) -> Result<PathBuf, String> {
    if let Some(parent) = server_binary.parent() {
        let beside = parent.join("llama-bench.exe");
        if beside.is_file() {
            return Ok(beside);
        }
    }
    Err(format!(
        "llama-bench.exe not found next to {}. Rebuild this provider in Foundry (core target includes llama-bench).",
        server_binary.display()
    ))
}

/// Flags llama-bench accepts. `Some(true)` = takes a value; `Some(false)` = bare flag.
fn bench_flag_takes_value(flag: &str) -> Option<bool> {
    match flag {
        "--numa" | "-r" | "--repetitions" | "--prio" | "--delay" | "-o" | "--output" | "-oe"
        | "--output-err" | "-fitt" | "--fit-target" | "-fitc" | "--fit-ctx" | "-rpc" | "--rpc"
        | "-m" | "--model" | "-hf" | "-hfr" | "--hf-repo" | "-hff" | "--hf-file" | "-hft"
        | "--hf-token" | "-p" | "--n-prompt" | "-n" | "--n-gen" | "-pg" | "-d" | "--n-depth"
        | "-b" | "--batch-size" | "-ub" | "--ubatch-size" | "-ctk" | "--cache-type-k" | "-ctv"
        | "--cache-type-v" | "-t" | "--threads" | "-C" | "--cpu-mask" | "--cpu-strict" | "--poll"
        | "-ngl" | "--n-gpu-layers" | "-ncmoe" | "--n-cpu-moe" | "-sm" | "--split-mode" | "-mg"
        | "--main-gpu" | "-nkvo" | "--no-kv-offload" | "-fa" | "--flash-attn" | "-dev"
        | "--device" | "-mmp" | "--mmap" | "-dio" | "--direct-io" | "-embd" | "--embeddings"
        | "-ts" | "--tensor-split" | "-ot" | "--override-tensor" | "-nopo" | "--no-op-offload"
        | "--no-host" | "-lm" | "--load-mode" => Some(true),
        "-h" | "--help" | "--list-devices" | "-v" | "--verbose" | "--progress" | "--no-warmup" => {
            Some(false)
        }
        _ => None,
    }
}

/// Keep only llama-bench-compatible tokens from a server launch argv.
pub fn map_server_args_to_bench(server_args: &[String]) -> (Vec<String>, Vec<String>) {
    let mut kept = Vec::new();
    let mut stripped = Vec::new();
    let mut i = 0;
    while i < server_args.len() {
        let tok = &server_args[i];
        if !tok.starts_with('-') {
            stripped.push(tok.clone());
            i += 1;
            continue;
        }
        if let Some((flag, val)) = tok.split_once('=') {
            match bench_flag_takes_value(flag) {
                Some(true) => {
                    kept.push(flag.to_string());
                    kept.push(val.to_string());
                }
                Some(false) => kept.push(tok.clone()),
                None => stripped.push(tok.clone()),
            }
            i += 1;
            continue;
        }
        match bench_flag_takes_value(tok) {
            Some(true) => {
                if i + 1 < server_args.len() {
                    kept.push(tok.clone());
                    kept.push(server_args[i + 1].clone());
                    i += 2;
                } else {
                    stripped.push(tok.clone());
                    i += 1;
                }
            }
            Some(false) => {
                kept.push(tok.clone());
                i += 1;
            }
            None => {
                stripped.push(tok.clone());
                if i + 1 < server_args.len() && !server_args[i + 1].starts_with('-') {
                    stripped.push(server_args[i + 1].clone());
                    i += 2;
                } else {
                    i += 1;
                }
            }
        }
    }
    (kept, stripped)
}

fn append_bench_defaults(args: &mut Vec<String>, d: &LlamaBenchDefaults) {
    let has_flag = |args: &[String], short: &str, long: &str| {
        args.iter()
            .any(|a| a == short || a == long || a.starts_with(&format!("{long}=")))
    };

    if !d.n_prompt.trim().is_empty() && !has_flag(args, "-p", "--n-prompt") {
        args.extend(["-p".into(), d.n_prompt.trim().into()]);
    }
    if !d.n_gen.trim().is_empty() && !has_flag(args, "-n", "--n-gen") {
        args.extend(["-n".into(), d.n_gen.trim().into()]);
    }
    if !d.pg.trim().is_empty() && !args.iter().any(|a| a == "-pg") {
        args.extend(["-pg".into(), d.pg.trim().into()]);
    }
    if !d.n_depth.trim().is_empty() && !has_flag(args, "-d", "--n-depth") {
        args.extend(["-d".into(), d.n_depth.trim().into()]);
    }
    if !has_flag(args, "-r", "--repetitions") {
        args.extend(["-r".into(), d.repetitions.to_string()]);
    }
    if !has_flag(args, "-o", "--output") {
        args.extend(["-o".into(), d.output.trim().into()]);
    }
    if d.progress && !args.iter().any(|a| a == "--progress") {
        args.push("--progress".into());
    }
    if d.no_warmup && !args.iter().any(|a| a == "--no-warmup") {
        args.push("--no-warmup".into());
    }
    for extra in &d.extra_args {
        let t = extra.trim();
        if !t.is_empty() {
            args.push(t.to_string());
        }
    }
}

#[cfg(windows)]
fn batch_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

#[cfg(windows)]
fn write_llama_bench_batch(
    bench_exe: &Path,
    bench_args: &[String],
    model_dir: &Path,
    gpu_mask: &str,
    binary_profile: &str,
    cuda: &foundry_toolchain::PortableCudaEnv,
) -> Result<(PathBuf, String), String> {
    let scrubbed = foundry_toolchain::scrub_foreign_cuda_from_path(
        &std::env::var("PATH").unwrap_or_default(),
    );
    let path_value = if scrubbed.is_empty() {
        cuda.path_prefix.clone()
    } else {
        format!("{};{}", cuda.path_prefix, scrubbed)
    };

    let cuda_root = cuda.cuda_root.to_string_lossy().to_string();
    let model_dir_s = model_dir.to_string_lossy().to_string();
    let dir = bench_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

    let script_path = dir.join("latest.cmd");
    let bench_cmd = engine_utils::format_cmd_line(bench_exe, bench_args);

    let body = format!(
        "@echo off\r\n\
         title Blackwell llama-bench\r\n\
         setlocal EnableExtensions\r\n\
         set \"BLACKWELL_LLAMA_BENCH=1\"\r\n\
         echo llama-bench - portable CUDA {} / profile {}\r\n\
         echo CWD: {}\r\n\
         echo GPU mask: {}\r\n\
         echo Edit sweeps: {}\r\n\
         echo.\r\n\
         set \"PATH={}\"\r\n\
         set \"CUDA_PATH={}\"\r\n\
         set \"{}={}\"\r\n\
         set \"CUDA_VISIBLE_DEVICES={}\"\r\n\
         set \"LLAMA_LOG_COLORS=on\"\r\n\
         cd /d {}\r\n\
         echo Running:\r\n\
         echo   {}\r\n\
         echo.\r\n\
         {}\r\n\
         echo.\r\n\
         echo Exit code: %%ERRORLEVEL%%\r\n",
        cuda.cuda_version,
        binary_profile,
        batch_quote(&model_dir_s),
        gpu_mask,
        batch_quote(&defaults_path().to_string_lossy()),
        path_value,
        cuda_root,
        cuda.cuda_path_var,
        cuda_root,
        gpu_mask,
        batch_quote(&model_dir_s),
        bench_cmd,
        bench_cmd,
    );

    std::fs::write(&script_path, body)
        .map_err(|e| format!("Failed to write {}: {e}", script_path.display()))?;
    Ok((script_path, bench_cmd))
}

fn write_latest_meta(
    server_binary: &Path,
    bench_exe: &Path,
    server_args: &[String],
    bench_args: &[String],
    stripped: &[String],
    bench_cmd: &str,
    defaults: &LlamaBenchDefaults,
) -> Result<PathBuf, String> {
    let dir = bench_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;
    let path = dir.join("latest.json");
    let doc = serde_json::json!({
        "serverBinary": server_binary.to_string_lossy(),
        "benchBinary": bench_exe.to_string_lossy(),
        "serverArgs": server_args,
        "benchArgs": bench_args,
        "strippedArgs": stripped,
        "benchCmd": bench_cmd,
        "defaults": defaults,
        "defaultsPath": defaults_path().to_string_lossy(),
    });
    let pretty = serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())?;
    std::fs::write(&path, pretty + "\n")
        .map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(path)
}

/// DEV: map current launch config → llama-bench, open external CMD (portable CUDA).
#[tauri::command]
pub async fn open_llama_bench_cmd(
    config: EngineConfig,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Err("llama-bench CMD is available in DEV builds only.".into());
    }

    let backend_type = provider_id.unwrap_or_else(|| {
        if config.backend_type.is_empty() {
            crate::config::DEFAULT_PROVIDER_ID.to_string()
        } else {
            config.backend_type.clone()
        }
    });

    let cfg = {
        let guard = app.config.lock().map_err(|e| e.to_string())?;
        guard.clone()
    };

    crate::config::validate_model_path(&config.model_path)?;

    // Port is irrelevant for bench but assemble_launch_command still emits --port.
    let mut config = config;
    config.port = 9_090;

    let assembled = engine::assemble_launch_command(&cfg, &config, &backend_type)?;
    let bench_exe = find_llama_bench_exe(&assembled.binary_path)?;
    let defaults = load_or_seed_defaults()?;

    let (mut bench_args, stripped) = map_server_args_to_bench(&assembled.cmd_args);
    append_bench_defaults(&mut bench_args, &defaults);

    let cuda = foundry_toolchain::portable_cuda_env_for_profile(&assembled.binary_profile)?;

    #[cfg(windows)]
    {
        let (script_path, bench_cmd) = write_llama_bench_batch(
            &bench_exe,
            &bench_args,
            &assembled.model_dir,
            &assembled.gpu_mask,
            &assembled.binary_profile,
            &cuda,
        )?;
        let meta_path = write_latest_meta(
            &assembled.binary_path,
            &bench_exe,
            &assembled.cmd_args,
            &bench_args,
            &stripped,
            &bench_cmd,
            &defaults,
        )?;
        engine::spawn_nobsproof_cmd_window(&script_path)?;
        app.blackwell_output_console_manager.emit_line_to_category(
            BlackwellOutputConsoleCategory::Debug,
            format!(
                "[llama-bench] Opened CMD — script: {} | meta: {}",
                script_path.display(),
                meta_path.display()
            ),
            BlackwellOutputConsoleLineStyle::Command,
        );
        app.blackwell_output_console_manager.emit_line_to_category(
            BlackwellOutputConsoleCategory::Debug,
            format!("[llama-bench] {bench_cmd}"),
            BlackwellOutputConsoleLineStyle::Command,
        );
        if !stripped.is_empty() {
            app.blackwell_output_console_manager.emit_line_to_category(
                BlackwellOutputConsoleCategory::Debug,
                format!(
                    "[llama-bench] stripped {} server-only token(s): {}",
                    stripped.len(),
                    stripped.join(" ")
                ),
                BlackwellOutputConsoleLineStyle::Warning,
            );
        }
        Ok(script_path.to_string_lossy().to_string())
    }

    #[cfg(not(windows))]
    {
        let _ = (assembled, bench_exe, bench_args, stripped, cuda, defaults);
        Err("llama-bench CMD is supported on Windows only.".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_model_runtime_strips_server() {
        let server = vec![
            "-m".into(),
            r"C:\models\foo.gguf".into(),
            "--port".into(),
            "9090".into(),
            "--alias".into(),
            "foo".into(),
            "--n-gpu-layers".into(),
            "999".into(),
            "-b".into(),
            "2048".into(),
            "-ub".into(),
            "512".into(),
            "--split-mode".into(),
            "tensor".into(),
            "--tensor-split".into(),
            "0.5/0.5".into(),
            "--metrics".into(),
            "--jinja".into(),
            "--parallel".into(),
            "4".into(),
            "-lv".into(),
            "4".into(),
            "--ctx-size".into(),
            "8192".into(),
            "--flash-attn".into(),
            "on".into(),
        ];
        let (kept, stripped) = map_server_args_to_bench(&server);
        assert!(kept
            .windows(2)
            .any(|w| w[0] == "-m" && w[1].contains("foo.gguf")));
        assert!(kept
            .windows(2)
            .any(|w| w[0] == "--n-gpu-layers" && w[1] == "999"));
        assert!(kept
            .windows(2)
            .any(|w| w[0] == "--split-mode" && w[1] == "tensor"));
        assert!(kept
            .windows(2)
            .any(|w| w[0] == "--tensor-split" && w[1] == "0.5/0.5"));
        assert!(kept
            .windows(2)
            .any(|w| w[0] == "--flash-attn" && w[1] == "on"));
        assert!(!kept
            .iter()
            .any(|a| a == "--port" || a == "--alias" || a == "--metrics"));
        assert!(stripped.iter().any(|a| a == "--port"));
        assert!(stripped.iter().any(|a| a == "--ctx-size"));
    }

    #[test]
    fn append_defaults_fills_p_n_r() {
        let mut args = vec!["-m".into(), "m.gguf".into()];
        append_bench_defaults(&mut args, &LlamaBenchDefaults::default());
        assert!(args.windows(2).any(|w| w[0] == "-p"));
        assert!(args.windows(2).any(|w| w[0] == "-n"));
        assert!(args.windows(2).any(|w| w[0] == "-r" && w[1] == "3"));
        assert!(args.iter().any(|a| a == "--progress"));
    }
}
