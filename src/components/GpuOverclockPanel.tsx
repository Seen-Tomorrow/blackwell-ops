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
  ocActive?: boolean;
  layout?: "page" | "rail";
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

const railModeBtn = "app-nav-tab gpu-oc-rail-btn gpu-oc-rail-btn--mode w-full font-mono rounded-sm";

const railActionBtn =
  "app-nav-tab gpu-oc-rail-btn gpu-oc-rail-btn--action w-full font-mono rounded-sm";

const VALUE_W = "w-[6.5rem]";

const ROW_H = "min-h-[8.25rem]";

/** UI slider caps for clock offsets (Inspector accepts higher; these are our guardrails). */
const OC_CORE_OFFSET_MAX_MHZ = 300;
const OC_MEM_OFFSET_MAX_MHZ = 3000;

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
  ocActive = false,
  onModeChange,
  onPatchPreset,
  onApply,
  onResetAll,
  onResetGpu,
  layout = "page",
}: GpuOverclockPanelProps) {
  const [expanded, setExpanded] = useState(false);
  const rail = layout === "rail";

  const powerMin = sliderDevice ? Math.round(sliderDevice.powerMinW) : 0;
  const powerMax = sliderDevice ? Math.round(sliderDevice.powerMaxW) : 0;
  const powerDefault = sliderDevice ? Math.round(sliderDevice.powerDefaultW) : 0;

  const targetLabel =
    ocMode === "sync" && syncGroupCount > 0
      ? `${syncGroupCount}× ${syncGroupName}`
      : `GPU ${selectedGpuIndex}`;

  const feedback = error ?? (status && !error ? status : null);
  const feedbackTone = error
    ? "gpu-oc-header__feedback--error"
    : feedback
      ? "gpu-oc-header__feedback--ok"
      : "";

  return (
    <div
      className={`theme-surface rounded-sm overflow-hidden${rail ? " gpu-oc-rail" : ""}`}
      data-gpu-overclock
    >
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className={`theme-surface-header gpu-oc-header w-full px-3 py-2 border-b border-stealth-border flex items-center gap-3 text-left transition-colors ${
          ocActive ? "gpu-oc-header--active" : "hover:bg-white/[0.02]"
        }`}
      >
        <span className="gpu-oc-header__title text-[10px] font-mono text-white tracking-wider shrink-0">
          OVERCLOCKING [at your own risk]
        </span>
        <span
          className={`gpu-oc-header__feedback flex-1 min-w-0 text-[8px] font-mono truncate text-right leading-none min-h-[0.65rem] ${feedback ? feedbackTone : "text-transparent select-none"}`}
          aria-live="polite"
        >
          {feedback ?? "·"}
        </span>
        <span className="gpu-oc-header__toggle text-[9px] font-mono text-stealth-muted shrink-0 w-3 text-center">
          {expanded ? "−" : "+"}
        </span>
      </button>

      {expanded && (
        <div className={rail ? "gpu-oc-rail-body" : "px-3 py-3 space-y-3"}>
          

          {rail ? (
            <div className="gpu-oc-rail-stack">
              <div className="gpu-oc-rail-btn-row gpu-oc-rail-btn-row--mode grid grid-cols-2">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onModeChange("sync")}
                  className={`${railModeBtn} ${ocMode === "sync" ? "app-nav-tab-active" : ""}`}
                >
                  SYNC
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onModeChange("individual")}
                  className={`${railModeBtn} ${ocMode === "individual" ? "app-nav-tab-active" : ""}`}
                >
                  PER GPU
                </button>
              </div>
              <p className="gpu-oc-rail-target font-mono text-stealth-muted truncate" title={targetLabel}>
                {targetLabel}
              </p>

              {sliderDevice ? (
                <div className="gpu-oc-rail-sliders">
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
                    compact
                    onChange={(v) => onPatchPreset({ powerLimitW: v })}
                  />
                  <OcSlider
                    label="CORE"
                    value={activePreset.coreOffsetMhz}
                    display={`+${Math.min(activePreset.coreOffsetMhz, OC_CORE_OFFSET_MAX_MHZ)} MHz`}
                    min={0}
                    max={OC_CORE_OFFSET_MAX_MHZ}
                    step={5}
                    disabled={busy}
                    defaultMark={0}
                    defaultTitle="Factory offset: +0 MHz"
                    compact
                    onChange={(v) => onPatchPreset({ coreOffsetMhz: v })}
                  />
                  <OcSlider
                    label="MEMORY"
                    value={activePreset.memOffsetMhz}
                    display={`+${Math.min(activePreset.memOffsetMhz, OC_MEM_OFFSET_MAX_MHZ)} MHz`}
                    min={0}
                    max={OC_MEM_OFFSET_MAX_MHZ}
                    step={50}
                    disabled={busy}
                    defaultMark={0}
                    defaultTitle="Factory offset: +0 MHz"
                    compact
                    onChange={(v) => onPatchPreset({ memOffsetMhz: v })}
                  />
                </div>
              ) : (
                <p className="gpu-oc-rail-empty font-mono text-stealth-muted text-center">
                  {initialLoading ? "Loading…" : "Select a GPU block above"}
                </p>
              )}

              <div className="gpu-oc-rail-btn-row grid grid-cols-3">
                <button
                  type="button"
                  disabled={busy || devicesCount === 0}
                  onClick={() => void onApply()}
                  className={`${railActionBtn} relative app-nav-tab-active disabled:opacity-40`}
                >
                  {busy ? "…" : "APPLY"}
                  {elevated !== true && (
                    <span className="gpu-oc-rail-btn__uac absolute bottom-0 left-0 right-0 text-center font-mono text-telemetry-amber/70 tracking-wide pointer-events-none">
                      UAC
                    </span>
                  )}
                </button>
                <button
                  type="button"
                  disabled={busy || devicesCount === 0}
                  onClick={() => void onResetAll()}
                  className={`${railActionBtn} disabled:opacity-40`}
                >
                  RESET ALL
                </button>
                <button
                  type="button"
                  disabled={busy || devicesCount === 0}
                  onClick={() => void onResetGpu()}
                  className={`${railActionBtn} disabled:opacity-40`}
                >
                  RESET
                </button>
              </div>
            </div>
          ) : (
            <div
              className={`grid w-full gap-3 items-stretch ${ROW_H}`}
              style={{
                gridTemplateColumns:
                  "minmax(5.5rem, 0.55fr) minmax(12rem, 1fr) minmax(5rem, 0.42fr) minmax(5rem, 0.42fr)",
              }}
            >
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
                      display={`+${Math.min(activePreset.coreOffsetMhz, OC_CORE_OFFSET_MAX_MHZ)} MHz`}
                      min={0}
                      max={OC_CORE_OFFSET_MAX_MHZ}
                      step={5}
                      disabled={busy}
                      defaultMark={0}
                      defaultTitle="Factory offset: +0 MHz"
                      onChange={(v) => onPatchPreset({ coreOffsetMhz: v })}
                    />
                    <OcSlider
                      label="MEMORY"
                      value={activePreset.memOffsetMhz}
                      display={`+${Math.min(activePreset.memOffsetMhz, OC_MEM_OFFSET_MAX_MHZ)} MHz`}
                      min={0}
                      max={OC_MEM_OFFSET_MAX_MHZ}
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
          )}
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
  compact = false,
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
  compact?: boolean;
  onChange: (v: number) => void;
}) {
  const clampedValue = Math.min(max, Math.max(min, value));
  const showDefault =
    defaultMark != null && max > min && defaultMark >= min && defaultMark <= max;
  const defaultPct = showDefault ? sliderDefaultPct(min, max, defaultMark) : 0;

  return (
    <label className={`flex flex-1 items-center min-h-0 py-1 ${compact ? "gap-2" : "gap-3"}`}>
      <span
        className={`shrink-0 font-mono text-stealth-muted tracking-wider leading-none ${
          compact ? "w-[2.75rem] text-[7px]" : "w-[3.25rem] text-[8px]"
        }`}
      >
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
          value={clampedValue}
          disabled={disabled}
          className="oc-slider w-full min-w-0"
          onChange={(e) => onChange(Number(e.target.value))}
        />
      </div>
      <span
        className={`shrink-0 text-right font-mono text-white/85 tabular-nums leading-none ${
          compact ? "w-[4.5rem] text-[10px]" : `${VALUE_W} text-sm`
        }`}
      >
        {display}
      </span>
    </label>
  );
}