import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { MemorySource } from "../lib/types";
import type { FitProbeMode } from "../services/vram/lowVramProbe";
import { isDevBuild } from "../lib/build";
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
  /** Optional launch summary included in hover recap. */
  launchSummary?: string;
}

export interface MemorySourceView {
  kindLabel: string;
  accent: (typeof MEMORY_SOURCE_ACCENT)[MemorySource["kind"]];
  isCurve: boolean;
  isFitProbe: boolean;
  isLearnedExact: boolean;
  isExact: boolean;
  isEstimate: boolean;
  /** Hero quality mark — EXACT / CURVE / MEASURED / ESTIMATE */
  idleStatus: "EXACT" | "CURVE" | "MEASURED" | "ESTIMATE" | null;
  showStatus: boolean;
  canProbe: boolean;
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
 * NEED frame live drive (rAF only) — perimeter rim only.
 * Never paints over need GB / status. Works on every theme.
 * full (RE-PROBE) = chasing highlight around the ring;
 * scan (CTX scrub) = slow breathing rim.
 */
function useNeedFrameLiveDrive(active: boolean, mode: "full" | "scan") {
  const rootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!active) return;
    const root = rootRef.current;
    if (!root) return;
    const rim = root.querySelector<HTMLElement>(".vram-fc-need-frame__live-rim");
    const tickEl = root.querySelector<HTMLElement>(".vram-fc-need-frame__live-tick");
    if (!rim) return;

    let raf = 0;
    const t0 = performance.now();
    const full = mode === "full";

    const tick = (now: number) => {
      const t = (now - t0) / 1000;
      if (full) {
        const deg = (t * 125) % 360;
        rim.style.setProperty("--rim-angle", `${deg.toFixed(1)}deg`);
        rim.style.opacity = (0.72 + 0.16 * Math.sin(t * 2.4)).toFixed(3);
        if (tickEl) {
          tickEl.style.setProperty("--rim-angle", `${deg.toFixed(1)}deg`);
          tickEl.style.opacity = (0.55 + 0.28 * Math.sin(t * 2.4 + 0.8)).toFixed(3);
        }
      } else {
        const deg = (t * 80) % 360;
        rim.style.setProperty("--rim-angle", `${deg.toFixed(1)}deg`);
        rim.style.opacity = (0.5 + 0.14 * Math.sin(t * 1.6)).toFixed(3);
        if (tickEl) tickEl.style.opacity = "0";
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      rim.style.removeProperty("--rim-angle");
      rim.style.opacity = "";
      if (tickEl) {
        tickEl.style.removeProperty("--rim-angle");
        tickEl.style.opacity = "";
      }
    };
  }, [active, mode]);
  return rootRef;
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
  if (memorySource.kind === "learned_curve") return "LEARNED · CURVE";
  if (memorySource.kind === "fit_probe") {
    return memorySource.exact === false ? "FIT PROBE · ESTIMATE" : "FIT PROBE · MEASURED";
  }
  return MEMORY_SOURCE_LABELS[memorySource.kind];
}

/** Derive SOURCE view flags (status mark, probe eligibility, accents). */
export function getMemorySourceView(
  memorySource: MemorySource,
  opts?: { onValidate?: () => void; hideValidate?: boolean },
): MemorySourceView {
  const isCurve = memorySource.kind === "learned_curve";
  const isFitProbe = memorySource.kind === "fit_probe";
  const isLearnedExact = memorySource.kind === "learned";
  const isExact = memorySource.exact !== false && !isCurve;
  const isEstimate = isCurve || (isFitProbe && memorySource.exact === false);
  const idleStatus = ((): MemorySourceView["idleStatus"] => {
    if (isLearnedExact) return "EXACT";
    if (isCurve) return "CURVE";
    if (isFitProbe) return isExact ? "MEASURED" : "ESTIMATE";
    return null;
  })();

  return {
    kindLabel: kindDisplayLabel(memorySource.kind),
    accent: MEMORY_SOURCE_ACCENT[memorySource.kind],
    isCurve,
    isFitProbe,
    isLearnedExact,
    isExact,
    isEstimate,
    idleStatus,
    showStatus: Boolean(idleStatus),
    // Exact LEARNED is a quality mark, not a lock — border/offload points need a re-probe.
    canProbe: Boolean(opts?.onValidate) && !opts?.hideValidate,
  };
}

