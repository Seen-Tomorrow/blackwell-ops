/**
 * TASK — one task preset switch plus the resolved sampler badges.
 *
 * The same CHAT / CODING / LONG-DOC / BATCH names are used by AUTOPILOT and by
 * the ASSISTED cockpit. The preset switch reuses the AUTOPILOT rail segment
 * (primary scale); CUSTOM opens the exact-value drawer, and editing any value
 * flips the derived task to CUSTOM automatically.
 *
 * CockpitInstruments is the one authoritative layout for the Assisted
 * instrument row: BATCH//UBATCH left, TASK right, TWEAKS collapsed underneath.
 */

import { useEffect, useRef, useState } from "react";
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
import BatchRangeSlider from "./BatchRangeSlider";
import CockpitNavSegment from "./CockpitNavSegment";
import TweaksPanel from "./TweaksPanel";

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

/** How long the resolved sampler values stay visible after a TASK pick. */
const TASK_PREVIEW_MS = 3000;

/** Cache RAM is shown in GiB (MiB → 8G / 16G / 32G) to stay compact. */
function formatCacheRam(value: ParamValue): string {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return String(value).toUpperCase();
  return n >= 1024 ? `${Math.round(n / 1024)}G` : `${n}M`;
}

export function SamplerTask({
  defs,
  config,
  onChange,
  onTask,
  parallel,
}: SamplerTaskProps) {
  const [open, setOpen] = useState(false);
  /** Resolved-value bubbles are a transient preview, not permanent chrome. */
  const [preview, setPreview] = useState(false);
  const previewTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (previewTimer.current != null) window.clearTimeout(previewTimer.current);
    };
  }, []);

  const sampler = samplerDefs(defs);
  if (sampler.length === 0) return null;

  const parallelSlots = parallel ?? (Number(config.parallel ?? 1) || 1);
  const active = detectSamplerTask(config);
  const fingerprint = samplerFingerprint(sampler, config);
  const presence = Number(config.presence_penalty ?? 0);
  const repeat = Number(config.repeat_penalty ?? 1);
  const penaltyAtLoad = (presence > 0 || repeat !== 1) && parallelSlots >= 8;

  // Prompt cache belongs to TASK: the presets drive cache_ram, so the control
  // lives on the same row instead of the cockpit header.
  const cacheDef = defs.find((def) => def.key === "cache_ram");
  const cacheValues =
    cacheDef && !cacheDef.hidden && !cacheDef.userHidden
      ? visibleParamValuesOf(cacheDef)
      : [];
  const cacheCurrent =
    String(config.cache_ram ?? "").trim() !== ""
      ? String(config.cache_ram)
      : String(cacheValues[0] ?? "");
  const cacheOptions = cacheValues.map(String);
  if (cacheCurrent && !cacheOptions.includes(cacheCurrent)) {
    cacheOptions.push(cacheCurrent);
  }
  const showCache = cacheOptions.length > 0;

  /** Any task pick re-flashes the resolved values — including re-picking the
   *  already-selected task, which is the "show me what this writes" gesture. */
  const flashPreview = () => {
    if (previewTimer.current != null) window.clearTimeout(previewTimer.current);
    setPreview(true);
    previewTimer.current = window.setTimeout(() => {
      previewTimer.current = null;
      setPreview(false);
    }, TASK_PREVIEW_MS);
  };

  const select = (id: string) => {
    if (id === "custom") {
      setOpen((prev) => !prev);
      return;
    }
    const task = FULL_AUTO_WORKLOADS.find((item) => item.id === id);
    if (task) {
      flashPreview();
      onTask(task.id);
      setOpen(false);
    }
  };

  return (
    <div className="cockpit-instrument cockpit-instrument--task">
      <div className="cockpit-instrument__task-row">
        <span className="cockpit-instrument__label">TASK</span>
        <CockpitNavSegment
          ariaLabel="Task sampler preset"
          options={TASK_OPTIONS}
          selectedId={open ? "custom" : active}
          onSelect={select}
          size="sub"
          className="cockpit-task-segment"
        />
        {penaltyAtLoad ? (
          <span className="cockpit-instrument__warn" title={PENALTY_WARNING}>
            PENALTY CPU
          </span>
        ) : null}
        {showCache ? (
          <span className="cockpit-instrument__cache">
            <span className="cockpit-instrument__label">PROMPT CACHE</span>
            <CockpitNavSegment
              ariaLabel="Prompt cache"
              options={cacheOptions.map((value) => ({
                id: value,
                label: formatCacheRam(value),
              }))}
              selectedId={cacheCurrent}
              onSelect={(id) => {
                const picked = cacheValues.find((value) => String(value) === id);
                onChange("cache_ram", picked ?? id);
              }}
              size="sub"
              className="cockpit-cache-segment"
            />
          </span>
        ) : null}
      </div>
      <span
        className={`cockpit-instrument__finger preview-fade${
          preview ? " preview-fade--on" : ""
        }`}
        aria-label="Resolved sampler values"
        aria-hidden={!preview}
      >
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

interface CockpitInstrumentsProps {
  defs: UserEditedTemplateParam[];
  config: Record<string, unknown>;
  onChange: (key: string, value: string | number) => void;
  onTask: (task: FullAutoWorkload) => void;
  /** No cockpit surface (custom provider) — own the outer face too. */
  standalone?: boolean;
}

/**
 * Instrument row for the ASSISTED cockpit (and the standalone fallback).
 * BATCH//UBATCH and TASK share one row height; TWEAKS is a collapsed
 * disclosure under TASK.
 */
export function CockpitInstruments({
  defs,
  config,
  onChange,
  onTask,
  standalone = false,
}: CockpitInstrumentsProps) {
  return (
    <div
      className={`cockpit-instruments${
        standalone ? " cockpit-instruments--standalone" : ""
      }`}
    >
      <BatchRangeSlider defs={defs} config={config} onChange={onChange} />
      <SamplerTask defs={defs} config={config} onChange={onChange} onTask={onTask} />
      <TweaksPanel defs={defs} config={config} onChange={onChange} />
    </div>
  );
}

export default CockpitInstruments;
