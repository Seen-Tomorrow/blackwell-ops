//! Ninja edge-counter parsing for the Foundry compile stage.
//!
//! Ninja prints one line per scheduled edge as it starts:
//!
//! ```text
//! [380/416] Building CXX object tools\server\CMakeFiles\server-context.dir\Release\x.cpp.obj
//! [404/416] Building CUDA object ggml\src\ggml-cuda\CMakeFiles\ggml-cuda.dir\Release\fattn-vec-instance-q8_0-f16.cu
//! [416/416] Linking CXX executable bin\Release\llama-server.exe
//! ```
//!
//! `M` is fixed for the whole `cmake --build` invocation and the counter only moves
//! forward, so a monotonic high-water mark *is* the compile progress.
//!
//! This lives in Rust rather than the frontend on purpose: the dock chip, the build
//! window, and `foundry_status` hydration must read one number. A TS-only parse loses
//! the value on modal reopen and on a minimized-chip remount (the dock survives, the
//! log listener does not).
//!
//! Two facts drive the shape below:
//! - Continuation lines exist (`fatbin-vec-instance-q8_0-f16.cu` on its own line, no
//!   counter), so a non-counter line must never clear the current edge label.
//! - stdout and stderr are drained on separate OS threads into one buffer with no
//!   ordering guarantee, so counters are merged by high-water mark — never by
//!   "last line wins".

use serde::{Deserialize, Serialize};
use std::sync::{Mutex, OnceLock};

/// Compile-stage edge progress, carried on `foundry-progress` and `foundry_status`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct BuildEdgeProgress {
    pub done: u32,
    pub total: u32,
    /// Leaf name of the edge's input/output, e.g. `fattn-vec-instance-q8_0-f16.cu`.
    pub label: Option<String>,
    /// Coarse edge kind: `CUDA` | `CXX` | `C` | `LINK` | `GEN` | `OTHER`.
    pub kind: Option<String>,
}

/// Split a counter line into `(done, total, tail_after_counter)`.
///
/// Scans every `[…]` group rather than assuming position zero, so a line that
/// happens to carry a leading `[19:01:32]` clock prefix still parses (the clock has
/// no `/`, so it can never be mistaken for a counter).
fn parse_edge(line: &str) -> Option<(u32, u32, &str)> {
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let after_open = &rest[open + 1..];
        let close = match after_open.find(']') {
            Some(c) => c,
            None => return None,
        };
        let inner = &after_open[..close];
        if let Some((a, b)) = inner.split_once('/') {
            if let (Ok(done), Ok(total)) = (a.trim().parse::<u32>(), b.trim().parse::<u32>()) {
                if total > 0 && done <= total {
                    return Some((done, total, &after_open[close + 1..]));
                }
            }
        }
        rest = &after_open[close + 1..];
    }
    None
}

/// Parse one ninja edge line into `(done, total, kind, label)`.
///
/// The single entry point for both the running value ([`apply`]) and the tests, so
/// there is exactly one definition of what a counter line looks like.
pub(crate) fn inspect_edge(line: &str) -> Option<(u32, u32, Option<String>, Option<String>)> {
    let (done, total, tail) = parse_edge(line)?;
    // Ninja emits `[0/1] Re-running CMake...` before the real graph exists when the
    // build tree regenerates. That is not compile work: reporting it would flash the
    // bar to 0/1 and then re-scale. Ignore it so progress stays "no counter yet".
    if tail.trim_start().starts_with("Re-running") {
        return None;
    }
    let (kind, label) = classify(tail);
    Some((done, total, kind, label))
}

