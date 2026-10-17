/**
 * TWEAKS — compatibility / runtime flags as always-visible segment rows.
 *
 * Jinja, SWA full, FIM infill, host cache and reasoning preservation are
 * launch-or-not flags, not tuning knobs. Each row uses the same compact
 * segment chrome as the cockpit VISION / FLASH / LOAD flags.
 */

import type { UserEditedTemplateParam } from "../lib/types";
import {
  COMPAT_KEYS,
  countTuned,
  formatParamValue,
  isParamTuned,
  visibleParamValuesOf,
} from "../lib/engineSurfaces";
import SegmentSwitch from "./SegmentSwitch";

const TWEAK_KEY_SET = new Set<string>(COMPAT_KEYS);

interface TweaksPanelProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
}

export default function TweaksPanel({ defs, config, onChange }: TweaksPanelProps) {
  const tweaks = defs.filter((def) => TWEAK_KEY_SET.has(def.key));
  if (tweaks.length === 0) return null;

  const changed = countTuned(tweaks, config);

  return (
    <div className="cockpit-instrument cockpit-instrument--tweaks">
      <div className="cockpit-instrument__head">
        <span className="cockpit-instrument__label">TWEAKS</span>
        <span className="cockpit-instrument__state">
          {changed > 0 ? `${changed} customized` : "template"}
        </span>
      </div>
      <div className="cockpit-tweaks-grid">
        {tweaks.map((def) => {
          const values = visibleParamValuesOf(def);
          const current = String(config[def.key] ?? def.defaultValue ?? "");
          return (
            <div key={def.key} className="cockpit-tweak-cell" title={def.note ?? def.label}>
              <span
                className={`cockpit-tweak-cell__label${
                  isParamTuned(def, config) ? " cockpit-tweak-cell__label--tuned" : ""
                }`}
              >
                {def.label}
              </span>
              <SegmentSwitch
                ariaLabel={def.label}
                options={values.map((value) => ({
                  id: String(value),
                  label: formatParamValue(value).toUpperCase(),
                }))}
                selectedId={current}
                onSelect={(id) => {
                  const value = values.find((item) => String(item) === id);
                  if (value !== undefined) onChange(def.key, value);
                }}
                size="compact"
                tone="accent"
                className="segment-switch--gpu-bezel segment-switch--cockpit-flag"
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
