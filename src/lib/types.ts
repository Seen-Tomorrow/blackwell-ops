/// Default provider ID — bundled with the app, always present.
export const DEFAULT_PROVIDER_ID = "ggml-master";

export interface ModelEntry {
  path: string;
  author: string;
  name: string;
  quant: string;
  size_str: string;
  vision: boolean;
  mmproj?: string;
  backend_type?: string;
  mmproj_size_mib?: number;
  sourcePathLabel?: string;
  metadata?: ModelMetadata;
  hfMeta?: HfMetadata;
}

export interface ModelPathEntry {
  path: string;
  label: string;
  isDefault: boolean;
}

export interface PathDiskUsage {
  path: string;
  totalGgufBytes: number;
  fileCount: number;
}

export interface HfMetadata {
  hfModelId: string;
  author: string;
  repoName: string;
  tags?: string[];
  downloads?: number;
  likesCount?: number;
  quantType: string;
  fileSizeBytes: number;
  lastModified?: string;
  lfsOid?: string;     // LFS content hash for incremental scan
}

export interface ModelMetadata {
  architecture: string;
  modelTypeLabel: string;
  n_layer: number;
  n_ctx_train: number;
  n_embd: number;
  n_head: number;
  n_head_kv: number;
  n_expert: number;
  n_expert_used: number;
  rope_freq_base: number;
  rope_dim: number;
  feed_forward_length?: number;
  expert_feed_forward_length?: number;
  file_type_str: string;
  bpw: number;
  tensor_counts: Record<string, number>;
  total_params_str: string;
  vocab_size: number;
  generalName: string;
  ropeScalingType: string;
  tokenizerModel: string;
  file_size_bytes: number;
  scan_timestamp: number;
  file_created?: number;
  nextn_predict_layers?: number;
}

export interface EngineConfig {
  alias: string;
  model_path: string;
  port: number;
  backend_type?: string;
  binary_profile?: string;
  extra_params?: Record<string, any>;
}

/** User's saved copy of a ProviderDefaultParam with runtime state (hidden, hiddenValues, userAddedValues, order, etc.).
 * Stored in user_providers_config.json. Created from ProviderDefaultParam at first run, then edited by the user in UI. */
export interface UserEditedTemplateParam {
  key: string;
  label: string;
  values: (string | number)[];
  order: number;
  hidden?: boolean;
  hiddenValues?: (string | number)[];
  defaultValue?: string | number;

  // ── CLI Mapping Fields (schema-driven command generation) ──
  flag?: string | null;
  flag_pair?: string[];
  ptype?: 'switch' | 'switch_onoff' | 'switch_inverted' | 'arg_select' | 'arg_select_double' | 'slider' | 'path_scanner' | 'logic_only';
  step?: number;
  ui_group?: string;
  /** When set, param renders in a docked block above PARAMETERS instead of its ui_group. Params sharing the same value group together. */
  dock?: string;
  note?: string;
  pattern?: string;
  sub_params?: Record<string, string[]>;
  userAddedValues?: (string | number)[];
  /** Factory default from provider default config — set once at load. Never changes via admin edits. */
  factoryDefault?: string | number;
}

export interface ProviderConfig {
  id: string;
  display_name: string;
  binary_path: string;
  enabled: boolean;
  params?: Record<string, any>;
  userEditedTemplateParams?: UserEditedTemplateParam[];
  groupOrder?: string[]; // Custom group order (empty = use template insertion order)
  _original_id?: string;
  git_url?: string;
  branch?: string;
  build_profile?: string;
  template_type?: string; // "ggml-llama" | "ik-llama" | "" (custom)
  display_order?: number;
  buildInfoPerEnv?: Record<string, BuildInfo>;
  binaryPathPerEnv?: Record<string, string>; // env -> sacred artifact path (e.g. "vanguard" -> "foundry/artifacts/<id>/vanguard/Release/llama-server.exe")
  downloadedVersionPerEnv?: Record<string, string>; // env -> GitHub release tag that was installed via update (e.g. "v0.7.8")
  lastPrPerEnv?: Record<string, string>; // env -> PR number (e.g. "stable" -> "21293")
  factory_provided?: boolean; // true = bundled in runtime/ or downloaded from GitHub releases
  templateVersion?: number; // bumped in default config JSON when template changes, used for update notification
  needsTemplateAttention?: boolean; // set by merge when user config version differs from factory — shows banner in ConfigPage
}

