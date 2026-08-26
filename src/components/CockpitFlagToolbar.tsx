import SegmentSwitch from "./SegmentSwitch";

export type CockpitFlagToggle = {
  key: string;
  /** Short header label (VISION / FLASH / LOAD). */
  label: string;
  title?: string;
  values: string[];
  current: string;
  onChange: (value: string) => void;
};

/**
 * Compact multi-option segment — same chrome language as VRAM bezel Split/Device.
 * Thin wrapper over the shared SegmentSwitch (compact + accent) with the
 * cockpit-flag bezel classes. The shared component measures all four thumb
 * vars (left/width/top/height), so the thumb never collapses to a line.
 */
function FlagSegment({
  options,
  activeIndex,
  ariaLabel,
  title,
  onSelect,
}: {
  options: { id: string; label: string }[];
  activeIndex: number;
  ariaLabel: string;
  title?: string;
  onSelect: (id: string) => void;
}) {
  const n = Math.max(1, options.length);
  const safeIdx = activeIndex >= 0 && activeIndex < n ? activeIndex : 0;
  const selectedId = options[safeIdx]?.id ?? "";
  return (
    <SegmentSwitch
      ariaLabel={ariaLabel}
      title={title}
      options={options}
      selectedId={selectedId}
      onSelect={onSelect}
      size="compact"
      tone="accent"
      className="segment-switch--gpu-bezel segment-switch--cockpit-flag"
    />
  );
}

function shortValueLabel(key: string, raw: string): string {
  const s = String(raw).trim();
  if (key === "vision") {
    if (s.toLowerCase() === "auto") return "ON";
    if (s.toLowerCase() === "off") return "OFF";
  }
  if (key === "flash_attn") {
    if (s.toLowerCase() === "on") return "ON";
    if (s.toLowerCase() === "off") return "OFF";
    if (s.toLowerCase() === "auto") return "AUTO";
  }
  if (key === "load_mode") {
    // Keep mmap/mlock/dio readable; mmap+mlock → M+L if ever present
    if (s.toLowerCase() === "mmap+mlock") return "M+L";
    return s.toUpperCase();
  }
  return s.toUpperCase();
}

/**
 * Cockpit header flag strip — far right, bezel-style segments.
 * Direct param writes (not Full Auto plan) so VISION consent is sticky.
 */
export default function CockpitFlagToolbar({
  flags,
}: {
  flags: CockpitFlagToggle[];
}) {
  if (!flags.length) return null;

  return (
    <div className="full-auto-cockpit__flag-toolbar" role="toolbar" aria-label="Cockpit flags">
      {flags.map((f) => {
        const vals = f.values.map(String);
        const cur = String(f.current ?? vals[0] ?? "");
        const idx = Math.max(
          0,
          vals.findIndex((v) => v.toLowerCase() === cur.toLowerCase()),
        );
        const options = vals.map((v) => ({
          id: v,
          label: shortValueLabel(f.key, v),
        }));
        return (
          <div key={f.key} className="full-auto-cockpit__flag-unit">
            <span className="full-auto-cockpit__flag-label font-mono">{f.label}</span>
            <FlagSegment
              options={options}
              activeIndex={idx}
              ariaLabel={f.label}
              title={f.title}
              onSelect={f.onChange}
            />
          </div>
        );
      })}
    </div>
  );
}
