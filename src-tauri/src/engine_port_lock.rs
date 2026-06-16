//! Per-port lock files — record engines we spawned so launch can reclaim only our orphans.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EnginePortLock {
    pub engine_pid: u32,
    pub owner_app_pid: u32,
    pub binary_path: String,
    pub reserved_at: String,
}

fn locks_dir() -> PathBuf {
    crate::config::app_root_dir()
        .join("config")
        .join("engine-locks")
}

fn lock_file(port: u16) -> PathBuf {
    locks_dir().join(format!("{port}.json"))
}

pub fn write_lock(port: u16, engine_pid: u32, binary_path: &Path) -> Result<(), String> {
    if port == 0 {
        return Ok(());
    }
    std::fs::create_dir_all(locks_dir()).map_err(|e| e.to_string())?;
    let lock = EnginePortLock {
        engine_pid,
        owner_app_pid: std::process::id(),
        binary_path: crate::config::to_relative_path(&binary_path.to_path_buf()),
        reserved_at: chrono::Utc::now().to_rfc3339(),
    };
    let json = serde_json::to_string_pretty(&lock).map_err(|e| e.to_string())?;
    std::fs::write(lock_file(port), json).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn delete_lock(port: u16) {
    if port == 0 {
        return;
    }
    let _ = std::fs::remove_file(lock_file(port));
}

fn read_lock(port: u16) -> Option<EnginePortLock> {
    let data = std::fs::read_to_string(lock_file(port)).ok()?;
    serde_json::from_str(&data).ok()
}

/// Remove lock files left after engine/app crashes (engine dead and/or port free).
pub async fn sweep_stale_locks() {
    let dir = locks_dir();
    let Ok(entries) = std::fs::read_dir(&dir) else {
        return;
    };

    let mut removed = 0usize;
    for entry in entries.flatten() {
        let path = entry.path();
        let Some(port) = path
            .file_stem()
            .and_then(|s| s.to_str())
            .and_then(|s| s.parse::<u16>().ok())
        else {
            continue;
        };

        let Some(lock) = read_lock(port) else {
            let _ = std::fs::remove_file(&path);
            removed += 1;
            continue;
        };

        // Port free = no listener; lock is orphaned metadata regardless of PID recycle quirks.
        let port_busy = crate::engine_utils::is_port_in_use(port).await;
        if !port_busy {
            log::info!(
                "[port_lock] Sweep: removing stale lock for port {port} (port free, lock PID {})",
                lock.engine_pid
            );
            delete_lock(port);
            removed += 1;
            continue;
        }

        // Port busy but listener differs from lock — stale lock file.
        if let Some(listener_pid) = crate::engine_utils::get_listening_pid(port).await {
            if listener_pid != lock.engine_pid {
                log::info!(
                    "[port_lock] Sweep: removing stale lock for port {port} \
                     (listener PID {listener_pid} != lock PID {})",
                    lock.engine_pid
                );
                delete_lock(port);
                removed += 1;
            }
        }
    }

    if removed > 0 {
        log::info!("[port_lock] Sweep removed {removed} stale engine lock(s)");
    }
}

/// Port busy: kill only a verified Blackwell orphan; otherwise fail without touching other apps.
pub async fn reclaim_our_ghost_or_fail(port: u16, binary_path: &Path) -> Result<(), String> {
    if !crate::engine_utils::is_port_in_use(port).await {
        if read_lock(port).is_some() {
            log::info!("[port_lock] Port {port} free — removing stale lock file");
            delete_lock(port);
        }
        return Ok(());
    }

    let listener_pid = crate::engine_utils::get_listening_pid(port).await.ok_or_else(|| {
        format!(
            "Port {port} is in use but the listening process could not be identified. \
             Stop the other server or change BASE-PORT."
        )
    })?;

    let lock = read_lock(port).ok_or_else(|| {
        format!(
            "Port {port} is in use by PID {listener_pid} (not a Blackwell Ops engine lock). \
             Stop the other application or change BASE-PORT."
        )
    })?;

    if lock.engine_pid != listener_pid {
        return Err(format!(
            "Port {port} is in use by PID {listener_pid} (lock expects PID {}). \
             Stop the other application or change BASE-PORT.",
            lock.engine_pid
        ));
    }

    let locked_binary = crate::config::resolve_path(&lock.binary_path);
    if !crate::engine_utils::same_executable_path(&locked_binary, binary_path) {
        return Err(format!(
            "Port {port} lock binary does not match this provider. \
             Stop the other application or change BASE-PORT."
        ));
    }

    let listener_image = tokio::task::spawn_blocking(move || {
        crate::engine_utils::get_process_image_path(listener_pid)
    })
    .await
    .map_err(|e| e.to_string())?;

    let Some(listener_image) = listener_image else {
        return Err(format!(
            "Port {port} listener PID {listener_pid} is not readable. \
             Stop the other application or change BASE-PORT."
        ));
    };

    if !crate::engine_utils::same_executable_path(&listener_image, binary_path) {
        return Err(format!(
            "Port {port} is held by PID {listener_pid} ({}) — not our llama-server. \
             Stop the other application or change BASE-PORT.",
            listener_image.display()
        ));
    }

    let current_app_pid = std::process::id();
    let owner_alive = crate::engine_utils::is_process_alive(lock.owner_app_pid);

    if lock.owner_app_pid != current_app_pid && owner_alive {
        return Err(format!(
            "Port {port} is in use by another running Blackwell Ops instance (owner PID {}). \
             Stop that engine first or change BASE-PORT.",
            lock.owner_app_pid
        ));
    }

    log::info!(
        "[port_lock] Reclaiming orphan engine on port {port} (PID {listener_pid}, owner_app_pid={})",
        lock.owner_app_pid
    );

    crate::engine_utils::kill_process_by_pid(listener_pid).await?;
    tokio::time::sleep(std::time::Duration::from_millis(200)).await;

    if crate::engine_utils::is_port_in_use(port).await {
        return Err(format!(
            "Port {port} is still in use after reclaiming orphan PID {listener_pid}. \
             Stop the process manually or change BASE-PORT."
        ));
    }

    delete_lock(port);
    Ok(())
}