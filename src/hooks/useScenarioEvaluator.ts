import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { CompanionReport, CompanionSlot, ModelEntry, EngineConfig, GpuInfo, StackEntry, SystemInfo, VramManifest, FitScanResult } from "../lib/types";
import { EVENTS } from "../lib/events";
import { evaluate } from "../services/vram/forecast/evaluate";
import type { ForecastInput as ScenarioInput } from "../services/vram/forecast/types";
import { committedSlotsFromStack, committedStackKey, parseCtx, computeGpuAvailableList } from "../services/vram/shared";
import { isDevBuild } from "../lib/build";
import { gpuMemoryBucketKey, vramManifestSnapshotEqual, vramTopoTag } from "../lib/telemetryGpu";
import { MEMORY_SOURCE_LABELS } from "../services/vram/forecast/memorySource";
import { sanitizeLearnedCurve } from "../services/vram/shared";
import type { GpuCalibrationRow } from "../lib/vramLayerPlan";
import { errorKind, errorMessage } from "../lib/blackwellError";
import {
  isNonLaunchableModel,
  draftRoleForSpecType,
  resolveExternalDraftPath,
} from "../lib/specDraft";
import { normalizeDraftPath } from "../lib/spec/adapters";
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
  /** Host-resident lookup table (Engram / PLE) reported at load. */
  validatedEngramMib?: number;
  validatedComponentsMib?: VramManifest["validatedComponentsMib"];
  fitProbeMeasuredAt: string;
  /** On-demand probe pair at two CTXs — makes the incomplete curve affine. */
  curve?: Array<{ ctx: number; vramMib: number; hostMib?: number; kvMib?: number }>;
};

/** Lookup-table size from the GGUF header — the only engram source that survives a knob change. */
function ggufEngramMib(model: ModelEntry | null | undefined): number | undefined {
  const bytes = model?.ggufShape?.lookupTableBytes;
  return bytes != null && bytes > 0 ? bytes / 1_048_576 : undefined;
}

function activeCompanionSizeMib(slot: CompanionSlot | undefined): number | null {
  if (!slot) return null;
  if (slot.pinned_off) return 0;
  if (slot.pinned) {
    const hit = slot.candidates.find((c) => c.path === slot.pinned);
    if (hit && hit.size_bytes > 0) return hit.size_bytes / 1_048_576;
  }
  if (slot.auto && slot.auto.size_bytes > 0) {
    return slot.auto.size_bytes / 1_048_576;
  }
  return null;
}
/**
 * Second CTX for the on-demand probe pair. It must sit on the far side of the useful range:
 * two points only describe the span between them, so an anchor 32K apart from live would
 * force an extrapolation for every larger context. At/above 256K the anchor looks down;
 * below it, the anchor looks up to 512K.
 */
function probePairCtx(liveCtx: number): number {
  if (liveCtx >= 262_144) return 32_768;
  return 524_288;
}

/** Measured KV at one probe — the probe's own `ctx` column, summed over devices. */
function probeKvMib(
  components: Array<{ ctx_mib?: number }> | null | undefined,
): number | undefined {
  if (!components?.length) return undefined;
  const kv = components.reduce((sum, row) => sum + (row.ctx_mib ?? 0), 0);
  return kv > 0 ? kv : undefined;
}

function placementConfigKey(config: Record<string, unknown>): string {
  return `${config.device || ""}|${config.split || ""}|${config.gpu_sync || ""}`;
}

function draftBaseName(config: Record<string, unknown>): string {
  const draft = String(config.dflash_draft_model ?? config.mtp_draft_model ?? config.spec_draft_model ?? "");
  return draft.split(/[/\\]/).pop() || draft;
}

/**
 * llama-fit-params loads model + context with no_alloc.
 * Memory actually moves with: model, n_ctx, n_ubatch, cache-type k/v, flash-attn, ngl,
 * split-mode. `n_batch` alone changes no buffer — measured 2026-11-05, batch 512 vs 2048 were
 * identical (docs/ENGINE-MEMORY-MEASUREMENTS.md) — so a batch change must not drop the probe
 * session or force a re-probe.
 * Parallel is not a FIT input either, but it is part of this identity: a probe taken at one\n * slot count must not be shown as current for another.
 */
function cpuMoeFlag(config: Record<string, unknown>): "1" | "0" {
  return String(config.cpu_moe ?? "off").trim().toLowerCase() === "on" ? "1" : "0";
}

export function fitProbeKey(config: Record<string, unknown>, autoVramLaunch: boolean): string {
  const split = String(config.split ?? "none").trim().toLowerCase() || "none";
  const spec = effectiveSpecTypeFromConfig(config);
  const specDraft = specDraftForLearned(config);
  const draftBase = specDraft
    ? (specDraft.split(/[/\\]/).pop()?.trim().toLowerCase() || specDraft.toLowerCase())
    : "";
  return [
    config.backend_type || "",
    config["kv_quant"] || "",
    String(config.ubatch ?? ""),
    config["flash_attn"] || "",
    split,
    // Slot count moves the compute buffers, so a probe taken at one count must not be presented
    // as current for another. (llama-fit-params itself is parallel-blind, so a probe can never
    // measure the delta — only a launch's learned row can.)
    String(config.parallel ?? 1),
    spec,
    draftBase,
    cpuMoeFlag(config),
    autoVramLaunch ? "1" : "0",
  ].join("|");
}

