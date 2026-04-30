/**
 * ValueBubbles — Render parameter values as clickable bubbles.
 *
 * STYLING LOGIC (single source of truth):
 * - User-added value     → yellow text/border always
 * - Factory default      → green styling only
 * - User-set default    → yellow double border + yellow text (distinct from factory)
 * - Selected non-default → green or overridden highlight
 */

import React, { useState, useCallback } from "react";

interface ValueBubblesProps {
  paramKey: string;
  isAdmin?: boolean;            // true = UNLOCKED mode — show controls
  currentValue?: string | number; // the value currently selected for this model+provider
  onOverrideChange?: (value: string | number) => void;   // user selects a different value
  addValue?: (value: string | number) => void;            // admin adds new value to param's available list
  toggleHiddenValue?: (_key: string, value: string | number) => void;
  hiddenValues?: (string | number)[];
  availableValues?: (string | number)[];
  userAddedValues?: (string | number)[];
  /** Current default for this param (what the UI shows as selected by default). */
  defaultValue?: string | number;
  /** Factory default from genesis_template.json — never changes. Used to distinguish factory vs admin-set defaults. */
  factoryDefault?: string | number;
  onChangeDefault?: (value: string | number) => void;  // admin marks this value as the new default
  ptype?: 'switch' | 'switch_onoff' | 'switch_inverted' | 'arg_select' | 'mapper' | 'path_scanner' | 'logic_only';
  /** Opens editor for this specific value's sub_params (admin only). */
  onEditValue?: (value: string | number) => void;
  /** Sub-params injected by Rust templates.rs when a specific value is selected (e.g. MOE_OPTIMAL). */
  subParams?: Record<string, string[]>;
}

