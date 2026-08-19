/**
 * CTX rail — one component, two placements (above-dock standalone vs in-cockpit).
 */

import { useCallback, useState } from "react";
import CustomSliderParam from "./CustomSliderParam";
import { formatCtxChipLabel } from "../lib/sliderParamUtils";
import {
  cycleCtxLearnedMarkMode,
  loadCtxLearnedMarkMode,
  saveCtxLearnedMarkMode,
  type CtxLearnedMarkMode,
} from "../lib/storage";

export function useCtxLearnedMarkMode(): {
  mode: CtxLearnedMarkMode;
  cycle: () => void;
} {
  const [mode, setMode] = useState<CtxLearnedMarkMode>(loadCtxLearnedMarkMode);
  const cycle = useCallback(() => {
    setMode((cur) => {
      const next = cycleCtxLearnedMarkMode(cur);
      saveCtxLearnedMarkMode(next);
      return next;
    });
  }, []);
  return { mode, cycle };
}

export function CtxLearnedMarkToggle({
  mode,
  onCycle,
  visible,
}: {
  mode: CtxLearnedMarkMode;
  onCycle: () => void;
  visible: boolean;
}) {
  if (!visible) return null;
  const label = mode === "all" ? "MARKS" : mode === "custom" ? "CUSTOM" : "OFF";
  return (
    <button
      type="button"
      className="full-auto-cockpit__ctx-marks-toggle font-mono"
      onClick={onCycle}
      title={
        mode === "all"
          ? "Hide preset learned ticks — keep custom ctx only"
          : mode === "custom"
            ? "Hide all learned ticks"
            : "Show learned ticks"
      }
    >
      {label}
    </button>
  );
}

export interface CockpitCtxStripProps {
  ctxValue?: number | string;
  ctxDefault?: number | string;
  ctxValues?: (string | number)[];
  ctxStep?: number;
  onCtxChange: (v: number) => void;
  ctxPerSlot?: number;
  ctxSlotCount?: number;
  className?: string;
  learnedMarks?: number[];
  /** Above-dock chrome. False when nested inside the cockpit. */
  standalone?: boolean;
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
  learnedMarks,
  standalone = true,
}: CockpitCtxStripProps) {
  const { mode, cycle } = useCtxLearnedMarkMode();
  return (
    <div className={`full-auto-cockpit__ctx-hero${standalone ? " full-auto-cockpit__ctx-hero--standalone" : ""} ${className}`}>
      <div className="full-auto-cockpit__ctx-slider min-w-0">
        <CustomSliderParam
          paramKey="ctx"
          currentValue={ctxValue}
          defaultValue={ctxDefault}
          onChange={onCtxChange}
          step={ctxStep}
          values={ctxValues}
          learnedMarks={learnedMarks}
          learnedMarkMode={mode}
        />
      </div>
      <div className="full-auto-cockpit__ctx-values">
        <span className="full-auto-cockpit__ctx-value font-mono">
          {typeof ctxValue === "number"
            ? formatCtxChipLabel(ctxValue)
            : String(ctxValue ?? "")}
        </span>
        {ctxPerSlot != null && ctxPerSlot > 0 && ctxSlotCount != null && ctxSlotCount > 1 && (
          <>
            <span className="full-auto-cockpit__ctx-sep font-mono">|</span>
            <span className="full-auto-cockpit__ctx-per-slot font-mono">
              {formatCtxChipLabel(ctxPerSlot)} / slot
            </span>
          </>
        )}
        <CtxLearnedMarkToggle
          mode={mode}
          onCycle={cycle}
          visible={(learnedMarks?.length ?? 0) > 0}
        />
      </div>
    </div>
  );
}
