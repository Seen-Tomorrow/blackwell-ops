import SegmentSwitch from "./SegmentSwitch";

interface FitLaunchToggleProps {
  fullAuto: boolean;
  available: boolean;
  onChange: (fullAuto: boolean) => void;
}

/** Segmented switch — ASSISTED vs FULL AUTO memory launch (under VRAM forecast). */
export default function FitLaunchToggle({ fullAuto, available, onChange }: FitLaunchToggleProps) {
  if (!available) return null;

  return (
    <SegmentSwitch
      ariaLabel="Launch memory mode"
      className="segment-switch--fit-launch"
      options={[
        { id: "assisted", label: "ASSISTED" },
        { id: "full-auto", label: "FULL AUTO" },
      ]}
      selectedId={fullAuto ? "full-auto" : "assisted"}
      onSelect={(id) => onChange(id === "full-auto")}
      size="compact"
      tone="accent"
    />
  );
}
