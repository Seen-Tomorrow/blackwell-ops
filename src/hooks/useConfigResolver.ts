// Merges param defaults with localStorage overrides.

import { useState, useCallback, useEffect } from "react";
import type { UserEditedTemplateParam } from "../lib/types";
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

  const loadConfig = useCallback(() => {
    if (!userEditedParams.length) return;

    const resolved: Record<string, any> = {};

    // Step 1: Set defaults from param definitions
    for (const p of userEditedParams) {
      if (p.values?.length > 0 && !p.hidden) {
        resolved[p.key] = p.defaultValue ?? p.values[0];
      }
    }

    // Step 2: Merge user overrides from localStorage
    const stored = readJsonStorage<Record<string, unknown>>(catalogOverrideKey(backendType));
    if (stored) Object.assign(resolved, stored);

    // Step 3: Normalize all string values to lowercase for consistent comparison
    const normalized = Object.fromEntries(
      Object.entries(resolved).map(([k, v]) => [k, normalizeValue(v)])
    );

    setConfig(normalized);
  }, [userEditedParams, backendType]);

  useEffect(() => {
    loadConfig();
  }, [model, userEditedParams.length, backendType]);

  useEffect(() => {
    const handler = () => loadConfig();
    window.addEventListener(EVENTS.paramConfigChanged, handler);
    return () => window.removeEventListener(EVENTS.paramConfigChanged, handler);
  }, [model, userEditedParams.length]);

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