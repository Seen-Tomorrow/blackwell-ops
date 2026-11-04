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
  onClose,
}: {
  plan: LayerPlan | null;
  calibration: GpuCalibrationRow[];
  forecastNeedGb: number | null;
  forecastKind: string | null;
  onClose: () => void;
}) {
  if (!plan) {
    return (
      <div className="vram-plan-pop" role="dialog" aria-label="Layer plan">
        <div className="vram-plan-pop__head">
          <span className="vram-plan-pop__title">PLAN</span>
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
      ? `ctx ${Math.round(row.median_residual_mib)} MiB · ${row.samples} launches`
      : "ctx est. 768 MiB · no calibration";
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
          {`${plan.boundary} / ${plan.layerCount} layers`}
        </span>
      </div>

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
