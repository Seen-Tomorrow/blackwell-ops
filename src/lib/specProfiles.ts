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

export const SPEC_PROFILE_MTP = SPEC_PROFILE_MTP_GROUP;
export const SPEC_PROFILE_DFLASH = SPEC_PROFILE_DFLASH_GROUP;

/** Protected profile groups — cannot delete; params may be hidden. */
export const SPEC_PROFILE_GROUPS = [SPEC_PROFILE_MTP, SPEC_PROFILE_DFLASH] as const;

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
export const MTP_N_MAX = "mtp_n_max";
export const MTP_N_MIN = "mtp_n_min";
export const MTP_P_MIN = "mtp_p_min";
export const DFLASH_N_MAX = "dflash_n_max";
export const DFLASH_N_MIN = "dflash_n_min";
export const DFLASH_P_MIN = "dflash_p_min";
export const DFLASH_DRAFT_MODEL = "dflash_draft_model";

export const SPEC_PROFILE_PARAM_KEYS = [
  MTP_N_MAX,
  MTP_N_MIN,
  MTP_P_MIN,
  DFLASH_N_MAX,
  DFLASH_N_MIN,
  DFLASH_P_MIN,
  DFLASH_DRAFT_MODEL,
] as const;

/** Legacy single-group keys — stripped on load; not used by new profiles. */
export const OBSOLETE_SPEC_PARAM_KEYS = [
  "spec_type",
  "spec_draft_n_max",
  "spec_draft_n_min",
  "spec_draft_p_min",
  // spec_draft_model moved to dflash_draft_model; strip old SYSTEM chip if present
  "spec_draft_model",
] as const;

const OBSOLETE_SET = new Set<string>(OBSOLETE_SPEC_PARAM_KEYS);
const PROFILE_KEY_SET = new Set<string>(SPEC_PROFILE_PARAM_KEYS);

export function isSpecProfileGroup(group: string | undefined | null): boolean {
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
  if (method === "mtp") return SPEC_PROFILE_MTP;
  // DFlash + DSpark share SPECULATIVE-DFLASH knobs / draft path chip
  if (method === "dflash" || method === "dspark") return SPEC_PROFILE_DFLASH;
  return null;
}

export function boostMethodForGroup(group: string): SpecBoostMethod | null {
  const g = normalizeUiGroup(group);
  if (g === SPEC_PROFILE_MTP) return "mtp";
  // Group alone cannot distinguish dflash vs dspark — UI Boost is source of truth
  if (g === SPEC_PROFILE_DFLASH) return "dflash";
  return null;
}

export function cliSpecTypeForMethod(method: SpecBoostMethod): string | null {
  if (method === "mtp") return "draft-mtp";
  if (method === "dflash") return "draft-dflash";
  if (method === "dspark") return "draft-dspark";
  return null;
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

export function paramsInProfile(
  params: UserEditedTemplateParam[],
  group: SpecProfileGroup,
): UserEditedTemplateParam[] {
  return params.filter((p) => paramUiGroup(p.ui_group) === group);
}

/**
 * Desired hidden state for profile groups given Boost method.
 * Active group: respect user_hidden. Inactive groups: all hidden.
 */
export function desiredProfileHidden(
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

  if (method === "mtp") {
    pickProfileKey(MTP_N_MAX);
    pickProfileKey(MTP_N_MIN);
    pickProfileKey(MTP_P_MIN);
  } else if (method === "dflash" || method === "dspark") {
    // Shared external-draft knobs (template SPECULATIVE-DFLASH)
    pickProfileKey(DFLASH_N_MAX);
    pickProfileKey(DFLASH_N_MIN);
    pickProfileKey(DFLASH_P_MIN);
    const draft = config[DFLASH_DRAFT_MODEL];
    if (draft != null && String(draft).trim() !== "") {
      out[DFLASH_DRAFT_MODEL] = draft;
      // Alias for post-loop draft inject / validate_spec_launch
      // CLI: --spec-draft-model / -md (same flag)
      if (String(draft).toLowerCase() !== "auto") {
        out[SPEC_CLI_DRAFT] = draft;
      }
    }
  }

  return out;
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

  const skip = new Set<string>([DFLASH_DRAFT_MODEL]);
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

/** Drop obsolete single-group params from a provider param list (no migration of values). */
export function stripObsoleteSpecParams<T extends { key: string; ui_group?: string }>(
  params: T[],
): T[] {
  return params.filter(
    (p) =>
      !isObsoleteSpecParamKey(p.key)
      && normalizeUiGroup(p.ui_group || "") !== "SPECULATIVE-DECODING",
  );
}
