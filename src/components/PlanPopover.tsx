import { useState } from "react";
import { formatPlanTotal, formatTensorSplit, type GpuCalibrationRow, type LayerPlan } from "../lib/vramLayerPlan";

/**
 * PLAN vs the current forecast, per device.
 *
 * The forecast answers "does this fit"; the plan answers "where do the layers go". Showing
 * them together is the point: when they disagree, the disagreement is the runtime overhead
 * estimate being wrong, and now it is visible per card instead of buried in a total.
 */
export default function PlanPopover({
  plan,
  calibration,
  forecastNeedGb,
  forecastKind,
  kvMibPerLayer = 0,
  kvSource = "none",
  squeezed = false,
  onApply,
  onClose,
}: {
  plan: LayerPlan | null;
  calibration: GpuCalibrationRow[];
  forecastNeedGb: number | null;
  forecastKind: string | null;
  /** KV per layer at the planned context, MiB (0 when the metadata cannot express it). */
  kvMibPerLayer?: number;
  /** How the KV term was obtained; "geometry" is an upper bound, not a forecast. */
  kvSource?: "measured" | "profile" | "geometry" | "none";
  /** The measured run had to shrink parameters to fit: same inventory, lower speed. */
  squeezed?: boolean;
  /** Write this plan into the launch config (-ts), so placement is chosen, not fitted. */
  onApply?: () => void;
  /** How much the plan exceeds the free budget, GB (0 when it fits). */
  overflowGb?: number;
  /** The forecast paints spill/over-free for this configuration. */
  strain?: boolean;
  onClose: () => void;
}) {
  // Local acknowledgement: the click must be visible even when the numbers do not move yet.
  const [applied, setApplied] = useState<"idle" | "busy" | "done">("idle");
  if (!plan) {
    return (
      <div className="vram-plan-pop" role="dialog" aria-label="Layer plan">
        <div className="vram-plan-pop__head">
          <span className="vram-plan-pop__title">PLAN</span>
          {onApply ? (
          <button
            type="button"
            className="vram-plan-pop__copy"
            title={`Apply -ts ${formatTensorSplit(plan.ts)} and split=layer to the launch config`}
            onClick={onApply}
          >
            APPLY
          </button>
        ) : null}
        <button type="button" className="vram-plan-pop__close" onClick={onClose} aria-label="Close plan">
            ✕
          </button>
        </div>
        <div className="vram-plan-pop__empty">No block table for this model yet.</div>
      </div>
    );
  }

  const contextLabel = (index: number) => {
    const row = calibration.find((c) => c.index === index);
    return row && row.samples > 0
      ? `overhead ${Math.round(row.median_residual_mib)} MiB · ${row.samples} launches`
      : "overhead est. 768 MiB · no calibration";
  };

  return (
    <div className="vram-plan-pop" role="dialog" aria-label="Layer plan">
      <div className="vram-plan-pop__head">
        <span className="vram-plan-pop__title">PLAN</span>
        <span className="vram-plan-pop__ts" title="llama.cpp --split-mode layer tensor split">
          -ts {formatTensorSplit(plan.ts)}
        </span>
        <button
          type="button"
          className="vram-plan-pop__copy"
          title="Copy the -ts value"
          onClick={() => void navigator.clipboard?.writeText(formatTensorSplit(plan.ts))}
        >
          COPY
        </button>
        {onApply ? (
          <button
            type="button"
            className="vram-plan-pop__copy"
            title={`Apply -ts ${formatTensorSplit(plan.ts)} and split=layer to the launch config`}
            onClick={onApply}
          >
            APPLY
          </button>
        ) : null}
        <button type="button" className="vram-plan-pop__close" onClick={onClose} aria-label="Close plan">
          ✕
        </button>
      </div>

      {plan.totalMib.map((mib, i) => {
        const budget = plan.budgetsMib[i] ?? 0;
        const pct = budget > 0 ? (mib / budget) * 100 : 0;
        const tone = pct > 100 ? "hot" : pct > 98 ? "caution" : "ok";
        return (
          <div key={i} className="vram-plan-pop__row" data-tone={tone}>
            <span className="vram-plan-pop__gpu">{`GPU${i}`}</span>
            <span className="vram-plan-pop__load">
              {(mib / 1024).toFixed(1)}
              <span className="vram-plan-pop__sep">/</span>
              {(budget / 1024).toFixed(1)} GiB
            </span>
            <span className="vram-plan-pop__pct">{`${Math.round(pct)}%`}</span>
            <span className="vram-plan-pop__meta">{contextLabel(i)}</span>
          </div>
        );
      })}

      <div className="vram-plan-pop__total">
        <span>{formatPlanTotal(plan)}</span>
        <span className="vram-plan-pop__layers">
          {kvMibPerLayer > 0
            ? `${plan.boundary} / ${plan.layerCount} layers · KV ${Math.round(kvMibPerLayer)} MiB/layer`
            : `${plan.boundary} / ${plan.layerCount} layers · weights only`}
        </span>
      </div>


      {squeezed && (
        <div className="vram-plan-pop__forecast">
          <span className="vram-plan-pop__meta">SQUEEZED</span>
          <span>engine shrank to fit — slower for the same VRAM</span>
        </div>
      )}

      {forecastNeedGb != null && forecastNeedGb > 0 && (
        <div className="vram-plan-pop__forecast">
          <span className="vram-plan-pop__meta">{forecastKind ?? "FORECAST"}</span>
          <span>{`${forecastNeedGb.toFixed(1)} GB total`}</span>
          <span className="vram-plan-pop__delta">
            {`vs plan ${(plan.sumMib / 1024).toFixed(1)} GiB`}
          </span>
        </div>
      )}
    </div>
  );
}
