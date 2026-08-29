/**
 * Launch combo presets — pure schema, storage, capture, apply plan.
 * See docs/launch-presets.md. UI is Launch toolbar + harness + manage modal.
 */

import type { LaunchPolicyId } from "./launchPolicy";
import { isLaunchPolicyId } from "./launchPolicy";
import type { SpecBoostMethod } from "./specProfiles";
import { SPEC_PROFILE_PARAM_KEYS } from "./specProfiles";
import type { ModelEntry, StackEntry } from "./types";
import {
  STORAGE_PREFIX,
  readJsonStorage,
  writeJsonStorage,
} from "./storage";

// ── Types ───────────────────────────────────────────────────────────────────

export type PortPolicyMode = "auto" | "prefer" | "fixed";

export type PortPolicy = {
  mode: PortPolicyMode;
  /** Used when mode is prefer | fixed */
  port?: number;
};

export type SeatRole = "brain" | "worker" | "solo" | "custom";

export type LaunchSeat = {
  id: string;
  role: SeatRole;
  label?: string;
  modelPath: string;
  modelName?: string;
  providerId: string;
  binaryProfile?: string;
  policyId: LaunchPolicyId;
  /** Sparse param bag (same spirit as mode profiles). */
  paramOverrides: Record<string, string | number>;
  /** Product Boost method (MTP / DFLASH / DSPARK / off) — not a CLI key. */
  boostMethod?: SpecBoostMethod;
  modelSpecOverrides?: Record<string, string | number>;
  portPolicy: PortPolicy;
};

/**
 * Agentic harness tool id. Live product is pi-only.
 * Old combos may still carry legacy `tool: "atomcode" | "qwen"` in localStorage;
 * readers must coerce any non-`"pi"` value to pi (see {@link normalizeHarnessTool}).
 * Extend this union when a second live harness ships — keep chrome neutral (`harness-*`).
 */
export type HarnessToolId = "pi";

/** Coerce a persisted (possibly legacy) harness tool id to the only live tool. */
export function normalizeHarnessTool(_raw: unknown): HarnessToolId {
  return "pi";
}

export type ComboPresetSource = "user" | "catalog-set";

export type ComboPreset = {
  id: string;
  name: string;
  version: 1;
  kind: "solo" | "twin" | "multi";
  seats: LaunchSeat[];
  /** When true, cold-launch BRAIN before WORKER (default: parallel). */
  sequenceBrainFirst?: boolean;
  harness?: {
    /** Live tool id; legacy combos may hold `"atomcode"` / `"qwen"` — use {@link normalizeHarnessTool}. */
    tool: HarnessToolId;
    defaultMode: "solo" | "twin";
    /** Override WORKER parallel for harness agents N. */
    agentsOverride?: number;
  };
  /** Catalog seat-set owned combos stay out of the casual PRESETS list. */
  source?: ComboPresetSource;
  /** 0–2 when source is catalog-set. */
  catalogSetIndex?: 0 | 1 | 2;
  createdAt: number;
  updatedAt: number;
  notes?: string;
};

export type LaunchPresetsStore = {
  version: 1;
  combos: ComboPreset[];
};

export const LAUNCH_PRESETS_KEY = `${STORAGE_PREFIX}launch-presets:v1`;
export const LAUNCH_PRESETS_MAX = 50;

// ── Path / id helpers ───────────────────────────────────────────────────────

export function normalizeModelPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase().trim();
}

export function newPresetId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `preset-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function newSeatId(): string {
  return `seat-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export function defaultPortPolicy(): PortPolicy {
  return { mode: "auto" };
}

// ── Storage ─────────────────────────────────────────────────────────────────

function emptyStore(): LaunchPresetsStore {
  return { version: 1, combos: [] };
}

