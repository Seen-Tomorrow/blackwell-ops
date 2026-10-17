/**
 * Engine surface routing — which params live as free chips (the maintenance
 * bay) and which are promoted to an instrument.
 *
 * The rule is intentionally data-shaped: a param is a "surface" param if the
 * cockpit / dock owns its value. The bay still renders every other param,
 * including anything added from the live catalog.
 */

import type { UserEditedTemplateParam } from "./types";

export type ParamValue = string | number;
export type ParamBag = Record<string, unknown>;

// ── Sampler ─────────────────────────────────────────────────────────────────

export const SAMPLER_KEYS = [
  "temp",
  "top_p",
  "top_k",
  "min_p",
  "presence_penalty",
  "repeat_penalty",
] as const;

export type SamplerKey = (typeof SAMPLER_KEYS)[number];

export const SAMPLER_SHORT: Record<SamplerKey, string> = {
  temp: "T",
  top_p: "P",
  top_k: "K",
  min_p: "M",
  presence_penalty: "PP",
  repeat_penalty: "RP",
};

export type TasteId = "model" | "exact" | "focused" | "balanced" | "wild";

export interface TasteDef {
  id: TasteId;
  label: string;
  blurb: string;
  /** Use the param's factory default for every sampler key. */
  defaults?: boolean;
  /** 0..1 position inside the param's own value list (works per provider). */
  percent?: Partial<Record<SamplerKey, number>>;
}

/** Five personalities, not six independent knobs. */
export const TASTES: TasteDef[] = [
  {
    id: "model",
    label: "MODEL",
    blurb: "Template / model recommendation — no overrides",
    defaults: true,
  },
  {
    id: "exact",
    label: "EXACT",
    blurb: "Code, extraction, deterministic output",
    percent: { temp: 0, top_p: 0, top_k: 0, min_p: 1, presence_penalty: 0, repeat_penalty: 0 },
  },
  {
    id: "focused",
    label: "FOCUSED",
    blurb: "Factual chat, low drift",
    percent: { temp: 0.25, top_p: 0.5, top_k: 0, min_p: 1, presence_penalty: 0, repeat_penalty: 0 },
  },
  {
    id: "balanced",
    label: "BALANCED",
    blurb: "General chat",
    percent: { temp: 0.5, top_p: 0.5, top_k: 0.5, min_p: 1, presence_penalty: 0.5, repeat_penalty: 0 },
  },
  {
    id: "wild",
    label: "WILD",
    blurb: "Writing, brainstorming, creative drift",
    percent: { temp: 1, top_p: 1, top_k: 1, min_p: 0, presence_penalty: 1, repeat_penalty: 0 },
  },
];

// ── Throughput ──────────────────────────────────────────────────────────────

export type ThroughputId = "latency" | "balanced" | "throughput" | "max";

export interface ThroughputDef {
  id: ThroughputId;
  label: string;
  blurb: string;
  defaults?: boolean;
  batch?: number;
  ubatch?: number;
}

export const THROUGHPUT_STOPS: ThroughputDef[] = [
  { id: "latency", label: "LATENCY", blurb: "Small prompts, snappiest first token", batch: 0.15, ubatch: 0.05 },
  { id: "balanced", label: "BAL", blurb: "Template batch — the safe default", defaults: true },
  { id: "throughput", label: "THRU", blurb: "Long prompts, better prefill throughput", batch: 0.55, ubatch: 0.5 },
  { id: "max", label: "MAX", blurb: "Big-prompt / many-agent workloads", batch: 0.9, ubatch: 0.85 },
];

// ── Compat ──────────────────────────────────────────────────────────────────

/** Launch-or-not flags. They belong next to the launch button, not in the wall. */
export const COMPAT_KEYS = [
  "jinja",
  "swa_full",
  "spm_infill",
  "cache_ram",
  "reasoning_preserve",
] as const;

export type CompatKey = (typeof COMPAT_KEYS)[number];

// ── Surface routing ─────────────────────────────────────────────────────────

/** Params promoted out of the maintenance bay. */
export const SURFACE_PARAM_KEYS: ReadonlySet<string> = new Set<string>([
  ...SAMPLER_KEYS,
  "batch",
  "ubatch",
  "unified_kv",
  ...COMPAT_KEYS,
]);

export function isSurfaceParam(key: string): boolean {
  return SURFACE_PARAM_KEYS.has(key);
}

/**
 * Launch-or-not flags that must always emit their resolved value — the engine
 * default is not guaranteed to match the template default.
 */
export const ALWAYS_LAUNCH_KEYS: ReadonlySet<string> = new Set<string>([
  "unified_kv",
  ...COMPAT_KEYS,
]);

// ── Value helpers ───────────────────────────────────────────────────────────

export function sameParamValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na === nb;
  return String(a).toLowerCase() === String(b).toLowerCase();
}

