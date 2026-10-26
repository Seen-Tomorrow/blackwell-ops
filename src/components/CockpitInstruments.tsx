/**
 * TASK — one task preset switch plus the resolved sampler badges.
 *
 * The same CHAT / CODING / LONG-DOC / BATCH names are used by AUTOPILOT and by
 * the ASSISTED cockpit. CUSTOM opens the exact-value drawer; editing any value
 * flips the derived task to CUSTOM automatically.
 */

import { useState } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
import {
  formatParamValue,
  sameParamValue,
  samplerDefs,
  samplerFingerprint,
  visibleParamValuesOf,
  type ParamValue,
} from "../lib/engineSurfaces";
import {
  detectSamplerTask,
  FULL_AUTO_WORKLOADS,
  type FullAutoWorkload,
} from "../lib/fullAutoGoals";
import SegmentSwitch from "./SegmentSwitch";

interface SamplerTaskProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
  onTask: (task: FullAutoWorkload) => void;
  /** Current slot count — the penalty warning only matters at high concurrency. */
  parallel?: number;
}

const TASK_OPTIONS = [
  ...FULL_AUTO_WORKLOADS.map((task) => ({
    id: task.id,
    label: task.label,
    title: task.note,
  })),
  { id: "custom", label: "CUSTOM", title: "Custom sampler values" },
];

const PENALTY_WARNING =
  "Presence / repeat penalty forces a full-vocab CPU scan. At high slot counts this can roughly halve TG throughput.";

export function SamplerTask({
  defs,
  config,
  onChange,
  onTask,
  parallel,
}: SamplerTaskProps) {
  const [open, setOpen] = useState(false);
  const sampler = samplerDefs(defs);
  if (sampler.length === 0) return null;

  const parallelSlots = parallel ?? (Number(config.parallel ?? 1) || 1);
  const active = detectSamplerTask(config);
  const fingerprint = samplerFingerprint(sampler, config);
  const presence = Number(config.presence_penalty ?? 0);
  const repeat = Number(config.repeat_penalty ?? 1);
  const penaltyAtLoad = (presence > 0 || repeat !== 1) && parallelSlots >= 8;

  const select = (id: string) => {
    if (id === "custom") {
      setOpen((prev) => !prev);
      return;
    }
    const task = FULL_AUTO_WORKLOADS.find((item) => item.id === id);
    if (task) {
      onTask(task.id);
      setOpen(false);
    }
  };

  return (
    <div className="cockpit-instrument cockpit-instrument--sample">
      <div className="cockpit-instrument__head">
        <span className="cockpit-instrument__label">TASK</span>
        {penaltyAtLoad ? (
          <span
            className="cockpit-instrument__state cockpit-instrument__state--warn"
            title={PENALTY_WARNING}
          >
            PENALTY CPU
          </span>
        ) : null}
      </div>
      <SegmentSwitch
        ariaLabel="Task sampler preset"
        options={TASK_OPTIONS}
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
          {sampler.map((def) => {
            const values = visibleParamValuesOf(def);
            const current = config[def.key];
            const recommended = FULL_AUTO_WORKLOADS
              .map((task) => (task.sampler as Record<string, ParamValue>)[def.key])
              .filter((value): value is ParamValue => value !== undefined);
            const extra =
              current !== undefined && !values.some((value) => sameParamValue(current, value))
                ? [current as ParamValue]
                : [];
            const allValues: ParamValue[] = [];
            for (const value of [...values, ...recommended, ...extra]) {
              if (!allValues.some((existing) => sameParamValue(existing, value))) {
                allValues.push(value);
              }
            }
            return (
              <div key={def.key} className="cockpit-instrument__drawer-row">
                <span className="cockpit-instrument__drawer-label" title={def.label}>
                  {def.label}
                </span>
                <div className="cockpit-instrument__values">
                  {allValues.map((value) => {
                    const selected = sameParamValue(current, value);
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
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
