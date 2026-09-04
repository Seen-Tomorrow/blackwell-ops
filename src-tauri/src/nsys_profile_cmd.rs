//! External `nsys profile` launcher — NoBSproof-style, isolated from fusion core.
//!
//! Reproduces the *exact* engine launch argv (same `assemble_launch_command` path as the
//! real spawn) under Nsight Systems, inside the isolated portable-CUDA env from
//! `/toolchain`, and opens an external CMD window. This is the profiling counterpart to
//! the NoBSproof CMD button: if it profiles, the app's flags and env are real.
//!
//! Flags below were validated against the installed `nsys profile --help` (2026.1.3):
//!   * **No `--attach`.** Nsight profiles a process tree it starts itself, so there is no
//!     attach-to-running-PID path — the engine reloads (which also puts model load in the
//!     timeline).
//!   * **No `--cuda-api`, no `--nvtx` boolean**; NVTX is a `--trace=` value.
//!   * **`osrt` is rejected** on this Windows build (Linux-only).
//!   * **`--gpu-metrics-devices` needs elevation** on GB202 (`ERR_NVGPUCTRPERM`), so it is
//!     opt-in and off by default; that flag is the power/utilization axis.
//!
//! `nsys.exe` and CUPTI are *not* part of the slimmed portable toolkit, so both are
//! located from the host install, independent of the engine's isolated env.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::engine::{self, AppContext};
use crate::engine_utils;
use crate::foundry_toolchain;
use crate::output_console::{
    BlackwellOutputConsoleCategory, BlackwellOutputConsoleLineStyle,
};
use crate::types::EngineConfig;

/// User-editable capture knobs — mirrors the `llama-bench` `defaults.json` convention.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct NsysDefaults {
    /// Seconds of auto-stop recording. **0 = no timer**: the engine keeps running and the
    /// trace is finalized when you stop it yourself (Ctrl+C in the CMD, or stop the engine).
    pub duration_seconds: u32,
    /// Extra `nsys` args appended verbatim to the profile invocation.
    pub extra_nsys_args: Vec<String>,
    /// Value for `--trace=` (nsys-validated API list, comma-separated, no spaces).
    pub trace: String,
    /// Value for `--gpu-metrics-devices=`: `none` | `cuda-visible` | `all` | GPU id list.
    /// Requires elevation on Blackwell; `none` keeps the run unprivileged.
    pub gpu_metrics: String,
    /// Terminate the engine when the profiling session ends. nsys defaults this to `true`,
    /// which kills the server the moment recording stops.
    pub kill_on_exit: bool,
    /// Output directory for `.nsys-rep`; empty = `config/nsys/`.
    pub output_dir: String,
}

impl Default for NsysDefaults {
    fn default() -> Self {
        Self {
            // No auto-stop: a fixed window is too short to bring the model up and then run a
            // real bench against it. Recording is bounded by how long you let it run.
            duration_seconds: 0,
            extra_nsys_args: Vec::new(),
            // Proven to collect without elevation. `wddm` and context-switch tracing exist
            // but are dropped by nsys unless the CMD is elevated.
            trace: "cuda,nvtx".to_string(),
            // Rejected with ERR_NVGPUCTRPERM on GB202 unless elevated. Set to
            // "cuda-visible" and re-run from an admin CMD for the power/SM/DRAM timeline.
            gpu_metrics: "none".to_string(),
            // Keep the profiled engine alive so the trace can be stopped on demand.
            kill_on_exit: false,
            output_dir: String::new(),
        }
    }
}

fn nsys_dir() -> PathBuf {
    crate::config::config_dir().join("nsys")
}

fn defaults_path() -> PathBuf {
    nsys_dir().join("defaults.json")
}

/// Ensure `config/nsys/defaults.json` exists; return current contents.
pub fn load_or_seed_defaults() -> Result<NsysDefaults, String> {
    let path = defaults_path();
    if path.is_file() {
        let text = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read {}: {e}", path.display()))?;
        return serde_json::from_str::<NsysDefaults>(&text)
            .map_err(|e| format!("Invalid {}: {e}", path.display()));
    }
    let defaults = NsysDefaults::default();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let text = serde_json::to_string_pretty(&defaults).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(defaults)
}

