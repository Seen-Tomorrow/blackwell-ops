//! Download manager — manages HF model downloads with pause/resume support.
//!
//! Stored as `Arc<RwLock<DownloadManager>>` in Tauri app state. Workers are spawned
//! by IPC commands and independently acquire the lock to update progress.

use std::collections::HashMap;
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

    /// Pause a running download. Sets status to Paused and saves current position as pause_offset.
    pub fn pause_task(&mut self, task_id: &str) -> Result<(), String> {
        match self.tasks.get_mut(task_id) {
            Some(task) => match task.status {
                DownloadStatus::Downloading => {
                    task.pause_offset = task.downloaded_bytes;
                    task.status = DownloadStatus::Paused;
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
                task.status = DownloadStatus::Failed;
                task.error = Some("Cancelled".to_string());

                // Remove partial file from disk
                if !dest.is_empty() && Path::new(&dest).exists() {
                    tokio::task::spawn_blocking(move || {
                        let _ = fs::remove_file(&dest);
                    });
                }

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
            Some(task) => {
                if matches!(task.status, DownloadStatus::Paused) {
                    // Reset pause_offset so the worker knows to use Range header
                    task.pause_offset = task.downloaded_bytes;
                    task.status = DownloadStatus::Queued;
                    task.error = None;

                    let worker_arc = self_arc;
                    tokio::spawn(async move {
                        Self::download_worker(task_id, worker_arc).await;
                    });

                    Ok(())
                } else {
                    Err(format!("Task {} is not paused (status: {:?})", task_id, task.status))
                }
            }
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

        // Mark as downloading and get task info
        let (url, dest_path, start_offset, total_bytes) = {
            let mut dm = manager.write().await;
            if let Some(task) = dm.tasks.get_mut(&task_id) {
                task.status = DownloadStatus::Downloading;
                task.downloaded_bytes = task.pause_offset;
                (
                    task.download_url.clone(),
                    task.dest_path.clone(),
                    task.pause_offset,
                    task.total_bytes,
                )
            } else {
                return;
            }
        };

        // Create parent directories
        if let Some(parent) = Path::new(&dest_path).parent() {
            if !parent.as_os_str().is_empty() {
                if let Err(e) = fs::create_dir_all(parent).await {
                    mark_failed(&manager, &task_id, format!("Failed to create directory: {}", e)).await;
                    return;
                }
            }
        }

        // Open file in append mode (for resume support)
        let mut file = match OpenOptions::new()
            .create(true)
            .append(true)
            .open(&dest_path)
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
            let mut f = match tokio::fs::File::create(&dest_path).await {
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
                .open(&dest_path)
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

        loop {
            tokio::select! {
                _ = progress_interval.tick() => {
                    // Periodic progress update + pause check
                    if batch_bytes > 0 {
                        let now_ms = Utc::now().timestamp_millis() as u128;
                        {
                            let mut dm = manager.write().await;
                            if let Some(task) = dm.tasks.get_mut(&task_id) {
                                task.downloaded_bytes += batch_bytes;
                                batch_bytes = 0;

                                speed_samples.push((now_ms, task.downloaded_bytes));
                                if speed_samples.len() > SPEED_SAMPLE_COUNT {
                                    speed_samples.remove(0);
                                }

                                if speed_samples.len() >= 2 {
                                    let (t0, b0) = speed_samples[0];
                                    let (t1, b1) = *speed_samples.last().unwrap();
                                    let dt_sec = (t1 - t0) as f64 / 1000.0;
                                    if dt_sec > 0.01 {
                                        let raw_speed = ((b1 - b0) as f64 / dt_sec);
                                        last_speed = last_speed * (1.0 - SPEED_SMOOTHING) + raw_speed * SPEED_SMOOTHING;
                                    }
                                }

                                task.speed_bps = last_speed as u64;
                                let remaining = task.total_bytes.saturating_sub(task.downloaded_bytes);
                                if task.speed_bps > 0 {
                                    task.eta_seconds = (remaining as f64 / task.speed_bps as f64) as u64;
                                } else {
                                    task.eta_seconds = 0;
                                }
                            }
                        }
                    }

                    // Check pause/cancel
                    {
                        let dm = manager.read().await;
                        if let Some(task) = dm.tasks.get(&task_id) {
                            match task.status {
                                DownloadStatus::Paused => break,
                                DownloadStatus::Failed => return,
                                _ => {}
                            }
                        }
                    }
                }

                chunk_result = stream.next() => {
                    let chunk = match chunk_result {
                        Some(Ok(c)) => c,
                        None => break, // Stream finished
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

        // Final progress update for any remaining batched bytes
        if batch_bytes > 0 {
            let mut dm = manager.write().await;
            if let Some(task) = dm.tasks.get_mut(&task_id) {
                task.downloaded_bytes += batch_bytes;
            }
        }

        // Mark as completed
        {
            let mut dm = manager.write().await;
            if let Some(task) = dm.tasks.get_mut(&task_id) {
                if !matches!(task.status, DownloadStatus::Failed) {
                    task.status = DownloadStatus::Completed;
                    task.speed_bps = 0;
                    task.eta_seconds = 0;
                    task.pause_offset = 0;

                    // Save HF metadata to unified cache
                    let dest_path_for_cache = task.dest_path.clone();
                    let hf_model_id_for_cache = task.hf_model_id.clone();
                    let hf_author_for_cache = task.hf_author.clone();
                    let quant_type_for_cache = task.quant_type.clone();
                    let total_bytes_for_cache = task.total_bytes;

                    // Derive repo name from HF model ID (author/repo → repo)
                    let repo_name = if let Some(pos) = hf_model_id_for_cache.find('/') {
                        hf_model_id_for_cache[pos+1..].to_string()
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
                        lfs_oid: task.lfs_oid.clone(),
                    };

                    if let Err(e) = crate::model_cache::set_hf_metadata(&dest_path_for_cache, hf_meta) {
                        log::warn!("[download] Failed to save HF metadata for {}: {}", dest_path_for_cache, e);
                    } else {
                        log::info!("[download] HF metadata saved to cache for {}", dest_path_for_cache);
                    }
                }
            }
        }

        log::info!("Download complete: {} -> {}", task_id, dest_path);
    }
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
