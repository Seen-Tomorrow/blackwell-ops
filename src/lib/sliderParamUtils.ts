import {
  useCallback,
  useLayoutEffect,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from "react";

export const SLIDER_THUMB_WIDTH_PX = 15;
export const TRACK_HEIGHT_PX = 6;
export const TICK_ZONE_HEIGHT_PX = 8;
/** Input / label control height — matches value-chip row in param rows. */
export const CONTROL_ROW_HEIGHT_PX = 18;
/** Visible track band — preset ticks overflow below without stretching the param row. */
export const TRACK_AREA_HEIGHT_PX = CONTROL_ROW_HEIGHT_PX;
export const TRACK_TOP_PX = (TRACK_AREA_HEIGHT_PX - TRACK_HEIGHT_PX) / 2;
export const TRACK_BOTTOM_PX = TRACK_TOP_PX + TRACK_HEIGHT_PX;
export const TICK_TOP_PX = TRACK_BOTTOM_PX + 2;
export const TICK_HEIGHT_PX = TICK_ZONE_HEIGHT_PX;

/**
 * CTX hero rail — taller host so value labels sit above the bar and ticks
 * run label→through-rail→below (bigger hit targets for learned marks).
 */
export const HERO_TRACK_AREA_HEIGHT_PX = 32;
/** Double the inline track thickness. */
export const HERO_TRACK_HEIGHT_PX = 12;
export const HERO_LABEL_ZONE_PX = 10;
export const HERO_TRACK_TOP_PX = HERO_LABEL_ZONE_PX + 1;
/** Tick bar from under label through rail and a few px below. */
export const HERO_TICK_HEIGHT_PX = HERO_TRACK_AREA_HEIGHT_PX - HERO_LABEL_ZONE_PX;
export const HERO_TICK_TOP_PX = HERO_LABEL_ZONE_PX;
export const HERO_HIT_WIDTH_PX = 16;
/** ~25% larger than inline thumb (15 → 19). */
export const HERO_SLIDER_THUMB_WIDTH_PX = 19;

export interface SliderParamSharedProps {
  paramKey: string;
  currentValue?: number | string;
  defaultValue?: number | string;
  onChange: (value: number) => void;
  step?: number;
  values?: (string | number)[];
  /** Launch-measured ctx tokens — cyan ticks on the rail. */
  learnedMarks?: number[];
  /** all = preset+custom learned; regular = preset-only; off = hidden. */
  learnedMarkMode?: "all" | "regular" | "off";
  /** `hero` = CTX strip (taller marks + labels). Default inline param row. */
  layout?: "inline" | "hero";
  /** Measured curve for fits-boundary ghost (hero). */
  forecastCurve?: Array<{ ctx: number; gb: number }>;
  /** Free GPU pool GB for fits ghost. */
  forecastFreeGb?: number;
  /** When false, hero rail stays the theme track (MARKS mode). */
  forecastRibbonOnTrack?: boolean;
}

export function parseSliderValues(values: (string | number)[]): number[] {
  return values
    .map((v) => (typeof v === "number" ? v : parseInt(String(v), 10)))
    .filter((n) => !isNaN(n));
}

/**
 * Compact token label for CTX ticks / hero.
 * Prefer clean decimal K/M when the value is a round 1000/1e6 multiple (750000 → 750K);
 * otherwise binary-style rounded K/M (262144 → 256K). Never emit long fractions.
 */
export function formatTokenLabel(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs >= 1_000_000 && n % 1_000_000 === 0) return `${n / 1_000_000}M`;
  if (abs >= 1000 && n % 1000 === 0) return `${n / 1000}K`;
  if (abs >= 1_048_576) {
    const m = n / 1_048_576;
    return m % 1 === 0 ? `${m}M` : `${Math.round(m * 10) / 10}M`;
  }
  if (abs >= 1024) {
    return `${Math.round(n / 1024)}K`;
  }
  return String(Math.round(n));
}

/** Rounded K/M chip label — same rules as formatTokenLabel (CTX total + per-slot). */
export function formatCtxChipLabel(n: number): string {
  return formatTokenLabel(n);
}

