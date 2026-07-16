//! Download manager — manages HF model downloads with pause/resume support.
//!
//! Stored as `Arc<RwLock<DownloadManager>>` in Tauri app state. Workers are spawned
//! by IPC commands and independently acquire the lock to update progress.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;
use std::path::{Path, PathBuf};

use chrono::Utc;
use futures_util::StreamExt;
use reqwest::header::RANGE;
use serde::{Deserialize, Serialize};
use tokio::fs::{self, OpenOptions};
use tokio::io::AsyncWriteExt;
use tokio::sync::RwLock;
use crate::types::{
    DownloadStatus, DownloadTask, QuantBatchPart, QuantDownloadBatch, TASK_KIND_APP,
    TASK_KIND_HF, TASK_KIND_PROVIDER, TASK_KIND_TOOLCHAIN,
};

/// Persisted manifest entry — survives restart so we can recover orphaned .part files.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct ManifestEntry {
    /// Original task ID (microsecond timestamp).
    task_id: String,
    #[serde(rename = "hfModelId")]
    hf_model_id: String,
    file_name: String,
    download_url: String,
    total_bytes: u64,
    dest_path: String,
    #[serde(default)]
    hf_author: String,
    #[serde(rename = "quantType")]
    quant_type: String,
    #[serde(default, rename = "lfsOid")]
    lfs_oid: String,
    #[serde(default, skip_serializing_if = "Option::is_none", rename = "batchId")]
    batch_id: Option<String>,
    #[serde(default = "default_manifest_task_kind", rename = "taskKind")]
    task_kind: String,
}

fn default_manifest_task_kind() -> String {
    TASK_KIND_HF.to_string()
}

fn is_toolchain_task(task: &DownloadTask) -> bool {
    task.task_kind == TASK_KIND_TOOLCHAIN
}

fn is_app_task(task: &DownloadTask) -> bool {
    task.task_kind == TASK_KIND_APP
}

fn is_provider_task(task: &DownloadTask) -> bool {
    task.task_kind == TASK_KIND_PROVIDER
}

fn is_post_download_task(task: &DownloadTask) -> bool {
    is_toolchain_task(task) || is_app_task(task) || is_provider_task(task)
}

fn needs_github_auth(task: &DownloadTask) -> bool {
    is_toolchain_task(task) || is_app_task(task) || is_provider_task(task)
}

const MANIFEST_FILE: &str = "download_tasks.json";
const BATCHES_FILE: &str = "download_batches.json";

fn manifest_path() -> PathBuf {
    crate::config::cache_dir().join(MANIFEST_FILE)
}

/// Load the task manifest from disk.
fn load_manifest() -> HashMap<String, ManifestEntry> {
    let path = manifest_path();
    if !path.exists() {
        return HashMap::new();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

/// Save the task manifest to disk — atomic write via .tmp + rename to avoid corruption on crash.
fn save_manifest(manifest: &HashMap<String, ManifestEntry>) {
    let path = manifest_path();
    let tmp_path = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = match serde_json::to_string_pretty(manifest) {
        Ok(j) => j,
        Err(e) => {
            log::warn!("[download] Failed to serialize manifest: {}", e);
            return;
        }
    };
    // Write to .tmp first, then atomic rename — prevents truncated JSON on crash.
    if let Err(e) = std::fs::write(&tmp_path, json) {
        log::warn!("[download] Failed to write manifest temp: {}", e);
        return;
    }
    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        log::warn!("[download] Failed to rename manifest: {}", e);
        // Fallback: try to clean up tmp so it doesn't linger
        let _ = std::fs::remove_file(&tmp_path);
    }
}

/// Persist a task to the manifest for crash recovery.
fn persist_task_to_manifest(task: &DownloadTask) {
    let mut manifest = load_manifest();
    manifest.insert(task.id.clone(), ManifestEntry {
        task_id: task.id.clone(),
        hf_model_id: task.hf_model_id.clone(),
        file_name: task.file_name.clone(),
        download_url: task.download_url.clone(),
        total_bytes: task.total_bytes,
        dest_path: task.dest_path.clone(),
        hf_author: task.hf_author.clone(),
        quant_type: task.quant_type.clone(),
        lfs_oid: task.lfs_oid.clone(),
        batch_id: task.batch_id.clone(),
        task_kind: task.task_kind.clone(),
    });
    save_manifest(&manifest);
}

/// Remove a task from the manifest.
fn remove_task_from_manifest(task_id: &str) {
    let mut manifest = load_manifest();
    manifest.remove(task_id);
    save_manifest(&manifest);
}

fn batches_path() -> PathBuf {
    crate::config::cache_dir().join(BATCHES_FILE)
}

fn load_quant_batches() -> HashMap<String, QuantDownloadBatch> {
    let path = batches_path();
    if !path.exists() {
        return HashMap::new();
    }
    match std::fs::read_to_string(&path) {
        Ok(content) => serde_json::from_str(&content).unwrap_or_default(),
        Err(_) => HashMap::new(),
    }
}

fn save_quant_batches(batches: &HashMap<String, QuantDownloadBatch>) {
    let path = batches_path();
    let tmp_path = path.with_extension("json.tmp");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let json = match serde_json::to_string_pretty(batches) {
        Ok(j) => j,
        Err(e) => {
            log::warn!("[download] Failed to serialize batch manifest: {}", e);
            return;
        }
    };
    if let Err(e) = std::fs::write(&tmp_path, json) {
        log::warn!("[download] Failed to write batch manifest temp: {}", e);
        return;
    }
    if let Err(e) = std::fs::rename(&tmp_path, &path) {
        log::warn!("[download] Failed to rename batch manifest: {}", e);
        let _ = std::fs::remove_file(&tmp_path);
    }
}

fn remove_quant_batch(batch_id: &str) {
    let mut batches = load_quant_batches();
    if batches.remove(batch_id).is_some() {
        save_quant_batches(&batches);
    }
}

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
    /// Sharded quants — defer `.part` → `.gguf` until every part is complete.
    quant_batches: HashMap<String, QuantDownloadBatch>,
    /// Max concurrent downloads (default 3).
    max_concurrent: usize,
    /// App handle for App update apply / provider pack config activation after download.
    app_update_handle: Option<tauri::AppHandle>,
}

