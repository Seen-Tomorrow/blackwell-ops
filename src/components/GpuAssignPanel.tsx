import type { GpuInfo } from "../lib/types";

const PARAM_LABEL_CLASS =
  "gpu-assign-panel__label font-mono w-24 flex-shrink-0 uppercase tracking-wider truncate text-[9px] text-stealth-muted";

function paramChipClass(active: boolean): string {
  return `px-2 py-0.5 text-[9px] font-mono rounded-sm focus:outline-none ${
    active ? "value-chip-active" : "value-chip"
  }`;
}

function isSplitModeActive(split: unknown): boolean {
  const mode = String(split ?? "none").trim();
  return mode.length > 0 && mode.toUpperCase() !== "NONE";
}

interface GpuAssignPanelProps {
  gpus: GpuInfo[];
  deviceValue: unknown;
  splitValue: unknown;
  splitValues: (string | number)[];
  onDeviceChange: (value: string) => void;
  onSplitChange: (value: string | number) => void;
}

export default function GpuAssignPanel({
  gpus,
  deviceValue,
  splitValue,
  splitValues,
  onDeviceChange,
  onSplitChange,
}: GpuAssignPanelProps) {
  if (gpus.length === 0) return null;

  const splitActive = isSplitModeActive(splitValue);
  const deviceOptions = gpus.map((_, i) => `GPU-${i}`);

  return (
    <div className="gpu-assign-panel flex-shrink-0" data-gpu-assign-panel>
      <div className="gpu-assign-panel__grid">
        <div className="gpu-assign-panel__half gpu-assign-panel__half--device">
          <span className={PARAM_LABEL_CLASS}>Device</span>
          <div className="gpu-assign-panel__chips config-chip-row flex items-center gap-1.5 min-w-0">
            {splitActive ? (
              <span
                className={`${paramChipClass(true)} opacity-90 cursor-default`}
                title="Split mode uses all detected GPUs. Set SPLIT to none to pick a single GPU."
              >
                ALL ({gpus.length})
              </span>
            ) : (
              deviceOptions.map((val) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => onDeviceChange(val)}
                  className={paramChipClass(String(deviceValue) === val)}
                >
                  {val}
                </button>
              ))
            )}
          </div>
        </div>
        <div className="gpu-assign-panel__divider" aria-hidden />
        <div className="gpu-assign-panel__half gpu-assign-panel__half--split">
          <span className={PARAM_LABEL_CLASS}>Split</span>
          <div className="gpu-assign-panel__chips config-chip-row flex items-center gap-1.5 min-w-0">
            {splitValues.map((val) => (
              <button
                key={String(val)}
                type="button"
                onClick={() => onSplitChange(val)}
                className={paramChipClass(
                  String(splitValue).toLowerCase() === String(val).toLowerCase(),
                )}
              >
                {String(val)}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}