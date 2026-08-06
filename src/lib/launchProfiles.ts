/**
 * Per-mode launch value profiles — storage shape + one-shot migration.
 *
 * Nested under the existing catalog-override key so one localStorage entry
 * holds all modes for a provider:
 *
 *   {
 *     version: 2,
 *     activePolicy: "full_auto" | "assisted_essentials" | "assisted_full",
 *     profiles: {
 *       full_auto: { ... },
 *       assisted_essentials: { ... },
 *       assisted_full: { ... }
 *     }
 *   }
 *
 * Migration from flat Record<key,value>:
 *   - assisted_essentials + assisted_full ← full legacy copy
 *   - full_auto ← seedFullAutoProfile(legacy, factory)  (no power residue)
 */

import {
  type LaunchPolicyId,
  isLaunchPolicyId,
  seedFullAutoProfile,
} from "./launchPolicy";
import {
  catalogOverrideKey,
  readJsonStorage,
  removeStorage,
  writeJsonStorage,
} from "./storage";

export const CATALOG_OVERRIDE_STORE_VERSION = 2 as const;

export type LaunchProfileMap = Record<string, unknown>;

export type CatalogOverrideStoreV2 = {
  version: typeof CATALOG_OVERRIDE_STORE_VERSION;
  activePolicy: LaunchPolicyId;
  profiles: Record<LaunchPolicyId, LaunchProfileMap>;
};

function emptyProfiles(): Record<LaunchPolicyId, LaunchProfileMap> {
  return {
    full_auto: {},
    assisted_essentials: {},
    assisted_full: {},
  };
}

export function isCatalogOverrideStoreV2(raw: unknown): raw is CatalogOverrideStoreV2 {
  if (!raw || typeof raw !== "object") return false;
  const o = raw as Record<string, unknown>;
  if (o.version !== CATALOG_OVERRIDE_STORE_VERSION) return false;
  if (!isLaunchPolicyId(o.activePolicy)) return false;
  if (!o.profiles || typeof o.profiles !== "object") return false;
  return true;
}

/** Flat v1 bag: plain object with no version field (or version !== 2). */
export function isFlatCatalogOverride(raw: unknown): raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  if (isCatalogOverrideStoreV2(raw)) return false;
  // Reject accidental nested half-migrates without version
  const o = raw as Record<string, unknown>;
  if ("profiles" in o && typeof o.profiles === "object") return false;
  return true;
}

export type MigrateCatalogOverrideInput = {
  raw: unknown;
  factoryDefaults: Record<string, unknown>;
  /** Preferred active policy after migrate (from FIT + configView). */
  preferredActive?: LaunchPolicyId;
};

/**
 * Normalize any on-disk shape to v2.
 * Pure — does not touch localStorage.
 */
export function migrateCatalogOverrideStore(
  input: MigrateCatalogOverrideInput,
): CatalogOverrideStoreV2 {
  const preferred = input.preferredActive ?? "full_auto";

  if (isCatalogOverrideStoreV2(input.raw)) {
    // Ensure all profile keys exist
    const profiles = emptyProfiles();
    for (const id of Object.keys(profiles) as LaunchPolicyId[]) {
      const p = input.raw.profiles[id];
      profiles[id] = p && typeof p === "object" && !Array.isArray(p) ? { ...p } : {};
    }
    return {
      version: CATALOG_OVERRIDE_STORE_VERSION,
      activePolicy: isLaunchPolicyId(input.raw.activePolicy)
        ? input.raw.activePolicy
        : preferred,
      profiles,
    };
  }

  const legacy: Record<string, unknown> =
    isFlatCatalogOverride(input.raw) ? { ...input.raw } : {};

  const fullAuto = seedFullAutoProfile({
    legacyValues: legacy,
    factoryDefaults: input.factoryDefaults,
  });

  return {
    version: CATALOG_OVERRIDE_STORE_VERSION,
    activePolicy: preferred,
    profiles: {
      full_auto: fullAuto,
      assisted_essentials: { ...legacy },
      assisted_full: { ...legacy },
    },
  };
}

// ── localStorage I/O ────────────────────────────────────────────────────────