/** @deprecated Use formatCtxChipLabel */
export const formatPerSlotTokenLabel = formatCtxChipLabel;

/** Parse CTX field — raw integers (20000) or K/M suffix (256K, 1.5M). */
export function parseCtxTokenInput(raw: string): number | null {
  const s = raw.trim().replace(/,/g, "");
  if (!s) return null;
  const km = /^(\d+(?:\.\d+)?)\s*([kKmM])$/.exec(s);
  if (km) {
    const n = parseFloat(km[1]);
    if (isNaN(n)) return null;
    const mult = km[2].toLowerCase() === "m" ? 1_048_576 : 1024;
    return Math.round(n * mult);
  }
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

/** Map value → thumb-center % of track (accounts for thumb inset at min/max). */
export function thumbCenterPercent(
  value: number,
  min: number,
  max: number,
  trackWidthPx: number,
  thumbWidthPx: number = SLIDER_THUMB_WIDTH_PX,
): number {
  if (max <= min || trackWidthPx <= 0) return 0;
  const ratio = (value - min) / (max - min);
  const centerPx =
    thumbWidthPx / 2 + ratio * (trackWidthPx - thumbWidthPx);
  return (centerPx / trackWidthPx) * 100;
}

export function clampSteppedValue(
  raw: number,
  min: number,
  max: number,
  step: number,
): number {
  const stepped = Math.round(raw / step) * step;
  return Math.max(min, Math.min(max, stepped));
}

/** Pixel radius for LEARNED magnetic notches (hero rail). */
export const LEARNED_SNAP_RADIUS_PX = 12;

/**
 * Pull value onto nearest mark when within snapRadiusPx of that mark on the track.
 * `freeDrag` (Alt/Shift) disables magnetism.
 */
export function snapToNearestMark(
  value: number,
  marks: number[],
  min: number,
  max: number,
  step: number,
  trackWidthPx: number,
  freeDrag: boolean,
  snapRadiusPx: number = LEARNED_SNAP_RADIUS_PX,
  thumbWidthPx: number = SLIDER_THUMB_WIDTH_PX,
): number {
  const stepped = clampSteppedValue(value, min, max, step);
  if (freeDrag || marks.length === 0 || trackWidthPx <= thumbWidthPx || max <= min) {
    return stepped;
  }
  const usable = trackWidthPx - thumbWidthPx;
  const valuePerPx = (max - min) / usable;
  const radiusVal = snapRadiusPx * valuePerPx;
  let best = stepped;
  let bestDist = Infinity;
  for (const m of marks) {
    if (m < min || m > max) continue;
    const d = Math.abs(m - stepped);
    if (d <= radiusVal && d < bestDist) {
      bestDist = d;
      best = m;
    }
  }
  return clampSteppedValue(best, min, max, step);
}

export function valueFromPointerX(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  min: number,
  max: number,
  step: number,
  thumbWidthPx: number = SLIDER_THUMB_WIDTH_PX,
): number {
  if (trackWidth <= thumbWidthPx) return min;
  const ratio =
    (clientX - trackLeft - thumbWidthPx / 2) / (trackWidth - thumbWidthPx);
  const clamped = Math.max(0, Math.min(1, ratio));
  const raw = min + clamped * (max - min);
  return clampSteppedValue(raw, min, max, step);
}

/** Piecewise-linear GB at ctx from sparse measured anchors. */
export function interpolateGbAtCtx(
  curve: Array<{ ctx: number; gb: number }>,
  ctx: number,
): number | null {
  const pts = curve
    .filter((p) => p.ctx > 0 && p.gb > 0)
    .slice()
    .sort((a, b) => a.ctx - b.ctx);
  if (pts.length === 0) return null;
  if (pts.length === 1) return pts[0].gb;
  if (ctx <= pts[0].ctx) {
    const a = pts[0];
    const b = pts[1];
    if (b.ctx === a.ctx) return a.gb;
    const t = (ctx - a.ctx) / (b.ctx - a.ctx);
    return Math.max(0, a.gb + t * (b.gb - a.gb));
  }
  if (ctx >= pts[pts.length - 1].ctx) {
    const a = pts[pts.length - 2];
    const b = pts[pts.length - 1];
    if (b.ctx === a.ctx) return b.gb;
    const t = (ctx - a.ctx) / (b.ctx - a.ctx);
    return Math.max(0, a.gb + t * (b.gb - a.gb));
  }
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    if (ctx >= a.ctx && ctx <= b.ctx) {
      if (b.ctx === a.ctx) return a.gb;
      const t = (ctx - a.ctx) / (b.ctx - a.ctx);
      return Math.max(0, a.gb + t * (b.gb - a.gb));
    }
  }
  return pts[pts.length - 1].gb;
}

