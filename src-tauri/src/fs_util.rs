//! Durable file writes — the single place app state should reach the disk.
//!
//! # Why this module exists
//!
//! `std::fs::write` **truncates the target before writing it**. If the process
//! dies in that window — `taskkill` on the stop path, `std::process::exit(0)` on
//! the update/teardown path, a panic under `panic = "abort"`, or a power loss —
//! the file is left empty or half-written.
//!
//! That alone would be recoverable. What made it unrecoverable was the reader:
//! `load_saved_config` treated an unparseable `app_config.json` exactly like a
//! missing one, so the next launch assumed a first run and **wrote fresh defaults
//! over the last known-good bytes**. One torn write became permanent, silent loss
//! of every model path and provider edit.
//!
//! Two rules, both enforced here rather than in prose:
//!   1. Writes go temp → flush → rename, so a reader only ever sees the old file
//!      or the new file, never a mixture.
//!   2. A file that fails to parse is **quarantined**, never overwritten. Absent
//!      and corrupt are different facts and must not share a code path.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// Monotonic tiebreaker for temp names, so two writes in the same nanosecond
/// (or a retried write after a partial failure) can never collide.
static TMP_COUNTER: AtomicU64 = AtomicU64::new(0);

fn tmp_suffix() -> String {
    let n = TMP_COUNTER.fetch_add(1, Ordering::Relaxed);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{:x}-{:x}-{:x}", std::process::id(), nanos, n)
}

/// Write `bytes` to `path` atomically: sibling temp file → flush → replace.
///
/// The temp file lives in the **same directory** as the target — rename is only
/// atomic within a volume, and a cross-volume rename silently degrades to a
/// copy, which reintroduces the torn-write window this exists to close.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent)
        .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;

    let stem = path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("atomic-target");
    let tmp = parent.join(format!(".{stem}.{}.tmp", tmp_suffix()));

    let staged = (|| -> Result<(), String> {
        let mut file = fs::File::create(&tmp)
            .map_err(|e| format!("Failed to create {}: {e}", tmp.display()))?;
        file.write_all(bytes)
            .map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
        // Hand the bytes to the OS *before* the rename makes them visible, so a
        // power loss cannot leave a renamed-but-empty file standing in for real data.
        file.sync_all()
            .map_err(|e| format!("Failed to flush {}: {e}", tmp.display()))?;
        Ok(())
    })();

    if let Err(e) = staged {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }

    // std::fs::rename on Windows is MoveFileEx(MOVEFILE_REPLACE_EXISTING), so this
    // replaces an existing target in one step — no delete-then-create gap.
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!(
            "Failed to move {} onto {}: {e}",
            tmp.display(),
            path.display()
        )
    })
}

/// Serialize as pretty JSON and write atomically.
pub fn write_json_atomic<T: serde::Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|e| format!("Failed to serialize {}: {e}", path.display()))?;
    write_atomic(path, json.as_bytes())
}

/// Move an unreadable file aside and return its new location, or `None` if that failed.
///
/// Callers must treat `None` as "still do not overwrite" — the point of this
/// function is that a file we could not parse is never replaced by a default.
pub fn quarantine(corrupt: &Path) -> Option<PathBuf> {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let name = corrupt.file_name().and_then(|s| s.to_str())?;
    let dest = corrupt.with_file_name(format!("{name}.corrupt-{stamp}"));
    match fs::rename(corrupt, &dest) {
        Ok(()) => {
            log::error!(
                "[fs_util] {} could not be parsed — preserved unreadable copy at {} \
                 (defaults were NOT written over it)",
                corrupt.display(),
                dest.display()
            );
            Some(dest)
        }
        Err(e) => {
            log::error!(
                "[fs_util] Failed to quarantine unreadable {}: {e}",
                corrupt.display()
            );
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "blackwell-fs-util-{tag}-{}",
            tmp_suffix()
        ));
        fs::create_dir_all(&dir).expect("scratch dir");
        dir
    }

    #[test]
    fn write_atomic_replaces_existing_contents() {
        let dir = scratch_dir("replace");
        let path = dir.join("state.json");
        write_atomic(&path, b"{\"v\":1}").expect("first write");
        write_atomic(&path, b"{\"v\":2}").expect("second write");
        assert_eq!(fs::read_to_string(&path).unwrap(), "{\"v\":2}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_atomic_creates_missing_parent_dirs() {
        let root = scratch_dir("nested");
        let path = root.join("a").join("b").join("deep.json");
        write_atomic(&path, b"ok").expect("nested write");
        assert_eq!(fs::read_to_string(&path).unwrap(), "ok");
        let _ = fs::remove_dir_all(&root);
    }

    #[test]
    fn write_atomic_leaves_no_temp_file_behind() {
        let dir = scratch_dir("clean");
        let path = dir.join("clean.json");
        write_atomic(&path, b"x").expect("write");
        let leftovers: Vec<_> = fs::read_dir(&dir)
            .expect("read_dir")
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .filter(|n| n.contains(".tmp"))
            .collect();
        assert_eq!(leftovers, Vec::<String>::new(), "temp file leaked");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn quarantine_preserves_the_bytes_and_frees_the_original_slot() {
        let dir = scratch_dir("quarantine");
        let path = dir.join("app_config.json");
        fs::write(&path, b"{ truncated mid-write").expect("seed");

        let moved = quarantine(&path).expect("quarantine");
        assert!(!path.exists(), "original slot must be freed");
        assert_eq!(
            fs::read(&moved).expect("preserved copy readable"),
            b"{ truncated mid-write"
        );
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_json_atomic_round_trips() {
        #[derive(serde::Serialize, serde::Deserialize, PartialEq, Debug)]
        struct Sample {
            name: String,
            count: u32,
        }
        let dir = scratch_dir("json");
        let path = dir.join("sample.json");
        let value = Sample {
            name: "ggml-master".into(),
            count: 3,
        };
        write_json_atomic(&path, &value).expect("json write");
        let back: Sample =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).expect("parse back");
        assert_eq!(back, value);
        let _ = fs::remove_dir_all(&dir);
    }
}
