import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { MemorySource, VramManifest } from "../lib/types";
import {
  MEMORY_SOURCE_ACCENT,
  MEMORY_SOURCE_LABELS,
} from "../services/vram/memorySource";
import {
  EVENTS,
  type CtxSliderDraggingDetail,
} from "../lib/events";

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

const CTX_DRAG_COAST_MS = 300;

/** Listen for CTX slider drag (+ short coast after release). */
function useCtxSliderDragging(): boolean {
  const [dragging, setDragging] = useState(false);
  const [coast, setCoast] = useState(false);

  useEffect(() => {
    let coastTimer: ReturnType<typeof setTimeout> | undefined;
    const onDrag = (ev: Event) => {
      const detail = (ev as CustomEvent<CtxSliderDraggingDetail>).detail;
      const next = Boolean(detail?.dragging);
      clearTimeout(coastTimer);
      coastTimer = undefined;
      if (next) {
        setDragging(true);
        setCoast(false);
      } else {
        setDragging(false);
        setCoast(true);
        coastTimer = setTimeout(() => {
          setCoast(false);
          coastTimer = undefined;
        }, CTX_DRAG_COAST_MS);
      }
    };
    window.addEventListener(EVENTS.ctxSliderDragging, onDrag);
    return () => {
      window.removeEventListener(EVENTS.ctxSliderDragging, onDrag);
      clearTimeout(coastTimer);
    };
  }, []);

  return dragging || coast;
}

/**
 * Vertical equalizer + scanline via rAF (no horizontal sweep).
 * CSS keyframes die under Windows animations-off / prefers-reduced-motion.
 */
function useLiveMeterDrive(active: boolean) {
  const barsRef = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const root = barsRef.current;
    if (!root) return;
    const bars = Array.from(root.querySelectorAll<HTMLElement>(".vram-fc-source__live-bar"));
    if (bars.length === 0) return;
    const meter = root.parentElement;
    const scan = meter?.querySelector<HTMLElement>(".vram-fc-source__live-meter-scan") ?? null;

    let raf = 0;
    const t0 = performance.now();
    const phase = bars.map((_, i) => i * 0.38);

    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      for (let i = 0; i < bars.length; i++) {
        const s = 0.16 + 0.84 * (0.5 + 0.5 * Math.sin(t * 3.8 + phase[i]));
        const o = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(t * 3.8 + phase[i] + 0.4));
        bars[i].style.transform = `scaleY(${s.toFixed(3)})`;
        bars[i].style.opacity = o.toFixed(3);
      }
      if (scan) {
        const y = 1 + (0.5 + 0.5 * Math.sin(t * 2.8)) * 8;
        scan.style.transform = `translateY(${y.toFixed(2)}px)`;
        scan.style.opacity = (0.35 + 0.55 * (0.5 + 0.5 * Math.sin(t * 2.8))).toFixed(3);
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      for (const bar of bars) {
        bar.style.transform = "";
        bar.style.opacity = "";
      }
      if (scan) {
        scan.style.transform = "";
        scan.style.opacity = "";
      }
    };
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

function sourceRecapLabel(memorySource: MemorySource): string {
  if (memorySource.kind === "learned") return "LEARNED · EXACT (previous launch)";
  if (memorySource.kind === "learned_curve") return "LEARNED · INTERPOLATED";
  if (memorySource.kind === "fit_probe") {
    return memorySource.exact === false ? "FIT PROBE · ESTIMATE" : "FIT PROBE · MEASURED";
  }
  return MEMORY_SOURCE_LABELS[memorySource.kind];
}
/** MEMORY FORECAST SOURCE — exact / estimate / live meter while CTX drag. */
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
  const isLearnedExact = memorySource.kind === "learned";
  const isExact = memorySource.exact !== false && !isCurve;
  const isEstimate = isCurve || (isFitProbe && memorySource.exact === false);

  const ctxDragging = useCtxSliderDragging();
  // Meter only while scrubbing CTX (or active PROBE).
  const meterActive =
    isValidating || (ctxDragging && (isEstimate || isFitProbe || isCurve));

  const showStatusSlot = isLearnedExact || isCurve || isFitProbe;
  // Exact measurement already locked — PROBE does nothing useful here.
  const canProbe = Boolean(onValidate) && !hideValidate && !isExact;

  const recap = collectRecap(memorySource, kindLabel, launchSummary);
  const tipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const barsRef = useLiveMeterDrive(meterActive);
  const [open, setOpen] = useState(false);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  // Hero status — more important than LEARNED / FIT PROBE kind word.
  const idleStatus = (() => {
    if (isLearnedExact) return "EXACT";
    if (isCurve) return "INTERPOLATED";
    if (isFitProbe) return isExact ? "MEASURED" : "ESTIMATE";
    return null;
  })();

  const probeLabel = isValidating ? "PROBING…" : "RE-PROBE";

  return (
    <div
      ref={rootRef}
      className="vram-fc-source memory-source-strip vram-fc-source--inline vram-fc-source--dominant"
      data-source-kind={memorySource.kind}
      data-source-exact={isExact ? "1" : "0"}
      data-source-layout="inline"
      data-ctx-dragging={ctxDragging ? "1" : undefined}
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
        </span>
        {showStatusSlot ? (
          <span
            className="vram-fc-source__status-slot"
            data-live={meterActive ? "1" : "0"}
            data-kind={memorySource.kind}
            data-has-probe={canProbe ? "1" : "0"}
          >
            <span className="vram-fc-source__status-main">
              {meterActive ? (
                <span
                  className={`vram-fc-source__live-meter${
                    isFitProbe ? " vram-fc-source__live-meter--probe" : ""
                  }${isValidating ? " is-probing" : ""}`}
                  title={
                    isValidating
                      ? "FIT PROBE running — measuring VRAM"
                      : isFitProbe
                        ? isExact
                          ? "FIT PROBE measured at this CTX"
                          : "FIT PROBE estimate — scrubbing CTX"
                        : "LEARNED interpolation — scrubbing CTX"
                  }
                  aria-label="Live memory measurement"
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
                  <span className="vram-fc-source__live-meter-scan" aria-hidden />
                </span>
              ) : (
                <span
                  className={`vram-fc-source__status-hero${
                    isExact ? " is-exact" : " is-estimate"
                  }`}
                  title={
                    isLearnedExact
                      ? "Exact launch measurement at this CTX"
                      : isCurve
                        ? "Interpolated between learned launches"
                        : isExact
                          ? "FIT PROBE measurement at this CTX"
                          : "Estimate adjusted from probe anchor — re-probe to lock"
                  }
                >
                  {idleStatus}
                </span>
              )}
            </span>
            {canProbe ? (
              <button
                type="button"
                className="vram-fc-source__reprobe"
                data-probe-state={isValidating ? "probing" : "reprobe"}
                disabled={isValidating}
                onClick={(e) => {
                  e.stopPropagation();
                  onValidate?.();
                }}
                title="Run FIT PROBE at this CTX to lock a measured point"
              >
                {probeLabel}
              </button>
            ) : null}
          </span>
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
              {sourceRecapLabel(memorySource)}
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
          {isEstimate ? (
            <div className="vram-fc-recap__foot">
              estimate — RE-PROBE at this CTX to lock a measured point
            </div>
          ) : (
            <div className="vram-fc-recap__foot">hover recap · cockpit has the knobs</div>
          )}
        </div>
      ) : null}
    </div>
  );
}

export function manifestHasFitProbe(manifest: VramManifest): boolean {
  return manifest.memorySource?.kind === "fit_probe";
}
