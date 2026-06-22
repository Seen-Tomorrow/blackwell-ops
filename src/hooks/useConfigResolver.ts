// Merges param defaults with localStorage overrides.

import { useState, useCallback, useEffect, useMemo } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
import { paramsVisibilityFingerprint, resolveParamDefaultValue } from "../lib/paramConfigResolve";
import { catalogOverrideKey, readJsonStorage, removeStorage, writeJsonStorage } from "../lib/storage";
import { EVENTS } from "../lib/events";

// Preserve mixed-case values like "8K", "GPU-0"; lowercase pure-alpha strings.
const normalizeValue = (value: any): any => {
  if (typeof value !== 'string') return value;
  
  // If string has both letters and contains uppercase, preserve original
  // This handles CTX values like "8K", "32K", "1M" where suffix is legitimately uppercase
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  
  // Skip normalization if mixed case (e.g., "Off") or has digit+uppercase pattern (e.g., "32K")
  if (hasLower && hasUpper) return value;
  if (/^\d+[KMGT]$/i.test(value)) return value; // e.g., "8K", "16M"
  if (/^GPU-\d+$/i.test(value)) return value;    // e.g., "GPU-0", "GPU-1" — preserve case for scenario parser
  
  return value.toLowerCase();
};

interface UseConfigResolverOptions {
  model: unknown; // ModelEntry | null - only used to trigger reload
  userEditedParams: UserEditedTemplateParam[];
  backendType: string;
}

export function useConfigResolver({
  model,
  userEditedParams,
  backendType,
}: UseConfigResolverOptions) {
  const [config, setConfig] = useState<Record<string, any>>({});
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
    const resolved: Record<string, any> = {};

    // Only visible params enter active config — hidden group params stay omitted from CLI path.
    for (const p of userEditedParams) {
      if (p.hidden || !p.values?.length) continue;
      const fallback = resolveParamDefaultValue(p);
      resolved[p.key] = stored[p.key] ?? fallback;
    }

    const normalized = Object.fromEntries(
      Object.entries(resolved).map(([k, v]) => [k, normalizeValue(v)])
    );

    setConfig(normalized);
  }, [userEditedParams, backendType]);

  useEffect(() => {
    loadConfig();
  }, [model, paramsFingerprint, backendType, loadConfig]);

  useEffect(() => {
    const handler = () => loadConfig();
    window.addEventListener(EVENTS.paramConfigChanged, handler);
    return () => window.removeEventListener(EVENTS.paramConfigChanged, handler);
  }, [loadConfig]);

  const updateParam = useCallback((key: string, value: any) => {
    const normalizedValue = normalizeValue(value);
    setConfig(prev => ({ ...prev, [key]: normalizedValue }));

    const storageKey = catalogOverrideKey(backendType);
    const overrides = readJsonStorage<Record<string, unknown>>(storageKey) ?? {};
    overrides[key] = normalizedValue;
    writeJsonStorage(storageKey, overrides);
  }, [backendType]);

  const clearOverrides = useCallback(() => {
    removeStorage(catalogOverrideKey(backendType));
    loadConfig();
  }, [backendType, loadConfig]);

  return { config, updateParam, clearOverrides };
}