export function readLaunchPresetsStore(): LaunchPresetsStore {
  const raw = readJsonStorage<LaunchPresetsStore>(LAUNCH_PRESETS_KEY);
  if (!raw || raw.version !== 1 || !Array.isArray(raw.combos)) return emptyStore();
  const valid = raw.combos.filter(isComboPreset);
  const catalog = valid.filter((c) => c.source === "catalog-set");
  const user = valid.filter((c) => c.source !== "catalog-set").slice(0, LAUNCH_PRESETS_MAX);
  return {
    version: 1,
    combos: [...catalog, ...user],
  };
}

export function writeLaunchPresetsStore(store: LaunchPresetsStore): void {
  const catalog = store.combos.filter((c) => c.source === "catalog-set");
  const user = store.combos.filter((c) => c.source !== "catalog-set").slice(0, LAUNCH_PRESETS_MAX);
  writeJsonStorage(LAUNCH_PRESETS_KEY, {
    version: 1,
    combos: [...catalog, ...user],
  });
}

export function listCombos(): ComboPreset[] {
  return readLaunchPresetsStore().combos.slice().sort((a, b) => b.updatedAt - a.updatedAt);
}

/** User-facing presets only (hide catalog seat-set bags). */
export function listUserCombos(): ComboPreset[] {
  return listCombos().filter((c) => c.source !== "catalog-set");
}

export function isCatalogOwnedCombo(c: ComboPreset): boolean {
  return c.source === "catalog-set";
}

export function saveCombo(combo: ComboPreset): ComboPreset {
  const store = readLaunchPresetsStore();
  const next = { ...combo, updatedAt: Date.now() };
  const idx = store.combos.findIndex((c) => c.id === next.id);
  if (idx >= 0) store.combos[idx] = next;
  else store.combos.unshift(next);
  writeLaunchPresetsStore(store);
  return next;
}

export function deleteCombo(id: string): void {
  const store = readLaunchPresetsStore();
  store.combos = store.combos.filter((c) => c.id !== id);
  writeLaunchPresetsStore(store);
}

export function getCombo(id: string): ComboPreset | null {
  return readLaunchPresetsStore().combos.find((c) => c.id === id) ?? null;
}

function isComboPreset(c: unknown): c is ComboPreset {
  if (!c || typeof c !== "object") return false;
  const o = c as ComboPreset;
  return (
    typeof o.id === "string"
    && typeof o.name === "string"
    && o.version === 1
    && Array.isArray(o.seats)
    && o.seats.length > 0
  );
}

// ── Capture ─────────────────────────────────────────────────────────────────

const CAPTURE_KEYS = [
  "ctx",
  "parallel",
  "kv_quant",
  "reasoning",
  "vision",
  "flash_attn",
  "load_mode",
  "batch",
  "ubatch",
  "temp",
  "top_p",
  "split",
  "offload_mode",
  "base_port",
  "device",
  // Boost / speculative pack (natural panel knobs — both BRAIN and WORKER)
  "dflash_draft_model",
  "spec_draft_model",
  ...SPEC_PROFILE_PARAM_KEYS,
] as const;

const CAPTURE_KEY_SET = new Set<string>(CAPTURE_KEYS);

function isCapturableParamKey(key: string): boolean {
  if (CAPTURE_KEY_SET.has(key)) return true;
  // Profile submenu knobs may gain keys beyond the fixed list.
  if (key.startsWith("mtp_") || key.startsWith("dflash_")) return true;
  return false;
}

function coerceCaptureValue(v: unknown): string | number | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v === "string" || typeof v === "number") return v;
  if (typeof v === "boolean") return v ? "on" : "off";
  return undefined;
}

/** Sparse overrides from a live config bag. */
export function sparseOverridesFromConfig(
  config: Record<string, unknown>,
  extraKeys?: string[],
): Record<string, string | number> {
  const keys = new Set<string>([...CAPTURE_KEYS, ...(extraKeys ?? [])]);
  const out: Record<string, string | number> = {};
  for (const k of keys) {
    const coerced = coerceCaptureValue(config[k]);
    if (coerced !== undefined) out[k] = coerced;
  }
  for (const [k, v] of Object.entries(config)) {
    if (k.startsWith("__")) continue;
    if (k in out) continue;
    if (!isCapturableParamKey(k) && !(extraKeys ?? []).includes(k)) continue;
    const coerced = coerceCaptureValue(v);
    if (coerced !== undefined) out[k] = coerced;
  }
  return out;
}

