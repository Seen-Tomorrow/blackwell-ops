/**
 * CTX rail — one component, two placements (above-dock standalone vs in-cockpit).
 * Hero layout: full-flex track + footer readout (CTX · per-slot · chevrons) + legend.
 */

import { useCallback, useMemo, useState } from "react";
import CustomSliderParam from "./CustomSliderParam";
import CtxForecastRibbon from "./CtxForecastRibbon";
import {
  clampSteppedValue,
  formatCtxChipLabel,
  parseSliderValues,
  interpolateGbAtCtx,
} from "../lib/sliderParamUtils";
import { isDevBuild } from "../lib/build";
import { ribbonTooltip } from "./ctxForecastRibbonMath";
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
  const [ribbonPlace, setRibbonPlace] = useState<"track" | "marks">("track");
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
  const showMarks = showRibbon && ribbonPlace === "marks";

  const hasGhost =
    (forecastCurve?.length ?? 0) > 0 && forecastFreeGb != null && forecastFreeGb > 0;
  const legendIdle = !hasLearned && !hasGhost;
  const ribbonProps = {
    min: sliderRange.min,
    max: sliderRange.max,
    forecastCurve: forecastCurve ?? [],
    forecastFreeGb: forecastFreeGb ?? 0,
    learnedMarks,
    ctxValues,
    onHover: setRibbonHover,
  };

  const ctxNumeric = useMemo(() => {
    if (typeof ctxValue === "number" && Number.isFinite(ctxValue)) return ctxValue;
    const n = parseInt(String(ctxValue ?? ""), 10);
    return Number.isFinite(n) ? n : sliderRange.min;
  }, [ctxValue, sliderRange.min]);

  const ctxLabel = Number.isFinite(ctxNumeric)
    ? formatCtxChipLabel(ctxNumeric)
    : String(ctxValue ?? "");

  const showPerSlot =
    ctxPerSlot != null && ctxPerSlot > 0 && ctxSlotCount != null && ctxSlotCount > 1;
  const perSlotLabel = showPerSlot ? formatCtxChipLabel(ctxPerSlot!) : "";
  const perSlotTitle = showPerSlot
    ? `${ctxLabel} (${ctxNumeric}) ÷ ${ctxSlotCount} slots = ${perSlotLabel} per slot`
    : undefined;

  const nudgeCtx = useCallback(
    (dir: -1 | 1) => {
      onCtxChange(
        clampSteppedValue(
          ctxNumeric + dir * ctxStep,
          sliderRange.min,
          sliderRange.max,
          ctxStep,
        ),
      );
    },
    [onCtxChange, ctxNumeric, ctxStep, sliderRange.min, sliderRange.max],
  );

  return (
    <div
      className={`full-auto-cockpit__ctx-hero full-auto-cockpit__ctx-hero--has-footer${standalone ? " full-auto-cockpit__ctx-hero--standalone" : ""} ${className}`}
    >
      <div className="full-auto-cockpit__ctx-hero-main">
        <div className="full-auto-cockpit__ctx-slider min-w-0">
          <div
            className="full-auto-cockpit__ctx-slider-host"
            onPointerMove={(e) => {
              if (!showRibbon || !forecastCurve || forecastFreeGb == null) return;
              const rect = e.currentTarget.getBoundingClientRect();
              if (!(rect.width > 0)) return;
              const pct = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
              const ctx = sliderRange.min + pct * (sliderRange.max - sliderRange.min);
              const gb = interpolateGbAtCtx(forecastCurve, ctx);
              setRibbonHover(
                gb == null ? null : ribbonTooltip(ctx, gb, forecastFreeGb, learnedMarks ?? []),
              );
            }}
            onPointerLeave={() => setRibbonHover(null)}
          >
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
              forecastRibbonOnTrack={ribbonPlace !== "marks"}
            />
          </div>
          {showMarks ? <CtxForecastRibbon {...ribbonProps} place="marks" /> : null}
        </div>
      </div>

      <div className="full-auto-cockpit__ctx-footer font-mono">
        <span className="full-auto-cockpit__ctx-footer-hover font-mono">
          {ribbonHover || "\u00a0"}
        </span>

        <div className="full-auto-cockpit__ctx-footer-readout" aria-label="Context length">
          <span className="full-auto-cockpit__ctx-value font-mono" title={`${ctxNumeric} tokens`}>
            {ctxLabel}
          </span>
          <span
            className={`full-auto-cockpit__ctx-slot-block${showPerSlot ? "" : " full-auto-cockpit__ctx-slot-block--empty"}`}
            title={perSlotTitle}
            aria-hidden={!showPerSlot || undefined}
          >
            <span className="full-auto-cockpit__ctx-sep font-mono" aria-hidden>
              |
            </span>
            <span className="full-auto-cockpit__ctx-per-slot font-mono">
              {showPerSlot ? `${perSlotLabel} / slot` : "\u00a0"}
            </span>
          </span>
          <span className="full-auto-cockpit__ctx-nudge" role="group" aria-label="Nudge context by 1K">
            <button
              type="button"
              className="full-auto-cockpit__ctx-chevron font-mono"
              onClick={() => nudgeCtx(-1)}
              disabled={ctxNumeric <= sliderRange.min}
              title={`−${formatCtxChipLabel(ctxStep)} (fine)`}
              aria-label={`Decrease context by ${ctxStep}`}
            >
              ‹
            </button>
            <button
              type="button"
              className="full-auto-cockpit__ctx-chevron font-mono"
              onClick={() => nudgeCtx(1)}
              disabled={ctxNumeric >= sliderRange.max}
              title={`+${formatCtxChipLabel(ctxStep)} (fine)`}
              aria-label={`Increase context by ${ctxStep}`}
            >
              ›
            </button>
          </span>
        </div>

        <span className="full-auto-cockpit__ctx-footer-right">
          <span
            className={`full-auto-cockpit__ctx-legend${legendIdle ? " full-auto-cockpit__ctx-legend--idle" : ""}`}
            title="Cyan ticks = LEARNED launches. Amber ≤N = VRAM limit. Ribbon paint = need vs free."
            aria-hidden={legendIdle || undefined}
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
            {legendIdle ? (
              <span className="full-auto-cockpit__ctx-legend-spacer">LEARNED · snap</span>
            ) : null}
          </span>
          <span
            className={`full-auto-cockpit__ctx-footer-actions${legendIdle && !showRibbon ? " full-auto-cockpit__ctx-footer-actions--idle" : ""}`}
          >
            {showRibbon ? (
              <button
                type="button"
                className="full-auto-cockpit__ctx-marks-toggle font-mono"
                onClick={() => {
                  setRibbonPlace((p) => (p === "track" ? "marks" : "track"));
                }}
                title="DEV ribbon: over track or under marks"
              >
                {ribbonPlace === "track" ? "RIBBON TRACK" : "RIBBON MARKS"}
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
        </span>
      </div>
    </div>
  );
}
