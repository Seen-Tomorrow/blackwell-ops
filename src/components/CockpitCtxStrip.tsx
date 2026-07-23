/**
 * Standalone CTX strip — same design as the in-cockpit rail (CustomSlider + hero value).
 * Used when CTX is docked above the cockpit (not embedded).
 */

import CustomSliderParam from "./CustomSliderParam";

export interface CockpitCtxStripProps {
  ctxValue?: number | string;
  ctxDefault?: number | string;
  ctxValues?: (string | number)[];
  ctxStep?: number;
  onCtxChange: (v: number) => void;
  ctxPerSlot?: number;
  ctxSlotCount?: number;
  className?: string;
}

export default function CockpitCtxStrip({
  ctxValue,
  ctxDefault,
  ctxValues,
  ctxStep = 1024,
  onCtxChange,
  ctxPerSlot,
  ctxSlotCount = 1,
  className = "",
}: CockpitCtxStripProps) {
  return (
    <div className={`full-auto-cockpit__ctx-hero full-auto-cockpit__ctx-hero--standalone ${className}`}>
      <div className="full-auto-cockpit__ctx-slider min-w-0">
        <CustomSliderParam
          paramKey="ctx"
          currentValue={ctxValue}
          defaultValue={ctxDefault}
          onChange={onCtxChange}
          step={ctxStep}
          values={ctxValues}
        />
      </div>
      <div className="full-auto-cockpit__ctx-values">
        <span className="full-auto-cockpit__ctx-value font-mono">
          {typeof ctxValue === "number"
            ? `${Math.round(ctxValue / 1024)}K`
            : String(ctxValue ?? "")}
        </span>
        {ctxPerSlot != null && ctxPerSlot > 0 && ctxSlotCount != null && ctxSlotCount > 1 && (
          <>
            <span className="full-auto-cockpit__ctx-sep font-mono">|</span>
            <span className="full-auto-cockpit__ctx-per-slot font-mono">
              {Math.round(ctxPerSlot / 1024)}K / slot
            </span>
          </>
        )}
      </div>
    </div>
  );
}
