//! Engine telemetry SSE client (`/events/sse`).
//!
//! The engine broadcasts the events its per-request stream already carries, so an observer that
//! does not own the request (fusion) can meter PP and TG without polling `/slots`, scraping
//! `/metrics` or parsing stderr. One reader task per port keeps a per-lane snapshot; the poll
//! brain consumes it as an overlay and the SSE-only brain (`fusion/sse.rs`) reads it as its whole
//! source. `probe()` is the one-shot launch capability check, and `request_epoch()` gives
//! stream-only callers request boundaries that do not depend on catching a transient idle tick.
//!
//! `BLACKWELL_ENGINE_SSE=0|false|off|no` disables the reader (legacy escape hatch); otherwise it is
//! on and an engine without the endpoint answers one 404 and leaves the poll path alone.
//!
//! Event shapes are defined by the engine patch `foundry/patches/ggml-master-telemetry-sse.patch`
//! (`docs/ENGINE-TELEMETRY-SSE-HANDOFF.md`).

use std::collections::{HashMap, HashSet};
use std::sync::{Mutex, OnceLock};
use std::time::Instant;

use futures_util::StreamExt;
use serde::Deserialize;

/// One frame of `/events/sse`, tagged by the SSE `type` field.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum EngineEvent {
    State {
        slot: i32,
        phase: String,
        busy: i32,
        peak: i32,
        n_ctx: i64,
        n_ctx_used: i64,
        seq: u64,
    },
    PromptProgress {
        slot: i32,
        total: i64,
        cache: i64,
        processed: i64,
        time_ms: f64,
        seq: u64,
    },
    GenProgress {
        slot: i32,
        decoded: u64,
        gen_ms: f64,
        tps: f64,
        seq: u64,
    },
    RequestEnd {
        slot: i32,
        task: i64,
        prompt_ms: f64,
        predicted_ms: f64,
        tokens_evaluated: u64,
        tokens_predicted: u64,
        cache_hit_tokens: u64,
        spec_accepted: u64,
        spec_draft: u64,
        lib_prompt_ms: f64,
        lib_tokens_evaluated: i64,
        seq: u64,
    },
}

/// Completed-request summary, kept until the next request lands.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RequestSummary {
    pub prompt_ms: f64,
    /// Library prefill counter (`t_p_eval_ms`) for the same request.
    pub lib_prompt_ms: f64,
    pub tokens_evaluated: u64,
    pub predicted_ms: f64,
    pub tokens_predicted: u64,
    pub cache_hit_tokens: u64,
    pub spec_accepted: u64,
    pub spec_draft: u64,
}

/// Latest values for one engine slot.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct SlotTelemetry {
    pub slot: i32,
    pub phase: String,
    pub n_ctx: i64,
    pub n_ctx_used: i64,
    pub pp_processed: i64,
    pub pp_cache: i64,
    pub pp_total: i64,
    pub pp_time_ms: f64,
    pub gen_decoded: u64,
    pub gen_tps: f64,
    /// Recent `(arrival, decoded)` samples: a trailing-window rate instead of a two-sample delta.
    pub gen_samples: Vec<(std::time::Instant, u64)>,
    pub last_request: Option<RequestSummary>,
    /// Monotonic frame counter, useful to detect a stalled stream.
    pub seq: u64,
    /// Wall clock at the PP transition of the current request.
    pub t_request_start: Option<std::time::Instant>,
    /// Wall clock at the PP -> TG transition (prompt finished).
    pub t_prefill_end: Option<std::time::Instant>,
    /// Wall clock of the first generated token of the current request.
    pub t_first_token: Option<std::time::Instant>,
    /// Session totals accumulated from `request_end`, since the stream attached.
    pub spec_accepted_total: u64,
    pub spec_draft_total: u64,
    /// True between `request_end` and the next request's PP transition.
    pub request_closed: bool,
    /// Aggregate-only: summed lane prefill rate (not derivable from summed counters).
    pub aggregate_pp_tps: f64,
    /// Aggregate-only: earliest lane TTFT.
    pub aggregate_ttft_ms: Option<f64>,
    /// Aggregate-only: the *last* busy lane's first token — the clock the SSE brain's TG
    /// average starts from ("AVG starts when the last lane decodes").
    pub t_wave_start: Option<Instant>,
    /// Aggregate-only: every busy lane has produced its first token (wave clock may start).
    pub wave_ready: bool,
}

/// Kept as an alias: callers that only care about a single-slot engine read `snapshot()`.
pub type PortTelemetry = SlotTelemetry;

