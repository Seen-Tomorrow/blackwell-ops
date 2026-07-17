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
  hfModelId?: string;
  /** Path/name-derived draft role from catalog scan — works without GGUF metadata. */
  draftRoleHint?: string;
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

export interface ModelLibraryValidation {
  exists: boolean;
  ggufCount: number;
  resolvedPath: string;
}

export interface SecretStatus {
  key: string;
  label: string;
  description: string;
  configured: boolean;
  preview?: string;
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
  general_basename?: string;
  ropeScalingType: string;
  tokenizerModel: string;
  file_size_bytes: number;
  scan_timestamp: number;
  file_created?: number;
  nextn_predict_layers?: number;
  /** none | mtp_embedded | external_dflash | external_eagle3 */
  draft_role?: string;
  rawKvs?: Record<string, string>;
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
  /** Per-param catalog hide — survives SPECULATIVE-DECODING group OFF/ON. */
  userHidden?: boolean;
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
  /** Essentials view — true=force show, false=force hide, unset=factory list. */
  essential?: boolean;
}

export interface ProviderConfig {
  id: string;
  display_name: string;
  binary_path: string;
  enabled: boolean;
  params?: Record<string, any>;
  userEditedTemplateParams?: UserEditedTemplateParam[];
  /** Factory param keys removed by admin — merge will not re-append from template. */
  excludedParamKeys?: string[];
  groupOrder?: string[]; // Custom group order (empty = use template insertion order)
  /** Per-group pin above VRAM display (default: below). */
  groupDisplayZone?: Record<string, "above" | "below">;
  /** Below-zone column layout (1–3). */
  configColumnCount?: 1 | 2 | 3;
  /** Below-zone column width fractions (sum = 1). */
  configColumnWidths?: number[];
  /** Per-group below-zone column index. */
  groupColumn?: Record<string, number>;
  /** Pinned-above zone column widths (2 cols, default 65/35). */
  aboveColumnWidths?: number[];
  _original_id?: string;
  git_url?: string;
  branch?: string;
  build_profile?: string;
  template_type?: string; // "ggml-llama" | "" (custom)
  display_order?: number;
  buildInfoPerEnv?: Record<string, BuildInfo>;
  binaryPathPerEnv?: Record<string, string>; // env -> active launch path (bundled, foundry, or catalog)
  /** User preference per profile: foundry | bundled | catalog (empty = auto by mtime). */
  binarySourcePerEnv?: Record<string, string>;
  /** Inventory — bundled installer binary (runtime/<id>/<profile>/). */
  bundledBinaryPathPerEnv?: Record<string, string>;
  foundryBinaryPathPerEnv?: Record<string, string>;
  /** Catalog overlay (core: runtime-catalog/; plugins: runtime/ + stamp). */
  catalogBinaryPathPerEnv?: Record<string, string>;
  bundledBuildInfoPerEnv?: Record<string, BuildInfo>;
  foundryBuildInfoPerEnv?: Record<string, BuildInfo>;
  catalogBuildInfoPerEnv?: Record<string, BuildInfo>;
  /** Product release tag that shipped the pack (e.g. "v1.0.18") — not engine build-info. */
  downloadedVersionPerEnv?: Record<string, string>;
  lastPrPerEnv?: Record<string, string>; // env -> PR number (e.g. "stable" -> "21293")
  factory_provided?: boolean; // true = bundled in runtime/ or downloaded from GitHub releases
  /** Optional fork — template via App update; engine via provider pack (not NSIS core). */
  optionalDownload?: boolean;
  templateVersion?: number; // bumped in default config JSON when template changes, used for update notification
  needsTemplateAttention?: boolean; // set by merge when user config version differs from factory — shows banner in ConfigPage
  /** Factory launch profile — synced from spawn_profile on load (not user-persisted). */
  launchProfile?: LaunchProfile;
}

/** Factory engine-config layout defaults — shipped in *-default-config.json. */
export interface LayoutDefaults {
  configColumnCount?: 1 | 2 | 3;
  configColumnWidths?: number[];
  groupDisplayZone?: Record<string, "above" | "below">;
  groupColumn?: Record<string, number>;
  aboveColumnWidths?: number[];
}

export interface ExportFactoryTemplateResult {
  templateVersion: number;
  paths: string[];
}

