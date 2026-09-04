// ── Download Manager Commands ─────────────────────────────────────────
//!
//! Moved verbatim out of `main.rs`; bodies unchanged.

use std::sync::Arc;
use tokio::sync::RwLock;
use crate::download_manager::DownloadManager;
use crate::engine::AppContext;
use tauri::{Emitter, Manager};

#[tauri::command]
pub async fn start_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    hf_model_id: String,
    file_name: String,
    url: String,
    total_bytes: u64,
    dest_path: String,
    hf_author: String,
    quant_type: String,
    lfs_oid: String,
) -> Result<String, String> {
    crate::config::validate_hf_model_id(&hf_model_id)?;
    crate::config::validate_download_file_name(&file_name)?;
    crate::config::validate_download_url_matches_model(&url, &hf_model_id, &file_name)?;
    if total_bytes > crate::config::MAX_DOWNLOAD_SIZE_BYTES {
        return Err(format!(
            "File too large: {} exceeds {} byte limit",
            total_bytes,
            crate::config::MAX_DOWNLOAD_SIZE_BYTES
        ));
    }
    {
        let cfg = app_config.lock().map_err(|e| e.to_string())?;
        crate::config::validate_download_dest(&dest_path, &cfg)?;
    }

    let mut dm = manager.write().await;
    if dm.has_active_task_for_dest(&dest_path) {
        return Err("A download for this file is already in progress".to_string());
    }
    let task_id = dm
        .start_download(
            hf_model_id,
            file_name,
            url,
            total_bytes,
            dest_path,
            hf_author,
            quant_type,
            lfs_oid,
            None,
            Arc::clone(&manager),
        )
        .await?;
    drop(dm);

    crate::ipc_meter::emit_tracked(&app, "download-event", serde_json::json!({
        "type": "queued",
        "taskId": task_id,
    }));

    Ok(task_id)
}

/// Download all parts of a quant — single file or full shard set.
#[tauri::command]
pub async fn start_quant_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    hf_model_id: String,
    hf_author: String,
    quant_type: String,
    gguf_file: crate::types::GgufFile,
) -> Result<Vec<String>, String> {
    crate::config::validate_hf_model_id(&hf_model_id)?;
    crate::config::validate_quant_download(&gguf_file, &hf_model_id)?;
    // Enforce size cap on every part of the quant.
    for part in &gguf_file.download_parts() {
        if part.size_bytes > crate::config::MAX_DOWNLOAD_SIZE_BYTES {
            return Err(format!(
                "Shard too large: {} exceeds {} byte limit",
                part.size_bytes,
                crate::config::MAX_DOWNLOAD_SIZE_BYTES
            ));
        }
    }

    let default_path = {
        let cfg = app_config.lock().map_err(|e| e.to_string())?;
        crate::config::get_default_download_path(&cfg)
    };

    let parts = gguf_file.download_parts();
    let mut task_ids: Vec<String> = Vec::new();
    let mut skipped_complete = 0usize;
    let mut skipped_active = 0usize;

    let mut dm = manager.write().await;

    let mut batch_parts: Vec<crate::types::QuantBatchPart> = Vec::with_capacity(parts.len());
    for part in &parts {
        let dest_path =
            crate::config::build_quant_dest_path(&default_path, &hf_model_id, &part.path_in_repo)?;
        {
            let cfg = app_config.lock().map_err(|e| e.to_string())?;
            crate::config::validate_download_dest(&dest_path, &cfg)?;
        }
        batch_parts.push(crate::types::QuantBatchPart {
            dest_path,
            total_bytes: part.size_bytes,
            lfs_oid: part.lfs_oid.clone(),
            file_name: part.file_name.clone(),
            download_url: part.url.clone(),
        });
    }

    let batch_id = if parts.len() > 1 {
        Some(dm.begin_quant_batch(
            hf_model_id.clone(),
            hf_author.clone(),
            quant_type.clone(),
            batch_parts,
        ))
    } else {
        None
    };

    for part in parts {
        let dest_path =
            crate::config::build_quant_dest_path(&default_path, &hf_model_id, &part.path_in_repo)?;

        if crate::config::quant_part_already_downloaded(&dest_path, part.size_bytes, &part.lfs_oid) {
            skipped_complete += 1;
            continue;
        }
        if dm.has_active_task_for_dest(&dest_path) {
            skipped_active += 1;
            continue;
        }

        let task_id = dm
            .start_download(
                hf_model_id.clone(),
                part.file_name.clone(),
                part.url.clone(),
                part.size_bytes,
                dest_path,
                hf_author.clone(),
                quant_type.clone(),
                part.lfs_oid.clone(),
                batch_id.clone(),
                Arc::clone(&manager),
            )
            .await?;
        task_ids.push(task_id);
    }
    drop(dm);

    if task_ids.is_empty() {
        if skipped_complete > 0 && skipped_active == 0 {
            return Err("All parts already downloaded".to_string());
        }
        if skipped_active > 0 {
            return Err("All parts already downloaded or in progress".to_string());
        }
        return Err("No files to download".to_string());
    }

    for task_id in &task_ids {
        crate::ipc_meter::emit_tracked(&app, "download-event", serde_json::json!({
            "type": "queued",
            "taskId": task_id,
        }));
    }

    Ok(task_ids)
}