/**
 * Highest ctx that still fits in freeGb (same 3% / 1G headroom as forecast gate).
 * null when curve empty or free unknown.
 */
export function findMaxFittingCtx(
  min: number,
  max: number,
  step: number,
  freeGb: number,
  curve: Array<{ ctx: number; gb: number }>,
): number | null {
  if (!(freeGb > 0) || curve.length === 0 || max <= min) return null;
  const headroom = Math.max(1.0, freeGb * 0.03);
  const budget = freeGb - headroom;
  if (!(budget > 0)) return null;

  const fits = (ctx: number): boolean | null => {
    const gb = interpolateGbAtCtx(curve, ctx);
    if (gb == null) return null;
    return gb <= budget;
  };

  const loOk = fits(min);
  const hiOk = fits(max);
  if (loOk == null && hiOk == null) return null;
  if (loOk === false) return min;
  if (hiOk === true) return max;

  let lo = min;
  let hi = max;
  // Binary search highest fitting stepped ctx.
  for (let i = 0; i < 48; i++) {
    if (hi - lo <= step) break;
    const mid = clampSteppedValue((lo + hi) / 2, min, max, step);
    if (mid <= lo || mid >= hi) break;
    const ok = fits(mid);
    if (ok == null) break;
    if (ok) lo = mid;
    else hi = mid;
  }
  return lo;
}

export function useSliderParamState({
  currentValue,
  onChange,
  step = 1024,
  values = [],
}: Pick<SliderParamSharedProps, "currentValue" | "onChange" | "step" | "values">) {
  const numericValues = parseSliderValues(values);
  const min = numericValues.length > 0 ? Math.min(...numericValues) : 2048;
  const max = numericValues.length > 0 ? Math.max(...numericValues) : 524288;

  const numericValue =
    typeof currentValue === "number" ? currentValue : parseInt(String(currentValue), 10);
  const safeValue =
    isNaN(numericValue) || numericValue < min ? min : Math.min(numericValue, max);

  const [editing, setEditing] = useState(false);
  const [draftStr, setDraftStr] = useState(String(safeValue));

  const displayLabel = formatCtxChipLabel(safeValue);

  useLayoutEffect(() => {
    if (!editing) {
      setDraftStr(String(safeValue));
    }
  }, [safeValue, editing]);

  const commitValue = useCallback(
    (val: number) => {
      const clamped = clampSteppedValue(val, min, max, step);
      onChange(clamped);
      setDraftStr(String(clamped));
    },
    [onChange, min, max, step],
  );

  const beginEdit = useCallback(() => {
    setDraftStr(String(safeValue));
    setEditing(true);
  }, [safeValue]);

  const finishEdit = useCallback(() => {
    const parsed = parseCtxTokenInput(draftStr);
    commitValue(parsed ?? safeValue);
    setEditing(false);
  }, [draftStr, safeValue, commitValue]);

  const handleInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setDraftStr(e.target.value);
  }, []);

  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        finishEdit();
        (e.target as HTMLInputElement).blur();
      }
    },
    [finishEdit],
  );

  const shownValue = editing ? draftStr : displayLabel;
  const userEdited = editing && draftStr.trim() !== String(safeValue);

  return {
    shownValue,
    editing,
    userEdited,
    beginEdit,
    finishEdit,
    handleInputChange,
    handleInputKeyDown,
  };
}