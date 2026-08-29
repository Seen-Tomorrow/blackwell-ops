/**
 * Merges param factory defaults with per-mode profile overrides.
 *
 * Full Auto / Assisted Essentials / Assisted Full each have their own value map
 * (see launchProfiles). Switching modes loads another profile — no silent leakage.
 */

import { useState, useCallback, useEffect, useMemo, useRef, type MutableRefObject } from "react";
import type { ModelEntry, UserEditedTemplateParam } from "../lib/types";
import { paramsVisibilityFingerprint, resolveParamDefaultValue } from "../lib/paramConfigResolve";
import {
  isSpecProfileParamKey,
  isObsoleteSpecParamKey,
  SPEC_PROFILE_PARAM_KEYS,
  stripObsoleteSpecParams,
} from "../lib/specProfiles";
import {
  modelSpecOverrideKey,
  readJsonStorage,
  removeStorage,
  writeJsonStorage,
  type ModelSpecOverride,
} from "../lib/storage";
import { EVENTS } from "../lib/events";
import {
  type LaunchPolicyId,
  resolveLaunchPolicyId,
  getLaunchPolicy,
  mergeLaunchValues,
} from "../lib/launchPolicy";
import { factoryDefaultsFromParams } from "../lib/buildLaunchConfig";
import {
  clearAllProfiles,
  patchProfileValues,
  readCatalogOverrideStore,
  switchActivePolicy,
  writeCatalogOverrideStore,
} from "../lib/launchProfiles";
import type { ConfigViewMode } from "../lib/types";

// Preserve mixed-case values like "8K", "GPU-0"; lowercase pure-alpha strings.
const normalizeValue = (value: unknown): unknown => {
  if (typeof value !== "string") return value;

  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);

  if (hasLower && hasUpper) return value;
  if (/^\d+[KMGT]$/i.test(value)) return value;
  if (/^GPU-\d+$/i.test(value)) return value;

  return value.toLowerCase();
};

const SPEC_KEY_SET = new Set<string>(SPEC_PROFILE_PARAM_KEYS);

interface UseConfigResolverOptions {
  model: ModelEntry | null;
  userEditedParams: UserEditedTemplateParam[];
  backendType: string;
  /** Active launch policy — drives which profile is read/written. */
  fullAutoMode: boolean;
  configView: ConfigViewMode;
  /**
   * When true, loadConfig is a no-op so FIT probe / param fingerprint
   * reloads cannot revert knobs during catalog seat-edit.
   */
  hydrateLockRef?: MutableRefObject<boolean>;
}