fn classify(tail: &str) -> (Option<String>, Option<String>) {
    let tail = tail.trim_start();
    let kind = if tail.starts_with("Building CUDA object") {
        Some("CUDA")
    } else if tail.starts_with("Building CXX object") {
        Some("CXX")
    } else if tail.starts_with("Building C object") {
        Some("C")
    } else if tail.starts_with("Linking") {
        Some("LINK")
    } else if tail.starts_with("Generating") {
        Some("GEN")
    } else if tail.starts_with("Building") {
        Some("OTHER")
    } else {
        None
    };

    // The leaf is the last whitespace token (a path); keep it only when it looks
    // like a file, so odd edges degrade to "no label" instead of a stale fragment.
    let label = tail
        .rsplit(' ')
        .find(|tok| !tok.is_empty())
        .and_then(|tok| {
            let leaf = tok.rsplit(|c| c == '\\' || c == '/').next().unwrap_or(tok);
            let plausible = leaf.len() <= 96 && leaf.len() > 2 && leaf.contains('.') && !leaf.starts_with('.');
            if plausible {
                Some(leaf.to_string())
            } else {
                None
            }
        });

    (kind.map(str::to_string), label)
}

/// Fold one streamed line into the running progress value.
///
/// Monotonic within a run (`total` unchanged). A different `total` means a *new*
/// ninja invocation (CMake can split targets, and a restat retry re-runs), so the
/// counter legitimately restarts — following it beats pinning the bar at 100%.
fn apply(prev: Option<BuildEdgeProgress>, line: &str) -> Option<BuildEdgeProgress> {
    let (done, total, kind, label) = match inspect_edge(line) {
        Some(v) => v,
        None => return prev,
    };
    let same_run = matches!(&prev, Some(p) if p.total == total);
    let done = if same_run {
        prev.as_ref().map(|p| p.done).unwrap_or(0).max(done)
    } else {
        done
    };

    let carried_label = prev.as_ref().and_then(|p| p.label.clone());
    let carried_kind = prev.as_ref().and_then(|p| p.kind.clone());

    Some(BuildEdgeProgress {
        done,
        total,
        label: label.or(carried_label),
        kind: kind.or(carried_kind),
    })
}

static EDGE_PROGRESS: OnceLock<Mutex<Option<BuildEdgeProgress>>> = OnceLock::new();

fn store() -> &'static Mutex<Option<BuildEdgeProgress>> {
    EDGE_PROGRESS.get_or_init(|| Mutex::new(None))
}

/// Record one drained pipe line. Cheap reject for the overwhelming majority of
/// lines (warnings, compiler notes) that cannot carry a counter.
pub(crate) fn record_line(line: &str) {
    if !line.as_bytes().contains(&b'[') {
        return;
    }
    match store().lock() {
        Ok(mut guard) => {
            let next = apply(guard.take(), line);
            *guard = next;
        }
        Err(e) => log::error!("[foundry] edge progress mutex poisoned: {e}"),
    }
}

/// Current progress for event emission / `foundry_status` hydration.
pub(crate) fn snapshot() -> Option<BuildEdgeProgress> {
    match store().lock() {
        Ok(guard) => guard.clone(),
        Err(e) => {
            log::error!("[foundry] edge progress mutex poisoned: {e}");
            None
        }
    }
}

