import { useState } from "react";
import type { GpuControlDeviceInfo, GpuControlOcMode, GpuControlSharedPreset } from "../lib/types";

interface GpuOverclockPanelProps {
  ocMode: GpuControlOcMode;
  syncGroupCount: number;
  syncGroupName: string;
  selectedGpuIndex: number;
  sliderDevice: GpuControlDeviceInfo | null;
  activePreset: GpuControlSharedPreset;
  busy: boolean;
  elevated: boolean | null;
  devicesCount: number;
  initialLoading: boolean;
  error: string | null;
  status: string | null;
  onModeChange: (mode: GpuControlOcMode) => void;
  onPatchPreset: (patch: Partial<GpuControlSharedPreset>) => void;
  onApply: () => void | Promise<void>;
  onResetAll: () => void | Promise<void>;
  onResetGpu: () => void | Promise<void>;
}

const modeBtn =
  "app-nav-tab w-full px-2.5 py-2 text-[9px] font-mono tracking-wider rounded-sm";

const actionBtn =
  "app-nav-tab w-full px-2 text-[9px] font-mono tracking-wider rounded-sm flex items-center justify-center";

const VALUE_W = "w-[6.5rem]";

const ROW_H = "min-h-[8.25rem]";

function sliderDefaultPct(min: number, max: number, mark: number): number {
  if (max <= min) return 0;
  const clamped = Math.min(max, Math.max(min, mark));
  return ((clamped - min) / (max - min)) * 100;
}

