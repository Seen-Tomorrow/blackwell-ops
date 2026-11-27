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

/// Update a local GGUF file against Hugging Face via Xet CAS chunk-level delta.
/// Reuses all unchanged 64 KiB chunks directly from `local_path` on disk and downloads
/// only changed Xorb ranges. Returns `status = "fallback_full"` for non-Xet files.
fn make_xet_progress_hook(
    manager: Arc<RwLock<DownloadManager>>,
    app: Option<tauri::AppHandle>,
    task_id: String,
    shard_prefix: Option<String>,
) -> crate::xet_client::XetProgressHook {
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
    let start = std::time::Instant::now();
    let base_reused = Arc::new(AtomicU64::new(u64::MAX));
    let last_emit_ms = Arc::new(AtomicU64::new(0));
    let cancelled = Arc::new(AtomicBool::new(false));

    let mgr_p = Arc::clone(&manager);
    let app_p = app.clone();
    let tid_p = task_id.clone();
    let cancel_p = Arc::clone(&cancelled);
    let on_progress = Arc::new(move |done: u64, total: u64, msg: Option<String>| {
        let base = {
            let cur = base_reused.load(Ordering::Relaxed);
            if cur == u64::MAX {
                base_reused.store(done, Ordering::Relaxed);
                done
            } else {
                cur
            }
        };
        let elapsed_ms = start.elapsed().as_millis() as u64;
        let prev_ms = last_emit_ms.load(Ordering::Relaxed);
        if msg.is_none() && elapsed_ms.saturating_sub(prev_ms) < 250 && done < total {
            return;
        }
        last_emit_ms.store(elapsed_ms, Ordering::Relaxed);

        let fetched = done.saturating_sub(base);
        let elapsed_secs = start.elapsed().as_secs_f64();
        let speed_bps = if elapsed_secs > 0.2 && fetched > 0 {
            (fetched as f64 / elapsed_secs) as u64
        } else {
            0
        };
        let eta_seconds = if speed_bps > 0 && total > done {
            (total - done) / speed_bps
        } else {
            0
        };
        let formatted_msg = msg.map(|m| match &shard_prefix {
            Some(p) => format!("{p} · {m}"),
            None => m,
        });

        let mgr = Arc::clone(&mgr_p);
        let app_c = app_p.clone();
        let tid = tid_p.clone();
        let cancel_flag = Arc::clone(&cancel_p);
        tokio::spawn(async move {
            let mut dm = mgr.write().await;
            if dm.is_task_cancelled(&tid) {
                cancel_flag.store(true, Ordering::Relaxed);
                return;
            }
            dm.update_xet_task(&tid, done, total, speed_bps, eta_seconds, formatted_msg);
            drop(dm);
            if let Some(ref handle) = app_c {
                crate::ipc_emit::emit_guarded(
                    handle,
                    "download-event",
                    serde_json::json!({ "type": "progress", "taskId": tid }),
                );
            }
        });
    });

    let mgr_c = Arc::clone(&manager);
    let tid_c = task_id.clone();
    let cancel_c = Arc::clone(&cancelled);
    let is_cancelled = Arc::new(move || {
        if cancel_c.load(Ordering::Relaxed) {
            return true;
        }
        if let Ok(dm) = mgr_c.try_read() {
            if dm.is_task_cancelled(&tid_c) {
                cancel_c.store(true, Ordering::Relaxed);
                return true;
            }
        }
        false
    });

    let mgr_pause = Arc::clone(&manager);
    let tid_pause = task_id;
    let is_paused = Arc::new(move || {
        mgr_pause
            .try_read()
            .map(|dm| dm.is_task_paused(&tid_pause))
            .unwrap_or(false)
    });

    crate::xet_client::XetProgressHook {
        on_progress,
        is_cancelled,
        is_paused,
    }
}