export interface MemorySourceNeedOverlayProps {
  memorySource: MemorySource;
  isValidating?: boolean;
  onValidate?: () => void;
  hideValidate?: boolean;
}

/**
 * Live cue on the NEED frame — perimeter rim only (no face veil).
 * RE-PROBE: chasing rim spark. CTX scrub: slow rim breathe.
 * Mount last so paint order owns stacking.
 */
export function MemorySourceNeedOverlay({
  memorySource,
  isValidating = false,
  onValidate,
  hideValidate = false,
}: MemorySourceNeedOverlayProps) {
  const view = getMemorySourceView(memorySource, { onValidate, hideValidate });
  const ctxDragging = useCtxSliderDragging();
  const scrubbing =
    ctxDragging && (view.isEstimate || view.isFitProbe || view.isCurve);
  const probing = isValidating;
  const liveActive = probing || scrubbing;
  const mode: "full" | "scan" = probing ? "full" : "scan";
  const rootRef = useNeedFrameLiveDrive(liveActive, mode);

  if (!liveActive) return null;

  return (
    <div
      ref={rootRef}
      className={`vram-fc-need-frame__live${
        probing ? " is-probing is-mode-full" : " is-mode-scan"
      }`}
      data-live-mode={mode}
      data-live="1"
      aria-hidden
    >
      <span className="vram-fc-need-frame__live-rim" />
      {mode === "full" ? <span className="vram-fc-need-frame__live-tick" /> : null}
    </div>
  );
}


export interface MemorySourceReprobeProps {
  memorySource: MemorySource;
  isValidating?: boolean;
  onValidate?: (mode?: FitProbeMode) => void;
  hideValidate?: boolean;
  className?: string;
  /** Tight free — flash LOW VRAM (REL swaps one button; DEV shows both). */
  needsLowVramReprobe?: boolean;
  /** Past amber fits-line — punch both probe controls red. */
  overFreeReprobe?: boolean;
}

/** RE-PROBE control — sits right of the assisted launch summary. */
export function MemorySourceReprobe({
  memorySource,
  isValidating = false,
  onValidate,
  hideValidate = false,
  className,
  needsLowVramReprobe = false,
  overFreeReprobe = false,
}: MemorySourceReprobeProps) {
  const view = getMemorySourceView(memorySource, { onValidate, hideValidate });
  if (!view.canProbe) return null;

  const wrap = className ? ` ${className}` : "";
  const fire = (mode: FitProbeMode) => (e: { stopPropagation: () => void }) => {
    e.stopPropagation();
    onValidate?.(mode);
  };

  const autoLow = needsLowVramReprobe && !isValidating;
  const autoLabel = isValidating
    ? needsLowVramReprobe
      ? "PROBING LOW VRAM…"
      : "PROBING…"
    : autoLow
      ? "RE-PROBE LOW VRAM"
      : "RE-PROBE";

  const autoBtn = (
    <button
      type="button"
      className={`vram-fc-source__reprobe vram-fc-header__reprobe${
        overFreeReprobe
          ? " vram-fc-header__reprobe--over-free"
          : autoLow
            ? " vram-fc-header__reprobe--low-vram"
            : ""
      }`}
      data-probe-state={
        isValidating ? "probing" : overFreeReprobe ? "over-free" : autoLow ? "low-vram" : "reprobe"
      }
      disabled={isValidating}
      onClick={fire(autoLow || overFreeReprobe ? "low_vram" : "full")}
      title={
        overFreeReprobe
          ? "Over free VRAM — run FIT now (auto picks low-vram)"
          : autoLow
            ? "Auto: free VRAM is tight — free-aware FIT (not on CTX drag)"
            : "Auto: full-need FIT at this CTX"
      }
    >
      {autoLabel}
    </button>
  );

  const manualCls = `vram-fc-source__reprobe vram-fc-header__reprobe vram-fc-header__reprobe--manual${
    overFreeReprobe ? " vram-fc-header__reprobe--over-free" : ""
  }`;

  if (isDevBuild()) {
    return (
      <span className={`vram-fc-header__reprobe-pair${wrap}`}>
        {autoBtn}
        <button
          type="button"
          className={manualCls}
          data-probe-state={isValidating ? "probing" : overFreeReprobe ? "over-free" : "reprobe"}
          disabled={isValidating}
          onClick={fire("full")}
          title="Manual full-need FIT (ngl 999) — ignore auto swap"
        >
          RE-PROBE
        </button>
        <button
          type="button"
          className={manualCls}
          data-probe-state={isValidating ? "probing" : overFreeReprobe ? "over-free" : "reprobe"}
          disabled={isValidating}
          onClick={fire("low_vram")}
          title="Manual free-aware FIT — ignore auto swap"
        >
          RE-PROBE LOW VRAM
        </button>
      </span>
    );
  }

  return (
    <span className={wrap.trim() || undefined}>
      {autoBtn}
    </span>
  );
}

