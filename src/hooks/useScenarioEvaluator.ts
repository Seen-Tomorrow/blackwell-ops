import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry, EngineConfig, GpuInfo, StackEntry, SystemInfo, VramManifest, FitScanResult } from "../lib/types";
import { evaluate, applyFitValidation, type ScenarioInput, type RunningSlotInfo, type FitPoint } from "../services/vram/scenarios/scenarios_factory";

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
  const fitPointsRef = useRef<FitPoint[] | null>(null);
  const lastFitModelPathRef = useRef("");
  const lastScenarioDebugModelRef = useRef("");
  const lastScenarioDebugNameRef = useRef("");

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
  const configKey = `${config.device || ""}|${config.split || ""}|${config["offload_mode"] || ""}|${config.ctx || ""}|${config["kv_quant"] || ""}|${config.batch ?? ""}|${config.ubatch ?? ""}|${config.parallel ?? ""}|${config["flash_attn"] || ""}|${config.vision || ""}|${config["unified_kv"] || ""}|${config["rope_scaling"] || ""}|${config["rope_scale"] ?? ""}`;

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
      backend_type: curConfig.backend_type,
      extra_params: { ...curConfig },
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
      fitPoints: fitPointsRef.current || undefined,
    };

    try {
      const result = evaluate(input);
      setManifest(result);

      // Scenario debug emission (deduped by model path + scenario name)
      if (model.path !== lastScenarioDebugModelRef.current || result.scenario !== lastScenarioDebugNameRef.current) {
        const modelName = model.path.split(/[\/\\]/).pop() || model.path;
        console.warn(`[SCENARIO] Model: ${modelName} | Meta: ${model.metadata ? 'YES' : 'NO'} | Arch: ${model.metadata?.architecture || '?'} | Layers: ${model.metadata?.n_layer ?? '?'} | Params: ${model.metadata?.total_params_str || '?'} | Size: ${(model.metadata?.file_size_bytes / (1024**3)).toFixed(1)}G`);

        const fps = fitPointsRef.current;
        if (fps && fps.length > 0) {
          const labels = fps.map(fp => fp.label.toLowerCase());
          const hasBase = labels.some(l => l.includes('base'));
          const hasQuant = labels.some(l => l.includes('quant') || l.includes('q4') || l.includes('q8') || l.includes('f16'));
          const hasCtxSweep = labels.filter(l => l.includes('ctx')).length >= 2;
          const missingLabels: string[] = [];
          if (!hasBase) missingLabels.push('base');
          if (!hasQuant) missingLabels.push('quant variants');
          if (!hasCtxSweep) missingLabels.push('ctx sweep');
          console.warn(`[SCENARIO] FIT: ${fps.length}pts loaded${missingLabels.length > 0 ? ' | MISSING: ' + missingLabels.join(', ') : ''}`);
        } else {
          console.warn('[SCENARIO] FIT: NO SCAN DATA');
        }

        const totalNeedGb = result.vramTotalGb;
        console.warn(`[SCENARIO] Scenario: ${result.scenario} | W:${result.vramWeightsGb.toFixed(1)}G KV:${result.vramKvGb.toFixed(1)}G OH:${result.vramOverheadGb.toFixed(1)}G Total:${totalNeedGb.toFixed(1)}G`);

        const allocText = result.gpuAllocations.map(a => {
          const pct = ((a.projectedLoadGb / a.vramManufacturedGb) * 100).toFixed(0);
          return `GPU-${a.gpuIndex}=${a.projectedLoadGb.toFixed(1)}G(${pct}%)`;
        }).join(', ');
        console.warn(`[SCENARIO] GPU: ${allocText} | Layers: ${result.gpuLayers} GPU / ${result.ramLayers} RAM`);

        if (result.validatedVramMib) {
          const validatedGb = result.validatedVramMib / 1024;
          const formulaTotalGb = result.formulaVramTotalGb || totalNeedGb;
          const delta = ((validatedGb - formulaTotalGb) / formulaTotalGb * 100);
          console.warn(`[SCENARIO] Validated: ${validatedGb.toFixed(1)}G (${delta > 0 ? '+' : ''}${delta.toFixed(1)}% from formula)`);
        } else {
          console.warn('[SCENARIO] Validated: NO (formula only)');
        }

        if (result.validatedComponentsMib && result.validatedComponentsMib.length > 0) {
          const compText = result.validatedComponentsMib.map((c, i) => `GPU${i}:W=${c.model_mib} KV=${c.ctx_mib} C=${c.compute_mib}`).join(' | ');
          console.warn(`[SCENARIO] Components: ${compText}`);
        }

        const fa = result.style.uiTemplate ? 'on' : 'off';
        const ep = engineConfig.extra_params || {};
        console.warn(`[SCENARIO] Config: CTX=${ep.ctx} KVQ=${ep["kv_quant"]} Batch=${ep.batch} Par=${ep.parallel} Split=${ep.split} FA=${fa} Offload=${ep["offload_mode"]}`);

        lastScenarioDebugModelRef.current = model.path;
        lastScenarioDebugNameRef.current = result.scenario;
      }
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

  // Fetch FIT scan points when model path changes, cache per model
  useEffect(() => {
    if (!model) {
      fitPointsRef.current = null;
      lastFitModelPathRef.current = "";
      return;
    }
    if (model.path === lastFitModelPathRef.current) return;
    lastFitModelPathRef.current = model.path;

    invoke("get_fit_scan_points", { modelPath: model.path }).then((result: any) => {
      fitPointsRef.current = result ?? null;
    }).catch(() => {
      fitPointsRef.current = null;
    });
  }, [model?.path]);

  useEffect(() => {
    if (!model || gpus.length === 0) {
      setManifest(null);
      lastTopologyRef.current = "";
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
    const configChanged = configKey !== lastConfigKeyRef.current || isFirstMount;
    const stackChanged = stackKey !== lastStackKeyRef.current || isFirstMount;
    const sysInfoChanged = sysInfoLoaded && !isFirstMount;

    if (!modelChanged && !topologyChanged && !configChanged && !stackChanged && !sysInfoChanged) return;
    lastModelPathRef.current = model.path;
    lastTopologyRef.current = gpuTopologyKey;
    lastConfigKeyRef.current = configKey;
    lastStackKeyRef.current = stackKey;

    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(runEvaluation, 150);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [model, gpuTopologyKey, gpus.length, configKey, stackKey, sysInfoLoaded, runEvaluation]);

  // FIT validation — runs llama-fit-params with current config, re-evaluates scenario with measured total
  const validate = useCallback(async () => {
    if (!model) return;
    setIsValidating(true);
    try {
      const curConfig = configRef.current;
      const result: FitScanResult = await invoke("fit_scan_model", {
        modelPath: model.path,
        providerId: curConfig.backend_type || null,
        ctxSize: typeof curConfig.ctx === 'number' ? curConfig.ctx : 32768,
        kvQuant: curConfig["kv_quant"] || "f16",
        device: curConfig.device || "GPU-0",
        splitMode: (curConfig.split || "none").toString().toLowerCase(),
        batch: typeof curConfig.batch === 'number' ? curConfig.batch : parseInt(String(curConfig.batch), 10) || 2048,
        ubatch: typeof curConfig.ubatch === 'number' ? curConfig.ubatch : parseInt(String(curConfig.ubatch), 10) || 512,
        parallel: typeof curConfig.parallel === 'number' ? curConfig.parallel : parseInt(String(curConfig.parallel), 10) || 1,
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

      const runningSlots: RunningSlotInfo[] = stackRef.current
        .filter(s => s.status === "RUNNING" || s.status === "LOADING")
        .map(s => {
          const short = (s.model_name && s.model_name !== s.model_path)
            ? s.model_name.slice(0, 30)
            : s.model_path?.split(/[\/\\]/).pop()?.slice(0, 30) || s.model_name.slice(0, 30);
          return { alias: s.alias, modelShort: short, vramMib: s.vram_mib || 0, gpuMask: s.gpu };
        });

      const sysInfo = systemInfoRef.current || { total_memory_mib: 0, available_memory_mib: 0, total_memory_manufactured_mib: 0 };

      const input: ScenarioInput = {
        modelMeta: model.metadata!,
        engineConfig,
        gpus: gpusRef.current,
        runningSlots,
        ramAvailableGb: sysInfo.available_memory_mib / 1024,
        ramManufacturedGb: sysInfo.total_memory_manufactured_mib / 1024,
        mmprojSizeMib: model.mmproj_size_mib,
        fitPoints: fitPointsRef.current || undefined,
      };

      // Evaluate with measured VRAM total — this will pick the correct scenario based on reality
      const newManifest = evaluate(input, result.vram_mib);
      
      // Also store validation metadata for display (CERTIFIED badge, scale factor, etc.)
      const validatedManifest: VramManifest = {
        ...newManifest,
        validatedVramMib: result.vram_mib,
        validatedGpuBreakdownMib: result.gpu_breakdown_mib,
        validatedHostMib: result.host_mib,
        validatedComponentsMib: result.gpu_components_mib ?? null,
      };
      
      setManifest(validatedManifest);

      // Validation debug emission — emit when scenario changed or validation newly applied
      if (model.path !== lastScenarioDebugModelRef.current || newManifest.scenario !== lastScenarioDebugNameRef.current || result.vram_mib !== validatedManifest.validatedVramMib) {
        const modelName = model.path.split(/[\/\\]/).pop() || model.path;
        console.warn(`[SCENARIO] Model: ${modelName} | Meta: YES | Arch: ${model.metadata?.architecture || '?'} | Layers: ${model.metadata?.n_layer ?? '?'} | Params: ${model.metadata?.total_params_str || '?'} | Size: ${(model.metadata?.file_size_bytes / (1024**3)).toFixed(1)}G`);

        const fps = fitPointsRef.current;
        if (fps && fps.length > 0) {
          console.warn(`[SCENARIO] FIT: ${fps.length}pts loaded | VALIDATED: ${(result.vram_mib / 1024).toFixed(1)}G`);
        } else {
          console.warn('[SCENARIO] FIT: NO SCAN DATA');
        }

        const totalNeedGb = validatedManifest.vramTotalGb;
        console.warn(`[SCENARIO] Scenario: ${newManifest.scenario} | W:${validatedManifest.vramWeightsGb.toFixed(1)}G KV:${validatedManifest.vramKvGb.toFixed(1)}G OH:${validatedManifest.vramOverheadGb.toFixed(1)}G Total:${totalNeedGb.toFixed(1)}G`);

        const allocText = validatedManifest.gpuAllocations.map(a => {
          const pct = ((a.projectedLoadGb / a.vramManufacturedGb) * 100).toFixed(0);
          return `GPU-${a.gpuIndex}=${a.projectedLoadGb.toFixed(1)}G(${pct}%)`;
        }).join(', ');
        console.warn(`[SCENARIO] GPU: ${allocText} | Layers: ${validatedManifest.gpuLayers} GPU / ${validatedManifest.ramLayers} RAM`);

        const validatedGb = result.vram_mib / 1024;
        const formulaTotalGb = validatedManifest.formulaVramTotalGb || totalNeedGb;
        const delta = ((validatedGb - formulaTotalGb) / formulaTotalGb * 100);
        console.warn(`[SCENARIO] Validated: ${validatedGb.toFixed(1)}G (${delta > 0 ? '+' : ''}${delta.toFixed(1)}% from formula)`);

        if (result.gpu_components_mib && result.gpu_components_mib.length > 0) {
          const compText = result.gpu_components_mib.map((c, i) => `GPU${i}:W=${c.model_mib} KV=${c.ctx_mib} C=${c.compute_mib}`).join(' | ');
          console.warn(`[SCENARIO] Components: ${compText}`);
        }

        const fa = newManifest.style.uiTemplate ? 'on' : 'off';
        const ep = engineConfig.extra_params || {};
        console.warn(`[SCENARIO] Config: CTX=${ep.ctx} KVQ=${ep["kv_quant"]} Batch=${ep.batch} Par=${ep.parallel} Split=${ep.split} FA=${fa} Offload=${ep["offload_mode"]}`);

        lastScenarioDebugModelRef.current = model.path;
        lastScenarioDebugNameRef.current = newManifest.scenario;
      }
    } catch (e) {
      console.error("[FitValidate]", e);
    } finally {
      setIsValidating(false);
    }
  }, [model]);

  return { manifest, isEvaluating, isValidating, validate };
}