/// Re-run a recovered Xet delta task when the user clicks RESUME after an app restart.
#[allow(clippy::too_many_arguments)]
pub async fn run_recovered_xet_task(
    manager: Arc<RwLock<DownloadManager>>,
    app: Option<tauri::AppHandle>,
    task_id: String,
    dest_path: String,
    download_url: String,
    lfs_oid: String,
    hf_model_id: String,
    hf_author: String,
    quant_type: String,
    file_name: String,
) {
    let hook = make_xet_progress_hook(Arc::clone(&manager), app.clone(), task_id.clone(), None);
    let expected = (!lfs_oid.is_empty()).then_some(lfs_oid.as_str());
    let res = crate::xet_client::xet_delta_update_with_progress(
        &dest_path,
        &download_url,
        expected,
        Some(hook),
    )
    .await;

    match res {
        Ok(r) => {
            if r.status == "updated" || r.status == "already_current" {
                let size_bytes = std::fs::metadata(&dest_path).map(|m| m.len()).unwrap_or(0);
                let mut meta = crate::model_cache::get_hf_metadata(&dest_path).unwrap_or_else(|| {
                    let slash = hf_model_id.find('/').unwrap_or(0);
                    crate::types::HfMetadata {
                        hf_model_id: hf_model_id.clone(),
                        author: if hf_author.is_empty() && slash > 0 {
                            hf_model_id[..slash].to_string()
                        } else {
                            hf_author.clone()
                        },
                        repo_name: if slash > 0 {
                            hf_model_id[slash + 1..].to_string()
                        } else {
                            String::new()
                        },
                        tags: Vec::new(),
                        downloads: 0,
                        likes_count: 0,
                        quant_type: quant_type.clone(),
                        file_size_bytes: size_bytes,
                        last_modified: String::new(),
                        lfs_oid: String::new(),
                    }
                });
                meta.file_size_bytes = size_bytes;
                if !lfs_oid.is_empty() {
                    meta.lfs_oid = lfs_oid;
                }
                let _ = crate::model_cache::set_hf_metadata(&dest_path, meta);
            }
            if r.status == "updated" {
                crate::download_manager::record_download_history(
                    crate::download_manager::DownloadHistoryEntry {
                        id: format!("xet-{}", chrono::Utc::now().timestamp_micros()),
                        hf_model_id,
                        file_name,
                        quant_type,
                        kind: "xet-delta".into(),
                        status: "updated".into(),
                        bytes: r.bytes_downloaded,
                        finished_at: chrono::Utc::now().timestamp(),
                    },
                );
            }
            let mut dm = manager.write().await;
            dm.finish_xet_task(
                &task_id,
                if r.status == "fallback_full" {
                    crate::types::DownloadStatus::Failed
                } else {
                    crate::types::DownloadStatus::Completed
                },
                r.reason,
                Some(if r.status == "already_current" {
                    "Up to date".to_string()
                } else {
                    "Xet delta complete".to_string()
                }),
            );
            drop(dm);
            if let Some(ref handle) = app {
                crate::ipc_emit::emit_guarded(
                    handle,
                    "download-event",
                    serde_json::json!({ "type": "completed", "taskId": task_id }),
                );
            }
        }
        Err(e) => {
            let mut dm = manager.write().await;
            dm.finish_xet_task(
                &task_id,
                crate::types::DownloadStatus::Failed,
                Some(e),
                None,
            );
            drop(dm);
            if let Some(ref handle) = app {
                crate::ipc_emit::emit_guarded(
                    handle,
                    "download-event",
                    serde_json::json!({ "type": "failed", "taskId": task_id }),
                );
            }
        }
    }
}

