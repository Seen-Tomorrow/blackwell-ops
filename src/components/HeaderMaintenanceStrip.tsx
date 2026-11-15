import { useEffect, useState } from "react";
import { cancelMetadataScan, getMetadataJob, subscribeLibraryJobs } from "../lib/libraryJobs";

function baseName(path: string | null): string | null {
  if (!path) return null;
  const parts = path.split(/[/\\]/);
  const leaf = parts[parts.length - 1];
  return leaf ? leaf.replace(/\.gguf$/i, "") : null;
}

/** Re-render on any store change - the store holds the truth, this just wakes up. */
function useJobTick(): void {
  const [, setTick] = useState(0);
  useEffect(() => subscribeLibraryJobs(() => setTick((t) => t + 1)), []);
}

/**
 * The metadata pass in the page header (per model, CPU only).
 *
 * Reads the shared job store directly, so it shows the same progress whatever started the run: the
 * first-run backfill or the catalog's SCAN META. The library-wide VRAM fit scan that used to share
 * this strip is gone; a model is measured on demand and by its own launches.
 */
export default function HeaderMaintenanceStrip() {
  useJobTick();
  const metadata = getMetadataJob();

  if (metadata.status !== "running") return null;

  const done = metadata.done;
  const total = metadata.total;
  const pct = total > 0 ? Math.min(100, (done / total) * 100) : 0;
  const label = "MODEL METADATA SCAN";
  const mode = metadata.manual ? "MANUAL SCAN" : "ONE-TIME SCAN";
  const detail = `Model metadata scan - ${done} of ${total} models parsed`;
  const current = baseName(metadata.current);

  return (
    <div
      className="hdr-maint-strip flex items-center gap-2 flex-shrink-0"
      data-job="metadata"
      title={current ? `${detail}\nModel ${current}` : detail}
    >
      {/* Model first: it is the only variable-width cell. With a fixed width it is the left edge
          that moves, and the strip is right-anchored - so progress, mode and buttons keep a stable
          position instead of sliding as names change. */}
      {current && (
        <span className="hdr-maint-strip__current" title={`Model ${current}`}>
          Model {current}
        </span>
      )}
      <span className="hdr-maint-strip__label">{label}</span>
      <span className="hdr-maint-strip__count">
        {done}/{total || "?"}
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
      <button
        type="button"
        className="hdr-maint-strip__btn hdr-maint-strip__btn--stop"
        onClick={() => cancelMetadataScan()}
        aria-label="Stop metadata scan"
        title="Stop"
      >
        ✕
      </button>
    </div>
  );
}
