import type { MemorySource, VramManifest } from "../lib/types";
import {
  MEMORY_SOURCE_ACCENT,
  MEMORY_SOURCE_LABELS,
} from "../services/vram/memorySource";

interface MemorySourcePanelProps {
  memorySource: MemorySource;
  /** Full manifest (reserved for detail wiring). */
  manifest?: VramManifest | null;
  isValidating?: boolean;
  hasProbed?: boolean;
  onValidate?: () => void;
  hideValidate?: boolean;
  /**
   * true  → one-line SOURCE · KIND · detail (FULL AUTO)
   * false → header + original detail/breakdown stack (ASSISTED)
   */
  compact?: boolean;
}

function ConfidencePips({ level }: { level: MemorySource["confidence"] }) {
  return (
    <span className="vram-fc-source__pips" aria-hidden>
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={`vram-fc-source__pip${n <= level ? " is-on" : ""}`}
        />
      ))}
    </span>
  );
}

/** SOURCE instrument — compact strip or full memory breakdown. */
export default function MemorySourcePanel({
  memorySource,
  isValidating = false,
  hasProbed = false,
  onValidate,
  hideValidate = false,
  compact = true,
}: MemorySourcePanelProps) {
  const accent = MEMORY_SOURCE_ACCENT[memorySource.kind];
  const label = MEMORY_SOURCE_LABELS[memorySource.kind];
  const detail = memorySource.detail?.trim() || "";

  return (
    <div
      className={`vram-fc-source memory-source-strip${compact ? " vram-fc-source--inline" : ""}`}
      data-source-kind={memorySource.kind}
      data-source-layout={compact ? "inline" : "stack"}
      title={[label, detail, memorySource.breakdown, memorySource.breakdownSecondary]
        .filter(Boolean)
        .join(" · ")}
    >
      <div className="vram-fc-source__head memory-source-header">
        <span className="vram-fc-source__lab">SOURCE</span>
        <span className={`vram-fc-source__kind ${accent.text}`}>
          <ConfidencePips level={memorySource.confidence} />
          <span className="memory-source-kind-label vram-fc-source__kind-lab">
            {label}
          </span>
        </span>
        {compact && detail ? (
          <>
            <span className="vram-fc-source__dot" aria-hidden>
              ·
            </span>
            <span className="vram-fc-source__detail">{detail}</span>
          </>
        ) : null}
        {onValidate && !hideValidate && (
          <FitProbeButton
            isValidating={isValidating}
            hasProbed={hasProbed}
            onClick={onValidate}
          />
        )}
      </div>

      {!compact && (
        <div className="vram-fc-source__body memory-source-body">
          <span className="memory-source-body__line memory-source-body__line--detail vram-fc-source__line">
            {memorySource.detail || "\u00a0"}
          </span>
          <span
            className={`memory-source-body__line memory-source-body__line--breakdown vram-fc-source__line${
              memorySource.breakdown ? "" : " memory-source-body__line--empty"
            }`}
          >
            {memorySource.breakdown || "\u00a0"}
          </span>
          <span
            className={`memory-source-body__line memory-source-body__line--secondary vram-fc-source__line${
              memorySource.breakdownSecondary ? "" : " memory-source-body__line--empty"
            }`}
          >
            {memorySource.breakdownSecondary || "\u00a0"}
          </span>
        </div>
      )}
    </div>
  );
}

export function manifestHasFitProbe(manifest: VramManifest): boolean {
  return manifest.memorySource?.kind === "fit_probe";
}

interface FitProbeButtonProps {
  isValidating?: boolean;
  hasProbed?: boolean;
  onClick?: () => void;
}

export function FitProbeButton({
  isValidating = false,
  hasProbed = false,
  onClick,
}: FitProbeButtonProps) {
  if (!onClick) return null;

  const state = isValidating ? "probing" : hasProbed ? "reprobe" : "idle";

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isValidating}
      data-probe-state={state}
      className="vram-fc-probe fit-probe-btn"
    >
      {isValidating ? "PROBING…" : hasProbed ? "RE-PROBE" : "FIT PROBE"}
    </button>
  );
}