impl DownloadManager {
    pub fn new() -> Self {
        Self {
            tasks: HashMap::new(),
            quant_batches: load_quant_batches(),
            max_concurrent: DEFAULT_MAX_CONCURRENT,
            app_update_handle: None,
        }
    }

    /// Register a sharded quant batch (all expected dest paths, including already on disk).
    pub fn register_quant_batch(&mut self, batch: QuantDownloadBatch) {
        self.quant_batches.insert(batch.id.clone(), batch);
        save_quant_batches(&self.quant_batches);
    }

    /// Start a quant batch before enqueueing per-shard tasks.
    pub fn begin_quant_batch(
        &mut self,
        hf_model_id: String,
        hf_author: String,
        quant_type: String,
        parts: Vec<QuantBatchPart>,
    ) -> String {
        let batch_id = generate_task_id();
        self.register_quant_batch(QuantDownloadBatch {
            id: batch_id.clone(),
            hf_model_id,
            quant_type,
            hf_author,
            parts,
        });
        batch_id
    }

    /// Paths + shard-group keys to hide from catalog while downloads are active.
    pub fn catalog_scan_exclusions(&self) -> crate::model_catalog::CatalogScanExclusions {
        crate::model_catalog::catalog_exclusions_from_downloads(&self.tasks, &self.quant_batches)
    }

    /// Exclusions from on-disk manifests only — used when the manager write lock is held during recovery.
    pub fn catalog_exclusions_from_persisted() -> crate::model_catalog::CatalogScanExclusions {
        let mut dest_paths = HashSet::new();
        let mut shard_groups = HashSet::new();

        for entry in load_manifest().values() {
            let resolved = crate::config::resolve_path(&entry.dest_path)
                .to_string_lossy()
                .to_string();
            dest_paths.insert(resolved.clone());
            shard_groups.insert(crate::model_catalog::shard_group_key_from_path(&resolved));
        }

        for batch in load_quant_batches().values() {
            for part in &batch.parts {
                let resolved = crate::config::resolve_path(&part.dest_path)
                    .to_string_lossy()
                    .to_string();
                dest_paths.insert(resolved.clone());
                shard_groups.insert(crate::model_catalog::shard_group_key_from_path(&resolved));
            }
        }

        crate::model_catalog::CatalogScanExclusions {
            dest_paths,
            shard_groups,
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
        batch_id: Option<String>,
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
            batch_id,
            task_kind: TASK_KIND_HF.to_string(),
        };

        self.tasks.insert(task_id.clone(), task);

        // Persist to manifest for crash recovery
        let task_ref = self.tasks.get(&task_id).unwrap();
        persist_task_to_manifest(task_ref);

        let worker_arc = self_arc;
        let task_id_for_worker = task_id.clone();
        tokio::spawn(async move {
            Self::download_worker(task_id_for_worker, worker_arc).await;
        });

        Ok(task_id)
    }

