import { useCallback } from "react";
import type { ParamDef, EngineConfig } from "../lib/types";

interface UseInferenceLauncherOptions {
  paramDefs: ParamDef[];
  currentConfig: Record<string, any>;
  backendType?: string;
  testFlagsRaw?: string; // Raw CLI flags — bypasses all user params when set
}

const OVERRIDES_KEY_PREFIX = "BlackOps-admin-catalog-override:";

export function useInferenceLauncher(options: UseInferenceLauncherOptions) {
  const { paramDefs, currentConfig, backendType = "ggml-stable", testFlagsRaw } = options;

  // Build sub_params CLI args for a given param value
  const buildSubParamsArgs = useCallback((def: ParamDef, selectedValue: string | number): string[] => {
    if (!def.sub_params) return [];
    const valueKey = String(selectedValue);
    const args = def.sub_params[valueKey];
    if (!args || !Array.isArray(args)) return [];
    return args;
  }, []);

  // Generic type casting based on template ptype metadata — no hardcoded field names
  const castValueByTemplate = useCallback((value: string | number, def: ParamDef): any => {
    const ptype = def.ptype || "arg_select";

    if (ptype === "switch_onoff") {
      return value === "ON" || value === "on";
    }

    if (ptype === "switch_inverted") {
      return value !== "ON" && value !== "on";
    }

    if (ptype === "mapper") {
      const mapId = def.map_id;
      if (!mapId) return String(value);

      // CTX_TO_INT is handled by Rust's ctx_to_int_str() — pass through as string
      if (mapId === "CTX_TO_INT") {
        return String(value);
      }

      if (mapId === "OFFLOAD_MAP") {
        // OFFLOAD_MAP is handled by Rust's offload_map() — pass through as string
        return String(value);
      }

      return String(value);
    }

    if (ptype === "arg_select") {
      const values = def.values || [];
      for (const v of values) {
        if (typeof v === "number" && String(value) === String(v)) return v;
      }
      // arg_select with ON/OFF string values → boolean (e.g. Reasoning, Flash-Attn)
      const upper = String(value).toUpperCase();
      if (upper === "ON") return true;
      if (upper === "OFF") return false;
      return value;
    }

    if (ptype === "path_scanner") {
      if (String(value).toUpperCase() === "OFF") return String(value);
      // AUTO — currentConfig should already have the resolved file path from model catalog scan
      return String(value) || "";
    }

    if (ptype === "logic_only") {
      return undefined;
    }

    return value;
  }, []);

  // Build the complete EngineConfig for launch — merges template + admin params
  const buildInferenceConfig = useCallback((baseConfig: Omit<EngineConfig, 'extra_params'>): EngineConfig => {
    // ── TEST MODE: bypass all user params, use raw flags only ───────────────────────
    if (testFlagsRaw && testFlagsRaw.trim()) {
      const testArgs: string[] = testFlagsRaw.trim().split(/\s+/).filter(Boolean);
      return { ...baseConfig, extra_params: { __test_args: testArgs } };
    }

    const extraParams: Record<string, any> = {};
    const subParamArgs: string[] = [];

    // Read user overrides fresh from localStorage — user's selection always wins
    let effectiveConfig: Record<string, any>;
    try {
      const stored = localStorage.getItem(OVERRIDES_KEY_PREFIX + backendType);
      effectiveConfig = { ...currentConfig };
      if (stored) Object.assign(effectiveConfig, JSON.parse(stored));
    } catch {
      effectiveConfig = currentConfig;
    }

    // Process all param defs — include even logic_only params (no config_key/flag)
    for (const def of paramDefs) {
      const configKey = def.config_key || def.key;

      // Get selected value — PRIMARY: key, FALLBACK: config_key
      let value = effectiveConfig[def.key] ?? effectiveConfig[configKey];
      if (value === undefined) continue;

      // Cast and route: typed fields → baseConfig, everything else → extra_params by key
      const castedValue = castValueByTemplate(value, def);
      if (castedValue !== undefined && def.config_key) {
        // Has config_key — goes to typed field on EngineConfig
        (baseConfig as any)[def.config_key] = castedValue;
      }
      // Put ALL selected values in extra_params by their param key
      // This ensures Rust's get_value can find them even for logic_only params with no flag/config_key
      extraParams[configKey] = value;

      // Inject sub_params CLI args based on selected value
      const subArgs = buildSubParamsArgs(def, value);
      if (subArgs.length > 0) {
        subParamArgs.push(...subArgs);
      }
    }

    // If there are sub_params args, store them as a special entry in extra_params
    if (subParamArgs.length > 0) {
      extraParams["__sub_args"] = subParamArgs;
    }

    return { ...baseConfig, extra_params: Object.keys(extraParams).length > 0 ? extraParams : undefined };
  }, [testFlagsRaw, paramDefs, currentConfig, buildSubParamsArgs]);

  // Get the effective value for a param (from localStorage overrides + currentConfig)
  const getEffectiveValue = useCallback((def: ParamDef): string | number | undefined => {
    let vals: Record<string, any> = { ...currentConfig };
    try {
      const stored = localStorage.getItem(OVERRIDES_KEY_PREFIX + backendType);
      if (stored) Object.assign(vals, JSON.parse(stored));
    } catch {}
    // PRIMARY: key, FALLBACK: config_key — matches buildInferenceConfig
    return vals[def.key] ?? vals[def.config_key || def.key];
  }, [currentConfig, backendType]);

  // Check if param is managed by admin (exists in template)
  const isManagedByAdmin = useCallback((key: string): boolean => {
    return paramDefs.some(d => d.key === key);
  }, [paramDefs]);

  return {
    buildInferenceConfig,
    getEffectiveValue,
    isManagedByAdmin,
  };
}