import { useEffect, useState } from "react";
import {
  cancelMetadataScan,
  getMetadataJob,
  getRunningFitSession,
  snoozeFitScan,
  stopFitScan,
  subscribeLibraryJobs,
} from "../lib/libraryJobs";
import { subscribeFitScanSessions } from "../lib/fitScanSessionStore";

function baseName(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[/\\]/);
  const leaf = parts[parts.length - 1];
  return leaf ? leaf.replace(/\.gguf$/i, "") : null;
}

/** Re-render on any store change — the stores hold the truth, this just wakes up. */
function useJobTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((t) => t + 1);
    const unsubscribeJobs = subscribeLibraryJobs(bump);
    const unsubscribeFit = subscribeFitScanSessions(bump);
    return () => {
      unsubscribeJobs();
      unsubscribeFit();
    };
  }, []);
}

/**
 * Background library passes in the page header — metadata (per model, CPU) then
 * the VRAM fit scan (GPU, minutes).
 *
 * Reads the shared job stores directly, so it shows the same progress whatever
 * started the run: the first-run backfill, the catalog's SCAN META, or CONFIG's
 * SCAN LIBRARY. Each row stops independently; the fit row also carries NOT NOW,
 * which keeps it quiet for a day.
 */
export default function HeaderMaintenanceStrip() {
  useJobTick();
  const metadata = getMetadataJob();
  const fit = getRunningFitSession();

  const view =
    metadata.status === "running"
      ? {
          kind: "metadata" as const,
          done: metadata.done,
          total: metadata.total,
          manual: metadata.manual,
          current: baseName(metadata.current),
          providerId: null as string | null,
        }
      : fit
        ? {
            kind: "fit" as const,
            // Models finished in this run — the results map also carries cached
            // entries, so counting it would show 60/12 on an incremental pass.
            done: fit.state.runCompleted ?? 0,
            total: fit.state.totalModels,
            manual: fit.state.manual ?? false,
            current: baseName(fit.state.activeModelPath ?? null),
            providerId: fit.providerId,
          }
        : null;

  if (!view) return null;

  const isFit = view.kind === "fit";
  const pct = view.total > 0 ? Math.min(100, (view.done / view.total) * 100) : 0;
  const label = isFit ? "VRAM FIT SCAN" : "MODEL METADATA SCAN";
  const mode = view.manual ? "MANUAL SCAN" : "ONE-TIME SCAN";
  const detail = isFit
    ? `VRAM fit scan — ${view.done} of ${view.total} models measured`
    : `Model metadata scan — ${view.done} of ${view.total} models parsed`;

  return (
    <div
      className="hdr-maint-strip flex items-center gap-2 flex-shrink-0"
      data-job={view.kind}
      title={view.current ? `${detail}\nModel ${view.current}` : detail}
    >
      <span className="hdr-maint-strip__label">{label}</span>
      <span className="hdr-maint-strip__count">
        {view.done}/{view.total || "?"}
      </span>
      <span
        className="hdr-maint-strip__track"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
      >
        <span className="hdr-maint-strip__fill" style={{ width: `${pct}%` }} />
      </span>
      <span className="hdr-maint-strip__mode">{mode}</span>
      {view.current && (
        <span className="hdr-maint-strip__current">Model {view.current}</span>
      )}
      {isFit && view.providerId && (
        <button
          type="button"
          className="hdr-maint-strip__btn"
          onClick={() => void snoozeFitScan(view.providerId!)}
          title="Stop the fit scan and keep it off for a day"
        >
          NOT NOW
        </button>
      )}
      <button
        type="button"
        className="hdr-maint-strip__btn hdr-maint-strip__btn--stop"
        onClick={() => {
          if (isFit && view.providerId) void stopFitScan(view.providerId);
          else cancelMetadataScan();
        }}
        aria-label={`Stop ${isFit ? "VRAM fit scan" : "metadata scan"}`}
        title="Stop"
      >
        ✕
      </button>
    </div>
  );
}
