/**
 * CTX / slider param — custom track + numeric input.
 */

import React from "react";
import { useSliderParamState, type SliderParamSharedProps } from "../lib/sliderParamUtils";
import CustomSliderParam from "./CustomSliderParam";

interface SliderParamProps extends SliderParamSharedProps {
  perSlotLabel?: string;
  perSlotTitle?: string;
  /** Reserve fixed per-slot field width (avoids track jump when parallel > 1). */
  perSlotReserve?: boolean;
}

export default function SliderParam({
  perSlotLabel,
  perSlotTitle,
  perSlotReserve = false,
  ...props
}: SliderParamProps) {
  const {
    inputStr,
    userEdited,
    handleInputChange,
    handleInputCommit,
    handleInputKeyDown,
  } = useSliderParamState(props);

  const showPerSlotField = perSlotReserve || Boolean(perSlotLabel);

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="ctx-slider-row flex items-center gap-2 min-w-0">
        <CustomSliderParam {...props} />

        <input
          type="text"
          value={inputStr}
          onChange={handleInputChange}
          onBlur={handleInputCommit}
          onKeyDown={handleInputKeyDown}
          className={`ctx-slider-value-input w-16 px-2 py-0.5 text-[9px] font-mono border rounded-sm transition-colors flex-shrink-0 text-right${
            userEdited ? " ctx-slider-value-input--edited mono-user-input" : ""
          }`}
        />

        {showPerSlotField && (
          <span
            className="ctx-slider-value-input ctx-slider-per-slot px-1.5 py-0.5 text-[8px] font-mono border rounded-sm flex-shrink-0 text-right"
            title={perSlotTitle}
          >
            {perSlotLabel ? `${perSlotLabel} /slot` : "— /slot"}
          </span>
        )}
      </div>
    </div>
  );
}