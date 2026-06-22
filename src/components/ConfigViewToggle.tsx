import type { ConfigViewMode } from "../lib/types";

interface ConfigViewToggleProps {
  view: ConfigViewMode;
  onChange: (view: ConfigViewMode) => void;
}

/** PARAM toolbar — Essentials vs Full config surface. */
export default function ConfigViewToggle({ view, onChange }: ConfigViewToggleProps) {
  const essentials = view === "essentials";

  return (
    <div
      className="segment-switch segment-switch--config-view"
      data-segment-switch
      data-active={essentials ? "left" : "right"}
      role="group"
      aria-label="Config detail level"
    >
      <span className="segment-switch__thumb" aria-hidden />
      <button
        type="button"
        className={`segment-switch__option${essentials ? " segment-switch__option--active" : ""}`}
        aria-pressed={essentials}
        onClick={() => onChange("essentials")}
      >
        ESSENTIALS
      </button>
      <button
        type="button"
        className={`segment-switch__option${!essentials ? " segment-switch__option--active" : ""}`}
        aria-pressed={!essentials}
        onClick={() => onChange("full")}
      >
        FULL
      </button>
    </div>
  );
}