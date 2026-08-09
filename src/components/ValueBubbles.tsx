/**
 * ValueBubbles — Render parameter values as clickable bubbles.
 *
 * STYLING (theme value-chip tokens — not Tailwind border-nv-green/N):
 * - Idle              → .value-chip
 * - Selected          → .value-chip-active
 * - Factory default   → .value-chip--factory-default
 * - User-set default  → .value-chip--user-default
 * - User-added value  → .value-chip--user-added
 * - Hidden            → .value-chip--hidden
 */

import React, { useState, useCallback, useMemo } from "react";
import { compareParamValues, isNumericLiteral } from "../lib/paramValueSort";

type ValueBubbleItem = { val: string | number; isUserAdded: boolean };

interface ValueBubblesProps {
  paramKey: string;
  editorUnlocked?: boolean;     // CONFIG editor unlocked — show value/row controls
  currentValue?: string | number; // the value currently selected for this model+provider
  onOverrideChange?: (value: string | number) => void;   // user selects a different value
  addValue?: (value: string | number) => void;            // admin adds new value to param's available list
  toggleHiddenValue?: (_key: string, value: string | number) => void;
  hiddenValues?: (string | number)[];
  /** Toggle value out of Essentials engine view only. */
  toggleEssentialsHiddenValue?: (_key: string, value: string | number) => void;
  essentialsHiddenValues?: (string | number)[];
  availableValues?: (string | number)[];
  userAddedValues?: (string | number)[];
  /** Current default for this param (what the UI shows as selected by default). */
  defaultValue?: string | number;
  /** Factory default from provider default config — never changes. Used to distinguish factory vs admin-set defaults. */
  factoryDefault?: string | number;
  onChangeDefault?: (value: string | number) => void;  // admin marks this value as the new default
  ptype?: 'switch' | 'switch_onoff' | 'switch_inverted' | 'arg_select' | 'arg_select_double' | 'slider' | 'path_scanner' | 'logic_only';
  /** Called when user clicks × on override bubble to clear it. */
  onClearOverride?: () => void;
  /** Opens editor for this specific value's sub_params (admin only). */
  onEditValue?: (value: string | number) => void;
  removeValue?: (value: string | number) => void;
  /**
   * When set, × only shown if true. Default: allow all when removeValue is set.
   * Used for protected groups: factory values hide-only; user values removable.
   */
  canRemoveValue?: (value: string | number, isUserAdded: boolean) => boolean;
  /** Sub-params injected by Rust templates.rs when a specific value is selected (e.g. MOE_OPTIMAL). */
  subParams?: Record<string, string[]>;
}