/// Locate `nsys.exe`.
///
/// Order: `BLACKWELL_NSYS_EXE` → `NSYS_EXE` → newest `Nsight Systems*` under the standard
/// install roots. `target-windows-x64\nsys.exe` is preferred over `host-*`: it is the
/// target-side CLI that injects into local CUDA processes on Windows.
pub fn find_nsys_exe() -> Result<PathBuf, String> {
    if let Ok(explicit) = std::env::var("BLACKWELL_NSYS_EXE") {
        let p = PathBuf::from(&explicit);
        if p.is_file() {
            return Ok(p);
        }
        return Err(format!(
            "BLACKWELL_NSYS_EXE points at a missing file: {explicit}"
        ));
    }
    if let Ok(env_path) = std::env::var("NSYS_EXE") {
        let p = PathBuf::from(&env_path);
        if p.is_file() {
            return Ok(p);
        }
    }

    let mut candidates: Vec<PathBuf> = Vec::new();
    for root in [
        Path::new(r"C:\Program Files\NVIDIA Corporation"),
        Path::new(r"C:\Program Files (x86)\NVIDIA Corporation"),
    ] {
        let Ok(entries) = std::fs::read_dir(root) else {
            continue;
        };
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if !name.starts_with("Nsight Systems") {
                continue;
            }
            for sub in [
                "target-windows-x64\\nsys.exe",
                "host-windows-x64\\nsys.exe",
                "bin\\nsys.exe",
            ] {
                let cand = entry.path().join(sub);
                if cand.is_file() {
                    candidates.push(cand);
                }
            }
        }
    }

    // Directory names embed the version ("Nsight Systems 2026.1.3"), so a lexical sort
    // orders them correctly; take the highest.
    candidates.sort();
    candidates
        .into_iter()
        .rev()
        .next()
        .ok_or_else(|| String::from(
            "nsys.exe not found under C:\\Program Files\\NVIDIA Corporation\\Nsight Systems*. \
             Install Nsight Systems, or set BLACKWELL_NSYS_EXE to the full path of nsys.exe \
             (use the copy under target-windows-x64).",
        ))
}

/// Locate the CUPTI `lib64` directory. Nsight injects `cupti64_*.dll`, which the slimmed
/// portable toolkit does not carry, so this resolves to a full CUDA install. `None` means
/// the caller must warn — a trace without CUPTI silently contains no CUDA activity.
pub fn find_cupti_lib_dir() -> Option<PathBuf> {
    let mut found: Vec<PathBuf> = Vec::new();
    let toolkit_root = Path::new(r"C:\Program Files\NVIDIA GPU Computing Toolkit\CUDA");
    if let Ok(entries) = std::fs::read_dir(toolkit_root) {
        for entry in entries.flatten() {
            let cand = entry.path().join("extras").join("CUPTI").join("lib64");
            if cand.is_dir() {
                found.push(cand);
            }
        }
    }
    let direct = toolkit_root.join("v13.3").join("extras").join("CUPTI").join("lib64");
    if direct.is_dir() && !found.contains(&direct) {
        found.push(direct);
    }
    found.sort();
    found.into_iter().rev().next()
}

#[cfg(windows)]
fn batch_quote(value: &str) -> String {
    format!("\"{}\"", value.replace('"', "\"\""))
}

/// Shared `nsys` collection flags (no subcommand, no target argv).
fn nsys_common_args(defaults: &NsysDefaults, rep_stem: &Path) -> Vec<String> {
    let mut a: Vec<String> = Vec::new();

    a.push(format!("--output={}", rep_stem.to_string_lossy()));
    a.push("--force-overwrite=true".to_string());

    let trace = defaults.trace.trim().trim_matches(',').replace(' ', "");
    a.push(format!(
        "--trace={}",
        if trace.is_empty() { "cuda,nvtx" } else { &trace }
    ));

    // GPU metrics give the power / SM / DRAM utilization timeline — the direct answer to
    // "why only 500 W of 1200 W". Opt-in because it needs elevation on GB202.
    let gpu_metrics = defaults.gpu_metrics.trim();
    if !gpu_metrics.is_empty() && gpu_metrics != "none" {
        a.push(format!("--gpu-metrics-devices={gpu_metrics}"));
    }

    // CPU sampling off: chasing GPU idle gaps; sampling inflates the rep and wants admin.
    a.push("--sample=none".to_string());
    a.push("--stats=false".to_string());

    // 0 keeps the flag out entirely: nsys' own default is 0 = "until the target exits".
    if defaults.duration_seconds > 0 {
        a.push(format!("--duration={}", defaults.duration_seconds));
    }

    // nsys defaults --kill=true, so stopping the session would terminate the engine. With
    // no duration set the session ends when the engine exits, so this only bites if the
    // session is shut down first (or a duration is set) — pin it off either way.
    a.push(format!(
        "--kill={}",
        if defaults.kill_on_exit { "true" } else { "false" }
    ));

    for extra in &defaults.extra_nsys_args {
        let t = extra.trim();
        if !t.is_empty() {
            a.push(t.to_string());
        }
    }

    a
}