/** Factory launch profile — synced from spawn_profile on load. */
export interface LaunchProfile {
  autoVram?: boolean;
  fitStyle?: string;
  /** When false, hide tensor (and row) from SPLIT chips — provider lacks stable tensor+FIT. */
  tensorSplit?: boolean;
  /** @deprecated Use fitLaunchKeys / essentialParamKeys — kept for factory JSON compat. */
  simpleParamKeys?: string[];
  /** CLI whitelist for AUTO FIT launch (excludes split — engine decides). */
  fitLaunchKeys?: string[];
  /** Param keys shown in Essentials view (panel filter only). */
  essentialParamKeys?: string[];
  fitMarginMib?: number;
}

export type ConfigViewMode = "essentials" | "full";

/** Provider origin classification — derived from existing fields, not stored */
export type ProviderOrigin = 'foundry' | 'downloaded' | 'bundled' | 'catalog';

export type BinarySourceKind = 'foundry' | 'bundled' | 'catalog';

/** Case-insensitive lookup in per-env provider maps (vanguard/VANGUARD, etc.). */
export function profileEnvLookup<T>(map: Record<string, T> | undefined, env: string): T | undefined {
  if (!map) return undefined;
  if (map[env] != null) return map[env];
  const key = Object.keys(map).find((k) => k.toLowerCase() === env.toLowerCase());
  return key ? map[key] : undefined;
}

/** True when a foundry artifact exists for this profile. */
export function isFoundryProfileBuilt(provider: ProviderConfig | undefined, env: string): boolean {
  if (!provider) return false;
  const path = profileEnvLookup(provider.foundryBinaryPathPerEnv, env);
  const info = profileEnvLookup(provider.foundryBuildInfoPerEnv, env);
  return !!(path?.trim() || info);
}

/** True when the active launch binary exists for this profile. */
export function isProfileBuilt(provider: ProviderConfig | undefined, env: string): boolean {
  if (!provider) return false;
  const path = profileEnvLookup(provider.binaryPathPerEnv, env);
  const info = profileEnvLookup(provider.buildInfoPerEnv, env);
  return !!(path?.trim() || info);
}

function normalizeBinaryPath(path: string): string {
  return path.replace(/\\/g, '/').toLowerCase();
}

/** True when the given inventory source is the active launch binary for this profile. */
export function isProfileSourceActive(
  provider: ProviderConfig,
  env: string,
  source: BinarySourceKind,
): boolean {
  const active = profileEnvLookup(provider.binaryPathPerEnv, env);
  if (!active?.trim()) return false;

  // Explicit user/system preference wins — avoids dual ACTIVE when paths collide
  // (legacy catalog-on-runtime) or inventory rows both match the active path.
  const pref = profileEnvLookup(provider.binarySourcePerEnv, env);
  if (pref === "foundry" || pref === "bundled" || pref === "catalog") {
    return pref === source;
  }

  const invMap =
    source === "foundry"
      ? provider.foundryBinaryPathPerEnv
      : source === "catalog"
        ? provider.catalogBinaryPathPerEnv
        : provider.bundledBinaryPathPerEnv;
  const inventory = profileEnvLookup(invMap, env);
  if (!inventory?.trim()) return false;
  return normalizeBinaryPath(active) === normalizeBinaryPath(inventory);
}

/**
 * Derive provider origin for a given environment.
 * - foundry: path under foundry/artifacts/
 * - catalog / downloaded: active catalog source or product-tag stamp
 * - bundled: NSIS runtime/
 */
