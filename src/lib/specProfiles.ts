/**
 * Template-driven speculative decoding profiles.
 *
 * Factory ships two system groups with independent knobs:
 *   SPECULATIVE-MTP    → --spec-type draft-mtp + knobs
 *   SPECULATIVE-DFLASH → --spec-type draft-dflash + knobs + draft path
 *
 * Boost only selects which profile is active (group visibility).
 * Defaults and chips live entirely in the template / Config editor — no hardcoded presets.
 */

import type { UserEditedTemplateParam } from "./types";
import { filterParamValuesForConfigView } from "./launchProfile";
import type { ConfigViewMode } from "./types";
import { normalizeUiGroup, paramUiGroup } from "./storage";
import { SPEC_PROFILE_DFLASH_GROUP, SPEC_PROFILE_MTP_GROUP } from "./systemParams";
import { adapterForMethod, cliTypeForMethod } from "./spec/adapters";

export const SPEC_PROFILE_MTP = SPEC_PROFILE_MTP_GROUP;
export const SPEC_PROFILE_DFLASH = SPEC_PROFILE_DFLASH_GROUP;

/** Protected profile groups — cannot delete; params may be hidden. */
const SPEC_PROFILE_GROUPS = [SPEC_PROFILE_MTP, SPEC_PROFILE_DFLASH] as const;

export type SpecProfileGroup = (typeof SPEC_PROFILE_GROUPS)[number];

/**
 * Product Boost methods that map 1:1 to a profile group (plus off).
 * DSpark reuses the DFlash profile knobs + draft path UI; CLI type is draft-dspark.
 */
export type SpecBoostMethod = "off" | "mtp" | "dflash" | "dspark";

/** CLI keys emitted at launch (llama.cpp). */
export const SPEC_CLI_TYPE = "spec_type";
export const SPEC_CLI_N_MAX = "spec_draft_n_max";
export const SPEC_CLI_N_MIN = "spec_draft_n_min";
export const SPEC_CLI_P_MIN = "spec_draft_p_min";
export const SPEC_CLI_DRAFT = "spec_draft_model";

/** Template param keys (unique per profile so both sets coexist). */
const MTP_N_MAX = "mtp_n_max";
const MTP_N_MIN = "mtp_n_min";
const MTP_P_MIN = "mtp_p_min";
const DFLASH_N_MAX = "dflash_n_max";
const DFLASH_N_MIN = "dflash_n_min";
const DFLASH_P_MIN = "dflash_p_min";
const DFLASH_SAMPLING = "dflash_sampling";
export const DFLASH_DRAFT_MODEL = "dflash_draft_model";
export const MTP_DRAFT_MODEL = "mtp_draft_model";

export const SPEC_PROFILE_PARAM_KEYS = [
  MTP_N_MAX,
  MTP_N_MIN,
  MTP_P_MIN,
  DFLASH_N_MAX,
  DFLASH_N_MIN,
  DFLASH_P_MIN,
  DFLASH_SAMPLING,
  DFLASH_DRAFT_MODEL,
  MTP_DRAFT_MODEL,
] as const;

/**
 * Bag keys no template row defines, stripped on load so a stale chip cannot reach the CLI.
 *
 * `spec_draft_model` is deliberately NOT here. It is the CLI alias the launch writes
 * (`SPEC_CLI_DRAFT`) and what Rust reads for `-md` — a live key, not a legacy one.
 */
const OBSOLETE_SPEC_PARAM_KEYS = [
  "spec_type",
  "spec_draft_n_max",
  "spec_draft_n_min",
  "spec_draft_p_min",
] as const;

const OBSOLETE_SET = new Set<string>(OBSOLETE_SPEC_PARAM_KEYS);
const PROFILE_KEY_SET = new Set<string>(SPEC_PROFILE_PARAM_KEYS);

function isSpecProfileGroup(group: string | undefined | null): boolean {
  if (!group) return false;
  const g = normalizeUiGroup(group);
  return g === SPEC_PROFILE_MTP || g === SPEC_PROFILE_DFLASH;
}

export function isSpecProfileParamKey(key: string): boolean {
  return PROFILE_KEY_SET.has(key);
}