impl SlotTelemetry {
    /// Time from request start to the first generated token (aggregate: earliest lane).
    pub fn ttft_ms(&self) -> Option<f64> {
        if self.aggregate_ttft_ms.is_some() {
            return self.aggregate_ttft_ms;
        }
        let (start, first) = (self.t_request_start?, self.t_first_token?);
        Some(first.duration_since(start).as_secs_f64() * 1000.0)
    }

    /// Time from prompt end to the first generated token.
    pub fn decode_ttft_ms(&self) -> Option<f64> {
        let (end, first) = (self.t_prefill_end?, self.t_first_token?);
        Some(first.duration_since(end).as_secs_f64() * 1000.0)
    }

    /// Prefill TPS from the slot clock. `prompt_progress` counts the cached prefix in `processed`,
    /// so the newly evaluated tokens are `processed - cache`.
    ///
    /// An aggregate carries the summed lane rate explicitly: summing tokens but taking the
    /// longest window would understate a parallel engine's throughput.
    pub fn prefill_tps(&self) -> f64 {
        if self.aggregate_pp_tps > 0.0 {
            return self.aggregate_pp_tps;
        }
        if self.pp_time_ms <= 0.0 {
            return 0.0;
        }
        let evaluated = (self.pp_processed - self.pp_cache).max(0) as f64;
        (evaluated / self.pp_time_ms) * 1000.0
    }

    /// Decode rate over the trailing `window`, from the samples actually received.
    ///
    /// A two-sample delta aliases badly when a whole ubatch lands between ticks (a 1024-token
    /// step at 25 ms reads as ~40k tok/s for one frame). A trailing window smooths that without
    /// inventing data, and returns 0 until the span is long enough to mean anything.
    pub fn gen_tps_window(&self, window: std::time::Duration) -> f64 {
        window_rate(&self.gen_samples, window)
    }
}

/// Rate over the trailing window of `samples` (sorted oldest→newest, `(arrival, count)`).
///
/// Returns 0 when there are fewer than two samples inside the window, or when their span is
/// under 50 ms — below that the divisor is noise, not a measurement.
pub fn window_rate(
    samples: &[(std::time::Instant, u64)],
    window: std::time::Duration,
) -> f64 {
    let Some(&(end_t, end_n)) = samples.last() else {
        return 0.0;
    };
    let Some(&(start_t, start_n)) = samples
        .iter()
        .find(|(t, _)| end_t.saturating_duration_since(*t) <= window)
    else {
        return 0.0;
    };
    let span = end_t.saturating_duration_since(start_t);
    if span < std::time::Duration::from_millis(50) || end_n <= start_n {
        return 0.0;
    }
    (end_n - start_n) as f64 / span.as_secs_f64()
}

/// True when the SSE path is enabled for this process.
///
/// SSE is the primary path: it is on unless `BLACKWELL_ENGINE_SSE=0|false|off` disables it. A
/// missing endpoint costs one failed connect and a warning, then the poll path keeps working.
pub fn enabled() -> bool {
    !matches!(
        std::env::var("BLACKWELL_ENGINE_SSE")
            .unwrap_or_default()
            .to_ascii_lowercase()
            .as_str(),
        "0" | "false" | "off" | "no"
    )
}

fn live_ports() -> &'static Mutex<HashSet<u16>> {
    static LIVE: OnceLock<Mutex<HashSet<u16>>> = OnceLock::new();
    LIVE.get_or_init(|| Mutex::new(HashSet::new()))
}

/// True while a `/events/sse` connection is open for this port.
pub fn is_live(port: u16) -> bool {
    live_ports()
        .lock()
        .map(|s| s.contains(&port))
        .unwrap_or(false)
}

fn snapshots() -> &'static Mutex<HashMap<(u16, i32), SlotTelemetry>> {
    static SNAPSHOTS: OnceLock<Mutex<HashMap<(u16, i32), SlotTelemetry>>> = OnceLock::new();
    SNAPSHOTS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn started() -> &'static Mutex<HashSet<u16>> {
    static STARTED: OnceLock<Mutex<HashSet<u16>>> = OnceLock::new();
    STARTED.get_or_init(|| Mutex::new(HashSet::new()))
}

fn request_epochs() -> &'static Mutex<HashMap<u16, u64>> {
    static EPOCHS: OnceLock<Mutex<HashMap<u16, u64>>> = OnceLock::new();
    EPOCHS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Monotonic per-port request counter, bumped on every `state: PP` transition.
