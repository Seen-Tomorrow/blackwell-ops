/**
 * Custom CTX slider — div track, aligned thumb, preset ticks below the rail.
 * `layout="hero"` (CTX strip): taller host, labels hug vertical marks, fat hit targets.
 */

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  HERO_HIT_WIDTH_PX,
  HERO_SLIDER_THUMB_WIDTH_PX,
  HERO_TICK_HEIGHT_PX,
  HERO_TICK_TOP_PX,
  HERO_TRACK_AREA_HEIGHT_PX,
  HERO_TRACK_HEIGHT_PX,
  HERO_TRACK_TOP_PX,
  SLIDER_THUMB_WIDTH_PX,
  TRACK_AREA_HEIGHT_PX,
  TRACK_HEIGHT_PX,
  TRACK_TOP_PX,
  TICK_HEIGHT_PX,
  TICK_TOP_PX,
  clampSteppedValue,
  findMaxFittingCtx,
  formatTokenLabel,
  parseSliderValues,
  snapToNearestMark,
  thumbCenterPercent,
  valueFromPointerX,
  type SliderParamSharedProps,
} from "../lib/sliderParamUtils";
import { ribbonCssGradient, sampleRibbonStops } from "./ctxForecastRibbonMath";
import { dispatchAppEvent, EVENTS } from "../lib/events";

function useTrackWidth() {
  const [trackWidthPx, setTrackWidthPx] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const trackRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    if (!node) return;

    const measure = () => {
      setTrackWidthPx(node.getBoundingClientRect().width);
    };

    measure();
    const ro = new ResizeObserver(() => measure());
    ro.observe(node);
    observerRef.current = ro;
  }, []);

  useLayoutEffect(() => {
    return () => {
      observerRef.current?.disconnect();
      observerRef.current = null;
    };
  }, []);

  return { trackRef, trackWidthPx };
}

