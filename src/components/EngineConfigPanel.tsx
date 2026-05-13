/**
 * Engine Config Panel — Model-specific parameter configuration and launch control
 *
 * Responsibilities:
 * - Display model identity (name, author, quant, size)
 * - Provider selection pills
 * - VRAM estimation with dirty math + tiered scan system
 * - Parameter value selection chips
 * - Launch button to add engine to stack
 */

import { motion } from "framer-motion";
import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ModelEntry, EngineConfig, GpuInfo, ParamDef, ProviderConfig, ProviderTemplate, StackEntry, SystemInfo } from "../lib/types";
import { invoke } from "@tauri-apps/api/core";
import VramBadge from "./VramBadge";
import VramDiagnostics from "./VramDiagnostics";
import { useScenarioEvaluator } from "../hooks/useScenarioEvaluator";
import { useConfigResolver } from "../hooks/useConfigResolver";

const DEFAULT_BASE_PORT = 9090;

type EnvProfile = "vanguard" | "fresh" | "stable";

const ENV_META: Record<EnvProfile, { label: string; color: string; cuda: string; vs: string }> = {
  vanguard: { label: "VANGUARD", color: "cyan",    cuda: "13.2", vs: "VS Build Tools 2026 (v18)" },
  fresh:    { label: "FRESH",    color: "amber",   cuda: "13.1", vs: "VS Build Tools 2022" },
  stable:   { label: "STABLE",   color: "nv-green", cuda: "12.8", vs: "VS Build Tools 2022" },
};

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
  isAdminUnlocked: boolean;
  systemInfo?: SystemInfo | null;
  stack: StackEntry[];
  onLaunch: (config: EngineConfig) => void;
  isModelRunning?: boolean;
  activeEngineAlias?: string;
  activeEnginePort?: number;
}