/// Full `nsys` argv for a profiled engine launch:
/// `profile <flags> -- <engine_exe> <engine_args…>`.
///
/// The exe MUST come immediately after `--`: everything after the separator is the
/// target command line, so a leading flag would be treated as the program to exec.
/// This is the single assembly point — `write_nsys_batch` must not re-append the target.
pub fn build_profile_args(
    defaults: &NsysDefaults,
    rep_stem: &Path,
    engine_exe: &Path,
    engine_args: &[String],
) -> Vec<String> {
    let mut a = vec!["profile".to_string()];
    a.extend(nsys_common_args(defaults, rep_stem));
    a.push("--".to_string());
    a.push(engine_exe.to_string_lossy().to_string());
    a.extend(engine_args.iter().cloned());
    a
}

/// Write the portable-CUDA `.cmd` that runs nsys around a freshly launched engine.
#[cfg(windows)]
fn write_nsys_batch(
    nsys_exe: &Path,
    nsys_args: &[String],
    model_dir: &Path,
    gpu_mask: &str,
    binary_profile: &str,
    cuda: &foundry_toolchain::PortableCudaEnv,
    cupti_dir: Option<&Path>,
    defaults: &NsysDefaults,
) -> Result<(PathBuf, String), String> {
    let scrubbed = foundry_toolchain::scrub_foreign_cuda_from_path(
        &std::env::var("PATH").unwrap_or_default(),
    );
    let mut path_value = if scrubbed.is_empty() {
        cuda.path_prefix.clone()
    } else {
        format!("{};{}", cuda.path_prefix, scrubbed)
    };
    if let Some(dir) = cupti_dir {
        path_value = format!("{};{}", path_value, dir.to_string_lossy());
    }

    let cuda_root = cuda.cuda_root.to_string_lossy().to_string();
    let model_dir_s = model_dir.to_string_lossy().to_string();
    let dir = nsys_dir();
    std::fs::create_dir_all(&dir)
        .map_err(|e| format!("Failed to create {}: {e}", dir.display()))?;

    let script_path = dir.join("latest.cmd");

    // nsys_args already carries `-- <exe> <args…>` (see build_profile_args); appending the
    // target again would put a flag where the program name belongs. format_cmd_line quotes
    // every token — including `profile` and `--` — which is correct: Windows
    // CommandLineToArgv strips the quotes before nsys parses (verified on 2026.1.3).
    let trace_cmd = engine_utils::format_cmd_line(nsys_exe, nsys_args);

    let gpu_hint = if defaults.gpu_metrics.trim() == "none" || defaults.gpu_metrics.trim().is_empty() {
        "GPU metrics OFF (power/utilization rows absent). To enable: set gpuMetrics to \
         \"cuda-visible\" in defaults.json and run this file from an ELEVATED CMD."
            .to_string()
    } else {
        format!(
            "GPU metrics ON ({}). If nsys reports ERR_NVGPUCTRPERM, re-run this file from an \
             ELEVATED CMD.",
            defaults.gpu_metrics.trim()
        )
    };

    let stop_hint = if defaults.duration_seconds > 0 {
        format!(
            "Recording auto-stops after {} s. The engine SURVIVES (kill={}), so it keeps \
             serving after the trace closes.",
            defaults.duration_seconds,
            if defaults.kill_on_exit { "on" } else { "off" }
        )
    } else {
        format!(
            "Recording runs until YOU stop it: Ctrl+C in this window, or stop the engine. \
             The .nsys-rep is finalized on stop{}, so do not just close the window.",
            if defaults.kill_on_exit {
                " (the engine is terminated too)"
            } else {
                " and the engine keeps serving"
            }
        )
    };

    let body = format!(
        "@echo off\r\n\
         title Blackwell Nsight Systems profile\r\n\
         setlocal EnableExtensions\r\n\
         set \"BLACKWELL_NSYS=1\"\r\n\
         echo Nsight Systems profile - portable CUDA {cuda_ver} / profile {profile}\r\n\
         echo CWD: {model_dir_q}\r\n\
         echo GPU mask: {gpu}\r\n\
         echo Defaults: {defaults_q}\r\n\
         echo CUPTI: {cupti}\r\n\
         echo {gpu_hint}\r\n\
         echo.\r\n\
        echo NOTE: this starts a SEPARATE profiled engine. Stop the app's running engine\r\n\
        echo first if VRAM is tight - the model is loaded twice otherwise.\r\n\
        echo.\r\n\
        echo {stop_hint}\r\n\
        echo.\r\n\
         set \"PATH={path}\"\r\n\
         set \"CUDA_PATH={cuda_root_q}\"\r\n\
         set \"{cuda_var}={cuda_root_q}\"\r\n\
         set \"CUDA_VISIBLE_DEVICES={gpu}\"\r\n\
         set \"LLAMA_LOG_COLORS=on\"\r\n\
         cd /d {model_dir_q}\r\n\
         echo Running:\r\n\
         echo   {trace_cmd}\r\n\
         echo.\r\n\
         {trace_run}\r\n\
         echo.\r\n\
         echo Trace written under config\\nsys\\. Exit code: %%ERRORLEVEL%%\r\n",
        cuda_ver = cuda.cuda_version,
        profile = binary_profile,
        model_dir_q = batch_quote(&model_dir_s),
        gpu = gpu_mask,
        defaults_q = batch_quote(&defaults_path().to_string_lossy()),
        cupti = cupti_dir
            .map(|p| p.to_string_lossy().to_string())
            .unwrap_or_else(|| "NOT FOUND - trace may contain no CUDA activity".to_string()),
        gpu_hint = gpu_hint,
        stop_hint = stop_hint,
        path = path_value,
        cuda_root_q = batch_quote(&cuda_root),
        cuda_var = cuda.cuda_path_var,
        trace_cmd = trace_cmd,
        trace_run = trace_cmd,
    );

    std::fs::write(&script_path, body)
        .map_err(|e| format!("Failed to write {}: {e}", dir.display()))?;
    Ok((script_path, trace_cmd))
}

