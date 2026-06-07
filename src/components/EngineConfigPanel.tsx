// Model-specific parameter configuration and launch control.

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ModelEntry, EngineConfig, GpuInfo, UserEditedTemplateParam, ProviderConfig, ProviderTemplate, StackEntry, SystemInfo } from "../lib/types";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import {
  KEYS,
  binaryProfileKey,
  engineAliasKey,
  readJsonStorage,
  readStorage,
  removeStorage,
  writeJsonStorage,
  writeStorage,
} from "../lib/storage";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import { invoke } from "@tauri-apps/api/core";
import VramBadge from "./VramBadge";
import RunningEnginesPanel from "./RunningEnginesPanel";
import SliderParam from "./SliderParam";
import { useScenarioEvaluator } from "../hooks/useScenarioEvaluator";
import { useConfigResolver } from "../hooks/useConfigResolver";
import { useDisplayTexture } from "../hooks/useDisplayTexture";



type EnvProfile = "vanguard" | "fresh" | "stable";

const ENV_META: Record<EnvProfile, { label: string; cuda: string; vs: string }> = {
  vanguard: { label: "VANGUARD", cuda: "13.2", vs: "VS Build Tools 2026 (v18)" },
  fresh:    { label: "FRESH",    cuda: "13.1", vs: "VS Build Tools 2022" },
  stable:   { label: "STABLE",   cuda: "12.8", vs: "VS Build Tools 2022" },
};

function pickBestBinaryProfile(provider: ProviderConfig | undefined): EnvProfile {
  if (!provider) return "vanguard";
  const profiles: EnvProfile[] = ["vanguard", "fresh", "stable"];
  const available = profiles.filter(
    (p) => provider.binaryPathPerEnv?.[p] || provider.buildInfoPerEnv?.[p],
  );
  if (available.length === 0) return "vanguard";
  let best = available[0];
  let bestDate = provider.buildInfoPerEnv?.[best]?.buildDate ?? "";
  for (const p of available.slice(1)) {
    const d = provider.buildInfoPerEnv?.[p]?.buildDate ?? "";
    if (d > bestDate) {
      best = p;
      bestDate = d;
    }
  }
  return best;
}

const PROFILE_COLORS: Record<string, string> = {
  cyan:     "#00e5ff",
  amber:    "#FFB800",
  "nv-green": "#76B900",
};

// Group metadata derived dynamically from template — no hardcoded group names.
interface ParamGroupMeta { id: string; label: string; alwaysOpen: boolean }
function deriveParamGroups(groupKeys: string[]): ParamGroupMeta[] {
  return groupKeys.map(id => ({
    id,
    label: id.toUpperCase(),
    alwaysOpen: id === 'Core' || id === 'Performance', // Core/Performance always open by convention
  }));
}

interface EngineConfigPanelProps {
  model: ModelEntry | null;
  gpus: GpuInfo[];
  providers?: ProviderConfig[];
  committedVramMib: number;
  isPowerUser: boolean;
  systemInfo?: SystemInfo | null;
  stack: StackEntry[];
  onLaunch: (config: EngineConfig) => Promise<any>;
  isModelRunning?: boolean;
  activeEngineAlias?: string;
  activeEnginePort?: number;
  selectedSlotIdx?: number | null; // Slot index for Fusion overlay
  supportsFusion?: boolean;
  models?: ModelEntry[]; // Full model list for running engines panel
  onSelectEngine?: (slotIdx: number) => void; // Callback to select a running engine
}