/** Learned rows also key on boost/draft/split/cpu_moe. CTX is not here. */
export function learnedIdentityKey(config: Record<string, unknown>, autoVramLaunch: boolean): string {
  return [
    fitProbeKey(config, autoVramLaunch),
    effectiveSpecTypeFromConfig(config),
    draftBaseName(config),
    String(config.split ?? "none"),
    cpuMoeFlag(config),
  ].join("|");
}

function scenarioProbeKey(
  config: Record<string, unknown>,
  autoVramLaunch: boolean,
  fullAutoMode?: boolean,
  excludedAutoSplitGpus?: number[],
): string {
  const excl = fullAutoMode ? `|excl=${(excludedAutoSplitGpus ?? []).join(",")}` : "";
  return `${fitProbeKey(config, autoVramLaunch)}|dev=${String(config.device ?? "")}${excl}`;
}

export function liveEvalKey(
  config: Record<string, unknown>,
  autoVramLaunch: boolean,
): string {
  const cmoe = cpuMoeFlag(config) === "1";
  const moeCacheAuto = cmoe && String(config.moe_cache_auto ?? "on").trim().toLowerCase() !== "off";
  const moeCacheKey = !cmoe ? "0" : moeCacheAuto ? "auto" : String(Math.max(0, Number(config.moe_cache_mib ?? 0) || 0));
  const visionKey = String(config.vision ?? "auto").trim().toLowerCase();
  return `${placementConfigKey(config)}|${learnedIdentityKey(config, autoVramLaunch)}|ctx=${config.ctx || ""}|cache=${moeCacheKey}|vision=${visionKey}`;
}

function probeScenarioFields(
  session: ProbeSession | null,
  modelPath: string,
  hardKey: string,
  placementKey: string,
) {
  if (!session || session.modelPath !== modelPath || session.hardKey !== hardKey) {
    return {};
  }
  const placementMatches = session.placementKey === placementKey;
  if (!placementMatches) {
    return {};
  }
  return {
    fitProbeVramMib: session.validatedVramMib,
    fitProbeHostMib: session.validatedHostMib,
    fitProbeHostModelMib: session.validatedHostModelMib,
    fitProbeEngramMib: session.validatedEngramMib,
    fitProbeGpuBreakdownMib: session.validatedGpuBreakdownMib,
    fitProbeComponentsMib: session.validatedComponentsMib,
    fitProbeCurve: session.curve,
    fitProbePlacementKey: session.placementKey,
    fitProbeAnchorCtx: session.anchorCtx,
    fitProbeMeasuredAt: session.fitProbeMeasuredAt,
  };
}


interface LearnedForecastBundle {
  exact: LearnedVramEntry | null;
  exact_spilled_host_mib?: number | null;
  exact_spilled_at?: string | null;
  curve: Array<{
    ctx: number;
    vram_mib: number;
    host_mib?: number;
    kv_mib?: number;
    engram_mib?: number;
    host_model_mib?: number;
  }>;
}

interface LearnedBundleState {
  vramMib: number | null;
  specIncluded: boolean | null;
  hostMib: number | null;
  hostModelMib: number | null;
  engramMib: number | null;
  gpuBreakdownMib: number[] | null;
  gpuComponentsMib: VramManifest["validatedComponentsMib"];
  launchProfile: string | undefined;
  measuredAt: string | undefined;
  mtpContextMib: number | undefined;
  anchorCtx: number | undefined;
  spilledHostMib: number | undefined;
  spilledAt: string | undefined;
  curve: Array<{
    ctx: number;
    vramMib: number;
    hostMib?: number;
    kvMib?: number;
    engramMib?: number;
    hostModelMib?: number;
  }>;
}

interface LearnedLaunchSnapshot {
  parser_id: string;
  reference_profile?: string;
  vram_mib: number;
  gpu_breakdown_mib: number[];
  gpu_components_mib?: VramManifest["validatedComponentsMib"];
  host_mib: number;
  host_pinned_mib?: number;
  /** Host row model/ctx/compute — model_mib is host weights, not buffer. */
  host_components_mib?: { model_mib?: number; ctx_mib?: number; compute_mib?: number };
  /** Host-resident lookup table (Engram / PLE) — never VRAM by design. */
  engram_mib?: number;
  mtp_context_mib?: number;
  vision_mib?: number;
  prompt_cache_limit_mib?: number;
  effective_ctx?: number;
}

interface LearnedVramEntry {
  vram_mib: number;
  reference_batch?: number;
  reference_ubatch?: number;
  reference_spec_key?: string;
  /** Response-only: the returned vram/host already include the external draft. */
  spec_included?: boolean;
  batch_deltas?: Record<string, unknown>;
  spec_deltas?: Record<string, unknown>;
  joint_deltas?: Record<string, unknown>;
  measured_at?: string;
  gpu_breakdown_mib?: number[];
  host_mib?: number;
  /** Host row model/ctx/compute from the learned launch — model_mib = host weights. */
  host_components_mib?: { model_mib?: number; ctx_mib?: number; compute_mib?: number };
  gpu_components_mib?: VramManifest["validatedComponentsMib"];
  launch_snapshot?: LearnedLaunchSnapshot;
}

interface UseScenarioEvaluatorProps {
  model: ModelEntry | null;
  config: Record<string, any>;
  gpus: GpuInfo[];
  stack: StackEntry[];
  systemInfo?: SystemInfo | null;
  autoVramLaunch?: boolean;
  fullAutoMode?: boolean;
  /** Per-device measured runtime cost — the number and the gate both include it. */
  gpuCalibration?: GpuCalibrationRow[];
  /** Full catalog — used to resolve external draft GGUF file size for measured forecast. */
  catalogModels?: ModelEntry[];
  /** Per-card planned MiB when the config carries an applied `-ts` (see ForecastInput). */
  layerSplitMib?: number[];
  excludedAutoSplitGpus?: number[];
}

