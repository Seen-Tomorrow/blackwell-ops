interface FitLaunchToggleProps {
  autoFit: boolean;
  available: boolean;
  onChange: (autoFit: boolean) => void;
}

/** Segmented switch — MANUAL vs AUTO FIT launch (under VRAM forecast). */
export default function FitLaunchToggle({ autoFit, available, onChange }: FitLaunchToggleProps) {
  if (!available) return null;

  return (
    <div
      className="segment-switch segment-switch--fit-launch"
      data-segment-switch
      data-active={autoFit ? "right" : "left"}
      role="group"
      aria-label="Launch memory mode"
    >
      <span className="segment-switch__thumb" aria-hidden />
      <button
        type="button"
        className={`segment-switch__option${!autoFit ? " segment-switch__option--active" : ""}`}
        aria-pressed={!autoFit}
        onClick={() => onChange(false)}
      >
        MANUAL
      </button>
      <button
        type="button"
        className={`segment-switch__option${autoFit ? " segment-switch__option--active" : ""}`}
        aria-pressed={autoFit}
        onClick={() => onChange(true)}
      >
        AUTO FIT
      </button>
    </div>
  );
}