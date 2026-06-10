//! Download manager — manages HF model downloads with pause/resume support.
//!
//! Stored as `Arc<RwLock<DownloadManager>>` in Tauri app state. Workers are spawned
//! by IPC commands and independently acquire the lock to update progress.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::path::Path;

use chrono::Utc;
use futures_util::StreamExt;
use reqwest::header::RANGE;
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use crate::types::{DownloadStatus, DownloadTask};

/// Maximum number of concurrent downloads.
const DEFAULT_MAX_CONCURRENT: usize = 3;

/// Interval between progress updates in the download loop (ms).
const PROGRESS_INTERVAL_MS: u64 = 50;

/// Speed smoothing factor (exponential moving average weight).
const SPEED_SMOOTHING: f64 = 0.3;

/// Number of speed samples to keep for calculation.
const SPEED_SAMPLE_COUNT: usize = 5;

/// In-progress downloads write here; renamed to final `.gguf` only on completion.
pub fn partial_download_path(dest_path: &str) -> String {
    format!("{dest_path}.part")
}

/// Download manager singleton state.
pub struct DownloadManager {
    /// All active/completed tasks. In-memory only — not persisted across restarts.
    tasks: HashMap<String, DownloadTask>,
    /// Max concurrent downloads (default 3).
    max_concurrent: usize,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            max_concurrent: DEFAULT_MAX_CONCURRENT,
        }
    }

    /// Create a new download task and spawn the background worker.
    ///
    /// The worker is spawned with a clone of this manager's Arc so it can
    /// independently acquire the lock to check status and update progress.
    pub async fn start_download(
        &mut self,
        hf_model_id: String,
        file_name: String,
        url: String,
        total_bytes: u64,
        dest_path: String,
        hf_author: String,
        quant_type: String,
        lfs_oid: String,
        self_arc: Arc<RwLock<Self>>,
    ) -> Result<String, String> {
        let task_id = generate_task_id();

        let task = DownloadTask {
            id: task_id.clone(),
            hf_model_id,
            file_name,
            download_url: url,
            total_bytes,
            downloaded_bytes: 0,
            status: DownloadStatus::Queued,
            dest_path,
            speed_bps: 0,
            pause_offset: 0,
            error: None,
            eta_seconds: 0,
            hf_author,
            quant_type,
            lfs_oid,
        };

        self.tasks.insert(task_id.clone(), task);

        let worker_arc = self_arc;
        let task_id_for_worker = task_id.clone();
        tokio::spawn(async move {
            Self::download_worker(task_id_for_worker, worker_arc).await;
        });

        Ok(task_id)
    }

    /// Pause a running download. Worker flushes progress and sets `pause_offset` on exit.
    pub fn pause_task(&mut self, task_id: &str) -> Result<(), String> {
        match self.tasks.get_mut(task_id) {
            Some(task) => match task.status {
                DownloadStatus::Downloading => {
                    task.status = DownloadStatus::Paused;
                    task.speed_bps = 0;
                    task.eta_seconds = 0;
                    Ok(())
                }
                _ => Err(format!("Task {} is not downloading (status: {:?})", task_id, task.status)),
            },
            None => Err(format!("Task {} not found", task_id)),
        }
    }

    /// Cancel a download. Sets status to Failed and removes the partial file from disk.
    pub fn cancel_task(&mut self, task_id: &str) -> Result<(), String> {
        match self.tasks.get_mut(task_id) {
            Some(task) => {
                let dest = task.dest_path.clone();
                let partial = partial_download_path(&dest);
                task.status = DownloadStatus::Failed;
                task.error = Some("Cancelled".to_string());

                // Remove partial (and legacy in-progress final path) from disk
                tokio::task::spawn_blocking(move || {
                    for path in [partial.as_str(), dest.as_str()] {
                        if !path.is_empty() && Path::new(path).exists() {
                            let _ = std::fs::remove_file(path);
                        }
                    }
                });

                Ok(())
            }
            None => Err(format!("Task {} not found", task_id)),
        }
    }

    /// Resume a paused download. Resets status to Queued and spawns a new worker.
    pub async fn resume_download(
        &mut self,
        task_id: String,
        self_arc: Arc<RwLock<Self>>,
    ) -> Result<(), String> {
        match self.tasks.get_mut(&task_id) {
            Some(task) => match task.status {
                DownloadStatus::Paused => {
                    task.pause_offset = task.downloaded_bytes;
                    task.status = DownloadStatus::Queued;
                    task.error = None;
                    task.speed_bps = 0;
                    task.eta_seconds = 0;

                    let worker_arc = self_arc;
                    tokio::spawn(async move {
                        Self::download_worker(task_id, worker_arc).await;
                    });

                    Ok(())
                }
                DownloadStatus::Queued | DownloadStatus::Downloading => {
                    Err(format!("Task {} is already active (status: {:?})", task_id, task.status))
                }
                _ => Err(format!("Task {} is not paused (status: {:?})", task_id, task.status)),
            },
            None => Err(format!("Task {} not found", task_id)),
        }
    }

    /// Get all download tasks.
    pub fn get_all_tasks(&self) -> Vec<DownloadTask> {
        self.tasks.values().cloned().collect()
    }

    /// Remove completed/failed tasks older than the last 20 entries (keeps history).
    pub fn remove_completed(&mut self) {
        let mut sorted: Vec<&DownloadTask> = self.tasks.values().collect();
        sorted.sort_by_key(|t| match t.status {
            DownloadStatus::Completed | DownloadStatus::Failed => t.downloaded_bytes,
            _ => 0,
        });

        if sorted.len() > 20 {
            let to_remove: Vec<String> = sorted[..sorted.len() - 20]
                .iter()
                .filter(|t| matches!(t.status, DownloadStatus::Completed | DownloadStatus::Failed))
                .map(|t| t.id.clone())
                .collect();

            for id in to_remove {
                self.tasks.remove(&id);
            }
        }
    }

    /// Get the count of currently downloading tasks.
    pub fn active_download_count(&self) -> usize {
        self.tasks
            .values()
            .filter(|t| matches!(t.status, DownloadStatus::Downloading))
            .count()
    }

    /// Resolved final paths for queued/active/paused tasks — hide from model catalog until complete.
    pub fn in_progress_dest_paths(&self) -> HashSet<String> {
        self.tasks
            .values()
            .filter(|t| {
                matches!(
                    t.status,
                    DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Paused
                )
            })
            .map(|t| {
                crate::config::resolve_path(&t.dest_path)
                    .to_string_lossy()
                    .to_string()
            })
            .collect()
    }

    /// The actual download loop — runs in a spawned tokio task.
    async fn download_worker(task_id: String, manager: Arc<RwLock<Self>>) {
        // HF's /resolve/main/ returns 302 → signed CAS URL. We need Range header preserved through redirect,
        // but reqwest strips custom headers on cross-host redirects by default. Manual follow:
        let base_client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("failed to build HTTP client");

        // Wait for a slot to open (under max_concurrent)
        loop {
            {
                let dm = manager.read().await;
                if dm.active_download_count() < dm.max_concurrent {
                    drop(dm);
                    break;
                }
                drop(dm);
            }
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;

            // Check if task was cancelled while waiting
            {
                let dm = manager.read().await;
                if let Some(task) = dm.tasks.get(&task_id) {
                    if matches!(task.status, DownloadStatus::Failed | DownloadStatus::Paused) {
                        return;
                    }
                }
            }
        }

        // Claim the task for this worker — bail if another worker already owns it.
        let (url, dest_path, partial_path, start_offset, _total_bytes) = {
            let mut dm = manager.write().await;
            let Some(task) = dm.tasks.get_mut(&task_id) else {
                return;
            };
            match task.status {
                DownloadStatus::Queued => {
                    task.status = DownloadStatus::Downloading;
                    task.downloaded_bytes = task.pause_offset;
                    (
                        task.download_url.clone(),
                        task.dest_path.clone(),
                        partial_download_path(&task.dest_path),
                        task.pause_offset,
                        task.total_bytes,
                    )
                }
                DownloadStatus::Downloading => {
                    log::warn!("[download] Worker skipped — task {} already downloading", task_id);
                    return;
                }
                _ => return,
            }
        };

        // Create parent directories
        if let Some(parent) = Path::new(&partial_path).parent() {
            if !parent.as_os_str().is_empty() {
                if let Err(e) = fs::create_dir_all(parent).await {
                    mark_failed(&manager, &task_id, format!("Failed to create directory: {}", e)).await;
                    return;
                }
            }
        }

        // Open partial file in append mode (for resume support)
        let mut file = match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&partial_path)
            .await
        {
            Ok(f) => f,
            Err(e) => {
                mark_failed(&manager, &task_id, format!("Failed to open file: {}", e)).await;
                return;
            }
        };

        // Build HTTP request with optional Range header for resume.
        // HF's /resolve/main/ returns 302 → signed CAS URL; follow redirects manually to preserve Range.
        let mut download_url = url.clone();
        let resp: reqwest::Response = loop {
            let mut req = base_client.get(&download_url);
            if start_offset > 0 {
                req = req.header(RANGE, format!("bytes={}-", start_offset));
            }

            let interim = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    mark_failed(&manager, &task_id, format!("Request failed: {}", e)).await;
                    return;
                }
            };

            let status = interim.status();
            if status == reqwest::StatusCode::MOVED_PERMANENTLY || status == reqwest::StatusCode::FOUND {
                if let Some(loc) = interim.headers().get(reqwest::header::LOCATION) {
                    if let Ok(loc_str) = loc.to_str() {
                        download_url = loc_str.to_string();
                        continue;
                    }
                }
            }

            break interim;
        };

        // Check response status for resume handling
        let status_code = resp.status();
        if start_offset > 0 && status_code.is_success() && status_code != reqwest::StatusCode::PARTIAL_CONTENT {
            // Server doesn't support range requests — truncate and restart from beginning
            drop(file);
            let _f = match tokio::fs::File::create(&partial_path).await {
                Ok(f) => f,
                Err(e) => {
                    mark_failed(&manager, &task_id, format!("Failed to reset file: {}", e)).await;
                    return;
                }
            };
            // Re-open fresh
            file = match OpenOptions::new()
                .create(true)
                .write(true)
                .truncate(true)
                .open(&partial_path)
                .await
            {
                Ok(f) => f,
                Err(e) => {
                    mark_failed(&manager, &task_id, format!("Failed to open file: {}", e)).await;
                    return;
                }
            };
        }

        if status_code != reqwest::StatusCode::OK && status_code != reqwest::StatusCode::PARTIAL_CONTENT {
            mark_failed(
                &manager,
                &task_id,
                format!("Unexpected status: {} {}", status_code.as_u16(), status_code.canonical_reason().unwrap_or("Unknown")),
            )
            .await;
            return;
        }

        // Stream the response body — batch chunks for throughput, update progress periodically.
        let mut stream = resp.bytes_stream();
        let mut speed_samples: Vec<(u128, u64)> = Vec::new();
        let mut last_speed: f64 = 0.0;
        let mut batch_bytes: u64 = 0;
        let mut progress_interval = tokio::time::interval(std::time::Duration::from_millis(PROGRESS_INTERVAL_MS));
        let mut stream_finished = false;

        loop {
            tokio::select! {
                _ = progress_interval.tick() => {
                    flush_download_progress(
                        &manager,
                        &task_id,
                        &mut batch_bytes,
                        &mut speed_samples,
                        &mut last_speed,
                    )
                    .await;

                    if should_stop_worker(&manager, &task_id).await {
                        let _ = file.flush().await;
                        finalize_paused_worker(&manager, &task_id).await;
                        return;
                    }
                }

                chunk_result = stream.next() => {
                    if should_stop_worker(&manager, &task_id).await {
                        flush_download_progress(
                            &manager,
                            &task_id,
                            &mut batch_bytes,
                            &mut speed_samples,
                            &mut last_speed,
                        )
                        .await;
                        let _ = file.flush().await;
                        finalize_paused_worker(&manager, &task_id).await;
                        return;
                    }

                    let chunk = match chunk_result {
                        Some(Ok(c)) => c,
                        None => {
                            stream_finished = true;
                            break;
                        }
                        Some(Err(e)) => {
                            mark_failed(&manager, &task_id, format!("Stream error: {}", e)).await;
                            return;
                        }
                    };

                    if let Err(e) = file.write_all(&chunk).await {
                        mark_failed(&manager, &task_id, format!("Write error: {}", e)).await;
                        return;
                    }
                    batch_bytes += chunk.len() as u64;
                }
            }
        }

        flush_download_progress(
            &manager,
            &task_id,
            &mut batch_bytes,
            &mut speed_samples,
            &mut last_speed,
        )
        .await;

        if should_stop_worker(&manager, &task_id).await {
            let _ = file.flush().await;
            finalize_paused_worker(&manager, &task_id).await;
            return;
        }

        if stream_finished {
            let _ = file.flush().await;
            mark_completed_worker(&manager, &task_id, &dest_path).await;
        }
    }
}