///
/// A brain that renders only from the stream needs request boundaries that do not depend on
/// catching a transient `IDLE` between two back-to-back requests (bench reps, agent turns):
/// comparing this counter is a hard "a new request started" edge.
pub fn request_epoch(port: u16) -> u64 {
    request_epochs()
        .lock()
        .ok()
        .and_then(|m| m.get(&port).copied())
        .unwrap_or(0)
}

fn bump_request_epoch(port: u16) {
    if let Ok(mut m) = request_epochs().lock() {
        *m.entry(port).or_insert(0) += 1;
    }
}

/// Telemetry for the port's active engine slot.
///
/// A single-slot engine (`--parallel 1`) has exactly one record. Ports that have seen several
/// slots return the busy one; if two slots are busy at the same time (true parallel lanes) this
/// returns `None` on purpose — the poller still owns the aggregate for that case.
pub fn snapshot(port: u16) -> Option<SlotTelemetry> {
    let map = snapshots().lock().ok()?;
    let mut entries: Vec<&SlotTelemetry> = map
        .iter()
        .filter(|((p, _), _)| *p == port)
        .map(|(_, v)| v)
        .collect();
    if entries.is_empty() {
        return None;
    }
    entries.sort_by_key(|e| e.seq);
    let busy: Vec<&&SlotTelemetry> = entries.iter().filter(|e| e.phase != "IDLE").collect();
    match busy.len() {
        1 => Some((**busy[0]).clone()),
        0 => entries.last().map(|e| (*e).clone()),
        _ => None,
    }
}

/// Per-slot view, for callers that know the engine slot id.
pub fn slot_snapshot(port: u16, slot: i32) -> Option<SlotTelemetry> {
    snapshots().lock().ok()?.get(&(port, slot)).cloned()
}

/// Per-lane telemetry for a port, sorted by engine slot id.
///
/// Callers that need per-slot data (ctx bars) read this instead of re-parsing the stream.
pub fn lanes(port: u16) -> Vec<SlotTelemetry> {
    let Ok(map) = snapshots().lock() else {
        return Vec::new();
    };
    let mut out: Vec<SlotTelemetry> = map
        .iter()
        .filter(|((p, _), _)| *p == port)
        .map(|(_, v)| v.clone())
        .collect();
    out.sort_by_key(|s| s.slot);
    out
}

/// Engine-wide view across every lane of a parallel engine.
///
/// Fusion tracks one brain per *engine*, so a `--parallel N` engine needs system numbers, not
/// one lane's. Aggregation rules:
/// - `phase`: PP if any lane is prefilling, else TG if any lane is generating, else IDLE;
/// - prefill: token counts summed, and the rate is the **sum of per-lane rates** (system
///   throughput), with the time window taken as the longest-running lane;
/// - generation: `gen_decoded` and `gen_tps` summed (system throughput);
/// - context: `n_ctx` / `n_ctx_used` summed;
/// - timings: TTFT is the earliest lane's, `request_closed` only when every lane is closed;
/// - spec totals summed; `last_request` is the most recently updated lane's.
pub fn aggregate(port: u16) -> Option<SlotTelemetry> {
    let map = snapshots().lock().ok()?;
    let lanes: Vec<&SlotTelemetry> = map
        .iter()
        .filter(|((p, _), _)| *p == port)
        .map(|(_, v)| v)
        .collect();
    if lanes.is_empty() {
        return None;
    }

    let mut out = SlotTelemetry {
        slot: -1,
        phase: "IDLE".to_string(),
        ..Default::default()
    };
    let mut pp_rate = 0.0;
    let mut ttft: Option<f64> = None;
    let mut latest: Option<&SlotTelemetry> = None;
    // Wave clock: the last busy lane's first token, only once every busy lane has decoded.
    let mut busy_lanes = 0usize;
    let mut all_busy_decoded = true;
    let mut wave_start: Option<Instant> = None;

    for lane in &lanes {
        out.n_ctx += lane.n_ctx;
        out.n_ctx_used += lane.n_ctx_used;
        out.pp_processed += lane.pp_processed;
        out.pp_cache += lane.pp_cache;
        out.pp_total += lane.pp_total;
        out.pp_time_ms = out.pp_time_ms.max(lane.pp_time_ms);
        out.gen_decoded += lane.gen_decoded;
        out.gen_tps += lane.gen_tps;
        out.spec_accepted_total += lane.spec_accepted_total;
        out.spec_draft_total += lane.spec_draft_total;
        out.seq = out.seq.max(lane.seq);
        pp_rate += lane.prefill_tps();
        if let Some(t) = lane.ttft_ms() {
            ttft = Some(ttft.map_or(t, |cur: f64| cur.min(t)));
        }
        if lane.phase == "PP" || lane.phase == "TG" {
            busy_lanes += 1;
            match lane.t_first_token {
                Some(t) => wave_start = Some(wave_start.map_or(t, |cur: Instant| cur.max(t))),
                None => all_busy_decoded = false,
            }
        }
        if lane.phase == "PP" {
            out.phase = "PP".to_string();
        } else if lane.phase == "TG" && out.phase != "PP" {
            out.phase = "TG".to_string();
        }
        if latest.map_or(true, |l| lane.seq >= l.seq) {
            latest = Some(lane);
        }
    }

    out.request_closed = lanes.iter().all(|l| l.request_closed);
    out.last_request = latest.and_then(|l| l.last_request.clone());
    // `pp_rate` is what prefill_tps() would recompute from summed tokens/time, so stash it in a
    // way that survives the summed counters: the summed rate is not derivable, keep it explicit.
    out.aggregate_pp_tps = pp_rate;
    out.aggregate_ttft_ms = ttft;
    // Only a wave where every busy lane produced a token may start the TG average; a queued or
    // still-prefilling lane means the clock has not started yet.
    out.wave_ready = busy_lanes > 0 && all_busy_decoded;
    out.t_wave_start = if out.wave_ready { wave_start } else { None };
    Some(out)
}

