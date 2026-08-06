import type { ConfigViewMode, ProviderDefaultParam, SpawnProfile, UserEditedTemplateParam } from "./types";
import { PANEL_CHROME_PARAM_KEYS } from "./paramDisplayZone";
import {
  COCKPIT_OWNED_PARAM_KEYS,
  ENGINE_ONLY_PARAM_KEYS,
  isCatalogVisibleParam,
  isPlacementChromeParam,
} from "./systemParams";
import { isModelSpecParamKey, SPEC_DECODING_UI_GROUP } from "./specDraft";
import { paramUiGroup } from "./storage";

/** Dock / launch chrome — always shown in essentials (alias uses separate row). */
export const LAUNCH_DOCK_PARAM_KEYS = ["base_port"] as const;

/** CLI keys injected by buildSpecCliExtraParams — not template row keys. */
export const SPEC_DECODING_LAUNCH_KEYS = [
  "spec_type",
  "spec_draft_model",
  "spec_draft_n_max",
  "spec_draft_n_min",
  "spec_draft_p_min",
] as const;

function skipSpecParamForLaunch(p: UserEditedTemplateParam, _specActive: boolean): boolean {
  // Profile knobs flatten to CLI keys at launch — never emit mtp_*/dflash_* rows as raw extras.
  const g = paramUiGroup(p.ui_group);
  if (g === "SPECULATIVE-MTP" || g === "SPECULATIVE-DFLASH") return true;
  if (g === SPEC_DECODING_UI_GROUP || isModelSpecParamKey(p.key)) return true;
  return false;
}

const DEFAULT_ESSENTIAL_KEYS = ["device", "ctx"] as const;

/** Factory FIT whitelist (param keys only — split handled separately for multi-GPU). */
export function resolveFitLaunchKeys(profile?: SpawnProfile): string[] {
  const raw = profile?.simple_param_keys ?? [...DEFAULT_ESSENTIAL_KEYS];
  return raw.filter((k) => k !== "split");
}

/** AUTO FIT launch + panel filter keys (split included when multi-GPU). */
export function resolveFitLaunchExtraKeys(opts: {
  profile?: SpawnProfile;
  specActive: boolean;
  multiGpu: boolean;
}): string[] {
  const keys = new Set<string>([
    ...resolveFitLaunchKeys(opts.profile),
    ...LAUNCH_DOCK_PARAM_KEYS,
  ]);
  if (opts.multiGpu) keys.add("split");
  if (opts.specActive) {
    for (const k of SPEC_DECODING_LAUNCH_KEYS) keys.add(k);
  }
  return [...keys];
}

const FIT_PANEL_CHROME_SCROLL_SKIP = new Set(["device", "split", "base_port", "offload_mode"]);

/** Scroll-area params under AUTO FIT — whitelist minus GpuAssign / dock chrome. */
export function filterParamsForFitLaunchDisplay(
  params: UserEditedTemplateParam[],
  launchKeys: Set<string>,
): UserEditedTemplateParam[] {
  return params.filter(
    (d) => !d.hidden && launchKeys.has(d.key) && !FIT_PANEL_CHROME_SCROLL_SKIP.has(d.key),
  );
}

/** Factory baseline for Essentials view (param panel filter only). */
export function resolveEssentialParamKeys(profile?: SpawnProfile): Set<string> {
  const raw = profile?.essentialParamKeys ?? profile?.simple_param_keys ?? [...DEFAULT_ESSENTIAL_KEYS];
  return new Set([...raw, ...LAUNCH_DOCK_PARAM_KEYS]);
}

export function isEssentialParam(
  def: UserEditedTemplateParam,
  factoryEssentialKeys: Set<string>,
): boolean {
  if (def.essential === true) return true;
  if (def.essential === false) return false;
  return factoryEssentialKeys.has(def.key);
}

