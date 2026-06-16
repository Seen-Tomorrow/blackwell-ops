/**
 * Custom CTX slider — div track, aligned thumb, preset ticks below the rail.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  SLIDER_THUMB_WIDTH_PX,
  TRACK_AREA_HEIGHT_PX,
  TRACK_HEIGHT_PX,
  TRACK_TOP_PX,
  TICK_HEIGHT_PX,
  TICK_TOP_PX,
  clampSteppedValue,
  formatTokenLabel,
  parseSliderValues,
  thumbCenterPercent,
  valueFromPointerX,
  type SliderParamSharedProps,
} from "../lib/sliderParamUtils";

function useTrackWidth() {
  const [trackWidthPx, setTrackWidthPx] = useState(0);
  const observerRef = useRef<ResizeObserver | null>(null);

  const trackRef = useCallback((node: HTMLDivElement | null) => {
    observerRef.current?.disconnect();
    observerRef.current = null;

    if (!node) return;

    const measure = () => {
      const width = node.getBoundingClientRect().width;
      if (width > 0) setTrackWidthPx(width);
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
  onChange,
  step = 1024,
  values = [],
}: SliderParamSharedProps) {
  const numericValues = parseSliderValues(values);
  const min = numericValues.length > 0 ? Math.min(...numericValues) : 2048;
  const max = numericValues.length > 0 ? Math.max(...numericValues) : 524288;

  const numericValue =
    typeof currentValue === "number" ? currentValue : parseInt(String(currentValue), 10);
  const safeValue =
    isNaN(numericValue) || numericValue < min ? min : Math.min(numericValue, max);

  const { trackRef, trackWidthPx } = useTrackWidth();
  const [hoveredPresetIdx, setHoveredPresetIdx] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(false);

  const commitValue = useCallback(
    (val: number) => onChange(clampSteppedValue(val, min, max, step)),
    [onChange, min, max, step],
  );

  const updateFromClientX = useCallback(
    (clientX: number, trackEl: HTMLDivElement) => {
      const rect = trackEl.getBoundingClientRect();
      commitValue(valueFromPointerX(clientX, rect.left, rect.width, min, max, step));
    },
    [commitValue, min, max, step],
  );

  const handleTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("[data-preset-tick]")) return;
      dragRef.current = true;
      setDragging(true);
      e.currentTarget.setPointerCapture(e.pointerId);
      updateFromClientX(e.clientX, e.currentTarget);
    },
    [updateFromClientX],
  );

  const handleTrackPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      updateFromClientX(e.clientX, e.currentTarget);
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

  const thumbPct = thumbCenterPercent(safeValue, min, max, trackWidthPx);

  return (
    <div
      ref={trackRef}
      className="relative flex-1 min-w-0 select-none touch-none"
      style={{ height: `${TRACK_AREA_HEIGHT_PX}px` }}
      onPointerDown={handleTrackPointerDown}
      onPointerMove={handleTrackPointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
    >
      <div
        className="ctx-slider-track absolute left-0 right-0 rounded-sm z-[1]"
        style={{ top: `${TRACK_TOP_PX}px`, height: `${TRACK_HEIGHT_PX}px` }}
      />

      {numericValues.map((pNum, idx) => {
        const pct =
          trackWidthPx > 0 ? thumbCenterPercent(pNum, min, max, trackWidthPx) : 0;
        const isActive = safeValue === pNum;
        return (
          <div
            key={`${paramKey}-tick-${pNum}`}
            data-preset-tick
            className="absolute z-[2]"
            style={{
              left: `${pct}%`,
              transform: "translateX(-50%)",
              width: "8px",
              visibility: trackWidthPx > 0 ? "visible" : "hidden",
            }}
          >
            <span
              aria-hidden
              className={`ctx-slider-tick absolute left-1/2 -translate-x-1/2 block w-[3px] rounded-sm transition-colors${
                isActive ? " ctx-slider-tick--active" : ""
              }`}
              style={{ top: `${TICK_TOP_PX}px`, height: `${TICK_HEIGHT_PX}px` }}
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
                top: `${TICK_TOP_PX}px`,
                width: "8px",
                height: `${TICK_HEIGHT_PX}px`,
              }}
              title={formatTokenLabel(pNum)}
              aria-label={`Set ${formatTokenLabel(pNum)}`}
            />
            {hoveredPresetIdx === idx && (
              <span
                className="ctx-slider-tick-tooltip absolute left-1/2 text-[7px] font-mono whitespace-nowrap pointer-events-none"
                style={{ top: "0px", transform: "translate(-50%, -100%)" }}
              >
                {formatTokenLabel(pNum)}
              </span>
            )}
          </div>
        );
      })}

      <div
        className={`ctx-slider-thumb absolute z-[3] rounded-[2px] ${
          dragging ? "cursor-grabbing" : "cursor-grab"
        }`}
        style={{
          top: `${TRACK_TOP_PX + TRACK_HEIGHT_PX / 2}px`,
          left: `${thumbPct}%`,
          width: `${SLIDER_THUMB_WIDTH_PX}px`,
          height: `${SLIDER_THUMB_WIDTH_PX}px`,
          transform: "translate(-50%, -50%)",
          visibility: trackWidthPx > 0 ? "visible" : "hidden",
        }}
        aria-hidden
      />
    </div>
  );
}