export default function GpuOverclockPanel({
  ocMode,
  syncGroupCount,
  syncGroupName,
  selectedGpuIndex,
  sliderDevice,
  activePreset,
  busy,
  elevated,
  devicesCount,
  initialLoading,
  error,
  status,
  onModeChange,
  onPatchPreset,
  onApply,
  onResetAll,
  onResetGpu,
}: GpuOverclockPanelProps) {
  const [expanded, setExpanded] = useState(true);

  const powerMin = sliderDevice ? Math.round(sliderDevice.powerMinW) : 0;
  const powerMax = sliderDevice ? Math.round(sliderDevice.powerMaxW) : 0;
  const powerDefault = sliderDevice ? Math.round(sliderDevice.powerDefaultW) : 0;

  const targetLabel =
    ocMode === "sync" && syncGroupCount > 0
      ? `${syncGroupCount}× ${syncGroupName}`
      : `GPU ${selectedGpuIndex}`;

  const feedback = error ?? (status && !error ? status : null);
  const feedbackTone = error ? "text-red-400/90" : "text-nv-green/90";

  return (
    <div className="theme-surface rounded-sm overflow-hidden" data-gpu-overclock>
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="theme-surface-header w-full px-3 py-2 border-b border-stealth-border flex items-center gap-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <span className="text-[10px] font-mono text-white tracking-wider shrink-0">OVERCLOCKING</span>
        <span
          className={`flex-1 min-w-0 text-[8px] font-mono truncate text-right leading-none min-h-[0.65rem] ${feedback ? feedbackTone : "text-transparent select-none"}`}
          aria-live="polite"
        >
          {feedback ?? "·"}
        </span>
        <span className="text-[9px] font-mono text-stealth-muted shrink-0 w-3 text-center">
          {expanded ? "−" : "+"}
        </span>
      </button>

      {expanded && (
        <div className="px-3 py-3 space-y-3">
          <p className="text-[8px] font-mono text-stealth-muted/80 leading-relaxed">
            Power limits and clock offsets via nvidia-smi + Nvidia Inspector — at your own risk.
            Mem clock may only change under load.
          </p>

          <div
            className={`grid w-full gap-3 items-stretch ${ROW_H}`}
            style={{
              gridTemplateColumns:
                "minmax(5.5rem, 0.55fr) minmax(12rem, 1fr) minmax(5rem, 0.42fr) minmax(5rem, 0.42fr)",
            }}
          >
            {/* Mode */}
            <div className="flex flex-col gap-1.5 h-full">
              <button
                type="button"
                disabled={busy}
                onClick={() => onModeChange("sync")}
                className={`${modeBtn} flex-1 ${ocMode === "sync" ? "app-nav-tab-active" : ""}`}
              >
                SYNC
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onModeChange("individual")}
                className={`${modeBtn} flex-1 ${ocMode === "individual" ? "app-nav-tab-active" : ""}`}
              >
                PER GPU
              </button>
              <p
                className="text-[7px] font-mono text-stealth-muted leading-tight truncate px-0.5"
                title={targetLabel}
              >
                {targetLabel}
              </p>
            </div>

            {/* Sliders */}
            <div className="flex flex-col h-full min-h-0">
              {sliderDevice ? (
                <>
                  <OcSlider
                    label="POWER"
                    value={activePreset.powerLimitW}
                    display={`${activePreset.powerLimitW}W`}
                    min={powerMin}
                    max={powerMax}
                    step={5}
                    disabled={busy}
                    defaultMark={powerDefault}
                    defaultTitle={`Driver default: ${powerDefault}W`}
                    onChange={(v) => onPatchPreset({ powerLimitW: v })}
                  />
                  <OcSlider
                    label="CORE"
                    value={activePreset.coreOffsetMhz}
                    display={`+${activePreset.coreOffsetMhz} MHz`}
                    min={0}
                    max={500}
                    step={5}
                    disabled={busy}
                    defaultMark={0}
                    defaultTitle="Factory offset: +0 MHz"
                    onChange={(v) => onPatchPreset({ coreOffsetMhz: v })}
                  />
                  <OcSlider
                    label="MEMORY"
                    value={activePreset.memOffsetMhz}
                    display={`+${activePreset.memOffsetMhz} MHz`}
                    min={0}
                    max={3500}
                    step={50}
                    disabled={busy}
                    defaultMark={0}
                    defaultTitle="Factory offset: +0 MHz"
                    onChange={(v) => onPatchPreset({ memOffsetMhz: v })}
                  />
                </>
              ) : (
                <div className="flex flex-1 items-center justify-center">
                  <p className="text-[8px] font-mono text-stealth-muted">
                    {initialLoading ? "Loading…" : "Select a GPU block below"}
                  </p>
                </div>
              )}
            </div>

            {/* Apply */}
            <button
              type="button"
              disabled={busy || devicesCount === 0}
              onClick={() => void onApply()}
              className={`${actionBtn} relative h-full ${ROW_H} app-nav-tab-active disabled:opacity-40`}
            >
              {busy ? "…" : "APPLY"}
              {elevated !== true && (
                <span className="absolute bottom-2 left-0 right-0 text-center text-[6px] font-mono text-telemetry-amber/70 tracking-wide pointer-events-none">
                  UAC
                </span>
              )}
            </button>

            {/* Resets */}
            <div className={`flex flex-col gap-1.5 h-full ${ROW_H}`}>
              <button
                type="button"
                disabled={busy || devicesCount === 0}
                onClick={() => void onResetAll()}
                className={`${actionBtn} flex-1 disabled:opacity-40`}
              >
                RESET ALL
              </button>
              <button
                type="button"
                disabled={busy || devicesCount === 0}
                onClick={() => void onResetGpu()}
                className={`${actionBtn} flex-1 disabled:opacity-40`}
              >
                RESET GPU
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function OcSlider({
  label,
  value,
  display,
  min,
  max,
  step,
  disabled,
  defaultMark,
  defaultTitle,
  onChange,
}: {
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  disabled: boolean;
  defaultMark?: number;
  defaultTitle?: string;
  onChange: (v: number) => void;
}) {
  const showDefault =
    defaultMark != null && max > min && defaultMark >= min && defaultMark <= max;
  const defaultPct = showDefault ? sliderDefaultPct(min, max, defaultMark) : 0;

  return (
    <label className="flex flex-1 items-center gap-3 min-h-0 py-1">
      <span className="w-[3.25rem] shrink-0 text-[8px] font-mono text-stealth-muted tracking-wider leading-none">
        {label}
      </span>
      <div className="relative flex-1 min-w-0 flex items-center">
        {showDefault && (
          <span
            className="oc-slider-default-mark"
            style={{ left: `${defaultPct}%` }}
            title={defaultTitle}
          />
        )}
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          className="oc-slider w-full min-w-0"
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <span
        className={`${VALUE_W} shrink-0 text-right text-sm font-mono text-white/85 tabular-nums leading-none`}
      >
        {display}
      </span>
    </label>
  );
}