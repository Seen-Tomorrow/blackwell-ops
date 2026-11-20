/**
 * Tune progress lives here, not in the instrument.
 *
 * The EXPERT CACHE block is re-mounted whenever the cockpit trades places (ASSISTED ⇄ FULL, a
 * device change, a model reload). Component state died with it and the progress bar vanished while
 * the Rust side kept launching engines. This module keeps the last known status and the Tauri
 * subscription for the life of the page, so a remount simply re-reads it.
 */

export interface TuneProgressEvent {
  index: number;
  total: number;
  status: "running" | "done";
  cpu_moe?: boolean;
  cache_mib?: number;
  cpu_share?: number;
  tps?: number | null;
}

export interface TuneStatus {
  running: boolean;
  done: number;
  total: number;
  startedAt: number | null;
  lastLabel: string | null;
}

let status: TuneStatus = {
  running: false,
  done: 0,
  total: 0,
  startedAt: null,
  lastLabel: null,
};

const listeners = new Set<() => void>();
let subscribed = false;

function notify(): void {
  for (const cb of listeners) cb();
}

function update(next: Partial<TuneStatus>): void {
  status = { ...status, ...next };
  notify();
}

export function getTuneStatus(): TuneStatus {
  return status;
}

export function subscribeTuneStatus(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Called by the instrument when it starts a run; the first progress event corrects the total. */
export function markTuneStarted(): void {
  update({ running: true, done: 0, total: 0, startedAt: Date.now(), lastLabel: "starting" });
}

export function markTuneFinished(): void {
  update({ running: false, lastLabel: "done" });
}

export function applyTuneProgress(evt: TuneProgressEvent): void {
  if (!evt) return;
  const label =
    evt.status === "done"
      ? `${evt.cpu_moe === false ? "full GPU" : `cache ${evt.cache_mib ?? 0} MiB`}${evt.tps != null ? ` · ${evt.tps.toFixed(1)} t/s` : ""}`
      : evt.cpu_moe === false
        ? "full GPU"
        : `cache ${evt.cache_mib ?? 0} MiB${evt.cpu_share ? ` · share ${evt.cpu_share}` : ""}`;
  update({
    running: evt.status === "running",
    done: evt.status === "done" ? evt.index + 1 : evt.index,
    total: evt.total > 0 ? evt.total : status.total,
    startedAt: status.startedAt ?? Date.now(),
    lastLabel: label,
  });
}

/**
 * One subscription for the page. Registered lazily on first mount, never torn down by a remount.
 */
export function ensureTuneStatusSubscription(): void {
  if (subscribed) return;
  const listen = (window as unknown as {
    __TAURI__?: { event?: { listen?: (event: string, cb: (e: { payload: TuneProgressEvent }) => void) => Promise<() => void> } };
  }).__TAURI__?.event?.listen;
  if (!listen) return;
  subscribed = true;
  void listen("moe-tune-progress", (e) => applyTuneProgress(e.payload)).catch(() => {
    // Leave `subscribed` true: one failed registration must not spawn duplicates on every mount.
  });
}