#[tauri::command]
pub async fn xet_update_model_file(
    app: tauri::AppHandle,
    manager: tauri::State<'_, Arc<RwLock<DownloadManager>>>,
    local_path: String,
    remote_url: String,
    expected_sha256: Option<String>,
) -> Result<crate::xet_client::XetDeltaReport, String> {
    let dm_arc = Arc::clone(&*manager);
    let path = std::path::Path::new(&local_path);
    let cached_meta = crate::model_cache::get_hf_metadata(&local_path);
    let repo_id = cached_meta
        .as_ref()
        .map(|m| m.hf_model_id.clone())
        .filter(|id| id.contains('/'))
        .or_else(|| {
            remote_url
                .strip_prefix("https://huggingface.co/")
                .or_else(|| remote_url.strip_prefix("http://huggingface.co/"))
                .and_then(|rest| {
                    let mut segs = rest.splitn(4, '/');
                    let owner = segs.next()?;
                    let repo = segs.next()?;
                    (!owner.is_empty() && !repo.is_empty()).then(|| format!("{owner}/{repo}"))
                })
        });

    if let (Some(repo_id), Some(filename), Some(dir)) = (
        repo_id,
        path.file_name().and_then(|s| s.to_str()),
        path.parent(),
    ) {
        let hf_token = crate::secrets::get_secret("hf_token")?;
        if let Ok(files) = crate::hf_api::list_repo_gguf_files(&repo_id, hf_token.as_deref()).await {
            let quant = crate::model_catalog::extract_quant(filename);
            let matched = files
                .iter()
                .filter(|g| g.role.is_quant())
                .find(|g| {
                    g.download_parts()
                        .iter()
                        .any(|p| p.file_name.eq_ignore_ascii_case(filename))
                })
                .or_else(|| files.iter().find(|g| g.role.is_quant() && g.r#type == quant));

            if let Some(hf) = matched {
                let parts = hf.download_parts();
                if !parts.is_empty() {
                    let model_cache = crate::model_cache::load_cache();
                    let slash = repo_id.find('/').unwrap_or(0);
                    let author = repo_id[..slash].to_string();
                    let repo_name = repo_id[slash + 1..].to_string();

                    let mut total_downloaded = 0u64;
                    let mut total_reused = 0u64;
                    let mut total_bytes = 0u64;
                    let mut all_verified = true;
                    let mut any_updated = false;

                    // Collect all stale shards first, pre-plan reused bytes (fast recipe JSON
                    // only, 0 weight bytes), and pre-register them as Queued so every queued
                    // shard immediately shows its reused % and delta size in the Downloads tab.
                    let mut stale_candidates: Vec<(usize, &crate::types::GgufShard, std::path::PathBuf, String)> = Vec::new();
                    for (idx, part) in parts.iter().enumerate() {
                        let sibling = dir.join(&part.file_name);
                        let sibling_str = sibling.to_string_lossy().to_string();
                        let already_current = sibling.is_file()
                            && !part.lfs_oid.is_empty()
                            && crate::model_cache::get_hf_metadata_with_cache(
                                &model_cache,
                                &sibling_str,
                            )
                            .is_some_and(|m| m.lfs_oid == part.lfs_oid);
                        if already_current {
                            total_reused += part.size_bytes;
                            total_bytes += part.size_bytes;
                            continue;
                        }
                        stale_candidates.push((idx, part, sibling, sibling_str));
                    }

                    let batch_items: Vec<(String, String)> = stale_candidates
                        .iter()
                        .map(|(_, part, _, sibling_str)| (sibling_str.clone(), part.url.clone()))
                        .collect();
                    let estimates =
                        crate::xet_client::estimate_xet_deltas_batch(&repo_id, &batch_items).await;

                    let mut queued_shards: Vec<(usize, &crate::types::GgufShard, std::path::PathBuf, String, String)> = Vec::new();
                    {
                        let mut dm = dm_arc.write().await;
                        for ((idx, part, sibling, sibling_str), est) in
                            stale_candidates.into_iter().zip(estimates.into_iter())
                        {
                            let shard_prefix = (parts.len() > 1)
                                .then(|| format!("Shard {}/{}", idx + 1, parts.len()));
                            let status_msg = match &est {
                                Some(e) if e.is_xet && e.reused_bytes > 0 && e.total_bytes > 0 => {
                                    let pct = (e.reused_bytes as f64 / e.total_bytes as f64) * 100.0;
                                    let reused_str = crate::model_catalog::calc_size_str_from_bytes(e.reused_bytes);
                                    let detail = format!("Queued · {reused_str} reused ({pct:.0}%)");
                                    match &shard_prefix {
                                        Some(p) => format!("{p} · {detail}"),
                                        None => detail,
                                    }
                                }
                                Some(e) if e.reused_bytes == 0 => {
                                    let detail = "Queued · full download (0% reused)";
                                    match &shard_prefix {
                                        Some(p) => format!("{p} · {detail}"),
                                        None => detail.to_string(),
                                    }
                                }
                                _ => shard_prefix
                                    .as_deref()
                                    .map(|p| format!("{p} · Queued (Xet delta)"))
                                    .unwrap_or_else(|| "Queued (Xet delta)".to_string()),
                            };
                            let task_id = dm.register_xet_task(
                                repo_id.clone(),
                                part.file_name.clone(),
                                part.url.clone(),
                                sibling_str.clone(),
                                author.clone(),
                                hf.r#type.clone(),
                                part.lfs_oid.clone(),
                                part.size_bytes,
                                crate::types::DownloadStatus::Queued,
                                Some(status_msg),
                            );
                            if let Some(ref e) = est {
                                if e.reused_bytes > 0 {
                                    dm.update_xet_task(&task_id, e.reused_bytes, e.total_bytes, 0, 0, None);
                                }
                            }
                            queued_shards.push((idx, part, sibling, sibling_str, task_id));
                        }
                    }
                    for (_, _, _, _, tid) in &queued_shards {
                        crate::ipc_emit::emit_guarded(
                            &app,
                            "download-event",
                            serde_json::json!({ "type": "queued", "taskId": tid }),
                        );
                    }

                    for (q_pos, (idx, part, sibling, sibling_str, task_id)) in queued_shards.iter().enumerate() {
                        let shard_prefix = (parts.len() > 1)
                            .then(|| format!("Shard {}/{}", idx + 1, parts.len()));
                        if parts.len() > 1 {
                            crate::output_console::emit_blackwell_output_console_utils_line(
                                format!(
                                    "[xet-delta] shard {}/{}: {}",
                                    idx + 1,
                                    parts.len(),
                                    part.file_name
                                ),
                                crate::output_console::BlackwellOutputConsoleLineStyle::Highlight,
                            );
                        }

                        {
                            let mut dm = dm_arc.write().await;
                            dm.set_xet_task_downloading(
                                task_id,
                                Some(
                                    shard_prefix
                                        .as_deref()
                                        .map(|p| format!("{p} · Xet delta planning…"))
                                        .unwrap_or_else(|| "Xet delta planning…".to_string()),
                                ),
                            );
                        }
                        crate::ipc_emit::emit_guarded(
                            &app,
                            "download-event",
                            serde_json::json!({ "type": "progress", "taskId": task_id }),
                        );

                        let hook = make_xet_progress_hook(
                            Arc::clone(&dm_arc),
                            Some(app.clone()),
                            task_id.clone(),
                            shard_prefix,
                        );
                        let expected = (!part.lfs_oid.is_empty()).then_some(part.lfs_oid.as_str());
                        let res = crate::xet_client::xet_delta_update_with_progress(
                            sibling_str,
                            &part.url,
                            expected,
                            Some(hook),
                        )
                        .await;

                        let r = match res {
                            Ok(r) => {
                                let mut dm = dm_arc.write().await;
                                if r.status == "fallback_full" {
                                    dm.finish_xet_task(
                                        task_id,
                                        crate::types::DownloadStatus::Failed,
                                        r.reason.clone(),
                                        None,
                                    );
                                } else {
                                    dm.finish_xet_task(
                                        task_id,
                                        crate::types::DownloadStatus::Completed,
                                        None,
                                        Some(if r.status == "already_current" {
                                            "Up to date".to_string()
                                        } else {
                                            "Xet delta complete".to_string()
                                        }),
                                    );
                                }
                                drop(dm);
                                crate::ipc_emit::emit_guarded(
                                    &app,
                                    "download-event",
                                    serde_json::json!({ "type": "completed", "taskId": task_id }),
                                );
                                r
                            }
                            Err(e) => {
                                let mut dm = dm_arc.write().await;
                                dm.finish_xet_task(
                                    task_id,
                                    crate::types::DownloadStatus::Failed,
                                    Some(e.clone()),
                                    None,
                                );
                                // Also cancel remaining pre-queued shards in this set.
                                for (_, _, _, _, rem_id) in &queued_shards[q_pos + 1..] {
                                    dm.finish_xet_task(
                                        rem_id,
                                        crate::types::DownloadStatus::Failed,
                                        Some(e.clone()),
                                        None,
                                    );
                                }
                                drop(dm);
                                crate::ipc_emit::emit_guarded(
                                    &app,
                                    "download-event",
                                    serde_json::json!({ "type": "failed", "taskId": task_id }),
                                );
                                return Err(e);
                            }
                        };

                        if r.status == "fallback_full" {
                            return Ok(r);
                        }

                        total_downloaded += r.bytes_downloaded;
                        total_reused += r.bytes_reused;
                        total_bytes += r.total_bytes;
                        all_verified &= r.sha256_verified;
                        if r.status == "updated" {
                            any_updated = true;
                        }

                        if r.status == "updated" || r.status == "already_current" {
                            let size_bytes = std::fs::metadata(sibling)
                                .map(|m| m.len())
                                .unwrap_or(part.size_bytes);
                            let mut updated_meta = crate::model_cache::get_hf_metadata_with_cache(
                                &model_cache,
                                sibling_str,
                            )
                            .unwrap_or_else(|| crate::types::HfMetadata {
                                hf_model_id: repo_id.clone(),
                                author: author.clone(),
                                repo_name: repo_name.clone(),
                                tags: Vec::new(),
                                downloads: 0,
                                likes_count: 0,
                                quant_type: hf.r#type.clone(),
                                file_size_bytes: size_bytes,
                                last_modified: String::new(),
                                lfs_oid: String::new(),
                            });
                            updated_meta.file_size_bytes = size_bytes;
                            if !part.lfs_oid.is_empty() {
                                updated_meta.lfs_oid = part.lfs_oid.clone();
                            }
                            let _ = crate::model_cache::set_hf_metadata(sibling_str, updated_meta);
                        }
                    }

                    if any_updated {
                        crate::download_manager::record_download_history(
                            crate::download_manager::DownloadHistoryEntry {
                                id: format!("xet-{}", chrono::Utc::now().timestamp_micros()),
                                hf_model_id: repo_id,
                                file_name: filename.to_string(),
                                quant_type: hf.r#type.clone(),
                                kind: "xet-delta".into(),
                                status: "updated".into(),
                                bytes: total_downloaded,
                                finished_at: chrono::Utc::now().timestamp(),
                            },
                        );
                    }

                    return Ok(crate::xet_client::XetDeltaReport {
                        status: if any_updated {
                            "updated".into()
                        } else {
                            "already_current".into()
                        },
                        bytes_downloaded: total_downloaded,
                        bytes_reused: total_reused,
                        total_bytes,
                        sha256_verified: all_verified,
                        reason: None,
                    });
                }
            }
        }
    }

    let file_name = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("model.gguf")
        .to_string();
    let total_guess = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    let task_id = {
        let mut dm = dm_arc.write().await;
        dm.register_xet_task(
            cached_meta
                .as_ref()
                .map(|m| m.hf_model_id.clone())
                .unwrap_or_default(),
            file_name.clone(),
            remote_url.clone(),
            local_path.clone(),
            cached_meta
                .as_ref()
                .map(|m| m.author.clone())
                .unwrap_or_default(),
            cached_meta
                .as_ref()
                .map(|m| m.quant_type.clone())
                .unwrap_or_default(),
            expected_sha256.clone().unwrap_or_default(),
            total_guess,
            crate::types::DownloadStatus::Downloading,
            Some("Xet delta planning…".to_string()),
        )
    };
    crate::ipc_emit::emit_guarded(
        &app,
        "download-event",
        serde_json::json!({ "type": "queued", "taskId": task_id }),
    );
    let hook = make_xet_progress_hook(Arc::clone(&dm_arc), Some(app.clone()), task_id.clone(), None);
    let res = crate::xet_client::xet_delta_update_with_progress(
        &local_path,
        &remote_url,
        expected_sha256.as_deref(),
        Some(hook),
    )
    .await;

    let report = match res {
        Ok(r) => {
            let mut dm = dm_arc.write().await;
            dm.finish_xet_task(
                &task_id,
                if r.status == "fallback_full" {
                    crate::types::DownloadStatus::Failed
                } else {
                    crate::types::DownloadStatus::Completed
                },
                r.reason.clone(),
                Some("Xet delta complete".to_string()),
            );
            drop(dm);
            crate::ipc_emit::emit_guarded(
                &app,
                "download-event",
                serde_json::json!({ "type": "completed", "taskId": task_id }),
            );
            r
        }
        Err(e) => {
            let mut dm = dm_arc.write().await;
            dm.finish_xet_task(
                &task_id,
                crate::types::DownloadStatus::Failed,
                Some(e.clone()),
                None,
            );
            drop(dm);
            crate::ipc_emit::emit_guarded(
                &app,
                "download-event",
                serde_json::json!({ "type": "failed", "taskId": task_id }),
            );
            return Err(e);
        }
    };

    if report.status == "updated" || report.status == "already_current" {
        if let Some(mut meta) = cached_meta {
            if let Ok(md) = std::fs::metadata(path) {
                meta.file_size_bytes = md.len();
            }
            if let Some(ref oid) = expected_sha256 {
                if !oid.is_empty() {
                    meta.lfs_oid = oid.clone();
                }
            }
            let _ = crate::model_cache::set_hf_metadata(&local_path, meta);
        }
    }

    if report.status == "updated" {
        crate::download_manager::record_download_history(
            crate::download_manager::DownloadHistoryEntry {
                id: format!("xet-{}", chrono::Utc::now().timestamp_micros()),
                hf_model_id: String::new(),
                file_name,
                quant_type: String::new(),
                kind: "xet-delta".into(),
                status: "updated".into(),
                bytes: report.bytes_downloaded,
                finished_at: chrono::Utc::now().timestamp(),
            },
        );
    }

    Ok(report)
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