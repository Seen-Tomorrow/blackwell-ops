/**
 * Config Resolver Hook — Consolidates config state management
 *
 * Handles:
 * - Loading defaults from param definitions
 * - Merging user overrides from localStorage  
 * - Syncing on provider/template changes
 */

import { useState, useCallback, useEffect } from "react";
import type { ParamDef } from "../lib/types";

const OVERRIDES_KEY_PREFIX = "BlackOps-admin-catalog-override:";

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

  // Load config from defaults + localStorage overrides
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
      const stored = localStorage.getItem(OVERRIDES_KEY_PREFIX + backendType);
      if (stored) {
        Object.assign(resolved, JSON.parse(stored));
      }
    } catch {}

    setConfig(resolved);
  }, [paramDefs, backendType]);

  // Reload when model or provider changes
  useEffect(() => {
    loadConfig();
  }, [model, paramDefs.length, backendType]);

  // Sync when ConfigPage updates params via custom event
  useEffect(() => {
    const handler = () => loadConfig();
    window.addEventListener("param-config-changed", handler);
    return () => window.removeEventListener("param-config-changed", handler);
  }, [model, paramDefs.length]);

  // Update single param value + persist to localStorage
  const updateParam = useCallback((key: string, value: any) => {
    setConfig(prev => ({ ...prev, [key]: value }));

    try {
      const overridesKey = OVERRIDES_KEY_PREFIX + backendType;
      const stored = localStorage.getItem(overridesKey);
      const overrides: Record<string, any> = stored ? JSON.parse(stored) : {};
      overrides[key] = value;
      localStorage.setItem(overridesKey, JSON.stringify(overrides));
    } catch {}
  }, [backendType]);

  // Clear all overrides for this provider
  const clearOverrides = useCallback(() => {
    try {
      localStorage.removeItem(OVERRIDES_KEY_PREFIX + backendType);
    } catch {}
    loadConfig();
  }, [backendType, loadConfig]);

  return { config, updateParam, clearOverrides };
}