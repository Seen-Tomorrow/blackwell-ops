// Merges param defaults with localStorage overrides.

import { useState, useCallback, useEffect, useMemo } from "react";
import type { ModelEntry, UserEditedTemplateParam } from "../lib/types";
import { paramsVisibilityFingerprint, resolveParamDefaultValue } from "../lib/paramConfigResolve";
import {
  isSpecProfileParamKey,
  isObsoleteSpecParamKey,
  SPEC_PROFILE_PARAM_KEYS,
  stripObsoleteSpecParams,
} from "../lib/specProfiles";
import {
  catalogOverrideKey,
  modelSpecOverrideKey,
  readJsonStorage,
  removeStorage,
  writeJsonStorage,
  type ModelSpecOverride,
} from "../lib/storage";
import { EVENTS } from "../lib/events";

// Preserve mixed-case values like "8K", "GPU-0"; lowercase pure-alpha strings.
const normalizeValue = (value: any): any => {
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
}

export function useConfigResolver({
  model,
  userEditedParams,
  backendType,
}: UseConfigResolverOptions) {
  const [config, setConfig] = useState<Record<string, any>>({});
  const modelPath = model?.path ?? "";

  const cleanedParams = useMemo(
    () => stripObsoleteSpecParams(userEditedParams),
    [userEditedParams],
  );

  const paramsFingerprint = useMemo(
    () => paramsVisibilityFingerprint(cleanedParams),
    [cleanedParams],
  );

  const loadConfig = useCallback(() => {
    if (!cleanedParams.length) {
      setConfig({});
      return;
    }

    const stored = readJsonStorage<Record<string, unknown>>(catalogOverrideKey(backendType)) ?? {};
    const modelSpec = modelPath ? readJsonStorage<ModelSpecOverride>(modelSpecOverrideKey(modelPath)) : null;
    const resolved: Record<string, any> = {};

    for (const p of cleanedParams) {
      const isSpecKey = SPEC_KEY_SET.has(p.key);
      // Profile knobs: always load defaults even when group hidden (Boost paints from them).
      if (isSpecKey) {
        const modelVal = modelSpec?.[p.key as keyof ModelSpecOverride];
        const fallback = resolveParamDefaultValue(p);
        resolved[p.key] = modelVal ?? stored[p.key] ?? fallback;
        continue;
      }
      if (p.hidden || !p.values?.length) continue;
      const fallback = resolveParamDefaultValue(p);
      resolved[p.key] = stored[p.key] ?? fallback;
    }

    const normalized = Object.fromEntries(
      Object.entries(resolved).map(([k, v]) => [k, normalizeValue(v)]),
    );

    setConfig(normalized);
  }, [cleanedParams, backendType, modelPath]);

  useEffect(() => {
    loadConfig();
  }, [modelPath, paramsFingerprint, backendType, loadConfig]);

  useEffect(() => {
    const handler = () => loadConfig();
    window.addEventListener(EVENTS.paramConfigChanged, handler);
    return () => window.removeEventListener(EVENTS.paramConfigChanged, handler);
  }, [loadConfig]);

  const updateParam = useCallback(
    (key: string, value: any) => {
      if (isObsoleteSpecParamKey(key)) return;
      const normalizedValue = normalizeValue(value);
      setConfig((prev) => ({ ...prev, [key]: normalizedValue }));

      if (modelPath && SPEC_KEY_SET.has(key)) {
        const prev = readJsonStorage<ModelSpecOverride>(modelSpecOverrideKey(modelPath)) ?? {};
        writeJsonStorage(modelSpecOverrideKey(modelPath), { ...prev, [key]: normalizedValue });
        return;
      }

      const storageKey = catalogOverrideKey(backendType);
      const overrides = readJsonStorage<Record<string, unknown>>(storageKey) ?? {};
      overrides[key] = normalizedValue;
      writeJsonStorage(storageKey, overrides);
    },
    [backendType, modelPath],
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
        const storageKey = catalogOverrideKey(backendType);
        const overrides = readJsonStorage<Record<string, unknown>>(storageKey) ?? {};
        writeJsonStorage(storageKey, { ...overrides, ...catalogPatch });
      }
    },
    [backendType, modelPath],
  );

  const clearOverrides = useCallback(() => {
    removeStorage(catalogOverrideKey(backendType));
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
    /** Params with obsolete SPECULATIVE-DECODING rows removed. */
    resolvedParams: cleanedParams,
  };
}