/** Provider origin classification — derived from existing fields, not stored */
export type ProviderOrigin = 'foundry' | 'downloaded' | 'bundled';

/**
 * Derive provider origin for a given environment.
 * - foundry: binary_path_per_env[env] starts with "foundry/artifacts/"
 * - downloaded: downloaded_version_per_env[env] is non-empty
 * - bundled: path points to runtime/<id>/<env>/, no build/download info
 */
export function getProviderOrigin(provider: ProviderConfig, env: string): ProviderOrigin {
  if (provider.binaryPathPerEnv?.[env]?.startsWith('foundry/artifacts/')) return 'foundry';
  if (provider.downloadedVersionPerEnv?.[env]) return 'downloaded';
  return 'bundled';
}

/** Full provider template — loaded from templates.json */
export interface ProviderTemplate {
  binary_name: string;
  description: string;
  params: ProviderDefaultParam[];
}

/** Factory blueprint from provider default config — immutable, embedded in binary. */
export interface ProviderDefaultParam extends Omit<UserEditedTemplateParam, 'values'> {
  values: (string | number)[];
  default: string | number;
  flag: string | null;
  flag_pair?: string[];
  ptype: 'switch' | 'switch_onoff' | 'switch_inverted' | 'arg_select' | 'arg_select_double' | 'slider' | 'path_scanner' | 'logic_only';
  sub_params?: Record<string, string[]>;
  dock?: string;
  hidden_default?: boolean;
}

/** Build metadata extracted from a compiled binary via --version + file mtime. */
export interface BuildInfo {
  version: string;
  buildDate: string;
  cudaVersion?: string;
}

/** Binary update info from check_binary_updates IPC command. */
export interface BinaryUpdateInfo {
  profile: string;
  profileLabel: string;
  installedVersion: string | null;
  latestVersion: string;
  available: boolean;
}

/** App update info from check_app_update IPC command. */
export interface AppUpdateInfo {
  available: boolean;
  version: string;
  currentVersion: string;
  releaseNotes: string | null;
}

/** Provider binary updates grouped by provider. */
export interface ProviderBinaryUpdates {
  providerId: string;
  updates: BinaryUpdateInfo[];
}

/** Combined startup update status from get_startup_updates IPC command. */
export interface StartupUpdateStatus {
  appUpdate: AppUpdateInfo;
  binaryUpdates: ProviderBinaryUpdates[];
}

/** Prompt mode for benchmark generation — unique vocabulary or repetitive pattern. */
export type bench_PromptMode = "unique" | "repetitive";

/** TG (generation) burst benchmark result from cmd_burst_bench IPC command. */
export interface bench_TGBenchResult {
  prompt_tokens: number;
  gen_tokens: number;
  prompt_tps: number;
  gen_tps: number;
  itl_ms: number;
  success: boolean;
  error?: string;
}

/** PP (prefill) burst benchmark result from cmd_bench_pp_burst IPC command. */
export interface bench_PPBurstResult {
  bench_prefill_tps: number;
  bench_prompt_tokens_actual: number;
  success: boolean;
  error?: string;
}

export interface GpuInfo {
  index: number;
  name: string;
  memory_total: number;
  memory_total_manufactured: number;
  memory_used: number;
  memory_free: number;
  temperature_gpu: number;
  temperature_hot_spot: number | null;
  temperature_memory: number | null;
  power_draw: number;
  power_limit: number;
  utilization_gpu: number;
  utilization_memory: number;
}

export interface CpuInfo {
  name: string;
  cores: number;
  threads: number;
  max_clock_mhz: number;
  avg_usage_percent: number;
  core_usages: number[]; // per-core usage percentage (0-100)
}

export interface SystemInfo {
  total_memory_mib: number;              // Real OS-reported RAM in MiB (used for calculations)
  available_memory_mib: number;          // Available (free + cache) in MiB
  total_memory_manufactured_mib: number; // Rounded manufactured capacity for display (e.g., 256 GB = 262144 MiB)
}

