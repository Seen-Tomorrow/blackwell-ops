import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export type HeaderNavSegmentOption = {
  id: string;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  className?: string;
  dataAttrs?: Record<string, string>;
};

export interface HeaderNavSegmentProps {
  options: HeaderNavSegmentOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  /**
   * `fit` — primary rail scale.
   * `compact` — sub-rail scale.
   */
  size?: "fit" | "compact";
  className?: string;
}

/**
 * DEDICATED header-navigation segmented switch.
 *
 * Forked from the shared measured-thumb core so the main app nav can grow
 * extended features (badges, async states, sub-rail docking) without
 * interfering with — or being constrained by — the other segment instances
 * (provider/profile bar, cockpit flags, GPU bezel, config toggles).
 *
 * Do NOT reuse this for non-nav segments; use `SegmentSwitch` for those.
 */
export default function HeaderNavSegment({
  options,
  selectedId,
  onSelect,
  ariaLabel,
  title,
  disabled = false,
  size = "compact",
  className,
}: HeaderNavSegmentProps) {
  const n = Math.max(1, options.length);
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.id === selectedId),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 2, top: 2, width: 0, height: 0 });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const btn = root.querySelector<HTMLElement>(
        `[data-seg-i="${activeIndex}"]`,
      );
      if (!btn) return;
      setThumb({
        left: btn.offsetLeft,
        top: btn.offsetTop,
        width: btn.offsetWidth,
        height: btn.offsetHeight,
      });
    };
    measure();
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(measure);
      ro.observe(root);
      root.querySelectorAll("[data-seg-i]").forEach((el) => ro!.observe(el));
    }
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeIndex, n]);

  const sizeClass =
    size === "fit" ? "segment-switch--size-fit" : "segment-switch--size-compact";
  const rootClass = [
    "segment-switch",
    n > 2 ? "segment-switch--multi" : "",
    sizeClass,
    "segment-switch--tone-accent",
    disabled ? "segment-switch--disabled" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div
      ref={rootRef}
      className={rootClass}
      data-segment-switch
      data-active={n === 2 ? (activeIndex === 0 ? "left" : "right") : undefined}
      role="group"
      aria-label={ariaLabel}
      aria-disabled={disabled || undefined}
      title={title}
      style={
        {
          "--seg-thumb-left": `${thumb.left}px`,
          "--seg-thumb-top": `${thumb.top}px`,
          "--seg-thumb-width": `${thumb.width}px`,
          "--seg-thumb-height": `${thumb.height}px`,
        } as CSSProperties
      }
    >
      <span className="segment-switch__thumb" aria-hidden />
      {options.map((opt, i) => {
        const active = i === activeIndex;
        const optDisabled = disabled || opt.disabled;
        return (
          <button
            key={opt.id}
            type="button"
            data-seg-i={i}
            className={[
              "segment-switch__option",
              active ? "segment-switch__option--active" : "",
              opt.className ?? "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={active}
            disabled={optDisabled}
            title={opt.title}
            onClick={() => {
              if (optDisabled) return;
              onSelect(opt.id);
            }}
            {...(opt.dataAttrs ?? {})}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
