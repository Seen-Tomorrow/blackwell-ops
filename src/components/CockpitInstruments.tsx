/**
 * SAMPLER — one personality switch plus the resolved-value badges.
 *
 * The six labels (MODEL / EXACT / FOCUSED / BALANCED / WILD / CUSTOM) use the
 * same compact segment chrome as the cockpit VISION / FLASH / LOAD flags.
 * CUSTOM opens the exact-value drawer; picking a personality closes it.
 */

import { useState } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
import {
  TASTES,
  detectSamplerTaste,
  formatParamValue,
  sameParamValue,
  samplerDefs,
  samplerFingerprint,
  tasteValues,
  visibleParamValuesOf,
  type TasteDef,
} from "../lib/engineSurfaces";
import SegmentSwitch from "./SegmentSwitch";

interface InstrumentProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
}

const TASTE_OPTIONS = [
  ...TASTES.map((taste) => ({
    id: taste.id,
    label: taste.label,
    title: taste.blurb,
  })),
  { id: "custom", label: "CUSTOM", title: "Custom sampler values" },
];

export function SamplerTaste({ defs, config, onChange }: InstrumentProps) {
  const [open, setOpen] = useState(false);
  const sampler = samplerDefs(defs);
  if (sampler.length === 0) return null;

  const active = detectSamplerTaste(sampler, config);
  const fingerprint = samplerFingerprint(sampler, config);

  const apply = (taste: TasteDef) => {
    for (const [key, value] of tasteValues(sampler, taste)) onChange(key, value);
    setOpen(false);
  };

  const select = (id: string) => {
    if (id === "custom") {
      setOpen((prev) => !prev);
      return;
    }
    const taste = TASTES.find((item) => item.id === id);
    if (taste) apply(taste);
  };

  return (
    <div className="cockpit-instrument cockpit-instrument--sample">
      <div className="cockpit-instrument__head">
        <span className="cockpit-instrument__label">SAMPLER</span>
      </div>
      <SegmentSwitch
        ariaLabel="Sampler personality"
        options={TASTE_OPTIONS}
        selectedId={open ? "custom" : active}
        onSelect={select}
        size="compact"
        tone="accent"
        className="segment-switch--gpu-bezel segment-switch--cockpit-flag"
      />
      <span className="cockpit-instrument__finger" aria-label="Resolved sampler values">
        {fingerprint.map((item) => (
          <span
            key={item.key}
            className={`cockpit-instrument__finger-item${
              item.tuned ? " cockpit-instrument__finger-item--tuned" : ""
            }`}
            title={item.key}
          >
            <span className="cockpit-instrument__finger-key">{item.label}</span>
            {item.value}
          </span>
        ))}
      </span>
      {open ? (
        <div className="cockpit-instrument__drawer">
          {sampler.map((def) => (
            <div key={def.key} className="cockpit-instrument__drawer-row">
              <span className="cockpit-instrument__drawer-label" title={def.label}>
                {def.label}
              </span>
              <div className="cockpit-instrument__values">
                {visibleParamValuesOf(def).map((value) => {
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
