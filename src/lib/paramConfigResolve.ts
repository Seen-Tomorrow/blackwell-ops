import type { UserEditedTemplateParam } from "./types";
import { isSpecProfileParamKey } from "./specProfiles";

/** Fingerprint visibility + defaults so config reloads when SPEC group toggles. */
export function paramsVisibilityFingerprint(params: UserEditedTemplateParam[]): string {
  return params
    .map((p) => `${p.key}:${p.hidden ? "h" : "v"}:${String(p.defaultValue ?? "")}`)
    .join("\n");
}

export function resolveParamDefaultValue(def: UserEditedTemplateParam): unknown {
  if (!def.values?.length) return undefined;
  return def.defaultValue ?? def.values[0];
}

/** Resolve launch/config value: override → catalog default. Skips hidden params (except profile knobs). */
export function resolveVisibleParamValue(
  key: string,
  config: Record<string, unknown>,
  params: UserEditedTemplateParam[],
): unknown {
  const def = params.find((p) => p.key === key);
  // Profile knobs always readable (group may be hidden while Boost still shows chips).
  if (isSpecProfileParamKey(key)) {
    const v = config[key];
    if (v !== undefined && v !== null && String(v).trim() !== "") return v;
    if (!def) return undefined;
    return resolveParamDefaultValue(def);
  }
  if (!def) return undefined;
  if (def.hidden) return undefined;
  if (config[key] !== undefined) return config[key];
  return resolveParamDefaultValue(def);
}

export function paramValuesMatch(current: unknown, candidate: unknown): boolean {
  if (current === candidate) return true;
  if (current == null || candidate == null) return false;
  return String(current).toLowerCase() === String(candidate).toLowerCase();
}

/** Build extra_params for MANUAL launch from a key whitelist. */
export function buildLaunchExtraParams(opts: {
  config: Record<string, unknown>;
  keys: string[];
  paramDefs: UserEditedTemplateParam[];
  extra?: Record<string, unknown>;
}): Record<string, unknown> {
  const params: Record<string, unknown> = { ...(opts.extra ?? {}) };
  for (const key of opts.keys) {
    const value = resolveVisibleParamValue(key, opts.config, opts.paramDefs);
    if (value !== undefined) {
      params[key] = value;
    }
  }
  return params;
}
