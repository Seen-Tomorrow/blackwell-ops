import { motion } from "framer-motion";
import { useState, useCallback, useMemo, useEffect } from "react";
import type { ModelEntry, EngineConfig, GpuInfo, VramFitResult, ParamDef, ProviderConfig, ProviderTemplate, StackEntry, VramProfile, FitScanResult } from "../lib/types";
import { invoke } from "@tauri-apps/api/core";
import { useInferenceLauncher } from "../hooks/useInferenceLauncher";

const OVERRIDES_KEY_PREFIX = "BlackOps-admin-catalog-override:";
const BASE_PORT = 9090;

interface EngineConfigPanelProps {
  model: ModelEntry | null;
  gpus: GpuInfo[];
  providers?: ProviderConfig[];
  committedVramMib: number;
  osOverheadMib: number;
  isAdminUnlocked: boolean;
  onLaunch: (config: EngineConfig) => void;
}

export default function EngineConfigPanel(props: EngineConfigPanelProps) {
  const { model, gpus, providers: externalProviders, committedVramMib, osOverheadMib, isAdminUnlocked, onLaunch } = props;

  // ── State ────────────────────────
  const [adminParamDefs, setAdminParamDefs] = useState<ParamDef[]>([]);
  const [config, setConfig] = useState<Record<string, any>>({});
  const [fitScanning, setFitScanning] = useState(false);
  const [fitResult, setFitResult] = useState<FitScanResult | null>(null);
  const [cachedProfile, setCachedProfile] = useState<VramProfile | null>(null);
  const [interpolating, setInterpolating] = useState(false);
  const [estimatedVramMib, setEstimatedVramMib] = useState<number | null>(null);
  const [estimatingVram, setEstimatingVram] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(() => {
    try { return localStorage.getItem("BlackOps-last-provider") || null; } catch { return null; }
  });
  const [testFlags, setTestFlags] = useState(() => {
    try { return localStorage.getItem("BlackOps-testFlags") || ""; } catch { return ""; }
  });
  const [testFlagsEnabled, setTestFlagsEnabled] = useState(() => {
    try { return localStorage.getItem("BlackOps-testFlagsOn") === "1"; } catch { return false; }
  });

  useEffect(() => {
    try { localStorage.setItem("BlackOps-testFlags", testFlags); } catch {}
  }, [testFlags]);

  useEffect(() => {
    try { localStorage.setItem("BlackOps-testFlagsOn", testFlagsEnabled ? "1" : "0"); } catch {}
  }, [testFlagsEnabled]);

  // Effective backend type — provider selector overrides model's default
  const effectiveBackendType = useMemo(() => {
    if (!model) return selectedProvider || "ggml-stable";
    return selectedProvider || (model.backend_type || "ggml-stable");
  }, [model, selectedProvider]);

  // Load admin param definitions when model changes
  useEffect(() => {
    if (!model) {
      setAdminParamDefs([]);
      setCachedProfile(null);
      return;
    }

    const backendType = effectiveBackendType;

    const prov = externalProviders?.find(p => p.id === backendType);
    if (prov && prov.param_definitions) {
      setAdminParamDefs(prov.param_definitions);
    } else {
      invoke<ProviderTemplate>("get_template", { providerId: backendType })
        .then((template: ProviderTemplate) => {
          const tDefs: ParamDef[] = (template.params || []).map((p, i) => ({
            key: p.key, label: p.label, values: p.values as (string | number)[], order: i, hidden: false, defaultValue: p.default,
            config_key: p.config_key, flag: p.flag ?? undefined, ptype: p.ptype, map_id: p.map_id,
            ui_group: p.ui_group, note: p.note, pattern: p.pattern, sub_params: p.sub_params,
          }));
          setAdminParamDefs(tDefs);
        })
        .catch(() => {});
    }

    invoke<VramProfile | null>("fit_get_cached_profile", { modelPath: model.path })
      .then((profile) => {
        if (profile) {
          setCachedProfile(profile);
        }
      })
      .catch(() => {});

    invoke<number>("get_mmproj_size_mib", { modelPath: model.path })
      .then((mmprojMib) => {
        if (model && mmprojMib > 0) {
          // Update parent's model with mmproj size via a custom event or just use it locally
          // For now, we store it in a ref-like state
          setCachedProfile(prev => prev ? { ...prev } : null);
        }
      })
      .catch(() => {});

  }, [model, effectiveBackendType, externalProviders]);

  // Merge admin defs for display
  const mergedParamDefs = useMemo(() => {
    if (!adminParamDefs.length) return [];
    return [...adminParamDefs].sort((a, b) => a.order - b.order);
  }, [adminParamDefs]);

  // Use the inference launcher hook for merge logic
  const launcher = useInferenceLauncher({
    paramDefs: mergedParamDefs,
    currentConfig: config,
    backendType: effectiveBackendType,
    testFlagsRaw: testFlagsEnabled ? testFlags : "",
  });

  // Build config from param defs defaults + user overrides when params change
  const resolveConfig = useCallback((backendType: string, paramDefs: ParamDef[]) => {
    const resolved: Record<string, any> = {};
    for (const p of paramDefs) {
      if (p.values.length > 0) {
        resolved[p.key] = p.defaultValue ?? p.values[0];
      }
    }
    try {
      const stored = localStorage.getItem(OVERRIDES_KEY_PREFIX + backendType);
      if (stored) {
        const overrides: Record<string, any> = JSON.parse(stored);
        Object.assign(resolved, overrides);
      }
    } catch {}
    return resolved;
  }, []);

  useEffect(() => {
    if (!model || mergedParamDefs.length === 0) return;
    const backendType = effectiveBackendType;
    setConfig(resolveConfig(backendType, mergedParamDefs));
  }, [mergedParamDefs, model]);

  // Sync params when Config page updates via param-config-changed event
  useEffect(() => {
    const handler = () => {
      if (!model || mergedParamDefs.length === 0) return;
      const backendType = effectiveBackendType;
      setConfig(resolveConfig(backendType, mergedParamDefs));
    };
    window.addEventListener("param-config-changed", handler);
    return () => window.removeEventListener("param-config-changed", handler);
  }, [model, mergedParamDefs, effectiveBackendType]);

  // Reset config when provider changes
  useEffect(() => {
    if (!model || mergedParamDefs.length === 0) return;
    const backendType = effectiveBackendType;
    setConfig(resolveConfig(backendType, mergedParamDefs));
  }, [effectiveBackendType, mergedParamDefs, model]);

  // ── Port / name helpers ────────────────
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

  // ── FIT CHECK (single source of truth) ────────────────
  const handleFitCheck = useCallback(async () => {
    if (!model) return;

    setFitScanning(true);
    try {
      const result = await invoke<FitScanResult>("fit_scan_model", {
        modelPath: model.path,
        providerId: effectiveBackendType,
        ctxSize: config.CTX || "32K",
        kvQuant: config["KV-Quant"] || "f16",
        device: config.Device || "GPU-0",
        splitMode: config.Split || "NONE",
      });

      setFitResult(result);

      const profile = await invoke<VramProfile | null>("fit_get_cached_profile", { modelPath: model.path });
      if (profile) {
        setCachedProfile(profile);
      }
    } catch (err) {
      console.error("FIT check failed:", err);
    } finally {
      setFitScanning(false);
    }
  }, [model, config, effectiveBackendType]);

  // ── VRAM estimation ────────────────
  const ctxToTokens = useCallback((ctxStr: string): number => {
    switch (ctxStr) {
      case "4K": return 4096;
      case "8K": return 8192;
      case "16K": return 16384;
      case "32K": return 32768;
      case "64K": return 65536;
      case "128K": return 131072;
      case "256K": return 262144;
      case "512K": return 524288;
      case "1M": return 1048576;
      default: return parseInt(ctxStr) || 32768;
    }
  }, []);

  useEffect(() => {
    if (!model || !cachedProfile) {
      setEstimatedVramMib(null);
      return;
    }

    let cancelled = false;
    const ctxTokens = ctxToTokens(config.CTX || "32K");
    const kvQuant = config["KV-Quant"] || "f16";

    setEstimatingVram(true);
    invoke<number | null>("fit_estimate_vram", {
      modelPath: model.path,
      ctx: ctxTokens,
      kvQuant,
    }).then((result) => {
      if (!cancelled && result !== null) {
        setEstimatedVramMib(result as number);
      }
    }).finally(() => {
      if (!cancelled) setEstimatingVram(false);
    });

    return () => { cancelled = true; };
  }, [model, cachedProfile, config.CTX, config["KV-Quant"], config.uBatch, config.Parallel, config.Split, config.Vision, config["Unified-KV"], ctxToTokens]);

  // ── Launch handler ────────────────
  const handleAddToStack = async () => {
    if (!model) return;

    const port = await getNextPort();
    const engineName = await getNextEngineName();

    const backendType = effectiveBackendType;

    const baseConfig: Omit<EngineConfig, 'extra_params'> = {
      alias: engineName,
      model_path: model.path,
      port,
      device: "GPU-0",
      kv_quant: "f16",
      ctx_size: "32K",
      batch: 2048,
      ubatch: 512,
      parallel: 1,
      offload: "ALL",
      offload_mode: "REGULAR",
      split_mode: "NONE",
      vision: "AUTO",
      flash_attn: true,
      jinja: true,
      cont_batching: true,
      metrics: false,
      reasoning: false,
      mmap: true,
      unified_kv: true,
      verbose: false,
      log_timestamps: true,
      backend_type: selectedProvider || "",
    };

    let templateParams: ParamDef[] = [];
    try {
      const template = await invoke<ProviderTemplate>("get_template", { providerId: backendType });
      templateParams = (template.params || []).map((p, i) => ({
        key: p.key, label: p.label, values: p.values as (string | number)[], order: i, hidden: false, defaultValue: p.default,
        config_key: p.config_key, flag: p.flag ?? undefined, ptype: p.ptype, map_id: p.map_id,
        ui_group: p.ui_group, note: p.note, pattern: p.pattern, sub_params: p.sub_params,
      }));
    } catch {}

    for (const tmpl of templateParams) {
      if (!tmpl.config_key) continue;
      const value = config[tmpl.key] ?? config[tmpl.config_key];
      if (value === undefined) continue;

      switch (tmpl.config_key) {
        case "kv_quant": baseConfig.kv_quant = String(value); break;
        case "ctx_size": baseConfig.ctx_size = String(value); break;
        case "batch": baseConfig.batch = typeof value === "number" ? value : parseInt(String(value), 10) || 2048; break;
        case "ubatch": baseConfig.ubatch = typeof value === "number" ? value : parseInt(String(value), 10) || 512; break;
        case "parallel": baseConfig.parallel = typeof value === "number" ? value : parseInt(String(value), 10) || 1; break;
        case "offload": {
          const v = String(value).toUpperCase();
          baseConfig.offload = v === "ALL" ? "ALL" : String(value);
          break;
        }
        case "offload_mode": baseConfig.offload_mode = String(value).toUpperCase() || "REGULAR"; break;
        case "split_mode": baseConfig.split_mode = String(value).toLowerCase() || "none"; break;
        case "vision": {
          const vv = String(value).toUpperCase();
          baseConfig.vision = vv === "OFF" ? "OFF" : "AUTO";
          break;
        }
        case "flash_attn": {
          const fa = String(value).toLowerCase();
          baseConfig.flash_attn = fa !== "off";
          break;
        }
        case "jinja": {
          const jv = String(value).toUpperCase();
          baseConfig.jinja = jv !== "OFF";
          break;
        }
        case "cont_batching": {
          const cb = String(value).toUpperCase();
          baseConfig.cont_batching = cb !== "OFF";
          break;
        }
        case "metrics": {
          const mv = String(value).toUpperCase();
          baseConfig.metrics = mv !== "OFF";
          break;
        }
        case "reasoning": {
          const rv = String(value).toUpperCase();
          baseConfig.reasoning = rv === "ON";
          break;
        }
        case "mmap": {
          const mmv = String(value).toUpperCase();
          baseConfig.mmap = mmv !== "OFF";
          break;
        }
        case "unified_kv": {
          const ukv = String(value).toUpperCase();
          baseConfig.unified_kv = ukv === "ON";
          break;
        }
        case "verbose": {
          const vb = String(value).toLowerCase();
          baseConfig.verbose = vb === "on";
          break;
        }
        case "log_timestamps":
        case "log-timestamps": {
          const lt = String(value).toLowerCase();
          baseConfig.log_timestamps = lt === "on";
          break;
        }
      }
    }

    const fullConfig = launcher.buildInferenceConfig(baseConfig);
    onLaunch(fullConfig);
  };

  // ── VRAM calculations ────────────────
  const totalGpuMib = gpus.reduce((sum, g) => sum + g.memory_total, 0);
  const availableVramMib = Math.max(0, totalGpuMib - osOverheadMib - committedVramMib);
  const availableVramGb = availableVramMib / 1024;

  const applyHeuristics = useCallback((baseVramMib: number): number => {
    let adjusted = baseVramMib;

    const ubatchVal = config.uBatch || 512;
    const batchBuffer = (ubatchVal / 512) * 128;
    adjusted += batchBuffer;

    const parallelVal = config.Parallel || 1;
    if (parallelVal > 1 && config["Unified-KV"] !== "ON") {
      if (cachedProfile) {
        const kvOverhead = baseVramMib - cachedProfile.anchor_a_mib;
        adjusted = cachedProfile.anchor_a_mib + kvOverhead * parallelVal + batchBuffer;
      }
    }

    if (config.Vision !== "OFF" && model?.mmproj) {
      const mmprojMib = model.mmproj_size_mib || 0;
      adjusted += mmprojMib;
    }

    return adjusted;
  }, [config, cachedProfile, model]);

  const getFitStatus = (): { fits: boolean; vramGb: string; vramMib: number } | null => {
    let baseVramMib = 0;
    let isProbe = false;

    if (fitResult) {
      baseVramMib = fitResult.vram_mib;
      isProbe = true;
    }
    else if (estimatedVramMib !== null && estimatedVramMib > 0) {
      baseVramMib = estimatedVramMib;
    }
    else if (model) {
      const nameLower = model.name.toLowerCase();
      let baseSize: number;
      if (nameLower.includes("405b")) baseSize = 405;
      else if (nameLower.includes("70b") || nameLower.includes("72b")) baseSize = 70;
      else if (nameLower.includes("34b") || nameLower.includes("32b")) baseSize = 34;
      else if (nameLower.includes("13b") || nameLower.includes("14b")) baseSize = 13;
      else if (nameLower.includes("8b") || nameLower.includes("7b")) baseSize = 7.5;
      else if (nameLower.includes("2b") || nameLower.includes("1.5b")) baseSize = 2;
      else baseSize = 7.5;

      const quantFactor: Record<string, number> = {
        "q8_0": 0.7, f16: 1.0, bf16: 1.0, f32: 2.0,
        "q5_0": 0.6, "q5_1": 0.6,
        "q4_0": 0.5, "q4_1": 0.5, "q4_k_s": 0.5, "q4_k_m": 0.5, "q4_k": 0.5,
        "q3_k": 0.4, q2_k: 0.35,
      };

      const factor = quantFactor[model.quant] || 0.5;
      baseVramMib = (baseSize * factor + 2) * 1024;
    } else {
      return null;
    }

    const adjustedVramMib = isProbe ? baseVramMib : applyHeuristics(baseVramMib);
    const fits = adjustedVramMib <= availableVramMib;

    return {
      fits,
      vramGb: `${(adjustedVramMib / 1024).toFixed(1)} GB`,
      vramMib: adjustedVramMib,
    };
  };

  const fitStatus = getFitStatus();
  const isGoldenSeal = fitStatus?.fits && (!!fitResult || (estimatedVramMib !== null && estimatedVramMib > 0));

  const handleParamChange = useCallback((key: string, value: any) => {
    setConfig((prev) => ({ ...prev, [key]: value }));

    if (!model) return;
    const backendType = selectedProvider || "ggml-stable";
    try {
      const overridesKey = OVERRIDES_KEY_PREFIX + backendType;
      const stored = localStorage.getItem(overridesKey);
      const overrides: Record<string, any> = stored ? JSON.parse(stored) : {};
      overrides[key] = value;
      localStorage.setItem(overridesKey, JSON.stringify(overrides));
    } catch {}

    const vramKeys = ["CTX", "KV-Quant", "uBatch", "Parallel", "Split", "Vision", "Unified-KV"];
    if (vramKeys.includes(key)) {
      setInterpolating(true);
      setTimeout(() => setInterpolating(false), 400);
    }
  }, [model, selectedProvider, mergedParamDefs]);

  // ── VRAM bar helper ────────────────
  const renderVramBar = () => {
    if (!fitStatus) return null;
    const pct = Math.min(100, (fitStatus.vramMib / availableVramMib) * 100);
    const barClass = fitStatus.fits ? "vram-bar-fit" : pct > 85 ? "vram-bar-warn" : "vram-bar-overflow";

    return (
      <div className="space-y-2.5">
        {/* Top row: status label + FIT CHECK button */}
        <div className="flex items-center justify-between">
          <span className={`text-[10px] font-mono ${fitStatus.fits ? "text-nv-green" : "text-telemetry-red"} glitch-text`}>
            {isGoldenSeal && !estimatingVram
              ? "✦ VERIFIED FIT"
              : isGoldenSeal && estimatingVram
                ? "✦ CALCULATING..."
                : fitStatus.fits
                  ? "◉ ESTIMATED VRAM"
                  : "◉ OVERFLOW"}
          </span>
          <button
            onClick={handleFitCheck}
            disabled={fitScanning || !model}
            className="px-3 py-1 text-[9px] font-mono border neon-border-cyan text-telemetry-cyan hover:text-nv-green hover:border-nv-green/60 transition-all duration-150 disabled:opacity-40 rounded-sm"
          >
            {fitScanning ? "▲ SCANNING..." : gpus.length === 0 ? "NO GPUs" : "➸ FIT CHECK"}
          </button>
        </div>
        {/* VRAM readings — cyan, double size */}
        <span className="text-[12px] font-mono text-telemetry-cyan">
          {fitStatus.vramGb} / {availableVramGb.toFixed(0)} GB
          {committedVramMib > 0 && ` (${(committedVramMib / 1024).toFixed(0)}GB committed)`}
        </span>
        {/* Progress bar — double height */}
        <div className="vram-bar-track">
          <motion.div
            className={`vram-bar-fill ${barClass}`}
            initial={{ width: "0%" }}
            animate={{ width: `${pct}%` }}
            transition={{ duration: 1, ease: "easeOut" }}
          />
        </div>
        {cachedProfile && (
          <div className="flex gap-3 text-[9px] font-mono text-stealth-muted">
            <span>A(8K): {(cachedProfile.anchor_a_mib / 1024).toFixed(1)}GB</span>
            <span>B(128K/f16): {(cachedProfile.anchor_b_mib / 1024).toFixed(1)}GB</span>
            <span>C(128K/q4_0): {(cachedProfile.anchor_c_mib / 1024).toFixed(1)}GB</span>
          </div>
        )}
      </div>
    );
  };

  // ── Render ────────────────
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

  return (
    <div className="flex flex-col h-full overflow-hidden">
      {/* Model identity header */}
      <div className="px-4 py-3 border-b section-divider relative flex-shrink-0">
        <div className="flex items-center gap-2 mb-1">
          {model.vision && (
            <span className="text-[9px] font-mono text-telemetry-cyan px-1.5 py-0.5 border border-telemetry-cyan/30 bg-telemetry-cyan/5" title="Vision capable">V</span>
          )}
          <motion.span
            key={model.name}
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="text-xs font-mono text-white truncate glitch-text"
          >
            {model.name}
          </motion.span>
        </div>
        <div className="flex items-center gap-2 text-[9px] font-mono text-stealth-muted">
          <span>{model.author}</span>
          <span>·</span>
          <span className="text-nv-green">{model.quant}</span>
          <span>·</span>
          <span>{model.size_str}</span>
        </div>
      </div>

      {/* Provider selector */}
      {externalProviders && externalProviders.length > 0 && (
        <div className="px-4 py-3 border-b section-divider relative flex-shrink-0">
          <label className="text-[9px] font-mono text-neon-magenta tracking-widest uppercase block mb-2 glitch-text">
            ◆ ENGINE PROVIDER
          </label>
          <div className="flex gap-1.5 flex-wrap">
            {externalProviders.filter(p => p.enabled).map((p) => (
              <button
                key={p.id}
                onClick={() => { setSelectedProvider(p.id); try { localStorage.setItem("BlackOps-last-provider", p.id); } catch {} }}
                className={`px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${
                  selectedProvider === p.id
                    ? "provider-pill-active"
                    : "provider-pill"
                }`}
              >
                {p.display_name || p.id}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* VRAM forecast */}
      <div className="px-4 py-3 border-b section-divider relative flex-shrink-0">
        <label className="text-[9px] font-mono text-telemetry-cyan tracking-widest uppercase block mb-2 glitch-text">
          ◆ VRAM FORECAST
        </label>
        {renderVramBar()}
      </div>

      {/* Params — scrollable middle section */}
      <div className="px-4 py-3 border-b section-divider relative flex-1 overflow-y-auto cyber-scrollbar">
        <label className="text-[9px] font-mono text-electric-blue tracking-widest uppercase block mb-3 glitch-text">
          ◆ PARAMETERS
        </label>
        {mergedParamDefs.length === 0 ? (
          <div className="text-stealth-muted text-[10px] font-mono opacity-50">NO PARAMS DEFINED</div>
        ) : (
          <div className="space-y-2.5">
            {mergedParamDefs.filter(d => !d.hidden).map((def) => {
              const baseValues = (def.values || []).filter(v => !(def.hiddenValues || []).some(hv => String(hv) === String(v)));
              const isAdminParam = adminParamDefs.some(d => d.key === def.key);
              const currentValue = config[def.key] ?? config[def.config_key || def.key];

              return (
                <div key={def.key} className="flex items-center gap-2">
                  <span className="text-[9px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider truncate" title={def.label}>
                    {def.label}
                  </span>
                  {!isAdminParam && (
                    <span className="text-[7px] font-mono text-yellow-400 bg-yellow-400/15 px-1 py-0 rounded-sm flex-shrink-0">CUSTOM</span>
                  )}
                  <div className="flex gap-1 flex-wrap flex-1 min-w-0">
                    {baseValues.filter((v: any) => !(v?._hidden)).map((val) => (
                      <button
                        key={`${def.key}-${val}`}
                        onClick={() => handleParamChange(def.key, val)}
                        className={`px-2 py-0.5 text-[9px] font-mono rounded-sm ${
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
            })}
          </div>
        )}

        {/* Test flags — below params in scroll */}
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

        {/* Launch button — below params in scroll */}
        <div className="px-1 py-4">
          <motion.button
            onClick={handleAddToStack}
            disabled={!model}
            whileHover={{ scale: 1.01 }}
            whileTap={{ scale: 0.98 }}
            className="w-full ignite-btn px-4 py-3 text-xs font-mono tracking-widest rounded-sm disabled:opacity-40 disabled:cursor-not-allowed"
          >
            ✦ IGNITE ENGINE
          </motion.button>
        </div>
      </div>
    </div>
  );
}
