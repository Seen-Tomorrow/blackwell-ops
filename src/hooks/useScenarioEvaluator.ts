import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry, EngineConfig, GpuInfo, StackEntry, SystemInfo, VramManifest, FitScanResult } from "../lib/types";
import { evaluate, committedSlotsFromStack, committedStackKey, parseCtx, computeGpuAvailableList, type ScenarioInput, type FitPoint } from "../services/vram/scenarios/scenarios_factory";
import {
  freeFingerprintFromGb,
  learnedLooksLikeFreeDependentSpill,
  shouldApplyLowVramSession,
  type FitProbeMode,
} from "../services/vram/lowVramProbe";
import { isDevBuild } from "../lib/build";
import { gpuMemoryBucketKey, vramManifestSnapshotEqual, vramTopoTag } from "../lib/telemetryGpu";
import { attachMemorySource, MEMORY_SOURCE_LABELS } from "../services/vram/memorySource";
import { tomMtpBlocked, toastTomMtpSkip, TOM_MTP_SKIP_MESSAGE } from "../lib/tomMtp";
import { EVENTS } from "../lib/events";
import { useTauriListen } from "./useTauriListen";
type ProbeSession = {
  modelPath: string;
  /** Hard knobs only — ctx slider does not drop the probe. */
  hardKey: string;
  placementKey: string;
  /** Ctx the probe was measured at. */
  anchorCtx: number;
  validatedVramMib: number;
  validatedGpuBreakdownMib?: number[];
  validatedHostMib?: number;
  validatedHostModelMib?: number;
  validatedComponentsMib?: VramManifest["validatedComponentsMib"];
  fitProbeMeasuredAt: string;
  /** full = ngl999 need; low_vram = free-aware spill. */
  mode: FitProbeMode;
  /** Free-pool fingerprint at probe time. */
  freeFingerprint: string;
  fittedNgl?: number;
};

function placementConfigKey(config: Record<string, unknown>): string {
  return `${config.device || ""}|${config.split || ""}|${config.gpu_sync || ""}`;
}

function draftBaseName(config: Record<string, unknown>): string {
  const draft = String(config.dflash_draft_model ?? config.spec_draft_model ?? "");
  return draft.split(/[/\\]/).pop() || draft;
}

/**
 * llama-fit-params loads model + context with no_alloc.
 * Memory actually moves with: model, n_ctx, n_batch, n_ubatch, cache-type k/v,
 * flash-attn, ngl, split-mode. Probe uses live split (none/layer/tensor).
 * Thinking / parallel / samplers / threads are not FIT inputs — ignore them.
 */
function fitProbeKey(config: Record<string, unknown>, autoVramLaunch: boolean): string {
  const split = String(config.split ?? "none").trim().toLowerCase() || "none";
  return [
    config.backend_type || "",
    config["kv_quant"] || "",
    String(config.batch ?? ""),
    String(config.ubatch ?? ""),
    config["flash_attn"] || "",
    split,
    autoVramLaunch ? "1" : "0",
  ].join("|");
}

/** Learned rows also key on boost/draft/split. CTX is not here. */
function learnedIdentityKey(config: Record<string, unknown>, autoVramLaunch: boolean): string {
  return [
    fitProbeKey(config, autoVramLaunch),
    effectiveSpecTypeFromConfig(config),
    draftBaseName(config),
    String(config.split ?? "none"),
  ].join("|");
}

function liveEvalKey(
  config: Record<string, unknown>,
  autoVramLaunch: boolean,
): string {
  return `${placementConfigKey(config)}|${learnedIdentityKey(config, autoVramLaunch)}|ctx=${config.ctx || ""}`;
}

function probeScenarioFields(
  session: ProbeSession | null,
  modelPath: string,
  hardKey: string,
  placementKey: string,
  liveFreeGb?: number,
  liveFreeFp?: string,
  liveCtx?: number,
) {
  if (!session || session.modelPath !== modelPath || session.hardKey !== hardKey) {
    return {};
  }
  if (
    session.mode === "low_vram"
    && liveCtx != null
    && session.anchorCtx !== liveCtx
  ) {
    return {};
  }
  if (
    isDevBuild()
    && session.mode === "low_vram"
    && liveFreeGb != null
    && liveFreeFp
    && !shouldApplyLowVramSession({
      mode: session.mode,
      probeFreeFingerprint: session.freeFingerprint,
      liveFreeFingerprint: liveFreeFp,
      probeGpuGb: session.validatedVramMib / 1024,
      liveFreeGb,
      anchorCtx: session.anchorCtx,
      liveCtx,
    })
  ) {
    return {};
  }
  const placementMatches = session.placementKey === placementKey;
  return {
    fitProbeVramMib: session.validatedVramMib,
    fitProbeHostMib: session.validatedHostMib,
    fitProbeHostModelMib: session.validatedHostModelMib,
    fitProbeGpuBreakdownMib: placementMatches ? session.validatedGpuBreakdownMib : undefined,
    fitProbePlacementKey: session.placementKey,
    fitProbeAnchorCtx: session.anchorCtx,
    fitProbeMeasuredAt: session.fitProbeMeasuredAt,
    fitProbeMode: session.mode,
    fitProbeFreeFingerprint: session.freeFingerprint,
    fitProbeFittedNgl: session.fittedNgl,
  };
}

