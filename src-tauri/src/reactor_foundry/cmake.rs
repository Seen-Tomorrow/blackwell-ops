//! CMake build flags, cache fingerprinting, work-tree policy, and target/binary helpers.
//!
//! Leaf module of the Foundry build service. Pure functions and directory policy that
//! the worker (`mod.rs`) and the batch runner (`batch.rs`) share.

use std::path::PathBuf;

use crate::foundry_toolchain;

const DEFAULT_CMAKE_FLAGS: &[(&str, &str)] = &[
    (
        "ggml-llama",
        concat!(
            "-DLLAMA_CURL=OFF ",
            "-DGGML_CUDA=ON ",
            "-DGGML_AVX512=ON ",
            // Portable CPU + CUDA (not host-only); GPU SMs still set via CMAKE_CUDA_ARCHITECTURES.
            "-DGGML_NATIVE=OFF ",
            // Ship llama-server (HTTP API engine) — not a separate "web UI" product.
            "-DLLAMA_BUILD_SERVER=ON ",
            // llama-bench lives under tools/ (not examples/).
            "-DLLAMA_BUILD_TOOLS=ON ",
            "-DLLAMA_BUILD_TESTS=OFF ",
            "-DLLAMA_BUILD_EXAMPLES=OFF ",
            // NCCL: llama.cpp guards the find_package probe with GGML_CUDA_NCCL
            // (ggml/src/ggml-cuda/CMakeLists.txt). Not shipped on Windows; OFF skips the probe.
            "-DGGML_CUDA_NCCL=OFF ",
            // OpenSSL not needed for local HTTP; skip probe.
            "-DLLAMA_OPENSSL=OFF",
        ),
    ),
];

/// Always merge these into configure so provider build_profile cannot re-enable tests/examples,
/// drop the server/tools targets, or leave host-native CPU/CUDA defaults that break ship portability.
const FOUNDRY_MANDATORY_CMAKE_FLAGS: &str = concat!(
    // Release is selected at compile time via `cmake --build --config Release`
    // (mod.rs stage_compile). CMAKE_BUILD_TYPE is ignored by multi-config generators
    // (Ninja Multi-Config), so it is deliberately NOT forced here.
    "-DGGML_NATIVE=OFF ",
    "-DLLAMA_BUILD_SERVER=ON ",
    "-DLLAMA_BUILD_TOOLS=ON ",
    "-DLLAMA_BUILD_TESTS=OFF ",
    "-DLLAMA_BUILD_EXAMPLES=OFF ",
    "-DGGML_CUDA_NCCL=OFF",
);

pub(crate) fn get_default_cmake_flags(template_type: &str) -> &'static str {
    DEFAULT_CMAKE_FLAGS
        .iter()
        .find(|(key, _)| *key == template_type)
        .map(|(_, flags)| *flags)
        .unwrap_or("")
}

/// Fingerprint file written after successful configure — gates warm reuse of `work/build-{profile}/`.
const FOUNDRY_CACHE_KEY_FILE: &str = ".blackwell-foundry-cache-key";

/// Retain CMake work trees between Foundry runs (all users). Fingerprint miss / CLEAR CACHE → cold tree.
pub(crate) fn foundry_keep_work_cache() -> bool {
    true
}

pub(crate) fn dir_size_bytes(path: &std::path::Path) -> u64 {
    if !path.exists() {
        return 0;
    }
    let mut total = 0u64;
    let mut stack = vec![path.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let p = entry.path();
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            if meta.is_dir() {
                stack.push(p);
            } else if meta.is_file() {
                total = total.saturating_add(meta.len());
            }
        }
    }
    total
}

pub(crate) fn format_bytes_label(bytes: u64) -> String {
    const KIB: f64 = 1024.0;
    const MIB: f64 = KIB * 1024.0;
    const GIB: f64 = MIB * 1024.0;
    let b = bytes as f64;
    if b >= GIB {
        format!("{:.2} GiB", b / GIB)
    } else if b >= MIB {
        format!("{:.1} MiB", b / MIB)
    } else if b >= KIB {
        format!("{:.0} KiB", b / KIB)
    } else {
        format!("{bytes} B")
    }
}