/// One-shot capability probe: true when this port serves `/events/sse`.
///
/// The handler writes a comment frame immediately, so `send()` resolves at the response headers
/// and the body is dropped at once — the probe costs one connection and leaves no reader behind.
/// Bounded by a 300 ms timeout: a listening engine without the patch answers 404 immediately, a
/// port that is not up yet refuses immediately, and a silent endpoint cannot stall the launch.
///
/// This reports what the *engine* can do; callers still gate the SSE brain on [`enabled`].
pub async fn probe(port: u16) -> bool {
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(300))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    match client
        .get(format!("http://127.0.0.1:{port}/events/sse"))
        .send()
        .await
    {
        Ok(resp) => resp.status().is_success(),
        Err(_) => false,
    }
}

/// Start the reader for a port. Idempotent; no-op unless `BLACKWELL_ENGINE_SSE=1`.
pub fn ensure(port: u16) {
    if !enabled() {
        return;
    }
    {
        let mut set = match started().lock() {
            Ok(s) => s,
            Err(_) => return,
        };
        if !set.insert(port) {
            return;
        }
    }
    tokio::spawn(async move { run(port).await });
}

async fn run(port: u16) {
    let url = format!("http://127.0.0.1:{port}/events/sse");
    let mut failures: u32 = 0;
    loop {
        if !enabled() {
            return;
        }
        match stream_once(port, &url).await {
            Ok(()) => {
                failures = 0;
                // clean close = engine gone; its numbers must not outlive it
                forget_port(port);
                log::info!("[engine-events] stream closed port={port}");
            }
            Err(e) => {
                failures = failures.saturating_add(1);
                // An engine without the patch (or a restarted one) must not inherit this port's
                // previous telemetry: clear it so callers fall back to polling immediately.
                forget_port(port);
                log::warn!("[engine-events] port={port} disconnected: {e}");
            }
        }
        let secs = (2u64 * u64::from(failures.max(1))).min(30);
        tokio::time::sleep(std::time::Duration::from_secs(secs)).await;
    }
}

/// Drop everything remembered about a port: slot telemetry and the live flag.
fn forget_port(port: u16) {
    if let Ok(mut map) = snapshots().lock() {
        map.retain(|(p, _), _| *p != port);
    }
    if let Ok(mut live) = live_ports().lock() {
        live.remove(&port);
    }
}

async fn stream_once(port: u16, url: &str) -> Result<(), String> {
    let resp = reqwest::Client::new()
        .get(url)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    if !resp.status().is_success() {
        return Err(format!("HTTP {}", resp.status()));
    }
    log::info!("[engine-events] attached port={port}");
    if let Ok(mut live) = live_ports().lock() {
        live.insert(port);
    }
    // A fresh connection means a fresh engine (or a restarted one): drop stale slot state so
    // accumulated session counters do not carry across processes.
    if let Ok(mut map) = snapshots().lock() {
        map.retain(|(p, _), _| *p != port);
    }

    let mut buf = String::new();
    let mut stream = resp.bytes_stream();
    while let Some(chunk) = stream.next().await {
        match chunk {
            Ok(chunk) => {
                buf.push_str(&String::from_utf8_lossy(&chunk));
                for evt in take_frames(&mut buf) {
                    apply(port, &evt);
                }
            }
            Err(e) => {
                if let Ok(mut live) = live_ports().lock() {
                    live.remove(&port);
                }
                return Err(e.to_string());
            }
        }
    }
    if let Ok(mut live) = live_ports().lock() {
        live.remove(&port);
    }
    Ok(())
}

