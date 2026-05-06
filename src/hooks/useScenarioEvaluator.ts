import { useState, useEffect, useCallback, useRef } from "react";
import type { ModelEntry, EngineConfig, GpuInfo, StackEntry, SystemInfo, VramManifest } from "../lib/types";
import { evaluate, type ScenarioInput, type RunningSlotInfo } from "../services/vram/scenarios/scenarios_factory";

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
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const runEvaluation = useCallback(() => {
    if (!model || gpus.length === 0) {
      setManifest(null);
      return;
    }

    // Model must have GGUF metadata scanned (from cache)
    if (!model.metadata) {
      console.warn("[ScenarioEvaluator] No cached GGUF metadata for", model.path);
      setManifest(null);
      return;
    }

    setIsEvaluating(true);

    const engineConfig: EngineConfig = {
      alias: "",
      model_path: model.path,
      port: 0,
      device: config.Device || "GPU-0",
      kv_quant: config["KV-Quant"] || "f16",
      ctx_size: config.CTX || "32K",
      batch: typeof config.Batch === 'number' ? config.Batch : parseInt(String(config.Batch), 10) || 2048,
      ubatch: typeof config.uBatch === 'number' ? config.uBatch : parseInt(String(config.uBatch), 10) || 512,
      parallel: typeof config.Parallel === 'number' ? config.Parallel : parseInt(String(config.Parallel), 10) || 1,
      offload: String(config.Offload || "ALL"),
      offload_mode: (config["Offload_Mode"] || "REGULAR").toString().toUpperCase(),
      split_mode: (config.Split || "NONE").toString().toLowerCase(),
      vision: config.Vision?.toUpperCase() === "OFF" ? "OFF" : "AUTO",
      flash_attn: config["Flash-Attn"]?.toString().toLowerCase() !== "off",
      jinja: config.Jinja?.toString().toUpperCase() !== "OFF",
      cont_batching: config["Cont-Batching"]?.toString().toUpperCase() !== "OFF",
      metrics: config.Metrics?.toString().toUpperCase() === "ON",
      reasoning: config.Reasoning?.toString().toUpperCase() === "ON",
      mmap: config.MMAP?.toString().toUpperCase() !== "OFF",
      verbose: false,
      log_timestamps: true,
    };

    const runningSlots: RunningSlotInfo[] = stack
      .filter(s => s.status === "RUNNING" || s.status === "LOADING")
      .map(s => {
        const short = s.model_path
          ? s.model_path.split("/").pop()?.slice(0, 30) || s.model_name.slice(0, 30)
          : s.model_name.slice(0, 30);
        return {
          alias: s.alias,
          modelShort: short,
          vramMib: s.vram_mib || 0,
          gpuMask: s.gpu,
        };
      });

    const sysInfo = systemInfo || {
      total_memory_mib: 0,
      available_memory_mib: 0,
      total_memory_manufactured_mib: 0,
    };

    const input: ScenarioInput = {
      modelMeta: model.metadata,
      engineConfig,
      gpus,
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
  }, [model, config, gpus, stack, systemInfo]);

  useEffect(() => {
    if (!model || gpus.length === 0) {
      setManifest(null);
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(runEvaluation, 150);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [model, config, gpus, stack, systemInfo, runEvaluation]);

  return { manifest, isEvaluating };
}
