/**
 * TWEAKS — compatibility / runtime flags as segment rows.
 *
 * Jinja, SWA full, FIM infill and reasoning preservation are launch-or-not
 * flags, not tuning knobs. Each row uses the same compact segment chrome as the
 * cockpit VISION / FLASH / LOAD flags, and the block stays collapsed by default
 * (it is reference chrome, not the main path).
 *
 * Layout is a two-column table: within a column the label track is `max-content`
 * (as wide as that column's longest label), so the switches line up in a clean
 * track while staying right next to their own label — no reserved blank column.
 */

import { Fragment, useState } from "react";
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
  const [open, setOpen] = useState(false);
  const tweaks = defs.filter((def) => TWEAK_KEY_SET.has(def.key));
  if (tweaks.length === 0) return null;

  const changed = countTuned(tweaks, config);
  // Row-major split so the visual order matches the old flat grid (1,2 / 3,4).
  const columns = [
    tweaks.filter((_, index) => index % 2 === 0),
    tweaks.filter((_, index) => index % 2 === 1),
  ];

  return (
    <div
      className={`cockpit-instrument cockpit-instrument--tweaks${
        open ? "" : " cockpit-instrument--tweaks--collapsed"
      }`}
    >
      <button
        type="button"
        className="cockpit-instrument__head cockpit-instrument__head--toggle"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        title={open ? "Hide TWEAKS" : "Show TWEAKS"}
      >
        <span className="cockpit-instrument__label">TWEAKS</span>
        <span className="cockpit-instrument__head-right">
          <span
            className="cockpit-instrument__state"
            title="Tweak values that differ from the template"
          >
            {changed} customized
          </span>
          <span
            className={`cockpit-instrument__chevron${
              open ? " cockpit-instrument__chevron--open" : ""
            }`}
            aria-hidden
          >
            ▶
          </span>
        </span>
      </button>
      {open ? (
        <div className="cockpit-tweaks-grid">
          {columns.map((column, columnIndex) => (
            <div className="cockpit-tweaks-col" key={`tweak-col-${columnIndex}`}>
              {column.map((def) => {
                const values = visibleParamValuesOf(def);
                const current = String(config[def.key] ?? def.defaultValue ?? "");
                return (
                  <Fragment key={def.key}>
                    <span
                      className={`cockpit-tweak-label${
                        isParamTuned(def, config) ? " cockpit-tweak-label--tuned" : ""
                      }`}
                      title={def.note ?? def.label}
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
                  </Fragment>
                );
              })}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