pub(crate) fn foundry_cache_fingerprint(
    profile_id: &str,
    cmake_configure_line: &str,
    toolchain_id: &str,
) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(profile_id.as_bytes());
    hasher.update(b"\0");
    hasher.update(cmake_configure_line.as_bytes());
    hasher.update(b"\0");
    // Toolchain swaps (VS/CUDA/version) must cold-start even if the configure line is unchanged.
    hasher.update(toolchain_id.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub(crate) async fn read_foundry_cache_key(build_dir: &std::path::Path) -> Option<String> {
    let path = build_dir.join(FOUNDRY_CACHE_KEY_FILE);
    let content = tokio::fs::read_to_string(&path).await.ok()?;
    let trimmed = content.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

pub(crate) async fn write_foundry_cache_key(build_dir: &std::path::Path, key: &str) -> Result<(), String> {
    tokio::fs::write(build_dir.join(FOUNDRY_CACHE_KEY_FILE), format!("{key}\n"))
        .await
        .map_err(|e| format!("Failed to write Foundry cache key: {e}"))
}

/// Prepare `work/build-{profile}/` — reuse when cache fingerprint matches, else fresh tree.
pub(crate) async fn prepare_foundry_build_dir(
    build_dir: &std::path::Path,
    cache_fingerprint: &str,
) -> Result<bool, String> {
    let cache_hit = if foundry_keep_work_cache()
        && build_dir.join("CMakeCache.txt").is_file()
        && read_foundry_cache_key(build_dir).await.as_deref() == Some(cache_fingerprint)
    {
        true
    } else {
        false
    };

    if cache_hit {
        return Ok(true);
    }

    if build_dir.exists() {
        tokio::fs::remove_dir_all(build_dir)
            .await
            .map_err(|e| format!("Failed to reset Foundry build dir: {e}"))?;
    }
    tokio::fs::create_dir_all(build_dir)
        .await
        .map_err(|e| format!("Failed to create Foundry build dir: {e}"))?;
    Ok(false)
}

pub(crate) async fn nuke_foundry_work_tree(provider_id: &str) {
    let work_root = crate::config::foundry_work_dir(provider_id);
    let _ = tokio::fs::remove_dir_all(&work_root).await;
}

pub(crate) async fn nuke_foundry_work_tree_on_exit(provider_id: &str) {
    if foundry_keep_work_cache() {
        return;
    }
    nuke_foundry_work_tree(provider_id).await;
}

/// Product build targets (always).
/// `llama-server` = HTTP API engine (OpenAI-compatible). Not a separate WebUI package —
/// any browser UI is served by this binary when you open its port.
/// `llama-bench` = industry-standard offline PP/TG reference (secondary to fusion bench).
const FOUNDRY_CMAKE_CORE_TARGETS: &[&str] = &["llama-server", "llama-fit-params", "llama-bench"];

/// Optional offline tools (Foundry modal toggle) — not used by the app runtime.
const FOUNDRY_CMAKE_EXTRA_TARGETS: &[&str] = &["llama-cli", "llama-quantize"];

const FOUNDRY_CORE_BINARIES: &[&str] = &[
    "llama-server.exe",
    "llama-fit-params.exe",
    "llama-bench.exe",
];

pub(crate) const FOUNDRY_EXTRA_BINARIES: &[&str] = &["llama-cli.exe", "llama-quantize.exe"];

pub(crate) struct FoundryCoreBinaryCheck {
    pub(crate) all_present: bool,
    pub(crate) missing: Vec<String>,
    pub(crate) binary_dir: Option<PathBuf>,
}

pub(crate) fn foundry_batch_script_paths(work_root: &std::path::Path, profile_id: &str) -> (PathBuf, PathBuf) {
    let pid = foundry_toolchain::normalize_profile_id(profile_id);
    (
        work_root.join(format!("_build_cfg_{pid}.bat")),
        work_root.join(format!("_build_run_{pid}.bat")),
    )
}

pub(crate) fn foundry_cmake_build_targets(include_extra_tools: bool) -> Vec<&'static str> {
    let mut t: Vec<&'static str> = FOUNDRY_CMAKE_CORE_TARGETS.to_vec();
    if include_extra_tools {
        t.extend_from_slice(FOUNDRY_CMAKE_EXTRA_TARGETS);
    }
    t
}

pub(crate) fn foundry_cmake_build_target_args(include_extra_tools: bool) -> String {
    foundry_cmake_build_targets(include_extra_tools)
        .iter()
        .map(|t| format!(" --target {t}"))
        .collect()
}

/// Ensure mandatory -D flags are present (provider build_profile may omit them).
pub(crate) fn merge_mandatory_cmake_flags(extra: &str) -> String {
    let mut out = extra.trim().to_string();
    for flag in FOUNDRY_MANDATORY_CMAKE_FLAGS.split_whitespace() {
        let key = flag.split('=').next().unwrap_or(flag);
        let already = out
            .split_whitespace()
            .any(|t| t == flag || t.starts_with(&format!("{key}=")));
        if !already {
            if !out.is_empty() {
                out.push(' ');
            }
            out.push_str(flag);
        }
    }
    out
}

pub(crate) fn foundry_release_candidate_dirs(build_dir: &std::path::Path, src_dir: &std::path::Path) -> Vec<PathBuf> {
    vec![
        build_dir.join("bin").join("Release"),
        src_dir.join("bin").join("Release"),
        src_dir.join("build").join("Release"),
    ]
}

pub(crate) fn check_foundry_core_binaries(candidate_dirs: &[PathBuf]) -> FoundryCoreBinaryCheck {
    let mut missing = Vec::new();
    let mut binary_dir = None;

    for bin in FOUNDRY_CORE_BINARIES {
        let mut found = false;
        for dir in candidate_dirs {
            if dir.join(bin).is_file() {
                found = true;
                if binary_dir.is_none() {
                    binary_dir = Some(dir.clone());
                }
                break;
            }
        }
        if !found {
            missing.push((*bin).to_string());
        }
    }

    FoundryCoreBinaryCheck {
        all_present: missing.is_empty(),
        missing,
        binary_dir,
    }
}

pub(crate) fn is_windows_vs_tail_batch_flake(stderr: &str) -> bool {
    stderr.to_ascii_lowercase().contains("the batch file cannot be found")
}

/// Escape cmd batch metacharacters in user-supplied CMake flags so a `%`, `&`, `|`, `^`, `(`, `)`
/// or redirection char cannot split/corrupt the generated `.bat` command line. `%`→`%%` (var
/// expansion), the rest are caret-escaped. Applied only to the batch-embedded copy; the display
/// message keeps the raw flags for readability.
pub(crate) fn cmd_escape_batch(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '%' => out.push_str("%%"),
            '&' | '|' | '<' | '>' | '^' | '(' | ')' => {
                out.push('^');
                out.push(c);
            }
            _ => out.push(c),
        }
    }
    out
}