export function useConfigResolver({
  model,
  userEditedParams,
  backendType,
  fullAutoMode,
  configView,
  hydrateLockRef,
}: UseConfigResolverOptions) {
  // Heterogeneous param bag — panel treats values as any; pure builder re-types at launch.
  const [config, setConfig] = useState<Record<string, any>>({});
  const modelPath = model?.path ?? "";

  const policyId = useMemo(
    () => resolveLaunchPolicyId({ fullAutoMode, configView }),
    [fullAutoMode, configView],
  );

  const policyIdRef = useRef(policyId);
  policyIdRef.current = policyId;

  const cleanedParams = useMemo(
    () => stripObsoleteSpecParams(userEditedParams),
    [userEditedParams],
  );

  const paramsFingerprint = useMemo(
    () => paramsVisibilityFingerprint(cleanedParams),
    [cleanedParams],
  );

  const factoryDefaults = useMemo(
    () => factoryDefaultsFromParams(cleanedParams),
    [cleanedParams],
  );

  const loadConfig = useCallback(() => {
    if (hydrateLockRef?.current) return;
    if (!cleanedParams.length) {
      setConfig({});
      return;
    }

    const store = readCatalogOverrideStore(backendType, factoryDefaults, policyId);
    // Keep activePolicy in sync with UI mode
    if (store.activePolicy !== policyId) {
      store.activePolicy = policyId;
      writeCatalogOverrideStore(backendType, store);
    }

    const profile = store.profiles[policyId] ?? {};
    const modelSpec = modelPath
      ? readJsonStorage<ModelSpecOverride>(modelSpecOverrideKey(modelPath))
      : null;

    const policy = getLaunchPolicy(policyId);
    const baseMerged = mergeLaunchValues({
      policy,
      factoryDefaults,
      profileValues: profile,
    });

    const resolved: Record<string, any> = {};

    for (const p of cleanedParams) {
      const isSpecKey = SPEC_KEY_SET.has(p.key);
      if (isSpecKey) {
        const modelVal = modelSpec?.[p.key as keyof ModelSpecOverride];
        const fallback = resolveParamDefaultValue(p);
        resolved[p.key] = modelVal ?? profile[p.key] ?? fallback;
        continue;
      }
      if (p.hidden || !p.values?.length) continue;
      resolved[p.key] = baseMerged[p.key] ?? resolveParamDefaultValue(p);
    }

    const normalized: Record<string, any> = Object.fromEntries(
      Object.entries(resolved).map(([k, v]) => [k, normalizeValue(v)]),
    );

    setConfig(normalized);
  }, [cleanedParams, backendType, modelPath, policyId, factoryDefaults, hydrateLockRef]);

  // Load when model / params / provider change
  useEffect(() => {
    loadConfig();
  }, [modelPath, paramsFingerprint, backendType, loadConfig]);

  // Mode switch: only change activePolicy + reload. Do NOT flush the full resolved
  // config bag into the profile — that materializes factory defaults as "overrides"
  // and freezes them forever. updateParam/updateParams already patch sparsely.
  const prevPolicyRef = useRef<LaunchPolicyId | null>(null);
  const prevBackendRef = useRef(backendType);
  useEffect(() => {
    if (prevBackendRef.current !== backendType) {
      prevBackendRef.current = backendType;
      prevPolicyRef.current = policyId;
      return;
    }
    if (prevPolicyRef.current === null) {
      prevPolicyRef.current = policyId;
      return;
    }
    if (prevPolicyRef.current === policyId) return;

    prevPolicyRef.current = policyId;
    switchActivePolicy(backendType, policyId, factoryDefaults);
    loadConfig();
  }, [policyId, backendType, factoryDefaults, loadConfig]);

  useEffect(() => {
    const handler = () => loadConfig();
    window.addEventListener(EVENTS.paramConfigChanged, handler);
    return () => window.removeEventListener(EVENTS.paramConfigChanged, handler);
  }, [loadConfig]);

  const updateParam = useCallback(
    (key: string, value: unknown) => {
      if (isObsoleteSpecParamKey(key)) return;
      const normalizedValue = normalizeValue(value);
      setConfig((prev) => ({ ...prev, [key]: normalizedValue }));

      if (modelPath && SPEC_KEY_SET.has(key)) {
        const prev = readJsonStorage<ModelSpecOverride>(modelSpecOverrideKey(modelPath)) ?? {};
        writeJsonStorage(modelSpecOverrideKey(modelPath), { ...prev, [key]: normalizedValue });
        return;
      }

      patchProfileValues(
        backendType,
        policyIdRef.current,
        { [key]: normalizedValue },
        factoryDefaults,
      );
    },
    [backendType, modelPath, factoryDefaults],
  );

  const updateParams = useCallback(
    (patch: Record<string, unknown>) => {
      const normalized: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(patch)) {
        if (isObsoleteSpecParamKey(k)) continue;
        normalized[k] = normalizeValue(v);
      }
      setConfig((prev) => ({ ...prev, ...normalized }));

      const modelPatch: Record<string, unknown> = {};
      const catalogPatch: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(normalized)) {
        if (SPEC_KEY_SET.has(k)) modelPatch[k] = v;
        else catalogPatch[k] = v;
      }
      if (modelPath && Object.keys(modelPatch).length > 0) {
        const prev = readJsonStorage<ModelSpecOverride>(modelSpecOverrideKey(modelPath)) ?? {};
        writeJsonStorage(modelSpecOverrideKey(modelPath), { ...prev, ...modelPatch });
      }
      if (Object.keys(catalogPatch).length > 0) {
        patchProfileValues(backendType, policyIdRef.current, catalogPatch, factoryDefaults);
      }
    },
    [backendType, modelPath, factoryDefaults],
  );

  const clearOverrides = useCallback(() => {
    clearAllProfiles(backendType);
    if (modelPath) removeStorage(modelSpecOverrideKey(modelPath));
    loadConfig();
  }, [backendType, modelPath, loadConfig]);

  const clearSpecConfig = useCallback(() => {
    if (modelPath) {
      const prev = readJsonStorage<Record<string, unknown>>(modelSpecOverrideKey(modelPath)) ?? {};
      let changed = false;
      for (const k of SPEC_PROFILE_PARAM_KEYS) {
        if (k in prev) {
          delete prev[k];
          changed = true;
        }
      }
      if (changed) {
        if (Object.keys(prev).length) writeJsonStorage(modelSpecOverrideKey(modelPath), prev);
        else removeStorage(modelSpecOverrideKey(modelPath));
      }
    }
    setConfig((prev) => {
      const next = { ...prev };
      for (const k of SPEC_PROFILE_PARAM_KEYS) delete next[k];
      return next;
    });
  }, [modelPath]);

  return {
    config,
    updateParam,
    updateParams,
    clearOverrides,
    clearSpecConfig,
    /** Active launch policy id for this resolver. */
    policyId,
    /** Params with obsolete SPECULATIVE-DECODING rows removed. */
    resolvedParams: cleanedParams,
  };
}

// Re-export for callers that want factory defaults without importing buildLaunchConfig
export { factoryDefaultsFromParams };