export interface StackEntry {
  idx: number;
  alias: string;
  model_name: string;
  port: number;
  gpu: string;
  status: string;
  slot_id?: number;
  provider_type?: string;
  ready_at?: string;
  model_path?: string;
  vram_mib?: number;
  n_ctx?: number;
  provider_name?: string;
  build_info?: BuildInfo;
}

/** Per-slot context bar info — matches Rust SlotCtxInfo struct */
export interface SlotCtxInfo {
  id: number;
  n_decoded: number;
  sessionNDecoded: number;
  totalTokensLifetime: number;
  is_processing: boolean;
  // Enriched from /slots for accurate prefill + full ctx fill (prompt + decoded + cache history)
  promptTokens: number;
  promptTokensProcessed: number;
  promptTokensCache: number;
  // Extra from full /slots response (n_remain especially useful for knowing how much gen is left in current request)
  nRemain?: number;
  idTask?: number;
  speculative?: boolean;
}

/** FUSION real-time engine monitoring data — emitted from Rust /slots + /metrics fusion brain. */
export interface FusionUpdate {
  alias: string;
  /** Unique engine slot index (0-based, never duplicated) */
  slotIdx: number;
  port: number;

  // Lifecycle (3 states)
  engine_state: 'LOADING' | 'READY' | 'ACTIVE';

  // Phase — fused from both sources
  phase: 'IDLE' | 'PP' | 'TG';

  // Prefill TPS: prefillTpsSession = request avg (bench-aligned); prefillTpsMetrics = /metrics smoothed gauge
  prefillTpsSession: number;   // tokens / elapsed — same as bench tokens_evaluated / prompt_ms
  prefillTpsInstant?: number;  // per-poll / log chunk — hero LIVE mode
  prefillTpsMetrics: number;   // llamacpp:prompt_tokens_seconds gauge (often lower; legacy fallback)

  // Primary prefill progress/tokens from /slots (real-time, catches short+long prompts, no 3s throttle)
  prefillProgress: number;    // 0→1 from n_prompt_tokens_processed / n_prompt_tokens
  prefillTokens: number;      // processed so far this request
  prefillTokensTotal: number; // target prompt size for current request

  // Generation metrics (primary source = /slots)
  genTps: number;         // session average since TG start (hero AVG mode)
  genTpsInstant?: number; // per-poll / log chunk — hero LIVE mode

  genTokensPerRequestSlots: number;    // from /slots n_decoded current value

  // Combined session total
  genTokensPerSession: number;

  // Context usage (primary source = /slots only)
  ctxUsedSession: number;          // cumulative across requests this session
  ctxFillPct: number;              // (ctx_used_session / ctx_total) * 100
  ctxTotal: number;                // engine context window size in tokens

  // Request timing
  requestElapsedMs: number;
  ttftMs?: number | null;          // from /metrics prompt_seconds delta

  // Per-slot CTX bars (from /slots only)
  slotCtx: SlotCtxInfo[];

  // Engine config flags
  parallel: number;
  unified_kv: boolean;

  // ── Log-parsed values (stderr print_timing lines — red in UI for comparison) ──
  /** Exact prefill progress 0→1 from "prompt processing, progress = X.XX" */
  logPrefillProgress?: number;

  /** Instantaneous PP tokens/s during prompt processing (engine's own calculation from log) */
  logPrefillTps?: number;

  /** n_tokens processed so far in current PP request (from print_timing line) */
  logPromptTokens?: number;

  /** tg = X t/s from generation print_timing line (may be delayed vs /slots real-time) */
  logGenTps?: number;

  /** Phase derived purely from log events (PP→TG via sampler_init, IDLE via stop_processing) */
  logPhase?: 'IDLE' | 'PP' | 'TG';

  /** Reset source indicator — "prompt" if NewPrompt caught request start (belt), "regression" if fallback detected (suspenders). Flashes for visual feedback then clears on next PP line. */
  phaseResetSource?: "prompt" | "regression";
}

