import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

type CockpitNavSegmentOption = {
  id: string;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  className?: string;
};

interface CockpitNavSegmentProps {
  options: CockpitNavSegmentOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
  title?: string;
  disabled?: boolean;
  /**
   * `primary` — header-primary scale for GOAL/TASK.
   * `sub` — header-sub scale for the contextual SPEC rail.
   */
  size?: "primary" | "sub";
  className?: string;
}

/**
 * Cockpit-owned fork of the navigation segmented switch. Same measure/thumb
 * core, but no `.app-header` dependency and cockpit-scale inline geometry so
 * the header chrome can evolve independently.
 */
export default function CockpitNavSegment({
  options,
  selectedId,
  onSelect,
  ariaLabel,
  title,
  disabled = false,
  size = "primary",
  className,
}: CockpitNavSegmentProps) {
  const n = Math.max(1, options.length);
  const activeIndex = Math.max(
    0,
    options.findIndex((option) => option.id === selectedId),
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 2, top: 2, width: 0, height: 0 });

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const measure = () => {
      const button = root.querySelector<HTMLElement>(`[data-seg-i="${activeIndex}"]`);
      if (!button) return;
      setThumb({
        left: button.offsetLeft,
        top: button.offsetTop,
        width: button.offsetWidth,
        height: button.offsetHeight,
      });
    };
    measure();
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(measure);
      observer.observe(root);
      root.querySelectorAll("[data-seg-i]").forEach((element) => observer!.observe(element));
    }
    window.addEventListener("resize", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [activeIndex, n]);

  const primary = size === "primary";
  const rootClass = [
    "segment-switch",
    n > 2 ? "segment-switch--multi" : "",
    "segment-switch--tone-accent",
    disabled ? "segment-switch--disabled" : "",
    className ?? "",
  ]
    .filter(Boolean)
    .join(" ");

  const rootStyle = {
    "--seg-thumb-left": `${thumb.left}px`,
    "--seg-thumb-top": `${thumb.top}px`,
    "--seg-thumb-width": `${thumb.width}px`,
    "--seg-thumb-height": `${thumb.height}px`,
    boxSizing: "border-box",
    flex: "0 0 auto",
    width: primary ? "100%" : "max-content",
    height: primary
      ? "calc(48px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1))"
      : "calc(30px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1))",
    minHeight: primary
      ? "calc(48px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1))"
      : "calc(30px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1))",
    padding: primary
      ? "max(1px, calc(2px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1)))"
      : "max(1px, calc(1.5px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1)))",
  } as CSSProperties;

  const optionStyle: CSSProperties = {
    flex: primary ? "1 1 0" : "0 0 auto",
    height: "100%",
    fontSize: primary
      ? "calc(13px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1))"
      : "calc(11px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1))",
    fontWeight: 600,
    letterSpacing: primary ? "0.12em" : "0.1em",
    padding: primary
      ? "0 calc(12px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1))"
      : "0 calc(10px * var(--header-nav-scale, 1.12) / var(--ui-text-scale, 1))",
    boxSizing: "border-box",
  };

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
      style={rootStyle}
    >
      <span className="segment-switch__thumb" aria-hidden />
      {options.map((option, index) => {
        const active = index === activeIndex;
        const optionDisabled = disabled || option.disabled;
        return (
          <button
            key={option.id}
            type="button"
            data-seg-i={index}
            className={[
              "segment-switch__option",
              active ? "segment-switch__option--active" : "",
              option.className ?? "",
            ]
              .filter(Boolean)
              .join(" ")}
            aria-pressed={active}
            disabled={optionDisabled}
            title={option.title}
            onClick={() => {
              if (optionDisabled) return;
              onSelect(option.id);
            }}
            style={optionStyle}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
