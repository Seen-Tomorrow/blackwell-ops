interface FitLaunchToggleProps {
  fullAuto: boolean;
  available: boolean;
  onChange: (fullAuto: boolean) => void;
}

/** Segmented switch — ASSISTED vs FULL AUTO memory launch (under VRAM forecast). */
export default function FitLaunchToggle({ fullAuto, available, onChange }: FitLaunchToggleProps) {
  if (!available) return null;

  return (
    <div
      className="segment-switch segment-switch--fit-launch"
      data-segment-switch
      data-active={fullAuto ? "right" : "left"}
      role="group"
      aria-label="Launch memory mode"
    >
      <span className="segment-switch__thumb" aria-hidden />
      <button
        type="button"
        className={`segment-switch__option${!fullAuto ? " segment-switch__option--active" : ""}`}
        aria-pressed={!fullAuto}
        onClick={() => onChange(false)}
      >
        ASSISTED
      </button>
      <button
        type="button"
        className={`segment-switch__option${fullAuto ? " segment-switch__option--active" : ""}`}
        aria-pressed={fullAuto}
        onClick={() => onChange(true)}
      >
        FULL AUTO
      </button>
    </div>
  );
}