//! Sacred artifacts publish — copy built Release tree into the permanent artifacts dir.
//!
//! Leaf module of the Foundry build service. The only place the sacred
//! `artifacts/<provider>/<env>/Release` tree is written during a normal build,
//! plus the one-previous-artifact (Release.prev) rotation for the restore button.

use std::path::PathBuf;

// ── Sacred Artifacts Publish (new directory model) ──────────────────

/// Copy the contents of the just-built Release dir (inside the disposable work tree)
/// into the sacred artifacts/<provider>/<env>/Release location.
/// Returns the absolute path to the published llama-server.exe on success.
pub(crate) async fn publish_artifacts_to_sacred(
    provider_id: &str,
    profile_id: &str,
    build_dir: &PathBuf,   // the temp work/build-xxx
    _src_dir: &PathBuf,    // unused in new model but kept for signature compat during transition
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

    log::info!("[foundry] Published sacred artifacts for {} {} -> {}", provider_id, profile_id, sacred.display());
    Ok(exe.to_string_lossy().to_string())
}

/// Recursively copy *contents* of src_dir into dst_dir (dst must already exist).
pub(crate) async fn copy_dir_contents(src_dir: &PathBuf, dst_dir: &PathBuf) -> std::io::Result<()> {
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