/** Effective CLI spec_type for forecast/learn — cockpit may only have Boost state until launch. */
function effectiveSpecTypeFromConfig(config: Record<string, unknown>): string {
  const raw = String(config.spec_type ?? "none").trim().toLowerCase();
  if (raw && raw !== "none" && raw !== "off") return raw;
  // Boost may inject __boost_spec_type into scenarioConfig without writing template row.
  const boost = String(config.__boost_spec_type ?? "").trim().toLowerCase();
  if (boost) return boost;
  return "none";
}

function externalDraftWanted(config: Record<string, unknown>): boolean {
  const st = effectiveSpecTypeFromConfig(config);
  // A draft PATH left over from another model/boost is not an active spec. Only the spec
  // identity decides: spec off means no draft is emitted, even if a path is still stored.
  if (st === "none" || st === "off") return false;
  if (st.includes("mtp") && !st.includes("dflash") && !st.includes("dspark") && !st.includes("eagle")) {
    return false;
  }
  return st.includes("dflash") || st.includes("dspark") || st.includes("eagle");
}

/** Resolve external draft path + size (MiB) for dflash/dspark forecast (sync path). */
function resolveDraftSizeMib(
  config: Record<string, unknown>,
  catalog: ModelEntry[] | undefined,
  draftOverride?: string,
): number | undefined {
  if (!draftOverride && !externalDraftWanted(config)) return undefined;
  const draftRaw = draftOverride ?? normalizeDraftPath(
    config.dflash_draft_model ?? config.mtp_draft_model ?? config.spec_draft_model,
  ) ?? "";
  if (!draftRaw) {
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
  if (!externalDraftWanted(config)) return "";
  return normalizeDraftPath(
    config.dflash_draft_model ?? config.mtp_draft_model ?? config.spec_draft_model,
  ) ?? "";
}

/** Raw draft path used by the learned spec identity (mirrors Rust draft_key_for_learn). */
function specDraftForLearned(config: Record<string, unknown>): string {
  const spec = effectiveSpecTypeFromConfig(config);
  if (spec === "none") return "";
  const raw = normalizeDraftPath(
    config.dflash_draft_model ?? config.mtp_draft_model ?? config.spec_draft_model,
  ) ?? "";
  const usesExternal = spec.includes("mtp")
    && !spec.includes("dflash")
    && !spec.includes("dspark")
    && !spec.includes("eagle")
    ? spec === "draft-mtp" && raw !== ""
    : spec.includes("dflash") || spec.includes("dspark") || spec.includes("eagle");
  return usesExternal ? raw : "";
}

/** Mirror Rust spec key: normalized spec type + external draft basename. */
function specKeyForLearned(
  config: Record<string, unknown>,
  draftOverride?: string,
): string {
  const spec = effectiveSpecTypeFromConfig(config);
  const draft = draftOverride ?? specDraftForLearned(config);
  if (!draft) return spec;
  const base = draft.split(/[/\\]/).pop()?.trim().toLowerCase();
  return `${spec}|${base || draft.toLowerCase()}`;
}

/**
 * Draft path that actually pairs with the selected main model.
 *
 * A path left over from another model (Boost selection is global) must not become this
 * model's spec identity: MoE MTP with a stale 27B DFlash path silently fell back to the
 * boost-off row. The pairing helpers own the model/family validation.
 */
function validDraftForForecast(
  config: Record<string, unknown>,
  model: ModelEntry | null,
  catalog: ModelEntry[] | undefined,
): string {
  const spec = effectiveSpecTypeFromConfig(config);
  if (spec === "none" || spec === "off") return "";
  const raw = normalizeDraftPath(
    config.dflash_draft_model ?? config.mtp_draft_model ?? config.spec_draft_model,
  ) ?? "";
  const role = draftRoleForSpecType(spec, raw);
  if (!role) return "";
  if (!model || !catalog?.length) return raw;
  return resolveExternalDraftPath(model, catalog, role, {
    currentPath: raw || null,
    specType: spec,
    allowAutoPair: true,
  }) ?? "";
}

// Shared scenarios-tab emission helper to avoid duplicating IPC calls to Blackwell Output Console
function emitScenarioConsole(
  modelName: string,
  modelMeta: ModelEntry["metadata"] | undefined,
  scenario: string,
  vramWeightsGb: number,
  totalNeedGb: number,
  gpuAllocations: VramManifest["gpuAllocations"],
  validatedVramMib: number | null,
  validatedComponentsMib: NonNullable<VramManifest["validatedComponentsMib"]> | null,
  uiTemplate: boolean | unknown,
  engineConfig: EngineConfig,
  memorySourceLabel?: string,
) {
  const lines: string[] = [];
  const sizeGb = modelMeta?.file_size_bytes != null ? (modelMeta.file_size_bytes / (1024**3)).toFixed(1) : '?';
  lines.push(`[SCENARIO] Model: ${modelName} | Meta: ${modelMeta ? 'YES' : 'NO'} | Arch: ${modelMeta?.architecture || '?'} | Layers: ${modelMeta?.n_layer ?? '?'} | Params: ${modelMeta?.total_params_str || '?'} | Size: ${sizeGb}G`);

  lines.push(`[SCENARIO] Scenario: ${scenario} | W:${vramWeightsGb.toFixed(1)}G Total:${totalNeedGb.toFixed(1)}G`);

  if (memorySourceLabel) {
    lines.push(`[SCENARIO] SOURCE: ${memorySourceLabel}`);
  }

  const allocText = gpuAllocations.map((a) => {
    const pct = ((a.projectedLoadGb / a.vramManufacturedGb) * 100).toFixed(0);
    return `GPU-${a.gpuIndex}=${a.projectedLoadGb.toFixed(1)}G(${pct}%)`;
  }).join(', ');
  lines.push(`[SCENARIO] GPU: ${allocText}`);

  if (validatedVramMib) {
    lines.push(`[SCENARIO] Measured: ${(validatedVramMib / 1024).toFixed(1)}G`);
  } else {
    lines.push('[SCENARIO] Measured: pending (LEARNED / FIT PROBE)');
  }

  if (validatedComponentsMib && validatedComponentsMib.length > 0) {
    const compText = validatedComponentsMib.map((c, i: number) => `GPU${i}:W=${c.model_mib} KV=${c.ctx_mib} C=${c.compute_mib}`).join(' | ');
    lines.push(`[SCENARIO] Components: ${compText}`);
  }

  const fa = uiTemplate ? 'on' : 'off';
  const ep = engineConfig.extra_params || {};
  lines.push(`[SCENARIO] Config: CTX=${ep.ctx} KVQ=${ep["kv_quant"]} Batch=${ep.batch} Par=${ep.parallel} Split=${ep.split} FA=${fa}`);

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

/** The expert cache is VRAM the launch reserves; 0 whenever the experts are not on the host. */
function moeCacheMibFor(config: Record<string, unknown>): number {
  const on = String(config.cpu_moe ?? "off").trim().toLowerCase() === "on";
  if (!on) return 0;
  return Math.max(0, Number(config.moe_cache_mib ?? 0) || 0);
}

export function useScenarioEvaluator({
  model,
  config,
  gpus,
  stack,
  systemInfo,
  autoVramLaunch = false,
  fullAutoMode = true,
  gpuCalibration,
  catalogModels,
  layerSplitMib,
  excludedAutoSplitGpus,
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
  const learnedBundleRef = useRef<LearnedBundleState | null>(null);
  const catalogModelsRef = useRef(catalogModels);
  catalogModelsRef.current = catalogModels;
  /** Disk-stat fallback for draft GGUF size when not in catalog metadata (MiB). */
  const draftDiskSizeRef = useRef<number | undefined>(undefined);
  const draftDiskPathRef = useRef("");
  const learnedFetchGenRef = useRef(0);
  const learnedFetchPendingRef = useRef(false);
  const autoVramLaunchRef = useRef(autoVramLaunch);
  const fullAutoModeRef = useRef(fullAutoMode);
  const gpuCalibrationRef = useRef(gpuCalibration);
  autoVramLaunchRef.current = autoVramLaunch;
  fullAutoModeRef.current = fullAutoMode;
  gpuCalibrationRef.current = gpuCalibration;
  const lastScenarioDebugModelRef = useRef("");
  const lastScenarioDebugNameRef = useRef("");
  const probeSessionRef = useRef<ProbeSession | null>(null);
  const validatingRef = useRef(false);
  /** Last auto-probe attempt (identity + CTX) — one try per point, never a radar loop. */
  const autoProbeKeyRef = useRef<string | null>(null);
  /** Hard knob changed (kv/ubatch/flash/split) — learned data must not skip the probe. */
  const forceProbeRef = useRef(false);
  const hadSysInfoRef = useRef(systemInfo != null);
  const hadMetaRef = useRef(Boolean(model?.metadata));
  const runEvaluationRef = useRef<() => void>(() => {});
  const scheduleEvaluationRef = useRef<(immediate?: boolean) => void>(() => {});
  const maybeAutoFitRef = useRef<() => void>(() => {});
  const gpusRef = useRef(gpus);
  const stackRef = useRef(stack);
  const systemInfoRef = useRef(systemInfo);
  const configRef = useRef(config);
  /** Applied `-ts` split from the layer plan — read per eval, so a plan change repaints. */
  const layerSplitRef = useRef<number[] | undefined>(layerSplitMib);
  const excludedAutoSplitRef = useRef<number[] | undefined>(excludedAutoSplitGpus);
  gpusRef.current = gpus;
  stackRef.current = stack;
  systemInfoRef.current = systemInfo;
  configRef.current = config;
  layerSplitRef.current = layerSplitMib;
  excludedAutoSplitRef.current = excludedAutoSplitGpus;
  fullAutoModeRef.current = fullAutoMode;

  // Combined key triggers re-eval / cache / learned fetch.
  // Split is a probe hard-key — none/layer/tensor drops the session and re-probes.
  const excludedKey = (excludedAutoSplitGpus ?? []).join(",");
  const configKey = `${liveEvalKey(config, autoVramLaunch)}|excl=${excludedKey}`;
  const probeKey = scenarioProbeKey(config, autoVramLaunch, fullAutoMode, excludedAutoSplitGpus);
  const learnedKey = learnedIdentityKey(config, autoVramLaunch);

  useEffect(() => {
    const prev = paintIdentityRef.current;
    const path = model?.path ?? "";
    if (path === prev.modelPath && probeKey === prev.probeKey) return;
    const hardKnobsChanged = path === prev.modelPath && probeKey !== prev.probeKey;
    probeSessionRef.current = null;
    autoProbeKeyRef.current = null;
    if (manifestRef.current != null) {
      commitManifest(null);
      setIsEvaluating(true);
    }
    paintIdentityRef.current = { modelPath: path, probeKey };
    if (hardKnobsChanged) {
      // KV / ubatch / flash / split changed: a learned row for the old hard knobs must not
      // suppress the fresh probe. Batch is not here — it moves no memory.
      forceProbeRef.current = true;
    }
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

    // Draft packs, companion files and interrupted sets are not mains — no LEARNED/FIT
    // glass, no auto probe. Rust's role hint is authoritative; TS path hints cover
    // unscanned files, and an incomplete set cannot launch at all.
    if (isNonLaunchableModel(model)) {
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

    const curProbeKey = scenarioProbeKey(
      curConfig,
      autoVramLaunchRef.current,
      fullAutoModeRef.current,
      excludedAutoSplitRef.current,
    );
    const curPlacementKey = placementConfigKey(curConfig);
    const session = probeSessionRef.current;
    const sessionFields = probeScenarioFields(
      session,
      model.path,
      curProbeKey,
      curPlacementKey,
    );
    const input: ScenarioInput = {
      modelMeta: model.metadata,
      engineConfig,
      gpus: curGpus,
      runningSlots,
      ramAvailableGb: sysInfo.available_memory_mib / 1024,
      ramManufacturedGb: sysInfo.total_memory_manufactured_mib / 1024,
      mmprojSizeMib: companionMmprojMibRef.current ?? model.mmproj_size_mib,
      visionOn:
        String(curConfig.vision ?? "auto").trim().toLowerCase() !== "off"
        && (companionMmprojMibRef.current ?? model.mmproj_size_mib ?? 0) > 0,
      draftSizeMib:
        resolveDraftSizeMib(
          curConfig,
          catalogModelsRef.current,
          validDraftForForecast(curConfig, model, catalogModelsRef.current),
        )
        ?? draftDiskSizeRef.current,
      autoVramLaunch: autoVramLaunchRef.current,
      fullAutoMode: fullAutoModeRef.current,
      gpuCalibration: gpuCalibrationRef.current,
      learnedVramMib: learnedBundleRef.current?.vramMib ?? undefined,
      moeCacheMib: moeCacheMibFor(curConfig),
      moeCpuExperts: cpuMoeFlag(curConfig) === "1",
      moeCacheAuto:
        cpuMoeFlag(curConfig) === "1"
        && String(curConfig.moe_cache_auto ?? "on").trim().toLowerCase() !== "off",
      learnedSpecIncluded: learnedBundleRef.current?.specIncluded ?? undefined,
      learnedHostMib: learnedBundleRef.current?.hostMib ?? undefined,
      learnedHostModelMib: learnedBundleRef.current?.hostModelMib ?? undefined,
      learnedEngramMib: learnedBundleRef.current?.engramMib ?? undefined,
      modelEngramMib: ggufEngramMib(model) ?? companionEngramMibRef.current,
      learnedGpuBreakdownMib: learnedBundleRef.current?.gpuBreakdownMib ?? undefined,
      learnedGpuComponentsMib: learnedBundleRef.current?.gpuComponentsMib ?? undefined,
      learnedLaunchProfile: learnedBundleRef.current?.launchProfile,
      learnedMeasuredAt: learnedBundleRef.current?.measuredAt,
      learnedSpilledHostMib: learnedBundleRef.current?.spilledHostMib,
      learnedSpilledAt: learnedBundleRef.current?.spilledAt,
      learnedSpecContextMib: learnedBundleRef.current?.mtpContextMib,
      learnedAnchorCtx: learnedBundleRef.current?.anchorCtx,
      learnedCurve: learnedBundleRef.current?.curve ?? [],
      layerSplitMib: layerSplitRef.current,
      excludedAutoSplitGpus: excludedAutoSplitRef.current,
      ...sessionFields,
    };

    try {
      const result = evaluate(input);
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
        emitScenarioConsole(
          modelName, model.metadata, result.scenario,
          result.vramWeightsGb, result.vramTotalGb, result.gpuAllocations,
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
      learnedBundleRef.current = null;
      setLearnedCurveCtxs([]);
      learnedFetchPendingRef.current = false;
      return;
    }
    const fetchGen = ++learnedFetchGenRef.current;
    learnedFetchPendingRef.current = true;
    learnedBundleRef.current = null;
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
    const draftModel = validDraftForForecast(curConfig, model, catalogModelsRef.current) || null;
    const vramTopo = vramTopoTag(gpusRef.current, curConfig.device);
    void invoke<LearnedForecastBundle>("get_learned_forecast_bundle", {
      modelPath: model.path,
      providerId: curConfig.backend_type || "ggml-master",
      ctx: String(queryCtx),
      kvQuant,
      split: String(curConfig.split ?? "none"),
      specType,
      draftModel,
      vramTopo: vramTopo || null,
      ubatch: Number(curConfig.ubatch ?? 0),
      parallel: Number(curConfig.parallel ?? 1),
      cpuMoe: String(curConfig.cpu_moe ?? "off"),
      modelEngramMib: ggufEngramMib(model) ?? null,
    })
      .then((bundle) => {
        if (fetchGen !== learnedFetchGenRef.current) return;
        const entry = bundle?.exact ?? null;
        const specKey = specKeyForLearned(curConfig, draftModel ?? undefined);
        const specMatch = Boolean(
          entry && (entry.reference_spec_key === specKey || entry.spec_deltas?.[specKey]),
        );
        if (entry && specMatch) {
          forceProbeRef.current = false;
        }
        const snap = entry?.launch_snapshot;
        const vramMib = entry?.vram_mib ?? snap?.vram_mib ?? null;
        const cleanCurve = sanitizeLearnedCurve(
          (bundle?.curve ?? []).map((p) => ({
            ctx: p.ctx,
            vramMib: p.vram_mib,
            hostMib: p.host_mib,
            kvMib: p.kv_mib,
            engramMib: p.engram_mib,
            hostModelMib: p.host_model_mib,
          })),
        );
        learnedBundleRef.current = {
          vramMib,
          specIncluded: entry?.spec_included ?? null,
          hostMib: entry?.host_mib ?? snap?.host_mib ?? null,
          hostModelMib: entry?.host_components_mib?.model_mib ?? snap?.host_components_mib?.model_mib ?? null,
          engramMib: snap?.engram_mib ?? null,
          gpuBreakdownMib: entry?.gpu_breakdown_mib ?? snap?.gpu_breakdown_mib ?? null,
          gpuComponentsMib: entry?.gpu_components_mib ?? snap?.gpu_components_mib ?? null,
          launchProfile: snap?.reference_profile,
          measuredAt: entry?.measured_at,
          mtpContextMib: snap?.mtp_context_mib,
          anchorCtx: vramMib ? queryCtx : undefined,
          spilledHostMib: bundle?.exact_spilled_host_mib ?? undefined,
          spilledAt: bundle?.exact_spilled_at ?? undefined,
          curve: cleanCurve,
        };
        setLearnedCurveCtxs(cleanCurve.map((p) => p.ctx));
      })
      .catch(() => {
        if (fetchGen !== learnedFetchGenRef.current) return;
        learnedBundleRef.current = null;
        setLearnedCurveCtxs([]);
      })
      .finally(() => {
        if (fetchGen !== learnedFetchGenRef.current) return;
        learnedFetchPendingRef.current = false;
        maybeAutoFitRef.current();
        scheduleEvaluationRef.current(true);
      });
  }, [
    model?.path,
    // The shape arrives after the path (catalog scan). The spill filter subtracts the
    // lookup table, so a late shape must re-run the read instead of leaving a stale model.
    model?.ggufShape?.lookupTableBytes,
    learnedKey,
    commitManifest,
  ]);

  const companionMmprojMibRef = useRef<number | null>(null);
  const companionEngramMibRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const modelPath = model?.path;
    if (!modelPath) {
      companionMmprojMibRef.current = null;
      companionEngramMibRef.current = undefined;
      return;
    }
    let cancelled = false;
    const refresh = () => {
      void invoke<CompanionReport>("resolve_companions", { modelPath })
        .then((report) => {
          if (cancelled) return;
          const nextMmproj = activeCompanionSizeMib(report.mmproj);
          const nextEngram = report.engram?.integrated
            ? undefined
            : activeCompanionSizeMib(report.engram) ?? undefined;
          const changed =
            companionMmprojMibRef.current !== nextMmproj
            || companionEngramMibRef.current !== nextEngram;
          companionMmprojMibRef.current = nextMmproj;
          companionEngramMibRef.current = nextEngram;
          if (changed) scheduleEvaluationRef.current(true);
        })
        .catch(() => {});
    };
    refresh();
    const onCompanions = (e: Event) => {
      const detail = (e as CustomEvent<{ modelPath?: string }>).detail;
      if (!detail?.modelPath || detail.modelPath === modelPath) refresh();
    };
    window.addEventListener(EVENTS.companionsChanged, onCompanions);
    return () => {
      cancelled = true;
      window.removeEventListener(EVENTS.companionsChanged, onCompanions);
    };
  }, [model?.path]);

  useEffect(() => {
    refreshLearnedVram();
  }, [refreshLearnedVram]);

  // Draft GGUF often lives outside catalog scan — fall back to on-disk size for measured forecast.
  useEffect(() => {
    const cfg = configRef.current;
    const draftPath = validDraftForForecast(cfg, model, catalogModelsRef.current);
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
  }, [configKey, model?.path, catalogModels]);

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

  useEffect(() => {
    if (!model || gpus.length === 0) {
      lastWrittenCacheKeyRef.current = "";
      commitManifest(null);
      lastTopologyRef.current = "";
      lastGpuMemoryRef.current = "";
      lastModelPathRef.current = "";
      lastConfigKeyRef.current = "";
      lastStackKeyRef.current = "";
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

  const validate = useCallback(async (): Promise<VramManifest | null> => {
    if (!model || validatingRef.current) return null;
    if (isNonLaunchableModel(model)) return null;
    const curConfig = configRef.current;
    validatingRef.current = true;
    setIsValidating(true);
    try {
      const runningSlots = committedSlotsFromStack(stackRef.current);

      const probeArgs = (ctxSize: number) => ({
        modelPath: model.path,
        providerId: curConfig.backend_type || null,
        ctxSize,
        kvQuant: curConfig["kv_quant"] || "f16",
        device: curConfig.device || "GPU-0",
        splitMode: String(curConfig.split ?? "none"),
        batch: typeof curConfig.batch === "number" ? curConfig.batch : parseInt(String(curConfig.batch), 10) || 2048,
        ubatch: typeof curConfig.ubatch === "number" ? curConfig.ubatch : parseInt(String(curConfig.ubatch), 10) || 512,
        flashAttn: curConfig["flash_attn"]?.toLowerCase() !== "off",
        cpuMoe: cpuMoeFlag(curConfig) === "1",
      });

      const anchorCtx = parseCtx(curConfig.ctx ?? "32768");
      const result: FitScanResult = await invoke("fit_scan_model", probeArgs(anchorCtx));

      const curProbeKey = scenarioProbeKey(
      curConfig,
      autoVramLaunchRef.current,
      fullAutoModeRef.current,
      excludedAutoSplitRef.current,
    );
      const curPlacementKey = placementConfigKey(curConfig);
      const prevSession = probeSessionRef.current;
      const mergedByCtx = new Map<
        number,
        { ctx: number; vramMib: number; hostMib?: number; kvMib?: number }
      >();
      if (
        prevSession
        && prevSession.modelPath === model.path
        && prevSession.hardKey === curProbeKey
        && prevSession.placementKey === curPlacementKey
      ) {
        if (prevSession.curve?.length) {
          for (const pt of prevSession.curve) mergedByCtx.set(pt.ctx, pt);
        } else if (prevSession.anchorCtx > 0 && prevSession.validatedVramMib > 0) {
          mergedByCtx.set(prevSession.anchorCtx, {
            ctx: prevSession.anchorCtx,
            vramMib: prevSession.validatedVramMib,
            hostMib: prevSession.validatedHostMib,
            kvMib: probeKvMib(prevSession.validatedComponentsMib),
          });
        }
      }
      mergedByCtx.set(anchorCtx, {
        ctx: anchorCtx,
        vramMib: result.vram_mib,
        hostMib: result.host_mib,
        kvMib: probeKvMib(result.gpu_components_mib),
      });

      const pairCtx = probePairCtx(anchorCtx);
      const wantsPair =
        pairCtx !== anchorCtx
        && ((learnedBundleRef.current?.curve?.length ?? 0) < 2
          || manifestRef.current?.memorySourceState === "launch_other");
      if (wantsPair) {
        try {
          const extra: FitScanResult = await invoke("fit_scan_model", probeArgs(pairCtx));
          if (extra.vram_mib > 0) {
            mergedByCtx.set(pairCtx, {
              ctx: pairCtx,
              vramMib: extra.vram_mib,
              hostMib: extra.host_mib,
              kvMib: probeKvMib(extra.gpu_components_mib),
            });
          }
        } catch {
          // One point is still a point; the line is a bonus, not a requirement.
        }
      }
      const mergedPoints = Array.from(mergedByCtx.values()).sort((a, b) => a.ctx - b.ctx);
      const probeCurve = mergedPoints.length >= 2 ? mergedPoints : undefined;

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

      const input: ScenarioInput = {
        modelMeta: model.metadata!,
        engineConfig,
        gpus: gpusRef.current,
        runningSlots,
        ramAvailableGb: sysInfo.available_memory_mib / 1024,
        ramManufacturedGb: sysInfo.total_memory_manufactured_mib / 1024,
        mmprojSizeMib: companionMmprojMibRef.current ?? model.mmproj_size_mib,
        visionOn:
          String(curConfig.vision ?? "auto").trim().toLowerCase() !== "off"
          && (companionMmprojMibRef.current ?? model.mmproj_size_mib ?? 0) > 0,
        draftSizeMib:
          resolveDraftSizeMib(
            curConfig,
            catalogModelsRef.current,
            validDraftForForecast(curConfig, model, catalogModelsRef.current),
          )
          ?? draftDiskSizeRef.current,
        autoVramLaunch: autoVramLaunchRef.current,
        fullAutoMode: fullAutoModeRef.current,
        gpuCalibration: gpuCalibrationRef.current,
        learnedVramMib: learnedBundleRef.current?.vramMib ?? undefined,
        moeCacheMib: moeCacheMibFor(curConfig),
        moeCpuExperts: cpuMoeFlag(curConfig) === "1",
        moeCacheAuto:
          cpuMoeFlag(curConfig) === "1"
          && String(curConfig.moe_cache_auto ?? "on").trim().toLowerCase() !== "off",
        learnedSpecIncluded: learnedBundleRef.current?.specIncluded ?? undefined,
        learnedHostMib: learnedBundleRef.current?.hostMib ?? undefined,
        learnedHostModelMib: learnedBundleRef.current?.hostModelMib ?? undefined,
        learnedEngramMib: learnedBundleRef.current?.engramMib ?? undefined,
        modelEngramMib: ggufEngramMib(model) ?? companionEngramMibRef.current,
        learnedGpuBreakdownMib: learnedBundleRef.current?.gpuBreakdownMib ?? undefined,
        learnedGpuComponentsMib: learnedBundleRef.current?.gpuComponentsMib ?? undefined,
        learnedLaunchProfile: learnedBundleRef.current?.launchProfile,
        learnedMeasuredAt: learnedBundleRef.current?.measuredAt,
        learnedSpilledHostMib: learnedBundleRef.current?.spilledHostMib,
        learnedSpilledAt: learnedBundleRef.current?.spilledAt,
        learnedSpecContextMib: learnedBundleRef.current?.mtpContextMib,
        learnedAnchorCtx: learnedBundleRef.current?.anchorCtx,
        learnedCurve: learnedBundleRef.current?.curve ?? [],
        layerSplitMib: layerSplitRef.current,
      excludedAutoSplitGpus: excludedAutoSplitRef.current,
        fitProbeVramMib: result.vram_mib,
        fitProbeHostMib: result.host_mib,
        fitProbeGpuBreakdownMib: result.gpu_breakdown_mib,
        fitProbeComponentsMib: result.gpu_components_mib,
        fitProbeCurve: probeCurve,
        fitProbePlacementKey: curPlacementKey,
        fitProbeAnchorCtx: anchorCtx,
        fitProbeMeasuredAt: probeMeasuredAt,
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
        validatedEngramMib: result.engram_mib,
        validatedComponentsMib: result.gpu_components_mib ?? null,
        fitProbeMeasuredAt: probeMeasuredAt,
        curve: probeCurve,
      };

      // Journal the probe itself: without a row we cannot tell which ctx a later launch
      // inherited its estimate from.
      void invoke("record_fit_forecast", {
        row: {
          model_path: model.path,
          ctx: anchorCtx,
          kv_quant: String(curConfig.kv_quant ?? ""),
          split: String(curConfig.split ?? "none"),
          batch: curConfig.batch ?? null,
          ubatch: curConfig.ubatch ?? null,
          validated_mib: result.vram_mib,
          host_mib: result.host_mib,
          gpu_breakdown_mib: result.gpu_breakdown_mib,
          gpu_components_mib: result.gpu_components_mib ?? null,
          fitted_ngl: null,
          mode: "full",
        },
      }).catch(() => {
        // Diagnostic only.
      });

      probeSessionRef.current = session;
      const painted = evaluate(input);
      commitManifest(painted);
      if (painted == null) {
        scheduleEvaluationRef.current(true);
      }
      return painted;
    } catch (e) {
      // `fit_scan_model` rejects with the serialized `BlackwellError`, not an `Error`.
      const msg = errorMessage(e);
      console.error("[FitValidate]", e);
      switch (errorKind(e)) {
        case "fit_probe_skipped":
          // Only a real skip is informational; the message names the reason.
          window.__blackopsToasts?.addToast(msg, "info");
          break;
        case "fit_binary_missing":
        case "fit_binary_mismatch":
          // No usable llama-fit-params — a setup problem, not an MTP skip. Saying
          // "Tom does not load MTP models" here would name the wrong cause.
          window.__blackopsToasts?.addToast(`FIT probe unavailable: ${msg}`, "error");
          break;
        case "fit_probe_failed":
        case "fit_probe_timeout":
        default:
          window.__blackopsToasts?.addToast(`FIT probe failed: ${msg}`, "error");
          break;
      }
      const hasLearned =
        learnedBundleRef.current?.vramMib != null ||
        (learnedBundleRef.current?.curve?.length ?? 0) > 0;
      void invoke("emit_to_blackwell_console", {
        category: "utils",
        content: hasLearned
          ? `[FIT] PROBE  glass=LEARNED fallback (FIT failed — will not auto-retry this split/kv)`
          : `[FIT] PROBE  glass=EVALUATING (no LEARNED + FIT failed — change model/knob to retry). ${msg.slice(0, 180)}`,
        style: "Error",
      });
      scheduleEvaluationRef.current(true);
      return null;
    } finally {
      validatingRef.current = false;
      setIsValidating(false);
    }
  }, [model, probeKey, commitManifest]);

  maybeAutoFitRef.current = () => {
    if (!autoVramLaunchRef.current || !model?.path || !model.metadata) return;
    if (isNonLaunchableModel(model)) return;
    if (validatingRef.current) return;
    const forceProbe = forceProbeRef.current;
    const liveCtx = parseCtx(configRef.current.ctx ?? "32768");
    // One automatic attempt per identity+CTX. A failed probe must not loop, but a CTX the
    // glass cannot paint must not go blank either — moving there earns one new try.
    const attemptKey = `${probeKey}|ctx=${liveCtx}`;
    if (forceProbe) autoProbeKeyRef.current = null;
    if (autoProbeKeyRef.current === attemptKey) return;
    if (learnedFetchPendingRef.current) return;
    const sess = probeSessionRef.current;
    if (
      sess
      && sess.modelPath === model.path
      && sess.hardKey === probeKey
      // A probe covers this CTX only when taken here; a probe pair is a line and covers all.
      && (sess.anchorCtx === liveCtx || (sess.curve?.length ?? 0) >= 2)
    ) {
      forceProbeRef.current = false;
      return;
    }
    // Any usable launch history for this model means the forecast can paint a point or a
    // curve; a CTX move alone must not fire a probe (the glass says ESTIMATE, RE-PROBE or
    // move on). A spilled launch is history but not a need — it must not block the probe
    // that would measure one. A hard-knob change forces a fresh probe.
    if (
      !forceProbe
      && (learnedBundleRef.current?.vramMib != null
        || (learnedBundleRef.current?.curve?.length ?? 0) > 0)
    ) {
      return;
    }
    const free = computeGpuAvailableList(
      gpusRef.current,
      committedSlotsFromStack(stackRef.current),
    );
    if (Math.max(...free, 0) < 2.5) return;
    forceProbeRef.current = false;
    autoProbeKeyRef.current = attemptKey;
    void validate();
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
        cpuMoe: String(curConfig.cpu_moe ?? "off"),
        removeCtxs,
      });
      if (n > 0) {
        window.__blackopsToasts?.addToast(
          `Pruned ${n} custom LEARNED CTX mark${n === 1 ? "" : "s"}`,
          "success",
        );
      }
      // The prune may have removed the only point the glass could paint — allow the
      // automatic probe again instead of leaving the user with an empty frame.
      autoProbeKeyRef.current = null;
      refreshLearnedVram();
      return n;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      window.__blackopsToasts?.addToast(`Prune LEARNED failed: ${msg}`, "error");
      return 0;
    }
  }, [model?.path, refreshLearnedVram]);

  // Repaint without probing: used when the config changes in a way the evaluator does not see
  // as an input change (e.g. a parameter written straight to the config object).
  const reevaluate = useCallback(() => {
    scheduleEvaluationRef.current(true);
  }, []);

  return { manifest, isEvaluating, isValidating, validate, reevaluate, learnedCurveCtxs, pruneLearnedCtxs };
}
