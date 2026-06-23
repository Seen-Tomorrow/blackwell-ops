import type { ConfigViewMode, LaunchProfile, UserEditedTemplateParam } from "./types";
import { PANEL_CHROME_PARAM_KEYS } from "./paramDisplayZone";
import { isCatalogVisibleParam, isSystemCatalogParam } from "./systemParams";

/** Dock / launch chrome — always shown in essentials (alias uses separate row). */
export const LAUNCH_DOCK_PARAM_KEYS = ["base_port"] as const;

export const SPEC_DECODING_LAUNCH_KEYS = [
  "spec_type",
  "spec_draft_n_max",
  "spec_draft_n_min",
] as const;

const DEFAULT_ESSENTIAL_KEYS = ["device", "ctx"] as const;

/** Factory FIT whitelist (param keys only — split handled separately for multi-GPU). */
export function resolveFitLaunchKeys(profile?: LaunchProfile): string[] {
  const raw = profile?.fitLaunchKeys ?? profile?.simpleParamKeys ?? [...DEFAULT_ESSENTIAL_KEYS];
  return raw.filter((k) => k !== "split");
}

/** AUTO FIT launch + panel filter keys (split included when multi-GPU). */
export function resolveFitLaunchExtraKeys(opts: {
  profile?: LaunchProfile;
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
export function resolveEssentialParamKeys(profile?: LaunchProfile): Set<string> {
  const raw = profile?.essentialParamKeys ?? profile?.simpleParamKeys ?? [...DEFAULT_ESSENTIAL_KEYS];
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
    if (p.hidden || !isCatalogVisibleParam(p) || isSystemCatalogParam(p)) continue;
    if (!isEssentialParam(p, factoryEssentialKeys)) continue;
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    keys.push(p.key);
  }
  return keys;
}

export function providerSupportsFitLaunch(profile?: LaunchProfile): boolean {
  return Boolean(profile?.autoVram || profile?.fitStyle);
}

/** Keys emitted on MANUAL launch — essentials view filters; full passes all visible params. */
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
      if (!p.hidden) keys.add(p.key);
    }
  } else {
    for (const p of opts.allParams) {
      if (!p.hidden && isEssentialParam(p, opts.essentialFactoryKeys)) {
        keys.add(p.key);
      }
    }
  }

  if (opts.specActive) {
    for (const k of SPEC_DECODING_LAUNCH_KEYS) keys.add(k);
  }

  return [...keys];
}