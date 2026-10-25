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

/// Write `build-info.txt` (`b<build>-<commit>`) beside the published engine binaries.
async fn write_build_info_sidecar(build_dir: &Path, sacred: &Path) {
    let cache = build_dir.join("CMakeCache.txt");
    let Ok(text) = tokio::fs::read_to_string(&cache).await else {
        log::debug!("[foundry] no CMakeCache at {} — build-info.txt skipped", cache.display());
        return;
    };
    let (Some(build), Some(commit)) = (
        cache_value(&text, "LLAMA_BUILD_NUMBER"),
        cache_value(&text, "LLAMA_BUILD_COMMIT"),
    ) else {
        log::warn!("[foundry] CMake cache lacks LLAMA_BUILD_NUMBER/COMMIT — build-info.txt skipped");
        return;
    };
    let short: String = commit.chars().take(8).collect();
    let body = format!("b{build}-{short}\n");
    if let Err(e) = tokio::fs::write(sacred.join("build-info.txt"), body).await {
        log::warn!("[foundry] could not write build-info.txt: {e}");
    }
}

#[cfg(test)]
mod build_info_tests {
    use super::cache_value;

    #[test]
    fn reads_typed_cache_entries_only() {
        let cache = "LLAMA_BUILD_NUMBER:STRING=11869\nLLAMA_BUILD_COMMIT:STRING=d327bf1f0\nLLAMA_BUILD_NUMBER_EXTRA=x\n";
        assert_eq!(cache_value(cache, "LLAMA_BUILD_NUMBER").as_deref(), Some("11869"));
        assert_eq!(cache_value(cache, "LLAMA_BUILD_COMMIT").as_deref(), Some("d327bf1f0"));
        assert_eq!(cache_value(cache, "LLAMA_BUILD_NUMBER_EXTRA"), None);
        assert_eq!(cache_value(cache, "MISSING"), None);
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
