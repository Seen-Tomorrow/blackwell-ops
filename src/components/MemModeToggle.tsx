interface MemModeToggleProps {
  enabled: boolean;
  available: boolean;
  onChange: (enabled: boolean) => void;
}

/** Compact USER/AUTO memory mode — lives in VramBadge near FORECAST. */
export default function MemModeToggle({ enabled, available, onChange }: MemModeToggleProps) {
  if (!available) return null;

  return (
    <div className="vram-mem-mode flex items-center gap-2 flex-shrink-0" data-vram-mem-mode>
      <span className="vram-mem-mode__label text-[8px] font-mono tracking-widest uppercase text-stealth-muted">
        MEM
      </span>
      <label className="toggle-switch toggle-switch--compact vram-mem-mode__toggle">
        <input
          type="checkbox"
          className="toggle-input"
          checked={enabled}
          onChange={() => onChange(!enabled)}
        />
        <span className="toggle-track">
          <span className="toggle-rust" />
          <span className="toggle-glow" />
          <span className="toggle-thumb">
            <span className="thumb-inner" />
            <span className="thumb-shine" />
          </span>
        </span>
        <span className="toggle-label">
          <span className="label-off">USER</span>
          <span className="label-on">AUTO</span>
        </span>
      </label>
    </div>
  );
}