/**
 * Custom provider (template_type = "custom") helpers.
 * Bare launch shell + optional capabilities; cockpit binds by Master param keys only.
 */

import type { ProviderConfig, UserEditedTemplateParam } from "./types";
import { COCKPIT_OWNED_PARAM_KEYS } from "./systemParams";

/** Canonical custom type string persisted on providers. */
export const CUSTOM_TEMPLATE_TYPE = "custom";

export function isCustomTemplateType(templateType: string | undefined | null): boolean {
  const t = (templateType ?? "").trim();
  return !t || t.toLowerCase() === CUSTOM_TEMPLATE_TYPE;
}

/** Optional spawn / product features for custom providers (all off by default). */
export type CustomProviderCapabilities = {
  /** Start Fusion brain (needs /slots + logs; often --metrics too). */
  fusion?: boolean;
  /** Inject --metrics at spawn. */
  metrics?: boolean;
  /** Inject verbosity tokens (see verboseArgs). */
  verbose?: boolean;
  /**
   * Free-form verbosity CLI, space-separated (e.g. "-lv 4" or "--verbose").
   * Used only when verbose is true. Default "-lv 4" when empty.
   */
  verboseArgs?: string;
};

export const DEFAULT_CUSTOM_CAPABILITIES: Required<
  Pick<CustomProviderCapabilities, "fusion" | "metrics" | "verbose">
> & { verboseArgs: string } = {
  fusion: false,
  metrics: false,
  verbose: false,
  verboseArgs: "-lv 4",
};

export function resolveCustomCapabilities(
  caps: CustomProviderCapabilities | undefined | null,
): typeof DEFAULT_CUSTOM_CAPABILITIES {
  return {
    fusion: Boolean(caps?.fusion),
    metrics: Boolean(caps?.metrics),
    verbose: Boolean(caps?.verbose),
    verboseArgs: (caps?.verboseArgs ?? "").trim() || DEFAULT_CUSTOM_CAPABILITIES.verboseArgs,
  };
}

/** Parse free-form verbose CLI into argv tokens. */
export function parseVerboseArgs(raw: string): string[] {
  const s = raw.trim();
  if (!s) return ["-lv", "4"];
  return s.split(/\s+/).filter(Boolean);
}

/**
 * Master-aligned essentials for custom "starter pack".
 * Same keys Master cockpit/chrome expects — regular user-editable rows (not protected).
 * Deleting a key just hides that cockpit control (2B).
 */
/**
 * Master-aligned **starter pack** keys (no reasoning — often incompatible across forks).
 * Placed in PERFORMANCE (not SYSTEM) so rows stay fully user-editable.
 * Named "starter" (not essentials) to avoid confusion with Essentials config view.
 */
export const CUSTOM_ESSENTIALS_PARAM_KEYS = [
  "ctx",
  "parallel",
  "kv_quant",
  "base_port",
  "split",
  "batch",
  "ubatch",
] as const;

export type CustomEssentialsKey = (typeof CUSTOM_ESSENTIALS_PARAM_KEYS)[number];

/** User-facing group for essentials pack — never SYSTEM (avoids chrome lock). */
export const CUSTOM_ESSENTIALS_UI_GROUP = "PERFORMANCE";

/** Cockpit surface keys — show control only if this key exists on the template. */
export const COCKPIT_BIND_KEYS = [
  "ctx",
  "parallel",
  "kv_quant",
  "reasoning",
  "reasoning_preserve",
] as const;

export function providerHasParamKey(
  params: Array<{ key: string }> | undefined,
  key: string,
): boolean {
  return Boolean(params?.some((p) => p.key === key));
}

