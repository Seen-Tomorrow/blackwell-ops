import type { MemorySource, VramManifest } from "../lib/types";
import {
  MEMORY_SOURCE_ACCENT,
  MEMORY_SOURCE_LABELS,
} from "../services/vram/memorySource";

interface MemorySourcePanelProps {
  memorySource: MemorySource;
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

/** Two-line SOURCE block — row 1: SOURCE · kind · probe btn; row 2: provenance spread horizontally. */
export default function MemorySourcePanel({
  memorySource,
  isValidating = false,
  hasProbed = false,
  onValidate,
  hideValidate = false,
}: MemorySourcePanelProps) {
  const accent = MEMORY_SOURCE_ACCENT[memorySource.kind];
  const label = MEMORY_SOURCE_LABELS[memorySource.kind];

  return (
    <div className="memory-source-strip flex flex-col justify-between gap-px min-w-0">
      <div className="flex items-center gap-1 min-w-0 text-[8px] font-mono leading-none">
        <span className="text-[7px] tracking-widest text-stealth-muted uppercase shrink-0">
          SOURCE
        </span>
        <span className="text-stealth-muted/40 shrink-0">·</span>
        <span className={`inline-flex items-center gap-0.5 shrink-0 ${accent.text}`}>
          <ConfidencePips level={memorySource.confidence} />
          <span className="memory-source-kind-label tracking-wider">{label}</span>
        </span>
        {onValidate && !hideValidate && (
          <FitProbeButton
            isValidating={isValidating}
            hasProbed={hasProbed}
            onClick={onValidate}
          />
        )}
      </div>

      <div className="flex items-center gap-1 min-w-0 text-[8px] font-mono leading-none text-stealth-muted">
        <span className="truncate min-w-0 flex-1">{memorySource.detail}</span>
        {memorySource.breakdown && (
          <>
            <span className="text-stealth-muted/40 shrink-0">·</span>
            <span className="truncate min-w-0 flex-1 text-stealth-muted/75">
              {memorySource.breakdown}
            </span>
          </>
        )}
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
      className={`fit-probe-btn ml-1 px-1.5 py-px text-[7px] font-mono tracking-widest rounded-sm border whitespace-nowrap shrink-0 transition-colors ${
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