/** True when a value is excluded from Essentials UI only (not Full, not catalog). */
export function isEssentialsHiddenValue(
  def: { essentialsHiddenValues?: (string | number)[] },
  value: string | number,
): boolean {
  return (def.essentialsHiddenValues || []).some((v) => String(v) === String(value));
}

/**
 * Filter display values for engine Essentials mode.
 * Always drops catalog hiddenValues; in essentials also drops essentialsHiddenValues.
 */
function valueKeyForHide(v: string | number): string {
  if (typeof v === "number" && Number.isFinite(v)) {
    // Canonical numeric key so 8192 and "8192" match.
    return String(v);
  }
  const s = String(v).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return String(n);
  }
  return s;
}

export function filterParamValuesForConfigView(
  def: UserEditedTemplateParam,
  values: (string | number)[],
  configView: ConfigViewMode,
): (string | number)[] {
  const catalogHidden = new Set((def.hiddenValues || []).map(valueKeyForHide));
  let out = values.filter((v) => !catalogHidden.has(valueKeyForHide(v)));
  if (configView === "essentials") {
    const essHidden = new Set((def.essentialsHiddenValues || []).map(valueKeyForHide));
    out = out.filter((v) => !essHidden.has(valueKeyForHide(v)));
  }
  return out;
}

export { valueKeyForHide };

/**
 * Snap a single value out of essentialsHiddenValues (and catalog hiddenValues)
 * onto a still-visible chip for Essentials / Full Auto launch.
 * Assisted Full must not call this — power keeps the fat bag.
 */
export function snapValueOutOfEssentialsHide(
  def: UserEditedTemplateParam,
  current: unknown,
): unknown {
  if (current === undefined || current === null) return current;
  const asChip: string | number =
    typeof current === "number" || typeof current === "string"
      ? current
      : String(current);

  const seen = new Set((def.values || []).map((v) => valueKeyForHide(v as string | number)));
  const allValues: (string | number)[] = [
    ...(def.values || []).map((v) => v as string | number),
    ...(def.userAddedValues || []).filter((v) => !seen.has(valueKeyForHide(v as string | number))) as (string | number)[],
  ];
  const visible = filterParamValuesForConfigView(def, allValues, "essentials");
  if (visible.length === 0) return current;

  const curKey = valueKeyForHide(asChip);
  if (visible.some((v) => valueKeyForHide(v) === curKey)) return current;

  // Prefer factory / row default if still visible
  const preferred = def.defaultValue ?? def.factoryDefault;
  if (preferred !== undefined && preferred !== null && preferred !== "") {
    const pChip: string | number =
      typeof preferred === "number" || typeof preferred === "string"
        ? preferred
        : String(preferred);
    if (visible.some((v) => valueKeyForHide(v) === valueKeyForHide(pChip))) {
      return preferred;
    }
  }
  return visible[0];
}

/**
 * Enforce essentials value curation on a launch value bag (UI + CLI agree).
 * Call only for Full Auto / Assisted Essentials — not Assisted Full.
 */
export function snapEssentialsHiddenInValues(
  values: Record<string, unknown>,
  allParams: UserEditedTemplateParam[],
): Record<string, unknown> {
  const byKey = new Map(allParams.map((p) => [p.key, p]));
  const out = { ...values };
  for (const [key, val] of Object.entries(out)) {
    const def = byKey.get(key);
    if (!def) continue;
    if (!def.essentialsHiddenValues?.length && !def.hiddenValues?.length) continue;
    const snapped = snapValueOutOfEssentialsHide(def, val);
    if (snapped !== val) out[key] = snapped;
  }
  return out;
}

function factoryParamToExportRow(fp: ProviderDefaultParam, order: number): UserEditedTemplateParam {
  return {
    key: fp.key,
    label: fp.label,
    values: [...fp.values],
    order,
    hidden: fp.hidden_default ?? false,
    userHidden: false,
    flag: fp.flag,
    flag_pair: fp.flag_pair,
    ptype: fp.ptype,
    step: fp.step,
    ui_group: fp.ui_group,
    note: fp.note ?? "",
    pattern: fp.pattern ?? "",
    sub_params: fp.sub_params,
    defaultValue: fp.default,
    factoryDefault: fp.default,
    dock: fp.dock ?? "",
  };
}

