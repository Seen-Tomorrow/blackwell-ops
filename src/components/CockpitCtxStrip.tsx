/**
 * CTX rail — one component, two placements (above-dock standalone vs in-cockpit).
 * Hero layout: taller slider + footer legend (LEARNED marks) + filter toggle.
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
    setMode((prev) => {
      const next = cycleCtxLearnedMarkMode(prev);
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
  const label = mode === "all" ? "ALL" : mode === "regular" ? "REG" : "OFF";
  return (
    <button
      type="button"
      className="full-auto-cockpit__ctx-marks-toggle font-mono"
      onClick={onCycle}
      title={
        mode === "all"
          ? "Learned marks: all (preset + custom). Click → regular presets only"
          : mode === "regular"
            ? "Learned marks: regular CTX presets only. Click → off"
            : "Learned marks off. Click → show all"
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
  const hasLearned = (learnedMarks?.length ?? 0) > 0;

  return (
    <div
      className={`full-auto-cockpit__ctx-hero${standalone ? " full-auto-cockpit__ctx-hero--standalone" : ""}${hasLearned ? " full-auto-cockpit__ctx-hero--has-marks" : ""} ${className}`}
    >
      <div className="full-auto-cockpit__ctx-hero-main">
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
            layout="hero"
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
        </div>
      </div>

      {hasLearned ? (
        <div className="full-auto-cockpit__ctx-footer font-mono">
          <span className="full-auto-cockpit__ctx-legend" title="Cyan ticks = prior launch measurements at that ctx">
            <span className="full-auto-cockpit__ctx-swatch full-auto-cockpit__ctx-swatch--learned" aria-hidden />
            LEARNED
            <span className="full-auto-cockpit__ctx-legend-sep">·</span>
            <span className="full-auto-cockpit__ctx-swatch full-auto-cockpit__ctx-swatch--custom" aria-hidden />
            custom ctx
          </span>
          <CtxLearnedMarkToggle mode={mode} onCycle={cycle} visible />
        </div>
      ) : null}
    </div>
  );
}
