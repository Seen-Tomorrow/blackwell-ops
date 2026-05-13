// Merges param defaults with localStorage overrides.

import { useState, useCallback, useEffect } from "react";
import type { ParamDef } from "../lib/types";
import { overridesKey } from "../lib/storage";

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
  paramDefs: ParamDef[];
  backendType: string;
}

export function useConfigResolver({
  model,
  paramDefs,
  backendType,
}: UseConfigResolverOptions) {
  const [config, setConfig] = useState<Record<string, any>>({});

  const loadConfig = useCallback(() => {
    if (!paramDefs.length) return;

    const resolved: Record<string, any> = {};

    // Step 1: Set defaults from param definitions
    for (const p of paramDefs) {
      if (p.values?.length > 0 && !p.hidden) {
        resolved[p.key] = p.defaultValue ?? p.values[0];
      }
    }

    // Step 2: Merge user overrides from localStorage
    try {
      const stored = localStorage.getItem(overridesKey(backendType));
      if (stored) {
        Object.assign(resolved, JSON.parse(stored));
      }
    } catch {}

    // Step 3: Normalize all string values to lowercase for consistent comparison
    const normalized = Object.fromEntries(
      Object.entries(resolved).map(([k, v]) => [k, normalizeValue(v)])
    );

    setConfig(normalized);
  }, [paramDefs, backendType]);

  useEffect(() => {
    loadConfig();
  }, [model, paramDefs.length, backendType]);

  useEffect(() => {
    const handler = () => loadConfig();
    window.addEventListener("param-config-changed", handler);
    return () => window.removeEventListener("param-config-changed", handler);
  }, [model, paramDefs.length]);

  const updateParam = useCallback((key: string, value: any) => {
    const normalizedValue = normalizeValue(value);
    setConfig(prev => ({ ...prev, [key]: normalizedValue }));

    try {
      const storageKey = overridesKey(backendType);
      const stored = localStorage.getItem(storageKey);
      const overrides: Record<string, any> = stored ? JSON.parse(stored) : {};
      overrides[key] = normalizedValue;
      localStorage.setItem(storageKey, JSON.stringify(overrides));
    } catch {}
  }, [backendType]);

  const clearOverrides = useCallback(() => {
    try {
      localStorage.removeItem(overridesKey(backendType));
    } catch {}
    loadConfig();
  }, [backendType, loadConfig]);

  return { config, updateParam, clearOverrides };
}