/** True if any cockpit-bound key exists (show MultiAgentBooster / ctx strip). */
export function providerHasAnyCockpitBinding(
  params: Array<{ key: string }> | undefined,
): boolean {
  if (!params?.length) return false;
  for (const k of COCKPIT_BIND_KEYS) {
    if (providerHasParamKey(params, k)) return true;
  }
  for (const k of COCKPIT_OWNED_PARAM_KEYS) {
    if (providerHasParamKey(params, k)) return true;
  }
  return params.some(
    (p) =>
      p.key.startsWith("mtp_") ||
      p.key.startsWith("dflash_") ||
      p.key === "spec_type",
  );
}

/** Soft launch: custom providers are not hard-blocked by VRAM forecast. */
export function shouldSoftLaunchOnForecast(
  provider: ProviderConfig | undefined | null,
): boolean {
  return isCustomTemplateType(provider?.template_type);
}

/**
 * Repair older essentials packs that were pinned into SYSTEM (locked chrome).
 * Moves known pack keys back to PERFORMANCE and clears dock.
 */
export function repairCustomEssentialsGroups<
  T extends { key: string; ui_group?: string; dock?: string | null },
>(params: T[]): { params: T[]; changed: boolean } {
  let changed = false;
  const pack = new Set<string>(CUSTOM_ESSENTIALS_PARAM_KEYS);
  // Also repair reasoning leftovers from first pack revision
  pack.add("reasoning");
  pack.add("reasoning_preserve");
  const next = params.map((p) => {
    if (!pack.has(p.key)) return p;
    const g = (p.ui_group || "").toUpperCase().replace(/\s+/g, "-");
    const needs =
      g === "SYSTEM" || Boolean(p.dock && String(p.dock).trim());
    if (!needs && g === CUSTOM_ESSENTIALS_UI_GROUP) return p;
    changed = true;
    return { ...p, ui_group: CUSTOM_ESSENTIALS_UI_GROUP, dock: "" };
  });
  return { params: next, changed };
}

/** Clone master factory rows into user-owned params (essentials pack). */
export function masterParamsToUserEssentials(
  masterParams: Array<{
    key: string;
    label?: string;
    values?: (string | number)[];
    default?: string | number | null;
    defaultValue?: string | number | null;
    flag?: string | null;
    flag_pair?: string[];
    ptype?: string;
    step?: number | null;
    ui_group?: string;
    note?: string;
    pattern?: string;
    sub_params?: Record<string, string[]> | null;
    dock?: string | null;
  }>,
  existingKeys: Set<string>,
  startOrder: number,
): UserEditedTemplateParam[] {
  const want = new Set<string>(CUSTOM_ESSENTIALS_PARAM_KEYS);
  const out: UserEditedTemplateParam[] = [];
  let order = startOrder;
  for (const fp of masterParams) {
    if (!want.has(fp.key) || existingKeys.has(fp.key)) continue;
    let def =
      fp.defaultValue !== undefined && fp.defaultValue !== null
        ? fp.defaultValue
        : fp.default !== undefined && fp.default !== null
          ? fp.default
          : fp.values?.[0];
    // Solo GPU default — avoid layer/tensor default lighting "ALL GPUs" on dual systems
    if (fp.key === "split") def = "none";
    if (fp.key === "base_port" && (def === undefined || def === null || def === "")) def = 9090;
    out.push({
      key: fp.key,
      label: fp.label || fp.key,
      values: [...(fp.values || [])],
      order: order++,
      hidden: false,
      userHidden: false,
      flag: fp.flag ?? null,
      flag_pair: fp.flag_pair || [],
      ptype: (fp.ptype as UserEditedTemplateParam["ptype"]) || "arg_select",
      step: fp.step ?? undefined,
      // Never copy Master SYSTEM / dock — pack rows must be normal editable params.
      ui_group: CUSTOM_ESSENTIALS_UI_GROUP,
      note: fp.note || "",
      pattern: fp.pattern || "",
      sub_params: fp.sub_params || undefined,
      defaultValue: def as string | number | undefined,
      factoryDefault: def as string | number | undefined,
      dock: "",
    });
    existingKeys.add(fp.key);
  }
  return out;
}