pub(crate) async fn nuke_foundry_build_dir_on_configure_fail(
    provider_id: &str,
    profile_id: &str,
) {
    if foundry_keep_work_cache() {
        let build_dir = crate::config::foundry_work_dir(provider_id)
            .join(format!("build-{profile_id}"));
        let _ = tokio::fs::remove_dir_all(&build_dir).await;
        return;
    }
    nuke_foundry_work_tree(provider_id).await;
}

pub(crate) fn resolve_template_type(_provider_id: &str) -> &'static str {
    "ggml-llama"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn merge_mandatory_empty_extra_gets_all_mandatory() {
        let out = merge_mandatory_cmake_flags("");
        for flag in FOUNDRY_MANDATORY_CMAKE_FLAGS.split_whitespace() {
            assert!(
                out.split_whitespace().any(|t| t == flag),
                "missing mandatory flag {flag} in: {out}"
            );
        }
    }

    #[test]
    fn merge_mandatory_existing_flag_not_duplicated() {
        let out = merge_mandatory_cmake_flags("-DGGML_NATIVE=OFF");
        let count = out
            .split_whitespace()
            .filter(|t| t.starts_with("-DGGML_NATIVE="))
            .count();
        assert_eq!(count, 1, "GGML_NATIVE duplicated: {out}");
    }

    #[test]
    fn merge_mandatory_extra_user_flags_preserved() {
        let out = merge_mandatory_cmake_flags("-DGGML_CUDA=ON -DCMAKE_BUILD_TYPE=Release");
        assert!(out.contains("-DGGML_CUDA=ON"));
        assert!(out.contains("-DCMAKE_BUILD_TYPE=Release"));
    }

    #[test]
    fn merge_mandatory_same_key_different_value_not_appended() {
        // -DGGML_NATIVE=ON already present (different value than mandatory OFF) → not appended again
        let out = merge_mandatory_cmake_flags("-DGGML_NATIVE=ON");
        let count = out
            .split_whitespace()
            .filter(|t| t.starts_with("-DGGML_NATIVE="))
            .count();
        assert_eq!(count, 1, "expected exactly one GGML_NATIVE, got: {out}");
    }

    #[test]
    fn batch_flake_case_insensitive_match() {
        assert!(is_windows_vs_tail_batch_flake("The Batch File Cannot Be Found"));
        assert!(is_windows_vs_tail_batch_flake("the batch file cannot be found"));
        assert!(is_windows_vs_tail_batch_flake("xxx THE BATCH FILE CANNOT BE FOUND yyy"));
    }

    #[test]
    fn batch_flake_non_match_is_false() {
        assert!(!is_windows_vs_tail_batch_flake("error C1001"));
        assert!(!is_windows_vs_tail_batch_flake(""));
    }

    #[test]
    fn cmd_escape_percent_doubled() {
        assert_eq!(cmd_escape_batch("100%"), "100%%");
    }

    #[test]
    fn cmd_escape_metachars_caret_escaped() {
        assert_eq!(cmd_escape_batch("a&b"), "a^&b");
        assert_eq!(cmd_escape_batch("a|b"), "a^|b");
        assert_eq!(cmd_escape_batch("a<b"), "a^<b");
        assert_eq!(cmd_escape_batch("a>b"), "a^>b");
        assert_eq!(cmd_escape_batch("a^b"), "a^^b");
        assert_eq!(cmd_escape_batch("(a)"), "^(a^)");
    }

    #[test]
    fn cmd_escape_other_chars_unchanged() {
        assert_eq!(cmd_escape_batch("-DFOO=bar baz"), "-DFOO=bar baz");
        assert_eq!(cmd_escape_batch("hello world"), "hello world");
    }

    #[test]
    fn cache_fingerprint_same_inputs_same_hex() {
        let a = foundry_cache_fingerprint("p1", "cmake -B x -S y", "tc1");
        let b = foundry_cache_fingerprint("p1", "cmake -B x -S y", "tc1");
        assert_eq!(a, b);
        // 64 hex chars (sha256)
        assert_eq!(a.len(), 64);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn cache_fingerprint_different_profile_differs() {
        let a = foundry_cache_fingerprint("p1", "cmake -B x -S y", "tc1");
        let b = foundry_cache_fingerprint("p2", "cmake -B x -S y", "tc1");
        assert_ne!(a, b);
    }

    #[test]
    fn cache_fingerprint_different_cmake_differs() {
        let a = foundry_cache_fingerprint("p1", "cmake -B x -S y", "tc1");
        let b = foundry_cache_fingerprint("p1", "cmake -B x -S z", "tc1");
        assert_ne!(a, b);
    }

    #[test]
    fn cache_fingerprint_different_toolchain_differs() {
        let a = foundry_cache_fingerprint("p1", "cmake -B x -S y", "tc1");
        let b = foundry_cache_fingerprint("p1", "cmake -B x -S y", "tc2");
        assert_ne!(a, b);
    }

    #[test]
    fn cache_fingerprint_null_separated_no_concat_collision() {
        // "ab" + "c" vs "a" + "bc" must not collide (null separator prevents this)
        let a = foundry_cache_fingerprint("ab", "c", "tc");
        let b = foundry_cache_fingerprint("a", "bc", "tc");
        assert_ne!(a, b, "null-separation failed: concat collision");
    }

    #[test]
    fn format_bytes_b() {
        assert_eq!(format_bytes_label(0), "0 B");
        assert_eq!(format_bytes_label(512), "512 B");
        assert_eq!(format_bytes_label(1023), "1023 B");
    }

    #[test]
    fn format_bytes_kib() {
        assert_eq!(format_bytes_label(1024), "1 KiB");
        assert_eq!(format_bytes_label(1536), "2 KiB");
    }

    #[test]
    fn format_bytes_mib() {
        assert_eq!(format_bytes_label(1024 * 1024), "1.0 MiB");
        assert_eq!(format_bytes_label(1536 * 1024), "1.5 MiB");
    }

    #[test]
    fn format_bytes_gib() {
        assert_eq!(format_bytes_label(1024u64 * 1024 * 1024), "1.00 GiB");
        assert_eq!(format_bytes_label(2u64 * 1024 * 1024 * 1024), "2.00 GiB");
    }
}