export function readCatalogOverrideStore(
  providerId: string,
  factoryDefaults: Record<string, unknown>,
  preferredActive?: LaunchPolicyId,
): CatalogOverrideStoreV2 {
  const key = catalogOverrideKey(providerId);
  const raw = readJsonStorage<unknown>(key);
  const store = migrateCatalogOverrideStore({
    raw,
    factoryDefaults,
    preferredActive,
  });
  // Persist migration once so we never re-seed full_auto from a flat bag
  if (!isCatalogOverrideStoreV2(raw)) {
    writeJsonStorage(key, store);
  }
  return store;
}

export function writeCatalogOverrideStore(
  providerId: string,
  store: CatalogOverrideStoreV2,
): void {
  writeJsonStorage(catalogOverrideKey(providerId), store);
}

export function readProfileValues(
  providerId: string,
  policyId: LaunchPolicyId,
  factoryDefaults: Record<string, unknown>,
): LaunchProfileMap {
  const store = readCatalogOverrideStore(providerId, factoryDefaults, policyId);
  return { ...store.profiles[policyId] };
}

export function writeProfileValues(
  providerId: string,
  policyId: LaunchPolicyId,
  values: LaunchProfileMap,
  factoryDefaults: Record<string, unknown> = {},
): void {
  const store = readCatalogOverrideStore(providerId, factoryDefaults, policyId);
  store.profiles[policyId] = { ...values };
  store.activePolicy = policyId;
  writeCatalogOverrideStore(providerId, store);
}

/** Patch keys into one profile (durable). */
export function patchProfileValues(
  providerId: string,
  policyId: LaunchPolicyId,
  patch: Record<string, unknown>,
  factoryDefaults: Record<string, unknown> = {},
): LaunchProfileMap {
  const store = readCatalogOverrideStore(providerId, factoryDefaults, policyId);
  const next = { ...store.profiles[policyId], ...patch };
  store.profiles[policyId] = next;
  store.activePolicy = policyId;
  writeCatalogOverrideStore(providerId, store);
  return next;
}

/**
 * Switch active policy: keep other profiles intact, return the target profile values.
 * Does not copy values between modes (no silent import).
 */
export function switchActivePolicy(
  providerId: string,
  nextPolicy: LaunchPolicyId,
  factoryDefaults: Record<string, unknown>,
  /** Current in-memory config to flush into the *previous* active profile first. */
  flushCurrent?: { policyId: LaunchPolicyId; values: Record<string, unknown> },
): { store: CatalogOverrideStoreV2; profileValues: LaunchProfileMap } {
  const store = readCatalogOverrideStore(providerId, factoryDefaults, nextPolicy);
  if (flushCurrent) {
    store.profiles[flushCurrent.policyId] = { ...flushCurrent.values };
  }
  store.activePolicy = nextPolicy;
  writeCatalogOverrideStore(providerId, store);
  return {
    store,
    profileValues: { ...store.profiles[nextPolicy] },
  };
}

export function clearAllProfiles(providerId: string): void {
  removeStorage(catalogOverrideKey(providerId));
}

/**
 * Config editor / Intel: read a flat-ish view for display.
 * Prefer active profile; fall back to assisted_full then merge.
 */
export function readActiveProfileFlat(
  providerId: string,
  factoryDefaults: Record<string, unknown> = {},
): Record<string, unknown> {
  const store = readCatalogOverrideStore(providerId, factoryDefaults);
  return { ...store.profiles[store.activePolicy] };
}

/**
 * Config editor writes a default — update assisted profiles (and cockpit keys on full_auto).
 * Power defaults must not silently redefine Joe non-cockpit keys.
 */
export function writeConfigEditorDefault(
  providerId: string,
  key: string,
  value: unknown,
  opts?: { isCockpitOwned?: boolean },
): void {
  const store = readCatalogOverrideStore(providerId, {});
  store.profiles.assisted_essentials = {
    ...store.profiles.assisted_essentials,
    [key]: value,
  };
  store.profiles.assisted_full = {
    ...store.profiles.assisted_full,
    [key]: value,
  };
  if (opts?.isCockpitOwned) {
    store.profiles.full_auto = {
      ...store.profiles.full_auto,
      [key]: value,
    };
  }
  writeCatalogOverrideStore(providerId, store);
}

export function removeConfigEditorDefault(
  providerId: string,
  key: string,
): void {
  const store = readCatalogOverrideStore(providerId, {});
  for (const id of Object.keys(store.profiles) as LaunchPolicyId[]) {
    if (key in store.profiles[id]) {
      const next = { ...store.profiles[id] };
      delete next[key];
      store.profiles[id] = next;
    }
  }
  writeCatalogOverrideStore(providerId, store);
}