export function normalizeBoostMethod(raw: unknown): SpecBoostMethod {
  if (raw === "mtp" || raw === "dflash" || raw === "dspark" || raw === "off") return raw;
  return "off";
}

export function boostMethodFromSeat(seat: LaunchSeat): SpecBoostMethod {
  return normalizeBoostMethod(seat.boostMethod);
}

export function captureSeatFromPanel(opts: {
  model: ModelEntry;
  providerId: string;
  binaryProfile?: string;
  policyId: LaunchPolicyId;
  config: Record<string, unknown>;
  role?: SeatRole;
  label?: string;
  portPolicy?: PortPolicy;
  boostMethod?: SpecBoostMethod;
  modelSpecOverrides?: Record<string, string | number>;
  /** Preserve seat id when updating an existing bag seat. */
  seatId?: string;
}): LaunchSeat {
  return {
    id: opts.seatId ?? newSeatId(),
    role: opts.role ?? "solo",
    label: opts.label ?? opts.model.name,
    modelPath: opts.model.path,
    modelName: opts.model.name,
    providerId: opts.providerId,
    binaryProfile: opts.binaryProfile,
    policyId: opts.policyId,
    paramOverrides: sparseOverridesFromConfig(opts.config),
    boostMethod: opts.boostMethod != null ? normalizeBoostMethod(opts.boostMethod) : undefined,
    modelSpecOverrides: opts.modelSpecOverrides,
    portPolicy: opts.portPolicy ?? defaultPortPolicy(),
  };
}

/**
 * Capture from a running stack entry.
 * Prefer merging panel overrides when the panel model matches (richer bag).
 */
export function captureSeatFromStack(opts: {
  entry: StackEntry;
  role: SeatRole;
  policyId?: LaunchPolicyId;
  panelConfig?: Record<string, unknown>;
  panelModelPath?: string | null;
  portPolicy?: PortPolicy;
  boostMethod?: SpecBoostMethod;
  seatId?: string;
}): LaunchSeat {
  const e = opts.entry;
  const path = e.model_path || "";
  const panelMatch =
    opts.panelModelPath
    && path
    && normalizeModelPath(opts.panelModelPath) === normalizeModelPath(path);

  const fromPanel = panelMatch && opts.panelConfig
    ? sparseOverridesFromConfig(opts.panelConfig)
    : {};

  const fromStack: Record<string, string | number> = {};
  if (e.n_ctx && e.n_ctx > 0) fromStack.ctx = e.n_ctx;
  if (e.parallel && e.parallel > 0) fromStack.parallel = e.parallel;
  if (e.splitMode) fromStack.split = e.splitMode;

  return {
    id: opts.seatId ?? newSeatId(),
    role: opts.role,
    label: e.alias || e.model_name,
    modelPath: path,
    modelName: e.model_name,
    providerId: e.provider_type || "ggml-master",
    binaryProfile: e.binaryProfile,
    policyId: opts.policyId ?? "full_auto",
    paramOverrides: { ...fromStack, ...fromPanel },
    boostMethod: opts.boostMethod != null ? normalizeBoostMethod(opts.boostMethod) : undefined,
    portPolicy: opts.portPolicy ?? defaultPortPolicy(),
  };
}

export function buildSoloCombo(opts: {
  name: string;
  seat: LaunchSeat;
  harness?: ComboPreset["harness"];
}): ComboPreset {
  const now = Date.now();
  const seat = { ...opts.seat, role: "solo" as const };
  return {
    id: newPresetId(),
    name: opts.name,
    version: 1,
    kind: "solo",
    seats: [seat],
    harness: opts.harness,
    createdAt: now,
    updatedAt: now,
  };
}