/// Clear at the start of a new build so a previous run can never leak into it.
pub(crate) fn reset() {
    match store().lock() {
        Ok(mut guard) => *guard = None,
        Err(e) => log::error!("[foundry] edge progress mutex poisoned: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::{apply, inspect_edge, BuildEdgeProgress};

    fn counter(line: &str) -> Option<(u32, u32)> {
        inspect_edge(line).map(|(done, total, _, _)| (done, total))
    }

    fn described(line: &str) -> (Option<String>, Option<String>) {
        inspect_edge(line)
            .map(|(_, _, kind, label)| (kind, label))
            .unwrap_or((None, None))
    }

    const CXX: &str = r"[381/416] Building CXX object tools\fit-params\CMakeFiles\llama-fit-params-impl.dir\Release\llama-fit-params.cpp.obj";
    const CUDA: &str = r"[404/416] Building CUDA object ggml\src\ggml-cuda\CMakeFiles\ggml-cuda.dir\Release\fattn-vec-instance-q8_0-f16.cu";
    const LINK: &str = r"[416/416] Linking CXX executable bin\Release\llama-server.exe";

    #[test]
    fn parses_counter_at_line_start() {
        assert_eq!(counter(CXX), Some((381, 416)));
        assert_eq!(counter(CUDA), Some((404, 416)));
    }

    #[test]
    fn parses_counter_after_clock_prefix() {
        assert_eq!(
            counter("[19:01:32] [380/416] Building CXX object x.obj"),
            Some((380, 416))
        );
    }

    #[test]
    fn clock_prefix_alone_is_not_a_counter() {
        assert_eq!(counter("[19:01:32] Building CXX object x.obj"), None);
    }

    #[test]
    fn rejects_malformed_or_impossible_counters() {
        assert_eq!(counter("[abc/def] Building CXX object x.obj"), None);
        assert_eq!(counter("[5/4] Building CXX object x.obj"), None);
        assert_eq!(counter("[0/0] Building CXX object x.obj"), None);
        assert_eq!(counter("Building CXX object x.obj"), None);
        assert_eq!(counter(""), None);
    }

    #[test]
    fn describes_cuda_cxx_and_link_edges() {
        assert_eq!(
            described(CUDA),
            (
                Some("CUDA".to_string()),
                Some("fattn-vec-instance-q8_0-f16.cu".to_string())
            )
        );
        assert_eq!(
            described(CXX),
            (Some("CXX".to_string()), Some("llama-fit-params.cpp.obj".to_string()))
        );
        assert_eq!(
            described(LINK),
            (Some("LINK".to_string()), Some("llama-server.exe".to_string()))
        );
    }

    #[test]
    fn high_water_mark_survives_out_of_order_lines() {
        let s = apply(None, CXX);
        let s = apply(s, CUDA);
        let s = apply(s, CXX); // stderr drain racing behind stdout
        let s = s.expect("progress");
        assert_eq!(s.done, 404);
        assert_eq!(s.total, 416);
    }

    #[test]
    fn continuation_line_keeps_current_label() {
        let s = apply(None, CUDA);
        let s = apply(s, "fattn-vec-instance-q8_0-f16.cu");
        let s = s.expect("progress");
        assert_eq!(s.done, 404);
        assert_eq!(s.label.as_deref(), Some("fattn-vec-instance-q8_0-f16.cu"));
    }

    #[test]
    fn new_invocation_resets_the_counter() {
        let first = BuildEdgeProgress {
            done: 416,
            total: 416,
            label: None,
            kind: None,
        };
        // A second ninja invocation with a different denominator must not pin at 100%.
        let s = apply(Some(first), "[1/12] Building CXX object x.obj").expect("progress");
        assert_eq!((s.done, s.total), (1, 12));
    }

    #[test]
    fn non_counter_line_before_any_counter_is_none() {
        assert_eq!(apply(None, "ninja: no work to do."), None);
    }

    #[test]
    fn ignores_the_cmake_reconfigure_pseudo_edge() {
        // `[0/1] Re-running CMake...` is not compile work — it must not seed a 0/1 bar.
        assert_eq!(counter("[0/1] Re-running CMake..."), None);
        assert!(apply(None, "[0/1] Re-running CMake...").is_none());
    }

    /// The frontend reads these four keys directly; a rename here must fail a test
    /// rather than silently blank the bar.
    #[test]
    fn wire_shape_matches_the_frontend_contract() {
        let value = serde_json::to_value(BuildEdgeProgress {
            done: 3,
            total: 9,
            label: Some("x.cu".into()),
            kind: Some("CUDA".into()),
        })
        .expect("serialize");

        assert_eq!(value["done"], 3);
        assert_eq!(value["total"], 9);
        assert_eq!(value["label"], "x.cu");
        assert_eq!(value["kind"], "CUDA");
    }
}