/// Split complete SSE records out of `buf`, leaving the trailing partial record in place.
///
/// Records are separated by a blank line. `:` comment lines (keep-alives) and `event:` lines are
/// ignored; only `data:` payloads are parsed. Malformed payloads are skipped rather than killing
/// the stream.
pub fn take_frames(buf: &mut String) -> Vec<EngineEvent> {
    let mut out = Vec::new();
    while let Some(idx) = buf.find("\n\n") {
        let record: String = buf.drain(..idx + 2).collect();
        let mut data = String::new();
        for line in record.lines() {
            if let Some(rest) = line.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                data.push_str(rest.trim_start());
            }
        }
        if data.is_empty() {
            continue;
        }
        match serde_json::from_str::<EngineEvent>(&data) {
            Ok(evt) => out.push(evt),
            Err(e) => log::debug!("[engine-events] bad frame: {e}: {data}"),
        }
    }
    out
}

fn apply(port: u16, evt: &EngineEvent) {    let slot = match evt {
        EngineEvent::State { slot, .. }
        | EngineEvent::PromptProgress { slot, .. }
        | EngineEvent::GenProgress { slot, .. }
        | EngineEvent::RequestEnd { slot, .. } => *slot,
    };
    let Ok(mut map) = snapshots().lock() else {
        return;
    };
    let entry = map.entry((port, slot)).or_default();
    entry.slot = slot;
    let now = std::time::Instant::now();
    let mut opened_wave = false;
    match evt {
        EngineEvent::State {
            phase,
            n_ctx,
            n_ctx_used,
            seq,
            ..
        } => {
            let was_pp = entry.phase == "PP";
            entry.phase = phase.clone();
            entry.n_ctx = *n_ctx;
            entry.n_ctx_used = *n_ctx_used;
            entry.seq = *seq;
            if phase == "PP" && !was_pp {
                // new request: timestamps belong to this one
                entry.t_request_start = Some(now);
                entry.t_prefill_end = None;
                entry.t_first_token = None;
                entry.request_closed = false;
                // a two-request-old decode sample must not leak into this request's window
                entry.gen_samples.clear();
                opened_wave = true;
            } else if phase == "TG" && entry.t_prefill_end.is_none() {
                entry.t_prefill_end = Some(now);
            }
            if phase == "IDLE" {
                entry.pp_processed = 0;
                entry.pp_cache = 0;
                entry.pp_total = 0;
                entry.pp_time_ms = 0.0;
                entry.gen_decoded = 0;
                entry.gen_tps = 0.0;
            }
        }
        EngineEvent::PromptProgress {
            total,
            cache,
            processed,
            time_ms,
            seq,
            ..
        } => {
            entry.pp_total = *total;
            entry.pp_cache = *cache;
            entry.pp_processed = *processed;
            entry.pp_time_ms = *time_ms;
            entry.seq = *seq;
        }
        EngineEvent::GenProgress {
            decoded, tps, seq, ..
        } => {
            if *decoded > 0 && entry.t_first_token.is_none() {
                entry.t_first_token = Some(now);
            }
            entry.gen_decoded = *decoded;
            entry.gen_tps = *tps;
            entry.seq = *seq;
            entry.gen_samples.push((now, *decoded));
            const KEEP: std::time::Duration = std::time::Duration::from_secs(4);
            while entry
                .gen_samples
                .first()
                .map(|(t, _)| now.saturating_duration_since(*t) > KEEP)
                .unwrap_or(false)
            {
                entry.gen_samples.remove(0);
            }
        }
        EngineEvent::RequestEnd {
            prompt_ms,
            predicted_ms,
            tokens_evaluated,
            tokens_predicted,
            cache_hit_tokens,
            spec_accepted,
            spec_draft,
            lib_prompt_ms,
            seq,
            ..
        } => {
            entry.last_request = Some(RequestSummary {
                prompt_ms: *prompt_ms,
                lib_prompt_ms: *lib_prompt_ms,
                tokens_evaluated: *tokens_evaluated,
                predicted_ms: *predicted_ms,
                tokens_predicted: *tokens_predicted,
                cache_hit_tokens: *cache_hit_tokens,
                spec_accepted: *spec_accepted,
                spec_draft: *spec_draft,
            });
            entry.seq = *seq;
            // Session totals: `request_end` carries per-request counters, the update wants
            // cumulative ones, so accumulate here (reset when the stream reconnects).
            entry.spec_accepted_total += *spec_accepted;
            entry.spec_draft_total += *spec_draft;
            entry.request_closed = true;
        }
    }

    // One request boundary per *wave*, not per lane: a parallel engine emits a PP state per lane,
    // and only the first busy lane of the wave may advance the epoch.
    if opened_wave {
        let busy_now = map
            .iter()
            .filter(|((p, _), e)| *p == port && (e.phase == "PP" || e.phase == "TG"))
            .count();
        if busy_now == 1 {
            bump_request_epoch(port);
        }
    }
}

