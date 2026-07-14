/**
 * CTX / slider param — custom track + numeric input.
 */

import React from "react";
import {
  formatCtxChipLabel,
  useSliderParamState,
  type SliderParamSharedProps,
} from "../lib/sliderParamUtils";
import CustomSliderParam from "./CustomSliderParam";

interface SliderParamProps extends SliderParamSharedProps {
  /** Per-slot token count (shown as rounded K/M chip when parallel > 1). */
  perSlotTokens?: number;
  perSlotTitle?: string;
  /** Reserve fixed per-slot field width (avoids track jump when parallel > 1). */
  perSlotReserve?: boolean;
}

export default function SliderParam({
  perSlotTokens,
  perSlotTitle,
  perSlotReserve = false,
  ...props
}: SliderParamProps) {
  const {
    shownValue,
    userEdited,
    beginEdit,
    finishEdit,
    handleInputChange,
    handleInputKeyDown,
  } = useSliderParamState(props);

  const showPerSlotField = perSlotReserve || (perSlotTokens != null && perSlotTokens > 0);
  const perSlotLabel =
    perSlotTokens != null && perSlotTokens > 0 ? formatCtxChipLabel(perSlotTokens) : undefined;
  const chipBase = "py-0.5 text-[9px] font-mono rounded-sm focus:outline-none";

  return (
    <div className="ctx-slider-row flex items-center gap-1 min-w-0 flex-1">
      <CustomSliderParam {...props} />

      <input
        type="text"
        value={shownValue}
        onFocus={beginEdit}
        onChange={handleInputChange}
        onBlur={finishEdit}
        onKeyDown={handleInputKeyDown}
        className={`ctx-slider-value-input ctx-slider-chip--reserve flex-shrink-0 text-center ${chipBase} value-chip-active${
          userEdited ? " mono-user-input" : ""
        }`}
      />

      {showPerSlotField && (
        <div className="ctx-slider-per-slot-stack ctx-slider-chip--reserve flex-shrink-0" title={perSlotTitle}>
          <span className={`ctx-slider-per-slot-chip text-center ${chipBase} value-chip`}>
            {perSlotLabel ?? "—"}
          </span>
          <span className="ctx-slider-per-slot-caption font-mono uppercase tracking-wide">/slot</span>
        </div>
      )}
    </div>
  );
}