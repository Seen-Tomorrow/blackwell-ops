import {
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";

export type SegmentSwitchOption = {
  id: string;
  label: ReactNode;
  title?: string;
  disabled?: boolean;
  /** Extra classes on the option button (e.g. animate-pulse while building). */
  className?: string;
  /** Optional data-* attributes (onboarding hooks, etc.). */
  dataAttrs?: Record<string, string>;
};

export type SegmentSwitchSize = "fit" | "compact";
export type SegmentSwitchTone = "accent" | "amber";

export interface SegmentSwitchProps {
  options: SegmentSwitchOption[];
  selectedId: string;
  onSelect: (id: string) => void;
  ariaLabel: string;
  title?: string;
  /** Disables the whole control. */
  disabled?: boolean;
  /**
   * `fit` — ASSISTED / FULL AUTO bezel scale.
   * `compact` — Device / Split / GPU density scale.
   */
  size?: SegmentSwitchSize;
  /**
   * `accent` — theme accent thumb (profile, launch modes).
   * `amber` — provider-pill secondary tokens.
   */
  tone?: SegmentSwitchTone;
  className?: string;
}

/**
 * Multi-option segmented switch with measured sliding thumb.
 * Same chrome language as ASSISTED/FULL AUTO + Device/Split; size + tone are
 * explicit so callers can mix fit/compact and amber/accent without forks.
 */
export default function SegmentSwitch({
  options,
  selectedId,
  onSelect,
  ariaLabel,
  title,
  disabled = false,
  size = "compact",
  tone = "accent",
  className,
}: SegmentSwitchProps) {
  const n = Math.max(1, options.length);
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.id === selectedId),
  );
  const safeIdx = activeIndex >= 0 && activeIndex < n ? activeIndex : 0;
  const rootRef = useRef<HTMLDivElement>(null);
  const [thumb, setThumb] = useState({ left: 2, width: 0, top: 2, height: 0 });
  // Label text is ReactNode — key off ids/disabled only; ResizeObserver covers size.
  const optionKey = options.map((o) => `${o.id}:${o.disabled ? 1 : 0}`).join("|");

  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const measure = () => {
      const btn = root.querySelector<HTMLElement>(
        `.segment-switch__option[data-seg-i="${safeIdx}"]`,
      );
      if (!btn) return;
      // Full option box — thumb hugs label pad equally on all sides (track pad = gap).
      setThumb({
        left: btn.offsetLeft,
        width: btn.offsetWidth,
        top: btn.offsetTop,
        height: btn.offsetHeight,
      });
    };

    measure();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(measure) : null;
    ro?.observe(root);
    for (const el of root.querySelectorAll(".segment-switch__option")) {
      ro?.observe(el);
    }
    window.addEventListener("resize", measure);
    return () => {
      ro?.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [safeIdx, options.length, optionKey]);

  // 2-option switches use the CSS-only data-active thumb (base .segment-switch
  // grid + translateX(100%)). 3+ options use the JS-measured --multi thumb.
  const isTwo = n === 2;
  const sizeClass =
    size === "fit" ? "segment-switch--size-fit" : "segment-switch--size-compact";
  const toneClass =
    tone === "amber" ? "segment-switch--tone-amber" : "segment-switch--tone-accent";

  return (
    <div
      ref={rootRef}
      className={[
        "segment-switch",
        !isTwo ? "segment-switch--multi" : "",
        sizeClass,
        toneClass,
        disabled ? "segment-switch--disabled" : "",
        className ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      data-segment-switch
      data-active={isTwo ? (safeIdx === 0 ? "left" : "right") : undefined}
      data-active-index={safeIdx}
      data-size={size}
      role="group"
      aria-label={ariaLabel}
      title={title}
      style={
        {
          "--seg-thumb-left": `${thumb.left}px`,
          "--seg-thumb-width": `${thumb.width}px`,
          "--seg-thumb-top": `${thumb.top}px`,
          "--seg-thumb-height": `${thumb.height}px`,
        } as CSSProperties
      }
    >
      <span className="segment-switch__thumb" aria-hidden />
      {options.map((opt, i) => {
        const optDisabled = disabled || Boolean(opt.disabled);
        const active = i === safeIdx;
        return (
          <button
            key={opt.id}
            type="button"
            data-seg-i={i}
            disabled={optDisabled}
            aria-pressed={active}
            title={opt.title}
            onClick={() => {
              if (optDisabled) return;
              onSelect(opt.id);
            }}
            className={[
              "segment-switch__option",
              active ? "segment-switch__option--active" : "",
              optDisabled ? "segment-switch__option--disabled" : "",
              opt.className ?? "",
            ]
              .filter(Boolean)
              .join(" ")}
            {...opt.dataAttrs}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
