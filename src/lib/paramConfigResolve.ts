import type { UserEditedTemplateParam } from "./types";

/** Picker-driven — no value chips; may stay hidden in SYSTEM while still launching. */
const INTERNAL_LAUNCH_PARAM_KEYS = new Set(["spec_draft_model"]);

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

/** Resolve launch/config value: override → catalog default. Skips hidden params. */
export function resolveVisibleParamValue(
  key: string,
  config: Record<string, unknown>,
  params: UserEditedTemplateParam[],
): unknown {
  const def = params.find((p) => p.key === key);
  if (!def) return undefined;
  if (INTERNAL_LAUNCH_PARAM_KEYS.has(key)) {
    const v = config[key];
    return v !== undefined && String(v).trim() !== "" ? v : undefined;
  }
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