    /// Enqueue a portable Foundry toolchain archive download.
    pub async fn start_toolchain_download(
        &mut self,
        pack: Option<String>,
        self_arc: Arc<RwLock<Self>>,
    ) -> Result<String, String> {
        if self.has_active_toolchain_download() {
            return Err("A toolchain download is already in progress.".into());
        }

        let pack_key = pack
            .unwrap_or_else(|| "full".to_string())
            .trim()
            .to_lowercase();

        if let Some(task_id) = self
            .tasks
            .iter()
            .find(|(_, t)| {
                is_toolchain_task(t)
                    && t.quant_type == pack_key
                    && t.status == DownloadStatus::Failed
            })
            .map(|(id, _)| id.clone())
        {
            self.resume_download(task_id.clone(), self_arc).await?;
            return Ok(task_id);
        }

        let stale_ids: Vec<String> = self
            .tasks
            .iter()
            .filter(|(_, t)| {
                is_toolchain_task(t)
                    && t.quant_type == pack_key
                    && matches!(t.status, DownloadStatus::Completed)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale_ids {
            self.tasks.remove(&id);
        }

        let (download_url, archive_name, total_bytes) =
            crate::foundry_toolchain::fetch_toolchain_asset(&pack_key).await?;
        let dest_path = crate::foundry_toolchain::toolchain_download_dest(&archive_name);

        if self.has_active_task_for_dest(&dest_path) {
            return Err("A download for this toolchain archive is already in progress.".into());
        }

        std::fs::create_dir_all(
            Path::new(&dest_path)
                .parent()
                .unwrap_or_else(|| Path::new(".")),
        )
        .map_err(|e| format!("Failed to create toolchain download dir: {}", e))?;

        let partial_path = partial_download_path(&dest_path);
        let resume_offset = std::fs::metadata(&partial_path)
            .ok()
            .map(|m| m.len())
            .unwrap_or(0);

        let task_id = generate_task_id();
        let task = DownloadTask {
            id: task_id.clone(),
            hf_model_id: crate::foundry_toolchain::toolchain_pack_label(&pack_key).to_string(),
            file_name: archive_name,
            download_url,
            total_bytes,
            downloaded_bytes: resume_offset,
            status: DownloadStatus::Queued,
            dest_path,
            speed_bps: 0,
            pause_offset: resume_offset,
            error: None,
            eta_seconds: 0,
            hf_author: String::new(),
            quant_type: pack_key,
            lfs_oid: String::new(),
            batch_id: None,
            task_kind: TASK_KIND_TOOLCHAIN.to_string(),
        };

        self.tasks.insert(task_id.clone(), task);
        let task_ref = self.tasks.get(&task_id).unwrap();
        persist_task_to_manifest(task_ref);

        let worker_arc = self_arc;
        let task_id_for_worker = task_id.clone();
        tokio::spawn(async move {
            Self::download_worker(task_id_for_worker, worker_arc).await;
        });

        Ok(task_id)
    }

    /// Re-run 7z extract from a cached or staged archive (no network download).
    pub async fn retry_toolchain_extract(
        &mut self,
        pack: Option<String>,
        self_arc: Arc<RwLock<Self>>,
    ) -> Result<String, String> {
        if self.has_active_toolchain_download() {
            return Err("A toolchain download or extract is already in progress.".into());
        }

        let pack_key = pack
            .unwrap_or_else(|| "full".to_string())
            .trim()
            .to_lowercase();
        let archive_path = crate::foundry_toolchain::archive_for_reextract(&pack_key)?;
        let archive_name = crate::foundry_toolchain::pack_archive_name(&pack_key)?;
        let archive_str = archive_path.to_string_lossy().to_string();
        let size = std::fs::metadata(&archive_path)
            .ok()
            .map(|m| m.len())
            .unwrap_or(0);

        let stale_ids: Vec<String> = self
            .tasks
            .iter()
            .filter(|(_, t)| {
                is_toolchain_task(t)
                    && t.quant_type == pack_key
                    && matches!(
                        t.status,
                        DownloadStatus::Completed | DownloadStatus::Failed
                    )
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale_ids {
            self.tasks.remove(&id);
        }

        let task_id = generate_task_id();
        let task = DownloadTask {
            id: task_id.clone(),
            hf_model_id: crate::foundry_toolchain::toolchain_pack_label(&pack_key).to_string(),
            file_name: archive_name.to_string(),
            download_url: String::new(),
            total_bytes: size,
            downloaded_bytes: size,
            status: DownloadStatus::Scanning,
            dest_path: crate::foundry_toolchain::toolchain_download_dest(archive_name),
            speed_bps: 0,
            pause_offset: 0,
            error: Some("Extracting toolchain…".to_string()),
            eta_seconds: 0,
            hf_author: String::new(),
            quant_type: pack_key.clone(),
            lfs_oid: String::new(),
            batch_id: None,
            task_kind: TASK_KIND_TOOLCHAIN.to_string(),
        };
        self.tasks.insert(task_id.clone(), task);

        let manager_arc = self_arc;
        let tid = task_id.clone();
        tokio::spawn(async move {
            finalize_toolchain_extract_worker(&manager_arc, &tid, &archive_str).await;
        });

        Ok(task_id)
    }

    /// True when any toolchain task is queued, downloading, paused, or extracting.
    pub fn has_active_toolchain_download(&self) -> bool {
        self.tasks.values().any(|t| {
            is_toolchain_task(t)
                && matches!(
                    t.status,
                    DownloadStatus::Queued
                        | DownloadStatus::Downloading
                        | DownloadStatus::Paused
                        | DownloadStatus::Scanning
                )
        })
    }

    /// True when an app NSIS installer download or install is in progress.
    pub fn has_active_app_update_download(&self) -> bool {
        self.tasks.values().any(|t| {
            is_app_task(t)
                && matches!(
                    t.status,
                    DownloadStatus::Queued
                        | DownloadStatus::Downloading
                        | DownloadStatus::Paused
                        | DownloadStatus::Scanning
                )
        })
    }

    /// Enqueue download of an App `.7z` or Full Bundle NSIS (`app_only` | `full_bundle`).
    pub async fn start_app_update_download(
        &mut self,
        app_handle: tauri::AppHandle,
        channel: String,
        current_version: String,
        self_arc: Arc<RwLock<Self>>,
    ) -> Result<String, String> {
        if self.has_active_app_update_download() {
            return Err("An app update download is already in progress.".into());
        }

        let (download_url, installer_name, release_tag, total_bytes) =
            crate::github_releases::resolve_installer_asset_for_version(&channel, &current_version)
                .await?;

        let dest_dir = crate::github_releases::app_update_cache_dir();
        std::fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("Failed to create app update cache dir: {e}"))?;
        let dest_path = dest_dir.join(&installer_name);
        let dest_path_str = dest_path.to_string_lossy().to_string();

        if self.has_active_task_for_dest(&dest_path_str) {
            return Err("An app update download for this installer is already in progress.".into());
        }

        let stale_ids: Vec<String> = self
            .tasks
            .iter()
            .filter(|(_, t)| {
                is_app_task(t)
                    && matches!(t.status, DownloadStatus::Completed | DownloadStatus::Failed)
            })
            .map(|(id, _)| id.clone())
            .collect();
        for id in stale_ids {
            self.tasks.remove(&id);
        }

        let partial_path = partial_download_path(&dest_path_str);
        let resume_offset = std::fs::metadata(&partial_path)
            .ok()
            .map(|m| m.len())
            .unwrap_or(0);

        let task_id = generate_task_id();
        let channel_label = if channel == crate::github_releases::CHANNEL_FULL_BUNDLE {
            "Full install"
        } else {
            "App update"
        };
        let task = DownloadTask {
            id: task_id.clone(),
            hf_model_id: format!("Blackwell Ops {channel_label} {release_tag}"),
            file_name: installer_name,
            download_url,
            total_bytes,
            downloaded_bytes: resume_offset,
            status: DownloadStatus::Queued,
            dest_path: dest_path_str,
            speed_bps: 0,
            pause_offset: resume_offset,
            error: None,
            eta_seconds: 0,
            hf_author: String::new(),
            quant_type: channel,
            lfs_oid: String::new(),
            batch_id: None,
            task_kind: TASK_KIND_APP.to_string(),
        };

        self.app_update_handle = Some(app_handle);
        self.tasks.insert(task_id.clone(), task);
        let task_ref = self.tasks.get(&task_id).unwrap();
        persist_task_to_manifest(task_ref);

        let worker_arc = self_arc;
        let task_id_for_worker = task_id.clone();
        tokio::spawn(async move {
            Self::download_worker(task_id_for_worker, worker_arc).await;
        });

        Ok(task_id)
    }

    /// True when a provider pack download/extract is active.
    pub fn has_active_provider_download(&self, provider_id: &str, profile: &str) -> bool {
        let key = format!("{provider_id}:{profile}");
        self.tasks.values().any(|t| {
            is_provider_task(t)
                && t.quant_type == key
                && matches!(
                    t.status,
                    DownloadStatus::Queued
                        | DownloadStatus::Downloading
                        | DownloadStatus::Paused
                        | DownloadStatus::Scanning
                )
        })
    }

    /// Enqueue provider runtime pack (`{provider}-{profile}.7z`) from the latest release that has it.
    pub async fn start_provider_pack_download(
        &mut self,
        app_handle: tauri::AppHandle,
        provider_id: String,
        profile: String,
        self_arc: Arc<RwLock<Self>>,
    ) -> Result<String, String> {
        if self.has_active_provider_download(&provider_id, &profile) {
            return Err(format!(
                "A download for {provider_id}/{profile} is already in progress."
            ));
        }

        let (download_url, asset_name, release_tag, total_bytes) =
            crate::github_releases::resolve_provider_pack_asset(&provider_id, &profile).await?;

        let dest_dir = crate::github_releases::provider_pack_cache_dir();
        std::fs::create_dir_all(&dest_dir)
            .map_err(|e| format!("Failed to create provider pack cache: {e}"))?;
        let dest_path = dest_dir.join(&asset_name);
        let dest_path_str = dest_path.to_string_lossy().to_string();

        if self.has_active_task_for_dest(&dest_path_str) {
            return Err("This provider pack is already downloading.".into());
        }

        let partial_path = partial_download_path(&dest_path_str);
        let resume_offset = std::fs::metadata(&partial_path)
            .ok()
            .map(|m| m.len())
            .unwrap_or(0);

        let task_id = generate_task_id();
        let quant_key = format!("{provider_id}:{profile}");
        let task = DownloadTask {
            id: task_id.clone(),
            hf_model_id: format!("Engine {provider_id} [{profile}] {release_tag}"),
            file_name: asset_name,
            download_url,
            total_bytes,
            downloaded_bytes: resume_offset,
            status: DownloadStatus::Queued,
            dest_path: dest_path_str,
            speed_bps: 0,
            pause_offset: resume_offset,
            error: None,
            eta_seconds: 0,
            hf_author: provider_id,
            quant_type: quant_key,
            lfs_oid: release_tag,
            batch_id: None,
            task_kind: TASK_KIND_PROVIDER.to_string(),
        };

        self.app_update_handle = Some(app_handle);
        self.tasks.insert(task_id.clone(), task);
        let task_ref = self.tasks.get(&task_id).unwrap();
        persist_task_to_manifest(task_ref);

        let worker_arc = self_arc;
        let task_id_for_worker = task_id.clone();
        tokio::spawn(async move {
            Self::download_worker(task_id_for_worker, worker_arc).await;
        });

        Ok(task_id)
    }

    /// Scan persisted manifest for orphaned `.part` files — safe on a blocking thread (may stat large files).
    pub fn gather_recovered_tasks() -> Vec<DownloadTask> {
        let manifest = load_manifest();
        if manifest.is_empty() {
            return Vec::new();
        }
        log::info!(
            "[download] Checking {} manifest entries for recoverable .part files",
            manifest.len()
        );

        let mut recovered = Vec::new();
        let mut stale = 0usize;

        for (task_id, entry) in manifest {
            let partial_path = partial_download_path(&entry.dest_path);
            if !Path::new(&partial_path).exists() {
                stale += 1;
                continue;
            }

            let part_size = std::fs::metadata(&partial_path)
                .ok()
                .map(|m| m.len())
                .unwrap_or(0);

            log::info!(
                "[download] Recovering .part file: {} ({} bytes)",
                partial_path,
                part_size
            );

            recovered.push(DownloadTask {
                id: task_id.clone(),
                hf_model_id: entry.hf_model_id,
                file_name: entry.file_name,
                download_url: entry.download_url,
                total_bytes: entry.total_bytes,
                downloaded_bytes: part_size,
                status: DownloadStatus::Paused,
                dest_path: entry.dest_path,
                speed_bps: 0,
                pause_offset: part_size,
                error: None,
                eta_seconds: 0,
                hf_author: entry.hf_author,
                quant_type: entry.quant_type,
                lfs_oid: entry.lfs_oid,
                batch_id: entry.batch_id,
                task_kind: entry.task_kind,
            });
        }

        if !recovered.is_empty() {
            log::info!(
                "[download] Gathered {} recoverable download(s) ({} stale manifest entries discarded)",
                recovered.len(),
                stale
            );
        }
        recovered
    }

    /// Insert tasks gathered by [`Self::gather_recovered_tasks`] — keep lock hold minimal.
    pub fn insert_recovered_tasks(&mut self, tasks: Vec<DownloadTask>) {
        if tasks.is_empty() {
            return;
        }
        let count = tasks.len();
        for task in tasks {
            self.tasks.insert(task.id.clone(), task);
        }
        log::info!("[download] Recovered {} orphaned download(s) into queue", count);
    }

    /// After recovery or when all batch parts finish — rename `.part` → `.gguf` together.
    pub fn try_finalize_pending_batches(&mut self) {
        let batch_ids: Vec<String> = self.quant_batches.keys().cloned().collect();
        for batch_id in batch_ids {
            if let Err(e) = try_finalize_quant_batch_sync(self, &batch_id) {
                log::debug!("[download] Batch {} not ready to finalize: {}", batch_id, e);
            }
        }
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

                // Manifest cleanup — spawned off blocking pool to avoid stalling IPC handler.
                let tid = task_id.to_string();
                std::thread::spawn(move || {
                    remove_task_from_manifest(&tid);
                });

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

                    // Persist for recovery
                    persist_task_to_manifest(task);

                    let worker_arc = self_arc;
                    tokio::spawn(async move {
                        Self::download_worker(task_id, worker_arc).await;
                    });

                    Ok(())
                }
                DownloadStatus::Failed if is_post_download_task(task) => {
                    let partial = partial_download_path(&task.dest_path);
                    let file_len = std::fs::metadata(&partial)
                        .ok()
                        .map(|m| m.len())
                        .unwrap_or(0);
                    if task.downloaded_bytes == 0 && file_len == 0 {
                        return Err(format!(
                            "Task {} has no partial data to resume (status: Failed)",
                            task_id
                        ));
                    }
                    task.downloaded_bytes = task.downloaded_bytes.max(file_len);
                    task.pause_offset = task.downloaded_bytes;
                    task.status = DownloadStatus::Queued;
                    task.error = None;
                    task.speed_bps = 0;
                    task.eta_seconds = 0;
                    persist_task_to_manifest(task);

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

            // In-memory removal under lock.
            for id in &to_remove {
                self.tasks.remove(id);
            }

            // Manifest cleanup — batch outside lock on blocking pool.
            let ids = to_remove.clone();
            std::thread::spawn(move || {
                for id in &ids {
                    remove_task_from_manifest(id);
                }
            });
        }
    }

    /// Get the count of currently downloading tasks.
    pub fn active_download_count(&self) -> usize {
        self.tasks
            .values()
            .filter(|t| matches!(t.status, DownloadStatus::Downloading))
            .count()
    }

    /// True when the same resolved destination already has a queued/active/paused task.
    pub fn has_active_task_for_dest(&self, dest_path: &str) -> bool {
        let target = crate::config::resolve_path(dest_path)
            .to_string_lossy()
            .to_string();
        if target.is_empty() {
            return false;
        }
        self.tasks.values().any(|t| {
            matches!(
                t.status,
                DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Paused
            ) && {
                let existing = crate::config::resolve_path(&t.dest_path)
                    .to_string_lossy()
                    .to_string();
                !existing.is_empty() && existing == target
            }
        })
    }

    /// Resolved final paths for queued/active/paused tasks — hide from model catalog until complete.
    #[allow(dead_code)]
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
        let (url, dest_path, partial_path, start_offset, _total_bytes, use_github_auth) = {
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
                        needs_github_auth(task),
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
            if use_github_auth {
                req = crate::github_releases::apply_github_auth(req);
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
                        None => break,
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

        let _ = file.flush().await;
        mark_completed_worker(&manager, &task_id, &dest_path).await;
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

fn batch_has_in_flight(dm: &DownloadManager, batch_id: &str) -> bool {
    dm.tasks.values().any(|t| {
        t.batch_id.as_deref() == Some(batch_id)
            && matches!(
                t.status,
                DownloadStatus::Queued | DownloadStatus::Downloading | DownloadStatus::Paused
            )
    })
}

fn part_bytes_ready(dest_path: &str, expected_size: u64, lfs_oid: &str) -> bool {
    if crate::config::quant_part_already_downloaded(dest_path, expected_size, lfs_oid) {
        return true;
    }
    let partial = partial_download_path(dest_path);
    let Ok(meta) = std::fs::metadata(&partial) else {
        return false;
    };
    download_bytes_complete(meta.len(), expected_size)
}

fn save_hf_metadata_for_part(
    dest_path: &str,
    hf_model_id: &str,
    hf_author: &str,
    quant_type: &str,
    total_bytes: u64,
    lfs_oid: &str,
) {
    let repo_name = hf_model_id
        .find('/')
        .map(|pos| hf_model_id[pos + 1..].to_string())
        .unwrap_or_else(|| hf_model_id.to_string());
    let hf_meta = crate::types::HfMetadata {
        hf_model_id: hf_model_id.to_string(),
        author: hf_author.to_string(),
        repo_name,
        tags: Vec::new(),
        downloads: 0,
        likes_count: 0,
        quant_type: quant_type.to_string(),
        file_size_bytes: total_bytes,
        last_modified: String::new(),
        lfs_oid: lfs_oid.to_string(),
    };
    if let Err(e) = crate::model_cache::set_hf_metadata(dest_path, hf_meta) {
        log::warn!("[download] Failed to save HF metadata for {}: {}", dest_path, e);
    }
}

fn finalize_part_on_disk(part: &QuantBatchPart, batch: &QuantDownloadBatch) -> Result<(), String> {
    if crate::config::quant_part_already_downloaded(&part.dest_path, part.total_bytes, &part.lfs_oid) {
        return Ok(());
    }

    let partial = partial_download_path(&part.dest_path);
    if !Path::new(&partial).exists() {
        return Err(format!("Missing partial file: {}", partial));
    }

    if Path::new(&part.dest_path).exists() {
        log::info!("[download] Replacing existing model: {}", part.dest_path);
        if let Err(e) = std::fs::remove_file(&part.dest_path) {
            log::warn!("[download] Failed to remove existing model {}: {}", part.dest_path, e);
        }
    }

    std::fs::rename(&partial, &part.dest_path)
        .map_err(|e| format!("Failed to finalize {}: {}", part.dest_path, e))?;

    save_hf_metadata_for_part(
        &part.dest_path,
        &batch.hf_model_id,
        &batch.hf_author,
        &batch.quant_type,
        part.total_bytes,
        &part.lfs_oid,
    );
    log::info!("[download] Finalized shard: {}", part.dest_path);
    Ok(())
}

fn try_finalize_quant_batch_sync(dm: &mut DownloadManager, batch_id: &str) -> Result<(), String> {
    let batch = dm
        .quant_batches
        .get(batch_id)
        .cloned()
        .ok_or_else(|| "batch not found".to_string())?;

    if batch.parts.len() > 1 && batch_has_in_flight(dm, batch_id) {
        return Err("sibling shards still downloading".to_string());
    }

    if !batch
        .parts
        .iter()
        .all(|p| part_bytes_ready(&p.dest_path, p.total_bytes, &p.lfs_oid))
    {
        return Err("not all shard parts ready".to_string());
    }

    for part in &batch.parts {
        finalize_part_on_disk(part, &batch)?;
    }

    dm.quant_batches.remove(batch_id);
    remove_quant_batch(batch_id);
    log::info!(
        "[download] Finalized sharded quant batch {} ({} part(s))",
        batch_id,
        batch.parts.len()
    );
    Ok(())
}

/// Mark a finished download complete — sharded quants keep `.part` until the full batch is ready.
async fn mark_completed_worker(
    manager: &Arc<RwLock<DownloadManager>>,
    task_id: &str,
    dest_path: &str,
) {
    let (batch_id, is_toolchain, is_app) = {
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
            remove_task_from_manifest(task_id);
            return;
        }

        let toolchain = is_toolchain_task(task);
        let app = is_app_task(task);
        if !toolchain && !app {
            task.status = DownloadStatus::Completed;
        }
        task.speed_bps = 0;
        task.eta_seconds = 0;
        task.pause_offset = 0;
        (task.batch_id.clone(), toolchain, app)
    };

    if !is_toolchain && !is_app {
        remove_task_from_manifest(task_id);
    }

    if let Some(batch_id) = batch_id {
        let mut dm = manager.write().await;
        match try_finalize_quant_batch_sync(&mut dm, &batch_id) {
            Ok(()) => log::info!("[download] Batch {} finalized after {}", batch_id, dest_path),
            Err(e) => log::info!(
                "[download] Shard complete, batch {} waiting: {} ({})",
                batch_id,
                dest_path,
                e
            ),
        }
        return;
    }

    // Single-file download — rename immediately.
    let partial_path = partial_download_path(dest_path);
    let dest_to_rename = dest_path.to_string();
    let task_id_for_finalization = task_id.to_string();

    if Path::new(&dest_to_rename).exists() {
        log::info!("[download] Replacing existing file: {}", dest_to_rename);
        if let Err(e) = std::fs::remove_file(&dest_to_rename) {
            log::warn!("[download] Failed to remove existing file {}: {}", dest_to_rename, e);
        }
    }

    if let Err(e) = std::fs::rename(&partial_path, &dest_to_rename) {
        let mut dm = manager.write().await;
        if let Some(task) = dm.tasks.get_mut(&task_id_for_finalization) {
            task.status = DownloadStatus::Failed;
            task.error = Some(format!("Failed to finalize download: {}", e));
            task.speed_bps = 0;
            task.eta_seconds = 0;
        }
        return;
    }

    if is_toolchain {
        {
            let mut dm = manager.write().await;
            if let Some(task) = dm.tasks.get_mut(&task_id_for_finalization) {
                task.status = DownloadStatus::Scanning;
                task.speed_bps = 0;
                task.eta_seconds = 0;
                task.error = Some("Extracting toolchain…".to_string());
            }
        }
        remove_task_from_manifest(&task_id_for_finalization);
        let manager_arc = Arc::clone(manager);
        let archive = dest_to_rename.clone();
        tokio::spawn(async move {
            finalize_toolchain_extract_worker(&manager_arc, &task_id_for_finalization, &archive).await;
        });
        return;
    }

    if is_app {
        let is_7z = dest_to_rename.to_ascii_lowercase().ends_with(".7z");
        {
            let mut dm = manager.write().await;
            if let Some(task) = dm.tasks.get_mut(&task_id_for_finalization) {
                task.status = DownloadStatus::Scanning;
                task.speed_bps = 0;
                task.eta_seconds = 0;
                task.error = Some(if is_7z {
                    "Applying portable app update…".to_string()
                } else {
                    "Launching NSIS installer…".to_string()
                });
            }
        }
        remove_task_from_manifest(&task_id_for_finalization);
        let manager_arc = Arc::clone(manager);
        let installer = dest_to_rename.clone();
        tokio::spawn(async move {
            finalize_app_install_worker(&manager_arc, &task_id_for_finalization, &installer).await;
        });
        return;
    }

    let is_provider = {
        let dm = manager.read().await;
        dm.tasks
            .get(&task_id_for_finalization)
            .map(is_provider_task)
            .unwrap_or(false)
    };
    if is_provider {
        {
            let mut dm = manager.write().await;
            if let Some(task) = dm.tasks.get_mut(&task_id_for_finalization) {
                task.status = DownloadStatus::Scanning;
                task.speed_bps = 0;
                task.eta_seconds = 0;
                task.error = Some("Extracting engine pack…".to_string());
            }
        }
        remove_task_from_manifest(&task_id_for_finalization);
        let manager_arc = Arc::clone(manager);
        let archive = dest_to_rename.clone();
        tokio::spawn(async move {
            finalize_provider_pack_worker(&manager_arc, &task_id_for_finalization, &archive).await;
        });
        return;
    }

    let dm_snapshot = manager.read().await;
    let cache_data = dm_snapshot.tasks.get(&task_id_for_finalization).map(|t| {
        (
            t.hf_model_id.clone(),
            t.hf_author.clone(),
            t.quant_type.clone(),
            t.total_bytes,
            t.lfs_oid.clone(),
        )
    });
    drop(dm_snapshot);

    if let Some((hf_model_id, hf_author, quant_type, total_bytes, lfs_oid)) = cache_data {
        save_hf_metadata_for_part(
            &dest_to_rename,
            &hf_model_id,
            &hf_author,
            &quant_type,
            total_bytes,
            &lfs_oid,
        );
    }

    log::info!("Download complete: {} -> {}", task_id_for_finalization, dest_to_rename);
}

async fn finalize_app_install_worker(
    manager: &Arc<RwLock<DownloadManager>>,
    task_id: &str,
    installer_path: &str,
) {
    let app_handle = {
        let mut dm = manager.write().await;
        dm.app_update_handle.take()
    };

    let path = Path::new(installer_path);
    let is_7z = installer_path.to_ascii_lowercase().ends_with(".7z");

    let result = match app_handle {
        Some(handle) if is_7z => {
            crate::github_releases::apply_app_update_archive(path, &handle)
        }
        Some(handle) => crate::github_releases::launch_nsis_installer(path, &handle),
        None => Err("App update session lost — restart download.".to_string()),
    };

    let mut dm = manager.write().await;
    let Some(task) = dm.tasks.get_mut(task_id) else {
        return;
    };

    match result {
        Ok(()) => {
            task.status = DownloadStatus::Completed;
            task.error = Some(if is_7z {
                "App update applied — restarting…".to_string()
            } else {
                "Installer launched — app will restart.".to_string()
            });
            log::info!("[download] App update applied: {task_id} (7z={is_7z})");
        }
        Err(e) => {
            task.status = DownloadStatus::Failed;
            task.error = Some(e);
            log::warn!(
                "[download] App install failed for {task_id}: {}",
                task.error.as_deref().unwrap_or("")
            );
        }
    }
    task.speed_bps = 0;
    task.eta_seconds = 0;
}

async fn finalize_provider_pack_worker(
    manager: &Arc<RwLock<DownloadManager>>,
    task_id: &str,
    archive_path: &str,
) {
    let (provider_id, profile, release_tag, app_handle) = {
        let dm = manager.read().await;
        let handle = dm.app_update_handle.clone();
        match dm.tasks.get(task_id) {
            Some(t) => {
                let mut parts = t.quant_type.splitn(2, ':');
                let p = parts.next().unwrap_or("").to_string();
                let prof = parts.next().unwrap_or("").to_string();
                (p, prof, t.lfs_oid.clone(), handle)
            }
            None => {
                return;
            }
        }
    };

    let archive = PathBuf::from(archive_path);
    let provider_for_extract = provider_id.clone();
    let profile_for_extract = profile.clone();
    let apply_result = tokio::task::spawn_blocking(move || {
        crate::github_releases::apply_provider_pack_archive(
            &archive,
            &provider_for_extract,
            &profile_for_extract,
        )
    })
    .await;

    let mut dm = manager.write().await;
    let Some(task) = dm.tasks.get_mut(task_id) else {
        return;
    };

    match apply_result {
        Ok(Ok(server)) => {
            let activate = match &app_handle {
                Some(handle) => crate::binary_update::activate_provider_pack(
                    handle,
                    &provider_id,
                    &profile,
                    &server,
                    &release_tag,
                ),
                None => Err("App session lost — restart provider download.".into()),
            };
            match activate {
                Ok(()) => {
                    task.status = DownloadStatus::Completed;
                    task.error = Some(format!("Installed {provider_id}/{profile}"));
                    log::info!("[download] Provider pack installed: {task_id}");
                    crate::ipc_meter::emit_tracked(
                        app_handle.as_ref().unwrap(),
                        "binary-update:download-complete",
                        &crate::binary_update::BinaryUpdateEvent {
                            provider_id: provider_id.clone(),
                            profile: profile.clone(),
                            status: "complete".to_string(),
                            message: format!("Updated {provider_id}/{profile}"),
                        },
                    );
                }
                Err(e) => {
                    task.status = DownloadStatus::Failed;
                    task.error = Some(e);
                }
            }
        }
        Ok(Err(e)) => {
            task.status = DownloadStatus::Failed;
            task.error = Some(e);
        }
        Err(e) => {
            task.status = DownloadStatus::Failed;
            task.error = Some(format!("Provider extract task failed: {e}"));
        }
    }
    task.speed_bps = 0;
    task.eta_seconds = 0;
}

async fn finalize_toolchain_extract_worker(
    manager: &Arc<RwLock<DownloadManager>>,
    task_id: &str,
    archive_path: &str,
) {
    let pack = {
        let dm = manager.read().await;
        dm.tasks
            .get(task_id)
            .map(|t| t.quant_type.clone())
            .unwrap_or_else(|| "full".to_string())
    };
    let archive = archive_path.to_string();
    let result = tokio::task::spawn_blocking(move || {
        crate::foundry_toolchain::finalize_toolchain_install(Path::new(&archive), &pack)
    })
    .await;

    let mut dm = manager.write().await;
    let Some(task) = dm.tasks.get_mut(task_id) else {
        return;
    };

    match result {
        Ok(Ok(())) => {
            task.status = DownloadStatus::Completed;
            task.error = None;
            log::info!("[download] Toolchain install complete: {}", task_id);
        }
        Ok(Err(e)) => {
            task.status = DownloadStatus::Failed;
            task.error = Some(e);
            log::warn!("[download] Toolchain extraction failed for {}: {}", task_id, task.error.as_deref().unwrap_or(""));
        }
        Err(e) => {
            task.status = DownloadStatus::Failed;
            task.error = Some(format!("Extraction task panicked: {}", e));
        }
    }
    task.speed_bps = 0;
    task.eta_seconds = 0;
}

/// Mark a task as failed with an error message.
async fn mark_failed(manager: &Arc<RwLock<DownloadManager>>, task_id: &str, error_msg: String) {
    let keep_manifest = {
        let dm = manager.read().await;
        dm.tasks
            .get(task_id)
            .map(is_post_download_task)
            .unwrap_or(false)
    };

    // Phase 1: Update in-memory state under lock — minimal hold.
    {
        let mut dm = manager.write().await;
        if let Some(task) = dm.tasks.get_mut(task_id) {
            task.status = DownloadStatus::Failed;
            task.error = Some(error_msg);
            task.speed_bps = 0;
            task.eta_seconds = 0;
            if keep_manifest {
                persist_task_to_manifest(task);
            }
        }
    }

    // Phase 2: Manifest cleanup — outside lock, on blocking pool to avoid stalling tokio workers.
    if !keep_manifest {
        let tid = task_id.to_string();
        tokio::task::spawn_blocking(move || {
            remove_task_from_manifest(&tid);
        });
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
                batch_id: None,
                task_kind: TASK_KIND_HF.to_string(),
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
                batch_id: None,
                task_kind: TASK_KIND_HF.to_string(),
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
                batch_id: None,
                task_kind: TASK_KIND_HF.to_string(),
            },
        );

        let paths = dm.in_progress_dest_paths();
        assert_eq!(paths.len(), 1);
        assert!(paths.iter().any(|p| p.ends_with("models\\m.gguf") || p.ends_with("models/m.gguf")));
    }

    #[test]
    fn has_active_task_for_dest_matches_resolved_paths() {
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
                batch_id: None,
                task_kind: TASK_KIND_HF.to_string(),
            },
        );

        assert!(dm.has_active_task_for_dest("models/m.gguf"));
        assert!(!dm.has_active_task_for_dest("models/other.gguf"));
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
                    batch_id: None,
                    task_kind: TASK_KIND_HF.to_string(),
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
