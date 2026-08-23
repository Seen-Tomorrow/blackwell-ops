/**
 * CTX rail — one component, two placements (above-dock standalone vs in-cockpit).
 * Hero layout: taller slider + footer legend (LEARNED marks) + filter toggle.
 */

import { useCallback, useMemo, useState } from "react";
import CustomSliderParam from "./CustomSliderParam";
import CtxForecastRibbon from "./CtxForecastRibbon";
import {
  formatCtxChipLabel,
  parseSliderValues,
  HERO_TRACK_HEIGHT_PX,
  HERO_TRACK_TOP_PX,
} from "../lib/sliderParamUtils";
import { isDevBuild } from "../lib/build";
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
  forecastCurve?: Array<{ ctx: number; gb: number }>;
  forecastFreeGb?: number;
  onPruneCustom?: (ctxs: number[]) => void | Promise<number | void>;
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
  forecastCurve,
  forecastFreeGb,
  onPruneCustom,
  standalone = true,
}: CockpitCtxStripProps) {
  const { mode, cycle } = useCtxLearnedMarkMode();
  const [ribbonPlace, setRibbonPlace] = useState<"track" | "marks" | "both">("track");
  const [ribbonHover, setRibbonHover] = useState<string | null>(null);
  const hasLearned = (learnedMarks?.length ?? 0) > 0;
  const customCtxs = useMemo(() => {
    const presets = new Set(parseSliderValues(ctxValues ?? []));
    return (learnedMarks ?? []).filter((m) => !presets.has(m));
  }, [ctxValues, learnedMarks]);
  const sliderRange = useMemo(() => {
    const nums = parseSliderValues(ctxValues ?? []);
    return {
      min: nums.length ? Math.min(...nums) : 2048,
      max: nums.length ? Math.max(...nums) : 524288,
    };
  }, [ctxValues]);
  const showRibbon =
    isDevBuild()
    && (forecastCurve?.length ?? 0) > 0
    && forecastFreeGb != null
    && forecastFreeGb > 0;
  const showTrack = showRibbon && (ribbonPlace === "track" || ribbonPlace === "both");
  const showMarks = showRibbon && (ribbonPlace === "marks" || ribbonPlace === "both");
  const hasGhost =
    (forecastCurve?.length ?? 0) > 0 && forecastFreeGb != null && forecastFreeGb > 0;
  const footerBusy = !hasLearned && !hasGhost;
  const ribbonProps = {
    min: sliderRange.min,
    max: sliderRange.max,
    forecastCurve: forecastCurve ?? [],
    forecastFreeGb: forecastFreeGb ?? 0,
    learnedMarks,
    ctxValues,
    onHover: setRibbonHover,
  };

  return (
    <div
      className={`full-auto-cockpit__ctx-hero full-auto-cockpit__ctx-hero--has-footer${standalone ? " full-auto-cockpit__ctx-hero--standalone" : ""} ${className}`}
    >
      <div className="full-auto-cockpit__ctx-hero-main">
        <div className="full-auto-cockpit__ctx-slider min-w-0">
          <div className="full-auto-cockpit__ctx-slider-host">
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
              forecastCurve={forecastCurve}
              forecastFreeGb={forecastFreeGb}
            />
            {showTrack ? (
              <div
                className="ctx-forecast-ribbon-slot ctx-forecast-ribbon-slot--track"
                style={{ top: HERO_TRACK_TOP_PX, height: HERO_TRACK_HEIGHT_PX }}
              >
                <CtxForecastRibbon {...ribbonProps} place="track" />
              </div>
            ) : null}
          </div>
          {showMarks ? <CtxForecastRibbon {...ribbonProps} place="marks" /> : null}
        </div>
        <div className="full-auto-cockpit__ctx-values">
          <span className="full-auto-cockpit__ctx-value font-mono">
            {typeof ctxValue === "number"
              ? formatCtxChipLabel(ctxValue)
              : String(ctxValue ?? "")}
          </span>
          {ribbonHover ? (
            <span className="ctx-forecast-ribbon__value-tip font-mono" title={ribbonHover}>
              {ribbonHover}
            </span>
          ) : null}
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


      <div
        className={`full-auto-cockpit__ctx-footer font-mono${footerBusy ? " full-auto-cockpit__ctx-footer--idle" : ""}`}
        aria-hidden={footerBusy || undefined}
      >
        <span
          className="full-auto-cockpit__ctx-legend"
          title="Cyan = LEARNED launches (drag snaps; Alt/Shift free). Amber ≤N = max CTX that still fits free VRAM — fixed limit; thumb crosses it when you raise CTX. Green rail OK / red over."
        >
          {hasLearned ? (
            <>
              <span className="full-auto-cockpit__ctx-swatch full-auto-cockpit__ctx-swatch--learned" aria-hidden />
              LEARNED
              <span className="full-auto-cockpit__ctx-legend-sep">·</span>
              <span className="full-auto-cockpit__ctx-swatch full-auto-cockpit__ctx-swatch--custom" aria-hidden />
              custom
              <span className="full-auto-cockpit__ctx-legend-sep">·</span>
              snap
            </>
          ) : null}
          {hasLearned && hasGhost ? (
            <span className="full-auto-cockpit__ctx-legend-sep">·</span>
          ) : null}
          {hasGhost ? (
            <>
              <span className="full-auto-cockpit__ctx-swatch full-auto-cockpit__ctx-swatch--limit" aria-hidden />
              VRAM limit
            </>
          ) : null}
          {footerBusy ? (
            <span className="full-auto-cockpit__ctx-legend-spacer">LEARNED · snap</span>
          ) : null}
        </span>
        <span className="full-auto-cockpit__ctx-footer-actions">
          {showRibbon ? (
            <button
              type="button"
              className="full-auto-cockpit__ctx-marks-toggle font-mono"
              onClick={() => {
                setRibbonPlace((p) => (p === "both" ? "track" : p === "track" ? "marks" : "both"));
              }}
              title="DEV ribbon: both / over track / under marks"
            >
              {ribbonPlace === "both" ? "RIBBON BOTH" : ribbonPlace === "track" ? "RIBBON TRACK" : "RIBBON MARKS"}
            </button>
          ) : null}
          {hasLearned ? (
            <>
              {onPruneCustom && customCtxs.length > 0 ? (
                <button
                  type="button"
                  className="full-auto-cockpit__ctx-marks-toggle full-auto-cockpit__ctx-marks-toggle--prune font-mono"
                  onClick={() => {
                    void onPruneCustom(customCtxs);
                  }}
                  title={`Remove ${customCtxs.length} custom LEARNED CTX mark${customCtxs.length === 1 ? "" : "s"} for this model + kv/spec/split (preset ticks stay)`}
                >
                  PRUNE {customCtxs.length}
                </button>
              ) : null}
              <CtxLearnedMarkToggle mode={mode} onCycle={cycle} visible />
            </>
          ) : (
            <span className="full-auto-cockpit__ctx-marks-toggle full-auto-cockpit__ctx-marks-toggle--slot" aria-hidden>
              ALL
            </span>
          )}
        </span>
      </div>
    </div>
  );
}