function attachProbeManifest(
  manifest: VramManifest | null,
  session: ProbeSession,
  input: ScenarioInput,
  placementMatches: boolean,
): VramManifest | null {
  if (!manifest) return null;
  const breakdownMib = placementMatches
    ? session.validatedGpuBreakdownMib
    : manifest.gpuAllocations.map((a) => a.projectedLoadGb * 1024);
  return attachMemorySource(
    {
      ...manifest,
      validatedVramMib: session.validatedVramMib,
      validatedGpuBreakdownMib: breakdownMib,
      validatedHostMib: session.validatedHostMib,
      validatedComponentsMib: placementMatches ? session.validatedComponentsMib : null,
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
  /** Full catalog — used to resolve external draft GGUF file size for measured forecast. */
  catalogModels?: ModelEntry[];
}

/** Effective CLI spec_type for forecast/learn — cockpit may only have Boost state until launch. */
export function effectiveSpecTypeFromConfig(config: Record<string, unknown>): string {
  const raw = String(config.spec_type ?? "none").trim().toLowerCase();
  if (raw && raw !== "none" && raw !== "off") return raw;
  // Boost may inject __boost_spec_type into scenarioConfig without writing template row.
  const boost = String(config.__boost_spec_type ?? "").trim().toLowerCase();
  if (boost) return boost;
  return "none";
}

function externalDraftWanted(config: Record<string, unknown>): boolean {
  const st = effectiveSpecTypeFromConfig(config);
  if (st.includes("mtp") && !st.includes("dflash") && !st.includes("dspark") && !st.includes("eagle")) {
    return false;
  }
  if (st.includes("dflash") || st.includes("dspark") || st.includes("eagle")) return true;
  // Draft path alone (Boost on, spec_type not yet flattened into config row).
  const draft = String(config.dflash_draft_model ?? config.spec_draft_model ?? "").trim();
  if (draft && draft.toLowerCase() !== "auto" && draft.toLowerCase() !== "off" && /\.gguf$/i.test(draft)) {
    return true;
  }
  return false;
}

/** Resolve external draft path + size (MiB) for dflash/dspark forecast (sync path). */
function resolveDraftSizeMib(
  config: Record<string, unknown>,
  catalog: ModelEntry[] | undefined,
): number | undefined {
  if (!externalDraftWanted(config)) return undefined;
  const draftRaw = String(
    config.dflash_draft_model ?? config.spec_draft_model ?? "",
  ).trim();
  if (!draftRaw || draftRaw.toLowerCase() === "auto" || draftRaw.toLowerCase() === "off") {
    return undefined;
  }
  const norm = draftRaw.replace(/\\/g, "/").toLowerCase();
  const base = norm.split("/").pop() || norm;
  const hit = (catalog ?? []).find((m) => {
    const p = m.path.replace(/\\/g, "/").toLowerCase();
    return p === norm || p.endsWith("/" + base) || p.endsWith(base);
  });
  const bytes = hit?.metadata?.file_size_bytes ?? 0;
  if (bytes > 0) return bytes / (1024 * 1024);
  return undefined;
}

function draftPathForLearned(config: Record<string, unknown>): string {
  return String(config.dflash_draft_model ?? config.spec_draft_model ?? "").trim();
}

// Shared scenarios-tab emission helper to avoid duplicating IPC calls to Blackwell Output Console
function emitScenarioConsole(
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
  validatedComponentsMib: any[] | null,
  uiTemplate: any,
  engineConfig: EngineConfig,
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
    lines.push(`[SCENARIO] Measured: ${(validatedVramMib / 1024).toFixed(1)}G`);
  } else {
    lines.push('[SCENARIO] Measured: pending (LEARNED / FIT PROBE)');
  }

  if (validatedComponentsMib && validatedComponentsMib.length > 0) {
    const compText = validatedComponentsMib.map((c: any, i: number) => `GPU${i}:W=${c.model_mib} KV=${c.ctx_mib} C=${c.compute_mib}`).join(' | ');
    lines.push(`[SCENARIO] Components: ${compText}`);
  }

  const fa = uiTemplate ? 'on' : 'off';
  const ep = engineConfig.extra_params || {};
  lines.push(`[SCENARIO] Config: CTX=${ep.ctx} KVQ=${ep["kv_quant"]} Batch=${ep.batch} Par=${ep.parallel} Split=${ep.split} FA=${fa} Offload=${ep["offload_mode"]}`);

  // Emit to Blackwell Output Console Scenarios tab via IPC (fire-and-forget)
  void invoke("emit_to_blackwell_console", {
    category: "scenarios",
    content: lines.join("\n"),
    style: "Warning",
  });
}

/** Survive OPERATIONS tab unmount — last good forecast for instant remount paint. */
const manifestCacheByKey = new Map<string, VramManifest>();
const MANIFEST_CACHE_MAX = 24;

/** Cache identity — ignore exact VRAM digits (NVML noise) so remount still hits. */
function manifestCacheKey(
  modelPath: string,
  configKey: string,
  gpuTopologyKey: string,
  stack: Array<{ status: string; alias: string }>,
): string {
  const stackAliases = stack
    .filter((s) => s.status === "RUNNING" || s.status === "LOADING")
    .map((s) => s.alias)
    .join("|");
  return `${modelPath}\0${configKey}\0${gpuTopologyKey}\0${stackAliases}`;
}

function readManifestCache(key: string): VramManifest | null {
  return manifestCacheByKey.get(key) ?? null;
}

function writeManifestCache(key: string, manifest: VramManifest): void {
  if (manifestCacheByKey.has(key)) manifestCacheByKey.delete(key);
  manifestCacheByKey.set(key, manifest);
  while (manifestCacheByKey.size > MANIFEST_CACHE_MAX) {
    const oldest = manifestCacheByKey.keys().next().value;
    if (oldest === undefined) break;
    manifestCacheByKey.delete(oldest);
  }
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
  catalogModels,
}: UseScenarioEvaluatorProps) {
  // GPU count/capacity — stable across NVML noise (needed before useState seed).
  const gpuTopologyKeyInit = gpus.length > 0
    ? `${gpus.length}-${gpus.reduce((s, g) => s + (g.memory_total_manufactured || g.memory_total), 0)}`
    : "0";
  const configKeyInit = liveEvalKey(config, autoVramLaunch);
  const seedCacheKey = model?.path
    ? manifestCacheKey(model.path, configKeyInit, gpuTopologyKeyInit, stack)
    : "";
  const seedRaw = seedCacheKey ? readManifestCache(seedCacheKey) : null;
  // Seed last measured forecast for instant remount paint; fresh eval follows.
  const seedManifest = seedRaw;
  const [manifest, setManifest] = useState<VramManifest | null>(seedManifest);
  /** Slider marks — from curve IPC, not evaluate(). Skeleton must not hide them. */
  const [learnedCurveCtxs, setLearnedCurveCtxs] = useState<number[]>([]);
  const manifestRef = useRef<VramManifest | null>(seedManifest);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [isValidating, setIsValidating] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastWrittenCacheKeyRef = useRef(seedCacheKey);

  const commitManifest = useCallback((next: VramManifest | null) => {
    // Measured only — null keeps skeleton until LEARNED / FIT PROBE lands.
    if (vramManifestSnapshotEqual(manifestRef.current, next)) return;
    manifestRef.current = next;
    setManifest(next);
    if (next && lastWrittenCacheKeyRef.current) {
      writeManifestCache(lastWrittenCacheKeyRef.current, next);
    }
  }, []);

  /** Last successful paint identity — hold only for soft refresh of the same model+hard knobs. */
  const paintIdentityRef = useRef<{ modelPath: string; probeKey: string }>({
    modelPath: model?.path ?? "",
    probeKey: model?.path ? fitProbeKey(config, autoVramLaunch) : "",
  });

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
  const lastHardKeyRef = useRef<string>("");
  const lastPlacementKeyRef = useRef<string>("");
  const lastStackKeyRef = useRef<string>("");
  const fitPointsRef = useRef<FitPoint[] | null>(null);
  const learnedVramRef = useRef<number | null>(null);
  const learnedHostRef = useRef<number | null>(null);
  const learnedGpuBreakdownRef = useRef<number[] | null>(null);
  const learnedGpuComponentsRef = useRef<VramManifest["validatedComponentsMib"]>(null);
  const learnedLaunchProfileRef = useRef<string | undefined>(undefined);
  const learnedMeasuredAtRef = useRef<string | undefined>(undefined);
  const learnedMtpContextRef = useRef<number | undefined>(undefined);
  const learnedAnchorCtxRef = useRef<number | undefined>(undefined);
  const learnedCurveRef = useRef<Array<{ ctx: number; vramMib: number; hostMib?: number }>>([]);
  const catalogModelsRef = useRef(catalogModels);
  catalogModelsRef.current = catalogModels;
  /** Disk-stat fallback for draft GGUF size when not in catalog metadata (MiB). */
  const draftDiskSizeRef = useRef<number | undefined>(undefined);
  const draftDiskPathRef = useRef("");
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
  const validatingRef = useRef(false);
  /** Last probeKey whose FIT failed — do not auto-loop radar. */
  const fitFailKeyRef = useRef<string | null>(null);
  const hadSysInfoRef = useRef(systemInfo != null);
  const hadMetaRef = useRef(Boolean(model?.metadata));
  const runEvaluationRef = useRef<() => void>(() => {});
  const scheduleEvaluationRef = useRef<(immediate?: boolean) => void>(() => {});
  const maybeAutoFitRef = useRef<() => void>(() => {});
  const gpusRef = useRef(gpus);
  const stackRef = useRef(stack);
  const systemInfoRef = useRef(systemInfo);
  const configRef = useRef(config);
  gpusRef.current = gpus;
  stackRef.current = stack;
  systemInfoRef.current = systemInfo;
  configRef.current = config;

  // Combined key triggers re-eval / cache / learned fetch.
  // Split is a probe hard-key — none/layer/tensor drops the session and re-probes.
  const configKey = liveEvalKey(config, autoVramLaunch);
  const probeKey = fitProbeKey(config, autoVramLaunch);
  const learnedKey = learnedIdentityKey(config, autoVramLaunch);

  useEffect(() => {
    const prev = paintIdentityRef.current;
    const path = model?.path ?? "";
    if (path === prev.modelPath && probeKey === prev.probeKey) return;
    probeSessionRef.current = null;
    fitFailKeyRef.current = null;
    if (manifestRef.current != null) {
      commitManifest(null);
    }
    paintIdentityRef.current = { modelPath: path, probeKey };
  }, [probeKey, model?.path, commitManifest]);

  // Stack fingerprint — changes when committed engines (RUNNING/LOADING) start/stop or VRAM shifts.
  const stackKey = committedStackKey(stack);
  // NVML used MiB buckets — finer when engines run (external bar), coarser when idle forecast only.
  const gpuMemoryKey = gpuMemoryBucketKey(gpus, stackKey === "" ? 512 : 128);

  // System info loaded flag — triggers re-eval when it arrives (was null before).
  const sysInfoLoaded = systemInfo != null;
  // Catalog often restores last-model path before GGUF metadata is attached.
  // Path-stable updates must still re-kick eval + auto-probe once metadata lands.
  const metaReady = Boolean(model?.metadata);

  const runEvaluation = useCallback(() => {
    const curGpus = gpusRef.current;
    const curStack = stackRef.current;
    const curSystemInfo = systemInfoRef.current;
    const curConfig = configRef.current;

    if (validatingRef.current) return;

    if (!model || curGpus.length === 0) {
      commitManifest(null);
      return;
    }

    // Model must have GGUF metadata scanned (from cache)
    if (!model.metadata) {
      void invoke("emit_to_blackwell_console", {
        category: "scenarios",
        content: `[ScenarioEvaluator] No cached GGUF metadata for ${model.path.split("/").pop()}`,
        style: "Warning",
      });
      commitManifest(null);
      return;
    }

    setIsEvaluating(true);
    // No measured data yet → evaluate() returns null and the skeleton stays painted
    // until LEARNED / FIT PROBE lands. isValidating drives the probe button spinner.

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

    const curProbeKey = fitProbeKey(curConfig, autoVramLaunchRef.current);
    const curPlacementKey = placementConfigKey(curConfig);
    const session = probeSessionRef.current;
    const gpuAvailLive = computeGpuAvailableList(curGpus, runningSlots);
    const devMatchLive = /GPU-?(\d+)/i.exec(String(curConfig.device || "GPU-0"));
    const devIdxLive = devMatchLive ? parseInt(devMatchLive[1], 10) : 0;
    const liveFreeGb =
      devIdxLive >= 0 && devIdxLive < gpuAvailLive.length
        ? Math.max(0, gpuAvailLive[devIdxLive] ?? 0)
        : Math.max(0, ...gpuAvailLive, 0);
    const liveFreeFp = freeFingerprintFromGb(liveFreeGb);
    const sessionFields = probeScenarioFields(
      session,
      model.path,
      curProbeKey,
      curPlacementKey,
      liveFreeGb,
      liveFreeFp,
      parseCtx(curConfig.ctx ?? "32768"),
    );
    const input: ScenarioInput = {
      modelMeta: model.metadata,
      engineConfig,
      gpus: curGpus,
      runningSlots,
      ramAvailableGb: sysInfo.available_memory_mib / 1024,
      ramManufacturedGb: sysInfo.total_memory_manufactured_mib / 1024,
      mmprojSizeMib: model.mmproj_size_mib,
      draftSizeMib:
        resolveDraftSizeMib(curConfig, catalogModelsRef.current)
        ?? draftDiskSizeRef.current,
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
      learnedMtpContextMib: learnedMtpContextRef.current,
      learnedAnchorCtx: learnedAnchorCtxRef.current,
      learnedCurve: learnedCurveRef.current,
      ...sessionFields,
    };

    try {
      let result = evaluate(input);
      if (
        session
        && session.modelPath === model.path
        && session.hardKey === curProbeKey
        && sessionFields.fitProbeMode
      ) {
        result = attachProbeManifest(
          result,
          session,
          input,
          session.placementKey === curPlacementKey,
        );
      }
      // Hold previous paint only for soft refresh of the *same* model + hard knobs
      // (LEARNED re-fetch / RE-PROBE). Model switch and hard-knob changes must show
      // EVALUATING radar — holding across identity made the skeleton disappear entirely.
      const sameIdentity =
        model.path === paintIdentityRef.current.modelPath
        && curProbeKey === paintIdentityRef.current.probeKey;
      if (
        result == null
        && manifestRef.current != null
        && sameIdentity
        && (learnedFetchPendingRef.current || validatingRef.current)
      ) {
        // keep manifestRef / React state
      } else {
        commitManifest(result);
        if (result != null) {
          paintIdentityRef.current = { modelPath: model.path, probeKey: curProbeKey };
        }
      }
      // Nothing measured and not already probing → kick auto FIT (may no-op if disabled).
      if (result == null && !validatingRef.current) {
        maybeAutoFitRef.current();
      }

      if (
        result
        && (model.path !== lastScenarioDebugModelRef.current
          || result.scenario !== lastScenarioDebugNameRef.current)
      ) {
        const modelName = model.path.split(/[\/\\]/).pop() || model.path;
        const fps = fitPointsRef.current;
        emitScenarioConsole(
          modelName, model.metadata, fps, result.scenario,
          result.vramWeightsGb, result.vramKvGb, result.vramOverheadGb,
          result.vramTotalGb, result.gpuAllocations, result.gpuLayers, result.ramLayers,
          result.validatedVramMib ?? null, result.validatedComponentsMib ?? null,
          result.style.uiTemplate, engineConfig,
          result.memorySource ? MEMORY_SOURCE_LABELS[result.memorySource.kind] : undefined,
        );
        lastScenarioDebugModelRef.current = model.path;
        lastScenarioDebugNameRef.current = result.scenario;
      }
    } catch (e) {
      console.error("[ScenarioEvaluator]", e);
      if (!(learnedFetchPendingRef.current || validatingRef.current) || manifestRef.current == null) {
        commitManifest(null);
      }
      maybeAutoFitRef.current();
    } finally {
      setIsEvaluating(false);
    }
  }, [model, commitManifest]);

  runEvaluationRef.current = runEvaluation;

  /**
   * Schedule a re-eval. First paint / remount runs immediately so skeleton can
   * flip to LEARNED/FIT PROBE as soon as IPC lands. Config churn debounces.
   */
  const scheduleEvaluation = useCallback((immediate = false) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    if (immediate) {
      timerRef.current = null;
      runEvaluationRef.current();
      return;
    }
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
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
      learnedMtpContextRef.current = undefined;
      learnedAnchorCtxRef.current = undefined;
      learnedCurveRef.current = [];
      setLearnedCurveCtxs([]);
      learnedFetchPendingRef.current = false;
      return;
    }
    const fetchGen = ++learnedFetchGenRef.current;
    learnedFetchPendingRef.current = true;
    learnedVramRef.current = null;
    learnedHostRef.current = null;
    learnedGpuBreakdownRef.current = null;
    learnedGpuComponentsRef.current = null;
    learnedLaunchProfileRef.current = undefined;
    learnedMeasuredAtRef.current = undefined;
    learnedMtpContextRef.current = undefined;
    learnedAnchorCtxRef.current = undefined;
    learnedCurveRef.current = [];
    // Keep a live FIT probe painted; otherwise re-eval immediately (null frame ok).
    const keepProbe = probeSessionRef.current?.modelPath === model.path
      && probeSessionRef.current.hardKey === fitProbeKey(configRef.current, autoVramLaunchRef.current);
    if (!keepProbe) {
      scheduleEvaluationRef.current(true);
    }
    const curConfig = configRef.current;
    const queryCtx = parseCtx(curConfig.ctx ?? "32768");
    const kvQuant = String(curConfig["kv_quant"] ?? "f16");
    const specType = effectiveSpecTypeFromConfig(curConfig);
    const draftModel = draftPathForLearned(curConfig) || null;
    const vramTopo = vramTopoTag(gpusRef.current, curConfig.device);
    void Promise.all([
      invoke<LearnedVramEntry | null>("get_learned_vram", {
        modelPath: model.path,
        providerId: curConfig.backend_type || "ggml-master",
        ctx: String(queryCtx),
        kvQuant,
        device: String(curConfig.device ?? "GPU-0"),
        split: String(curConfig.split ?? "none"),
        memoryMode: fullAutoModeRef.current ? "full_auto" : "assisted",
        offloadMode: "regular",
        specType,
        cacheRam: String(curConfig.cache_ram ?? "0"),
        draftModel,
        vramTopo: vramTopo || null,
      }),
      invoke<Array<{ ctx: number; vram_mib: number; host_mib?: number }>>("get_learned_vram_curve", {
        modelPath: model.path,
        providerId: curConfig.backend_type || "ggml-master",
        kvQuant,
        specType,
        draftModel,
        split: String(curConfig.split ?? "none"),
        vramTopo: vramTopo || null,
      }).catch(() => []),
    ])
      .then(([entry, curve]) => {
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
        learnedMtpContextRef.current = snap?.mtp_context_mib;
        learnedAnchorCtxRef.current = learnedVramRef.current ? queryCtx : undefined;
        learnedCurveRef.current = (curve ?? []).map((p) => ({
          ctx: p.ctx,
          vramMib: p.vram_mib,
          hostMib: p.host_mib,
        }));
        setLearnedCurveCtxs((curve ?? []).map((p) => p.ctx));
      })
      .catch(() => {
        if (fetchGen !== learnedFetchGenRef.current) return;
        learnedVramRef.current = null;
        learnedHostRef.current = null;
        learnedGpuBreakdownRef.current = null;
        learnedGpuComponentsRef.current = null;
        learnedLaunchProfileRef.current = undefined;
        learnedMeasuredAtRef.current = undefined;
        learnedMtpContextRef.current = undefined;
        learnedAnchorCtxRef.current = undefined;
        learnedCurveRef.current = [];
        setLearnedCurveCtxs([]);
      })
      .finally(() => {
        if (fetchGen !== learnedFetchGenRef.current) return;
        learnedFetchPendingRef.current = false;
        maybeAutoFitRef.current();
        scheduleEvaluationRef.current(true);
      });
  }, [model?.path, learnedKey, commitManifest]);

  useEffect(() => {
    refreshLearnedVram();
  }, [refreshLearnedVram]);

  // Draft GGUF often lives outside catalog scan — fall back to on-disk size for measured forecast.
  useEffect(() => {
    const cfg = configRef.current;
    const draftPath = draftPathForLearned(cfg);
    if (!externalDraftWanted(cfg) || !draftPath || !/\.gguf$/i.test(draftPath)) {
      draftDiskSizeRef.current = undefined;
      draftDiskPathRef.current = "";
      return;
    }
    // Catalog hit already provides size — skip IPC.
    if (resolveDraftSizeMib(cfg, catalogModelsRef.current) != null) {
      draftDiskSizeRef.current = undefined;
      draftDiskPathRef.current = "";
      return;
    }
    if (draftDiskPathRef.current === draftPath && draftDiskSizeRef.current != null) {
      return;
    }
    draftDiskPathRef.current = draftPath;
    void invoke<number>("get_path_size_bytes", { path: draftPath })
      .then((bytes) => {
        if (draftDiskPathRef.current !== draftPath) return;
        if (bytes > 0) {
          draftDiskSizeRef.current = bytes / (1024 * 1024);
          scheduleEvaluationRef.current(true);
        }
      })
      .catch(() => {
        if (draftDiskPathRef.current === draftPath) {
          draftDiskSizeRef.current = undefined;
        }
      });
  }, [configKey, model?.path]);

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
        scheduleEvaluationRef.current(true);
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
      lastWrittenCacheKeyRef.current = "";
      commitManifest(null);
      lastTopologyRef.current = "";
      lastGpuMemoryRef.current = "";
      lastModelPathRef.current = "";
      lastConfigKeyRef.current = "";
      lastStackKeyRef.current = "";
      fitPointsRef.current = null;
      hadMetaRef.current = false;
      return;
    }

    lastWrittenCacheKeyRef.current = manifestCacheKey(
      model.path,
      configKey,
      gpuTopologyKey,
      stack,
    );

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
    const metaJustLoaded = metaReady && !hadMetaRef.current;
    hadMetaRef.current = metaReady;
    const placementKey = placementConfigKey(configRef.current);
    const ctxOnly =
      !isFirstMount
      && configChanged
      && !modelChanged
      && !stackChanged
      && !sysInfoJustLoaded
      && !metaJustLoaded
      && learnedKey === lastHardKeyRef.current
      && placementKey === lastPlacementKeyRef.current;

    if (
      !modelChanged
      && !topologyChanged
      && !gpuMemoryChanged
      && !configChanged
      && !stackChanged
      && !sysInfoJustLoaded
      && !metaJustLoaded
    ) {
      return;
    }
    lastModelPathRef.current = model.path;
    lastTopologyRef.current = gpuTopologyKey;
    lastGpuMemoryRef.current = gpuMemoryKey;
    lastConfigKeyRef.current = configKey;
    lastHardKeyRef.current = learnedKey;
    lastPlacementKeyRef.current = placementKey;
    lastStackKeyRef.current = stackKey;
    const immediate = isFirstMount || modelChanged || sysInfoJustLoaded || metaJustLoaded || ctxOnly;
    scheduleEvaluationRef.current(immediate);
    // CTX does not invalidate a live probe (KV delta only). But if we still have no
    // measurement at all, retry auto-probe — first attempt may have raced metadata/free VRAM.
    if (ctxOnly || metaJustLoaded) {
      maybeAutoFitRef.current();
      if (ctxOnly) return;
    }
    return () => { clearTimeout(timerRef.current); };
  }, [model?.path, stack, gpuTopologyKey, gpuMemoryKey, gpus.length, configKey, learnedKey, stackKey, sysInfoLoaded, metaReady, commitManifest]);

  const validate = useCallback(async (requestedMode?: FitProbeMode) => {
    if (!model || validatingRef.current) return;
    const curConfig = configRef.current;
    const providerId = curConfig.backend_type || "";
    if (tomMtpBlocked(providerId, model)) {
      toastTomMtpSkip();
      return;
    }
    validatingRef.current = true;
    setIsValidating(true);
    try {
      // Auto / default RE-PROBE is always full-need (ngl 999).
      // low_vram only when the button is flashing and the user clicks it.
      const probeMode: FitProbeMode =
        requestedMode
        ?? (manifestRef.current?.style?.needsLowVramReprobe ? "low_vram" : "full");

      const runningSlots = committedSlotsFromStack(stackRef.current);
      const gpuAvail = computeGpuAvailableList(gpusRef.current, runningSlots);
      const devMatch = /GPU-?(\d+)/i.exec(String(curConfig.device || "GPU-0"));
      const devIdx = devMatch ? parseInt(devMatch[1], 10) : 0;
      const targetFreeGb =
        devIdx >= 0 && devIdx < gpuAvail.length
          ? Math.max(0, gpuAvail[devIdx] ?? 0)
          : Math.max(0, ...gpuAvail, 0);
      const freeBudgetMib = targetFreeGb * 1024;
      const liveFreeFp = freeFingerprintFromGb(targetFreeGb);

      const result: FitScanResult = await invoke("fit_scan_model", {
        modelPath: model.path,
        providerId: curConfig.backend_type || null,
        ctxSize: parseCtx(curConfig.ctx ?? "32768"),
        kvQuant: curConfig["kv_quant"] || "f16",
        device: curConfig.device || "GPU-0",
        splitMode: String(curConfig.split ?? "none"),
        batch: typeof curConfig.batch === "number" ? curConfig.batch : parseInt(String(curConfig.batch), 10) || 2048,
        ubatch: typeof curConfig.ubatch === "number" ? curConfig.ubatch : parseInt(String(curConfig.ubatch), 10) || 512,
        flashAttn: curConfig["flash_attn"]?.toLowerCase() !== "off",
        offloadMode: "regular",
        mode: probeMode,
        freeBudgetMib: probeMode === "low_vram" ? freeBudgetMib : null,
      });

      const engineConfig: EngineConfig = {
        alias: "",
        model_path: model.path,
        port: 0,
        backend_type: curConfig.backend_type,
        extra_params: { ...curConfig },
      };

      const sysInfo = systemInfoRef.current || {
        total_memory_mib: 0,
        available_memory_mib: 0,
        total_memory_manufactured_mib: 0,
      };
      const probeMeasuredAt = new Date().toLocaleString(undefined, {
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });
      const curProbeKey = fitProbeKey(curConfig, autoVramLaunchRef.current);
      const curPlacementKey = placementConfigKey(curConfig);
      const anchorCtx = parseCtx(curConfig.ctx ?? "32768");
      const resultMode: FitProbeMode =
        result.probe_mode === "low_vram" ? "low_vram" : probeMode;

      const input: ScenarioInput = {
        modelMeta: model.metadata!,
        engineConfig,
        gpus: gpusRef.current,
        runningSlots,
        ramAvailableGb: sysInfo.available_memory_mib / 1024,
        ramManufacturedGb: sysInfo.total_memory_manufactured_mib / 1024,
        mmprojSizeMib: model.mmproj_size_mib,
        draftSizeMib:
          resolveDraftSizeMib(curConfig, catalogModelsRef.current)
          ?? draftDiskSizeRef.current,
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
        learnedMtpContextMib: learnedMtpContextRef.current,
        learnedAnchorCtx: learnedAnchorCtxRef.current,
        learnedCurve: learnedCurveRef.current,
        fitProbeVramMib: result.vram_mib,
        fitProbeHostMib: result.host_mib,
        fitProbeGpuBreakdownMib: result.gpu_breakdown_mib,
        fitProbePlacementKey: curPlacementKey,
        fitProbeAnchorCtx: anchorCtx,
        fitProbeMode: resultMode,
        fitProbeFreeFingerprint: liveFreeFp,
        fitProbeFittedNgl: result.fitted_ngl,
        fitProbeHostModelMib: result.host_components_mib?.model_mib,
      };

      const session: ProbeSession = {
        modelPath: model.path,
        hardKey: curProbeKey,
        placementKey: curPlacementKey,
        anchorCtx,
        validatedVramMib: result.vram_mib,
        validatedGpuBreakdownMib: result.gpu_breakdown_mib,
        validatedHostMib: result.host_mib,
        validatedHostModelMib: result.host_components_mib?.model_mib,
        validatedComponentsMib: result.gpu_components_mib ?? null,
        fitProbeMeasuredAt: probeMeasuredAt,
        mode: resultMode,
        freeFingerprint: liveFreeFp,
        fittedNgl: result.fitted_ngl,
      };

      probeSessionRef.current = session;
      commitManifest(evaluate(input));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error("[FitValidate]", e);
      fitFailKeyRef.current = probeKey;
      if (msg.includes(TOM_MTP_SKIP_MESSAGE) || msg.toLowerCase().includes("mtp")) {
        toastTomMtpSkip(msg);
      } else {
        window.__blackopsToasts?.addToast(`FIT probe failed: ${msg}`, "error");
      }
      const hasLearned = learnedVramRef.current != null || (learnedCurveRef.current?.length ?? 0) > 0;
      void invoke("emit_to_blackwell_console", {
        category: "utils",
        content: hasLearned
          ? `[FIT] PROBE  glass=LEARNED fallback (FIT failed — will not auto-retry this split/kv)`
          : `[FIT] PROBE  glass=EVALUATING (no LEARNED + FIT failed — change model/knob to retry). ${msg.slice(0, 180)}`,
        style: "Error",
      });
      scheduleEvaluationRef.current(true);
    } finally {
      validatingRef.current = false;
      setIsValidating(false);
    }
  }, [model, probeKey, commitManifest]);

  maybeAutoFitRef.current = () => {
    if (!autoVramLaunchRef.current || !model?.path || !model.metadata) return;
    if (validatingRef.current) return;
    if (fitFailKeyRef.current === probeKey) return;
    if (learnedFetchPendingRef.current) return;
    if (
      probeSessionRef.current?.modelPath === model.path
      && probeSessionRef.current.hardKey === probeKey
    ) {
      const sess = probeSessionRef.current;
      const freeList = computeGpuAvailableList(
        gpusRef.current,
        committedSlotsFromStack(stackRef.current),
      );
      const freeGb = Math.max(...freeList, 0);
      const staleLowVram =
        isDevBuild()
        && sess.mode === "low_vram"
        && !shouldApplyLowVramSession({
          mode: sess.mode,
          probeFreeFingerprint: sess.freeFingerprint,
          liveFreeFingerprint: freeFingerprintFromGb(freeGb),
          probeGpuGb: sess.validatedVramMib / 1024,
          liveFreeGb: freeGb,
        });
      if (!staleLowVram) return;
    }
    // Skip auto-probe only for an identity-matched LEARNED row that is still
    // usable. DEV: spill-shaped LEARNED (fat host, GPU already fits free) must
    // not block a full ngl999 probe.
    if (learnedVramRef.current != null) {
      const freeList = computeGpuAvailableList(
        gpusRef.current,
        committedSlotsFromStack(stackRef.current),
      );
      const freeGb = Math.max(...freeList, 0);
      const spillLearned =
        isDevBuild()
        && learnedLooksLikeFreeDependentSpill(
          learnedVramRef.current / 1024,
          (learnedHostRef.current ?? 0) / 1024,
          freeGb,
        );
      if (!spillLearned) return;
    }
    const free = computeGpuAvailableList(
      gpusRef.current,
      committedSlotsFromStack(stackRef.current),
    );
    if (Math.max(...free, 0) < 2.5) return;
    const providerId = String(configRef.current.backend_type || "");
    if (tomMtpBlocked(providerId, model)) return;
    void validate("full");
  };

  const pruneLearnedCtxs = useCallback(async (removeCtxs: number[]) => {
    if (!model?.path || removeCtxs.length === 0) return 0;
    const curConfig = configRef.current;
    try {
      const n = await invoke<number>("prune_learned_vram_curve", {
        modelPath: model.path,
        providerId: curConfig.backend_type || "ggml-master",
        kvQuant: String(curConfig["kv_quant"] ?? "f16"),
        specType: effectiveSpecTypeFromConfig(curConfig),
        draftModel: draftPathForLearned(curConfig) || null,
        split: String(curConfig.split ?? "none"),
        vramTopo: vramTopoTag(gpusRef.current, curConfig.device) || null,
        removeCtxs,
      });
      if (n > 0) {
        window.__blackopsToasts?.addToast(
          `Pruned ${n} custom LEARNED CTX mark${n === 1 ? "" : "s"}`,
          "success",
        );
      }
      refreshLearnedVram();
      return n;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.__blackopsToasts?.addToast(`Prune LEARNED failed: ${msg}`, "error");
      return 0;
    }
  }, [model?.path, refreshLearnedVram]);

  return { manifest, isEvaluating, isValidating, validate, learnedCurveCtxs, pruneLearnedCtxs };
}