export default function ValueBubbles({
  paramKey,
  isAdmin = false,
  currentValue = "",
  onOverrideChange,
  addValue,
  toggleHiddenValue,
  hiddenValues = [],
  availableValues,
  userAddedValues = [],
  defaultValue,
  factoryDefault,
  onChangeDefault,
  onEditValue,
  ptype,
  subParams,
}: ValueBubblesProps) {
  const [inputValue, setInputValue] = useState("");
  const [expandedSubs, setExpandedSubs] = useState<Record<string, boolean>>({});

  // ── Build unified display list (template values + user-added), deduped ──────────
  const seen = new Set<string>();
  type DisplayItem = { val: string | number; isUserAdded: boolean };
  const allDisplayValues: DisplayItem[] = [];

  if (availableValues) {
    for (const v of availableValues) {
      const key = String(v);
      if (!seen.has(key)) { seen.add(key); allDisplayValues.push({ val: v, isUserAdded: false }); }
    }
  }
  for (const v of userAddedValues || []) {
    const key = String(v);
    if (!seen.has(key)) { seen.add(key); allDisplayValues.push({ val: v, isUserAdded: true }); }
  }

  // ── Submit value from input field ─────────────────────────────────────────────
  const submitValue = useCallback(() => {
    const trimmed = inputValue.trim();
    if (!trimmed) return;

    let parsed: string | number;
    if (/^-?\d+$/.test(trimmed)) parsed = parseInt(trimmed, 10);
    else if (/^-?\d+\.\d+$/.test(trimmed)) parsed = parseFloat(trimmed);
    else parsed = trimmed;

    if (addValue) {
      addValue(parsed);
      setInputValue("");
      return;
    }
    if (onOverrideChange) {
      onOverrideChange(parsed);
      setInputValue("");
    }
  }, [inputValue, addValue, onOverrideChange]);

  // ── Check if a value is hidden from catalog ───────────────────────────────────
  const isHidden = useCallback((val: string | number): boolean =>
    hiddenValues.some(hv => String(hv) === String(val)),
  [hiddenValues]);

  // ── Sub-args for a given value (from subParams mapping, case-insensitive key lookup) ─
  const getSubArgs = (val: string | number): string[] => {
    if (!subParams) return [];
    const normalized = String(val).toUpperCase();
    for (const [key, args] of Object.entries(subParams)) {
      if (key.toUpperCase() === normalized) return args;
    }
    return subParams[String(val)] || []; // fallback to exact match
  };
  const hasSubArgs = (val: string | number): boolean =>
    getSubArgs(val).length > 0;

  // ── Render single bubble ───────────────────────────────────────────────────────
  const renderBubble = (item: DisplayItem, idx: number) => {
    const { val, isUserAdded } = item;
    const selected = String(val) === String(currentValue);
    const hidden = isHidden(val);

    // Hidden value — shown greyed-out with eye icon to un-hide
    if (hidden) {
      return (
        <span key={`hidden-${paramKey}-${idx}`}
          className="inline-flex items-center gap-1 px-2 py-0.5 border text-[11px] font-mono rounded-sm bg-nv-green/8 border-nv-green/30 text-nv-green line-through opacity-40">
          {String(val)}
          {isAdmin && toggleHiddenValue && (
            <button onClick={() => toggleHiddenValue(paramKey, val)}
              className="leading-none text-nv-green/50 hover:text-yellow-400 transition-colors"
              title="Show value in catalog">
              <svg width="12" height="12" viewBox="0 0 24 24"><path d="M3 12s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7z" fill="none" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
            </button>
          )}
        </span>
      );
    }

    // Determine styling based on value type and selection state
    let style = "";
    
    if (isUserAdded) {
      // User-added values: always yellow text + border
      style = "bg-yellow-400/15 border border-yellow-400/60 text-yellow-300";
    } else {
      const isDefault = defaultValue !== undefined && String(val) === String(defaultValue);
      const isFactoryDefault = factoryDefault !== undefined &&
        String(val).toUpperCase() === String(factoryDefault).toUpperCase();

      if (isDefault) {
        // This param has a defined default — distinguish factory vs user-set
        if (!isFactoryDefault) {
          // User-set default: yellow border + yellow text (distinct from green factory)
          style = "bg-yellow-400/25 border-double border-2 border-yellow-400/80 text-yellow-300";
        } else {
          // Factory default: green styling only
          style = selected
            ? "bg-nv-green/30 border-double border-2 border-nv-green/70 text-nv-green"
            : "";
        }
      } else if (selected) {
        // Selected but not the default value
        style = "";
      } else {
        // Not a default, not selected
        style = "";
      }

      // Apply base styles if no conditional style was set
      if (!style) {
        style = selected
          ? "bg-nv-green/30 border-double border-2 border-nv-green/70 text-nv-green"
          : "bg-nv-green/10 border border-nv-green/30 text-nv-green/70 hover:text-white";
      }
    }

    return (
      <span key={`${paramKey}-${idx}`}
        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-sm transition-all ${style}`}>

        {/* Set as default button — admin only (only on non-default values) */}
        {isAdmin && defaultValue !== undefined && String(val) !== String(defaultValue) && onChangeDefault && (
          <button onClick={() => onChangeDefault(val)}
            className="leading-none font-bold text-[12px] text-nv-green/60 hover:text-yellow-400 transition-colors"
            title="Set as default value">
            *
          </button>
        )}

        {String(val)}

        {/* Expand sub-args disclosure — show on any value with sub_args */}
        {hasSubArgs(String(val)) && (
          <button onClick={(e) => {
            e.stopPropagation();
            setExpandedSubs(prev => ({ ...prev, [String(val)]: !prev[String(val)] }));
          }}
            className="leading-none transition-colors"
            title="Show injected CLI args">
            {expandedSubs[String(val)]
              ? <span className="text-[11px] text-yellow-400 font-bold">&#x25B2;</span>
              : <span className="text-[9px] text-yellow-400/50 hover:text-yellow-400">&#x25BC;</span>}
          </button>
        )}

        {/* Sub-args disclosure — inline below this bubble */}
        {hasSubArgs(String(val)) && expandedSubs[String(val)] && (
          <span className="ml-1 px-1 py-0.5 bg-yellow-400 text-black text-[9px] font-mono">
            {(() => {
              const args = getSubArgs(String(val));
              return args.map((arg, i) => {
                let suffix = "";
                if (i >= args.length - 1) return <span key={i}>{arg}</span>;
                const nextFlag = args[i + 1]?.startsWith("-");
                if (nextFlag) suffix = "\u00A0\u2022\u00A0";
                else if (!arg.startsWith("-")) {} // plain value before flag — no extra space
                else suffix = " ";               // flag followed by value — add space
                return <span key={i}>{arg}{suffix}</span>;
              });
            })()}
          </span>
        )}

        {/* Hide toggle — admin only */}
        {isAdmin && (
          <button onClick={() => toggleHiddenValue?.(paramKey, val)}
            className="leading-none text-nv-green/50 hover:text-yellow-400 transition-colors"
            title="Hide this value (persists)">
            <svg width="12" height="12" viewBox="0 0 24 24"><path d="M3 12s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7z" fill="none" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
          </button>
        )}

        {/* Edit sub-params — admin only, shown when value has sub_params */}
        {isAdmin && onEditValue && hasSubArgs(String(val)) && (
          <button onClick={(e) => {
            e.stopPropagation();
            onEditValue(val);
          }}
            className="leading-none text-nv-green/50 hover:text-yellow-400 transition-colors"
            title="Edit sub-args for this value">
            E
          </button>
        )}
      </span>
    );
  };



  return (
    <div className="flex-1 flex flex-col gap-0.5">
      {/* Inline row: bubbles + override selector + add input */}
      <div className="flex items-center gap-1.5 flex-wrap">
        {allDisplayValues.map((item, idx) => renderBubble(item, idx))}

        {/* Override selector — show current override when not in any list */}
        {onOverrideChange && currentValue &&
         !allDisplayValues.some(d => String(d.val) === String(currentValue)) && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 border text-[9px] font-mono rounded-sm bg-yellow-400/25 border-yellow-400/60 text-yellow-300">
            {String(currentValue)}
            <button onClick={() => onOverrideChange(String(currentValue))}
              className="ml-0.5 leading-none text-red-400/40 hover:text-red-400 transition-colors"
              title="Remove override">×</button>
          </span>
        )}

        {/* Add value input — admin only */}
        {addValue && (
          <input type="text" placeholder="+ add" value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitValue(); } }}
            className="w-12 bg-transparent border-b border-stealth-border/50 text-[9px] font-mono text-nv-green focus:outline-none px-1 py-0.5 placeholder:text-white/40" />
        )}
      </div>


    </div>
  );
}