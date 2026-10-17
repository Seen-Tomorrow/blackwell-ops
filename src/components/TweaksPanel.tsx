/**
 * TWEAKS — compatibility / runtime flags.
 *
 * Jinja, SWA full, FIM infill, host cache and reasoning preservation are
 * launch-or-not flags, not tuning knobs. They live as a full-width row under
 * the SAMPLER / THROUGHPUT instruments so the cockpit owns every engine
 * surface.
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

const TWEAK_KEY_SET = new Set<string>(COMPAT_KEYS);

interface TweaksPanelProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
}

export default function TweaksPanel({ defs, config, onChange }: TweaksPanelProps) {
  const [open, setOpen] = useState(false);
  const tweaks = defs.filter((def) => TWEAK_KEY_SET.has(def.key));
  if (tweaks.length === 0) return null;

  const changed = countTuned(tweaks, config);

  return (
    <div className="cockpit-instrument cockpit-instrument--tweaks">
      <span className="cockpit-instrument__label">TWEAKS</span>
      <span className="cockpit-instrument__readout">
        <span className="cockpit-instrument__readout-item">
          {changed > 0 ? `${changed} changed` : "template"}
        </span>
      </span>
      <button
        type="button"
        className={`cockpit-instrument__more${
          open ? " cockpit-instrument__more--active" : ""
        }`}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title="Compatibility / runtime tweaks — chat template, SWA, FIM, host cache, reasoning"
      >
        {open ? "CLOSE" : "EDIT"}
      </button>
      {open ? (
        <div className="cockpit-instrument__drawer">
          {tweaks.map((def) => (
            <div
              key={def.key}
              className="cockpit-instrument__drawer-row"
              title={def.note ?? def.label}
            >
              <span
                className={`cockpit-instrument__drawer-label${
                  isParamTuned(def, config)
                    ? " cockpit-instrument__drawer-label--tuned"
                    : ""
                }`}
              >
                {def.label}
              </span>
              <div className="cockpit-instrument__values">
                {paramValuesOf(def).map((value) => {
                  const selected = sameParamValue(config[def.key], value);
                  return (
                    <button
                      key={`${def.key}-${String(value)}`}
                      type="button"
                      className={`cockpit-instrument__value${
                        selected ? " cockpit-instrument__value--active" : ""
                      }`}
                      onClick={() => onChange(def.key, value)}
                    >
                      {formatParamValue(value)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
