/**
 * COMPAT — launch-or-not flags, parked next to the launch button.
 *
 * These are not tuning knobs. They answer "will this model run at all?":
 * chat template, SWA, FIM, host cache, reasoning preservation.
 */

import { useState } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
import {
  COMPAT_KEYS,
  countTuned,
  formatParamValue,
  isParamTuned,
  paramValuesOf,
  sameParamValue,
} from "../lib/engineSurfaces";

const COMPAT_KEY_SET = new Set<string>(COMPAT_KEYS);

interface CompatPanelProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
}

export default function CompatPanel({ defs, config, onChange }: CompatPanelProps) {
  const [open, setOpen] = useState(false);
  const compat = defs.filter((def) => COMPAT_KEY_SET.has(def.key));
  if (compat.length === 0) return null;

  const tuned = countTuned(compat, config);

  return (
    <div className="compat-anchor">
      <button
        type="button"
        className={`config-panel-toolbar-chip compat-chip${
          tuned > 0 ? " compat-chip--tuned" : ""
        }${open ? " compat-chip--open" : ""}`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Compatibility flags — chat template, SWA, FIM, host cache, reasoning"
      >
        COMPAT{tuned > 0 ? ` ${tuned}` : ""}
      </button>
      {open ? (
        <div className="compat-popover" role="dialog" aria-label="Compatibility flags">
          <div className="compat-popover__head">
            <span className="compat-popover__title">COMPAT</span>
            <span className="compat-popover__note">
              Launch-or-not flags. Template defaults are safe; change these only when a model misbehaves.
            </span>
          </div>
          {compat.map((def) => {
            const values = paramValuesOf(def);
            return (
              <div key={def.key} className="compat-popover__row" title={def.note ?? def.label}>
                <span
                  className={`compat-popover__label${isParamTuned(def, config) ? " compat-popover__label--tuned" : ""}`}
                >
                  {def.label}
                </span>
                <div className="compat-popover__values">
                  {values.map((value) => {
                    const selected = sameParamValue(config[def.key], value);
                    return (
                      <button
                        key={`${def.key}-${String(value)}`}
                        type="button"
                        className={`compat-popover__value${
                          selected ? " compat-popover__value--active" : ""
                        }`}
                        onClick={() => onChange(def.key, value)}
                      >
                        {formatParamValue(value)}
                      </button>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