/// Flush batched bytes and update speed/ETA on the task.
async fn flush_download_progress(
    manager: &Arc<RwLock<DownloadManager>>,
    task_id: &str,
    batch_bytes: &mut u64,
    speed_samples: &mut Vec<(u128, u64)>,
    last_speed: &mut f64,
) {
    if *batch_bytes == 0 {
        return;
    }

    let now_ms = Utc::now().timestamp_millis() as u128;
    let mut dm = manager.write().await;
    let Some(task) = dm.tasks.get_mut(task_id) else {
        return;
    };

    task.downloaded_bytes += *batch_bytes;
    *batch_bytes = 0;

    speed_samples.push((now_ms, task.downloaded_bytes));
    if speed_samples.len() > SPEED_SAMPLE_COUNT {
        speed_samples.remove(0);
    }

    if speed_samples.len() >= 2 {
        let (t0, b0) = speed_samples[0];
        let (t1, b1) = *speed_samples.last().unwrap();
        let dt_sec = (t1 - t0) as f64 / 1000.0;
        if dt_sec > 0.01 {
            let raw_speed = (b1 - b0) as f64 / dt_sec;
            *last_speed = *last_speed * (1.0 - SPEED_SMOOTHING) + raw_speed * SPEED_SMOOTHING;
        }
    }

    task.speed_bps = *last_speed as u64;
    let remaining = task.total_bytes.saturating_sub(task.downloaded_bytes);
    task.eta_seconds = if task.speed_bps > 0 {
        (remaining as f64 / task.speed_bps as f64) as u64
    } else {
        0
    };
}