export function isObsoleteSpecParamKey(key: string): boolean {
  return OBSOLETE_SET.has(key);
}

export function groupForBoostMethod(method: SpecBoostMethod): SpecProfileGroup | null {
  return adapterForMethod(method)?.group ?? null;
}

function boostMethodForGroup(group: string): SpecBoostMethod | null {
  const g = normalizeUiGroup(group);
  if (g === SPEC_PROFILE_MTP) return "mtp";
  // Group alone cannot distinguish dflash vs dspark — UI Boost is source of truth
  if (g === SPEC_PROFILE_DFLASH) return "dflash";
  return null;
}

export function cliSpecTypeForMethod(method: SpecBoostMethod): string | null {
  return cliTypeForMethod(method) ?? null;
}

/** True if any param in either profile group is visible (spec product mode on). */
export function isAnySpecProfileActive(params: UserEditedTemplateParam[]): boolean {
  return params.some((p) => isSpecProfileGroup(p.ui_group) && !p.hidden);
}

/** Which product profile is currently visible (prefers MTP if both somehow on). */
export function activeBoostMethodFromParams(
  params: UserEditedTemplateParam[],
): SpecBoostMethod {
  const mtpOn = params.some(
    (p) => paramUiGroup(p.ui_group) === SPEC_PROFILE_MTP && !p.hidden,
  );
  const dfOn = params.some(
    (p) => paramUiGroup(p.ui_group) === SPEC_PROFILE_DFLASH && !p.hidden,
  );
  if (mtpOn && !dfOn) return "mtp";
  if (dfOn && !mtpOn) return "dflash";
  if (mtpOn && dfOn) return "mtp";
  return "off";
}

function paramsInProfile(
  params: UserEditedTemplateParam[],
  group: SpecProfileGroup,
): UserEditedTemplateParam[] {
  return params.filter((p) => paramUiGroup(p.ui_group) === group);
}

/**
 * Desired hidden state for profile groups given Boost method.
 * Active group: respect user_hidden. Inactive groups: all hidden.
 */
function desiredProfileHidden(
  method: SpecBoostMethod,
  group: SpecProfileGroup,
  param: UserEditedTemplateParam,
): boolean {
  const active = groupForBoostMethod(method);
  if (active !== group) return true;
  return Boolean(param.userHidden);
}

/**
 * Map active profile knobs → extra_params for launch.
 *
 * Rust `build_cmd` matches `extra_params` keys to **template param keys**
 * (`mtp_n_max`, `dflash_n_max`, …) and uses each param's `flag` for the CLI.
 * Also set `spec_type` so sanitize + post-loop inject can see the method.
 */
export function buildSpecCliExtraParams(
  method: SpecBoostMethod,
  config: Record<string, unknown>,
  params: UserEditedTemplateParam[],
): Record<string, unknown> {
  if (method === "off") return {};

  const st = cliSpecTypeForMethod(method);
  if (!st) return {};

  const out: Record<string, unknown> = { [SPEC_CLI_TYPE]: st };

  const pickProfileKey = (key: string) => {
    const def = params.find((p) => p.key === key);
    // Row hidden in Config / cockpit → do not force into extra_params.
    // Rust treats extra_params as an explicit override that bypasses hidden.
    if (def?.hidden || def?.userHidden) {
      return;
    }
    const raw = config[key];
    if (raw !== undefined && raw !== null && String(raw).trim() !== "") {
      out[key] = raw;
      return;
    }
    // 0 is a valid p_min
    if (typeof raw === "number" && !Number.isNaN(raw)) {
      out[key] = raw;
      return;
    }
    if (def?.defaultValue !== undefined && def.defaultValue !== null) {
      out[key] = def.defaultValue;
      return;
    }
    if (def?.values?.length) {
      out[key] = def.values[0];
    }
  };

  const adapter = adapterForMethod(method);
  if (!adapter) return {};

  pickProfileKey(adapter.knobs.nMax);
  pickProfileKey(adapter.knobs.nMin);
  pickProfileKey(adapter.knobs.pMin);
  // DFlash2-only: probabilistic sampling. DSpark shares the profile but not this knob.
  if (method === "dflash" && adapter.knobs.sampling) {
    pickProfileKey(adapter.knobs.sampling);
  }

  const draftKey = adapter.knobs.draftModel;
  if (draftKey) {
    const draft = config[draftKey];
    if (draft != null && String(draft).trim() !== "") {
      out[draftKey] = draft;
      // Alias for post-loop draft inject / validate_spec_launch
      // CLI: --spec-draft-model / -md (same flag)
      if (String(draft).toLowerCase() !== "auto") {
        out[SPEC_CLI_DRAFT] = draft;
      }
    }
  }

  return out;
}

