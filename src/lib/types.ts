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
}

export interface EngineConfig {
  alias: string;
  model_path: string;
  port: number;
  device: string;
  kv_quant: string;
  ctx_size: string;
  batch: number;
  ubatch: number;
  parallel: number;
  offload: string;
  offload_mode: string;
  split_mode: string;
  vision: string;
  flash_attn: boolean;
  jinja: boolean;
  cont_batching: boolean;
  metrics: boolean;
  reasoning: boolean;
  mmap: boolean;
  verbose?: boolean;
  log_timestamps?: boolean;
  unified_kv?: boolean;
  backend_type?: string;
  extra_params?: Record<string, any>;
  // RoPE / Context Extension params (from genesis_template.json)
  rope_scaling?: string;
  rope_scale?: number;
  yarn_orig_ctx?: number;
  rope_freq_base?: number;
}

export interface ParamDef {
  key: string;
  label: string;
  values: (string | number)[];
  order: number;
  hidden?: boolean;
  hiddenValues?: (string | number)[];
  defaultValue?: string | number;

  // ── CLI Mapping Fields (schema-driven command generation) ──
  config_key?: string;
  flag?: string | null;
  ptype?: 'switch' | 'switch_onoff' | 'switch_inverted' | 'arg_select' | 'mapper' | 'path_scanner' | 'logic_only';
  map_id?: string;
  ui_group?: string;
  /** When set, param renders in a docked block above PARAMETERS instead of its ui_group. Params sharing the same value group together. */
  dock?: string;
  note?: string;
  pattern?: string;
  sub_params?: Record<string, string[]>;
  userAddedValues?: (string | number)[];
  /** Factory default from genesis_template.json — set once at load. Never changes via admin edits. */
  factoryDefault?: string | number;
}

export interface ProviderConfig {
  id: string;
  display_name: string;
  binary_path: string;
  enabled: boolean;
  params?: Record<string, any>;
  param_definitions?: ParamDef[];
  groupOrder?: string[]; // Custom group order (empty = use template insertion order)
  _original_id?: string;
  git_url?: string;
  branch?: string;
  build_profile?: string;
  template_type?: string; // "ggml-llama" | "ik-llama" | "" (custom)
  buildInfoPerEnv?: Record<string, BuildInfo>;
}

/** Full provider template — loaded from templates.json */
export interface ProviderTemplate {
  binary_name: string;
  description: string;
  params: TemplateParam[];
}

export interface TemplateParam extends Omit<ParamDef, 'values'> {
  values: (string | number)[];
  default: string | number;
  flag: string | null;
  ptype: 'switch' | 'switch_onoff' | 'switch_inverted' | 'arg_select' | 'mapper' | 'path_scanner' | 'logic_only';
  sub_params?: Record<string, string[]>;
  dock?: string;
}

/** Build metadata extracted from a compiled binary via --version + file mtime. */
export interface BuildInfo {
  version: string;
  buildDate: string;
  cudaVersion?: string;
}

/** Burst benchmark result from cmd_burst_bench IPC command. */
export interface BenchResult {
  prompt_tokens: number;
  gen_tokens: number;
  prompt_tps_min: number;
  prompt_tps_avg: number;
  prompt_tps_max: number;
  gen_tps_min: number;
  gen_tps_avg: number;
  gen_tps_max: number;
  itl_ms_avg: number;
  runs_count: number;
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

export interface EnginePerfEvent {
  slot: number;
  alias: string;
  tps: number;
  ttft_ms?: number | null;
  fuel_alpha_pct?: number | null;
  fuel_beta_pct?: number | null;
  n_tokens?: number;
  prompt_tokens?: number;
  kv_cache_pct?: number | null;
  prompt_progress?: number | null;
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
  | 'SOLO_CLEAN_FIT'
  | 'SOLO_BUSY_FIT'
  | 'SOLO_SPILL'
  | 'MULTI_PERFECT'
  | 'MULTI_PRESSURE'
  | 'TOTAL_SPILL'
  | 'HW_LOCKED';

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
}

/** Progress update during library scanning */
export interface FitScanProgress {
  model_path: string;
  model_name: string;
  status: 'scanning' | 'complete' | 'error';
  args?: string;
  vram_mib?: number;
}

/** Complete result from a library scan */
export interface FitScanComplete {
  provider_id: string;
  total_models: number;
  completed: number;
  failed: number;
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
  timestamp: string;
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
