import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry, EngineConfig, GpuInfo, StackEntry, SystemInfo, VramManifest, FitScanResult } from "../lib/types";
import { evaluate, committedSlotsFromStack, committedStackKey, parseCtx, type ScenarioInput, type FitPoint } from "../services/vram/scenarios/scenarios_factory";
import { attachMemorySource, MEMORY_SOURCE_LABELS } from "../services/vram/memorySource";
import { gpuMemoryBucketKey, vramManifestSnapshotEqual } from "../lib/telemetryGpu";
import { tomMtpBlocked, toastTomMtpSkip, TOM_MTP_SKIP_MESSAGE } from "../lib/tomMtp";
import { EVENTS } from "../lib/events";
import { useTauriListen } from "./useTauriListen";

type ProbeSession = {
  modelPath: string;
  configKey: string;
  validatedVramMib: number;
  validatedGpuBreakdownMib?: number[];
  validatedHostMib?: number;
  validatedComponentsMib?: VramManifest["validatedComponentsMib"];
  fitProbeMeasuredAt: string;
};

function scenarioConfigKey(
  config: Record<string, unknown>,
  autoVramLaunch: boolean,
  memoryMode: "full_auto" | "assisted",
): string {
  return `${config.device || ""}|${config.split || ""}|${config["offload_mode"] || ""}|${config.ctx || ""}|${config["kv_quant"] || ""}|${config.batch ?? ""}|${config.ubatch ?? ""}|${config["flash_attn"] || ""}|${config.vision || ""}|${config["unified_kv"] || ""}|${config["rope_scaling"] || ""}|${config["rope_scale"] ?? ""}|${config.gpu_sync || ""}|${config.cache_ram || ""}|${config.spec_type || ""}|${config.backend_type || ""}|fit=${autoVramLaunch ? "1" : "0"}|mode=${memoryMode}`;
}

function probeScenarioFields(session: ProbeSession | null, modelPath: string, configKey: string) {
  if (!session || session.modelPath !== modelPath || session.configKey !== configKey) {
    return {};
  }
  return {
    fitProbeVramMib: session.validatedVramMib,
    fitProbeHostMib: session.validatedHostMib,
    fitProbeGpuBreakdownMib: session.validatedGpuBreakdownMib,
  };
}

function attachProbeManifest(
  manifest: VramManifest,
  session: ProbeSession,
  input: ScenarioInput,
): VramManifest {
  return attachMemorySource(
    {
      ...manifest,
      validatedVramMib: session.validatedVramMib,
      validatedGpuBreakdownMib: session.validatedGpuBreakdownMib,
      validatedHostMib: session.validatedHostMib,
      validatedComponentsMib: session.validatedComponentsMib,
      fitProbeMeasuredAt: session.fitProbeMeasuredAt,
    },
    input,
  );
}

interface LearnedVramFitAttempt {
  vram_mib: number;
  host_mib?: number;
  gpu_breakdown_mib?: number[];
}

interface LearnedLaunchSnapshot {
  parser_id: string;
  reference_profile?: string;
  vram_mib: number;
  gpu_breakdown_mib: number[];
  gpu_components_mib?: VramManifest["validatedComponentsMib"];
  host_mib: number;
  host_pinned_mib?: number;
  mtp_context_mib?: number;
  vision_mib?: number;
  prompt_cache_limit_mib?: number;
  effective_ctx?: number;
}

interface LearnedVramEntry {
  vram_mib: number;
  measured_at?: string;
  gpu_breakdown_mib?: number[];
  host_mib?: number;
  gpu_components_mib?: VramManifest["validatedComponentsMib"];
  launch_snapshot?: LearnedLaunchSnapshot;
  fit_attempts?: LearnedVramFitAttempt[];
}

interface UseScenarioEvaluatorProps {
  model: ModelEntry | null;
  config: Record<string, any>;
  gpus: GpuInfo[];
  stack: StackEntry[];
  systemInfo?: SystemInfo | null;
  autoVramLaunch?: boolean;
  fullAutoMode?: boolean;
  fitStyle?: string;
}

