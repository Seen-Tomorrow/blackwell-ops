import FusionBooter from "./FusionBooter";
import {
  abortForecastCurveRun,
  skipForecastCurveCalibration,
  type CurveRunSnapshot,
} from "../lib/forecastCurveRun";
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

export default function MemoryCalibrationOverlay({
  run,
  gpus,
  vramTargetMib,
  modelLayerTotal,
  gpuLoadTargetsMib,
  className,
}: MemoryCalibrationOverlayProps) {
  const step2 = run.phase === "restoring";
  const stepLabel = step2
    ? `STEP 2/2 · TARGET LAUNCH (${fmtCtx(run.fromCtx)})`
    : `STEP 1/2 · LOW-CTX ANCHOR (${fmtCtx(run.toCtx)})`;

  return (
    <div className={`vram-badge-forecast vram-fc vram-cal-ov relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}>
      <div className="vram-cal-ov__head">
        <span className="vram-cal-ov__title">MEMORY CALIBRATION</span>
        <span className="vram-cal-ov__step">{stepLabel}</span>
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

      <div className="vram-cal-ov__hero">
        <svg className="vram-cal-ov__svg" viewBox="0 0 260 92" aria-hidden="true">
          <line x1="26" y1="10" x2="26" y2="74" className="vram-cal-ov__axis" />
          <line x1="26" y1="74" x2="246" y2="74" className="vram-cal-ov__axis" />
          <text x="20" y="16" className="vram-cal-ov__axlab" textAnchor="end">GB</text>
          <text x="246" y="86" className="vram-cal-ov__axlab" textAnchor="end">CTX</text>

          <line x1="58" y1="54" x2="216" y2="24" className="vram-cal-ov__fit" />
          {step2 && <line x1="58" y1="54" x2="216" y2="24" className="vram-cal-ov__curve" />}

          <circle
            cx="58"
            cy="54"
            r={step2 ? 4.5 : 5.5}
            className={`vram-cal-ov__dot ${step2 ? "is-done" : "is-active"}`}
          />
          <text x="58" y="68" className="vram-cal-ov__ptlab" textAnchor="middle">
            {fmtCtx(run.toCtx)}
          </text>

          <circle
            cx="216"
            cy="24"
            r={step2 ? 5.5 : 4}
            className={`vram-cal-ov__dot ${step2 ? "is-active" : "is-pending"}`}
          />
          <text x="216" y="16" className="vram-cal-ov__ptlab" textAnchor="middle">
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

      {run.slotIdx != null && run.port != null ? (
        <div className="vram-cal-ov__boot">
          <FusionBooter
            key={`${run.phase}-${run.slotIdx}-${run.port}`}
            slotIdx={run.slotIdx}
            alias={run.alias ?? ""}
            port={run.port}
            gpus={gpus}
            gpuMask={run.gpuMask ?? "0"}
            vramTargetMib={vramTargetMib}
            modelLayerTotal={modelLayerTotal}
            gpuLoadTargetsMib={gpuLoadTargetsMib}
            onStop={abortForecastCurveRun}
          />
        </div>
      ) : (
        <div className="vram-cal-ov__wait font-mono">{run.message ?? "starting…"}</div>
      )}
    </div>
  );
}