export default function EngineConfigPanel(props: EngineConfigPanelProps) {
  const { model, gpus, providers: externalProviders, committedVramMib, isAdminUnlocked, systemInfo, stack, onLaunch, isModelRunning, activeEngineAlias, activeEnginePort } = props;

  // ── State ───────────────────────────────────────────────────────────────
  const [adminParamDefs, setAdminParamDefs] = useState<ParamDef[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(() => {
    try { return localStorage.getItem("BlackOps-last-provider") || null; } catch { return null; }
  });
  const [testFlags, setTestFlags] = useState(() => {
    try { return localStorage.getItem("BlackOps-testFlags") || ""; } catch { return ""; }
  });
  const [testFlagsEnabled, setTestFlagsEnabled] = useState(() => {
    try { return localStorage.getItem("BlackOps-testFlagsOn") === "1"; } catch { return false; }
  });

  // Test flags mode: "add" (prepend to config) or "replace" (bypass all params)
  const [testFlagsMode, setTestFlagsMode] = useState<"add" | "replace">(() => {
    try { return localStorage.getItem("BlackOps-testFlagsMode") === "add" ? "add" : "replace"; } catch { return "replace"; }
  });

  // Engine alias — per-model persistent, auto-populated if empty
  const [aliasInput, setAliasInput] = useState<string>("");
  const aliasInitializedRef = useRef<{ modelPath: string; done: boolean }>({ modelPath: "", done: false });

  // Binary profile selection — persisted per-provider, defaults to vanguard
  const [selectedBinaryProfile, setSelectedBinaryProfile] = useState<EnvProfile>(() => {
    try { return (localStorage.getItem("BlackOps-binary-profile") as EnvProfile) || "vanguard"; } catch { return "vanguard"; }
  });

  // Blaze animation state — triggers fire effect on launch button
  const [isBlazing, setIsBlazing] = useState(false);

  // Collapsible group state — persisted across sessions, defaults to collapsed for non-always-open groups
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('BlackOps-collapsed-groups');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch { return new Set(); }
  });

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      try { localStorage.setItem('BlackOps-collapsed-groups', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  // Persist test flags
  useEffect(() => {
    try { localStorage.setItem("BlackOps-testFlags", testFlags); } catch {}
  }, [testFlags]);
  useEffect(() => {
    try { localStorage.setItem("BlackOps-testFlagsOn", testFlagsEnabled ? "1" : "0"); } catch {}
  }, [testFlagsEnabled]);

  // Persist test flags mode
  useEffect(() => {
    try { localStorage.setItem("BlackOps-testFlagsMode", testFlagsMode); } catch {}
  }, [testFlagsMode]);

  // Persist binary profile selection
  useEffect(() => {
    try { localStorage.setItem("BlackOps-binary-profile", selectedBinaryProfile); } catch {}
  }, [selectedBinaryProfile]);

  // Auto-populate alias when model changes — per-model persistence
  useEffect(() => {
    if (!model) return;
    const key = `BlackOps-engine-alias:${model.path}`;
    const initKey = aliasInitializedRef.current.modelPath;
    
    // Only initialize once per model path to avoid overwriting user input on HMR
    if (initKey !== model.path) {
      try {
        const saved = localStorage.getItem(key);
        if (saved) {
          setAliasInput(saved);
        } else {
          // Auto-generate suggestion
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
            aliasInitializedRef.current = { modelPath: model.path, done: true };
          }).catch(() => {
            setAliasInput("ENGINE_1");
            aliasInitializedRef.current = { modelPath: model.path, done: true };
          });
        }
      } catch {
        aliasInitializedRef.current = { modelPath: model.path, done: true };
      }
    }
  }, [model?.path]);

  // Save alias to localStorage when it changes (after initial load)
  useEffect(() => {
    if (!model || !aliasInitializedRef.current.done) return;
    try { localStorage.setItem(`BlackOps-engine-alias:${model.path}`, aliasInput); } catch {}
  }, [aliasInput, model?.path]);

  // ── Derived state ───────────────────────────────────────────────────────────
  const effectiveBackendType = useMemo(() => {
    if (!model) return selectedProvider || "ggml-stable";
    return selectedProvider || (model.backend_type || "ggml-stable");
  }, [model, selectedProvider]);

  // Dynamic Device param — generated from GPU topology, docked to runtime block
  const deviceParamDef: ParamDef | null = useMemo(() => {
    if (gpus.length === 0) return null;
    const alreadyExists = adminParamDefs.some(d => d.key === "Device");
    if (alreadyExists) return null;
    return {
      key: "Device",
      label: "Device",
      config_key: "device",
      flag: null,
      ptype: "arg_select" as const,
      values: gpus.map((_, i) => `GPU-${i}`),
      order: -1,
      hidden: false,
      defaultValue: "GPU-0",
      dock: "runtime",
      ui_group: "Core",
      note: "Select which GPU to use for inference.",
    };
  }, [gpus.length, adminParamDefs]);

  const mergedParamDefs = useMemo(() => {
    const defs = deviceParamDef ? [deviceParamDef, ...adminParamDefs] : [...adminParamDefs];
    return defs.sort((a, b) => a.order - b.order);
  }, [adminParamDefs, deviceParamDef]);

  // Docked params: extracted from merged defs by dock key
  const dockedParams = useMemo(() => {
    const docks: Record<string, ParamDef[]> = {};
    for (const def of mergedParamDefs) {
      if (!def.dock || def.hidden) continue;
      if (!docks[def.dock]) docks[def.dock] = [];
      docks[def.dock].push(def);
    }
    return docks;
  }, [mergedParamDefs]);

  // ── Hooks ────────────────────────────────────────────────────────────────
  const { config, updateParam } = useConfigResolver({
    model,
    paramDefs: mergedParamDefs,
    backendType: effectiveBackendType,
  });

  // Display value — manufactured capacity, no deductions (what users see)
  const displayVramMib = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);

  // Calculation value — real available for fit decisions
  const availableVramMib = Math.max(0, gpus.reduce((sum, g) => sum + g.memory_free, 0) - committedVramMib);
  
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

  // Extracted param row renderer for reuse
  const renderParamRow = useCallback((def: ParamDef, isLocked?: boolean) => {
    // Merge values + userAddedValues (user-added params from ConfigPage admin edit)
    const seenVals = new Set((def.values || []).map(v => String(v)));
    const allValues = [...(def.values || []), ...(def.userAddedValues || []).filter(v => !seenVals.has(String(v)))];
    const baseValues = allValues.filter(v => !(def.hiddenValues || []).some(hv => String(hv) === String(v)));
    const currentValue = config[def.key] ?? config[def.config_key || def.key];

    return (
      <div key={def.key} data-param-row className={`flex items-center gap-2 ${isLocked ? 'opacity-50' : ''}`}>
        <span
          className="font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider truncate text-[9px]"
          title={def.label}
        >
          {def.label}
        </span>

        <div className="flex gap-1 flex-wrap flex-1 min-w-0">
          {baseValues.filter((v: any) => !(v?._hidden)).map((val) => (
            <button
              key={`${def.key}-${val}`}
              tabIndex={isLocked ? -1 : 0}
              onClick={() => {
                if (!isLocked) updateParam(def.key, val);
              }}
              className={`px-2 py-0.5 text-[9px] font-mono rounded-sm focus:outline-none ${
                (currentValue === val || config[def.config_key || def.key] === val) ||
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
  }, [adminParamDefs, config, updateParam, vramCalc.manifest]);

  // Grouped params — skip docked (rendered separately)
  const groupedParams = useMemo(() => {
    const groups: Record<string, ParamDef[]> = {};
    for (const def of mergedParamDefs) {
      if (def.hidden || def.dock) continue;
      const groupId = def.ui_group || 'Feature Flags';
      if (!groups[groupId]) groups[groupId] = [];
      groups[groupId].push(def);
    }
    return groups;
  }, [mergedParamDefs]);

  // Ordered group keys: custom provider order > template insertion order
  const orderedGroupKeys = useMemo(() => {
    const allGroups = Object.keys(groupedParams);
    const currentProv = externalProviders?.find(p => p.id === effectiveBackendType);
    if (currentProv?.groupOrder && currentProv.groupOrder.length > 0) {
      return [...currentProv.groupOrder.filter(g => allGroups.includes(g)), ...allGroups.filter(g => !currentProv.groupOrder!.includes(g))];
    }
    return allGroups;
  }, [groupedParams, externalProviders, effectiveBackendType]);

  // ── Load param definitions when model/provider changes ───────────────────
  useEffect(() => {
    if (!model) {
      setAdminParamDefs([]);
      return;
    }

    const backendType = effectiveBackendType;

    const prov = externalProviders?.find(p => p.id === backendType);
    if (prov && prov.param_definitions) {
      setAdminParamDefs(prov.param_definitions || []);
    } else {
      invoke<ProviderTemplate>("get_template", { providerId: backendType })
        .then((template: ProviderTemplate) => {
          const tDefs: ParamDef[] = (template.params || []).map((p, i) => ({
            key: p.key,
            label: p.label,
            values: p.values as (string | number)[],
            order: i,
            hidden: false,
            defaultValue: p.default,
            config_key: p.config_key,
            flag: p.flag ?? undefined,
            ptype: p.ptype,
            map_id: p.map_id,
            ui_group: p.ui_group,
            note: p.note,
            pattern: p.pattern,
            sub_params: p.sub_params,
            dock: p.dock || undefined,
          }));
           setAdminParamDefs(tDefs);
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
    window.addEventListener("blackops-launch-engine", handler);
    return () => window.removeEventListener("blackops-launch-engine", handler);
  }, [model, config, effectiveBackendType]);

  // ── Port / name helpers ────────────────────────────────────────────────────
  const getBasePort = useCallback((): number => {
    const bp = config.Base_Port ?? config.base_port;
    if (typeof bp === 'number') return bp;
    const parsed = parseInt(String(bp), 10);
    return isNaN(parsed) ? DEFAULT_BASE_PORT : parsed;
  }, [config.Base_Port, config.base_port]);

  const getNextPort = useCallback(async (): Promise<number> => {
    const basePort = getBasePort();
    try {
      const stack = await invoke<StackEntry[]>("get_stack_status");
      for (let i = 0; i < 4; i++) {
        const expectedPort = basePort + i;
        const inUse = stack.some(s => s.port === expectedPort && s.status !== "IDLE");
        if (!inUse) return expectedPort;
      }
    } catch {}
    let maxPort = basePort - 1;
    for (let i = 0; i < 4; i++) {
      maxPort = Math.max(maxPort, basePort + i);
    }
    return maxPort + 1;
  }, [getBasePort]);

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

    const port = await getNextPort();
    
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

    // Build typed EngineConfig for Rust's launch_engine command
    const fullConfig: EngineConfig = {
      alias: finalAlias,
      model_path: model.path,
      port,
      device: config.Device || "GPU-0",
      kv_quant: config["KV-Quant"] || "f16",
      ctx_size: config.CTX || "32K",
      batch: typeof config.Batch === 'number' ? config.Batch : parseInt(String(config.Batch), 10) || 2048,
      ubatch: typeof config.uBatch === 'number' ? config.uBatch : parseInt(String(config.uBatch), 10) || 512,
      parallel: typeof config.Parallel === 'number' ? config.Parallel : parseInt(String(config.Parallel), 10) || 1,
      // Auto-offload: use calculated layers from metadata, fallback to config value
      offload: vramCalc.manifest?.gpuLayers != null && vramCalc.manifest.ramLayers > 0 ? String(vramCalc.manifest.gpuLayers) : (config.Offload === "all" || !config.Offload ? "ALL" : String(config.Offload)),
      offload_mode: config["Offload_Mode"] || "regular",
      split_mode: config.Split || "none",
      vision: config.Vision?.toUpperCase() === "OFF" ? "OFF" : "AUTO",
      flash_attn: config["Flash-Attn"]?.toString().toLowerCase() !== "off",
      jinja: config.Jinja?.toString().toUpperCase() !== "OFF",
      cont_batching: config["Cont-Batching"]?.toString().toUpperCase() !== "OFF",
      metrics: config.Metrics?.toString().toUpperCase() === "ON",
      reasoning: config.Reasoning?.toString().toUpperCase() === "ON",
      mmap: config.MMAP?.toString().toUpperCase() !== "OFF",
      verbose: false,
      log_timestamps: true,
      backend_type: effectiveBackendType,
      binary_profile: selectedBinaryProfile,
    };

    // Inject test flags into extra_params if enabled
    if (testFlagsEnabled && testFlags.trim()) {
      const testArgs = testFlags.trim().split(/\s+/).filter(Boolean);
      fullConfig.extra_params = testFlagsMode === "replace"
        ? { __test_args: testArgs } // REPLACE: bypass all params, use only raw flags
        : { __test_args_add: testArgs }; // ADD: append to end of config command (overrides template)
    }

    // Trigger blaze animation
    setIsBlazing(true);
    setTimeout(() => setIsBlazing(false), 800);

    // Dispatch success event for toast + status bar
    window.dispatchEvent(new CustomEvent("blackops-launch-success", { detail: { alias: finalAlias, port } }));

    onLaunch(fullConfig);
  };

  // ── Empty state ──────────────────────────────────────────────────────────
  if (!model) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-stealth-muted font-mono">
        <motion.div
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ duration: 0.5 }}
          className="text-center"
        >
          <div className="text-3xl mb-3 text-stealth-muted/40">⬡</div>
          <p className="text-xs tracking-widest uppercase">SELECT A MODEL</p>
          <p className="text-[9px] mt-1 opacity-50">Choose from the catalog to configure</p>
        </motion.div>
      </div>
    );
  }

  const displayVramGb = displayVramMib / 1024;

  return (
    <div className="flex flex-col h-full overflow-hidden" data-config-panel>
      {/* Provider selector */}
      {externalProviders && externalProviders.length > 0 && (
        <div className="px-4 py-3 border-b section-divider relative flex-shrink-0">
          <label className="text-[9px] font-mono tracking-widest uppercase block mb-2 glitch-text" style={{ color: '#4ade80' }}>
            ENGINE PROVIDER
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {externalProviders.filter(p => p.enabled).map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedProvider(p.id);
                  try { localStorage.setItem("BlackOps-last-provider", p.id); } catch {}
                }}
                className={`px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${
                  selectedProvider === p.id
                    ? "provider-pill-active"
                    : "provider-pill"
                }`}
              >
                {p.display_name || p.id}<span className="ml-1 opacity-40 text-[8px]">({(p.param_definitions || []).length})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* VRAM Section */}
      <div className="vram-section px-4 py-3 border-b section-divider relative flex-shrink-0">
        <VramBadge
          manifest={vramCalc.manifest}
          gpus={gpus}
          selectedGpuIndices={selectedGpuIndices.length > 0 ? selectedGpuIndices : undefined}
          onDeviceSelect={(gpuIndex) => {
            // Clicking a GPU resets Split to none (single-GPU mode)
            updateParam("Device", `GPU-${gpuIndex}`);
            if (config.Split && config.Split.toUpperCase() !== "NONE") {
              updateParam("Split", "none");
            }
          }}
          isValidating={vramCalc.isValidating}
          onValidate={vramCalc.validate}
          isModelRunning={isModelRunning}
          activeEngineAlias={activeEngineAlias}
          activeEnginePort={activeEnginePort}
          offloadMode={config["Offload_Mode"]}
          onMoeSuggestionClick={() => {
            // Auto-switch to MOE_OPTIMAL when user clicks the suggestion badge
            updateParam("Offload_Mode", "moe_optimal");
          }}
          modelMeta={model?.metadata}
        />
      </div>

      {/* ── Runtime Docked Block (2-column) ─────────────── */}
      {dockedParams["runtime"] && dockedParams["runtime"].length > 0 && (() => {
        const runtimeDocked = dockedParams["runtime"];
        const leftParams = runtimeDocked.filter(d => d.ui_group !== "Runtime Config");
        const rightParams = runtimeDocked.filter(d => d.ui_group === "Runtime Config");
        const currentProvider = externalProviders?.find(p => p.id === effectiveBackendType);
        const availableProfiles: EnvProfile[] = Object.keys(ENV_META) as EnvProfile[];
        const builtProfiles = currentProvider?.buildInfoPerEnv
          ? (Object.keys(currentProvider.buildInfoPerEnv) as EnvProfile[]).filter(k => ENV_META[k])
          : [];

        return (
          <div className="mono-panel border-b section-divider relative flex-shrink-0">
            {/* Section header — outside the green bg, on dark */}
            <div className="relative z-[2] px-4 pt-3 pb-1" style={{ background: '#0c120a' }}>

            </div>
            <div className="relative z-[2] px-4 py-3 pr-6">
              <div className="flex gap-4">
                {/* Left: Multi-GPU params */}
                {leftParams.length > 0 && (
                  <div className="space-y-2.5 flex-1 min-w-0">
                    <label className="text-[8px] font-mono tracking-widest uppercase block mb-2">
                      MULTI-GPU
                    </label>
                    {leftParams.map(def => renderParamRow(def))}
                  </div>
                )}

                {/* Subtle vertical separator */}
                <div className="w-px flex-shrink-0 bg-green-400/10" />

                {/* Right: Runtime Config */}
                <div className="w-[40%] min-w-[200px] flex-shrink-0">
                  <label className="text-[8px] font-mono tracking-widest uppercase block mb-2">
                    RUNTIME CONFIG
                  </label>

                  {/* Base_Port chips from genesis */}
                  {rightParams.length > 0 && (
                    <div className="space-y-2.5 mb-3">
                      {rightParams.map(def => renderParamRow(def))}
                    </div>
                  )}

                  {/* Engine Alias input */}
                  <div className="flex items-center gap-2 mb-2.5">
                    <span className="font-mono text-[9px] w-24 flex-shrink-0 uppercase tracking-wider truncate mono-label">
                      Alias
                    </span>
                    <input
                      type="text"
                      value={aliasInput}
                      onChange={(e) => setAliasInput(e.target.value)}
                      className="flex-1 min-w-0 bg-green-400/5 border border-green-400/20 text-[9px] font-mono px-2 py-0.5 rounded-sm focus:outline-none focus:border-green-400/40 placeholder:text-green-400/30"
                      style={{ color: '#4ade80' }}
                      placeholder="auto..."
                    />
                  </div>

                  {/* Binary Profile badges */}
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-[9px] w-24 flex-shrink-0 uppercase tracking-wider truncate mono-label">
                      Profile
                    </span>
                    <div className="flex gap-1">
                      {availableProfiles.map(profile => {
                        const meta = ENV_META[profile];
                        const hasBuild = builtProfiles.includes(profile);
                        const isSelected = selectedBinaryProfile === profile;
                        return (
                          <button
                            key={profile}
                            onClick={() => setSelectedBinaryProfile(profile)}
                            disabled={!hasBuild}
                            className={`px-2 py-0.5 text-[8px] font-mono rounded-sm border transition-all ${
                              isSelected
                                ? "mono-badge-active"
                                : hasBuild
                                  ? "mono-badge-inactive hover:border-green-400/50 hover:text-[#66ff66]"
                                  : "opacity-25 cursor-not-allowed mono-badge-disabled"
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
          </div>
        );
      })()}

      {/* Memory Forecast Diagnostics — admin only, between HW block and PARAMETERS */}
      {isAdminUnlocked && (
        <VramDiagnostics modelPath={model?.path ?? null} manifest={vramCalc.manifest} />
      )}

      {/* Parameters — scrollable middle section (e-ink panel) */}
      <div className="px-4 py-3 border-b relative flex-1 overflow-y-auto cyber-scrollbar eink-panel">

        {mergedParamDefs.length === 0 ? (
          <div className="text-stealth-muted text-[10px] font-mono opacity-50">NO PARAMS DEFINED</div>
        ) : (
          <div className="space-y-3">
            {deriveParamGroups(orderedGroupKeys).map(group => {
              const groupParams = groupedParams[group.id];
              if (!groupParams || groupParams.length === 0) return null;



              const isCollapsed = collapsedGroups.has(group.id);

              return (
                <div key={group.id}>
                  {/* Group header */}
                  {group.alwaysOpen ? (
                    <div className="text-[8px] font-mono text-stealth-muted/60 tracking-widest uppercase mb-2 pb-1 border-b border-stealth-border/30">
                      {group.label}
                    </div>
                  ) : (
                    <button
                      onClick={() => toggleGroup(group.id)}
                      className="flex items-center gap-1.5 text-[8px] font-mono tracking-widest uppercase mb-2 pb-1 border-b border-stealth-border/30 w-full text-stealth-muted hover:text-white transition-colors"
                    >
                      <span className="text-[7px]">{isCollapsed ? '▶' : '▼'}</span>
                      {group.label}
                      <span className="opacity-40">({groupParams.length})</span>
                    </button>
                  )}

                  {/* Param rows */}
                  {!isCollapsed && (
                    <div className="space-y-2.5">
                      {groupParams.map(def => renderParamRow(def))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Test flags */}
        {isAdminUnlocked && (
          <div className="px-1 py-3 border-t section-divider relative mt-3 bg-yellow-500">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[9px] font-mono text-black uppercase tracking-wider glitch-text">CUSTOM FLAGS</label>
              <div className="flex gap-1.5">
                {/* ADD/REPLACE mode toggle */}
                <button
                  onClick={() => setTestFlagsMode(m => m === "add" ? "replace" : "add")}
                  className={`relative flex items-center justify-center px-4 py-0.5 text-[8px] font-mono border rounded-full transition-all duration-150 ${
                    testFlagsEnabled
                      ? (testFlagsMode === "add"
                        ? "bg-green-600 text-white border-green-600"
                        : "bg-red-600 text-white border-red-600")
                      : "bg-transparent text-black/40 border-black/30 disabled:opacity-30 disabled:cursor-not-allowed"
                  }`}
                  disabled={!testFlagsEnabled}
                >
                  {testFlagsMode === "add" ? "//APPEND to above user config" : "//REPLACE user config with this"}
                </button>
                {/* ON/OFF toggle */}
                <button
                  onClick={() => setTestFlagsEnabled(v => !v)}
                  className={`relative flex items-center justify-center w-12 px-4 py-0.5 text-[8px] font-mono border rounded-full transition-all duration-150 ${
                    testFlagsEnabled
                      ? "bg-black text-white border-black"
                      : "bg-transparent text-black/40 border-black/30 hover:text-black hover:border-black"
                  }`}
                >
                  <span className={`absolute block w-2 h-2 rounded-full transition-all duration-150 ${testFlagsEnabled ? "bg-white left-1" : "bg-black right-1"}`}></span>
                  {testFlagsEnabled ? "ON" : "OFF"}
                </button>
              </div>
            </div>
            <input
              type="text"
              value={testFlags}
              onChange={(e) => setTestFlags(e.target.value)}
              placeholder="-sm layer -smf32 1 ..."
              disabled={!testFlagsEnabled}
              className={`w-full bg-black border text-[9px] font-mono px-2 py-1.5 focus:outline-none transition-colors placeholder:text-stealth-muted/50 rounded-sm ${
                 testFlagsEnabled
                   ? "border-telemetry-red/40 text-white"
                   : "border-stealth-border disabled:opacity-30 disabled:cursor-not-allowed"
               }`}
            />
          </div>
        )}

        {/* Launch button */}
        <div className="px-1 py-4">
          <motion.button
            onClick={handleAddToStack}
            disabled={!model || vramCalc.manifest?.scenario === 'HW_LOCKED'}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            className={`w-full ignite-btn px-4 py-3 text-xs font-mono tracking-widest rounded-sm disabled:opacity-40 disabled:cursor-not-allowed ${isBlazing ? "blazing" : ""}`}
          >
            {isBlazing ? "🔥 LAUNCHED" : "✦ LAUNCH ENGINE ✦"}
          </motion.button>
          <p className="text-[8px] font-mono text-stealth-muted/40 text-center mt-1.5">Ctrl+Enter to launch</p>
        </div>
      </div>
    </div>
  );
}