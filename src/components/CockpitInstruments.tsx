/**
 * Cockpit instruments — SAMPLE personality rail + THROUGHPUT batch rail.
 *
 * These are not sliders and not chip groups: one rail per family, with the
 * resolved values always visible and the exact controls one click away.
 */

import { useState } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
import {
  TASTES,
  THROUGHPUT_STOPS,
  detectSamplerTaste,
  detectThroughput,
  formatParamValue,
  paramValuesOf,
  sameParamValue,
  samplerDefs,
  samplerFingerprint,
  tasteValues,
  throughputDefs,
  throughputValues,
  type TasteDef,
  type ThroughputDef,
} from "../lib/engineSurfaces";

interface InstrumentProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
}

export function SamplerTaste({ defs, config, onChange }: InstrumentProps) {
  const [open, setOpen] = useState(false);
  const sampler = samplerDefs(defs);
  if (sampler.length === 0) return null;

  const active = detectSamplerTaste(sampler, config);
  const fingerprint = samplerFingerprint(sampler, config);

  const apply = (taste: TasteDef) => {
    for (const [key, value] of tasteValues(sampler, taste)) onChange(key, value);
  };

  return (
    <div className="cockpit-instrument cockpit-instrument--sample">
      <span className="cockpit-instrument__label">SAMPLE</span>
      <div className="cockpit-instrument__stops" role="group" aria-label="Sampler personality">
        {TASTES.map((taste) => (
          <button
            key={taste.id}
            type="button"
            className={`cockpit-instrument__stop${
              active === taste.id ? " cockpit-instrument__stop--active" : ""
            }`}
            title={taste.blurb}
            onClick={() => apply(taste)}
          >
            {taste.label}
          </button>
        ))}
        {active === "custom" ? (
          <span className="cockpit-instrument__custom" title="Values do not match a personality">
            CUSTOM
          </span>
        ) : null}
      </div>
      <span className="cockpit-instrument__finger" aria-label="Resolved sampler values">
        {fingerprint.map((item) => (
          <span
            key={item.key}
            className={`cockpit-instrument__finger-item${
              item.tuned ? " cockpit-instrument__finger-item--tuned" : ""
            }`}
            title={item.key}
          >
            {item.short} {item.value}
          </span>
        ))}
      </span>
      <button
        type="button"
        className="cockpit-instrument__more"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide exact sampler values" : "Show exact sampler values"}
      >
        {open ? "CLOSE" : "VALUES"}
      </button>
      {open ? (
        <div className="cockpit-instrument__drawer">
          {sampler.map((def) => (
            <div key={def.key} className="cockpit-instrument__drawer-row">
              <span className="cockpit-instrument__drawer-label" title={def.label}>
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

export function ThroughputRail({ defs, config, onChange }: InstrumentProps) {
  const [open, setOpen] = useState(false);
  const throughput = throughputDefs(defs);
  if (throughput.length === 0) return null;

  const active = detectThroughput(throughput, config);
  const batch = config.batch;
  const ubatch = config.ubatch;

  const apply = (stop: ThroughputDef) => {
    for (const [key, value] of throughputValues(throughput, stop)) onChange(key, value);
  };

  return (
    <div className="cockpit-instrument cockpit-instrument--throughput">
      <span className="cockpit-instrument__label">THRU</span>
      <div className="cockpit-instrument__stops" role="group" aria-label="Batch throughput">
        {THROUGHPUT_STOPS.map((stop) => (
          <button
            key={stop.id}
            type="button"
            className={`cockpit-instrument__stop${
              active === stop.id ? " cockpit-instrument__stop--active" : ""
            }`}
            title={stop.blurb}
            onClick={() => apply(stop)}
          >
            {stop.label}
          </button>
        ))}
        {active === "custom" ? (
          <span className="cockpit-instrument__custom" title="Custom batch/ubatch pair">
            CUSTOM
          </span>
        ) : null}
      </div>
      <span className="cockpit-instrument__readout" aria-label="Resolved batch and ubatch">
        b{formatParamValue(batch)} / ub{formatParamValue(ubatch)}
      </span>
      <button
        type="button"
        className="cockpit-instrument__more"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        title={open ? "Hide exact batch values" : "Show exact batch values"}
      >
        {open ? "CLOSE" : "VALUES"}
      </button>
      {open ? (
        <div className="cockpit-instrument__drawer">
          {throughput.map((def) => (
            <div key={def.key} className="cockpit-instrument__drawer-row">
              <span className="cockpit-instrument__drawer-label" title={def.label}>
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