/**
 * Share-card view of the active Boost profile — CLI truth, hidden-aware.
 *
 * Reads through `buildSpecCliExtraParams`, the same flattening launch emits, so the
 * card prints what the engine actually gets (hidden knobs dropped, factory defaults
 * filled). Reading the legacy `spec_type` / `spec_draft_n_*` bag keys directly is a
 * dead end: they are `OBSOLETE_SPEC_PARAM_KEYS`, stripped on load, so the share
 * header silently loses its whole SPEC row.
 */
export function specShareFields(
  method: SpecBoostMethod,
  config: Record<string, unknown>,
  params: UserEditedTemplateParam[],
): { specType?: string; nMax?: string | number; nMin?: string | number } {
  const cli = buildSpecCliExtraParams(method, config, params);
  const specType = cli[SPEC_CLI_TYPE];
  if (typeof specType !== "string" || !specType.trim()) return {};

  const pick = (key: string): string | number | undefined => {
    const raw = cli[key];
    if (typeof raw === "number") return raw;
    if (typeof raw === "string" && raw.trim()) return raw.trim();
    return undefined;
  };

  const mtp = method === "mtp";
  return {
    specType: specType.trim(),
    nMax: pick(mtp ? MTP_N_MAX : DFLASH_N_MAX),
    nMin: pick(mtp ? MTP_N_MIN : DFLASH_N_MIN),
  };
}

export type ProfileKnobRow = {
  key: string;
  label: string;
  values: (string | number)[];
  current: string | number | undefined;
  userAdded?: boolean;
  onChange: (v: string | number) => void;
};

/** SPEC-EXTRA rows for the active Boost method (from template params only). */
export function cockpitProfileKnobRows(
  method: SpecBoostMethod,
  params: UserEditedTemplateParam[],
  config: Record<string, unknown>,
  configView: ConfigViewMode,
  onChange: (key: string, value: string | number) => void,
): ProfileKnobRow[] {
  const group = groupForBoostMethod(method);
  if (!group) return [];

  // Draft paths are chosen by the ★ picker strip, not by a chip — both lanes skip
  // their own row so the head is never picked two different ways.
  const skip = new Set<string>([DFLASH_DRAFT_MODEL, MTP_DRAFT_MODEL]);
  return paramsInProfile(params, group)
    .filter((d) => !skip.has(d.key) && !d.userHidden && !d.hidden)
    .sort((a, b) => a.order - b.order)
    .map((d) => {
      const seen = new Set((d.values || []).map(String));
      const rawValues = [
        ...(d.values || []),
        ...(d.userAddedValues || []).filter((v) => !seen.has(String(v))),
      ];
      const values = filterParamValuesForConfigView(d, rawValues, configView);
      const cur = config[d.key];
      const current =
        cur !== undefined && cur !== null && String(cur).trim() !== ""
          ? (cur as string | number)
          : d.defaultValue !== undefined && d.defaultValue !== null
            ? (d.defaultValue as string | number)
            : values[0];
      return {
        key: d.key,
        label: d.label || d.key,
        values,
        current,
        userAdded: Boolean(d.userAddedValues?.length),
        onChange: (v: string | number) => onChange(d.key, v),
      };
    })
    .filter((r) => r.values.length > 0);
}

/** Drop bag keys no template row defines, so a stale chip cannot reach the CLI. */
export function stripObsoleteSpecParams<T extends { key: string }>(params: T[]): T[] {
  return params.filter((p) => !isObsoleteSpecParamKey(p.key));
}