/** Usable values: factory list + user-added, deduped, hidden-object values dropped. */
export function paramValuesOf(def: UserEditedTemplateParam): ParamValue[] {
  const seen = new Set<string>();
  const out: ParamValue[] = [];
  for (const raw of [...(def.values ?? []), ...(def.userAddedValues ?? [])]) {
    if (raw == null || typeof raw === "object") continue;
    const key = String(raw);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

function sortedValues(def: UserEditedTemplateParam): ParamValue[] {
  const values = paramValuesOf(def);
  const nums = values.map((v) => Number(v));
  if (values.length > 1 && nums.every((n) => Number.isFinite(n))) {
    return [...values].sort((a, b) => Number(a) - Number(b));
  }
  return values;
}

export function defaultValueOf(def: UserEditedTemplateParam): ParamValue | undefined {
  if (def.defaultValue !== undefined) return def.defaultValue;
  return paramValuesOf(def)[0];
}

/** Pick a valid value at a 0..1 position in this param's own list. */
export function pickPercent(def: UserEditedTemplateParam, percent: number): ParamValue | undefined {
  const values = sortedValues(def);
  if (values.length === 0) return defaultValueOf(def);
  const i = Math.round(Math.min(1, Math.max(0, percent)) * (values.length - 1));
  return values[i];
}

export function isParamTuned(def: UserEditedTemplateParam, config: ParamBag): boolean {
  const current = config[def.key];
  if (current === undefined || current === null) return false;
  if (def.defaultValue === undefined) return false;
  return !sameParamValue(current, def.defaultValue);
}

export function countTuned(defs: UserEditedTemplateParam[], config: ParamBag): number {
  let n = 0;
  for (const def of defs) if (isParamTuned(def, config)) n += 1;
  return n;
}

export function formatParamValue(value: unknown): string {
  if (value === undefined || value === null || value === "") return "—";
  return String(value);
}

// ── Sampler state ───────────────────────────────────────────────────────────

export function samplerDefs(defs: UserEditedTemplateParam[]): UserEditedTemplateParam[] {
  return SAMPLER_KEYS.map((key) => defs.find((d) => d.key === key)).filter(
    (d): d is UserEditedTemplateParam => Boolean(d),
  );
}

export function tasteValues(
  defs: UserEditedTemplateParam[],
  taste: TasteDef,
): Map<SamplerKey, ParamValue> {
  const out = new Map<SamplerKey, ParamValue>();
  for (const def of defs) {
    const key = def.key as SamplerKey;
    if (!(SAMPLER_KEYS as readonly string[]).includes(key)) continue;
    if (taste.defaults) {
      const v = defaultValueOf(def);
      if (v !== undefined) out.set(key, v);
      continue;
    }
    const percent = taste.percent?.[key];
    if (percent === undefined) continue;
    const v = pickPercent(def, percent);
    if (v !== undefined) out.set(key, v);
  }
  return out;
}

export function detectSamplerTaste(
  defs: UserEditedTemplateParam[],
  config: ParamBag,
): TasteId | "custom" {
  for (const taste of TASTES) {
    const values = tasteValues(defs, taste);
    if (values.size === 0) continue;
    let match = true;
    for (const [key, value] of values) {
      if (!sameParamValue(config[key], value)) {
        match = false;
        break;
      }
    }
    if (match) return taste.id;
  }
  return "custom";
}

export function samplerFingerprint(
  defs: UserEditedTemplateParam[],
  config: ParamBag,
): Array<{ key: SamplerKey; short: string; value: string; tuned: boolean }> {
  const out: Array<{ key: SamplerKey; short: string; value: string; tuned: boolean }> = [];
  for (const def of defs) {
    const key = def.key as SamplerKey;
    if (!(SAMPLER_KEYS as readonly string[]).includes(key)) continue;
    out.push({
      key,
      short: SAMPLER_SHORT[key],
      value: formatParamValue(config[key] ?? def.defaultValue),
      tuned: isParamTuned(def, config),
    });
  }
  return out;
}

// ── Throughput state ────────────────────────────────────────────────────────

export function throughputDefs(defs: UserEditedTemplateParam[]): UserEditedTemplateParam[] {
  return ["batch", "ubatch"]
    .map((key) => defs.find((d) => d.key === key))
    .filter((d): d is UserEditedTemplateParam => Boolean(d));
}

export function throughputValues(
  defs: UserEditedTemplateParam[],
  stop: ThroughputDef,
): Map<string, ParamValue> {
  const out = new Map<string, ParamValue>();
  for (const def of defs) {
    if (stop.defaults) {
      const v = defaultValueOf(def);
      if (v !== undefined) out.set(def.key, v);
      continue;
    }
    const percent = def.key === "batch" ? stop.batch : stop.ubatch;
    if (percent === undefined) continue;
    const v = pickPercent(def, percent);
    if (v !== undefined) out.set(def.key, v);
  }
  return out;
}

export function detectThroughput(
  defs: UserEditedTemplateParam[],
  config: ParamBag,
): ThroughputId | "custom" {
  for (const stop of THROUGHPUT_STOPS) {
    const values = throughputValues(defs, stop);
    if (values.size === 0) continue;
    let match = true;
    for (const [key, value] of values) {
      if (!sameParamValue(config[key], value)) {
        match = false;
        break;
      }
    }
    if (match) return stop.id;
  }
  return "custom";
}
