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
import { useState, useCallback, useEffect, useMemo } from "react";
import type { ModelEntry, EngineConfig, GpuInfo, ParamDef, ProviderConfig, ProviderTemplate, StackEntry, SystemInfo } from "../lib/types";
import { invoke } from "@tauri-apps/api/core";
import VramBadge from "./VramBadge";
import VramDiagnostics from "./VramDiagnostics";
import { useScenarioEvaluator } from "../hooks/useScenarioEvaluator";
import { useConfigResolver } from "../hooks/useConfigResolver";

const BASE_PORT = 9090;

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

  // ── Derived state ───────────────────────────────────────────────────────────
  const effectiveBackendType = useMemo(() => {
    if (!model) return selectedProvider || "ggml-stable";
    return selectedProvider || (model.backend_type || "ggml-stable");
  }, [model, selectedProvider]);

  // Dynamic Device param — generated from GPU topology, docked to hardware block
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
      dock: "hardware",
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

    // Check if MOE suggestion is active for this param (Offload_Mode)
    const moeSuggestionActive = vramCalc.manifest?.moeSuggestion?.wouldFit && 
                                 def.key === "Offload_Mode" &&
                                 currentValue !== "MOE_OPTIMAL";

    const isDevice = def.key === "Device";

    return (
      <div key={def.key} data-param-row className={`flex items-center gap-2 ${isLocked ? 'opacity-50' : ''}`}>
        <span
          className={`font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider truncate ${isDevice ? 'text-[11px]' : 'text-[9px]'} ${
            moeSuggestionActive ? 'text-orange-400 animate-pulse' : ''
          }`}
          title={def.label}
        >
          {def.label}
          {moeSuggestionActive && <span className="ml-1">💡</span>}
        </span>

        <div className={`flex gap-1 flex-wrap flex-1 min-w-0 ${
          moeSuggestionActive ? 'ring-2 ring-orange-400/30 rounded-sm -mx-1 px-1' : ''
        }`}>
          {baseValues.filter((v: any) => !(v?._hidden)).map((val) => (
            <button
              key={`${def.key}-${val}`}
              tabIndex={isLocked ? -1 : 0}
              onClick={() => {
                if (!isLocked) updateParam(def.key, val);
              }}
              className={`px-2 py-0.5 font-mono rounded-sm focus:outline-none ${isDevice ? 'text-[11px] px-3 py-1' : 'text-[9px]'} ${
                (currentValue === val || config[def.config_key || def.key] === val) ||
                (typeof currentValue === 'string' && typeof val === 'string' && 
                 currentValue.toLowerCase() === String(val).toLowerCase())
                  ? "value-chip-active"
                  : "value-chip"
              } ${moeSuggestionActive && String(val) === "MOE_OPTIMAL" ? 'ring-2 ring-orange-400 shadow-[0_0_8px_rgba(251,149,0,0.4)]' : ''}`}
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
  const getNextPort = useCallback(async (): Promise<number> => {
    try {
      const stack = await invoke<StackEntry[]>("get_stack_status");
      for (let i = 0; i < 4; i++) {
        const expectedPort = BASE_PORT + i;
        const inUse = stack.some(s => s.port === expectedPort && s.status !== "IDLE");
        if (!inUse) return expectedPort;
      }
    } catch {}
    let maxPort = BASE_PORT - 1;
    for (let i = 0; i < 4; i++) {
      maxPort = Math.max(maxPort, BASE_PORT + i);
    }
    return maxPort + 1;
  }, []);

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
    const engineName = await getNextEngineName();

    // Build typed EngineConfig for Rust's launch_engine command
    const fullConfig: EngineConfig = {
      alias: engineName,
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
    };

    // Trigger blaze animation
    setIsBlazing(true);
    setTimeout(() => setIsBlazing(false), 800);

    // Dispatch success event for toast + status bar
    window.dispatchEvent(new CustomEvent("blackops-launch-success", { detail: { alias: engineName, port } }));

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
          <label className="text-[9px] font-mono text-neon-magenta tracking-widest uppercase block mb-2 glitch-text">
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
      <div className="px-4 py-3 border-b section-divider relative flex-shrink-0">
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

      {/* ── Docked Hardware Block ─────────────── */}
      {dockedParams["hardware"] && dockedParams["hardware"].length > 0 && (
        <div className="hw-section-green border-b section-divider relative flex-shrink-0">
          <div className="px-4 py-3">
            <div className="flex gap-4">
              {/* Left: param rows (~full width now) */}
              <div className="space-y-2.5 flex-1 min-w-0">
                {dockedParams["hardware"].map(def => renderParamRow(def))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Memory Forecast Diagnostics — admin only, between HW block and PARAMETERS */}
      {isAdminUnlocked && (
        <VramDiagnostics modelPath={model?.path ?? null} />
      )}

      {/* Parameters — scrollable middle section */}
      <div className="px-4 py-3 border-b section-divider relative flex-1 overflow-y-auto cyber-scrollbar">
          <label className="text-[9px] font-mono text-white tracking-widest uppercase block mb-3 glitch-text">
            PARAMETERS
          </label>

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
          <div className="px-1 py-3 border-t section-divider relative mt-3">
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-[9px] font-mono text-yellow-400 uppercase tracking-wider glitch-text">TEST FLAGS</label>
              <button
                onClick={() => setTestFlagsEnabled(v => !v)}
                className={`px-2 py-0.5 text-[8px] font-mono border rounded-sm transition-all duration-150 ${
                  testFlagsEnabled
                    ? "bg-telemetry-red/20 text-telemetry-red border-telemetry-red/60"
                    : "text-stealth-muted border-stealth-border hover:text-white hover:border-stealth-muted"
                }`}
              >
                {testFlagsEnabled ? "☐ ON" : "■ OFF"}
              </button>
            </div>
            <input
              type="text"
              value={testFlags}
              onChange={(e) => setTestFlags(e.target.value)}
              placeholder="-sm layer -smf32 1 ..."
              disabled={!testFlagsEnabled}
              className={`w-full bg-transparent border text-[9px] font-mono px-2 py-1.5 focus:outline-none transition-colors placeholder:text-stealth-muted/50 rounded-sm ${
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
            {isBlazing ? "🔥 LAUNCHED" : "✦ IGNITE ENGINE"}
          </motion.button>
          <p className="text-[8px] font-mono text-stealth-muted/40 text-center mt-1.5">Ctrl+Enter to launch</p>
        </div>
      </div>
    </div>
  );
}