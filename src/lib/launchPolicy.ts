/**
 * Launch modes — pure policy tables (no React, no storage I/O).
 *
 * Product:
 *   full_auto            — Joe; cockpit + FIT; no Assisted power residue on CLI
 *   assisted_essentials  — medium; cockpit + essentials chips
 *   assisted_full        — power; full matrix; never Smart batch push
 *
 * Values live in per-mode profiles (see launchProfiles.ts).
 * This module only defines *rules* for key sets, topology, batch, and Joe defaults.
 */

import type { ConfigViewMode, UserEditedTemplateParam } from "./types";
import { PANEL_CHROME_PARAM_KEYS } from "./paramDisplayZone";
import {
  COCKPIT_OWNED_PARAM_KEYS,
  isCockpitOwnedParam,
} from "./systemParams";
import {
  isEssentialParam,
  LAUNCH_DOCK_PARAM_KEYS,
  SPEC_DECODING_LAUNCH_KEYS,
} from "./launchProfile";
import { isModelSpecParamKey, SPEC_DECODING_UI_GROUP } from "./specDraft";
import { paramUiGroup } from "./storage";

// ── Policy identity ─────────────────────────────────────────────────────────

export type LaunchPolicyId = "full_auto" | "assisted_essentials" | "assisted_full";

export type LaunchKeySetId = "cockpit_plus_essentials" | "essentials" | "full";

export type LaunchTopologyOwner = "fit_owned" | "user_chrome";

/**
 * Where batch/ubatch values come from at launch:
 * - smart_push — Joe Smart may inject high batch for this launch only (ephemeral)
 * - profile    — use profile values as-is
 * - factory    — prefer factory defaults over profile residue
 */
export type LaunchBatchSource = "smart_push" | "profile" | "factory";

export type LaunchPolicy = Readonly<{
  id: LaunchPolicyId;
  keySet: LaunchKeySetId;
  /** Full Auto always wants FIT topology path when provider supports it. */
  fitImplied: boolean;
  topology: LaunchTopologyOwner;
  batch: LaunchBatchSource;
  /**
   * Applied when a profile key is missing (seed + launch merge).
   * Never steals from another mode's profile.
   */
  fallbackDefaults: Readonly<Record<string, string | number>>;
  /** resolveFullAutoPlan powerUser — no Smart invent / no silent batch. */
  powerUser: boolean;
  /** Default Boost when no product speed selected. */
  defaultSpeed: "smart" | "off";
  /** Show chip matrix under cockpit. */
  showParamMatrix: boolean;
  /** Essentials vs full filter for chip matrix (when shown). */
  matrixView: ConfigViewMode | "none";
}>;

// ── Product locks (decision log) ────────────────────────────────────────────

/**
 * Full Auto non-cockpit / flag defaults (Joe).
 * Cockpit live UI still owns parallel / kv_quant / reasoning / ctx when set.
 *
 * Decisions (2026-08-05):
 * - load_mode: mmap (mlock is power-user)
 * - vision: off (multi-GB mmproj needs header consent)
 * - flash_attn: on (usually beneficial)
 * - reasoning_preserve: off (FEATURE-FLAGS free chip; keep quiet for Joe)
 * - Smart batch: ephemeral at launch only (never persist from Smart)
 * - Full Auto non-cockpit: factory + these fallbacks; not Assisted residue
 */
export const JOE_FULL_AUTO_DEFAULTS: Readonly<Record<string, string | number>> = Object.freeze({
  load_mode: "mmap",
  vision: "off",
  flash_attn: "on",
  reasoning_preserve: "off",
  offload_mode: "regular",
});

/** Topology keys FIT owns in Full Auto — never from Assisted chrome. */
export const FIT_OWNED_TOPOLOGY_KEYS = Object.freeze(["device", "split", "offload_mode"] as const);

