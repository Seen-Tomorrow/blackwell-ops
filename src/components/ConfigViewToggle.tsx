import type { ConfigViewMode } from "../lib/types";
import SegmentSwitch from "./SegmentSwitch";

interface ConfigViewToggleProps {
  view: ConfigViewMode;
  onChange: (view: ConfigViewMode) => void;
}

/** PARAM toolbar — Essentials vs Full config surface. */
export default function ConfigViewToggle({ view, onChange }: ConfigViewToggleProps) {
  const essentials = view === "essentials";
  return (
    <SegmentSwitch
      ariaLabel="Config detail level"
      className="segment-switch--config-view"
      options={[
        { id: "essentials", label: "ESSENTIALS" },
        { id: "full", label: "FULL" },
      ]}
      selectedId={view}
      onSelect={(id) => onChange(id as ConfigViewMode)}
      size="compact"
      tone="accent"
    />
  );
}
