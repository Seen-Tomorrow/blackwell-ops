/**
 * CockpitSlider — discrete option slider for the Full Auto cockpit rows.
 * Similar to the CTX slider but with labeled marks as choices.
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

const THUMB_WIDTH = 16;
const TRACK_HEIGHT = 6;
const TRACK_AREA_BASE = 32;
const TRACK_AREA_WITH_ABOVE = 46;

export interface CockpitSliderOption {
  id: string;
  label: string;
  blurb?: string;
  disabled?: boolean;
  /** Strikethrough label (e.g. multi-agent locked while MTP is on). */
  strike?: boolean;
  /**
   * Accent when available — MTP=green, DFlash=violet.
   * Unavailable options stay monochrome like Agents / Memory.
   */
  badgeColor?: "green" | "violet";
  emphasize?: boolean;
  /** Tiny status above the mark (e.g. "draft ready"). */
  aboveLabel?: string;
  /** User-added / non-preset factory value — slightly different mark style. */
  custom?: boolean;
}

interface CockpitSliderProps {
  options: CockpitSliderOption[];
  value: string;
  onChange: (value: string) => void;
  label: string;
  /** Optional right-side badge showing the value (e.g. "x8"). */
  valueBadge?: string;
  /** Reserved width for the badge (prevents layout shift). */
  badgeWidth?: string;
  /** Use hero-style badge (larger, CTX hero formatting). */
  heroBadge?: boolean;
  className?: string;
}

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

/** Position a thumb at the given index in a list of options. */
function thumbPercent(idx: number, count: number, trackWidthPx: number): number {
  if (count <= 1 || trackWidthPx <= 0) return 0;
  const ratio = idx / (count - 1);
  const centerPx = THUMB_WIDTH / 2 + ratio * (trackWidthPx - THUMB_WIDTH);
  return (centerPx / trackWidthPx) * 100;
}

/** Map client X to the nearest option index. */
function indexFromClientX(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  count: number,
): number {
  if (trackWidth <= THUMB_WIDTH) return 0;
  const ratio = (clientX - trackLeft - THUMB_WIDTH / 2) / (trackWidth - THUMB_WIDTH);
  const clamped = Math.max(0, Math.min(1, ratio));
  return Math.round(clamped * (count - 1));
}

