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
import { useVramCalculator } from "../hooks/useVramCalculator";
import { useConfigResolver } from "../hooks/useConfigResolver";

const BASE_PORT = 9090;

const PARAM_GROUPS: { id: string; label: string; alwaysOpen: boolean; elevatable?: boolean }[] = [
  { id: 'Core', label: 'CORE', alwaysOpen: true },
  { id: 'Performance', label: 'PERFORMANCE', alwaysOpen: true },
  { id: 'Multi-GPU', label: 'MULTI-GPU', alwaysOpen: false, elevatable: true },
  { id: 'Feature Flags', label: 'FEATURE FLAGS', alwaysOpen: false },
];

interface EngineConfigPanelProps {
  model: ModelEntry | null;
  gpus: GpuInfo[];
  providers?: ProviderConfig[];
  committedVramMib: number;
  isAdminUnlocked: boolean;
  systemInfo?: SystemInfo | null;
  onLaunch: (config: EngineConfig) => void;
}

export default function EngineConfigPanel(props: EngineConfigPanelProps) {
  const { model, gpus, providers: externalProviders, committedVramMib, isAdminUnlocked, systemInfo, onLaunch } = props;

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

  // Collapsible group state — persisted across sessions
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('BlackOps-collapsed-groups');
      return saved ? new Set(JSON.parse(saved)) : new Set(['Multi-GPU', 'Feature Flags']);
    } catch { return new Set(['Multi-GPU', 'Feature Flags']); }
  });

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      try { localStorage.setItem('BlackOps-collapsed-groups', JSON.stringify([...next])); } catch {}
      return next;
    });
  }, []);

  // Multi-GPU elevation: model exceeds single GPU VRAM (needs split to run)
  const shouldElevateMultiGpu = useMemo(() => {
    if (!model || gpus.length < 2) return false;
    const sizeMatch = model.size_str?.match(/([\d.]+)\s*GB/i);
    if (!sizeMatch) return false;
    const modelSizeMib = parseFloat(sizeMatch[1]) * 1024;
    const singleGpuVram = gpus[0].memory_total_manufactured || gpus[0].memory_total;
    return modelSizeMib > singleGpuVram;
  }, [model?.path, model?.size_str, gpus.length]);

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

  const mergedParamDefs = useMemo(() => {
    return [...adminParamDefs].sort((a, b) => a.order - b.order);
  }, [adminParamDefs]);

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
  
  const vramCalc = useVramCalculator({
    model,
    config: { ...config, providerId: effectiveBackendType },
    gpus,
    availableMib: availableVramMib,
    systemInfo,
  });

  // RAM offload needed: auto-offload calculation (accurate) or fallback to raw size check
  const needsRamOffload = useMemo(() => {
    if (vramCalc.autoOffload) {
      return vramCalc.autoOffload.ramLayers > 0;
    }
    if (!model || gpus.length === 0) return false;
    const sizeMatch = model.size_str?.match(/([\d.]+)\s*GB/i);
    if (!sizeMatch) return false;
    const modelSizeMib = parseFloat(sizeMatch[1]) * 1024;
    const totalVramMib = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);
    return modelSizeMib > totalVramMib;
  }, [model?.path, vramCalc.autoOffload, gpus.length]);

  // Extracted param row renderer for reuse (inline + elevated Multi-GPU)
  const renderParamRow = useCallback((def: ParamDef) => {
    // Merge values + userAddedValues (user-added params from ConfigPage admin edit)
    const seenVals = new Set((def.values || []).map(v => String(v)));
    const allValues = [...(def.values || []), ...(def.userAddedValues || []).filter(v => !seenVals.has(String(v)))];
    const baseValues = allValues.filter(v => !(def.hiddenValues || []).some(hv => String(hv) === String(v)));
    const isAdminParam = adminParamDefs.some(d => d.key === def.key);
    const currentValue = config[def.key] ?? config[def.config_key || def.key];

    return (
      <div key={def.key} data-param-row className="flex items-center gap-2">
        <span
          className="text-[9px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider truncate"
          title={def.label}
        >
          {def.label}
        </span>

        {!isAdminParam && (
          <span className="text-[7px] font-mono text-yellow-400 bg-yellow-400/15 px-1 py-0 rounded-sm flex-shrink-0">
            CUSTOM
          </span>
        )}

        <div className="flex gap-1 flex-wrap flex-1 min-w-0">
          {baseValues.filter((v: any) => !(v?._hidden)).map((val) => (
            <button
              key={`${def.key}-${val}`}
              tabIndex={0}
              onClick={() => updateParam(def.key, val)}
              className={`px-2 py-0.5 text-[9px] font-mono rounded-sm focus:outline-none ${
                currentValue === val || config[def.config_key || def.key] === val
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
  }, [adminParamDefs, config, updateParam]);

  // Grouped params
  const groupedParams = useMemo(() => {
    const groups: Record<string, ParamDef[]> = {};
    for (const def of mergedParamDefs) {
      if (def.hidden) continue;
      const groupId = def.ui_group || 'Feature Flags';
      if (!groups[groupId]) groups[groupId] = [];
      groups[groupId].push(def);
    }
    return groups;
  }, [mergedParamDefs]);

  // Multi-GPU params for elevation
  const multiGpuParams = useMemo(() => {
    return mergedParamDefs.filter(d => d.ui_group === 'Multi-GPU' && !d.hidden);
  }, [mergedParamDefs]);

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
      offload: vramCalc.autoOffload?.nGpuLayers ?? ((config.Offload || "ALL").toUpperCase() === "ALL" ? "ALL" : String(config.Offload)),
      offload_mode: (config["Offload-Mode"] || "REGULAR").toString().toUpperCase(),
      split_mode: (config.Split || "NONE").toString().toLowerCase(),
      vision: config.Vision?.toUpperCase() === "OFF" ? "OFF" : "AUTO",
      flash_attn: config["Flash-Attn"]?.toString().toLowerCase() !== "off",
      jinja: config.Jinja?.toString().toUpperCase() !== "OFF",
      cont_batching: config["Cont-Batch"]?.toString().toUpperCase() !== "OFF",
      metrics: config.Metrics?.toString().toUpperCase() === "ON",
      reasoning: config.Reasoning?.toString().toUpperCase() === "ON",
      mmap: config.MMap?.toString().toUpperCase() !== "OFF",
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
          result={vramCalc.vramDisplay || null}
          gpus={gpus}
          gpuDistribution={vramCalc.gpuDistribution}
          ramEstimate={vramCalc.ramEstimate}
          availableVramGb={displayVramGb}
          committedVramMib={committedVramMib}
          onFitCheck={vramCalc.triggerFitCheck}
          isScanning={vramCalc.isScanning}
          autoOffload={vramCalc.autoOffload}
          shouldShowRam={needsRamOffload}
          modelName={model.name}
          modelSizeStr={model.size_str}
        />
      </div>

      {/* ── Dynamic Multi-GPU Elevation ─────────────── */}
      {shouldElevateMultiGpu && multiGpuParams.length > 0 && (
        <div className={`px-4 py-3 border-b section-divider relative flex-shrink-0 ${config.Split?.toUpperCase() === "NONE" ? "opacity-50" : needsRamOffload ? "bg-telemetry-red/5 border-telemetry-red/30" : "bg-telemetry-cyan/5 border-telemetry-cyan/30"}`}>
          <label className={`text-[9px] font-mono tracking-widest uppercase block mb-2 glitch-text ${needsRamOffload ? "text-telemetry-red" : "text-telemetry-cyan"}`}>
            ⚡ MULTI-GPU REQUIRED — Model exceeds single GPU VRAM
          </label>
          <div className="space-y-2.5">
            {multiGpuParams.map(def => renderParamRow(def))}
          </div>
        </div>
      )}

      {/* Parameters — scrollable middle section */}
      <div className="px-4 py-3 border-b section-divider relative flex-1 overflow-y-auto cyber-scrollbar">
        <label className="text-[9px] font-mono text-electric-blue tracking-widest uppercase block mb-3 glitch-text">
          PARAMETERS
        </label>

        {mergedParamDefs.length === 0 ? (
          <div className="text-stealth-muted text-[10px] font-mono opacity-50">NO PARAMS DEFINED</div>
        ) : (
          <div className="space-y-3">
            {PARAM_GROUPS.map(group => {
              const groupParams = groupedParams[group.id];
              if (!groupParams || groupParams.length === 0) return null;

              // Skip Multi-GPU inline when elevated above
              if (group.elevatable && shouldElevateMultiGpu) return null;

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
            disabled={!model || vramCalc.vramDisplay?.status === 'critical'}
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