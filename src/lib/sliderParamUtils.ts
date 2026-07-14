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

export interface SliderParamSharedProps {
  paramKey: string;
  currentValue?: number | string;
  /** Configured default — strong tick highlight; independent of slider position. */
  defaultValue?: number | string;
  onChange: (value: number) => void;
  step?: number;
  values?: (string | number)[];
}

export function parseSliderValues(values: (string | number)[]): number[] {
  return values
    .map((v) => (typeof v === "number" ? v : parseInt(String(v), 10)))
    .filter((n) => !isNaN(n));
}

export function formatTokenLabel(n: number): string {
  if (n >= 1_048_576) {
    return `${(n / 1_048_576).toFixed(n % 1_048_576 === 0 ? 0 : 1)}M`;
  }
  if (n >= 1024) {
    return `${n / 1024}K`;
  }
  return String(n);
}

/** Rounded K/M chip label — CTX total + per-slot (e.g. 256K, not 262144 or 59.125K). */
export function formatCtxChipLabel(n: number): string {
  if (n >= 1_048_576) {
    const m = n / 1_048_576;
    return m % 1 === 0 ? `${m}M` : `${Math.round(m * 10) / 10}M`;
  }
  if (n >= 1024) {
    return `${Math.round(n / 1024)}K`;
  }
  return String(Math.round(n));
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
): number {
  if (max <= min || trackWidthPx <= 0) return 0;
  const ratio = (value - min) / (max - min);
  const centerPx =
    SLIDER_THUMB_WIDTH_PX / 2 + ratio * (trackWidthPx - SLIDER_THUMB_WIDTH_PX);
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

export function valueFromPointerX(
  clientX: number,
  trackLeft: number,
  trackWidth: number,
  min: number,
  max: number,
  step: number,
): number {
  if (trackWidth <= SLIDER_THUMB_WIDTH_PX) return min;
  const ratio = (clientX - trackLeft - SLIDER_THUMB_WIDTH_PX / 2) / (trackWidth - SLIDER_THUMB_WIDTH_PX);
  const clamped = Math.max(0, Math.min(1, ratio));
  const raw = min + clamped * (max - min);
  return clampSteppedValue(raw, min, max, step);
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