/// True when the worker should stop without marking the download complete.
async fn should_stop_worker(manager: &Arc<RwLock<DownloadManager>>, task_id: &str) -> bool {
    let dm = manager.read().await;
    matches!(
        dm.tasks.get(task_id).map(|t| &t.status),
        Some(DownloadStatus::Paused) | Some(DownloadStatus::Failed)
    )
}

/// Persist pause position after the worker stops early.
async fn finalize_paused_worker(manager: &Arc<RwLock<DownloadManager>>, task_id: &str) {
    let mut dm = manager.write().await;
    let Some(task) = dm.tasks.get_mut(task_id) else {
        return;
    };
    if matches!(task.status, DownloadStatus::Paused) {
        task.pause_offset = task.downloaded_bytes;
        task.speed_bps = 0;
        task.eta_seconds = 0;
    }
}

/// Mark a finished download complete and save HF metadata to the model cache.
async fn mark_completed_worker(
    manager: &Arc<RwLock<DownloadManager>>,
    task_id: &str,
    dest_path: &str,
) {
    let mut dm = manager.write().await;
    let Some(task) = dm.tasks.get_mut(task_id) else {
        return;
    };

    if !matches!(task.status, DownloadStatus::Downloading) {
        return;
    }

    if !download_bytes_complete(task.downloaded_bytes, task.total_bytes) {
        task.status = DownloadStatus::Failed;
        task.error = Some(format!(
            "Download incomplete: {}/{} bytes",
            task.downloaded_bytes, task.total_bytes
        ));
        task.speed_bps = 0;
        task.eta_seconds = 0;
        return;
    }

    let partial_path = partial_download_path(dest_path);
    if let Err(e) = std::fs::rename(&partial_path, dest_path) {
        task.status = DownloadStatus::Failed;
        task.error = Some(format!("Failed to finalize download: {}", e));
        task.speed_bps = 0;
        task.eta_seconds = 0;
        return;
    }

    task.status = DownloadStatus::Completed;
    task.speed_bps = 0;
    task.eta_seconds = 0;
    task.pause_offset = 0;

    let hf_model_id_for_cache = task.hf_model_id.clone();
    let hf_author_for_cache = task.hf_author.clone();
    let quant_type_for_cache = task.quant_type.clone();
    let total_bytes_for_cache = task.total_bytes;
    let lfs_oid = task.lfs_oid.clone();

    let repo_name = if let Some(pos) = hf_model_id_for_cache.find('/') {
        hf_model_id_for_cache[pos + 1..].to_string()
    } else {
        hf_model_id_for_cache.clone()
    };

    let hf_meta = crate::types::HfMetadata {
        hf_model_id: hf_model_id_for_cache,
        author: hf_author_for_cache,
        repo_name,
        tags: Vec::new(),
        downloads: 0,
        likes_count: 0,
        quant_type: quant_type_for_cache,
        file_size_bytes: total_bytes_for_cache,
        last_modified: String::new(),
        lfs_oid,
    };

    if let Err(e) = crate::model_cache::set_hf_metadata(dest_path, hf_meta) {
        log::warn!("[download] Failed to save HF metadata for {}: {}", dest_path, e);
    } else {
        log::info!("[download] HF metadata saved to cache for {}", dest_path);
    }

    log::info!("Download complete: {} -> {}", task_id, dest_path);
}