export default function CockpitSlider({
  options,
  value,
  onChange,
  label,
  valueBadge,
  badgeWidth = "3rem",
  heroBadge = false,
  className = "",
}: CockpitSliderProps) {
  const { trackRef, trackWidthPx } = useTrackWidth();
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef(false);

  const hasAbove = options.some((o) => Boolean(o.aboveLabel));
  const trackAreaH = hasAbove ? TRACK_AREA_WITH_ABOVE : TRACK_AREA_BASE;
  const trackTop = (trackAreaH - TRACK_HEIGHT) / 2 + (hasAbove ? 4 : 0);

  const selectedIdx = Math.max(0, options.findIndex((o) => o.id === value));

  const commitIndex = useCallback(
    (idx: number) => {
      const safe = Math.max(0, Math.min(options.length - 1, idx));
      const opt = options[safe];
      if (opt && !opt.disabled) onChange(opt.id);
    },
    [options, onChange],
  );

  const updateFromClientX = useCallback(
    (clientX: number, trackEl: HTMLDivElement) => {
      const rect = trackEl.getBoundingClientRect();
      commitIndex(indexFromClientX(clientX, rect.left, rect.width, options.length));
    },
    [commitIndex, options.length],
  );

  const handleTrackPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      if ((e.target as HTMLElement).closest("[data-cockpit-mark]")) return;
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

  const thumbPct = thumbPercent(selectedIdx, options.length, trackWidthPx);

  return (
    <div className={`cockpit-slider-row flex items-center gap-x-1 gap-y-1 min-w-0 ${className}`}>
      <span className="full-auto-cockpit__row-label font-mono tracking-wider uppercase flex-shrink-0">
        {label}
      </span>
      <div className="flex items-center gap-1 min-w-0 flex-1">
        <div
          ref={trackRef}
          className="cockpit-slider-track-host relative flex-1 min-w-0 select-none touch-none"
          style={{ height: `${trackAreaH}px` }}
          onPointerDown={handleTrackPointerDown}
          onPointerMove={handleTrackPointerMove}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {/* Track line */}
          <div
            className="cockpit-slider-track absolute left-0 right-0 rounded-sm z-[1]"
            style={{ top: `${trackTop}px`, height: `${TRACK_HEIGHT}px` }}
          />

          {/* Option marks — always visible */}
          {options.map((opt, idx) => {
            const pct = trackWidthPx > 0 ? thumbPercent(idx, options.length, trackWidthPx) : 0;
            const isSelected = idx === selectedIdx;
            const emphasize = Boolean(opt.emphasize && opt.badgeColor && !opt.disabled);
            return (
              <div
                key={opt.id}
                data-cockpit-mark
                className={`absolute z-[2] cursor-pointer${
                  opt.disabled ? " cockpit-slider-mark-wrap--disabled" : ""
                }${opt.strike ? " cockpit-slider-mark-wrap--strike" : ""}${
                  opt.custom ? " cockpit-slider-mark-wrap--custom" : ""
                }`}
                style={{
                  left: `${pct}%`,
                  transform: "translateX(-50%)",
                  width: "10px",
                  visibility: trackWidthPx > 0 ? "visible" : "hidden",
                }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={() => commitIndex(idx)}
                title={
                  opt.strike
                    ? `${opt.label}: not available with MTP (Solo only)`
                    : opt.blurb || opt.label
                }
                role="button"
                aria-label={`Select ${opt.label}`}
                aria-disabled={opt.disabled || undefined}
                tabIndex={opt.disabled ? -1 : 0}
              >
                {opt.aboveLabel ? (
                  <span
                    className={`cockpit-slider-above-label absolute left-1/2 -translate-x-1/2 text-center font-mono whitespace-nowrap${
                      emphasize && opt.badgeColor === "green"
                        ? " cockpit-slider-above-label--green"
                        : emphasize && opt.badgeColor === "violet"
                          ? " cockpit-slider-above-label--violet"
                          : ""
                    }${isSelected ? " cockpit-slider-above-label--selected" : ""}`}
                    style={{ top: `${Math.max(0, trackTop - 12)}px` }}
                  >
                    {opt.aboveLabel}
                  </span>
                ) : null}
                <span
                  aria-hidden
                  className={`cockpit-slider-mark absolute left-1/2 -translate-x-1/2 block w-[3px] rounded-sm transition-colors ${
                    isSelected ? "cockpit-slider-mark--selected" : ""
                  }${
                    emphasize && opt.badgeColor
                      ? ` cockpit-slider-mark--${opt.badgeColor}${isSelected ? "" : " cockpit-slider-mark--tint"}`
                      : ""
                  }`}
                  style={{ top: `${trackTop}px`, height: `${TRACK_HEIGHT}px` }}
                />
                {/* Label below mark — MTP green / DFlash violet when capable */}
                <span
                  className={`cockpit-slider-mark-label absolute left-1/2 -translate-x-1/2 text-center font-mono whitespace-nowrap ${
                    isSelected ? "cockpit-slider-mark-label--selected" : ""
                  }${emphasize && opt.badgeColor ? ` cockpit-slider-mark-label--${opt.badgeColor}` : ""}${
                    opt.disabled ? " cockpit-slider-mark-label--muted" : ""
                  }${opt.strike ? " cockpit-slider-mark-label--strike" : ""}${
                    opt.custom ? " cockpit-slider-mark-label--custom" : ""
                  }`}
                  style={{ top: `${trackTop + TRACK_HEIGHT + 4}px` }}
                >
                  {opt.custom ? `·${opt.label}` : opt.label}
                </span>
              </div>
            );
          })}

          {/* Thumb */}
          <div
            className={`cockpit-slider-thumb absolute z-[3] rounded-[2px] ${
              dragging ? "cursor-grabbing" : "cursor-grab"
            }`}
            style={{
              top: `${trackTop + TRACK_HEIGHT / 2}px`,
              left: `${thumbPct}%`,
              width: `${THUMB_WIDTH}px`,
              height: `${THUMB_WIDTH}px`,
              transform: "translate(-50%, -50%)",
              visibility: trackWidthPx > 0 ? "visible" : "hidden",
            }}
            aria-hidden
          />
        </div>

        {/* Value badge — right side with reserved left padding for growth */}
        <div
          className="flex-shrink-0 font-mono text-[10px]"
          style={{ paddingLeft: heroBadge ? "2ch" : "0.4rem", minWidth: badgeWidth }}
        >
          {valueBadge ? (
            <span className={`cockpit-slider-badge inline-block rounded-sm px-1.5 py-0.5${heroBadge ? " cockpit-slider-badge--hero" : ""}`}>
              {valueBadge}
            </span>
          ) : null}
        </div>
      </div>
    </div>
  );
}
