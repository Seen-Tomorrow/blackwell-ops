interface FusionBenchTrayLatchProps {
  open: boolean;
  onToggle: () => void;
}

/** Phosphor drawer lip — toggles the benchmark tray without chevrons. */
export default function FusionBenchTrayLatch({ open, onToggle }: FusionBenchTrayLatchProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className={`fusion-bench-latch w-full flex-shrink-0 ${open ? "fusion-bench-latch--open" : "fusion-bench-latch--stowed"}`}
      title={open ? "Stow benchmark tray" : "Open benchmark tray"}
      aria-expanded={open}
      aria-label={open ? "Stow benchmark tray" : "Open benchmark tray"}
    >
      <span className="fusion-bench-latch__rule" aria-hidden />
      <span className="fusion-bench-latch__core">
        <span className="fusion-bench-latch__segments" aria-hidden>
          <span className={open ? "is-lit" : undefined} />
          <span className={open ? "is-lit" : undefined} />
          <span className={open ? "is-lit" : undefined} />
        </span>
        <span className="fusion-bench-latch__label">BENCHMARK</span>
        <span className="fusion-bench-latch__action">{open ? "STOW" : "OPEN"}</span>
      </span>
      <span className="fusion-bench-latch__rule" aria-hidden />
    </button>
  );
}