/// Feed raw SSE text into the per-port snapshot. Test-only; the real path is `stream_once`.
#[cfg(test)]
pub(crate) fn ingest_for_test(port: u16, text: &str) {
    let mut buf = text.to_string();
    for evt in take_frames(&mut buf) {
        apply(port, &evt);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal HTTP endpoint that answers one request with `status` and closes.
    async fn fake_http(status: &'static str) -> u16 {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        tokio::spawn(async move {
            if let Ok((mut sock, _)) = listener.accept().await {
                let mut buf = [0u8; 1024];
                let _ = sock.read(&mut buf).await;
                let body = if status.starts_with("200") { ":ok\n\n" } else { "" };
                let head = format!(
                    "HTTP/1.1 {status}\r\nContent-Type: text/event-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                    body.len()
                );
                let _ = sock.write_all(head.as_bytes()).await;
                let _ = sock.flush().await;
            }
        });
        port
    }

    #[tokio::test]
    async fn probe_reports_only_a_successful_stream() {
        assert!(probe(fake_http("200 OK").await).await, "an SSE endpoint is capable");
        assert!(
            !probe(fake_http("404 Not Found").await).await,
            "an unpatched engine (404) must not be called SSE-capable"
        );
    }

    #[tokio::test]
    async fn probe_is_false_when_nothing_listens() {
        // Bind then drop: the port is closed again, so the connect is refused immediately.
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        assert!(!probe(port).await);
    }

    #[test]
    fn parses_records_and_keeps_partial() {
        let mut buf = String::from(
            "event: state\ndata: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":1,\"peak\":1,\"n_ctx\":8192,\"n_ctx_used\":0,\"seq\":1}\n\n\
             :\n\n\
             event: prompt_progress\ndata: {\"type\":\"prompt_progress\",\"slot\":0,\"total\":8",
        );
        let frames = take_frames(&mut buf);
        assert_eq!(frames.len(), 1, "keep-alive must be skipped, partial kept");
        assert!(matches!(frames[0], EngineEvent::State { .. }));
        assert!(buf.starts_with("event: prompt_progress"));

        buf.push_str("192,\"cache\":0,\"processed\":128,\"time_ms\":40.5,\"seq\":2}\n\n");
        let frames = take_frames(&mut buf);
        assert_eq!(frames.len(), 1);
        match &frames[0] {
            EngineEvent::PromptProgress {
                processed,
                total,
                time_ms,
                ..
            } => {
                assert_eq!((*processed, *total), (128, 8192));
                assert!((time_ms - 40.5).abs() < 1e-9);
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(buf.is_empty());
    }

    #[test]
    fn malformed_frame_is_skipped() {
        let mut buf = String::from("data: {not json}\n\ndata: {\"type\":\"gen_progress\",\"slot\":0,\"decoded\":3,\"gen_ms\":30.0,\"tps\":100.0,\"seq\":7}\n\n");
        let frames = take_frames(&mut buf);
        assert_eq!(frames.len(), 1);
        assert!(matches!(frames[0], EngineEvent::GenProgress { decoded: 3, .. }));
    }

    #[test]
    fn applies_snapshot_and_resets_on_idle() {
        let mut buf = String::from(concat!(
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":1,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":1}\n\n",
            "data: {\"type\":\"prompt_progress\",\"slot\":0,\"total\":2048,\"cache\":0,\"processed\":1024,\"time_ms\":100.0,\"seq\":2}\n\n",
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"IDLE\",\"busy\":0,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":3}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(9001, &evt);
        }
        let snap = snapshot(9001).expect("snapshot");
        assert_eq!(snap.phase, "IDLE");
        assert_eq!(snap.pp_processed, 0, "idle clears the live prefill window");
        assert_eq!(snap.n_ctx, 4096);
    }

    #[test]
    fn prefill_tps_uses_processed_over_time() {
        let t = PortTelemetry {
            pp_processed: 512,
            pp_total: 512,
            pp_time_ms: 128.0,
            ..Default::default()
        };
        assert!((t.prefill_tps() - 4000.0).abs() < 1e-6);
    }

    #[test]
    fn window_rate_smooths_a_burst() {
        let d = std::time::Duration::from_secs;
        let t0 = std::time::Instant::now();
        // one ubatch landing between two samples: a two-sample delta would read 20k/s
        let samples = vec![(t0, 0u64), (t0 + d(1), 1000)];
        assert!((window_rate(&samples, d(2)) - 1000.0).abs() < 1.0);

        // only the samples inside the window count
        let samples = vec![(t0, 0u64), (t0 + d(1), 500), (t0 + d(2), 1000)];
        assert!((window_rate(&samples, d(1)) - 500.0).abs() < 1.0);

        // too short a span is noise, not a measurement
        let samples = vec![(t0, 0u64), (t0 + std::time::Duration::from_millis(10), 500)];
        assert_eq!(window_rate(&samples, d(1)), 0.0);

        assert_eq!(window_rate(&[], d(1)), 0.0);
        assert_eq!(window_rate(&[(t0, 5u64)], d(1)), 0.0);
    }

    #[test]
    fn decode_window_resets_between_requests() {
        let mut buf = String::from(concat!(
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"TG\",\"busy\":1,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":1}\n\n",
            "data: {\"type\":\"gen_progress\",\"slot\":0,\"decoded\":10,\"gen_ms\":100.0,\"tps\":100.0,\"seq\":2}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(9300, &evt);
        }
        assert_eq!(slot_snapshot(9300, 0).unwrap().gen_samples.len(), 1);

        let mut buf = String::from("data: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":1,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":3}\n\n");
        for evt in take_frames(&mut buf) {
            apply(9300, &evt);
        }
        assert!(slot_snapshot(9300, 0).unwrap().gen_samples.is_empty());
    }

    #[test]
    fn aggregate_sums_lanes_for_a_parallel_engine() {
        let mut buf = String::from(concat!(
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"TG\",\"busy\":2,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":100,\"seq\":1}\n\n",
            "data: {\"type\":\"gen_progress\",\"slot\":0,\"decoded\":10,\"gen_ms\":100.0,\"tps\":100.0,\"seq\":2}\n\n",
            "data: {\"type\":\"state\",\"slot\":1,\"phase\":\"TG\",\"busy\":2,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":50,\"seq\":3}\n\n",
            "data: {\"type\":\"gen_progress\",\"slot\":1,\"decoded\":20,\"gen_ms\":100.0,\"tps\":200.0,\"seq\":4}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(9200, &evt);
        }
        let agg = aggregate(9200).expect("aggregate");
        assert_eq!(agg.phase, "TG");
        assert_eq!(agg.gen_tps, 300.0, "system throughput is the sum of lanes");
        assert_eq!(agg.gen_decoded, 30);
        assert_eq!(agg.n_ctx_used, 150);
        assert!(snapshot(9200).is_none(), "two busy lanes have no single answer");
    }

    #[test]
    fn aggregate_prefers_prefill_phase_and_sums_rate() {
        let mut buf = String::from(concat!(
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":2,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":1}\n\n",
            "data: {\"type\":\"prompt_progress\",\"slot\":0,\"total\":2048,\"cache\":0,\"processed\":1024,\"time_ms\":200.0,\"seq\":2}\n\n",
            "data: {\"type\":\"state\",\"slot\":1,\"phase\":\"PP\",\"busy\":2,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":3}\n\n",
            "data: {\"type\":\"prompt_progress\",\"slot\":1,\"total\":2048,\"cache\":0,\"processed\":1024,\"time_ms\":200.0,\"seq\":4}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(9201, &evt);
        }
        let agg = aggregate(9201).expect("aggregate");
        assert_eq!(agg.phase, "PP");
        assert_eq!(agg.pp_processed, 2048);
        assert!((agg.prefill_tps() - 10_240.0).abs() < 1.0, "got {}", agg.prefill_tps());
    }

    #[test]
    fn request_epoch_bumps_only_on_a_new_pp() {
        let port = 9500;
        let before = request_epoch(port);
        let mut buf = String::from(concat!(
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":1,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":1}\n\n",
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"TG\",\"busy\":1,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":100,\"seq\":2}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(port, &evt);
        }
        assert_eq!(request_epoch(port), before + 1, "one PP transition, one request");

        let mut buf = String::from(concat!(
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"IDLE\",\"busy\":0,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":3}\n\n",
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":1,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":4}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(port, &evt);
        }
        assert_eq!(request_epoch(port), before + 2, "the next request is a new epoch");
    }

    #[test]
    fn request_epoch_is_one_per_wave_not_per_lane() {
        let port = 9501;
        let before = request_epoch(port);
        let mut buf = String::from(concat!(
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":1,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":1}\n\n",
            "data: {\"type\":\"state\",\"slot\":1,\"phase\":\"PP\",\"busy\":2,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":2}\n\n",
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"TG\",\"busy\":2,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":50,\"seq\":3}\n\n",
            "data: {\"type\":\"state\",\"slot\":1,\"phase\":\"TG\",\"busy\":2,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":60,\"seq\":4}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(port, &evt);
        }
        assert_eq!(
            request_epoch(port),
            before + 1,
            "a 2-lane wave is one request, not two"
        );
    }

    #[test]
    fn aggregate_wave_start_waits_for_every_busy_lane() {
        let mut buf = String::from(concat!(
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"TG\",\"busy\":2,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":10,\"seq\":1}\n\n",
            "data: {\"type\":\"gen_progress\",\"slot\":0,\"decoded\":5,\"gen_ms\":100.0,\"tps\":50.0,\"seq\":2}\n\n",
            "data: {\"type\":\"state\",\"slot\":1,\"phase\":\"TG\",\"busy\":2,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":3}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(9400, &evt);
        }
        let agg = aggregate(9400).expect("aggregate");
        assert!(!agg.wave_ready, "lane 1 has not produced a token");
        assert_eq!(agg.t_wave_start, None);

        let mut buf = String::from("data: {\"type\":\"gen_progress\",\"slot\":1,\"decoded\":3,\"gen_ms\":50.0,\"tps\":60.0,\"seq\":4}\n\n");
        for evt in take_frames(&mut buf) {
            apply(9400, &evt);
        }
        let agg = aggregate(9400).expect("aggregate");
        assert!(agg.wave_ready, "every busy lane has decoded");
        let lane1_first = slot_snapshot(9400, 1)
            .unwrap()
            .t_first_token
            .expect("lane 1 token");
        assert_eq!(
            agg.t_wave_start,
            Some(lane1_first),
            "the wave clock starts at the LAST lane's first token"
        );
    }

    #[test]
    fn slots_do_not_overwrite_each_other() {
        let mut buf = String::from(concat!(
            "data: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":1,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":1}\n\n",
            "data: {\"type\":\"state\",\"slot\":1,\"phase\":\"IDLE\",\"busy\":1,\"peak\":2,\"n_ctx\":4096,\"n_ctx_used\":77,\"seq\":2}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(9100, &evt);
        }
        assert_eq!(slot_snapshot(9100, 0).unwrap().phase, "PP");
        assert_eq!(slot_snapshot(9100, 1).unwrap().n_ctx_used, 77);
        // one busy slot: the aggregate follows it rather than the most recent frame
        assert_eq!(snapshot(9100).unwrap().phase, "PP");
    }

    #[test]
    fn spec_totals_accumulate_and_close_the_request() {
        let mut buf = String::from(concat!(
            "data: {\"type\":\"request_end\",\"slot\":0,\"task\":1,\"prompt_ms\":100.0,\"predicted_ms\":50.0,",
            "\"tokens_evaluated\":512,\"tokens_predicted\":32,\"cache_hit_tokens\":0,",
            "\"spec_accepted\":10,\"spec_draft\":20,\"lib_prompt_ms\":90.0,\"lib_tokens_evaluated\":512,\"seq\":1}\n\n",
            "data: {\"type\":\"request_end\",\"slot\":0,\"task\":2,\"prompt_ms\":110.0,\"predicted_ms\":60.0,",
            "\"tokens_evaluated\":512,\"tokens_predicted\":32,\"cache_hit_tokens\":0,",
            "\"spec_accepted\":5,\"spec_draft\":10,\"lib_prompt_ms\":95.0,\"lib_tokens_evaluated\":512,\"seq\":2}\n\n"
        ));
        for evt in take_frames(&mut buf) {
            apply(9101, &evt);
        }
        let t = slot_snapshot(9101, 0).unwrap();
        assert_eq!((t.spec_accepted_total, t.spec_draft_total), (15, 30));
        assert!(t.request_closed);

        // next request reopens it
        let mut buf = String::from("data: {\"type\":\"state\",\"slot\":0,\"phase\":\"PP\",\"busy\":1,\"peak\":1,\"n_ctx\":4096,\"n_ctx_used\":0,\"seq\":3}\n\n");
        for evt in take_frames(&mut buf) {
            apply(9101, &evt);
        }
        assert!(!slot_snapshot(9101, 0).unwrap().request_closed);
    }
}
