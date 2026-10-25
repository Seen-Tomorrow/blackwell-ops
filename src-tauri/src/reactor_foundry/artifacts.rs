//! Sacred artifacts publish — copy built Release tree into the permanent artifacts dir.
//!
//! Leaf module of the Foundry build service. The only place the sacred
//! `artifacts/<provider>/<env>/Release` tree is written during a normal build,
//! plus the one-previous-artifact (Release.prev) rotation for the restore button.

use std::path::Path;

// ── Sacred Artifacts Publish (new directory model) ──────────────────

/// Copy the contents of the just-built Release dir (inside the disposable work tree)
/// into the sacred artifacts/<provider>/<env>/Release location.
/// Returns the absolute path to the published llama-server.exe on success.
pub(crate) async fn publish_artifacts_to_sacred(
    provider_id: &str,
    profile_id: &str,
    build_dir: &Path,   // the temp work/build-xxx
    _src_dir: &Path,    // unused in new model but kept for signature compat during transition
) -> Result<String, String> {
    let temp_release = build_dir.join("bin").join("Release");
    if !temp_release.exists() {
        return Err("Build produced no Release directory under bin/".into());
    }

    let sacred = crate::config::foundry_artifact_release_dir(provider_id, profile_id);
    if let Err(e) = tokio::fs::create_dir_all(&sacred).await {
        return Err(format!("Failed to create sacred artifacts dir: {}", e));
    }

    // Keep one previous artifact for the "Restore Previous Build" button (user request).
    // Before overwriting, move the current Release to Release.prev (deleting old .prev if present).
    let prev_dir = sacred
        .parent()
        .ok_or_else(|| format!("Invalid sacred artifact path: {}", sacred.display()))?
        .join("Release.prev");
    if sacred.exists() {
        // Remove any previous .prev
        if prev_dir.exists() {
            let _ = tokio::fs::remove_dir_all(&prev_dir).await;
        }
        // Move current sacred -> .prev
        let _ = tokio::fs::rename(&sacred, &prev_dir).await;
        // Recreate the target dir for the new copy
        let _ = tokio::fs::create_dir_all(&sacred).await;
    }

    // Simple recursive copy (small tree: a few exes + dlls + pdbs at most)
    copy_dir_contents(&temp_release, &sacred).await
        .map_err(|e| format!("Copy to sacred artifacts failed: {}", e))?;

    let exe = sacred.join("llama-server.exe");
    if !exe.exists() {
        return Err("Published directory missing llama-server.exe".into());
    }

    // Engine identity sidecar. CMake derived these from git at configure time
    // (cmake/build-info.cmake), so no probe, CPU build or spawn is needed — and it is rewritten
    // with every publish, so it can never go stale.
    write_build_info_sidecar(build_dir, &sacred).await;

    log::info!("[foundry] Published sacred artifacts for {} {} -> {}", provider_id, profile_id, sacred.display());
    Ok(exe.to_string_lossy().to_string())
}