#[tauri::command]
pub async fn pause_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    task_id: String,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    dm.pause_task(&task_id)?;
    drop(dm);

    crate::ipc_meter::emit_tracked(&app, "download-event", serde_json::json!({
        "type": "paused",
        "taskId": task_id,
    }));

    Ok(())
}

#[tauri::command]
pub async fn cancel_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    task_id: String,
) -> Result<(), String> {
    let part_paths = {
        let mut dm = manager.write().await;
        dm.cancel_task(&task_id)?
    };
    // Worker checks Failed on a 50ms tick and must drop the file handle first (Windows).
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
    let paths = part_paths.clone();
    tokio::task::spawn_blocking(move || {
        crate::download_manager::delete_partial_files(&paths);
    })
    .await
    .map_err(|e| format!("cancel cleanup join: {e}"))?;

    crate::ipc_meter::emit_tracked(&app, "download-event", serde_json::json!({
        "type": "cancelled",
        "taskId": task_id,
    }));

    Ok(())
}

#[tauri::command]
pub async fn resume_download(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    task_id: String,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    let result = dm.resume_download(task_id.clone(), Arc::clone(&manager)).await;
    drop(dm);

    if result.is_ok() {
        crate::ipc_meter::emit_tracked(&app, "download-event", serde_json::json!({
            "type": "resumed",
            "taskId": task_id,
        }));
    }

    result
}

#[tauri::command]
pub async fn start_toolchain_download(
    app: tauri::AppHandle,
    ctx: tauri::State<'_, AppContext>,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    pack: Option<String>,
) -> Result<String, String> {
    {
        let stack = ctx.stack.lock().await;
        if let Some(msg) = crate::engine::toolchain_install_blocked_message(&stack) {
            return Err(msg);
        }
    }
    let mut dm = manager.write().await;
    let task_id = dm
        .start_toolchain_download(pack, Arc::clone(&manager))
        .await?;
    drop(dm);

    crate::ipc_meter::emit_tracked(
        &app,
        "download-event",
        serde_json::json!({
            "type": "queued",
            "taskId": task_id,
            "taskKind": "toolchain",
        }),
    );

    Ok(task_id)
}

#[tauri::command]
pub async fn retry_toolchain_extract(
    app: tauri::AppHandle,
    ctx: tauri::State<'_, AppContext>,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    pack: Option<String>,
) -> Result<String, String> {
    {
        let stack = ctx.stack.lock().await;
        if let Some(msg) = crate::engine::toolchain_install_blocked_message(&stack) {
            return Err(msg);
        }
    }
    let mut dm = manager.write().await;
    let task_id = dm
        .retry_toolchain_extract(pack, Arc::clone(&manager))
        .await?;
    drop(dm);

    crate::ipc_meter::emit_tracked(
        &app,
        "download-event",
        serde_json::json!({
            "type": "extract",
            "taskId": task_id,
            "taskKind": "toolchain",
        }),
    );

    Ok(task_id)
}

#[tauri::command]
pub async fn get_download_tasks(
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
) -> Result<Vec<serde_json::Value>, String> {
    let dm = manager.read().await;
    let tasks = dm.get_all_tasks();
    drop(dm);

    Ok(tasks.iter().map(|t| serde_json::to_value(t).unwrap_or_default()).collect())
}

#[tauri::command]
pub async fn get_download_history() -> Result<Vec<crate::download_manager::DownloadHistoryEntry>, String> {
    Ok(crate::download_manager::load_download_history())
}

#[tauri::command]
pub async fn clear_completed_downloads(
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    dm.remove_completed();
    Ok(())
}

/// Manual recovery: reconcile persisted sharded-batch manifests against on-disk state and
/// re-create tasks for any incomplete parts that lost their queue entry after a restart.
/// Call this from the UI when downloads disappear after the app closes while a multi-part
/// download is mid-batch.
#[tauri::command]
pub async fn recover_orphaned_batch_parts(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
) -> Result<usize, String> {
    let created = {
        let mut dm = manager.write().await;
        let created = dm.requeue_orphaned_batch_parts();
        // After reconciliation, check whether any now-complete batches can finalize.
        dm.try_finalize_pending_batches();
        created
    };
    // Signal frontend to refresh the download list.
    let _ = app.emit("download-event", serde_json::json!({ "type": "reconciled" }));
    Ok(created)
}

