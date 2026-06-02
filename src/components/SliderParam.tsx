/**
 * SliderParam — Numeric range input with vertical tick marks overlaid on track.
 * Ticks come from param.values. Range = values[0]..values[last].
 */

import React, { useCallback, useState } from "react";

interface SliderParamProps {
  paramKey: string;
  currentValue?: number | string;
  onChange: (value: number) => void;
  step?: number;
  values?: (string | number)[];
}

function formatTokenLabel(n: number): string {
  if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(n % 1_048_576 === 0 ? 0 : 1)}M`;
  if (n >= 1024) {
    const k = n / 1024;
    return `${k}K`;
  }
  return String(n);
}

export default function SliderParam({
  paramKey,
  currentValue,
  onChange,
  step = 1024,
  values = [],
}: SliderParamProps) {
  const numericValues = values.map(v => typeof v === 'number' ? v : parseInt(String(v), 10)).filter(n => !isNaN(n));
  const min = numericValues.length > 0 ? Math.min(...numericValues) : 2048;
  const max = numericValues.length > 0 ? Math.max(...numericValues) : 524288;

  const numericValue = typeof currentValue === 'number'
    ? currentValue
    : parseInt(String(currentValue), 10);
  const safeValue = isNaN(numericValue) || numericValue < min ? min : Math.min(numericValue, max);

  const [inputStr, setInputStr] = useState<string>(String(safeValue));
  const [userEdited, setUserEdited] = useState(false);
  const [hoveredPresetIdx, setHoveredPresetIdx] = useState<number | null>(null);

  const handleSliderChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const val = parseInt(e.target.value, 10);
    if (!isNaN(val)) {
      onChange(Math.max(min, Math.min(max, val)));
      setInputStr(String(val));
    }
  }, [onChange, min, max]);

  const handleInputChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    setInputStr(e.target.value);
    setUserEdited(true);
  }, []);

  const handleInputCommit = useCallback(() => {
    let parsed = parseInt(inputStr.trim(), 10);
    if (isNaN(parsed)) parsed = safeValue;
    parsed = Math.round(parsed / step) * step;
    parsed = Math.max(min, Math.min(max, parsed));
    onChange(parsed);
    setInputStr(String(parsed));
  }, [inputStr, safeValue, onChange, min, max, step]);

  const handleInputKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      handleInputCommit();
    }
  }, [handleInputCommit]);

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Slider row: slider wrapper + numeric input */}
      <div className="flex items-center gap-2">
        <div className="relative flex-1" style={{ height: '24px' }}>
          {/* Tick marks — extend through track, visible above/below */}
          {numericValues.length > 0 && (
            <div
              className="absolute inset-x-0 top-0 pointer-events-none z-[10]"
              style={{ height: '24px' }}
              onMouseLeave={() => setHoveredPresetIdx(null)}
            >
              {numericValues.map((pNum, idx) => {
                const pct = ((pNum - min) / (max - min)) * 100;
                const isActive = safeValue === pNum;
                return (
                  <div
                    key={`${paramKey}-tick-${pNum}`}
                    className="absolute top-0 pointer-events-auto cursor-pointer"
                    style={{ left: `${pct}%`, transform: 'translateX(-50%)', height: '24px' }}
                  >
                     <button
                       onClick={() => { onChange(pNum); setInputStr(String(pNum)); setUserEdited(false); }}
                       onMouseEnter={() => setHoveredPresetIdx(idx)}
                       className={`absolute block w-[2px] transition-all ${
                         isActive ? "bg-[#4ade80]" : "bg-white/40 hover:bg-[#4ade80]/70"
                       }`}
                       style={{ height: 'calc(100% - 3px)', top: '8px' }}
                      title={formatTokenLabel(pNum)}
                    />
                    {hoveredPresetIdx === idx && (
                       <span className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-full mt-1 text-[7px] font-mono text-[#4ade80] whitespace-nowrap pointer-events-none">
                        {formatTokenLabel(pNum)}
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Track outline only — no fill, centered vertically */}
          <div
            className="absolute left-0 right-0 top-1/2 -translate-y-1/2 h-[6px] rounded-sm border border-[#4ade80]/30 pointer-events-none z-[2]"
          />

          <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={safeValue}
            onChange={handleSliderChange}
            className="slider-param absolute left-0 right-0 top-1/2 -translate-y-1/2 w-full h-[6px] cursor-pointer rounded-sm appearance-none z-[3] [&::-webkit-slider-runnable-track]:bg-transparent [&::-webkit-slider-runnable-track]:border-none [&::-moz-range-track]:bg-transparent [&::-moz-range-track]:border-none [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:w-[15px] [&::-webkit-slider-thumb]:h-[15px] [&::-webkit-slider-thumb]:rounded-[2px] [&::-webkit-slider-thumb]:bg-[#4ade80] [&::-webkit-slider-thumb]:-mt-[3px] [&::-moz-range-thumb]:w-[15px] [&::-moz-range-thumb]:h-[15px] [&::-moz-range-thumb]:rounded-[2px] [&::-moz-range-thumb]:bg-[#4ade80]"
          />
        </div>

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