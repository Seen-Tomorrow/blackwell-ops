//! Removal for the disposable Foundry `work/` tree.
//!
//! Windows keeps the last handle on a just-finished build tree open for a beat after the
//! final compiler/linker child exits — an AV scan of a freshly linked DLL does the same.
//! A single `remove_dir_all` therefore reports `os error 32` on a tree that is already
//! dead, which reads as "CLEAR CACHE did nothing" and invites 2–3 clicks.
//!
//! Retry with capped exponential backoff, then fail loudly **naming the entry that still
//! holds the handle**: `io::Error` carries no path, so the caller could only ever print
//! the tree root and the culprit stayed invisible.

use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a removal keeps retrying before it fails. Long enough for compiler teardown
/// plus an AV scan of a freshly linked DLL; short enough that a genuinely wedged tree
/// still fails while the user is watching.
pub(crate) const TREE_REMOVE_BUDGET: Duration = Duration::from_secs(8);

const FIRST_DELAY: Duration = Duration::from_millis(150);
const MAX_DELAY: Duration = Duration::from_millis(2_000);

/// Files probed when looking for the locked entry. The failing child is normally one of
/// the newest outputs, so a partial scan is enough for a diagnostic hint.
const LOCK_SCAN_LIMIT: usize = 5_000;

/// `remove_dir_all` for a disposable build tree, retried for [`TREE_REMOVE_BUDGET`].
///
/// `Ok` means the path is gone (already absent counts). `Err` carries the last OS error
/// plus the locked entry when one can be identified.
pub(crate) async fn remove_dir_all_retrying(path: &Path) -> Result<(), String> {
    remove_dir_all_retrying_within(path, TREE_REMOVE_BUDGET).await
}

/// Same, with an explicit budget — tests use a short one.
pub(crate) async fn remove_dir_all_retrying_within(
    path: &Path,
    budget: Duration,
) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    let started = std::time::Instant::now();
    let mut delay = FIRST_DELAY;
    let mut attempts: u32 = 0;
    let mut last_error: Option<std::io::Error> = None;

    loop {
        attempts += 1;
        match tokio::fs::remove_dir_all(path).await {
            Ok(()) => break,
            Err(e) => last_error = Some(e),
        }
        // A partial pass can still finish the job (the locked child is usually the last one).
        if !path.exists() {
            break;
        }
        let remaining = budget.saturating_sub(started.elapsed());
        if remaining.is_zero() {
            break;
        }
        tokio::time::sleep(delay.min(remaining)).await;
        delay = (delay * 2).min(MAX_DELAY);
    }

    if !path.exists() {
        return Ok(());
    }

    let mut detail = last_error
        .map(|e| e.to_string())
        .unwrap_or_else(|| "tree still present".to_string());
    detail.push_str(&format!(" after {attempts} attempt(s)"));
    match locked_entry_hint(path).await {
        Some(hint) => detail.push_str(&format!("; {hint}")),
        None => detail.push_str(
            "; no locked file found inside — the directory itself is held \
             (a process CWD or an Explorer window)",
        ),
    }
    Err(detail)
}

async fn locked_entry_hint(root: &Path) -> Option<String> {
    let root = root.to_path_buf();
    tokio::task::spawn_blocking(move || find_locked_entry(&root))
        .await
        .ok()
        .flatten()
}

fn find_locked_entry(root: &Path) -> Option<String> {
    let mut stack: Vec<PathBuf> = vec![root.to_path_buf()];
    let mut scanned = 0usize;
    while let Some(dir) = stack.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            let path = entry.path();
            if file_type.is_dir() {
                stack.push(path);
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            scanned += 1;
            if scanned > LOCK_SCAN_LIMIT {
                return None;
            }
            if is_locked(&path) {
                return Some(format!("locked file: {}", path.display()));
            }
        }
    }
    None
}

/// Probe by opening with no sharing allowed: another handle makes that fail.
#[cfg(windows)]
fn is_locked(path: &Path) -> bool {
    use std::os::windows::fs::OpenOptionsExt;
    match std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .share_mode(0)
        .open(path)
    {
        Ok(_) => false,
        // 32 ERROR_SHARING_VIOLATION, 33 ERROR_LOCK_VIOLATION. Anything else (5 on a
        // read-only artifact, 2 for an entry that just vanished) is not a sharing lock.
        Err(e) => matches!(e.raw_os_error(), Some(32) | Some(33)),
    }
}

#[cfg(not(windows))]
fn is_locked(_path: &Path) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("blackwell-fstree-{}-{name}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("nested")).expect("create scratch tree");
        std::fs::write(dir.join("nested").join("artifact.bin"), b"x").expect("write artifact");
        dir
    }

    #[tokio::test]
    async fn removes_an_unlocked_tree() {
        let dir = scratch("plain");
        remove_dir_all_retrying(&dir).await.expect("removal");
        assert!(!dir.exists());
    }

    #[tokio::test]
    async fn absent_path_is_not_an_error() {
        let dir = std::env::temp_dir().join(format!("blackwell-fstree-absent-{}", std::process::id()));
        assert!(remove_dir_all_retrying(&dir).await.is_ok());
    }

    /// The OS error is a bare `os error 32`; the message must still point at the entry.
    #[cfg(windows)]
    #[tokio::test]
    async fn names_the_locked_entry_when_the_budget_expires() {
        use std::os::windows::fs::OpenOptionsExt;
        let dir = scratch("locked");
        let locked = dir.join("nested").join("artifact.bin");
        let held = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .share_mode(0)
            .open(&locked)
            .expect("hold an exclusive handle");

        let err = remove_dir_all_retrying_within(&dir, std::time::Duration::from_millis(150))
            .await
            .expect_err("a held handle must fail the removal");
        assert!(err.contains("artifact.bin"), "error must name the locked entry: {err}");

        drop(held);
        remove_dir_all_retrying(&dir).await.expect("removal after release");
        assert!(!dir.exists());
    }
}
