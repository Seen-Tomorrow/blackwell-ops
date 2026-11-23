import {
  abortForecastCurveRun,
  skipForecastCurveCalibration,
  type CurveRunSnapshot,
} from "../lib/forecastCurveRun";
import { useFusionBooterState, phaseIndex } from "../hooks/useFusionBooterState";
import { LOAD_PHASE_LABELS, LOAD_PHASE_ORDER } from "../lib/fusionLoadParser";
import type { GpuInfo } from "../lib/types";

interface MemoryCalibrationOverlayProps {
  run: CurveRunSnapshot;
  gpus: GpuInfo[];
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
  className?: string;
}

function fmtCtx(ctx: number | null): string {
  if (!ctx || ctx <= 0) return "—";
  return ctx >= 1024 ? `${Math.round(ctx / 1024)}K` : String(ctx);
}

function formatTimer(elapsedSec: number): string {
  const mm = Math.floor(elapsedSec / 60);
  const ss = Math.floor(elapsedSec % 60);
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

function formatDiskRate(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

export default function MemoryCalibrationOverlay({
  run,
  gpus,
  vramTargetMib,
  modelLayerTotal,
  gpuLoadTargetsMib,
  className,
}: MemoryCalibrationOverlayProps) {
  const hasSlot = run.slotIdx != null && run.port != null;
  const boot = useFusionBooterState({
    slotIdx: run.slotIdx ?? 0,
    port: run.port ?? 0,
    gpuMask: run.gpuMask ?? "0",
    vramTargetMib,
    modelLayerTotal,
    gpuLoadTargetsMib,
    gpus,
    active: hasSlot,
  });

  const step2 = run.phase === "restoring";
  const stepLabel = step2
    ? `STEP 2/2 · TARGET LAUNCH (${fmtCtx(run.fromCtx)})`
    : `STEP 1/2 · LOW-CTX ANCHOR (${fmtCtx(run.toCtx)})`;

  const currentPhase = phaseIndex(boot.phase);
  const fillPct = boot.loadProgress01 >= 0 ? Math.min(100, Math.round(boot.loadProgress01 * 100)) : null;
  const layerLabel =
    boot.layerTotal > 0
      ? `${Math.min(boot.layerCurrent, boot.layerTotal)}/${boot.layerTotal}`
      : boot.layerCurrent > 0
        ? `${boot.layerCurrent}`
        : "—";
  const srcLabel = boot.progressSource === "sse" ? "SSE" : boot.progressSource === "logs" ? "LOGS" : "—";

  const ioMib = hasSlot ? boot.diskReadMibPerS : 0;
  const ioTone = ioMib >= 4096 ? "is-hot" : ioMib > 8 ? "is-warm" : "is-idle";

  return (
    <div className={`vram-badge-forecast vram-fc vram-cal-ov relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}>
      <div className="vram-cal-ov__head">
        <span className="vram-cal-ov__title">MEMORY CALIBRATION</span>
        <span className="vram-cal-ov__step">{stepLabel}</span>
        {hasSlot && (
          <>
            <span className="vram-cal-ov__src font-mono">SRC {srcLabel}</span>
            <span className="vram-cal-ov__timer font-mono">{formatTimer(boot.elapsedSec)}</span>
          </>
        )}
        <div className="vram-cal-ov__actions">
          {!step2 && (
            <button
              type="button"
              className="vram-cal-ov__btn"
              onClick={skipForecastCurveCalibration}
              title="Skip calibration and launch your target CTX directly"
            >
              SKIP
            </button>
          )}
          <button
            type="button"
            className="vram-cal-ov__btn vram-cal-ov__btn--stop"
            onClick={abortForecastCurveRun}
            title="Stop calibration and restore your CTX"
          >
            STOP
          </button>
        </div>
      </div>

      <div className="vram-cal-ov__body">
        <div className="vram-cal-ov__left">
          <div className="vram-cal-ov__hero">
            <svg className="vram-cal-ov__svg" viewBox="0 0 240 76" aria-hidden="true">
              <line x1="24" y1="8" x2="24" y2="60" className="vram-cal-ov__axis" />
              <line x1="24" y1="60" x2="228" y2="60" className="vram-cal-ov__axis" />
              <text x="18" y="14" className="vram-cal-ov__axlab" textAnchor="end">GB</text>
              <text x="228" y="72" className="vram-cal-ov__axlab" textAnchor="end">CTX</text>

              <line x1="54" y1="46" x2="198" y2="20" className="vram-cal-ov__fit" />
              {step2 && <line x1="54" y1="46" x2="198" y2="20" className="vram-cal-ov__curve" />}

              <circle
                cx="54"
                cy="46"
                r={step2 ? 4 : 5}
                className={`vram-cal-ov__dot ${step2 ? "is-done" : "is-active"}`}
              />
              <text x="54" y="57" className="vram-cal-ov__ptlab" textAnchor="middle">
                {fmtCtx(run.toCtx)}
              </text>

              <circle
                cx="198"
                cy="20"
                r={step2 ? 5 : 3.5}
                className={`vram-cal-ov__dot ${step2 ? "is-active" : "is-pending"}`}
              />
              <text x="198" y="13" className="vram-cal-ov__ptlab" textAnchor="middle">
                {fmtCtx(run.fromCtx)}
              </text>
            </svg>

            <div className="vram-cal-ov__notes font-mono">
              <div className={`vram-cal-ov__note${!step2 ? " is-active" : " is-done"}`}>
                1. Safe low-CTX pass ({fmtCtx(run.toCtx)}) — measures base weights &amp; compute
              </div>
              <div className={`vram-cal-ov__note${step2 ? " is-active" : ""}`}>
                2. Target launch ({fmtCtx(run.fromCtx)}) — locks KV slope &amp; stays running
              </div>
              <div className="vram-cal-ov__gain">
                One-time per config · exact VRAM curve for every CTX
              </div>
            </div>
          </div>

          {hasSlot && boot.loadFailed ? (
            <div className="vram-cal-ov__fail font-mono">
              LOAD FAILED: {boot.loadErrorReason}
            </div>
          ) : hasSlot ? (
            <div className="vram-cal-ov__progress">
              <div className="fusion-boot-phase__steps" role="list">
                {LOAD_PHASE_ORDER.map((id, i) => {
                  const done = i < currentPhase;
                  const active = i === currentPhase;
                  const state = done ? "is-done" : active ? "is-active" : "is-todo";
                  return (
                    <div key={id} className={`fusion-boot-phase__step ${state}`} role="listitem">
                      <div className="fusion-boot-phase__bar" />
                      <span className="fusion-boot-phase__lab">{LOAD_PHASE_LABELS[id]}</span>
                    </div>
                  );
                })}
              </div>
              {fillPct != null && (
                <div className="fusion-boot-phase__progress" aria-label={`Load progress ${fillPct} percent`}>
                  <div className="fusion-boot-phase__progress-track">
                    <div
                      className="fusion-boot-phase__progress-fill"
                      style={{ width: `${Math.max(2, fillPct)}%` }}
                    />
                  </div>
                  <span className="fusion-boot-phase__progress-val">{fillPct}%</span>
                </div>
              )}
              <div className="vram-cal-ov__meta font-mono">
                <span>LAYER {layerLabel}</span>
                <span>PHASE {LOAD_PHASE_LABELS[boot.phase]}</span>
                <span>{(run.alias ?? "").toUpperCase()} :{run.port}</span>
              </div>
            </div>
          ) : (
            <div className="vram-cal-ov__wait font-mono">{run.message ?? "starting…"}</div>
          )}
        </div>

        <div className={`vram-cal-ov__io ${ioTone}`} aria-label={`NVMe read ${formatDiskRate(ioMib)} MiB/s`}>
          <span className="vram-cal-ov__io-lab">NVMe READ</span>
          <span className="vram-cal-ov__io-val">{formatDiskRate(ioMib)}</span>
          <span className="vram-cal-ov__io-unit">MiB/s</span>
          <span className="vram-cal-ov__io-mbit">{formatDiskRate(ioMib * 8)} Mbit/s</span>
        </div>
      </div>
    </div>
  );
}
