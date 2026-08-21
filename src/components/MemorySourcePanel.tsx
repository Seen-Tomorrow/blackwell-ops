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
   * true  → one-line SOURCE · KIND · [RE-PROBE]
   * false → same head (legacy stack removed — recap is tooltip-only)
   */
  compact?: boolean;
  /** Optional launch summary included in hover recap. */
  launchSummary?: string;
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

function buildRecapTooltip(
  memorySource: MemorySource,
  label: string,
  launchSummary?: string,
): string {
  const lines: string[] = [];
  if (launchSummary?.trim()) lines.push(launchSummary.trim());
  lines.push(`SOURCE · ${label}`);
  if (memorySource.detail?.trim()) lines.push(memorySource.detail.trim());
  if (memorySource.breakdown?.trim()) lines.push(memorySource.breakdown.trim());
  if (memorySource.breakdownSecondary?.trim()) {
    lines.push(memorySource.breakdownSecondary.trim());
  }
  return lines.join("\n");
}

/** SOURCE instrument — dominant kind chip + optional RE-PROBE; full recap on hover. */
export default function MemorySourcePanel({
  memorySource,
  isValidating = false,
  hasProbed = false,
  onValidate,
  hideValidate = false,
  compact: _compact = true,
  launchSummary,
}: MemorySourcePanelProps) {
  const accent = MEMORY_SOURCE_ACCENT[memorySource.kind];
  const label = MEMORY_SOURCE_LABELS[memorySource.kind];
  const tip = buildRecapTooltip(memorySource, label, launchSummary);

  return (
    <div
      className="vram-fc-source memory-source-strip vram-fc-source--inline vram-fc-source--dominant"
      data-source-kind={memorySource.kind}
      data-source-layout="inline"
      title={tip}
    >
      <div className="vram-fc-source__head memory-source-header">
        <span className="vram-fc-source__lab">SOURCE</span>
        <span className={`vram-fc-source__kind ${accent.text}`}>
          <ConfidencePips level={memorySource.confidence} />
          <span className="memory-source-kind-label vram-fc-source__kind-lab">
            {label}
          </span>
        </span>
        {onValidate && !hideValidate ? (
          <FitProbeButton
            isValidating={isValidating}
            hasProbed={hasProbed}
            onClick={onValidate}
          />
        ) : null}
      </div>
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
      {isValidating ? "PROBING…" : hasProbed ? "RE-PROBE" : "PROBE"}
    </button>
  );
}