export function buildTwinCombo(opts: {
  name: string;
  brain: LaunchSeat;
  worker: LaunchSeat;
  sequenceBrainFirst?: boolean;
  harness?: ComboPreset["harness"];
  source?: ComboPresetSource;
  catalogSetIndex?: 0 | 1 | 2;
  id?: string;
  createdAt?: number;
}): ComboPreset {
  const now = Date.now();
  const brain = { ...opts.brain, role: "brain" as const };
  const worker = { ...opts.worker, role: "worker" as const };
  // Agents N default = worker parallel (overridable in editor via harness.agentsOverride)
  const harness: ComboPreset["harness"] = opts.harness ?? {
    tool: "pi",
    defaultMode: "twin",
    agentsOverride: undefined,
  };
  return {
    id: opts.id ?? newPresetId(),
    name: opts.name,
    version: 1,
    kind: "twin",
    seats: [brain, worker],
    sequenceBrainFirst: opts.sequenceBrainFirst ?? false,
    harness: {
      ...harness,
      defaultMode: "twin",
      agentsOverride: harness.agentsOverride,
    },
    source: opts.source,
    catalogSetIndex: opts.catalogSetIndex,
    createdAt: opts.createdAt ?? now,
    updatedAt: now,
  };
}

export function catalogSetComboName(setIndex: 0 | 1 | 2): string {
  return `Catalog set ${setIndex + 1}`;
}

export function seatHasModelPath(seat: LaunchSeat | null | undefined): boolean {
  return Boolean(seat?.modelPath && seat.modelPath.trim());
}

export function catalogComboReadyForTwin(combo: ComboPreset | null | undefined): boolean {
  if (!combo) return false;
  return seatHasModelPath(seatOnCombo(combo, "brain")) && seatHasModelPath(seatOnCombo(combo, "worker"));
}

/** One-seat catalog bag — never clone the sibling from the seat being saved. */
export function ensureCatalogSetCombo(opts: {
  existing: ComboPreset | null;
  setIndex: 0 | 1 | 2;
  seat: LaunchSeat;
}): ComboPreset {
  const now = Date.now();
  if (!opts.existing) {
    return {
      id: newPresetId(),
      name: catalogSetComboName(opts.setIndex),
      version: 1,
      kind: "twin",
      seats: [opts.seat],
      sequenceBrainFirst: true,
      harness: { tool: "pi", defaultMode: "twin", agentsOverride: undefined },
      source: "catalog-set",
      catalogSetIndex: opts.setIndex,
      createdAt: now,
      updatedAt: now,
    };
  }
  return {
    ...upsertSeatOnCombo(opts.existing, opts.seat),
    source: "catalog-set",
    catalogSetIndex: opts.setIndex,
    name: opts.existing.name || catalogSetComboName(opts.setIndex),
  };
}

/** Path pin write-through — keep knobs. */
export function writeComboSeatPath(
  combo: ComboPreset,
  role: SeatRole,
  path: string,
  name?: string,
): ComboPreset {
  const paths =
    role === "brain"
      ? { brain: path }
      : role === "worker"
        ? { worker: path }
        : {};
  const names =
    role === "brain"
      ? { brain: name }
      : role === "worker"
        ? { worker: name }
        : {};
  return syncComboModelPaths(combo, paths, names);
}

/** Clear path on a bag seat; keep overrides for a later re-pin. */
export function clearComboSeatPath(combo: ComboPreset, role: SeatRole): ComboPreset {
  const seats = combo.seats.map((s) =>
    s.role === role ? { ...s, modelPath: "", modelName: s.modelName } : s,
  );
  return { ...combo, seats, updatedAt: Date.now() };
}

/** Replace or insert a role seat on a twin combo; preserves sibling seat. */
export function upsertSeatOnCombo(combo: ComboPreset, seat: LaunchSeat): ComboPreset {
  const role = seat.role;
  const seats = combo.seats.filter((s) => s.role !== role);
  seats.push(seat);
  seats.sort((a, b) => {
    const rank = (r: SeatRole) => (r === "brain" ? 0 : r === "worker" ? 1 : 2);
    return rank(a.role) - rank(b.role);
  });
  return {
    ...combo,
    kind: combo.kind === "solo" && seats.length > 1 ? "twin" : combo.kind,
    seats,
    updatedAt: Date.now(),
  };
}