export default function CustomSliderParam({
  paramKey,
  currentValue,
  defaultValue,
  onChange,
  step = 1024,
  values = [],
  learnedMarks = [],
  learnedMarkMode = "all",
  layout = "inline",
  forecastCurve,
  forecastFreeGb,
  forecastRibbonOnTrack = true,
}: SliderParamSharedProps) {
  const hero = layout === "hero";
  const areaH = hero ? HERO_TRACK_AREA_HEIGHT_PX : TRACK_AREA_HEIGHT_PX;
  const trackH = hero ? HERO_TRACK_HEIGHT_PX : TRACK_HEIGHT_PX;
  const trackTop = hero ? HERO_TRACK_TOP_PX : TRACK_TOP_PX;
  const tickTop = hero ? HERO_TICK_TOP_PX : TICK_TOP_PX;
  const tickH = hero ? HERO_TICK_HEIGHT_PX : TICK_HEIGHT_PX;
  const hitW = hero ? HERO_HIT_WIDTH_PX : 8;
  const thumbW = hero ? HERO_SLIDER_THUMB_WIDTH_PX : SLIDER_THUMB_WIDTH_PX;

  const numericValues = parseSliderValues(values);
  const min = numericValues.length > 0 ? Math.min(...numericValues) : 2048;
  const max = numericValues.length > 0 ? Math.max(...numericValues) : 524288;
  const presetCtxSet = new Set(numericValues);
  const visibleLearnedMarks =
    learnedMarkMode === "off"
      ? []
      : learnedMarks.filter((mark) => {
        if (mark < min || mark > max) return false;
        // regular = only marks that land on CTX template preset values
        if (learnedMarkMode === "regular" && !presetCtxSet.has(mark)) return false;
        return true;
      });
  // Preset values that already have a LEARNED cyan mark — draw cyan once, skip white tick.
  const learnedCoverSet = new Set(visibleLearnedMarks);

  const numericValue =
    typeof currentValue === "number" ? currentValue : parseInt(String(currentValue), 10);
  const safeValue =
    isNaN(numericValue) || numericValue < min ? min : Math.min(numericValue, max);

  const { trackRef, trackWidthPx } = useTrackWidth();
  const [hoveredPresetIdx, setHoveredPresetIdx] = useState<number | null>(null);
  const [hoveredLearned, setHoveredLearned] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(false);
  const commitValue = useCallback(
    (val: number) => onChange(clampSteppedValue(val, min, max, step)),
    [onChange, min, max, step],
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const freeDrag = e.altKey || e.shiftKey;
      const nudge = (raw: number) => {
        if (!hero || freeDrag || visibleLearnedMarks.length === 0) {
          commitValue(raw);
          return;
        }
        // Keyboard: soft-snap onto learned notches when landing nearby.
        commitValue(
          snapToNearestMark(
            raw,
            visibleLearnedMarks,
            min,
            max,
            step,
            trackWidthPx,
            false,
            12,
            thumbW,
          ),
        );
      };
      if (e.key === "ArrowRight" || e.key === "ArrowUp") {
        e.preventDefault();
        nudge(safeValue + step);
      } else if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
        e.preventDefault();
        nudge(safeValue - step);
      } else if (e.key === "PageUp") {
        e.preventDefault();
        nudge(safeValue + step * 8);
      } else if (e.key === "PageDown") {
        e.preventDefault();
        nudge(safeValue - step * 8);
      } else if (e.key === "Home") {
        e.preventDefault();
        commitValue(min);
      } else if (e.key === "End") {
        e.preventDefault();
        commitValue(max);
      }
    },
    [commitValue, safeValue, step, min, max, hero, visibleLearnedMarks, trackWidthPx, thumbW],
  );

  const updateFromClientX = useCallback(
    (clientX: number, trackEl: HTMLDivElement, freeDrag: boolean) => {
      const rect = trackEl.getBoundingClientRect();
      const raw = valueFromPointerX(
        clientX,
        rect.left,
        rect.width,
        min,
        max,
        step,
        thumbW,
      );
      const next =
        hero && visibleLearnedMarks.length > 0
          ? snapToNearestMark(
              raw,
              visibleLearnedMarks,
              min,
              max,
              step,
              rect.width,
              freeDrag,
              12,
              thumbW,
            )
          : raw;
      commitValue(next);
    },
    [commitValue, min, max, step, thumbW, hero, visibleLearnedMarks],
  );

  const handleTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("[data-preset-tick]")) return;
      dragRef.current = true;
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      updateFromClientX(e.clientX, e.currentTarget, e.altKey || e.shiftKey);
    },
    [updateFromClientX],
  );

  const handleTrackPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      updateFromClientX(e.clientX, e.currentTarget, e.altKey || e.shiftKey);
    },
    [updateFromClientX],
  );

  const endDrag = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragRef.current) return;
    dragRef.current = false;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  useEffect(() => {
    const stop = () => {
      dragRef.current = false;
      setDragging(false);
    };
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
    return () => {
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    };
  }, []);

  // Broadcast CTX drag so MEMORY FORECAST SOURCE can animate only while scrubbing.
  useEffect(() => {
    if (paramKey !== "ctx") return;
    dispatchAppEvent(EVENTS.ctxSliderDragging, { dragging });
    return () => {
      if (dragging) dispatchAppEvent(EVENTS.ctxSliderDragging, { dragging: false });
    };
  }, [dragging, paramKey]);
  const ribbonGradient = useMemo(() => {
    if (!hero || forecastRibbonOnTrack === false || !forecastCurve?.length || !(forecastFreeGb != null && forecastFreeGb > 0)) {
      return null;
    }
    const stops = sampleRibbonStops(min, max, forecastFreeGb, forecastCurve);
    return stops.length >= 2 ? ribbonCssGradient(stops) : null;
  }, [hero, forecastRibbonOnTrack, forecastCurve, forecastFreeGb, min, max]);

  const thumbPct = thumbCenterPercent(safeValue, min, max, trackWidthPx, thumbW);

  const fitsBoundaryCtx =
    hero && forecastCurve && forecastCurve.length > 0 && forecastFreeGb != null && forecastFreeGb > 0
      ? findMaxFittingCtx(min, max, step, forecastFreeGb, forecastCurve)
      : null;
  const fitsBoundaryPct =
    fitsBoundaryCtx != null && trackWidthPx > 0
      ? thumbCenterPercent(fitsBoundaryCtx, min, max, trackWidthPx, thumbW)
      : null;

  const defaultNumeric =
    defaultValue !== undefined
      ? typeof defaultValue === "number"
        ? defaultValue
        : parseInt(String(defaultValue), 10)
      : NaN;
  const hasDefault = !isNaN(defaultNumeric);

  // Always-visible labels crowd the low end of a linear token scale (4K/8K/16K/32K).
  // Show the lowest mark, skip every other label while value < 64K, then show all larger marks.
  // Selected + hovered always stay labeled (ticks remain clickable regardless).
  const labelVisible = useCallback(
    (idx: number, pNum: number, isSelected: boolean) => {
      if (isSelected || hoveredPresetIdx === idx) return true;
      if (pNum >= 65_536) return true;
      let lowOrdinal = 0;
      for (let i = 0; i < numericValues.length; i++) {
        const v = numericValues[i]!;
        if (v >= 65_536) break;
        if (i === idx) return lowOrdinal % 2 === 0;
        lowOrdinal += 1;
      }
      return true;
    },
    [hoveredPresetIdx, numericValues],
  );

  return (
    <div
      ref={trackRef}
      className={`ctx-slider-track-host relative flex-1 min-w-0 select-none touch-none${hero ? " ctx-slider-track-host--hero" : ""}`}
      style={{ height: `${areaH}px` }}
      onPointerDown={handleTrackPointerDown}
      onPointerMove={handleTrackPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      title={
        hero
          ? "Drag CTX — snaps to LEARNED marks. Hold Alt or Shift for free drag."
          : undefined
      }
    >
      <div
        className="ctx-slider-track absolute left-0 right-0 rounded-sm z-[1]"
        style={{
          top: `${trackTop}px`,
          height: `${trackH}px`,
          ...(ribbonGradient ? { background: ribbonGradient, borderColor: "transparent" } : {}),
        }}
      />
      {fitsBoundaryPct != null && fitsBoundaryCtx != null ? (
        <div
          className="ctx-slider-ghost-mark absolute z-[4] pointer-events-none"
          style={{ left: `${fitsBoundaryPct}%` }}
          title={`Forecast VRAM limit — fits up to ${formatTokenLabel(fitsBoundaryCtx)} (free pool). Thumb left of this = OK, right = over.`}
        >
          <span
            className="ctx-slider-ghost-stem"
            style={{ top: -10, height: areaH + 18 }}
            aria-hidden
          />
          <span className="ctx-slider-ghost-label font-mono">
            ≤{formatTokenLabel(fitsBoundaryCtx)}
          </span>
        </div>
      ) : null}
      {numericValues.map((pNum, idx) => {
        // LEARNED owns this ctx — cyan mark only (no white+cyan stack).
        if (learnedCoverSet.has(pNum)) return null;
        const pct =
          trackWidthPx > 0 ? thumbCenterPercent(pNum, min, max, trackWidthPx) : 0;
        const isDefault = hasDefault && pNum === defaultNumeric;
        const isSelected = safeValue === pNum && !isDefault;
        const showLabel = labelVisible(idx, pNum, safeValue === pNum);
        return (
          <div
            key={`${paramKey}-tick-${pNum}`}
            data-preset-tick
            className="absolute z-[2]"
            style={{
              left: `${pct}%`,
              transform: "translateX(-50%)",
              width: `${hitW}px`,
              height: hero ? `${areaH}px` : undefined,
              top: hero ? 0 : undefined,
              visibility: trackWidthPx > 0 ? "visible" : "hidden",
            }}
          >
            <span
              aria-hidden
              className={`ctx-slider-tick absolute left-1/2 -translate-x-1/2 block w-[3px] rounded-sm transition-colors pointer-events-none${
                isDefault ? " ctx-slider-tick--default" : isSelected ? " ctx-slider-tick--selected" : ""
              }`}
              style={{ top: `${tickTop}px`, height: `${tickH}px` }}
            />
            <button
              type="button"
              data-preset-tick
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => commitValue(pNum)}
              onMouseEnter={() => setHoveredPresetIdx(idx)}
              onMouseLeave={() => setHoveredPresetIdx(null)}
              className="absolute left-1/2 -translate-x-1/2 cursor-pointer bg-transparent border-0 p-0"
              style={{
                top: hero ? 0 : `${tickTop}px`,
                width: `${hitW}px`,
                height: hero ? `${areaH}px` : `${tickH}px`,
              }}
              title={formatTokenLabel(pNum)}
              aria-label={`Set ${formatTokenLabel(pNum)}`}
            />
            {showLabel ? (
              <span
                className={`ctx-slider-tick-tooltip absolute left-1/2 type-micro font-mono whitespace-nowrap pointer-events-none${hoveredPresetIdx === idx || safeValue === pNum ? " ctx-slider-tick-tooltip--active" : ""}${hero ? " ctx-slider-tick-tooltip--hero" : ""}`}
                style={
                  hero
                    ? { top: "0px", transform: "translateX(-50%)" }
                    : { top: "0px", transform: "translate(-50%, -100%)" }
                }
              >
                {formatTokenLabel(pNum)}
              </span>
            ) : null}
          </div>
        );
      })}
      {visibleLearnedMarks.map((mark) => {
        const pct = trackWidthPx > 0 ? thumbCenterPercent(mark, min, max, trackWidthPx) : 0;
        const isCustom = !presetCtxSet.has(mark);
        const isActive = safeValue === mark || hoveredLearned === mark;
        // On presets, always show label (replaces the skipped white tick's label).
        const showLearnedLabel = hero || isCustom;
        return (
          <div
            key={`${paramKey}-learned-${mark}`}
            data-preset-tick
            className="absolute z-[2]"
            style={{
              left: `${pct}%`,
              transform: "translateX(-50%)",
              width: `${hitW}px`,
              height: hero ? `${areaH}px` : undefined,
              top: hero ? 0 : undefined,
              visibility: trackWidthPx > 0 ? "visible" : "hidden",
            }}
          >
            <span
              aria-hidden
              className={`ctx-slider-tick ctx-slider-tick--learned absolute left-1/2 -translate-x-1/2 block rounded-sm pointer-events-none${
                isCustom ? " ctx-slider-tick--learned-custom" : ""
              }${isActive ? " ctx-slider-tick--learned-active" : ""}`}
              style={{
                top: `${tickTop}px`,
                height: `${tickH}px`,
                width: isCustom ? "2px" : "3px",
              }}
            />
            <button
              type="button"
              data-preset-tick
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => commitValue(mark)}
              onMouseEnter={() => setHoveredLearned(mark)}
              onMouseLeave={() => setHoveredLearned(null)}
              className="absolute left-1/2 -translate-x-1/2 cursor-pointer bg-transparent border-0 p-0"
              style={{
                top: hero ? 0 : `${tickTop}px`,
                width: `${hitW}px`,
                height: hero ? `${areaH}px` : `${tickH}px`,
              }}
              title={`Learned ${formatTokenLabel(mark)}`}
              aria-label={`Set learned ${formatTokenLabel(mark)}`}
            />
            {showLearnedLabel ? (
              <span
                className={`ctx-slider-tick-tooltip ctx-slider-tick-tooltip--learned absolute left-1/2 type-micro font-mono whitespace-nowrap pointer-events-none${isActive ? " ctx-slider-tick-tooltip--active" : ""}${isCustom ? " ctx-slider-tick-tooltip--custom" : ""}${hero ? " ctx-slider-tick-tooltip--hero" : ""}`}
                style={{ top: "0px", transform: hero ? "translateX(-50%)" : "translate(-50%, -100%)" }}
              >
                {formatTokenLabel(mark)}
              </span>
            ) : null}
          </div>
        );
      })}
      <div
        role="slider"
        tabIndex={0}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-valuenow={safeValue}
        aria-label="Context length"
        className={`ctx-slider-thumb absolute z-[3] rounded-[2px] outline-none focus-visible:ring-1 focus-visible:cfg-ring--inf--a70 ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{
          top: `${trackTop + trackH / 2}px`,
          left: `${thumbPct}%`,
          width: `${thumbW}px`,
          height: `${thumbW}px`,
          transform: "translate(-50%, -50%)",
          visibility: trackWidthPx > 0 ? "visible" : "hidden",
        }}
        onKeyDown={handleKeyDown}
        onPointerDown={(e) => e.currentTarget.focus()}
      />
    </div>
  );
}