// Shared debug emission helper to avoid duplicating IPC calls to Blackwell Output Console
function emitScenarioDebug(
  modelName: string,
  modelMeta: any,
  fps: FitPoint[] | null,
  scenario: string,
  vramWeightsGb: number,
  vramKvGb: number,
  vramOverheadGb: number,
  totalNeedGb: number,
  gpuAllocations: any[],
  gpuLayers: number,
  ramLayers: number,
  validatedVramMib: number | null,
  formulaVramTotalGb: number | null,
  validatedComponentsMib: any[] | null,
  uiTemplate: any,
  engineConfig: EngineConfig,
  validatedGb?: number,
  memorySourceLabel?: string,
) {
  const lines: string[] = [];
  lines.push(`[SCENARIO] Model: ${modelName} | Meta: ${modelMeta ? 'YES' : 'NO'} | Arch: ${modelMeta?.architecture || '?'} | Layers: ${modelMeta?.n_layer ?? '?'} | Params: ${modelMeta?.total_params_str || '?'} | Size: ${(modelMeta?.file_size_bytes / (1024**3)).toFixed(1)}G`);

  if (fps && fps.length > 0) {
    const labels = fps.map(fp => fp.label.toLowerCase());
    const hasBase = labels.some(l => l.includes('base'));
    const hasQuant = labels.some(l => l.includes('quant') || l.includes('q4') || l.includes('q8') || l.includes('f16'));
    const hasCtxSweep = labels.filter(l => l.includes('ctx')).length >= 2;
    const missingLabels: string[] = [];
    if (!hasBase) missingLabels.push('base');
    if (!hasQuant) missingLabels.push('quant variants');
    if (!hasCtxSweep) missingLabels.push('ctx sweep');
    lines.push(`[SCENARIO] FIT: ${fps.length}pts loaded${missingLabels.length > 0 ? ' | MISSING: ' + missingLabels.join(', ') : ''}`);
  } else {
    lines.push('[SCENARIO] FIT: NO SCAN DATA');
  }

  lines.push(`[SCENARIO] Scenario: ${scenario} | W:${vramWeightsGb.toFixed(1)}G KV:${vramKvGb.toFixed(1)}G OH:${vramOverheadGb.toFixed(1)}G Total:${totalNeedGb.toFixed(1)}G`);

  if (memorySourceLabel) {
    lines.push(`[SCENARIO] SOURCE: ${memorySourceLabel}`);
  }

  const allocText = gpuAllocations.map((a: any) => {
    const pct = ((a.projectedLoadGb / a.vramManufacturedGb) * 100).toFixed(0);
    return `GPU-${a.gpuIndex}=${a.projectedLoadGb.toFixed(1)}G(${pct}%)`;
  }).join(', ');
  lines.push(`[SCENARIO] GPU: ${allocText} | Layers: ${gpuLayers} GPU / ${ramLayers} RAM`);

  if (validatedVramMib) {
    const vGb = validatedVramMib / 1024;
    const formulaTotalGb = formulaVramTotalGb || totalNeedGb;
    const delta = ((vGb - formulaTotalGb) / formulaTotalGb * 100);
    lines.push(`[SCENARIO] Validated: ${vGb.toFixed(1)}G (${delta > 0 ? '+' : ''}${delta.toFixed(1)}% from formula)`);
  } else {
    lines.push('[SCENARIO] Validated: NO (formula only)');
  }

  if (validatedComponentsMib && validatedComponentsMib.length > 0) {
    const compText = validatedComponentsMib.map((c: any, i: number) => `GPU${i}:W=${c.model_mib} KV=${c.ctx_mib} C=${c.compute_mib}`).join(' | ');
    lines.push(`[SCENARIO] Components: ${compText}`);
  }

  const fa = uiTemplate ? 'on' : 'off';
  const ep = engineConfig.extra_params || {};
  lines.push(`[SCENARIO] Config: CTX=${ep.ctx} KVQ=${ep["kv_quant"]} Batch=${ep.batch} Par=${ep.parallel} Split=${ep.split} FA=${fa} Offload=${ep["offload_mode"]}`);

  // Emit to Blackwell Output Console via IPC (fire-and-forget)
  void invoke("emit_to_blackwell_console", {
    category: "debug",
    content: lines.join("\n"),
    style: "Warning",
  });
}