export default function ValueBubbles({
  paramKey,
  editorUnlocked = false,
  currentValue = "",
  onOverrideChange,
  addValue,
  toggleHiddenValue,
  hiddenValues = [],
  toggleEssentialsHiddenValue,
  essentialsHiddenValues = [],
  availableValues,
  userAddedValues = [],
  defaultValue,
  factoryDefault,
  onChangeDefault,
  onEditValue,
  removeValue,
  canRemoveValue,
  ptype,
  onClearOverride,
  subParams,
}: ValueBubblesProps) {
  const [inputValue, setInputValue] = useState("");
  const [expandedSubs, setExpandedSubs] = useState<Record<string, boolean>>({});

  // ── Build unified display list (template values + user-added), deduped + sorted ──
  const allDisplayValues = useMemo(() => {
    const seen = new Set<string>();
    const userAddedSet = new Set((userAddedValues || []).map((v) => String(v)));
    const items: ValueBubbleItem[] = [];

    if (availableValues) {
      for (const v of availableValues) {
        const key = String(v);
        if (!seen.has(key)) {
          seen.add(key);
          items.push({ val: v, isUserAdded: userAddedSet.has(key) });
        }
      }
    }
    for (const v of userAddedValues || []) {
      const key = String(v);
      if (!seen.has(key)) {
        seen.add(key);
        items.push({ val: v, isUserAdded: true });
      }
    }
    if (items.length > 1 && items.every((i) => isNumericLiteral(i.val))) {
      return items.sort((a, b) => compareParamValues(a.val, b.val));
    }
    return items;
  }, [availableValues, userAddedValues]);

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

  const isEssentialsHidden = useCallback((val: string | number): boolean =>
    essentialsHiddenValues.some((hv) => String(hv) === String(val)),
  [essentialsHiddenValues]);

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
  const renderBubble = (item: ValueBubbleItem, idx: number) => {
    const { val, isUserAdded } = item;
    const selected = String(val) === String(currentValue);
    const hidden = isHidden(val);
    const essHidden = isEssentialsHidden(val);

    // Hidden value — shown greyed-out with eye icon to un-hide
    if (hidden) {
      return (
        <span key={`hidden-${paramKey}-${idx}`}
          className="value-chip value-chip--hidden inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-sm line-through opacity-40">
          {String(val)}
          {editorUnlocked && toggleHiddenValue && (
            <button onClick={() => toggleHiddenValue(paramKey, val)}
              className="leading-none text-nv-green/50 hover:text-yellow-400 transition-colors"
              title="Show value in catalog">
              <svg width="12" height="12" viewBox="0 0 24 24"><path d="M3 12s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7z" fill="none" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
            </button>
          )}
        </span>
      );
    }

    /*
     * Theme chips (value-chip*) — never Tailwind border-nv-green/N (opacity on CSS
     * vars washes to white on dark / vanishes on ARCTIC).
     */
    const isDefault = defaultValue !== undefined && String(val) === String(defaultValue);
    const isFactoryDefault =
      factoryDefault !== undefined &&
      String(val).toUpperCase() === String(factoryDefault).toUpperCase();

    let chipClass = "value-chip";
    if (isUserAdded) {
      chipClass = "value-chip value-chip--user-added";
    } else if (isDefault && !isFactoryDefault) {
      chipClass = "value-chip value-chip--user-default";
    } else if (isDefault && isFactoryDefault) {
      chipClass = "value-chip value-chip--factory-default";
    } else if (selected) {
      chipClass = "value-chip value-chip-active";
    }

    return (
      <span
        key={`${paramKey}-${idx}`}
        role={onOverrideChange ? "button" : undefined}
        tabIndex={onOverrideChange ? 0 : undefined}
        onClick={() => {
          if (onOverrideChange) onOverrideChange(val);
        }}
        onKeyDown={(e) => {
          if (!onOverrideChange) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOverrideChange(val);
          }
        }}
        className={`inline-flex items-center gap-1 px-2 py-0.5 text-[11px] font-mono rounded-sm transition-all cursor-pointer select-none ${chipClass}${
          selected ? " value-chip-active" : ""
        }${essHidden ? " opacity-55" : ""}`}
        data-selected={selected ? "1" : undefined}
      >

        {/* Set as default button — admin only (only on non-default values) */}
        {editorUnlocked && defaultValue !== undefined && String(val) !== String(defaultValue) && onChangeDefault && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onChangeDefault(val);
            }}
            className="leading-none font-bold text-[12px] text-nv-green/60 hover:text-yellow-400 transition-colors pl-1"
            title="Set as default value"
          >
            *
          </button>
        )}

        {/* Essentials value flag — same ESS on/off visual as param row */}
        {editorUnlocked && toggleEssentialsHiddenValue && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              toggleEssentialsHiddenValue(paramKey, val);
            }}
            className={`config-param-ess text-[8px] font-mono px-0.5 select-none transition-colors ${
              essHidden
                ? "text-stealth-muted/30 line-through"
                : "text-nv-green/70 hover:text-nv-green"
            }`}
            title={
              essHidden
                ? "Excluded from Essentials engine view — click to include"
                : "In Essentials engine view — click to hide this value from Essentials only"
            }
          >
            ESS
          </button>
        )}

        <span className={essHidden ? "line-through decoration-stealth-muted/40 opacity-70" : undefined}>
          {String(val)}
        </span>

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

        {/* Remove value — admin only; factory chips may be hide-only under protected policy */}
        {editorUnlocked && removeValue && (canRemoveValue ? canRemoveValue(val, isUserAdded) : true) && (
          <button onClick={(e) => { e.stopPropagation(); removeValue(val); }}
            className="leading-none text-red-400/60 hover:text-red-400 transition-colors"
            title={isUserAdded ? "Remove user value" : "Remove this value"}>
            ×
          </button>
        )}

        {/* Hide toggle — admin only */}
        {editorUnlocked && (
          <button onClick={() => toggleHiddenValue?.(paramKey, val)}
            className="leading-none text-nv-green/50 hover:text-yellow-400 transition-colors pr-1"
            title="Hide this value (persists)">
            <svg width="12" height="12" viewBox="0 0 24 24"><path d="M3 12s4-7 9-7 9 7 9 7-4 7-9 7-9-7-9-7z" fill="none" stroke="currentColor" strokeWidth="2"/><circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="2"/></svg>
          </button>
        )}

        {/* Edit sub-params — admin only, shown when value has sub_params */}
        {editorUnlocked && onEditValue && hasSubArgs(String(val)) && (
          <button onClick={(e) => {
            e.stopPropagation();
            onEditValue(val);
          }}
            className="leading-none text-nv-green/50 hover:text-yellow-400 transition-colors pr-1"
            title="Edit sub-args for this value">
            E
          </button>
        )}
      </span>
    );
  };



  return (
    <div className="flex-1 flex flex-col gap-0.5 min-w-0">
      {/* Themed value chips + add/override — CONFIG editor page keeps its own
          .value-chip treatment (no engine-config segment rail) */}
      <div className="flex items-center gap-1.5 flex-wrap min-w-0">
        {allDisplayValues.map((item, idx) => renderBubble(item, idx))}

        {/* Override selector — show current override when not in any list (skip for slider — custom values are normal) */}
        {onOverrideChange && currentValue && ptype !== 'slider' &&
         !allDisplayValues.some(d => String(d.val) === String(currentValue)) && (
          <span className="inline-flex items-center gap-0.5 px-1.5 py-0.5 border text-[9px] font-mono rounded-sm bg-yellow-400/25 border-yellow-400/60 text-yellow-300">
            {String(currentValue)}
            <button onClick={() => onClearOverride?.()}
              className="ml-0.5 leading-none text-red-400/40 hover:text-red-400 transition-colors"
              title="Remove override">×</button>
          </span>
        )}

        {/* Add value input — admin only */}
        {addValue && (
          <input type="text" placeholder="+ add" value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); submitValue(); } }}
            className="config-param-add-input w-12 bg-transparent border-b border-stealth-border/50 text-[9px] font-mono text-nv-green focus:outline-none px-1 py-0.5 placeholder:text-white/40" />
        )}
      </div>
    </div>
  );
}