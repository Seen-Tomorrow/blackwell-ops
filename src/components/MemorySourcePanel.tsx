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
    return () => {
      cancelAnimationFrame(raf);
      // Idle resting pose
      for (const bar of bars) {
        bar.style.transform = "";
        bar.style.opacity = "";
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
  if (memorySource.kind === "learned") return "LEARNED (from previous run)";
  if (memorySource.kind === "learned_curve") return "LEARNED · interpolated";
  if (memorySource.kind === "fit_probe") {
    return memorySource.exact === false ? "FIT PROBE · estimate" : "FIT PROBE · measured";
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
  // Estimate path: curve interp, or probe moved off its anchor.
  const isEstimate = isCurve || (isFitProbe && memorySource.exact === false);

  const ctxDragging = useCtxSliderDragging();
  // Meter only while scrubbing CTX (or active PROBE). Exact parked marks stay quiet.
  const meterActive =
    isValidating || (ctxDragging && (isEstimate || isFitProbe || isCurve));

  const showStatusSlot = isLearnedExact || isCurve || isFitProbe;
  const showReprobeNudge =
    isEstimate && Boolean(onValidate) && !hideValidate && !isValidating && !meterActive;

  const recap = collectRecap(memorySource, kindLabel, launchSummary);
  const tipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const barsRef = useLiveMeterDrive(meterActive);
  const [open, setOpen] = useState(false);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  const idleStatus = (() => {
    if (isLearnedExact) return "(from previous run)";
    if (isCurve) return "interpolated";
    if (isFitProbe) return isExact ? "(measured)" : "estimate";
    return null;
  })();

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
          {showStatusSlot ? (
            <span
              className="vram-fc-source__status-slot"
              data-live={meterActive ? "1" : "0"}
              data-kind={memorySource.kind}
            >
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
                  <span className="vram-fc-source__live-meter-sweep" aria-hidden />
                  <span className="vram-fc-source__live-meter-scan" aria-hidden />
                </span>
              ) : (
                <span className="vram-fc-source__idle-status">
                  {idleStatus ? (
                    <span className="vram-fc-source__prev-lab">{idleStatus}</span>
                  ) : null}
                  {showReprobeNudge ? (
                    <button
                      type="button"
                      className="vram-fc-source__reprobe"
                      onClick={(e) => {
                        e.stopPropagation();
                        onValidate?.();
                      }}
                      title="Run FIT PROBE at this CTX to lock a measured point"
                    >
                      RE-PROBE?
                    </button>
                  ) : null}
                </span>
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