/// Patch a local GGUF file with new metadata from HF when only the header
/// (metadata section) has changed. Avoids re-downloading the entire file.
///
/// - `local_path` — full path to the local .gguf file
/// - `remote_url` — HF download URL for the same quant
/// - `remote_total_size` — total file size of the remote file (from HF API)
#[tauri::command]
pub async fn patch_model_metadata(
    local_path: String,
    remote_url: String,
    remote_total_size: u64,
) -> Result<String, String> {
    match crate::gguf_patch::patch_metadata(&local_path, &remote_url, remote_total_size).await {
        crate::gguf_patch::PatchResult::AlreadyCurrent => Ok("already_current".to_string()),
        crate::gguf_patch::PatchResult::Patched { header_bytes_downloaded, local_io_bytes } => {
            log::info!(
                "[patch-model] Patched {}: downloaded {} header bytes, {} local I/O",
                local_path,
                header_bytes_downloaded,
                local_io_bytes
            );
            let name = std::path::Path::new(&local_path)
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("model.gguf")
                .to_string();
            crate::download_manager::record_download_history(
                crate::download_manager::DownloadHistoryEntry {
                    id: format!("patch-{}", chrono::Utc::now().timestamp_micros()),
                    hf_model_id: String::new(),
                    file_name: name,
                    quant_type: String::new(),
                    kind: "header".into(),
                    status: "patched".into(),
                    bytes: header_bytes_downloaded,
                    finished_at: chrono::Utc::now().timestamp(),
                },
            );
            let _ = local_io_bytes;
            Ok("patched".to_string())
        }
        crate::gguf_patch::PatchResult::RequiresFullDownload { reason } => {
            Err(format!("Requires full re-download: {}", reason))
        }
        crate::gguf_patch::PatchResult::Error(e) => Err(e),
    }
}

/// Adjust queue priority for a download task — lower number = higher priority.
/// Tasks with higher priority skip ahead when competing for download slots.
#[tauri::command]
pub async fn set_download_priority(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    task_id: String,
    priority: u32,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    let new_priority = dm.set_task_priority(&task_id, priority)?;
    drop(dm);
    let _ = app.emit("download-event", serde_json::json!({
        "type": "reprioritized",
        "taskId": task_id,
        "priority": new_priority,
    }));
    Ok(())
}

/// Move a task up in priority (decrements by step, min 0 = highest).
#[tauri::command]
pub async fn move_download_up(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    task_id: String,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    let new_priority = dm.bump_priority_up(&task_id)?;
    drop(dm);
    let _ = app.emit("download-event", serde_json::json!({
        "type": "reprioritized",
        "taskId": task_id,
        "priority": new_priority,
    }));
    Ok(())
}

/// Move a task down in priority (increments by step, max 1000 = lowest).
#[tauri::command]
pub async fn move_download_down(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    task_id: String,
) -> Result<(), String> {
    let mut dm = manager.write().await;
    let new_priority = dm.bump_priority_down(&task_id)?;
    drop(dm);
    let _ = app.emit("download-event", serde_json::json!({
        "type": "reprioritized",
        "taskId": task_id,
        "priority": new_priority,
    }));
    Ok(())
}

/// Check whether the target file already exists on disk and compare its LFS OID.
#[tauri::command]
pub fn check_download_target(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    dest_path: String,
    lfs_oid: String,
) -> Result<serde_json::Value, String> {
    {
        let cfg = app_config.lock().map_err(|e| e.to_string())?;
        crate::config::validate_download_dest(&dest_path, &cfg)?;
    }

    let exists = std::path::Path::new(&dest_path).exists();
    if !exists {
        return Ok(serde_json::json!({
            "exists": false,
            "sameModel": false,
            "lfsMatch": false,
            "cachedLfsOid": null,
        }));
    }

    // Look up cached HF metadata for this file
    let cached_hf = crate::model_cache::get_hf_metadata(&dest_path);
    let cached_lfs = cached_hf.as_ref().and_then(|m| if m.lfs_oid.is_empty() { None } else { Some(m.lfs_oid.clone()) });

    let cached_oid_str = cached_lfs.clone();
    // Both empty = can't differentiate, assume identical (pre-fix downloads or non-LFS files).
    let lfs_match = if lfs_oid.is_empty() {
        cached_lfs.is_none()
    } else {
        cached_lfs.as_deref() == Some(lfs_oid.as_str())
    };

    // Determine sameModel: same cached HF model ID or same filename
    let same_model = cached_hf.is_some();

    Ok(serde_json::json!({
        "exists": true,
        "sameModel": same_model,
        "lfsMatch": lfs_match,
        "cachedLfsOid": cached_oid_str,
    }))
}

/// Check HF GGUF files against local disk catalog. Returns per-file match results.
#[tauri::command]
pub async fn check_hf_files_against_disk(
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    gguf_files: Vec<crate::types::GgufFile>,
    app: tauri::AppHandle,
    hf_model_id: Option<String>,
) -> Result<Vec<crate::types::DiskCheckResult>, String> {
    if let Some(ref model_id) = hf_model_id {
        crate::config::validate_hf_model_id(model_id)?;
    }
    for gf in &gguf_files {
        if !gf.url.is_empty() {
            crate::config::validate_download_url(&gf.url)?;
        }
    }

    let cfg = app_config.lock().map_err(|e| e.to_string())?;
    let paths = crate::config::get_model_paths(&cfg);
    let log_hub = app.state::<AppContext>().log_hub.clone();
    Ok(crate::model_catalog::check_hf_files_against_disk(&paths, &gguf_files, Some(&log_hub), hf_model_id.as_deref()))
}
