import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry, EngineConfig, GpuInfo, StackEntry, SystemInfo, VramManifest, FitScanResult } from "../lib/types";
import { evaluate, applyFitValidation, type ScenarioInput, type RunningSlotInfo } from "../services/vram/scenarios/scenarios_factory";

interface UseScenarioEvaluatorProps {
  model: ModelEntry | null;
  config: Record<string, any>;
  gpus: GpuInfo[];
  stack: StackEntry[];
  systemInfo?: SystemInfo | null;
}

export function useScenarioEvaluator({ model, config, gpus, stack, systemInfo }: UseScenarioEvaluatorProps) {
  const [manifest, setManifest] = useState<VramManifest | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Stabilize GPU reference: telemetry polls every 250ms creating new object refs.
  // Only re-evaluate when GPU topology meaningfully changes (count or total VRAM shifts).
  const gpuTopologyKey = gpus.length > 0
    ? `${gpus.length}-${gpus.reduce((s, g) => s + (g.memory_total_manufactured || g.memory_total), 0)}`
    : "0";

  // Track last topology key to skip redundant re-evals from telemetry noise.
  const isMountedRef = useRef(false);
  const lastTopologyRef = useRef<string>("");
  const lastModelPathRef = useRef("");
  const lastConfigKeyRef = useRef<string>("");
  const lastStackKeyRef = useRef<string>("");

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
  const configKey = `${config.Device || ""}|${config.Split || ""}|${config["Offload_Mode"] || ""}|${config.CTX || ""}|${config["KV-Quant"] || ""}|${config.Batch ?? ""}|${config.uBatch ?? ""}|${config.Parallel ?? ""}|${config["Flash-Attn"] || ""}|${config.Offload || ""}`;

  // Stack fingerprint — changes when running engines start/stop or their VRAM shifts.
  const stackKey = stack
    .filter(s => s.status === "RUNNING" || s.status === "LOADING")
    .map(s => `${s.alias}-${s.vram_mib || 0}`)
    .join("|");

  // System info loaded flag — triggers re-eval when it arrives (was null before).
  const sysInfoLoaded = systemInfo != null;

  const runEvaluation = useCallback(() => {
    const curGpus = gpusRef.current;
    const curStack = stackRef.current;
    const curSystemInfo = systemInfoRef.current;
    const curConfig = configRef.current;

    if (!model || curGpus.length === 0) {
      setManifest(null);
      return;
    }

    // Model must have GGUF metadata scanned (from cache)
    if (!model.metadata) {
      console.warn("[ScenarioEvaluator] No cached GGUF metadata for", model.path.split("/").pop());
      setManifest(null);
      return;
    }

    setIsEvaluating(true);

    const engineConfig: EngineConfig = {
      alias: "",
      model_path: model.path,
      port: 0,
      device: curConfig.Device || "GPU-0",
      kv_quant: curConfig["KV-Quant"] || "f16",
      ctx_size: curConfig.CTX || "32K",
      batch: typeof curConfig.Batch === 'number' ? curConfig.Batch : parseInt(String(curConfig.Batch), 10) || 2048,
      ubatch: typeof curConfig.uBatch === 'number' ? curConfig.uBatch : parseInt(String(curConfig.uBatch), 10) || 512,
      parallel: typeof curConfig.Parallel === 'number' ? curConfig.Parallel : parseInt(String(curConfig.Parallel), 10) || 1,
      offload: String(curConfig.Offload || "ALL"),
      offload_mode: (curConfig["Offload_Mode"] || "REGULAR").toString().toUpperCase(),
      split_mode: (curConfig.Split || "NONE").toString().toLowerCase(),
      vision: curConfig.Vision?.toUpperCase() === "OFF" ? "OFF" : "AUTO",
      flash_attn: curConfig["Flash-Attn"]?.toString().toLowerCase() !== "off",
      jinja: curConfig.Jinja?.toString().toUpperCase() !== "OFF",
      cont_batching: curConfig["Cont-Batching"]?.toString().toUpperCase() !== "OFF",
      metrics: curConfig.Metrics?.toString().toUpperCase() === "ON",
      reasoning: curConfig.Reasoning?.toString().toUpperCase() === "ON",
      mmap: curConfig.MMAP?.toString().toUpperCase() !== "OFF",
      verbose: false,
      log_timestamps: true,
    };

    const runningSlots: RunningSlotInfo[] = curStack
      .filter(s => s.status === "RUNNING" || s.status === "LOADING")
      .map(s => {
        const short = (s.model_name && s.model_name !== s.model_path)
          ? s.model_name.slice(0, 30)
          : s.model_path?.split(/[\/\\]/).pop()?.slice(0, 30)
            || s.model_name.slice(0, 30);
        return {
          alias: s.alias,
          modelShort: short,
          vramMib: s.vram_mib || 0,
          gpuMask: s.gpu,
        };
      });

    const sysInfo = curSystemInfo || {
      total_memory_mib: 0,
      available_memory_mib: 0,
      total_memory_manufactured_mib: 0,
    };

    const input: ScenarioInput = {
      modelMeta: model.metadata,
      engineConfig,
      gpus: curGpus,
      runningSlots,
      ramAvailableGb: sysInfo.available_memory_mib / 1024,
      ramManufacturedGb: sysInfo.total_memory_manufactured_mib / 1024,
      mmprojSizeMib: model.mmproj_size_mib,
    };

    try {
      const result = evaluate(input);
      setManifest(result);
    } catch (e) {
      console.error("[ScenarioEvaluator]", e);
      setManifest(null);
    } finally {
      setIsEvaluating(false);
    }
  }, [model]);

  useEffect(() => {
    // Reset on unmount to handle Strict Mode double-mount correctly
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      isMountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (!model || gpus.length === 0) {
      setManifest(null);
      lastTopologyRef.current = "";
      lastModelPathRef.current = "";
      lastConfigKeyRef.current = "";
      lastStackKeyRef.current = "";
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
    const configChanged = configKey !== lastConfigKeyRef.current || isFirstMount;
    const stackChanged = stackKey !== lastStackKeyRef.current || isFirstMount;
    const sysInfoChanged = sysInfoLoaded && !isFirstMount;

    // Only log when something actually changed (not Strict Mode double-mount noise)
    if (modelChanged || topologyChanged || configChanged || stackChanged || sysInfoChanged) {
      console.debug(`[ScenarioEvaluator] model: ${modelChanged} topo: ${topologyChanged} config: ${configChanged} stack: ${stackChanged} sysInfo: ${sysInfoChanged}`);
    }
    if (!modelChanged && !topologyChanged && !configChanged && !stackChanged && !sysInfoChanged) return;
    lastModelPathRef.current = model.path;
    lastTopologyRef.current = gpuTopologyKey;
    lastConfigKeyRef.current = configKey;
    lastStackKeyRef.current = stackKey;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(runEvaluation, 150);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [model, gpuTopologyKey, gpus.length, configKey, stackKey, sysInfoLoaded, runEvaluation]);

  // FIT validation — runs llama-fit-params with current config, applies measured total to manifest
  const validate = useCallback(async () => {
    if (!model) return;
    setIsValidating(true);
    try {
      const curConfig = configRef.current;
      const result: FitScanResult = await invoke("fit_scan_model", {
        modelPath: model.path,
        ctxSize: curConfig.CTX || "32K",
        kvQuant: curConfig["KV-Quant"] || "f16",
        device: curConfig.Device || "GPU-0",
        splitMode: (curConfig.Split || "NONE").toString().toLowerCase(),
        batch: typeof curConfig.Batch === 'number' ? curConfig.Batch : parseInt(String(curConfig.Batch), 10) || 2048,
        ubatch: typeof curConfig.uBatch === 'number' ? curConfig.uBatch : parseInt(String(curConfig.uBatch), 10) || 512,
        parallel: typeof curConfig.Parallel === 'number' ? curConfig.Parallel : parseInt(String(curConfig.Parallel), 10) || 1,
        flashAttn: curConfig["Flash-Attn"]?.toString().toLowerCase() !== "off",
      });

      // Apply validated total to current manifest
      setManifest(prev => {
        if (!prev) return prev;
        return applyFitValidation(
          prev,
          result.vram_mib,
          result.gpu_breakdown_mib,
          result.host_mib,
        );
      });
    } catch (e) {
      console.error("[FitValidate]", e);
    } finally {
      setIsValidating(false);
    }
  }, [model]);

  return { manifest, isEvaluating, isValidating, validate };
}