/// Mark a task as failed with an error message.
async fn mark_failed(manager: &Arc<RwLock<DownloadManager>>, task_id: &str, error_msg: String) {
    let mut dm = manager.write().await;
    if let Some(task) = dm.tasks.get_mut(task_id) {
        task.status = DownloadStatus::Failed;
        task.error = Some(error_msg);
        task.speed_bps = 0;
        task.eta_seconds = 0;
    }
}

/// Generate a unique task ID using microsecond timestamp.
fn generate_task_id() -> String {
    Utc::now().timestamp_micros().to_string()
}

/// True when the streamed byte count satisfies the declared file size.
fn download_bytes_complete(downloaded: u64, total: u64) -> bool {
    total == 0 || downloaded >= total
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn download_bytes_complete_allows_unknown_total() {
        assert!(download_bytes_complete(1024, 0));
    }

    #[test]
    fn partial_download_path_appends_suffix() {
        assert_eq!(
            partial_download_path("models/author/repo/model.gguf"),
            "models/author/repo/model.gguf.part"
        );
    }

    #[test]
    fn download_bytes_complete_requires_full_file_when_total_known() {
        assert!(!download_bytes_complete(100, 200));
        assert!(download_bytes_complete(200, 200));
        assert!(download_bytes_complete(250, 200));
    }

    #[test]
    fn pause_task_only_from_downloading() {
        let mut dm = DownloadManager::new();
        let task_id = "test-task".to_string();
        dm.tasks.insert(
            task_id.clone(),
            DownloadTask {
                id: task_id.clone(),
                hf_model_id: "author/model".to_string(),
                file_name: "model.gguf".to_string(),
                download_url: "https://huggingface.co/x".to_string(),
                total_bytes: 1000,
                downloaded_bytes: 400,
                status: DownloadStatus::Downloading,
                dest_path: "models/model.gguf".to_string(),
                speed_bps: 0,
                pause_offset: 0,
                error: None,
                eta_seconds: 0,
                hf_author: "author".to_string(),
                quant_type: "Q4_K_M".to_string(),
                lfs_oid: String::new(),
            },
        );

        dm.pause_task(&task_id).expect("pause should succeed");
        let task = dm.tasks.get(&task_id).unwrap();
        assert_eq!(task.status, DownloadStatus::Paused);
        assert_eq!(task.downloaded_bytes, 400);
    }

    #[test]
    fn in_progress_dest_paths_includes_active_tasks_only() {
        let mut dm = DownloadManager::new();
        dm.tasks.insert(
            "active".to_string(),
            DownloadTask {
                id: "active".to_string(),
                hf_model_id: "a/m".to_string(),
                file_name: "m.gguf".to_string(),
                download_url: "https://x".to_string(),
                total_bytes: 100,
                downloaded_bytes: 10,
                status: DownloadStatus::Downloading,
                dest_path: "models/m.gguf".to_string(),
                speed_bps: 0,
                pause_offset: 0,
                error: None,
                eta_seconds: 0,
                hf_author: "a".to_string(),
                quant_type: "Q4".to_string(),
                lfs_oid: String::new(),
            },
        );
        dm.tasks.insert(
            "done".to_string(),
            DownloadTask {
                id: "done".to_string(),
                hf_model_id: "a/m2".to_string(),
                file_name: "m2.gguf".to_string(),
                download_url: "https://x".to_string(),
                total_bytes: 100,
                downloaded_bytes: 100,
                status: DownloadStatus::Completed,
                dest_path: "models/m2.gguf".to_string(),
                speed_bps: 0,
                pause_offset: 0,
                error: None,
                eta_seconds: 0,
                hf_author: "a".to_string(),
                quant_type: "Q4".to_string(),
                lfs_oid: String::new(),
            },
        );

        let paths = dm.in_progress_dest_paths();
        assert_eq!(paths.len(), 1);
        assert!(paths.iter().any(|p| p.ends_with("models\\m.gguf") || p.ends_with("models/m.gguf")));
    }

    #[tokio::test]
    async fn resume_task_rejects_active_states() {
        let manager = Arc::new(RwLock::new(DownloadManager::new()));
        let task_id = "active-task".to_string();
        {
            let mut dm = manager.write().await;
            dm.tasks.insert(
                task_id.clone(),
                DownloadTask {
                    id: task_id.clone(),
                    hf_model_id: "author/model".to_string(),
                    file_name: "model.gguf".to_string(),
                    download_url: "https://huggingface.co/x".to_string(),
                    total_bytes: 1000,
                    downloaded_bytes: 400,
                    status: DownloadStatus::Downloading,
                    dest_path: "models/model.gguf".to_string(),
                    speed_bps: 0,
                    pause_offset: 0,
                    error: None,
                    eta_seconds: 0,
                    hf_author: "author".to_string(),
                    quant_type: "Q4_K_M".to_string(),
                    lfs_oid: String::new(),
                },
            );
        }

        let result = {
            let mut dm = manager.write().await;
            dm.resume_download(task_id, Arc::clone(&manager)).await
        };
        assert!(result.is_err());
    }
}
