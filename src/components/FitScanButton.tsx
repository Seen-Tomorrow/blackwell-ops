import { useEffect, useState } from "react";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import { KEYS, readStorage } from "../lib/storage";
import { getRunningFitSession, startFitScan, stopFitScan } from "../lib/libraryJobs";
import { subscribeFitScanSessions } from "../lib/fitScanSessionStore";

/** Library VRAM fit scan, on demand.
 *
 *  The library schedule only probes models it has not measured yet (and the first
 *  contact is the path-add autotrigger), so there was no way to re-measure or to fill
 *  a half-scanned library after the providers page lost its FIT section. This is that
 *  trigger; it reuses the same session store, so progress and the running scan are the
 *  ones the schedule owns and a second start still reports `busy`.
 *
 *  Shift-click re-measures everything — measurements do not survive a driver or engine
 *  change, and the incremental pass would otherwise report "nothing to do". */
const FIT_PARALLEL = 2;

function formatRemaining(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.round(seconds / 60)}m`;
}

export function FitScanButton() {
  const [, setRevision] = useState(0);
  useEffect(() => subscribeFitScanSessions(() => setRevision((r) => r + 1)), []);

  const running = getRunningFitSession();
  const buttonBase = "px-3 py-1 type-label font-mono border transition-colors";

  if (running) {
    // `runCompleted` is the live per-run counter; `completed` is only settled at the end.
    const done = running.state.runCompleted ?? 0;
    const total = Math.max(running.state.totalModels ?? 0, done);
    const failed = running.state.failed ?? 0;
    const remaining =
      done > 0 && total > done
        ? ((Date.now() - running.state.scanStartTime) / done) * (total - done)
        : NaN;
    const eta = formatRemaining(remaining);
    const detail = failed > 0 ? `${failed} failed` : eta ? `~${eta} left` : "";
    return (
      <button
        type="button"
        onClick={() => void stopFitScan(running.providerId)}
        title="VRAM fit scan running — click to stop"
        className={`${buttonBase} cfg-bord--dng--a30 cfg-dng hover:cfg-fill--dng--a15`}
      >
        {detail ? `FIT ${done}/${total} · ${detail} · STOP` : `FIT ${done}/${total} · STOP`}
      </button>
    );
  }

  const providerId = readStorage(KEYS.lastProvider) || DEFAULT_PROVIDER_ID;

  const start = (forceRescan: boolean) => {
    if (
      forceRescan &&
      !window.confirm(
        "Re-measure VRAM for every model in the library?\n\nA full pass takes far longer than the incremental one.",
      )
    ) {
      return;
    }
    void startFitScan(providerId, FIT_PARALLEL, forceRescan, { manual: true });
  };

  return (
    <button
      type="button"
      onClick={(e) => start(e.shiftKey)}
      title="Measure VRAM for models without data. Shift-click to re-measure everything."
      className={`${buttonBase} cfg-bord--acc--a60 cfg-acc hover:cfg-fill--a15`}
    >
      RUN FIT SCAN
    </button>
  );
}