export function useScenarioEvaluator({
  model,
  config,
  gpus,
  stack,
  systemInfo,
  autoVramLaunch = false,
  fullAutoMode = true,
  fitStyle = "",
}: UseScenarioEvaluatorProps) {
  const [manifest, setManifest] = useState<VramManifest | null>(null);
  const manifestRef = useRef<VramManifest | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const commitManifest = useCallback((next: VramManifest | null) => {
    if (vramManifestSnapshotEqual(manifestRef.current, next)) return;
    manifestRef.current = next;
    setManifest(next);
  }, []);

  // GPU count/capacity — stable across NVML noise.
  const gpuTopologyKey = gpus.length > 0
    ? `${gpus.length}-${gpus.reduce((s, g) => s + (g.memory_total_manufactured || g.memory_total), 0)}`
    : "0";

  // Track last topology key to skip redundant re-evals from telemetry noise.
  const isMountedRef = useRef(false);
  const lastTopologyRef = useRef<string>("");
  const lastGpuMemoryRef = useRef<string>("");
  const lastModelPathRef = useRef("");
  const lastConfigKeyRef = useRef<string>("");
  const lastStackKeyRef = useRef<string>("");
  const fitPointsRef = useRef<FitPoint[] | null>(null);
  const learnedVramRef = useRef<number | null>(null);
  const learnedHostRef = useRef<number | null>(null);
  const learnedGpuBreakdownRef = useRef<number[] | null>(null);
  const learnedGpuComponentsRef = useRef<VramManifest["validatedComponentsMib"]>(null);
  const learnedLaunchProfileRef = useRef<string | undefined>(undefined);
  const learnedMeasuredAtRef = useRef<string | undefined>(undefined);
  const lastFitModelPathRef = useRef("");
  const learnedFetchGenRef = useRef(0);
  const learnedFetchPendingRef = useRef(false);
  const autoVramLaunchRef = useRef(autoVramLaunch);
  const fullAutoModeRef = useRef(fullAutoMode);
  const fitStyleRef = useRef(fitStyle);
  autoVramLaunchRef.current = autoVramLaunch;
  fullAutoModeRef.current = fullAutoMode;
  fitStyleRef.current = fitStyle;
  const lastScenarioDebugModelRef = useRef("");
  const lastScenarioDebugNameRef = useRef("");
  const probeSessionRef = useRef<ProbeSession | null>(null);
  const hadSysInfoRef = useRef(systemInfo != null);
  const runEvaluationRef = useRef<() => void>(() => {});
  const scheduleEvaluationRef = useRef<() => void>(() => {});

  // Unstable refs: these objects change every render/poll but shouldn't churn deps.
  // Read from refs inside the callback to get latest values without re-creating the callback.
  const gpusRef = useRef(gpus);
  const stackRef = useRef(stack);
  const systemInfoRef = useRef(systemInfo);
  const configRef = useRef(config);
  gpusRef.current = gpus;
  stackRef.current = stack;
  systemInfoRef.current = systemInfo;
  configRef.current = config;

  // Config fingerprint — only keys that affect scenario evaluation.
  // Changes here trigger re-eval (HW buttons, param chips). Telemetry noise doesn't touch these.
  const memoryMode = fullAutoMode ? "full_auto" : "assisted";
  const configKey = scenarioConfigKey(config, autoVramLaunch, memoryMode);

  useEffect(() => {
    probeSessionRef.current = null;
  }, [configKey, model?.path]);

  // Stack fingerprint — changes when committed engines (RUNNING/LOADING) start/stop or VRAM shifts.
  const stackKey = committedStackKey(stack);
  // NVML used MiB buckets — finer when engines run (external bar), coarser when idle forecast only.
  const gpuMemoryKey = gpuMemoryBucketKey(gpus, stackKey === "" ? 512 : 128);

  // System info loaded flag — triggers re-eval when it arrives (was null before).
  const sysInfoLoaded = systemInfo != null;

  const runEvaluation = useCallback(() => {
    const curGpus = gpusRef.current;
    const curStack = stackRef.current;
    const curSystemInfo = systemInfoRef.current;
    const curConfig = configRef.current;

    if (!model || curGpus.length === 0) {
      commitManifest(null);
      return;
    }

    // Model must have GGUF metadata scanned (from cache)
    if (!model.metadata) {
      void invoke("emit_to_blackwell_console", {
        category: "debug",
        content: `[ScenarioEvaluator] No cached GGUF metadata for ${model.path.split("/").pop()}`,
        style: "Warning",
      });
      commitManifest(null);
      return;
    }

    setIsEvaluating(true);

    const engineConfig: EngineConfig = {
      alias: "",
      model_path: model.path,
      port: 0,
      backend_type: curConfig.backend_type,
      extra_params: { ...curConfig },
    };

    const runningSlots = committedSlotsFromStack(curStack);

    const sysInfo = curSystemInfo || {
      total_memory_mib: 0,
      available_memory_mib: 0,
      total_memory_manufactured_mib: 0,
    };

    const curConfigKey = scenarioConfigKey(
      curConfig,
      autoVramLaunchRef.current,
      fullAutoModeRef.current ? "full_auto" : "assisted",
    );
    const session = probeSessionRef.current;
    const input: ScenarioInput = {
      modelMeta: model.metadata,
      engineConfig,
      gpus: curGpus,
      runningSlots,
      ramAvailableGb: sysInfo.available_memory_mib / 1024,
      ramManufacturedGb: sysInfo.total_memory_manufactured_mib / 1024,
      mmprojSizeMib: model.mmproj_size_mib,
      fitPoints: fitPointsRef.current || undefined,
      autoVramLaunch: autoVramLaunchRef.current,
      fullAutoMode: fullAutoModeRef.current,
      fitStyle: fitStyleRef.current,
      learnedVramMib: learnedVramRef.current ?? undefined,
      learnedHostMib: learnedHostRef.current ?? undefined,
      learnedGpuBreakdownMib: learnedGpuBreakdownRef.current ?? undefined,
      learnedGpuComponentsMib: learnedGpuComponentsRef.current ?? undefined,
      learnedLaunchProfile: learnedLaunchProfileRef.current,
      learnedMeasuredAt: learnedMeasuredAtRef.current,
      ...probeScenarioFields(session, model.path, curConfigKey),
    };

    try {
      let result = evaluate(input);
      if (session && session.modelPath === model.path && session.configKey === curConfigKey) {
        result = attachProbeManifest(result, session, input);
      }
      commitManifest(result);

      // Scenario debug emission (deduped by model path + scenario name)
      if (model.path !== lastScenarioDebugModelRef.current || result.scenario !== lastScenarioDebugNameRef.current) {
        const modelName = model.path.split(/[\/\\]/).pop() || model.path;
        const fps = fitPointsRef.current;
        emitScenarioDebug(
          modelName, model.metadata, fps, result.scenario,
          result.vramWeightsGb, result.vramKvGb, result.vramOverheadGb,
          result.vramTotalGb, result.gpuAllocations, result.gpuLayers, result.ramLayers,
          result.validatedVramMib, result.formulaVramTotalGb, result.validatedComponentsMib,
          result.style.uiTemplate, engineConfig, undefined,
          result.memorySource ? MEMORY_SOURCE_LABELS[result.memorySource.kind] : undefined,
        );
        lastScenarioDebugModelRef.current = model.path;
        lastScenarioDebugNameRef.current = result.scenario;
      }
    } catch (e) {
      console.error("[ScenarioEvaluator]", e);
      commitManifest(null);
    } finally {
      setIsEvaluating(false);
    }
  }, [model, commitManifest]);

  runEvaluationRef.current = runEvaluation;

  const scheduleEvaluation = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (learnedFetchPendingRef.current) {
        scheduleEvaluationRef.current();
        return;
      }
      runEvaluationRef.current();
    }, 150);
  }, []);

  scheduleEvaluationRef.current = scheduleEvaluation;

  useEffect(() => {
    // Reset on unmount to handle Strict Mode double-mount correctly
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      isMountedRef.current = false;
    };
  }, []);

  const refreshLearnedVram = useCallback(() => {
    if (!model) {
      learnedVramRef.current = null;
      learnedHostRef.current = null;
      learnedGpuBreakdownRef.current = null;
      learnedGpuComponentsRef.current = null;
      learnedLaunchProfileRef.current = undefined;
      learnedMeasuredAtRef.current = undefined;
      learnedFetchPendingRef.current = false;
      return;
    }
    const fetchGen = ++learnedFetchGenRef.current;
    learnedFetchPendingRef.current = true;
    const curConfig = configRef.current;
    void invoke<LearnedVramEntry | null>("get_learned_vram", {
      modelPath: model.path,
      providerId: curConfig.backend_type || "ggml-master",
      ctx: String(parseCtx(curConfig.ctx ?? "32768")),
      kvQuant: String(curConfig["kv_quant"] ?? "f16"),
      device: String(curConfig.device ?? "GPU-0"),
      split: String(curConfig.split ?? "none"),
      memoryMode: fullAutoModeRef.current ? "full_auto" : "assisted",
      offloadMode: String(curConfig["offload_mode"] ?? "regular"),
      specType: String(curConfig.spec_type ?? "none"),
      cacheRam: String(curConfig.cache_ram ?? "0"),
    })
      .then((entry) => {
        if (fetchGen !== learnedFetchGenRef.current) return;
        const snap = entry?.launch_snapshot;
        const lastAttempt = entry?.fit_attempts?.length
          ? entry.fit_attempts[entry.fit_attempts.length - 1]
          : undefined;
        learnedVramRef.current = snap?.vram_mib ?? entry?.vram_mib ?? null;
        learnedHostRef.current =
          snap?.host_mib ?? entry?.host_mib ?? lastAttempt?.host_mib ?? null;
        learnedGpuBreakdownRef.current =
          snap?.gpu_breakdown_mib ?? entry?.gpu_breakdown_mib ?? lastAttempt?.gpu_breakdown_mib ?? null;
        learnedGpuComponentsRef.current =
          snap?.gpu_components_mib ?? entry?.gpu_components_mib ?? null;
        learnedLaunchProfileRef.current = snap?.reference_profile;
        learnedMeasuredAtRef.current = entry?.measured_at;
      })
      .catch(() => {
        if (fetchGen !== learnedFetchGenRef.current) return;
        learnedVramRef.current = null;
        learnedHostRef.current = null;
        learnedGpuBreakdownRef.current = null;
        learnedGpuComponentsRef.current = null;
        learnedLaunchProfileRef.current = undefined;
        learnedMeasuredAtRef.current = undefined;
      })
      .finally(() => {
        if (fetchGen !== learnedFetchGenRef.current) return;
        learnedFetchPendingRef.current = false;
        scheduleEvaluationRef.current();
      });
  }, [model?.path, configKey]);

  // Fetch learned VRAM when model/config fingerprint changes — gate eval until settled
  useEffect(() => {
    refreshLearnedVram();
  }, [refreshLearnedVram]);

  // Re-fetch after launch learn persists (model loaded / exit tables) without switching models
  useTauriListen<{ model_path?: string; provider_id?: string }>(
    "learned-vram-changed",
    () => {
      refreshLearnedVram();
    },
    [refreshLearnedVram],
  );

  // Exit-table persist can land just before slot-cleared — short delay catches first-run learn.
  useTauriListen<{ slot: number }>(
    "slot-cleared",
    () => {
      window.setTimeout(() => refreshLearnedVram(), 300);
    },
    [refreshLearnedVram],
  );

  const loadFitScanPoints = useCallback(() => {
    if (!model) {
      fitPointsRef.current = null;
      lastFitModelPathRef.current = "";
      return;
    }
    lastFitModelPathRef.current = model.path;
    const providerId = (config.backend_type as string) || "ggml-master";
    invoke("get_fit_scan_points", { modelPath: model.path, providerId })
      .then((result: any) => {
        fitPointsRef.current = result ?? null;
        scheduleEvaluationRef.current();
      })
      .catch(() => {
        fitPointsRef.current = null;
      });
  }, [model?.path, config.backend_type]);

  useEffect(() => {
    loadFitScanPoints();
  }, [loadFitScanPoints]);

  useEffect(() => {
    const onFitCacheChanged = () => loadFitScanPoints();
    window.addEventListener(EVENTS.fitScanCacheChanged, onFitCacheChanged);
    return () => window.removeEventListener(EVENTS.fitScanCacheChanged, onFitCacheChanged);
  }, [loadFitScanPoints]);

  useEffect(() => {
    if (!model || gpus.length === 0) {
      commitManifest(null);
      lastTopologyRef.current = "";
      lastGpuMemoryRef.current = "";
      lastModelPathRef.current = "";
      lastConfigKeyRef.current = "";
      lastStackKeyRef.current = "";
      fitPointsRef.current = null;
      return;
    }

    // Force evaluation on first mount (Strict Mode safe via isMountedRef)
    const isFirstMount = !isMountedRef.current;
    if (isFirstMount) {
      isMountedRef.current = true;
    }

    // Skip re-eval only when model, topology, config, AND stack are all stable.
    const modelChanged = model.path !== lastModelPathRef.current || isFirstMount;
    const topologyChanged = gpuTopologyKey !== lastTopologyRef.current || isFirstMount;
    const gpuMemoryChanged = gpuMemoryKey !== lastGpuMemoryRef.current || isFirstMount;
    const configChanged = configKey !== lastConfigKeyRef.current || isFirstMount;
    const stackChanged = stackKey !== lastStackKeyRef.current || isFirstMount;
    const sysInfoJustLoaded = sysInfoLoaded && !hadSysInfoRef.current;
    hadSysInfoRef.current = sysInfoLoaded;

    if (!modelChanged && !topologyChanged && !gpuMemoryChanged && !configChanged && !stackChanged && !sysInfoJustLoaded) {
      return;
    }
    lastModelPathRef.current = model.path;
    lastTopologyRef.current = gpuTopologyKey;
    lastGpuMemoryRef.current = gpuMemoryKey;
    lastConfigKeyRef.current = configKey;
    lastStackKeyRef.current = stackKey;

    scheduleEvaluationRef.current();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [model, gpuTopologyKey, gpuMemoryKey, gpus.length, configKey, stackKey, sysInfoLoaded, commitManifest]);

  // FIT validation — runs llama-fit-params with current config, re-evaluates scenario with measured total
  const validate = useCallback(async () => {
    if (!model) return;
    const curConfig = configRef.current;
    const providerId = curConfig.backend_type || "";
    if (tomMtpBlocked(providerId, model)) {
      toastTomMtpSkip();
      return;
    }
    setIsValidating(true);
    try {
      const result: FitScanResult = await invoke("fit_scan_model", {
        modelPath: model.path,
        providerId: curConfig.backend_type || null,
        ctxSize: typeof curConfig.ctx === 'number' ? curConfig.ctx : 32768,
        kvQuant: curConfig["kv_quant"] || "f16",
        device: curConfig.device || "GPU-0",
        splitMode: (curConfig.split || "none").toString().toLowerCase(),
        batch: typeof curConfig.batch === 'number' ? curConfig.batch : parseInt(String(curConfig.batch), 10) || 2048,
        ubatch: typeof curConfig.ubatch === 'number' ? curConfig.ubatch : parseInt(String(curConfig.ubatch), 10) || 512,
        flashAttn: curConfig["flash_attn"]?.toString().toLowerCase() !== "off",
        offloadMode: (curConfig["offload_mode"] || "regular").toString(),
      });

      // Re-run full scenario evaluation with measured VRAM total
      const engineConfig: EngineConfig = {
        alias: "",
        model_path: model.path,
        port: 0,
        backend_type: curConfig.backend_type,
        extra_params: { ...curConfig },
      };

      const runningSlots = committedSlotsFromStack(stackRef.current);

      const sysInfo = systemInfoRef.current || { total_memory_mib: 0, available_memory_mib: 0, total_memory_manufactured_mib: 0 };

      const probeMeasuredAt = new Date().toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

      const curConfigKey = scenarioConfigKey(
        curConfig,
        autoVramLaunchRef.current,
        fullAutoModeRef.current ? "full_auto" : "assisted",
      );

      const input: ScenarioInput = {
        modelMeta: model.metadata!,
        engineConfig,
        gpus: gpusRef.current,
        runningSlots,
        ramAvailableGb: sysInfo.available_memory_mib / 1024,
        ramManufacturedGb: sysInfo.total_memory_manufactured_mib / 1024,
        mmprojSizeMib: model.mmproj_size_mib,
        fitPoints: fitPointsRef.current || undefined,
        autoVramLaunch: autoVramLaunchRef.current,
        fullAutoMode: fullAutoModeRef.current,
        fitStyle: fitStyleRef.current,
        learnedVramMib: learnedVramRef.current ?? undefined,
        learnedHostMib: learnedHostRef.current ?? undefined,
        learnedGpuBreakdownMib: learnedGpuBreakdownRef.current ?? undefined,
        learnedGpuComponentsMib: learnedGpuComponentsRef.current ?? undefined,
        learnedLaunchProfile: learnedLaunchProfileRef.current,
        learnedMeasuredAt: learnedMeasuredAtRef.current,
        fitProbeVramMib: result.vram_mib,
        fitProbeHostMib: result.host_mib,
        fitProbeGpuBreakdownMib: result.gpu_breakdown_mib,
      };

      const session: ProbeSession = {
        modelPath: model.path,
        configKey: curConfigKey,
        validatedVramMib: result.vram_mib,
        validatedGpuBreakdownMib: result.gpu_breakdown_mib,
        validatedHostMib: result.host_mib,
        validatedComponentsMib: result.gpu_components_mib ?? null,
        fitProbeMeasuredAt: probeMeasuredAt,
      };

      probeSessionRef.current = session;

      const validatedManifest = attachProbeManifest(evaluate(input), session, input);

      commitManifest(validatedManifest);

     // Validation debug emission — emit when scenario changed or validation newly applied
      if (model.path !== lastScenarioDebugModelRef.current || validatedManifest.scenario !== lastScenarioDebugNameRef.current || result.vram_mib !== validatedManifest.validatedVramMib) {
        const modelName = model.path.split(/[\/\\]/).pop() || model.path;
        const fps = fitPointsRef.current;
        emitScenarioDebug(
          modelName, model.metadata, fps, validatedManifest.scenario,
          validatedManifest.vramWeightsGb, validatedManifest.vramKvGb, validatedManifest.vramOverheadGb,
          validatedManifest.vramTotalGb, validatedManifest.gpuAllocations, validatedManifest.gpuLayers, validatedManifest.ramLayers,
          validatedManifest.validatedVramMib, validatedManifest.formulaVramTotalGb, validatedManifest.validatedComponentsMib,
          validatedManifest.style.uiTemplate, engineConfig, result.vram_mib / 1024,
          validatedManifest.memorySource
            ? MEMORY_SOURCE_LABELS[validatedManifest.memorySource.kind]
            : undefined,
        );
        lastScenarioDebugModelRef.current = model.path;
        lastScenarioDebugNameRef.current = validatedManifest.scenario;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FitValidate]", e);
      if (msg.includes(TOM_MTP_SKIP_MESSAGE) || msg.toLowerCase().includes("mtp")) {
        toastTomMtpSkip(msg);
      } else {
        window.__blackopsToasts?.addToast(`FIT probe failed: ${msg}`, "error");
      }
    } finally {
      setIsValidating(false);
    }
  }, [model, configKey, commitManifest]);

  return { manifest, isEvaluating, isValidating, validate };
}
