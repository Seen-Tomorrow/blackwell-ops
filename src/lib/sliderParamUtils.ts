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
/** Input / label control height — vertically centered in TRACK_AREA_HEIGHT_PX. */
export const CONTROL_ROW_HEIGHT_PX = 18;
export const TRACK_AREA_HEIGHT_PX = 28;
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

  const [inputStr, setInputStr] = useState<string>(String(safeValue));
  const [userEdited, setUserEdited] = useState(false);

  useLayoutEffect(() => {
    setInputStr(String(safeValue));
    setUserEdited(false);
  }, [safeValue]);

  const commitValue = useCallback(
    (val: number) => {
      const clamped = clampSteppedValue(val, min, max, step);
      onChange(clamped);
      setInputStr(String(clamped));
    },
    [onChange, min, max, step],
  );

  const handleInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    setInputStr(e.target.value);
    setUserEdited(true);
  }, []);

  const handleInputCommit = useCallback(() => {
    let parsed = parseInt(inputStr.trim(), 10);
    if (isNaN(parsed)) parsed = safeValue;
    commitValue(parsed);
    setUserEdited(false);
  }, [inputStr, safeValue, commitValue]);

  const handleInputKeyDown = useCallback(
    (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "Enter") {
        e.preventDefault();
        handleInputCommit();
      }
    },
    [handleInputCommit],
  );

  return {
    inputStr,
    userEdited,
    handleInputChange,
    handleInputCommit,
    handleInputKeyDown,
  };
}