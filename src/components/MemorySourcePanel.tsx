import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { MemorySource, VramManifest } from "../lib/types";
import {
  MEMORY_SOURCE_ACCENT,
  MEMORY_SOURCE_LABELS,
} from "../services/vram/memorySource";

interface MemorySourcePanelProps {
  memorySource: MemorySource;
  manifest?: VramManifest | null;
  isValidating?: boolean;
  hasProbed?: boolean;
  onValidate?: () => void;
  hideValidate?: boolean;
  compact?: boolean;
  /** Optional launch summary included in hover recap. */
  launchSummary?: string;
}

/**
 * Drive live-meter bars via rAF when CSS animations are blocked
 * (Windows "Show animations" off → prefers-reduced-motion). WebView2 still
 * paints transforms if we set them directly each frame.
 */
function useLiveMeterDrive(active: boolean) {
  const barsRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const root = barsRef.current;
    if (!root) return;
    const bars = Array.from(root.querySelectorAll<HTMLElement>(".vram-fc-source__live-bar"));
    if (bars.length === 0) return;

    let raf = 0;
    const t0 = performance.now();
    const phase = bars.map((_, i) => i * 0.37);

    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      for (let i = 0; i < bars.length; i++) {
        const s = 0.18 + 0.82 * (0.5 + 0.5 * Math.sin(t * 4.2 + phase[i]));
        const o = 0.45 + 0.55 * (0.5 + 0.5 * Math.sin(t * 4.2 + phase[i] + 0.4));
        bars[i].style.transform = `scaleY(${s.toFixed(3)})`;
        bars[i].style.opacity = o.toFixed(3);
      }
      const meter = root.parentElement;
      if (meter) {
        const sweep = meter.querySelector<HTMLElement>(".vram-fc-source__live-meter-sweep");
        const scan = meter.querySelector<HTMLElement>(".vram-fc-source__live-meter-scan");
        if (sweep) {
          const x = ((t * 0.8) % 1.4) * 280 - 130;
          sweep.style.transform = `translateX(${x.toFixed(1)}%)`;
        }
        if (scan) {
          const y = 1 + (0.5 + 0.5 * Math.sin(t * 3.0)) * 8;
          scan.style.transform = `translateY(${y.toFixed(2)}px)`;
          scan.style.opacity = (0.35 + 0.6 * (0.5 + 0.5 * Math.sin(t * 3.0))).toFixed(3);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [active]);
  return barsRef;
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

function kindDisplayLabel(kind: MemorySource["kind"]): string {
  // LEARNED static/live share the same root word; status slot differentiates.
  if (kind === "learned_curve" || kind === "learned") return "LEARNED";
  return MEMORY_SOURCE_LABELS[kind];
}

interface RecapBits {
  summary?: string;
  kindLabel: string;
  detail?: string;
  breakdown?: string;
  secondary?: string;
}

function collectRecap(
  memorySource: MemorySource,
  kindLabel: string,
  launchSummary?: string,
): RecapBits {
  return {
    summary: launchSummary?.trim() || undefined,
    kindLabel,
    detail: memorySource.detail?.trim() || undefined,
    breakdown: memorySource.breakdown?.trim() || undefined,
    secondary: memorySource.breakdownSecondary?.trim() || undefined,
  };
}

export default function MemorySourcePanel({
  memorySource,
  isValidating = false,
  hasProbed = false,
  onValidate,
  hideValidate = false,
  launchSummary,
}: MemorySourcePanelProps) {
  const accent = MEMORY_SOURCE_ACCENT[memorySource.kind];
  const kindLabel = kindDisplayLabel(memorySource.kind);
  const isCurve = memorySource.kind === "learned_curve";
  const isFitProbe = memorySource.kind === "fit_probe";
  const isLiveMeter = isCurve || isFitProbe;
  const showStatusSlot =
    memorySource.kind === "learned" || isCurve || isFitProbe;
  const recap = collectRecap(memorySource, kindLabel, launchSummary);
  const tipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const barsRef = useLiveMeterDrive(isLiveMeter);
  const [open, setOpen] = useState(false);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  return (
    <div
      ref={rootRef}
      className="vram-fc-source memory-source-strip vram-fc-source--inline vram-fc-source--dominant"
      data-source-kind={memorySource.kind}
      data-source-layout="inline"
      data-tip-open={open ? "1" : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <div className="vram-fc-source__head memory-source-header">
        <span className="vram-fc-source__lab">MEMORY FORECAST SOURCE</span>
        <span className={`vram-fc-source__kind ${accent.text}`}>
          <ConfidencePips level={memorySource.confidence} />
          <span className="memory-source-kind-label vram-fc-source__kind-lab">
            {kindLabel}
          </span>
          {/* Fixed-width status slot — static vs live never shifts the row */}
          {showStatusSlot ? (
            <span
              className="vram-fc-source__status-slot"
              data-live={isLiveMeter ? "1" : "0"}
              data-kind={memorySource.kind}
            >
              {isLiveMeter ? (
                <span
                  className={`vram-fc-source__live-meter${
                    isFitProbe ? " vram-fc-source__live-meter--probe" : ""
                  }${isValidating ? " is-probing" : ""}`}
                  title={
                    isFitProbe
                      ? isValidating
                        ? "FIT PROBE running — measuring VRAM"
                        : "FIT PROBE memory measurement"
                      : "Live memory measurement — interpolating between measured launches"
                  }
                  aria-label={
                    isFitProbe ? "FIT PROBE memory measurement" : "Live memory measurement"
                  }
                >
                  <span
                    ref={barsRef}
                    className="vram-fc-source__live-meter-bars"
                    aria-hidden
                  >
                    {[0, 1, 2, 3, 4, 5, 6, 7].map((i) => (
                      <i key={i} className="vram-fc-source__live-bar" />
                    ))}
                  </span>
                  <span className="vram-fc-source__live-meter-sweep" aria-hidden />
                  <span className="vram-fc-source__live-meter-scan" aria-hidden />
                </span>
              ) : (
                <span className="vram-fc-source__prev-lab">(from previous run)</span>
              )}
            </span>
          ) : null}
        </span>
        {onValidate && !hideValidate ? (
          <FitProbeButton
            isValidating={isValidating}
            hasProbed={hasProbed}
            onClick={onValidate}
          />
        ) : null}
      </div>

      {open ? (
        <div
          id={tipId}
          className="vram-fc-recap"
          role="tooltip"
          data-source-kind={memorySource.kind}
        >
          {recap.summary ? (
            <div className="vram-fc-recap__summary">{recap.summary}</div>
          ) : null}
          <div className="vram-fc-recap__row">
            <span className="vram-fc-recap__k">SOURCE</span>
            <span className={`vram-fc-recap__v vram-fc-recap__v--kind ${accent.text}`}>
              {isCurve
                ? "LEARNED · live measure"
                : memorySource.kind === "learned"
                  ? "LEARNED (from previous run)"
                  : isFitProbe
                    ? "FIT PROBE · measured"
                    : recap.kindLabel}
            </span>
          </div>
          {recap.detail ? (
            <div className="vram-fc-recap__row">
              <span className="vram-fc-recap__k">WHEN</span>
              <span className="vram-fc-recap__v">{recap.detail}</span>
            </div>
          ) : null}
          {recap.breakdown ? (
            <div className="vram-fc-recap__block">
              <span className="vram-fc-recap__k">SPLIT</span>
              <span className="vram-fc-recap__v vram-fc-recap__v--mono">{recap.breakdown}</span>
            </div>
          ) : null}
          {recap.secondary ? (
            <div className="vram-fc-recap__block">
              <span className="vram-fc-recap__k">HOST</span>
              <span className="vram-fc-recap__v vram-fc-recap__v--mono">{recap.secondary}</span>
            </div>
          ) : null}
          <div className="vram-fc-recap__foot">hover recap · cockpit has the knobs</div>
        </div>
      ) : null}
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
