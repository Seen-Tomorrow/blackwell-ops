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

    crate::ipc_emit::emit_guarded(&app, "download-event", serde_json::json!({
        "type": "queued",
        "taskId": task_id,
    }));

    Ok(task_id)
}

// Download one companion file from the model's Hub repo into the extras store and
/// pin it to the slot. The pin is written now; launch/FIT only use it once the file
/// exists, so a queued download cannot break a launch.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn download_companion(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    model_path: String,
    role: String,
    repo_id: String,
    path_in_repo: String,
    size_bytes: u64,
    url: String,
    lfs_oid: String,
) -> Result<String, String> {
    let role_enum = crate::companions::parse_role(&role)?;
    let file_name = path_in_repo
        .rsplit('/')
        .next()
        .unwrap_or(&path_in_repo)
        .to_string();
    crate::config::validate_hf_model_id(&repo_id)?;
    crate::config::validate_download_file_name(&file_name)?;
    crate::config::validate_download_url_matches_model(&url, &repo_id, &file_name)?;
    if size_bytes > crate::config::MAX_DOWNLOAD_SIZE_BYTES {
        return Err(format!(
            "File too large: {} exceeds {} byte limit",
            size_bytes,
            crate::config::MAX_DOWNLOAD_SIZE_BYTES
        ));
    }

    let dest_path = {
        let cfg = app_config.lock().map_err(|e| e.to_string())?;
        // SWAP files keep to one shape: <extras>/<role>/<author>__<repo>__<file>.
        // The prefix carries provenance (which Hub repo it came from) so two repos that
        // ship the same file name cannot collide in a flat role directory.
        let dest_dir = crate::config::extras_dir_for(&cfg, &role)
            .or_else(|| {
                std::path::Path::new(&model_path)
                    .parent()
                    .map(|parent| parent.join(crate::config::EXTRAS_DIR_NAME).join(&role))
            })
            .ok_or_else(|| "No destination for the companion download".to_string())?;
        std::fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("Failed to create {}: {e}", dest_dir.display()))?;
        let author = repo_id.split('/').next().unwrap_or("");
        let repo = repo_id.split('/').nth(1).unwrap_or("");
        let dest = dest_dir
            .join(format!("{author}__{repo}__{file_name}"))
            .to_string_lossy()
            .to_string();
        crate::config::validate_download_dest(&dest, &cfg)?;
        dest
    };

    let hf_author = repo_id.split('/').next().unwrap_or("").to_string();
    let mut dm = manager.write().await;
    if dm.has_active_task_for_dest(&dest_path) {
        return Err("A download for this file is already in progress".to_string());
    }
    let task_id = dm
        .start_download(
            repo_id,
            file_name,
            url,
            size_bytes,
            dest_path.clone(),
            hf_author,
            role.clone(),
            lfs_oid,
            None,
            Arc::clone(&manager),
        )
        .await?;
    drop(dm);

    // Pin the future path: launch and FIT ignore a file that is not on disk yet.
    crate::companions::set_pin(&model_path, role_enum, &dest_path)?;

    crate::ipc_emit::emit_guarded(&app, "download-event", serde_json::json!({
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
        // A draft head is a SWAP file, not a model: it belongs in the extras store with
        // the rest of them, never beside the launchable quants.
        let dest_path = {
            let cfg = app_config.lock().map_err(|e| e.to_string())?;
            if gguf_file.role == crate::types::GgufRole::Draft {
                crate::config::build_extras_dest_path(&cfg, "draft", &hf_model_id, &part.path_in_repo)?
            } else {
                crate::config::build_quant_dest_path(&default_path, &hf_model_id, &part.path_in_repo)?
            }
        };
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

    // Aggregate preflight: a shard set larger than the free space would fill the
    // volume and fail every worker mid-write. Fail once, before any bytes move.
    {
        let needed: u64 = batch_parts
            .iter()
            .filter(|p| {
                !crate::config::quant_part_already_downloaded(
                    &p.dest_path,
                    p.total_bytes,
                    &p.lfs_oid,
                ) && !dm.has_active_task_for_dest(&p.dest_path)
            })
            .map(|p| {
                let already =
                    crate::download_manager::partial_len(&p.dest_path).min(p.total_bytes);
                p.total_bytes.saturating_sub(already)
            })
            .sum();
        if needed > 0 {
            if let Some(free) = crate::download_manager::free_space_for_path(&default_path) {
                if free < needed {
                    return Err(format!(
                        "Not enough free space: this download still needs {}, only {} is free on the destination volume.",
                        crate::model_catalog::calc_size_str_from_bytes(needed),
                        crate::model_catalog::calc_size_str_from_bytes(free),
                    ));
                }
            }
        }
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
        // A draft head is a SWAP file, not a model: it belongs in the extras store with
        // the rest of them, never beside the launchable quants.
        let dest_path = {
            let cfg = app_config.lock().map_err(|e| e.to_string())?;
            if gguf_file.role == crate::types::GgufRole::Draft {
                crate::config::build_extras_dest_path(&cfg, "draft", &hf_model_id, &part.path_in_repo)?
            } else {
                crate::config::build_quant_dest_path(&default_path, &hf_model_id, &part.path_in_repo)?
            }
        };

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
        crate::ipc_emit::emit_guarded(&app, "download-event", serde_json::json!({
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

    crate::ipc_emit::emit_guarded(&app, "download-event", serde_json::json!({
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

    crate::ipc_emit::emit_guarded(&app, "download-event", serde_json::json!({
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
        crate::ipc_emit::emit_guarded(&app, "download-event", serde_json::json!({
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

    crate::ipc_emit::emit_guarded(
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

    crate::ipc_emit::emit_guarded(
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
) -> Result<crate::types::DownloadTargetCheck, String> {
    {
        let cfg = app_config.lock().map_err(|e| e.to_string())?;
        crate::config::validate_download_dest(&dest_path, &cfg)?;
    }

    let exists = std::path::Path::new(&dest_path).exists();
    if !exists {
        return Ok(crate::types::DownloadTargetCheck {
            exists: false,
            same_model: false,
            lfs_match: false,
            cached_lfs_oid: None,
        });
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

    Ok(crate::types::DownloadTargetCheck {
        exists: true,
        same_model,
        lfs_match,
        cached_lfs_oid: cached_oid_str,
    })
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
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestageReport {
    pub repo_id: String,
    pub queued: usize,
    /// Parts already complete (or queued elsewhere) and therefore untouched.
    pub skipped: usize,
    pub already_complete: bool,
    pub missing: Vec<String>,
}

/// Finish an interrupted set: enqueue only the shards that are not on disk, beside the
/// ones that are. The existing quant's Hub pairing supplies the repo, so nothing is
/// guessed; the destination is the folder the file already lives in.
#[tauri::command]
pub async fn restage_incomplete(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    app_config: tauri::State<'_, Arc<std::sync::Mutex<crate::config::AppConfig>>>,
    model_path: String,
) -> Result<RestageReport, String> {
    let local = std::path::Path::new(&model_path);
    let local_name = local
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or_else(|| "Not a file path".to_string())?
        .to_string();
    let dir = local
        .parent()
        .ok_or_else(|| "The file has no folder".to_string())?
        .to_path_buf();
    let meta = crate::model_cache::get_hf_metadata(&model_path).ok_or_else(|| {
        "No Hub pairing for this file - run VERIFY HUB PAIRINGS in CONFIG -> MODEL PATHS"
            .to_string()
    })?;
    let repo_id = crate::companions::normalize_repo_id(&meta.hf_model_id)
        .ok_or_else(|| format!("'{}' is not an org/repo id", meta.hf_model_id))?;
    let hf_token = crate::secrets::get_secret("hf_token")?;
    let files = crate::hf_api::list_repo_gguf_files(&repo_id, hf_token.as_deref()).await?;
    let set = files
        .iter()
        .find(|f| {
            f.download_parts()
                .iter()
                .any(|p| p.file_name.eq_ignore_ascii_case(&local_name))
        })
        .ok_or_else(|| format!("{repo_id} no longer publishes {local_name}"))?;

    let parts = set.download_parts();
    let author = repo_id.split('/').next().unwrap_or("").to_string();
    let mut missing: Vec<String> = Vec::new();
    let mut ids: Vec<String> = Vec::new();
    let mut skipped: usize = 0;
    let mut dm = manager.write().await;
    for part in &parts {
        if part.size_bytes > crate::config::MAX_DOWNLOAD_SIZE_BYTES {
            return Err(format!("Shard too large: {}", part.file_name));
        }
        let dest_str = dir.join(&part.file_name).to_string_lossy().to_string();
        let dest = std::path::Path::new(&dest_str);
        let present = dest.exists()
            && (std::fs::metadata(dest).map(|m| m.len()).unwrap_or(0) == part.size_bytes
                || crate::config::quant_part_already_downloaded(
                    &dest_str,
                    part.size_bytes,
                    &part.lfs_oid,
                ));
        if present {
            skipped += 1;
            continue;
        }
        if dm.has_active_task_for_dest(&dest_str) {
            skipped += 1;
            continue;
        }
        {
            let cfg = app_config.lock().map_err(|e| e.to_string())?;
            crate::config::validate_download_dest(&dest_str, &cfg)?;
        }
        let task = dm
            .start_download(
                repo_id.clone(),
                part.file_name.clone(),
                part.url.clone(),
                part.size_bytes,
                dest_str,
                author.clone(),
                set.r#type.clone(),
                part.lfs_oid.clone(),
                None,
                Arc::clone(&manager),
            )
            .await?;
        missing.push(part.file_name.clone());
        ids.push(task);
    }
    drop(dm);
    if !ids.is_empty() {
        crate::ipc_emit::emit_guarded(
            &app,
            "download-event",
            serde_json::json!({ "type": "queued", "taskIds": ids }),
        );
    }
    Ok(RestageReport {
        repo_id,
        queued: ids.len(),
        skipped,
        already_complete: missing.is_empty(),
        missing,
    })
}