export function seatOnCombo(combo: ComboPreset | null | undefined, role: SeatRole): LaunchSeat | null {
  if (!combo) return null;
  return combo.seats.find((s) => s.role === role) ?? null;
}

/** Overlay catalog path pins onto combo seats without wiping overrides. */
export function syncComboModelPaths(
  combo: ComboPreset,
  paths: { brain?: string | null; worker?: string | null },
  names?: { brain?: string; worker?: string },
): ComboPreset {
  const seats = combo.seats.map((s) => {
    if (s.role === "brain" && paths.brain) {
      return {
        ...s,
        modelPath: paths.brain,
        modelName: names?.brain ?? s.modelName,
      };
    }
    if (s.role === "worker" && paths.worker) {
      return {
        ...s,
        modelPath: paths.worker,
        modelName: names?.worker ?? s.modelName,
      };
    }
    return s;
  });
  return { ...combo, seats, updatedAt: Date.now() };
}

export function resolveAgentsN(combo: ComboPreset): number {
  if (combo.harness?.agentsOverride != null && combo.harness.agentsOverride > 0) {
    return Math.floor(combo.harness.agentsOverride);
  }
  const worker = combo.seats.find((s) => s.role === "worker") ?? combo.seats[0];
  return Math.max(1, Number(worker?.paramOverrides?.parallel) || 1);
}

// ── Apply plan ──────────────────────────────────────────────────────────────

export type ComboBindTarget = {
  seatId: string;
  role: SeatRole;
  port: number;
  slotIdx: number;
  alias: string;
  modelPath: string;
};

export type ComboApplyPlan = {
  /** Seats already running — bind only. */
  bind: ComboBindTarget[];
  /** Seats that need launch_engine. */
  launch: LaunchSeat[];
  errors: string[];
  agentsN: number;
  /** Ordered launch list (sequence or parallel). */
  launchOrder: "parallel" | "sequence_brain_first";
};

function findRunningForSeat(
  stack: StackEntry[],
  seat: LaunchSeat,
): StackEntry | null {
  const want = normalizeModelPath(seat.modelPath);
  if (!want) return null;
  const running = stack.filter((s) => s.status === "RUNNING" && s.port > 0);
  const byPath = running.find(
    (s) => s.model_path && normalizeModelPath(s.model_path) === want,
  );
  return byPath ?? null;
}

/**
 * Pure apply plan: reuse Running engines by model path; rest must launch.
 * Port fixed/prefer is advisory for the launch step (handled by launcher).
 */
export function resolveComboApply(opts: {
  combo: ComboPreset;
  stack: StackEntry[];
  /** Paths known present on disk (optional). */
  availableModelPaths?: Iterable<string>;
}): ComboApplyPlan {
  const { combo, stack } = opts;
  const available = opts.availableModelPaths
    ? new Set([...opts.availableModelPaths].map(normalizeModelPath))
    : null;

  const bind: ComboBindTarget[] = [];
  const launch: LaunchSeat[] = [];
  const errors: string[] = [];

  if (!combo.seats.length) {
    errors.push("Combo has no seats");
    return {
      bind,
      launch,
      errors,
      agentsN: 1,
      launchOrder: combo.sequenceBrainFirst ? "sequence_brain_first" : "parallel",
    };
  }

  for (const seat of combo.seats) {
    if (!seat.modelPath?.trim()) {
      errors.push(`Seat ${seat.role}: missing model path`);
      continue;
    }
    if (available && !available.has(normalizeModelPath(seat.modelPath))) {
      errors.push(`Seat ${seat.role}: model not found — ${seat.modelName || seat.modelPath}`);
      continue;
    }
    if (!isLaunchPolicyId(seat.policyId)) {
      errors.push(`Seat ${seat.role}: invalid policy`);
      continue;
    }

    const hit = findRunningForSeat(stack, seat);
    if (hit) {
      bind.push({
        seatId: seat.id,
        role: seat.role,
        port: hit.port,
        slotIdx: hit.idx,
        alias: hit.alias,
        modelPath: hit.model_path || seat.modelPath,
      });
    } else {
      launch.push(seat);
    }
  }

  // Twin: refuse partial bind of same port for both roles
  if (combo.kind === "twin") {
    const brain = bind.find((b) => b.role === "brain");
    const worker = bind.find((b) => b.role === "worker");
    if (brain && worker && brain.port === worker.port) {
      errors.push("BRAIN and WORKER resolved to the same running engine");
    }
  }

  return {
    bind,
    launch,
    errors,
    agentsN: resolveAgentsN(combo),
    launchOrder: combo.sequenceBrainFirst ? "sequence_brain_first" : "parallel",
  };
}