export function getProviderOrigin(provider: ProviderConfig, env: string): ProviderOrigin {
  const norm = (profileEnvLookup(provider.binaryPathPerEnv, env) ?? '').replace(/\\/g, '/').toLowerCase();
  if (norm.includes('foundry/artifacts/')) return 'foundry';
  if (norm.includes('runtime-catalog/')) return 'catalog';
  const pref = profileEnvLookup(provider.binarySourcePerEnv, env);
  if (pref === 'catalog') return 'catalog';
  if (profileEnvLookup(provider.downloadedVersionPerEnv, env) && provider.optionalDownload) {
    return 'downloaded';
  }
  if (profileEnvLookup(provider.catalogBinaryPathPerEnv, env) && pref === 'catalog') {
    return 'catalog';
  }
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

/** Pre-build source/binary revision check — shown on Foundry confirm modal. */
export interface FoundrySourcePreview {
  status: "up_to_date" | "update_available" | "first_clone" | "binary_stale" | "no_binary" | "offline" | "unknown";
  branch: string;
  local_commit?: string | null;
  remote_commit?: string | null;
  installed_version?: string | null;
  installed_commit?: string | null;
  message: string;
  banner_tone: "green" | "amber" | "cyan" | "muted";
}

/** DEV Foundry confirm modal — CMake work tree under foundry/engines/.../work/build-{profile}/ */
export interface FoundryWorkCacheStatus {
  devCacheEnabled: boolean;
  profileId: string;
  buildDirExists: boolean;
  cmakeCachePresent: boolean;
}

/** Build metadata extracted from a compiled binary via --version + file mtime. */
export interface BuildInfo {
  version: string;
  buildDate: string;
  cudaVersion?: string;
  /** GPU arch codes from CMAKE_CUDA_ARCHITECTURES at build time (e.g. ["86","89","120"]). */
  cudaArchitectures?: string[];
}

/** Binary update info from check_binary_updates IPC command. */
export interface BinaryUpdateInfo {
  profile: string;
  profileLabel: string;
  installedVersion: string | null;
  latestVersion: string;
  available: boolean;
  /** Separate CORE_/PLUGIN_ pack exists on GitHub (core may be NSIS-only). */
  packAvailable?: boolean;
}

/** App update info from check_app_update IPC command. */
export interface AppUpdateInfo {
  available: boolean;
  version: string;
  currentVersion: string;
  releaseNotes: string | null;
}

export type UpdateChannel = 'app_only' | 'full_bundle';

export interface UpdateChannelOffering {
  channel: UpdateChannel | string;
  available: boolean;
  version: string;
  tag: string;
  sizeBytes: number;
  label: string;
  summary: string;
  releaseNotes: string | null;
}

export interface UpdateOfferings {
  currentVersion: string;
  enginesAvailable: boolean;
  appOnly: UpdateChannelOffering;
  fullBundle: UpdateChannelOffering;
  recommended: UpdateChannel | 'none' | string;
  anyAvailable: boolean;
}

/** Provider binary updates grouped by provider. */
export interface ProviderBinaryUpdates {
  providerId: string;
  updates: BinaryUpdateInfo[];
}

export interface PluginProfileOffering {
  profile: string;
  profileLabel: string;
  packAvailable: boolean;
  packVersion: string;
  sizeBytes: number;
  installed: boolean;
  /** Release-style only (e.g. v1.0.16); foundry/git noise omitted. */
  installedVersion: string | null;
  updateAvailable: boolean;
  cudaArchitectures?: string[];
  cudaVersion?: string | null;
}

export interface PluginCatalogEntry {
  id: string;
  displayName: string;
  description: string;
  installed: boolean;
  enabled: boolean | null;
  profiles: PluginProfileOffering[];
}

export interface PluginCatalogResponse {
  catalogVersion: number;
  plugins: PluginCatalogEntry[];
}

/** Combined startup update status from get_startup_updates IPC command. */
export interface StartupUpdateStatus {
  appUpdate: AppUpdateInfo;
  updateOfferings: UpdateOfferings;
  binaryUpdates: ProviderBinaryUpdates[];
}

/**
 * TG + PP bench prompt corpus (shared backend builder).
 * Unique — cycles diverse technical vocabulary. Repetitive — cycles a fixed short phrase.
 * TG: 512-token prefill (calibrated via /tokenize); measured decode = n_predict at temp 0.
 * PP: token target from chip; prefill-only (n_predict=0).
 */
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
  /** Concurrent feeds on measured run (1 = legacy single-request). */
  parallel_requests?: number;
  /** Total gen tok/s across all parallel feeds (wall clock). */
  aggregate_gen_tps?: number;
  /** Mean per-request engine gen tok/s when parallel > 1. */
  per_request_gen_tps?: number;
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
  /** NVIDIA driver version from nvidia-smi (e.g. "610.47.23"). */
  driver_version?: string;
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

export interface DiskIoInfo {
  read_mib_per_s: number;
  write_mib_per_s: number;
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
  /** Runtime profile env (vanguard/frontier/fresh/stable) the engine was launched with. */
  binaryProfile?: string;
  ready_at?: string;
  model_path?: string;
  vram_mib?: number;
  /** Per-GPU SELF MiB from live memory breakdown (CUDA0, CUDA1, …). */
  gpu_breakdown_mib?: number[];
  n_ctx?: number;
  provider_name?: string;
  build_info?: BuildInfo;
  /** Live Fusion monitoring enabled for this provider (from spawn_profile). */
  supportsFusion?: boolean;
  /** Multi-GPU split at launch (`none` / `layer` / `row` / `tensor`). */
  splitMode?: string;
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
  /** Per-slot KV budget from engine (`/slots` n_ctx or log `n_ctx_slot`). */
  nCtxSlot?: number;
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
  genTps: number;         // per-request TG avg (gated; legacy fallback)
  /** Cumulative decode TPS across bursts — hero AVG mode (mirrors prefillTpsSession). */
  genTpsSession?: number;
  genTpsInstant?: number; // per-poll / log chunk — hero LIVE mode

  /** Hero meter lane — parallel bench uses poll-only aggregate wall clock. */
  meterLane?: 'single' | 'parallel';
  busySlotCount?: number;

  genTokensPerRequestSlots: number;    // from /slots n_decoded current value

  // Combined session total
  genTokensPerSession: number;

  // Context usage (log-primary fill; per-slot budget from engine n_ctx)
  ctxUsedSession: number;          // peak slot KV fill this session
  ctxFillPct: number;              // max per-slot fill % vs n_ctx_slot
  ctxTotal: number;                // configured -c context size
  ctxPerSlot?: number;             // per-slot KV budget (n_ctx_seq)

  // Request timing
  requestElapsedMs: number;
  /** True after request end — elapsed + hero AVG must not tick (bench HTTP return / stop processing). */
  requestClosed?: boolean;
  ttftMs?: number | null;          // wall ms from request start → first decode token (/slots)
  /** Prompt prefill duration only (sampler_init / prompt eval). */
  prefillMs?: number | null;
  /** First output token after prefill completes (ttftMs − prefillMs). */
  decodeTtftMs?: number | null;

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

  /** Session cumulative MTP draft acceptance rate (0–1) from print_timing stderr. */
  specDraftAcceptRate?: number;
  specDraftAccepted?: number;
  specDraftGenerated?: number;
  /** Last completed request draft acceptance snapshot. */
  specDraftAcceptRateLast?: number;
  specDraftAcceptedLast?: number;
  specDraftGeneratedLast?: number;
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

export type Scenario = 'AUTO_FIT' | 'HW_LOCKED';

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
  /** FULL AUTO hero headline — replaces detailed bars when showDetailedForecast is false. */
  heroText?: string;
  heroSubtext?: string;
  /** ASSISTED shows full breakdown; FULL AUTO collapses to hero. */
  showDetailedForecast?: boolean;
  /** GPU layer info line text (e.g. "→ 37 layers goes to GPU VRAM ~ 48.6 GB (32%)") */
  gpuLayerText: string;
  /** RAM layer info line text (e.g. "→ 23 layers in RAM — 111 GB offload (44%)") */
  ramLayerText: string;
  /** Whether to show the RAM bar + layer text at all */
  showRamBar?: boolean;
  /** MOE_OPTIMAL expert weights — orange hatched RAM bar. */
  moeRamBar?: boolean;
  /** Inset label on RAM bar (e.g. "RAM offload — slower inference"). Omit or null to hide. */
  offloadWarningText?: string | null;
  /** Inset label on VRAM bar (e.g. KV spill risk). Omit or null to hide. */
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

/** Where the forecast GB number comes from — priority: FIT PROBE → LEARNED → FIT CACHE → FORMULA */
export type MemorySourceKind = "formula" | "fit_cache" | "fit_probe" | "learned";

export interface MemorySource {
  kind: MemorySourceKind;
  /** Primary provenance line (9px muted in UI). */
  detail: string;
  /** Breakdown line 1 — profile, per-GPU split, or hint text. */
  breakdown?: string;
  /** Breakdown line 2 — W/KV/OH components + host RAM when learned. */
  breakdownSecondary?: string;
  /** Confidence tier: formula=1 … learned=4 */
  confidence: 1 | 2 | 3 | 4;
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
  /** Forecast uses VRAM measured on a prior launch (learned-vram.json). */
  learnedFromPreviousRun?: boolean;
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
  /** AUTO_FIT: engine will launch with --split-mode layer across GPUs. */
  autoLayerSplit?: boolean;
  /** Active memory estimation path — drives SOURCE panel and GB accent color. */
  memorySource?: MemorySource;
  /** Display timestamp for on-demand FIT PROBE (set when user runs validate). */
  fitProbeMeasuredAt?: string;
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
  status: 'scanning' | 'complete' | 'error' | 'skipped' | 'point_skipped' | 'library_meta';
  args?: string;
  vram_mib?: number;
  label?: string;
  provider_id?: string;
  total_models?: number;
  scan_points_total?: number;
  /** Model-level skip (e.g. Tom + MTP) — not a point failure */
  skip_reason?: string;
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
  /** Intentional skip — not counted as scan failure */
  skip_reason?: string;
  /** Per-label skips (e.g. Tom tensor) — label → reason */
  skipped_points?: Record<string, string>;
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

export interface IntelChannel {
  id: string;
  display_name: string;
  tab_label: string;
  repo: string;
}

export interface IntelItem {
  id: string;
  title: string;
  url: string;
  source: string;
  author: string;
  body_preview: string;
  timestamp: string;
  channel: string;
  labels: string[];
  is_breaking: boolean;
  is_open: boolean;
}

export interface IntelFeed {
  channels: IntelChannel[];
  items: IntelItem[];
  fetched_at: string;
  cache_ttl_seconds: number;
}

// ── Hugging Face Hub Types ───────────────────────────────────────

export interface GgufShard {
  fileName: string;
  pathInRepo: string;
  size_bytes: number;
  url: string;
  lfsOid?: string;
  lastModified?: string;
}

export interface GgufFile {
  type: string;        // quant tag like "Q4_K_M"
  size_bytes: number;
  url: string;         // direct download URL (first shard when sharded)
  lfsOid?: string;     // LFS content hash for incremental scan
  shards?: GgufShard[];
  shardCount?: number;
  lastModified?: string;
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
  last_modified?: string;
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
  /** `hf` (default), `toolchain`, or `app` (NSIS installer) */
  taskKind?: 'hf' | 'toolchain' | 'app' | 'provider';
}

export interface DownloadTargetCheck {
  exists: boolean;
  sameModel: boolean;
  lfsMatch: boolean;
  cachedLfsOid: string | null;
}

export interface DiskCheckResult {
  quantType: string;
  matchType: 'lfs' | 'size' | 'mismatch' | 'none';
  diskFileSize: number | null;
  diskAuthor: string | null;
}

export interface HfFileUpdateCheck {
  quantType: string;
  hasUpdate: boolean;
  cachedSizeBytes: number;
  hfSizeBytes: number;
  hfLfsOid: string;
  status: 'lfs_match' | 'size_match' | 'changed' | 'not_cached';
}

export interface HfRepoUpdateStatus {
  hfModelId: string;
  files: HfFileUpdateCheck[];
  /** Local quants on disk for this repo that were checked */
  localCopyCount: number;
  /** How many of those local quants are out of date on HF */
  updateCount: number;
  error?: string | null;
}

export interface CatalogUpdateEntry {
  path: string;
  hfModelId: string;
  quant: string;
  hasUpdate: boolean;
}

export type IpcMeterTier = "green" | "yellow" | "orange" | "red";

export interface GpuControlDeviceInfo {
  index: number;
  name: string;
  powerLimitW: number;
  powerMinW: number;
  powerMaxW: number;
  powerDefaultW: number;
  coreClockMhz: number;
  memClockMhz: number;
  maxCoreClockMhz: number;
  maxMemClockMhz: number;
}

export type GpuControlOcMode = "sync" | "individual";

export interface GpuControlSharedPreset {
  powerLimitW: number;
  coreOffsetMhz: number;
  memOffsetMhz: number;
}

export interface GpuControlPreset {
  gpuIndex: number;
  powerLimitW: number;
  coreOffsetMhz: number;
  memOffsetMhz: number;
}

export interface GpuControlStepResult {
  gpuIndex: number;
  step: string;
  ok: boolean;
  detail?: string;
}

export interface GpuControlApplyResult {
  ok: boolean;
  steps: GpuControlStepResult[];
  elevated: boolean;
}

export interface GpuControlSavedState {
  reapplyOnLaunch: boolean;
  ocMode: GpuControlOcMode;
  selectedGpuIndex: number;
  sharedPreset: GpuControlSharedPreset;
  presets: GpuControlPreset[];
}

export interface IpcMeterSnapshot {
  totalPerSec: number;
  fusionPerSec: number;
  logBatchPerSec: number;
  otherPerSec: number;
  peakPerSec: number;
  tier: IpcMeterTier;
}

/** Sanitize alias for CLI/API use — replaces spaces and commas with hyphens. */
export function sanitizeAlias(alias: string): string {
    return alias.replace(/[\s,]/g, "-");
}