/// Read one `KEY:TYPE=value` entry from a CMake cache file.
fn cache_value(cache: &str, key: &str) -> Option<String> {
    for line in cache.lines() {
        let Some(rest) = line.strip_prefix(key) else {
            continue;
        };
        if !rest.starts_with(':') {
            continue;
        }
        if let Some((_, value)) = rest.split_once('=') {
            let v = value.trim();
            if !v.is_empty() {
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Parse the CMake-generated `common/build-info.cpp`:
/// `int LLAMA_BUILD_NUMBER = 11870;` / `char const * LLAMA_COMMIT = "74bca3950";`
fn parse_generated_build_info(text: &str) -> Option<(String, String)> {
    let mut build = None;
    let mut commit = None;
    for line in text.lines() {
        if build.is_none() && line.contains("LLAMA_BUILD_NUMBER") {
            if let Some((_, rhs)) = line.split_once('=') {
                let digits: String = rhs.chars().filter(|c| c.is_ascii_digit()).collect();
                if !digits.is_empty() {
                    build = Some(digits);
                }
            }
        }
        if commit.is_none() && line.contains("LLAMA_COMMIT") {
            if let Some(start) = line.find('"') {
                if let Some(len) = line[start + 1..].find('"') {
                    let candidate = &line[start + 1..start + 1 + len];
                    if (7..=40).contains(&candidate.len())
                        && candidate.chars().all(|c| c.is_ascii_hexdigit())
                    {
                        commit = Some(candidate.to_string());
                    }
                }
            }
        }
    }
    Some((build?, commit?))
}

/// Version name CMake generated for this build (`llama-config-version.cmake`):
/// `set(PACKAGE_VERSION "0.7.0-dev")`.
fn parse_package_version(text: &str) -> Option<String> {
    let line = text
        .lines()
        .find(|l| l.trim_start().starts_with("set(PACKAGE_VERSION"))?;
    let start = line.find('"')? + 1;
    let rest = &line[start..];
    let end = rest.find('"')?;
    let value = rest[..end].trim();
    if value.is_empty() || value.contains("${") {
        None
    } else {
        Some(value.to_string())
    }
}

async fn read_engine_version_name(build_dir: &Path) -> Option<String> {
    let path = build_dir.join("llama-config-version.cmake");
    let text = tokio::fs::read_to_string(path).await.ok()?;
    parse_package_version(&text)
}

/// Write `build-info.txt` beside the published engine binaries: `<version> (build N)` when the
/// configure produced a version name, `b<build>-<commit>` otherwise.
/// Source of truth is the CMake-generated `common/build-info.cpp`; `CMakeCache.txt` is only a
/// fallback because upstream sets these as normal variables, not cache entries.
async fn write_build_info_sidecar(build_dir: &Path, sacred: &Path) {
    let generated = build_dir.join("common").join("build-info.cpp");
    let from_generated = match tokio::fs::read_to_string(&generated).await {
        Ok(text) => parse_generated_build_info(&text),
        Err(_) => None,
    };
    let pair = match from_generated {
        Some(pair) => pair,
        None => {
            let cache = build_dir.join("CMakeCache.txt");
            let Ok(text) = tokio::fs::read_to_string(&cache).await else {
                log::warn!("[foundry] no build-info.cpp or CMakeCache — build-info.txt skipped");
                return;
            };
            let (Some(build), Some(commit)) = (
                cache_value(&text, "LLAMA_BUILD_NUMBER"),
                cache_value(&text, "LLAMA_BUILD_COMMIT"),
            ) else {
                log::warn!("[foundry] build info missing in cache — build-info.txt skipped");
                return;
            };
            (build, commit)
        }
    };
    let short: String = pair.1.chars().take(8).collect();
    let body = match read_engine_version_name(build_dir).await {
        Some(version) => format!("{version} (build {})\n", pair.0),
        None => format!("b{}-{short}\n", pair.0),
    };
    if let Err(e) = tokio::fs::write(sacred.join("build-info.txt"), body).await {
        log::warn!("[foundry] could not write build-info.txt: {e}");
    }
}

#[cfg(test)]
mod build_info_tests {
    use super::{cache_value, parse_generated_build_info, parse_package_version};

    #[test]
    fn reads_typed_cache_entries_only() {
        let cache = "LLAMA_BUILD_NUMBER:STRING=11869\nLLAMA_BUILD_COMMIT:STRING=d327bf1f0\nLLAMA_BUILD_NUMBER_EXTRA=x\n";
        assert_eq!(cache_value(cache, "LLAMA_BUILD_NUMBER").as_deref(), Some("11869"));
        assert_eq!(cache_value(cache, "LLAMA_BUILD_COMMIT").as_deref(), Some("d327bf1f0"));
        assert_eq!(cache_value(cache, "LLAMA_BUILD_NUMBER_EXTRA"), None);
        assert_eq!(cache_value(cache, "MISSING"), None);
    }

    #[test]
    #[test]
    fn parses_the_generated_package_version() {
        let text = "set(PACKAGE_VERSION \"0.7.0-dev\")";
        assert_eq!(parse_package_version(text).as_deref(), Some("0.7.0-dev"));
        assert_eq!(parse_package_version("nothing here"), None);
    }
    fn parses_the_cmake_generated_build_info() {
        let generated = "#include \"build-info.h\"\n\
int LLAMA_BUILD_NUMBER = 11870;\n\
char const * LLAMA_COMMIT = \"74bca3950\";\n\
char const * LLAMA_COMPILER = \"MSVC 19.51.36243.0\";\n";
        assert_eq!(
            parse_generated_build_info(generated),
            Some(("11870".to_string(), "74bca3950".to_string()))
        );
    }
}

/// Recursively copy *contents* of src_dir into dst_dir (dst must already exist).
pub(crate) async fn copy_dir_contents(src_dir: &Path, dst_dir: &Path) -> std::io::Result<()> {
    let mut rd = tokio::fs::read_dir(src_dir).await?;
    while let Some(entry) = rd.next_entry().await? {
        let src_path = entry.path();
        let dst_path = dst_dir.join(entry.file_name());

        let ft = entry.file_type().await?;
        if ft.is_dir() {
            tokio::fs::create_dir_all(&dst_path).await?;
            Box::pin(copy_dir_contents(&src_path, &dst_path)).await?;
        } else {
            // Overwrite if exists (normal case when re-building a profile)
            let _ = tokio::fs::copy(&src_path, &dst_path).await?;
        }
    }
    Ok(())
}