export interface MemorySourceStatusMarkProps {
  memorySource: MemorySource;
  className?: string;
}

export function MemorySourceStatusMark({
  memorySource,
  className,
}: MemorySourceStatusMarkProps) {
  const view = getMemorySourceView(memorySource);
  if (!view.idleStatus) return null;

  return (
    <div
      className={`vram-fc-need-frame__status-row${className ? ` ${className}` : ""}`}
      data-source-kind={memorySource.kind}
      data-has-status="1"
      data-precision={memorySource.confidence}
    >
      <div className="vram-fc-need-frame__status-stack">
        <span
          className={`vram-fc-need-frame__status${
            view.isExact ? " is-exact" : " is-estimate"
          }`}
          data-status={view.idleStatus}
          title={
            view.isLearnedExact
              ? "EXACT · 4/4 — launch measurement at this CTX"
              : view.isCurve
                ? "CURVE · 3/4 — between two LEARNED launches (~95%)"
                : view.isExact
                  ? "MEASURED · 2/4 — FIT probe at this CTX"
                  : "ESTIMATE · 1/4 — FIT walked off its probe CTX"
          }
        >
          {view.idleStatus}
        </span>
        <span className="vram-fc-need-frame__precision" aria-label={`Precision ${memorySource.confidence} of 4`}>
          <span className="vram-fc-need-frame__precision-label">precision</span>
          {[1, 2, 3, 4].map((n) => (
            <span
              key={n}
              className={`vram-fc-need-frame__pip${n <= memorySource.confidence ? " is-on" : ""}`}
            />
          ))}
        </span>
      </div>
    </div>
  );
}
/** MEMORY FORECAST SOURCE identity — lab + kind + pips; hover recap. */
export default function MemorySourcePanel({
  memorySource,
  launchSummary,
}: MemorySourcePanelProps) {

  const view = getMemorySourceView(memorySource);
  const recap = collectRecap(memorySource, view.kindLabel, launchSummary);
  const tipId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);

  const show = useCallback(() => setOpen(true), []);
  const hide = useCallback(() => setOpen(false), []);

  return (
    <div
      ref={rootRef}
      className="vram-fc-source memory-source-strip vram-fc-source--inline vram-fc-source--dominant"
      data-source-kind={memorySource.kind}
      data-source-exact={view.isExact ? "1" : "0"}
      data-source-layout="inline"
      data-tip-open={open ? "1" : undefined}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
    >
      <div className="vram-fc-source__head memory-source-header">
        <div className="vram-fc-source__line1">
          <span className="vram-fc-source__lab">MEMORY FORECAST SOURCE</span>
          <span className={`vram-fc-source__kind ${view.accent.text}`}>
            <span className="memory-source-kind-label vram-fc-source__kind-lab">
              {view.kindLabel}
            </span>
          </span>
        </div>
        <div className="vram-fc-source__line2">
          {memorySource.confidence <= 2 ? (
            <span className="vram-fc-source__curve-hint">
              Do two LAUNCHES on any CTX to get best precision
            </span>
          ) : (
            <span className="vram-fc-source__curve-hint vram-fc-source__curve-hint--slot" aria-hidden>
              Do two LAUNCHES on any CTX to get best precision
            </span>
          )}
        </div>
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
            <span className={`vram-fc-recap__v vram-fc-recap__v--kind ${view.accent.text}`}>
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
          {view.isEstimate ? (
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

