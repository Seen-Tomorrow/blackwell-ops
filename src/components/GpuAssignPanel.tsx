import type { GpuInfo } from "../lib/types";

const DEVICE_LABEL_CLASS =
  "gpu-assign-panel__label font-mono w-14 flex-shrink-0 uppercase tracking-wider truncate text-[9px] text-stealth-muted";

const SPLIT_LABEL_CLASS =
  "gpu-assign-panel__label font-mono w-10 flex-shrink-0 uppercase tracking-wider truncate text-[9px] text-stealth-muted text-right";

function paramChipClass(active: boolean, disabled?: boolean): string {
  const base = `px-2 py-0.5 text-[9px] font-mono rounded-sm focus:outline-none ${
    active ? "value-chip-active" : "value-chip"
  }`;
  return disabled ? `${base} gpu-assign-chip--locked` : base;
}

function isSplitModeActive(split: unknown): boolean {
  const mode = String(split ?? "none").trim();
  return mode.length > 0 && mode.toUpperCase() !== "NONE";
}

/** Multi-option segment switch (same visual language as ASSISTED/FULL AUTO). */
function SegmentOptionGroup({
  options,
  activeIndex,
  disabled,
  ariaLabel,
  onSelect,
  title,
}: {
  options: { id: string; label: string; title?: string }[];
  activeIndex: number;
  disabled?: boolean;
  ariaLabel: string;
  onSelect: (id: string) => void;
  title?: string;
}) {
  const n = Math.max(1, options.length);
  const safeIdx = activeIndex >= 0 && activeIndex < n ? activeIndex : 0;
  return (
    <div
      className={`segment-switch segment-switch--gpu-bezel${disabled ? " segment-switch--gpu-bezel-disabled" : ""}`}
      data-segment-switch
      data-active-index={safeIdx}
      role="group"
      aria-label={ariaLabel}
      title={title}
      style={
        {
          "--seg-n": n,
          "--seg-i": safeIdx,
        } as React.CSSProperties
      }
    >
      <span className="segment-switch__thumb" aria-hidden />
      {options.map((opt, i) => (
        <button
          key={opt.id}
          type="button"
          disabled={disabled}
          aria-pressed={i === safeIdx}
          title={opt.title}
          onClick={() => onSelect(opt.id)}
          className={`segment-switch__option${i === safeIdx ? " segment-switch__option--active" : ""}`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  );
}

interface GpuAssignPanelProps {
  gpus: GpuInfo[];
  deviceValue: unknown;
  splitValue: unknown;
  splitValues: (string | number)[];
  onDeviceChange: (value: string) => void;
  onSplitChange: (value: string | number) => void;
  /** FULL AUTO — hatched, non-interactive chrome. */
  chromeDisabled?: boolean;
  deviceLocked?: boolean;
  splitLocked?: boolean;
  hideSplitNone?: boolean;
  /** Hide tensor/row when provider spawn_profile.tensor_split is false. */
  hideTensorSplit?: boolean;
  /** Compact row for industrial-display-frame top chrome. */
  bezel?: boolean;
}

export default function GpuAssignPanel({
  gpus,
  deviceValue,
  splitValue,
  splitValues,
  onDeviceChange,
  onSplitChange,
  chromeDisabled = false,
  deviceLocked = false,
  splitLocked = false,
  hideSplitNone = false,
  hideTensorSplit = false,
  bezel = false,
}: GpuAssignPanelProps) {
  if (gpus.length === 0) return null;

  const splitActive = isSplitModeActive(splitValue);
  const deviceOptions = gpus.map((_, i) => `GPU-${i}`);
  const visibleSplitValues = splitValues.filter((val) => {
    const mode = String(val).toLowerCase();
    if (hideSplitNone && mode === "none") return false;
    if (hideTensorSplit && (mode === "tensor" || mode === "row")) return false;
    return true;
  });
  const showSplitRow = gpus.length > 1;
  const panelClass =
    (chromeDisabled ? " gpu-assign-panel--chrome-disabled" : "")
    + (bezel ? " gpu-assign-panel--bezel" : "");

  const chipDisabled = (locked: boolean) => chromeDisabled || locked;

  if (bezel) {
    const deviceSegOpts = splitActive
      ? [{ id: "__all__", label: `ALL (${gpus.length})`, title: "Split mode uses all GPUs" }]
      : deviceOptions.map((val) => ({ id: val, label: val }));
    const deviceActive = splitActive
      ? 0
      : Math.max(0, deviceOptions.findIndex((v) => String(deviceValue) === v));
    const splitSegOpts = visibleSplitValues.map((val) => ({
      id: String(val),
      label: String(val),
    }));
    const splitActiveIdx = Math.max(
      0,
      splitSegOpts.findIndex(
        (o) => o.id.toLowerCase() === String(splitValue).toLowerCase(),
      ),
    );

    return (
      <div
        className={`gpu-assign-panel flex-shrink-0 min-w-0${panelClass}`}
        data-gpu-assign-panel
        data-bezel="1"
      >
        <div className={`gpu-assign-panel__grid${!showSplitRow ? " gpu-assign-panel__grid--solo" : ""}`}>
          <div className="gpu-assign-panel__half gpu-assign-panel__half--device">
            <SegmentOptionGroup
              ariaLabel="Device"
              disabled={chipDisabled(deviceLocked) || splitActive}
              activeIndex={deviceActive}
              options={deviceSegOpts}
              onSelect={(id) => {
                if (id === "__all__" || splitActive) return;
                onDeviceChange(id);
              }}
              title={
                splitActive
                  ? "Split mode uses all detected GPUs. Set SPLIT to none to pick a single GPU."
                  : undefined
              }
            />
          </div>
          {showSplitRow && (
            <>
              <div className="gpu-assign-panel__divider" aria-hidden />
              <div className="gpu-assign-panel__half gpu-assign-panel__half--split">
                <SegmentOptionGroup
                  ariaLabel="Split"
                  disabled={chipDisabled(splitLocked)}
                  activeIndex={splitActiveIdx}
                  options={splitSegOpts}
                  onSelect={(id) => onSplitChange(id)}
                />
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div
      className={`gpu-assign-panel flex-shrink-0 min-w-0${panelClass}`}
      data-gpu-assign-panel
    >
      <div className={`gpu-assign-panel__grid${!showSplitRow ? " gpu-assign-panel__grid--solo" : ""}`}>
        <div className="gpu-assign-panel__half gpu-assign-panel__half--device">
          <span className={DEVICE_LABEL_CLASS}>Device</span>
          <div className="gpu-assign-panel__chips config-chip-row flex items-center gap-1.5 min-w-0">
            {splitActive ? (
              <span
                className={`${paramChipClass(true, chromeDisabled)} opacity-90 cursor-default`}
                title={
                  chromeDisabled
                    ? "FULL AUTO — engine picks GPU placement"
                    : "Split mode uses all detected GPUs. Set SPLIT to none to pick a single GPU."
                }
              >
                ALL ({gpus.length})
              </span>
            ) : (
              deviceOptions.map((val) => (
                <button
                  key={val}
                  type="button"
                  disabled={chipDisabled(deviceLocked)}
                  onClick={() => onDeviceChange(val)}
                  className={paramChipClass(String(deviceValue) === val, chromeDisabled || deviceLocked)}
                >
                  {val}
                </button>
              ))
            )}
          </div>
        </div>
        {showSplitRow && (
          <>
            <div className="gpu-assign-panel__divider" aria-hidden />
            <div className="gpu-assign-panel__half gpu-assign-panel__half--split">
              <span className={SPLIT_LABEL_CLASS}>Split</span>
              <div className="gpu-assign-panel__chips config-chip-row flex items-center gap-1.5 min-w-0">
                {visibleSplitValues.map((val) => (
                  <button
                    key={String(val)}
                    type="button"
                    disabled={chipDisabled(splitLocked)}
                    onClick={() => onSplitChange(val)}
                    className={paramChipClass(
                      String(splitValue).toLowerCase() === String(val).toLowerCase(),
                      chromeDisabled || splitLocked,
                    )}
                  >
                    {String(val)}
                  </button>
                ))}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