fn write_latest_meta(
    nsys_exe: &Path,
    trace_cmd: &str,
    server_args: &[String],
    defaults: &NsysDefaults,
    cupti_dir: Option<&Path>,
) -> Result<PathBuf, String> {
    let path = nsys_dir().join("latest.json");
    let meta = serde_json::json!({
        "nsys_exe": nsys_exe.to_string_lossy(),
        "trace_cmd": trace_cmd,
        "server_args": server_args,
        "cupti_dir": cupti_dir.map(|p| p.to_string_lossy().to_string()),
        "defaults": defaults,
    });
    let text = serde_json::to_string_pretty(&meta).map_err(|e| e.to_string())?;
    std::fs::write(&path, text).map_err(|e| format!("Failed to write {}: {e}", path.display()))?;
    Ok(path)
}

fn rep_stem() -> String {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("blackwell-{now}")
}

/// DEV: launch a *fresh* engine under Nsight Systems with the exact app launch config.
#[tauri::command]
pub async fn open_nsys_profile_cmd(
    config: EngineConfig,
    provider_id: Option<String>,
    app: tauri::State<'_, AppContext>,
) -> Result<String, String> {
    if !cfg!(debug_assertions) {
        return Err("Nsight Systems profile CMD is available in DEV builds only.".into());
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

    let mut config = config;
    config.port = engine::peek_next_launch_port(&app, &config).await?;

    let assembled = engine::assemble_launch_command(&cfg, &config, &backend_type)?;
    let defaults = load_or_seed_defaults()?;
    let nsys_exe = find_nsys_exe()?;
    let cupti_dir = find_cupti_lib_dir();

    let out_root = if defaults.output_dir.trim().is_empty() {
        nsys_dir()
    } else {
        PathBuf::from(defaults.output_dir.trim())
    };
    std::fs::create_dir_all(&out_root)
        .map_err(|e| format!("Failed to create {}: {e}", out_root.display()))?;
    let rep = out_root.join(rep_stem());

    let nsys_args =
        build_profile_args(&defaults, &rep, &assembled.binary_path, &assembled.cmd_args);
    let cuda = foundry_toolchain::portable_cuda_env_for_profile(&assembled.binary_profile)?;

    #[cfg(windows)]
    {
        let (script_path, trace_cmd) = write_nsys_batch(
            &nsys_exe,
            &nsys_args,
            &assembled.model_dir,
            &assembled.gpu_mask,
            &assembled.binary_profile,
            &cuda,
            cupti_dir.as_deref(),
            &defaults,
        )?;
        let meta_path = write_latest_meta(
            &nsys_exe,
            &trace_cmd,
            &assembled.cmd_args,
            &defaults,
            cupti_dir.as_deref(),
        )?;
        engine::spawn_nobsproof_cmd_window(&script_path)?;

        let console = &app.blackwell_output_console_manager;
        console.emit_line_to_category(
            BlackwellOutputConsoleCategory::Debug,
            format!(
                "[nsys] script: {} | meta: {}",
                script_path.display(),
                meta_path.display()
            ),
            BlackwellOutputConsoleLineStyle::Command,
        );
        console.emit_line_to_category(
            BlackwellOutputConsoleCategory::Debug,
            format!("[nsys] {trace_cmd}"),
            BlackwellOutputConsoleLineStyle::Command,
        );
        if cupti_dir.is_none() {
            console.emit_line_to_category(
                BlackwellOutputConsoleCategory::Debug,
                "[nsys] CUPTI lib64 not found in any CUDA install — the trace may contain no \
                 CUDA activity. Install the full CUDA Toolkit; Nsight requires it."
                    .to_string(),
                BlackwellOutputConsoleLineStyle::Warning,
            );
        }
        Ok(script_path.to_string_lossy().to_string())
    }

    #[cfg(not(windows))]
    {
        let _ = (
            assembled, defaults, nsys_exe, cupti_dir, nsys_args, rep, cuda,
        );
        Err("Nsight Systems profile CMD is supported on Windows only.".into())
    }
}

/// DEV: report profiler + CUPTI availability so the UI can gate the button honestly.
#[tauri::command]
pub fn nsys_profile_status() -> Result<serde_json::Value, String> {
    let nsys = find_nsys_exe();
    let cupti = find_cupti_lib_dir();
    Ok(serde_json::json!({
        "nsys_exe": nsys.as_ref().ok().map(|p| p.to_string_lossy().to_string()),
        "nsys_error": nsys.as_ref().err().cloned(),
        "cupti_dir": cupti.map(|p| p.to_string_lossy().to_string()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stem() -> PathBuf {
        PathBuf::from(r"C:\tmp\trace")
    }

    fn exe() -> PathBuf {
        PathBuf::from(r"C:\eng\llama-server.exe")
    }

    #[test]
    fn engine_exe_is_first_token_after_the_separator() {
        let d = NsysDefaults::default();
        let args = build_profile_args(&d, &stem(), &exe(), &["--port".into(), "8080".into()]);
        assert_eq!(args[0], "profile");
        let dash = args.iter().position(|a| a == "--").expect("separator");
        // nsys execs whatever follows `--`: a flag here means "command not found".
        assert_eq!(args[dash + 1], r"C:\eng\llama-server.exe");
        assert_eq!(args[dash + 2], "--port");
        assert_eq!(args[dash + 3], "8080");
        assert_eq!(args.len(), dash + 4, "target must appear exactly once");
    }

    #[test]
    fn target_is_never_duplicated_into_the_argv() {
        // Guards the write_nsys_batch double-append bug: exe and each arg appear once.
        let d = NsysDefaults::default();
        let args = build_profile_args(
            &d,
            &stem(),
            &exe(),
            &["--port".into(), "8080".into(), "--n-gpu-layers".into(), "99".into()],
        );
        assert_eq!(args.iter().filter(|a| **a == r"C:\eng\llama-server.exe").count(), 1);
        assert_eq!(args.iter().filter(|a| **a == "--port").count(), 1);
        assert_eq!(args.iter().filter(|a| **a == "--n-gpu-layers").count(), 1);
        assert_eq!(args.iter().filter(|a| **a == "--").count(), 1);
    }

    #[test]
    fn default_flags_are_elevation_free() {
        let d = NsysDefaults::default();
        let joined = build_profile_args(&d, &stem(), &exe(), &[]).join(" ");
        assert!(joined.contains("--trace=cuda,nvtx"), "{joined}");
        assert!(joined.contains("--sample=none"));
        assert!(joined.contains("--kill=false"), "{joined}");
        // Default is open-ended: no timer, so the engine stays up until manually stopped.
        assert!(!joined.contains("--duration"), "{joined}");
        // osrt is rejected on Windows builds; attach/--cuda-api do not exist.
        assert!(!joined.contains("osrt"), "{joined}");
        assert!(!joined.contains("--attach"), "{joined}");
        assert!(!joined.contains("--cuda-api"), "{joined}");
        // gpu metrics off by default (needs admin on GB202).
        assert!(!joined.contains("--gpu-metrics-devices"), "{joined}");
    }

    #[test]
    fn enabling_gpu_metrics_adds_the_flag() {
        let d = NsysDefaults {
            gpu_metrics: "cuda-visible".into(),
            ..Default::default()
        };
        let joined = build_profile_args(&d, &stem(), &exe(), &[]).join(" ");
        assert!(joined.contains("--gpu-metrics-devices=cuda-visible"), "{joined}");
    }

    #[test]
    fn opt_in_duration_emits_timer_but_still_spares_the_engine() {
        let d = NsysDefaults {
            duration_seconds: 45,
            ..Default::default()
        };
        let joined = build_profile_args(&d, &stem(), &exe(), &[]).join(" ");
        assert!(joined.contains("--duration=45"), "{joined}");
        // Auto-stop must not take the server down with it.
        assert!(joined.contains("--kill=false"), "{joined}");
    }

    #[test]
    fn kill_on_exit_can_be_re_enabled() {
        let d = NsysDefaults {
            kill_on_exit: true,
            ..Default::default()
        };
        let joined = build_profile_args(&d, &stem(), &exe(), &[]).join(" ");
        assert!(joined.contains("--kill=true"), "{joined}");
    }

    #[test]
    fn empty_trace_falls_back_to_cuda_nvtx() {
        let d = NsysDefaults {
            trace: "  ,, ".into(),
            ..Default::default()
        };
        let args = build_profile_args(&d, &stem(), &exe(), &[]);
        assert!(args.contains(&"--trace=cuda,nvtx".to_string()));
    }

    #[test]
    fn trace_value_has_spaces_stripped() {
        let d = NsysDefaults {
            trace: "cuda, nvtx".into(),
            ..Default::default()
        };
        let args = build_profile_args(&d, &stem(), &exe(), &[]);
        assert!(args.contains(&"--trace=cuda,nvtx".to_string()));
    }

    #[test]
    fn emitted_batch_line_quotes_exe_and_preserves_target_order() {
        // Asserts the REAL line written into latest.cmd, via the same format_cmd_line
        // NoBSproof uses — not a reimplementation. A quoted exe with spaces must survive,
        // and the token after `--` must be the engine exe, not a flag.
        let nsys = Path::new(
            r"C:\Program Files\NVIDIA Corporation\Nsight Systems 2026.1.3\target-windows-x64\nsys.exe",
        );
        let d = NsysDefaults::default();
        let args = build_profile_args(
            &d,
            &stem(),
            &exe(),
            &["--model".into(), r"C:\My Models\UD-Q4_K_XL.gguf".into(), "--port".into(), "8080".into()],
        );
        let line = engine_utils::format_cmd_line(nsys, &args);

        assert!(
            line.starts_with("\"C:\\Program Files\\NVIDIA Corporation\\Nsight Systems 2026.1.3\\target-windows-x64\\nsys.exe\""),
            "line must begin with the quoted nsys path: {line}"
        );
        // `profile` stays a quoted-but-valid argv token (do not special-case it).
        assert!(line.contains("\"profile\""), "{line}");
        // Target clause in order, exe first after the separator, spaced model path quoted.
        assert!(line.contains(r#""--" "C:\eng\llama-server.exe" "--model" "C:\My Models\UD-Q4_K_XL.gguf" "--port" "8080""#), "{line}");
    }
}