export const LAUNCH_POLICIES: Readonly<Record<LaunchPolicyId, LaunchPolicy>> = Object.freeze({
  full_auto: Object.freeze({
    id: "full_auto",
    keySet: "cockpit_plus_essentials" as const,
    fitImplied: true,
    topology: "fit_owned" as const,
    batch: "smart_push" as const,
    fallbackDefaults: JOE_FULL_AUTO_DEFAULTS,
    powerUser: false,
    defaultSpeed: "smart" as const,
    showParamMatrix: false,
    matrixView: "none" as const,
  }),
  assisted_essentials: Object.freeze({
    id: "assisted_essentials",
    keySet: "essentials" as const,
    fitImplied: false,
    topology: "user_chrome" as const,
    batch: "profile" as const,
    fallbackDefaults: Object.freeze({} as Record<string, string | number>),
    powerUser: false,
    defaultSpeed: "smart" as const,
    showParamMatrix: true,
    matrixView: "essentials" as const,
  }),
  assisted_full: Object.freeze({
    id: "assisted_full",
    keySet: "full" as const,
    fitImplied: false,
    topology: "user_chrome" as const,
    batch: "profile" as const,
    fallbackDefaults: Object.freeze({} as Record<string, string | number>),
    powerUser: true,
    defaultSpeed: "off" as const,
    showParamMatrix: true,
    matrixView: "full" as const,
  }),
});

export function getLaunchPolicy(id: LaunchPolicyId): LaunchPolicy {
  return LAUNCH_POLICIES[id];
}

/** Map current UI toggles → policy id (single derivation point). */
export function resolveLaunchPolicyId(opts: {
  fullAutoMode: boolean;
  configView: ConfigViewMode;
}): LaunchPolicyId {
  if (opts.fullAutoMode) return "full_auto";
  return opts.configView === "full" ? "assisted_full" : "assisted_essentials";
}

export function isLaunchPolicyId(value: unknown): value is LaunchPolicyId {
  return value === "full_auto" || value === "assisted_essentials" || value === "assisted_full";
}

// ── Key set resolution ──────────────────────────────────────────────────────

function skipSpecParamForLaunch(p: UserEditedTemplateParam): boolean {
  const g = paramUiGroup(p.ui_group);
  if (g === "SPECULATIVE-MTP" || g === "SPECULATIVE-DFLASH") return true;
  if (g === SPEC_DECODING_UI_GROUP || isModelSpecParamKey(p.key)) return true;
  return false;
}

export type ResolveLaunchKeySetInput = {
  policy: LaunchPolicy;
  essentialFactoryKeys: Set<string>;
  specActive: boolean;
  allParams: UserEditedTemplateParam[];
};

/**
 * Keys allowed on CLI for this policy.
 * Always includes cockpit-owned keys present on the template + dock chrome.
 * Spec profile rows never emit raw mtp_/dflash_ keys — only flattened SPEC_DECODING_LAUNCH_KEYS.
 */
export function resolveLaunchKeySet(input: ResolveLaunchKeySetInput): string[] {
  const { policy, essentialFactoryKeys, specActive, allParams } = input;
  const chrome = [...PANEL_CHROME_PARAM_KEYS, ...LAUNCH_DOCK_PARAM_KEYS];
  const keys = new Set<string>(chrome);
  const templateKeys = new Set(allParams.map((p) => p.key));

  if (policy.keySet === "full") {
    for (const p of allParams) {
      if (!p.hidden && !skipSpecParamForLaunch(p)) keys.add(p.key);
    }
  } else {
    // essentials | cockpit_plus_essentials — essentials matrix + always cockpit
    for (const p of allParams) {
      if (
        !p.hidden
        && isEssentialParam(p, essentialFactoryKeys)
        && !skipSpecParamForLaunch(p)
      ) {
        keys.add(p.key);
      }
    }
  }

  for (const k of COCKPIT_OWNED_PARAM_KEYS) {
    if (templateKeys.has(k)) keys.add(k);
  }

  if (specActive) {
    for (const k of SPEC_DECODING_LAUNCH_KEYS) keys.add(k);
  }

  // Full Auto: topology is FIT-owned — still list split for multi-GPU builder path,
  // but device/split/offload values come from FIT merge, not Assisted chrome.
  return [...keys];
}

// ── Value merge for launch ──────────────────────────────────────────────────

export type FactoryDefaultsMap = Readonly<Record<string, unknown>>;

/**
 * Build the value bag used for CLI emission.
 *
 * Order (later wins only within allowed layers):
 * 1. factory defaults (template)
 * 2. policy.fallbackDefaults (Joe table for Full Auto)
 * 3. profileValues (mode-specific durable store)
 * 4. cockpitLive overlay (current cockpit UI — cockpit-owned keys only)
 *
 * Does NOT read another mode's profile.
 */
