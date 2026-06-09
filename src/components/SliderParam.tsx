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
          className={`w-16 px-2 py-0.5 text-[9px] font-mono border rounded-sm focus:outline-none transition-colors flex-shrink-0 ${
            userEdited
              ? "bg-black border-white/30 focus:border-white/50 mono-user-input"
              : "bg-green-400/5 border-green-400/20 focus:border-green-400/40"
          } text-right`}
        />
      </div>
    </div>
  );
}