/**
 * Full param list for factory JSON export — every catalog param (including hidden),
 * plus factory blueprint rows not on disk (unless admin-excluded).
 * Skips topology-owned keys (device) — values come from GPU scan at runtime.
 */
export function buildParamsForFactoryExport(
  userParams: UserEditedTemplateParam[],
  factoryParams: ProviderDefaultParam[],
  excludedKeys?: string[],
): UserEditedTemplateParam[] {
  const excluded = new Set(excludedKeys ?? []);
  const isExportable = (key: string) =>
    !ENGINE_ONLY_PARAM_KEYS.has(key) && !excluded.has(key);

  const byKey = new Set(
    userParams.filter((p) => isExportable(p.key)).map((p) => p.key),
  );
  const out: UserEditedTemplateParam[] = userParams
    .filter((p) => isExportable(p.key))
    .map((p) => ({
      ...p,
      hidden: Boolean(p.hidden || p.userHidden),
    }));

  let maxOrder = out.reduce((max, p) => Math.max(max, p.order), 0);
  for (const fp of factoryParams) {
    if (byKey.has(fp.key) || !isExportable(fp.key)) continue;
    maxOrder += 1;
    out.push(factoryParamToExportRow(fp, maxOrder));
  }

  return out;
}

/**
 * Effective Essentials list for factory export — scroll-area params only (excludes
 * engine chrome / topology-owned keys). Order follows param `order`.
 */
export function computeEssentialParamKeysForExport(
  params: UserEditedTemplateParam[],
  factoryEssentialKeys: Set<string>,
): string[] {
  const sorted = [...params].sort((a, b) => a.order - b.order);
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const p of sorted) {
    if (p.hidden || !isCatalogVisibleParam(p) || isPlacementChromeParam(p)) continue;
    if (!isEssentialParam(p, factoryEssentialKeys)) continue;
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    keys.push(p.key);
  }
  return keys;
}

export function providerSupportsFitLaunch(profile?: SpawnProfile): boolean {
  return Boolean(profile?.auto_vram || profile?.fit_style);
}

/**
 * Keys emitted on MANUAL launch — essentials view filters; full passes all visible params.
 * Prefer `resolveLaunchKeySet` + LaunchPolicy for new code (see launchPolicy.ts).
 */
export function resolveManualLaunchKeys(opts: {
  configView: ConfigViewMode;
  essentialFactoryKeys: Set<string>;
  specActive: boolean;
  allParams: UserEditedTemplateParam[];
}): string[] {
  const chrome = [...PANEL_CHROME_PARAM_KEYS, ...LAUNCH_DOCK_PARAM_KEYS];
  const keys = new Set<string>(chrome);

  if (opts.configView === "full") {
    for (const p of opts.allParams) {
      if (!p.hidden && !skipSpecParamForLaunch(p, opts.specActive)) keys.add(p.key);
    }
  } else {
    for (const p of opts.allParams) {
      if (
        !p.hidden
        && isEssentialParam(p, opts.essentialFactoryKeys)
        && !skipSpecParamForLaunch(p, opts.specActive)
      ) {
        keys.add(p.key);
      }
    }
  }

  // Cockpit-owned knobs must always reach CLI when present on the template.
  const templateKeys = new Set(opts.allParams.map((p) => p.key));
  for (const k of COCKPIT_OWNED_PARAM_KEYS) {
    if (templateKeys.has(k)) keys.add(k);
  }

  if (opts.specActive) {
    for (const k of SPEC_DECODING_LAUNCH_KEYS) keys.add(k);
  }

  return [...keys];
}