/** Sort launch seats for sequential BRAIN-first cold start. */
export function orderSeatsForLaunch(
  seats: LaunchSeat[],
  sequenceBrainFirst: boolean,
): LaunchSeat[] {
  if (!sequenceBrainFirst) return [...seats];
  const rank = (r: SeatRole) => (r === "brain" ? 0 : r === "worker" ? 1 : 2);
  return [...seats].sort((a, b) => rank(a.role) - rank(b.role));
}

/** Resolve requested port for a seat (0 = auto / backend picks). */
export function resolveSeatLaunchPort(seat: LaunchSeat): number {
  if (seat.portPolicy.mode === "auto") return 0;
  const p = Number(seat.portPolicy.port);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.floor(p);
}

export function duplicateCombo(combo: ComboPreset, nameSuffix = " (copy)"): ComboPreset {
  const now = Date.now();
  return {
    ...combo,
    id: newPresetId(),
    name: `${combo.name}${nameSuffix}`,
    seats: combo.seats.map((s) => ({ ...s, id: newSeatId() })),
    createdAt: now,
    updatedAt: now,
  };
}

// ── Memory estimates (placement / UX only — not full FIT) ───────────────────

export type SeatMemoryEstimate = {
  seatId: string;
  role: SeatRole;
  label: string;
  weightGb: number;
  /** Rough resident VRAM (weights × 1.12 + small headroom). */
  vramGb: number;
  /** Host spill risk placeholder — 0 unless we lack GPU pool (not computed here). */
  ramGb: number;
};

export type ComboMemoryEstimate = {
  seats: SeatMemoryEstimate[];
  totalWeightGb: number;
  totalVramGb: number;
  totalRamGb: number;
};

/** Weight from GGUF size; vram ≈ weights × 1.12 (same order as synthetic placement). */
export function estimateSeatMemory(
  seat: LaunchSeat,
  models: Array<{ path: string; metadata?: { file_size_bytes?: number }; name?: string }>,
): SeatMemoryEstimate {
  const want = normalizeModelPath(seat.modelPath);
  const m = models.find((x) => normalizeModelPath(x.path) === want);
  const bytes = m?.metadata?.file_size_bytes ?? 0;
  const weightGb = bytes > 0 ? bytes / 1024 ** 3 : 0;
  const vramGb = weightGb > 0 ? weightGb * 1.12 + 0.5 : 0;
  return {
    seatId: seat.id,
    role: seat.role,
    label: seat.modelName || m?.name || seat.modelPath.split(/[/\\]/).pop() || seat.role,
    weightGb,
    vramGb,
    ramGb: 0,
  };
}

export function estimateComboMemory(
  combo: ComboPreset,
  models: Array<{ path: string; metadata?: { file_size_bytes?: number }; name?: string }>,
): ComboMemoryEstimate {
  const seats = combo.seats.map((s) => estimateSeatMemory(s, models));
  return {
    seats,
    totalWeightGb: seats.reduce((a, s) => a + s.weightGb, 0),
    totalVramGb: seats.reduce((a, s) => a + s.vramGb, 0),
    totalRamGb: seats.reduce((a, s) => a + s.ramGb, 0),
  };
}

export function formatGb(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "—";
  return n >= 10 ? `${n.toFixed(0)} GB` : `${n.toFixed(1)} GB`;
}
