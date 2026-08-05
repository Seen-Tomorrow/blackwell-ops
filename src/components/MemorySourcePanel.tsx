import type { MemorySource, VramManifest } from "../lib/types";
import {
  MEMORY_SOURCE_ACCENT,
  MEMORY_SOURCE_LABELS,
} from "../services/vram/memorySource";
import { resolveSplitDriver } from "../lib/autoVramLaunch";

interface MemorySourcePanelProps {
  memorySource: MemorySource;
  /** Full manifest — lets the SOURCE strip show what drives the split/device decision. */
  manifest?: VramManifest | null;
  isValidating?: boolean;
  hasProbed?: boolean;
  onValidate?: () => void;
  hideValidate?: boolean;
}

function ConfidencePips({ level }: { level: MemorySource["confidence"] }) {
  return (
    <span className="inline-flex gap-px shrink-0" aria-hidden>
      {[1, 2, 3, 4].map((n) => (
        <span
          key={n}
          className={`inline-block w-[3px] h-[3px] rounded-full ${
            n <= level ? "bg-current opacity-90" : "bg-current opacity-25"
          }`}
        />
      ))}
    </span>
  );
}

/** SOURCE block — header + fixed 3 body slots (detail / breakdown / secondary).
 *  Always mount all three lines so formula ↔ learned ↔ FIT cache never shifts VramBadge height. */
export default function MemorySourcePanel({
  memorySource,
  manifest,
  isValidating = false,
  hasProbed = false,
  onValidate,
  hideValidate = false,
}: MemorySourcePanelProps) {
  const accent = MEMORY_SOURCE_ACCENT[memorySource.kind];
  const label = MEMORY_SOURCE_LABELS[memorySource.kind];
  const driver = manifest ? resolveSplitDriver(manifest) : null;

  return (
    <div className="memory-source-strip flex flex-col gap-px min-w-0">
      <div className="memory-source-header flex items-center gap-1 min-w-0 text-[8px] font-mono leading-none">
        <span className="text-[7px] tracking-widest text-stealth-muted uppercase shrink-0">
          SOURCE
        </span>
        <span className="text-stealth-muted/40 shrink-0">·</span>
        <span className={`inline-flex items-center gap-0.5 shrink-0 ${accent.text}`}>
          <ConfidencePips level={memorySource.confidence} />
          <span className="memory-source-kind-label tracking-wider">{label}</span>
        </span>
        {driver && (
          <span
            className={`inline-flex items-center gap-0.5 shrink-0 border rounded-sm px-1 py-px text-[7px] leading-none tracking-wider ${
              driver.willSplit
                ? "border-violet-400/40 text-violet-300"
                : driver.measured
                  ? "border-nv-green/50 text-nv-green"
                  : "border-stealth-muted/40 text-stealth-muted"
            }`}
            title={`Split decision driven by ${driver.label} estimate (~${driver.estimateGb.toFixed(1)} GB). ${
              driver.willSplit
                ? "Forecast exceeds best single GPU → layer split."
                : "Fits a single GPU."
            }`}
          >
            {driver.willSplit ? "SPLIT" : "SINGLE"}:{driver.label}
          </span>
        )}
        {onValidate && !hideValidate && (
          <FitProbeButton
            isValidating={isValidating}
            hasProbed={hasProbed}
            onClick={onValidate}
          />
        )}
      </div>

      <div className="memory-source-body min-w-0 text-[8px] font-mono text-stealth-muted">
        <span className="memory-source-body__line memory-source-body__line--detail">
          {memorySource.detail || "\u00a0"}
        </span>
        <span
          className={`memory-source-body__line memory-source-body__line--breakdown${
            memorySource.breakdown ? "" : " memory-source-body__line--empty"
          }`}
        >
          {memorySource.breakdown || "\u00a0"}
        </span>
        <span
          className={`memory-source-body__line memory-source-body__line--secondary${
            memorySource.breakdownSecondary ? "" : " memory-source-body__line--empty"
          }`}
        >
          {memorySource.breakdownSecondary || "\u00a0"}
        </span>
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

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isValidating}
      className={`fit-probe-btn px-1.5 py-px text-[7px] font-mono tracking-widest rounded-sm border whitespace-nowrap shrink-0 transition-colors ${
        isValidating
          ? "border-yellow-400/40 text-yellow-400 cursor-wait animate-pulse"
          : hasProbed
            ? "border-amber-400/50 text-amber-400 hover:bg-amber-400/10"
            : "border-stealth-muted/50 text-stealth-muted hover:text-white hover:border-stealth-muted"
      }`}
    >
      {isValidating ? "⟳ PROBING…" : hasProbed ? "↻ RE-PROBE" : "RUN FIT PROBE"}
    </button>
  );
}