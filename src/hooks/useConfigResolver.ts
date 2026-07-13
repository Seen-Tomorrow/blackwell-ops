// Merges param defaults with localStorage overrides.

import { useState, useCallback, useEffect, useMemo } from "react";
import type { ModelEntry, UserEditedTemplateParam } from "../lib/types";
import { paramsVisibilityFingerprint, resolveParamDefaultValue } from "../lib/paramConfigResolve";
import { MODEL_SPEC_PARAM_KEYS } from "../lib/specDraft";
import { loadModelSpecOverride, saveModelSpecOverride } from "../lib/specDraft";
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

const SPEC_KEY_SET = new Set<string>(MODEL_SPEC_PARAM_KEYS);

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
  const paramsFingerprint = useMemo(
    () => paramsVisibilityFingerprint(userEditedParams),
    [userEditedParams],
  );

  const loadConfig = useCallback(() => {
    if (!userEditedParams.length) {
      setConfig({});
      return;
    }

    const stored = readJsonStorage<Record<string, unknown>>(catalogOverrideKey(backendType)) ?? {};
    const modelSpec = modelPath ? loadModelSpecOverride(modelPath) : null;
    const resolved: Record<string, any> = {};

    // Only visible params enter active config — hidden group params stay omitted from CLI path.
    for (const p of userEditedParams) {
      const isSpecKey = SPEC_KEY_SET.has(p.key);
      const internalSpec = p.key === "spec_draft_model";
      if (!internalSpec && (p.hidden || !p.values?.length)) continue;
      if (internalSpec && p.hidden) {
        const modelVal = modelSpec?.[p.key as keyof ModelSpecOverride];
        if (modelVal !== undefined) resolved[p.key] = modelVal;
        continue;
      }
      const fallback = resolveParamDefaultValue(p);
      const modelVal =
        modelSpec && isSpecKey
          ? (modelSpec as Record<string, unknown>)[p.key]
          : undefined;
      resolved[p.key] = modelVal ?? stored[p.key] ?? fallback;
    }

    const normalized = Object.fromEntries(
      Object.entries(resolved).map(([k, v]) => [k, normalizeValue(v)]),
    );

    setConfig(normalized);
  }, [userEditedParams, backendType, modelPath]);

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
      const normalizedValue = normalizeValue(value);
      setConfig((prev) => ({ ...prev, [key]: normalizedValue }));

      if (modelPath && SPEC_KEY_SET.has(key)) {
        saveModelSpecOverride(modelPath, { [key]: normalizedValue } as ModelSpecOverride);
        return;
      }

      const storageKey = catalogOverrideKey(backendType);
      const overrides = readJsonStorage<Record<string, unknown>>(storageKey) ?? {};
      overrides[key] = normalizedValue;
      writeJsonStorage(storageKey, overrides);
    },
    [backendType, modelPath],
  );

  const clearOverrides = useCallback(() => {
    removeStorage(catalogOverrideKey(backendType));
    if (modelPath) removeStorage(modelSpecOverrideKey(modelPath));
    loadConfig();
  }, [backendType, modelPath, loadConfig]);

  return { config, updateParam, clearOverrides };
}