export interface VramFitResult {
  total_vram_gb: number;
  fits: boolean;
  gpu_total_gb: number;
  breakdown: {
    model_weights_gb: number;
    kv_cache_gb: number;
    overhead_gb: number;
  };
}

/** Scenario Factory types — single source of truth for VRAM evaluation */

export type Scenario =
  | 'SOLO_FIT'
  | 'SOLO_PRESSURE'
  | 'SOLO_SPILL'
  | 'MULTI_FIT'
  | 'MULTI_PRESSURE'
  | 'MULTI_SPILL'
  | 'HW_LOCKED';

/** MOE_OPTIMAL suggestion — computed internally, not exposed as scenario */
export interface MoeSuggestion {
  /** Whether MOE_OPTIMAL would fit (on GPU or with less RAM offload) */
  wouldFit: boolean;
  
  /** VRAM savings compared to current scenario (in GB) */
  vramSavedGb?: number;
  
  /** true if MOE_OPTIMAL eliminates RAM layer spill entirely */
  avoidsSpill?: boolean;
  
  /** Speed impact estimate (<10%, minimal, etc.) */
  speedImpact: string;
  
  /** Whether to highlight/animate the badge (true when conditions are met) */
  shouldHighlight?: boolean;
  
  /** Full tooltip text for user-facing display */
  suggestionText: string;
}

/** Scenario-driven UI template — controls what VramBadge renders.
 *  Each scenario defines its own inline. VramBadge is a dumb skeleton that reads these values.
 *  GOLDEN RULE: If you want to change text, visibility, or color of an element in the forecast block,
 *  edit the scenario's uiTemplate — NOT VramBadge.tsx. */
export interface UiTemplate {
  /** GPU layer info line text (e.g. "→ 37 layers goes to GPU VRAM ~ 48.6 GB (32%)") */
  gpuLayerText: string;
  /** RAM layer info line text (e.g. "→ 23 layers in RAM — 111 GB offload (44%)") */
  ramLayerText: string;
  /** Whether to show the RAM bar + layer text at all */
  showRamBar?: boolean;
  /** Offload warning text (e.g. "RAM offload active — expect slower inference"). Omit or null to hide. */
  offloadWarningText?: string | null;
  /** KV spill risk warning text. Omit or null to hide. */
  kvSpillRiskText?: string | null;
}

export interface StyleObject {
  titleColor: string;
  gpuBarColor: string;
  borderColor: string;
  bgTint: string;
  badgeBg: string;
  icon: string;
  label: string;
  ramVisible: boolean;
  /** KV cache may spill to system RAM — honest warning, not certainty */
  kvSpillCritical?: boolean;
  /** Scenario-driven UI config — REQUIRED. Controls all text and visibility in VramBadge. */
  uiTemplate: UiTemplate;
}

export interface RunningEngine {
  slotAlias: string;
  modelShort: string;
  vramUsedMib: number;
}

export interface GpuAllocation {
  gpuIndex: number;
  name: string;
  vramManufacturedGb: number;
  vramAvailableGb: number;
  projectedLoadGb: number;
  runningEngines: RunningEngine[];
}

export interface VramManifest {
  scenario: Scenario;
  style: StyleObject;
  vramWeightsGb: number;
  vramKvGb: number;
  vramOverheadGb: number;
  vramTotalGb: number;
  ramWeightsGb: number;
  ramKvGb: number;
  ramSpillGb: number;
  ramTotalGb: number;
  ramManufacturedGb: number;
  ramAvailableGb: number;
  gpuAllocations: GpuAllocation[];
  fits: boolean;
  recommendation: string;
  gpuLayers: number;
  ramLayers: number;
  /** Original formula total before validation (preserved for comparison) */
  formulaVramTotalGb: number;
  /** FIT-validated total VRAM in MiB (replaces formula when set) */
  validatedVramMib?: number;
  /** Per-GPU breakdown from FIT scan (MiB per GPU) */
  validatedGpuBreakdownMib?: number[];
  /** Host RAM usage from FIT scan */
  validatedHostMib?: number;
    /** Per-GPU component breakdown from FIT scan (snake_case to match Rust serialization) */
  validatedComponentsMib?: {
    model_mib: number;
    ctx_mib: number;
    compute_mib: number;
  }[];
  /** Optional MOE_OPTIMAL alternative suggestion (computed but not shown as scenario) */
  moeSuggestion?: MoeSuggestion | null;
}

