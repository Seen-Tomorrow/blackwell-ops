/**
 * CTX / slider param — custom track + numeric input.
 */

import React from "react";
import { useSliderParamState, type SliderParamSharedProps } from "../lib/sliderParamUtils";
import CustomSliderParam from "./CustomSliderParam";

export default function SliderParam(props: SliderParamSharedProps) {
  const {
    inputStr,
    userEdited,
    handleInputChange,
    handleInputCommit,
    handleInputKeyDown,
  } = useSliderParamState(props);

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center gap-2 min-w-0">
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
      </div>
    </div>
  );
}