export function mergeLaunchValues(input: {
  policy: LaunchPolicy;
  factoryDefaults: FactoryDefaultsMap;
  profileValues: Record<string, unknown>;
  /** Live cockpit UI; only cockpit-owned keys are applied. */
  cockpitLive?: Record<string, unknown>;
}): Record<string, unknown> {
  const { policy, factoryDefaults, profileValues, cockpitLive } = input;
  const out: Record<string, unknown> = { ...factoryDefaults };

  for (const [k, v] of Object.entries(policy.fallbackDefaults)) {
    if (v !== undefined) out[k] = v;
  }

  for (const [k, v] of Object.entries(profileValues)) {
    if (v !== undefined) out[k] = v;
  }

  if (cockpitLive) {
    for (const [k, v] of Object.entries(cockpitLive)) {
      if (!isCockpitOwnedParam(k)) continue;
      if (v !== undefined) out[k] = v;
    }
  }

  // Full Auto: force FIT topology markers (values may be overwritten by FIT builder)
  if (policy.topology === "fit_owned") {
    out.offload_mode = "regular";
  }

  return out;
}

/**
 * Cockpit keys safe to carry from Assisted → Full Auto seed.
 * Flag keys in JOE_FULL_AUTO_DEFAULTS (load_mode, vision, …) stay at Joe defaults
 * so Assisted mlock/auto-vision never becomes Joe residue (§8 case 1).
 */
const FULL_AUTO_SEED_COCKPIT_KEYS = new Set([
  "parallel",
  "kv_quant",
  "reasoning",
  "ctx",
]);

/**
 * Seed a Full Auto profile from a legacy single-map bag.
 * Carries Agents/Memory/Think/CTX from legacy; resets flags + non-cockpit to factory + Joe.
 * Prevents Assisted power residue (mlock, exotic temp, huge batch) from living in Joe's bag.
 */
export function seedFullAutoProfile(input: {
  legacyValues: Record<string, unknown>;
  factoryDefaults: FactoryDefaultsMap;
}): Record<string, unknown> {
  const { legacyValues, factoryDefaults } = input;
  const out: Record<string, unknown> = { ...factoryDefaults, ...JOE_FULL_AUTO_DEFAULTS };

  for (const k of FULL_AUTO_SEED_COCKPIT_KEYS) {
    if (k in legacyValues && legacyValues[k] !== undefined) {
      out[k] = legacyValues[k];
    }
  }

  // Never seed Full Auto with Assisted topology chrome
  out.offload_mode = "regular";
  delete out.device;
  delete out.split;

  return out;
}

/**
 * Smart batch picks (ephemeral). Pure — caller injects into launch values only.
 * Returns null fields when no high numeric available.
 */
export function resolveSmartBatchPush(input: {
  policy: LaunchPolicy;
  /** True when Boost=Smart and plan.pushBatch */
  pushBatch: boolean;
  batchValues: (string | number)[] | undefined;
  ubatchValues: (string | number)[] | undefined;
  pickHigh: (values: (string | number)[], maxHint?: number) => number | null;
}): { batch?: number; ubatch?: number } {
  if (input.policy.batch !== "smart_push" || !input.pushBatch) return {};
  const batch = input.batchValues ? input.pickHigh(input.batchValues) : null;
  const ubatch = input.ubatchValues
    ? input.pickHigh(input.ubatchValues, batch ?? undefined)
    : null;
  const out: { batch?: number; ubatch?: number } = {};
  if (batch != null) out.batch = batch;
  if (ubatch != null) out.ubatch = ubatch;
  return out;
}

/** Filter a value map down to keys allowed by the policy key set. */
export function filterValuesToKeySet(
  values: Record<string, unknown>,
  allowedKeys: ReadonlySet<string> | readonly string[],
): Record<string, unknown> {
  const allow = allowedKeys instanceof Set ? allowedKeys : new Set(allowedKeys);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (allow.has(k) && v !== undefined) out[k] = v;
  }
  return out;
}

/** UI helper: configView for chip matrix / value filtering from policy. */
export function configViewForPolicy(policy: LaunchPolicy): ConfigViewMode {
  if (policy.matrixView === "full") return "full";
  return "essentials";
}

/** True when FIT toggle maps to Full Auto (product: FIT ON = Joe). */
export function isFullAutoPolicy(id: LaunchPolicyId): boolean {
  return id === "full_auto";
}
