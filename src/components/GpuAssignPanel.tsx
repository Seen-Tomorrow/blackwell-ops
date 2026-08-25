import type { GpuInfo, VramManifest } from "../lib/types";
import SegmentSwitch from "./SegmentSwitch";

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

/**
 * Multi-option segment switch — same chrome language as ASSISTED / FULL AUTO.
 * Thin wrapper over SegmentSwitch (compact + accent) with the legacy
 * `segment-switch--gpu-bezel` class so bezel CSS keeps matching.
 */
export function GpuSegmentSwitch({
  options,
  selectedId,
  disabled,
  ariaLabel,
  onSelect,
  title,
}: {
  options: { id: string; label: string; title?: string }[];
  selectedId: string;
  disabled?: boolean;
  ariaLabel: string;
  onSelect: (id: string) => void;
  title?: string;
}) {
  return (
    <SegmentSwitch
      options={options}
      selectedId={selectedId}
      disabled={disabled}
      ariaLabel={ariaLabel}
      onSelect={onSelect}
      title={title}
      size="compact"
      tone="accent"
      className={`segment-switch--gpu-bezel${disabled ? " segment-switch--gpu-bezel-disabled" : ""}`}
    />
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
  /** @deprecated Split driver badge removed from chrome. Kept for call-site compat. */
  manifest?: VramManifest | null;
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

  const splitActive = isSplitModeActive(splitValue) || hideSplitNone;
  const deviceOptions = gpus.map((g) => `GPU-${g.index}`);
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
    const deviceSelectedId = splitActive
      ? "__all__"
      : deviceOptions.includes(String(deviceValue ?? ""))
        ? String(deviceValue)
        : (deviceSegOpts[0]?.id ?? "");
    const splitSegOpts = visibleSplitValues.map((val) => ({
      id: String(val),
      label: String(val).toUpperCase(),
    }));
    const splitSelectedId = (() => {
      const hit = splitSegOpts.find(
        (o) => o.id.toLowerCase() === String(splitValue).toLowerCase(),
      );
      return hit?.id ?? splitSegOpts[0]?.id ?? "";
    })();

    return (
      <div
        className={`gpu-assign-panel flex-shrink-0 min-w-0${panelClass}`}
        data-gpu-assign-panel
        data-bezel="1"
      >
        {/* Split first (content-hug), Device last (claims space to the right) */}
        <div className={`gpu-assign-panel__grid${!showSplitRow ? " gpu-assign-panel__grid--solo" : ""}`}>
          {showSplitRow && (
            <>
              <div className="gpu-assign-panel__half gpu-assign-panel__half--split">
                <div className="gpu-assign-panel__split-head">
                  <span className="gpu-assign-panel__label gpu-assign-panel__label--bezel">Split</span>
                </div>
                <GpuSegmentSwitch
                  ariaLabel="Split"
                  disabled={chipDisabled(splitLocked)}
                  selectedId={splitSelectedId}
                  options={splitSegOpts}
                  onSelect={(id) => onSplitChange(id)}
                />
              </div>
              <div className="gpu-assign-panel__divider" aria-hidden />
            </>
          )}
          <div className="gpu-assign-panel__half gpu-assign-panel__half--device">
            <span className="gpu-assign-panel__label gpu-assign-panel__label--bezel">Device</span>
            <GpuSegmentSwitch
              ariaLabel="Device"
              disabled={chipDisabled(deviceLocked) || splitActive}
              selectedId={deviceSelectedId}
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
        {showSplitRow && (
          <>
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
            <div className="gpu-assign-panel__divider" aria-hidden />
          </>
        )}
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
      </div>
    </div>
  );
}