export default function EngineConfigPanel(props: EngineConfigPanelProps) {
  const { model, gpus, providers: externalProviders, committedVramMib, isPowerUser, systemInfo, stack, onLaunch, isModelRunning, activeEngineAlias, activeEnginePort, selectedSlotIdx, supportsFusion = true, models, onSelectEngine } = props;

  // ── State ───────────────────────────────────────────────────────────────

  const [userEditedParams, setUserEditedParams] = useState<UserEditedTemplateParam[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(() => {
    return readStorage(KEYS.lastProvider);
  });
  const [testFlags, setTestFlags] = useState(() => {
    return readStorage(KEYS.testFlags) || "";
  });
  const [testFlagsEnabled, setTestFlagsEnabled] = useState(() => {
    return readStorage(KEYS.testFlagsOn) === "1";
  });

  // Test flags mode: "add" (prepend to config) or "replace" (bypass all params)
  const [testFlagsMode, setTestFlagsMode] = useState<"add" | "replace">(() => {
    return readStorage(KEYS.testFlagsMode) === "add" ? "add" : "replace";
  });

  const [aliasInput, setAliasInput] = useState<string>("");
  const [aliasIsUserSet, setAliasIsUserSet] = useState(false);
  const aliasInitializedRef = useRef<{ modelPath: string; done: boolean }>({ modelPath: "", done: false });
  const aliasUserEditedRef = useRef(false);

  const [selectedBinaryProfile, setSelectedBinaryProfile] = useState<EnvProfile>("vanguard");

  const [isBlazing, setIsBlazing] = useState(false);
  const [specFlash, setSpecFlash] = useState(false);

  const { texture: displayTexture, label: displayTextureLabel, cycle: cycleDisplayTexture } = useDisplayTexture();

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const saved = readStorage(KEYS.collapsedGroups);
      if (saved) return new Set(JSON.parse(saved));
    } catch {}
    return new Set(["ADVANCED", "FEATURE-FLAGS"]);
  });

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      writeJsonStorage(KEYS.collapsedGroups, [...next]);
      return next;
    });
  }, []);

  // Persist test flags
  useEffect(() => {
    writeStorage(KEYS.testFlags, testFlags);
  }, [testFlags]);
  useEffect(() => {
    writeStorage(KEYS.testFlagsOn, testFlagsEnabled ? "1" : "0");
  }, [testFlagsEnabled]);

  // Persist test flags mode
  useEffect(() => {
    writeStorage(KEYS.testFlagsMode, testFlagsMode);
  }, [testFlagsMode]);

  // Auto-populate alias when model changes — per-model persistence
  useEffect(() => {
    if (!model) return;
    const key = engineAliasKey(model.path);
    const initKey = aliasInitializedRef.current.modelPath;

    // Only initialize once per model path to avoid overwriting user input on HMR
    if (initKey !== model.path) {
      try {
        const saved = readStorage(key);
        if (saved) {
          setAliasInput(saved);
          aliasUserEditedRef.current = true;
          setAliasIsUserSet(true);
        } else {
          // Auto-generate suggestion — not persisted
          invoke<StackEntry[]>("get_stack_status").then(stack => {
            const usedNames = new Set<number>();
            for (const s of stack) {
              const match = s.alias?.match(/^ENGINE_(\d+)$/);
              if (match) usedNames.add(parseInt(match[1], 10));
            }
            for (let i = 1; i <= 64; i++) {
              if (!usedNames.has(i)) return `ENGINE_${i}`;
            }
            return "ENGINE_1";
          }).then(autoName => {
            setAliasInput(autoName);
            aliasUserEditedRef.current = false;
            setAliasIsUserSet(false);
            aliasInitializedRef.current = { modelPath: model.path, done: true };
          }).catch(() => {
            setAliasInput("ENGINE_1");
            aliasUserEditedRef.current = false;
            setAliasIsUserSet(false);
            aliasInitializedRef.current = { modelPath: model.path, done: true };
          });
        }
      } catch {
        aliasUserEditedRef.current = false;
        setAliasIsUserSet(false);
        aliasInitializedRef.current = { modelPath: model.path, done: true };
      }
    }
  }, [model?.path]);

  // Save alias to localStorage only when user has actively edited it (not on every keystroke)
  const saveAliasForModel = useCallback((modelPath: string, aliasValue: string) => {
    try {
      if (aliasValue.trim()) {
        writeStorage(engineAliasKey(modelPath), aliasValue.trim());
      } else {
        removeStorage(engineAliasKey(modelPath));
      }
    } catch {}
  }, []);

  // Clear persisted alias when user clears the input field
  useEffect(() => {
    if (!model || !aliasInitializedRef.current.done) return;
    try {
      if (aliasUserEditedRef.current && !aliasInput.trim()) {
        removeStorage(engineAliasKey(model.path));
        setAliasIsUserSet(false);
      }
    } catch {}
  }, [aliasInput, model?.path]);

  // Auto-select default provider when providers load (runs once on mount)
  const providerInitDone = useRef(false);
  useEffect(() => {
    if (providerInitDone.current || !externalProviders?.length) return;
    providerInitDone.current = true;

    const enabled = externalProviders.filter(p => p.enabled);
    if (enabled.length === 0) return;

    // Prefer saved localStorage choice, validate it exists, else default to ggml-master or first available
    let target: string | null = null;
    target = readStorage(KEYS.lastProvider);

    if (!target || !enabled.some(p => p.id === target)) {
      const def = enabled.find(p => p.id === DEFAULT_PROVIDER_ID);
      target = def?.id || enabled[0].id;
    }

    setSelectedProvider(target);
  }, [externalProviders]);

  // ── Derived state ───────────────────────────────────────────────────────────
  const effectiveBackendType = useMemo(() => {
    if (!model) return selectedProvider || DEFAULT_PROVIDER_ID;
    return selectedProvider || (model.backend_type || DEFAULT_PROVIDER_ID);
  }, [model, selectedProvider]);

  // Per-provider binary profile — re-resolve when provider or available builds change
  useEffect(() => {
    if (!effectiveBackendType) return;
    const provider = externalProviders?.find((p) => p.id === effectiveBackendType);
    const built: EnvProfile[] = (["vanguard", "fresh", "stable"] as EnvProfile[]).filter(
      (env) => provider?.binaryPathPerEnv?.[env] || provider?.buildInfoPerEnv?.[env],
    );
    try {
      const saved = readStorage(binaryProfileKey(effectiveBackendType)) as EnvProfile | null;
      if (saved && built.includes(saved)) {
        setSelectedBinaryProfile(saved);
        return;
      }
    } catch { /* ignore */ }
    setSelectedBinaryProfile(pickBestBinaryProfile(provider));
  }, [effectiveBackendType, externalProviders]);

  useEffect(() => {
    if (!effectiveBackendType) return;
    writeStorage(binaryProfileKey(effectiveBackendType), selectedBinaryProfile);
  }, [selectedBinaryProfile, effectiveBackendType]);

  // Dynamic Device param — generated from GPU topology, docked to runtime block
  const deviceParam: UserEditedTemplateParam | null = useMemo(() => {
    if (gpus.length === 0) return null;
    const alreadyExists = userEditedParams.some(d => d.key === "device");
    if (alreadyExists) return null;
    return {
      key: "device",
      label: "DEVICE",
      flag: null,
      ptype: "arg_select" as const,
      values: gpus.map((_, i) => `GPU-${i}`),
      order: -1,
      hidden: false,
      defaultValue: "GPU-0",
      dock: "runtime",
      ui_group: "MULTI-GPU",
      note: "Select which GPU to use for inference.",
    };
  }, [gpus.length, userEditedParams]);

  const allParamsForLaunch = useMemo(() => {
    const defs = deviceParam ? [deviceParam, ...userEditedParams] : [...userEditedParams];
    const gpuValues = gpus.map((_, i) => `GPU-${i}`);
    return defs
      .map((d) => {
        if (d.key !== "device" || gpus.length === 0) return d;
        const defaultStr = String(d.defaultValue);
        return {
          ...d,
          values: gpuValues,
          defaultValue: gpuValues.includes(defaultStr) ? d.defaultValue : "GPU-0",
        };
      })
      .sort((a, b) => a.order - b.order);
  }, [userEditedParams, deviceParam, gpus]);

  // Docked params: extracted from merged defs by dock key
  const dockedParams = useMemo(() => {
    const docks: Record<string, UserEditedTemplateParam[]> = {};
    for (const def of allParamsForLaunch) {
      if (!def.dock || def.hidden) continue;
      if (!docks[def.dock]) docks[def.dock] = [];
      docks[def.dock].push(def);
    }
    return docks;
  }, [allParamsForLaunch]);

  // ── Hooks ────────────────────────────────────────────────────────────────
  const { config, updateParam } = useConfigResolver({
    model,
    userEditedParams: allParamsForLaunch,
    backendType: effectiveBackendType,
  });

  // Display value — manufactured capacity, no deductions (what users see)
  const displayVramMib = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);

 const vramCalc = useScenarioEvaluator({
    model,
    config: { ...config, backend_type: effectiveBackendType },
    gpus,
    stack,
    systemInfo,
  });

  // Compute which GPUs are involved from manifest — for multi-GPU highlighting
  const selectedGpuIndices = useMemo(() => {
    if (!vramCalc.manifest) return [];
    return vramCalc.manifest.gpuAllocations
      .filter(a => a.projectedLoadGb > 0.1) // Only highlight GPUs with actual load
      .map(a => a.gpuIndex);
  }, [vramCalc.manifest]);

  // ── Provider default param keys (for yellow accent on user-added params) ──
  const [providerDefaultKeys, setProviderDefaultKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!effectiveBackendType) return;
    invoke<ProviderTemplate>("get_template", { providerId: effectiveBackendType })
      .then(template => setProviderDefaultKeys(new Set((template.params || []).map(p => p.key))))
      .catch(() => setProviderDefaultKeys(new Set()));
  }, [effectiveBackendType]);

  // Extracted param row renderer for reuse
  const paramRowKey = (def: UserEditedTemplateParam, idx?: number) =>
    `${def.key || "param"}-${def.order}-${idx ?? 0}`;

  const renderParamRow = useCallback((def: UserEditedTemplateParam, isLocked?: boolean, rowIdx?: number) => {
    // Merge values + userAddedValues (user-added params from ConfigPage admin edit)
    const seenVals = new Set((def.values || []).map(v => String(v)));
    const allValues = [...(def.values || []), ...(def.userAddedValues || []).filter(v => !seenVals.has(String(v)))];
    const baseValues = allValues.filter(v => !(def.hiddenValues || []).some(hv => String(hv) === String(v)));
    const currentValue = config[def.key];

    // Yellow accent: user-added params (not in provider default params, not system-injected via dock)
    const isUserAdded = providerDefaultKeys.size > 0 && !providerDefaultKeys.has(def.key) && !def.dock;

    // ── Slider ptype — render range input instead of value chips ───────────
    if (def.ptype === 'slider') {
      return (
        <div key={paramRowKey(def, rowIdx)} data-param-row className={`flex items-center ${isLocked ? 'opacity-50' : ''}`}>
          {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 bg-yellow-400/40 mr-1.5" />}
          {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />}
          <span
            className={`font-mono w-24 flex-shrink-0 uppercase tracking-wider truncate text-[9px] ${isUserAdded ? 'text-yellow-400/80' : 'text-stealth-muted'}`}
            title={def.label}
          >
            {def.label}
          </span>
          <SliderParam
            paramKey={def.key}
            currentValue={currentValue}
            onChange={(v) => updateParam(def.key, v)}
            step={def.step ?? 1024}
            values={baseValues}
          />
        </div>
      );
    }

    return (
      <div key={paramRowKey(def, rowIdx)} data-param-row className={`flex items-center ${isLocked ? 'opacity-50' : ''}`}>
        {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 bg-yellow-400/40 mr-1.5" />}
        {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />}
        <span
          className={`font-mono w-24 flex-shrink-0 uppercase tracking-wider truncate text-[9px] ${isUserAdded ? 'text-yellow-400/80' : 'text-stealth-muted'}`}
          title={def.label}
        >
          {def.label}
        </span>

        <div className="flex gap-1 flex-wrap flex-1 min-w-0">
          {baseValues.filter((v: any) => !(v?._hidden)).map((val, valIdx) => (
            <button
              key={`${paramRowKey(def, rowIdx)}-val-${valIdx}-${String(val)}`}
              tabIndex={isLocked ? -1 : 0}
              onClick={() => {
                if (!isLocked) updateParam(def.key, val);
              }}
           className={`px-2 py-0.5 text-[9px] font-mono rounded-sm focus:outline-none ${
                currentValue === val ||
                (typeof currentValue === 'string' && typeof val === 'string' &&
                  currentValue.toLowerCase() === String(val).toLowerCase())
                  ? "value-chip-active"
                  : "value-chip"
              }`}
            >
              {String(val)}
            </button>
          ))}
        </div>
      </div>
    );
  }, [userEditedParams, config, updateParam, vramCalc.manifest]);

  // Grouped params — skip docked (rendered separately)
  const groupedParams = useMemo(() => {
    const groups: Record<string, UserEditedTemplateParam[]> = {};
    for (const def of allParamsForLaunch) {
      if (def.hidden || def.dock) continue;
      const groupId = def.ui_group || 'Feature Flags';
      if (!groups[groupId]) groups[groupId] = [];
      groups[groupId].push(def);
    }
    return groups;
  }, [allParamsForLaunch]);

  // All params by group — includes hidden ones (for nuclear button to find Speculative decoding group)
  const allGroupedParams = useMemo(() => {
    const groups: Record<string, UserEditedTemplateParam[]> = {};
    for (const def of allParamsForLaunch) {
      if (def.dock) continue;
      const groupId = def.ui_group || 'Feature Flags';
      if (!groups[groupId]) groups[groupId] = [];
      groups[groupId].push(def);
    }
    return groups;
  }, [allParamsForLaunch]);

  // Ordered group keys: custom provider order > template insertion order (include hidden-only groups)
  const orderedGroupKeys = useMemo(() => {
    const allGroups = [...new Set([...Object.keys(groupedParams), ...Object.keys(allGroupedParams)])];
    const currentProv = externalProviders?.find(p => p.id === effectiveBackendType);
    if (currentProv?.groupOrder && currentProv.groupOrder.length > 0) {
      return [...currentProv.groupOrder.filter(g => allGroups.includes(g)), ...allGroups.filter(g => !currentProv.groupOrder!.includes(g))];
    }
    return allGroups;
  }, [groupedParams, allGroupedParams, externalProviders, effectiveBackendType]);

  // ── Load param definitions when model/provider changes ───────────────────
  useEffect(() => {
    if (!model) {
      setUserEditedParams([]);
      return;
    }

    const backendType = effectiveBackendType;

    const prov = externalProviders?.find(p => p.id === backendType);
    if (prov && prov.userEditedTemplateParams) {
      setUserEditedParams(prov.userEditedTemplateParams || []);
    } else {
      invoke<ProviderTemplate>("get_template", { providerId: backendType })
        .then((template: ProviderTemplate) => {
          const tDefs: UserEditedTemplateParam[] = (template.params || []).map((p, i) => ({
            key: p.key,
            label: p.label,
            values: p.values as (string | number)[],
            order: i,
            hidden: p.hidden_default ?? false,
            defaultValue: p.default,
            flag: p.flag ?? undefined,
            ptype: p.ptype,
            step: p.step,
            ui_group: p.ui_group,
            note: p.note,
            pattern: p.pattern,
            sub_params: p.sub_params,
            dock: p.dock || undefined,
          }));
           setUserEditedParams(tDefs);
         })
         .catch(() => {});
    }

  }, [model, effectiveBackendType, externalProviders]);

  // Keyboard launch — Ctrl+Enter triggers ignite
  useEffect(() => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
      handleAddToStack();
    };
    window.addEventListener(EVENTS.launchEngine, handler);
    return () => window.removeEventListener(EVENTS.launchEngine, handler);
  }, [model, config, effectiveBackendType]);

  // ── Name helpers ───────────────────────────────────────────────────────────
  const getNextEngineName = useCallback(async (): Promise<string> => {
    try {
      const stack = await invoke<StackEntry[]>("get_stack_status");
      const usedNames = new Set<number>();
      for (const s of stack) {
        const match = s.alias?.match(/^ENGINE_(\d+)$/);
        if (match) {
          usedNames.add(parseInt(match[1], 10));
        }
      }
      for (let i = 1; i <= 64; i++) {
        if (!usedNames.has(i)) return `ENGINE_${i}`;
      }
    } catch {}
    return "ENGINE_1";
  }, []);

  // ── Launch handler ───────────────────────────────────────────────────────
  const handleAddToStack = async () => {
    if (!model) return;

    // Resolve final alias: user input if non-empty, otherwise auto-generate
    let finalAlias = aliasInput.trim();
    if (!finalAlias) {
      finalAlias = await getNextEngineName();
    }
    
    // Check for collision with active (non-IDLE) engines — append suffix if needed
    try {
      const stackStatus = await invoke<StackEntry[]>("get_stack_status");
      const collisions = stackStatus.filter(s => s.alias === finalAlias && s.status !== "IDLE");
      if (collisions.length > 0) {
        let suffix = 2;
        while (stackStatus.some(s => s.alias === `${finalAlias}_${suffix}` && s.status !== "IDLE")) {
          suffix++;
        }
        finalAlias = `${finalAlias}_${suffix}`;
      }
    } catch {}

    // Build data-driven EngineConfig: mandatory fields + all user params in extra_params
    const extraParams: Record<string, any> = { ...config };
    // Override n_gpu_layers with VRAM calculation if partial offload is active
    if (vramCalc.manifest?.gpuLayers != null && vramCalc.manifest.ramLayers > 0) {
      extraParams.__ngl = String(vramCalc.manifest.gpuLayers);
    }

    const fullConfig: EngineConfig = {
      alias: finalAlias,
      model_path: model.path,
      port: 0, // Backend computes the actual port from base_port + collision avoidance
      backend_type: effectiveBackendType,
      binary_profile: selectedBinaryProfile,
      extra_params: extraParams,
    };

    // Inject test flags into extra_params if enabled
    if (testFlagsEnabled && testFlags.trim()) {
      const testArgs = testFlags.trim().split(/\s+/).filter(Boolean);
      fullConfig.extra_params = testFlagsMode === "replace"
        ? { __test_args: testArgs } // REPLACE: bypass all params, use only raw flags
        : { ...fullConfig.extra_params, __test_args_add: testArgs }; // ADD: merge with user config, append test flags
    }

    // Trigger blaze animation
    setIsBlazing(true);
    setTimeout(() => setIsBlazing(false), 800);

    try {
      const result = await onLaunch(fullConfig);
      // Dispatch success event for toast + status bar with the real port from backend
      if (result?.port) {
        dispatchAppEvent(EVENTS.launchSuccess, { alias: finalAlias, port: result.port });
      }
      // Only persist if user actively edited the alias — skip auto-generated ENGINE_N names
      const wasUserEdited = aliasUserEditedRef.current;
      if (wasUserEdited) {
        saveAliasForModel(model.path, aliasInput.trim());
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      dispatchAppEvent(EVENTS.launchError, { message: msg });
    }
  };

  // ── Empty state ──────────────────────────────────────────────────────────
  if (!model) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-stealth-muted font-mono">
        <div className="text-center config-empty-enter">
          <div className="text-3xl mb-3 text-stealth-muted/40">⬡</div>
          <p className="text-xs tracking-widest uppercase">SELECT A MODEL</p>
          <p className="text-[9px] mt-1 opacity-50">Choose from the catalog to configure</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full overflow-hidden" data-config-panel>
      {/* Provider selector */}
      {externalProviders && externalProviders.length > 0 && (
        <div className="px-4 py-3 border-b section-divider relative flex-shrink-0">
          <label className="text-[9px] font-mono tracking-widest uppercase block mb-2 amber-label">
            ENGINE PROVIDER
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {externalProviders.filter(p => p.enabled).map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedProvider(p.id);
                  writeStorage(KEYS.lastProvider, p.id);
                }}
                className={`px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${
                  selectedProvider === p.id
                    ? "provider-pill-active"
                    : "provider-pill"
                }`}
              >
                {p.display_name || p.id}
                <span className="ml-1 opacity-40 text-[8px]">({(p.userEditedTemplateParams || []).length})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Mandatory Config Block (2-column) ─────────────── */}
      {dockedParams["runtime"] && dockedParams["runtime"].length > 0 && (() => {
        const runtimeDocked = dockedParams["runtime"];
        const leftParams = runtimeDocked.filter(d => d.ui_group !== "RUNTIME-CONFIG");
        const rightParams = runtimeDocked.filter(d => d.ui_group === "RUNTIME-CONFIG");
        const currentProvider = externalProviders?.find(p => p.id === effectiveBackendType);
        const availableProfiles: EnvProfile[] = Object.keys(ENV_META) as EnvProfile[];
        const builtProfiles = (Object.keys(ENV_META) as EnvProfile[]).filter(
          (env) => currentProvider?.binaryPathPerEnv?.[env] || currentProvider?.buildInfoPerEnv?.[env],
        );

        return (
          <div className="mono-panel relative flex-shrink-0">
            {/* Section header — outside the green bg, on dark */}
            <div className="relative z-[2] px-4 pt-3 pb-1 mono-panel-header">

            </div>
            <div className="relative z-[2] px-4 py-3 pr-6">
              <div className="flex gap-4">
                {/* Left: Multi-GPU params */}
                {leftParams.length > 0 && (
                  <div className="space-y-2.5 flex-1 min-w-0">
                    <label className="text-[8px] font-mono tracking-widest uppercase block mb-2 mono-label">
                      MULTI-GPU
                    </label>
                    {leftParams.map((def, i) => renderParamRow(def, false, i))}
                  </div>
                )}

                {/* Subtle vertical separator */}
                <div className="w-px flex-shrink-0 bg-white/[0.03]" />

               {/* Right: Runtime Config */}
                <div className="flex-1 min-w-0 space-y-2.5">
                  <label className="text-[8px] font-mono tracking-widest uppercase block mb-2 mono-label">
                    RUNTIME-CONFIG
                  </label>

                  {rightParams.map((def, i) => renderParamRow(def, false, i))}

                  <div className="flex items-center">
                    <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />
                    <span className="font-mono w-24 flex-shrink-0 uppercase tracking-wider truncate text-[9px] text-stealth-muted">
                      Alias{aliasIsUserSet ? <span className="mono-user-set"> - user set</span> : ''}
                    </span>
                    <input
                      type="text"
                      value={aliasInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val.trim()) {
                          aliasUserEditedRef.current = true;
                          setAliasIsUserSet(true);
                        } else {
                          aliasUserEditedRef.current = false;
                          setAliasIsUserSet(false);
                        }
                        setAliasInput(val);
                      }}
                      className={`flex-1 min-w-0 border text-[9px] font-mono px-2 py-0.5 rounded-sm focus:outline-none transition-colors ${
                        aliasUserEditedRef.current
                          ? "bg-black border-white/30 focus:border-white/50 mono-user-input"
                          : "bg-green-400/5 border-green-400/20 focus:border-green-400/40"
                      }`}
                      placeholder="auto..."
                    />
                  </div>

                  <div className="flex items-center">
                    <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />
                    <span className="font-mono w-24 flex-shrink-0 uppercase tracking-wider truncate text-[9px] text-stealth-muted runtime-profile-label">
                      RUNTIME PROFILE
                    </span>
                    {availableProfiles.map(profile => {
                      const meta = ENV_META[profile];
                      const hasBuild = builtProfiles.includes(profile);
                      const isSelected = selectedBinaryProfile === profile;
                      return (
                        <button
                          key={profile}
                          onClick={() => setSelectedBinaryProfile(profile)}
                          disabled={!hasBuild}
                          className={`px-2 py-0.5 text-[9px] font-mono rounded-sm runtime-profile-chip ${
                            isSelected
                              ? "runtime-profile-chip-active"
                              : hasBuild
                                ? ""
                                : "opacity-25 cursor-not-allowed"
                          }`}
                          title={`${meta.label} — CUDA ${meta.cuda}, ${meta.vs}${hasBuild ? '' : ' (not yet built)'}`}
                        >
                          {meta.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

    {/* VRAM + Running Engines — industrial display unit */}
      <div className="industrial-display-area flex-shrink-0">
          <div
            className="industrial-display-frame relative"
            data-display-texture={displayTexture}
          >
              <button
                type="button"
                onClick={cycleDisplayTexture}
                className="display-texture-toggle absolute top-[3px] left-1/2 -translate-x-1/2 z-[60]"
                title={`Display texture: ${displayTextureLabel}. Click to cycle CLEAN / CRT / PHOSPHOR DARK / PHOSPHOR LIGHT.`}
              >
                {displayTextureLabel}
              </button>
              <div className="phosphor-screen-inner phosphor-display-surface">
                <VramBadge
                  manifest={vramCalc.manifest}
                  gpus={gpus}
                  selectedGpuIndices={selectedGpuIndices.length > 0 ? selectedGpuIndices : undefined}
                  onDeviceSelect={(gpuIndex) => {
                    updateParam("device", `GPU-${gpuIndex}`);
                    if (config.split && config.split.toUpperCase() !== "NONE") {
                      updateParam("split", "none");
                    }
                  }}
                  isValidating={vramCalc.isValidating}
                  onValidate={vramCalc.validate}
                  isModelRunning={isModelRunning}
                  activeEngineAlias={activeEngineAlias}
                  activeEnginePort={activeEnginePort}
                  selectedSlotIdx={selectedSlotIdx}
                  supportsFusion={supportsFusion}
                  offloadMode={config["offload_mode"]}
                  onMoeSuggestionClick={() => {
                    updateParam("offload_mode", "moe_optimal");
                  }}
                  modelMeta={model?.metadata}
                />
              </div>
          </div>

          {/* Running Engines — eject panel below display */}
          {onSelectEngine && models && (
            <div className="industrial-eject-panel relative flex-shrink-0">
              <RunningEnginesPanel
                stack={stack}
                models={models}
                selectedSlotIdx={selectedSlotIdx ?? null}
                onSelectEngine={onSelectEngine}
              />
            </div>
          )}
      </div>

      {/* Parameters — scrollable middle section (e-ink panel) */}
      <div className="px-4 py-3 relative flex-1 overflow-y-auto eink-scrollbar eink-panel">

        {allParamsForLaunch.length === 0 ? (
          <div className="text-stealth-muted text-[10px] font-mono opacity-50">NO PARAMS DEFINED</div>
        ) : (() => {
          const allGroups = deriveParamGroups(orderedGroupKeys);
          const mid = Math.ceil(allGroups.length / 2);
          const leftCol = allGroups.slice(0, mid);
          const rightCol = allGroups.slice(mid);

          const renderGroup = (group: ReturnType<typeof deriveParamGroups>[number]) => {
            const groupParams = groupedParams[group.id];
            const isSpecGroup = group.id === "SPECULATIVE-DECODING";

            if (isSpecGroup) {
              const specAllParams = allGroupedParams[group.id] || [];
               if (specAllParams.length === 0) return null;
               const isMtpModel = (model?.metadata?.nextn_predict_layers ?? 0) > 0;
               // Force OFF visually for non-MTP models — params may be unhidden from previous MTP session
               const allHidden = specAllParams.every(d => d.hidden);
               const specActive = isMtpModel ? !allHidden : false;

              return (
                <div key={group.id}>
                  <div className={`nuclear-btn-container ${specFlash ? 'flash' : ''}`}>
                    <span className="font-mono text-stealth-muted/30">SPECULATIVE DECODING</span>
                    <label className={`toggle-switch ${!isMtpModel ? 'opacity-40 pointer-events-none' : ''}`}>
                      <input
                        type="checkbox"
                        className="toggle-input"
                        checked={specActive}
                        disabled={!isMtpModel}
                        onChange={() => {
                          invoke<boolean>("toggle_group_hidden", { providerId: effectiveBackendType, groupId: group.id })
                            .then(() => {
                              setSpecFlash(true);
                              setTimeout(() => setSpecFlash(false), 400);
                              dispatchAppEvent(EVENTS.reloadProviders);
                              dispatchAppEvent(EVENTS.paramConfigChanged);
                            })
                            .catch(err => console.error("[toggle_group_hidden] failed:", err));
                        }}
                      />
                      <span className="toggle-track">
                        <span className="toggle-rust"></span>
                        <span className="toggle-glow"></span>
                        <span className="toggle-thumb">
                          <span className="thumb-inner"></span>
                          <span className="thumb-shine"></span>
                        </span>
                        <span className="toggle-icons">
                          <svg
                            className="icon-off"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <circle cx="12" cy="12" r="5"></circle>
                            <path
                              d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
                            ></path>
                          </svg>
                          <svg className="icon-on" viewBox="0 0 24 24" fill="currentColor">
                            <path
                              d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313-12.454z"
                            ></path>
                          </svg>
                        </span>
                      </span>
                      <span className="toggle-label">
                        <span className="label-off">OFF</span>
                        <span className="label-on">ON</span>
                      </span>
                    </label>
                  </div>

                  {isMtpModel && specActive && (
                    <div className="rounded-sm px-3 py-2 text-[8px] font-mono tracking-wide uppercase flex items-center gap-1 text-nv-green">
                      Speculative mode active
                    </div>
                  )}

                  {isMtpModel && specActive && (
                    <div className="space-y-2.5 mt-2">
                      {specAllParams.map((def, i) => (
                        <div key={paramRowKey(def, i)} className="spec-param-unlock" style={{ opacity: 0 }}>
                          {renderParamRow(def, false, i)}
                        </div>
                      ))}
                    </div>
                  )}

                  {!isMtpModel && (
                    <div className="text-[8px] font-mono text-stealth-muted/30 tracking-wider uppercase mt-1 ml-2">
                      Requires an MTP model for speculative decoding
                    </div>
                  )}

                  {isMtpModel && !specActive && specAllParams.length > 0 && (
                    <div className="text-[8px] font-mono text-stealth-muted/30 tracking-wider uppercase mt-1 ml-2">
                       {specAllParams.length} parameter{specAllParams.length > 1 ? 's' : ''} 🔒locked — activate to configure
                    </div>
                  )}
                </div>
              );
            }

            if (!groupParams || groupParams.length === 0) return null;

            const isCollapsed = collapsedGroups.has(group.id);

            return (
              <div key={group.id}>
                {group.alwaysOpen ? (
                  <div className="text-[8px] font-mono text-[#4ade80] opacity-45 tracking-widest uppercase mb-2 pb-1 border-b border-stealth-border/30">
                    {group.label}
                  </div>
                ) : (
                  <button
                     onClick={() => toggleGroup(group.id)}
                     className="flex items-center gap-1.5 text-[8px] font-mono tracking-widest uppercase mb-2 pb-1 border-b border-stealth-border/30 w-full text-[#4ade80] opacity-45 hover:text-white hover:opacity-100 transition-colors"
                   >
                    <span className="text-[7px]">{isCollapsed ? '▶' : '▼'}</span>
                    {group.label}
                    <span className="opacity-40">({groupParams.length})</span>
                  </button>
                )}

                {!isCollapsed && (
                  <div className="space-y-2.5">
                    {groupParams.map((def, i) => renderParamRow(def, false, i))}
                  </div>
                )}
              </div>
            );
          };

          return (
            <div className="flex gap-4">
              <div className="flex-1 min-w-0 space-y-3">
                {leftCol.map(renderGroup)}
              </div>
              <div className="w-px flex-shrink-0 bg-white/[0.03]" />
              <div className="w-[40%] min-w-[200px] flex-shrink-0 space-y-3">
                {rightCol.map(renderGroup)}
              </div>
            </div>
          );
        })()}

        {/* Test flags */}
        {isPowerUser && (
          <div className={`relative mt-2 border rounded-sm overflow-hidden transition-all duration-200 custom-flags-block ${testFlagsEnabled ? 'custom-flags-active' : ''}`}>
            {/* Top accent bar */}
            <div className="h-[1px] w-full bg-gradient-to-r from-transparent via-amber-600/40 to-transparent" />
            <div className="px-2.5 py-1.5 space-y-1 transition-all duration-200 custom-flags-body">
              {/* Header row */}
              <div className="flex items-center justify-between">
                <label className={`text-[9px] font-mono uppercase tracking-wider transition-all duration-200 custom-flags-label`}>
                  CUSTOM FLAGS
                </label>
                <div className="flex items-center gap-2">
                  {/* Mode toggle */}
                  <button
                    onClick={() => { if (testFlagsEnabled) setTestFlagsMode(m => m === "add" ? "replace" : "add"); }}
                  className={`px-2 py-0.5 text-[7px] font-mono border rounded-sm transition-all duration-150 ${
                       testFlagsEnabled
                         ? testFlagsMode === "add"
                           ? "mode-btn-add"
                           : "mode-btn-replace"
                         : "mode-btn-disabled"
                     }`}
                     disabled={!testFlagsEnabled}
                  >
                    {testFlagsMode === "add" ? "+ APPEND" : "= REPLACE"}
                  </button>

                  {/* ON/OFF toggle */}
                  <label className="toggle-switch">
                    <input
                      type="checkbox"
                      className="toggle-input"
                      checked={testFlagsEnabled}
                      onChange={() => setTestFlagsEnabled(v => !v)}
                    />
                    <span className="toggle-track">
                      <span className="toggle-rust"></span>
                      <span className="toggle-glow"></span>
                      <span className="toggle-thumb">
                        <span className="thumb-inner"></span>
                        <span className="thumb-shine"></span>
                      </span>
                      <span className="toggle-icons">
                        <svg
                          className="icon-off"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <circle cx="12" cy="12" r="5"></circle>
                          <path
                            d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
                          ></path>
                        </svg>
                        <svg className="icon-on" viewBox="0 0 24 24" fill="currentColor">
                          <path
                            d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313-12.454z"
                          ></path>
                        </svg>
                      </span>
                    </span>
                    <span className="toggle-label">
                      <span className="label-off">OFF</span>
                      <span className="label-on">ON</span>
                    </span>
                  </label>
                </div>
              </div>

              {/* Input */}
              <input
                type="text"
                value={testFlags}
                onChange={(e) => setTestFlags(e.target.value)}
                placeholder="-sm layer -smf32 1 ..."
                disabled={!testFlagsEnabled}
               className={`w-full border text-[9px] font-mono px-2.5 py-1 focus:outline-none transition-all duration-150 rounded-sm custom-flags-input ${
                    testFlagsEnabled
                      ? "border-amber-600/30 focus:border-amber-600/50 placeholder:text-stealth-muted/40"
                      : "border-stealth-border/20 text-stealth-muted/30 cursor-not-allowed"
                }`}
              />
            </div>
          </div>
        )}

        {/* Launch button */}
        <div className="px-1 py-2.5">
          <button
            onClick={handleAddToStack}
            disabled={!model || vramCalc.manifest?.scenario === 'HW_LOCKED'}
            className={`w-full ignite-btn px-4 py-3 text-xs font-mono tracking-widest rounded-sm disabled:opacity-40 disabled:cursor-not-allowed config-launch-btn ${isBlazing ? "blazing" : ""}`}
          >
            {isBlazing ? "🔥 LAUNCHED" : "✦ LAUNCH ENGINE ✦"}
          </button>
          <p className="text-[8px] font-mono text-stealth-muted/40 text-center mt-1.5">Ctrl+Enter to launch</p>
        </div>
      </div>
    </div>
  );
}