/** Per-GPU component breakdown parsed from llama's memory table. */
export interface GpuComponentMib {
  /** Model weights VRAM in MiB (snake_case to match Rust serialization) */
  model_mib: number;
  /** KV cache VRAM in MiB (llama "ctx", snake_case to match Rust) */
  ctx_mib: number;
  /** Compute/buffer overhead VRAM in MiB */
  compute_mib: number;
}

/** Single fit scan result for one model at one context/KV setting */
export interface FitScanResult {
  model_path: string;
  vram_mib: number;
  ctx: number;
  kv_quant: string;
  fits: boolean;
  /** Per-GPU self MiB breakdown from memory table */
  gpu_breakdown_mib?: number[];
  /** Host RAM usage from memory table */
  host_mib?: number;
  /** Per-GPU component breakdown (model/ctx/compute per GPU) */
  gpu_components_mib?: GpuComponentMib[];
}

/** Progress update during library scanning */
export interface FitScanProgress {
  model_path: string;
  model_name: string;
  status: 'scanning' | 'complete' | 'error';
  args?: string;
  vram_mib?: number;
  label?: string;
}

/** Complete result from a library scan */
export interface FitScanComplete {
  provider_id: string;
  total_models: number;
  completed: number;
  failed: number;
  scan_points_total?: number;
  results: Record<string, FitScanFull>;
}

/** Single measured data point from comprehensive scan */
export interface FitDataPoint {
  label: string;
  ctx: number;
  kv_quant: string;
  batch: number;
  parallel: number;
  split_mode: string;
  vram_mib: number;
}

/** Full comprehensive scan result for one model — all measured data points */
export interface FitScanFull {
  model_path: string;
  points: FitDataPoint[];
  error?: string;
}

export interface LogEntry {
  slot: number;
  alias: string;
  text: string;
}

export interface LogBatch {
  slot: number;
  alias: string;
  entries: LogEntry[];
}

export interface SystemEvent {
  slot: number;
  alias: string;
  text: string;
  timestamp: string;
}

export interface IntelItem {
  id: string;
  title: string;
  url: string;
  source: string;
  author: string;
  body_preview: string;
  timestamp: string;
}

// ── Hugging Face Hub Types ───────────────────────────────────────

export interface GgufFile {
  type: string;        // quant tag like "Q4_K_M"
  size_bytes: number;
  url: string;         // direct download URL
  lfsOid?: string;     // LFS content hash for incremental scan
}

export interface HfModel {
  id: string;          // e.g. "bartowski/Llama-3.1-8B-IQ1_MS"
  author: string;
  tags: string[];
  downloads: number;
  likes_count: number;
  last_modified: string;
  gguf_files: GgufFile[];
}

export interface HfSearchFilters {
  query: string;
  vram_limit_gb: number;  // 0 = no filter
  limit: number;
  sort: string;           // "downloads" | "likes" | "lastModified"
}

export interface HfSearchResponse {
  models: HfModel[];
  hasMore: boolean;
}

export interface HfModelInfo {
  id: string;
  author: string;
  description: string;
  tags: string[];
  downloads: number;
  likes_count: number;
  gguf_files: GgufFile[];
}

// ── Download Manager Types ───────────────────────────────────────

export type DownloadStatus = 'queued' | 'downloading' | 'paused' | 'completed' | 'failed' | 'scanning';

export interface DownloadTask {
  id: string;
  hfModelId: string;
  fileName: string;
  downloadUrl: string;
  totalBytes: number;
  downloadedBytes: number;
  status: DownloadStatus;
  destPath: string;
  speedBps: number;
  pauseOffset: number;
  error?: string;
  etaSeconds: number;
  hfAuthor?: string;
  quantType?: string;
  lfsOid?: string;     // LFS content hash for incremental scan
}

/** Sanitize alias for CLI/API use — replaces spaces and commas with hyphens. */
export function sanitizeAlias(alias: string): string {
    return alias.replace(/[\s,]/g, "-");
}


