/**
 * Launch combo presets — pure schema, storage, capture, apply plan.
 * See docs/launch-presets.md. UI is Launch toolbar + harness + manage modal.
 */

import type { LaunchPolicyId } from "./launchPolicy";
import { isLaunchPolicyId } from "./launchPolicy";
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
  modelSpecOverrides?: Record<string, string | number>;
  portPolicy: PortPolicy;
};

export type HarnessToolId = "pi" | "atomcode" | "qwen";

export type ComboPreset = {
  id: string;
  name: string;
  version: 1;
  kind: "solo" | "twin" | "multi";
  seats: LaunchSeat[];
  /** When true, cold-launch BRAIN before WORKER (default: parallel). */
  sequenceBrainFirst?: boolean;
  harness?: {
    tool: HarnessToolId;
    defaultMode: "solo" | "twin";
    /** Override WORKER parallel for harness agents N. */
    agentsOverride?: number;
  };
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
  return {
    version: 1,
    combos: raw.combos.filter(isComboPreset).slice(0, LAUNCH_PRESETS_MAX),
  };
}

export function writeLaunchPresetsStore(store: LaunchPresetsStore): void {
  writeJsonStorage(LAUNCH_PRESETS_KEY, {
    version: 1,
    combos: store.combos.slice(0, LAUNCH_PRESETS_MAX),
  });
}

export function listCombos(): ComboPreset[] {
  return readLaunchPresetsStore().combos.slice().sort((a, b) => b.updatedAt - a.updatedAt);
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
] as const;

/** Sparse overrides from a live config bag. */
export function sparseOverridesFromConfig(
  config: Record<string, unknown>,
  extraKeys?: string[],
): Record<string, string | number> {
  const keys = new Set<string>([...CAPTURE_KEYS, ...(extraKeys ?? [])]);
  const out: Record<string, string | number> = {};
  for (const k of keys) {
    const v = config[k];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "string" || typeof v === "number") out[k] = v;
    else if (typeof v === "boolean") out[k] = v ? "on" : "off";
  }
  // Also pick known numeric/string leftovers that look like user params
  for (const [k, v] of Object.entries(config)) {
    if (k.startsWith("__")) continue;
    if (k in out) continue;
    if (typeof v === "string" || typeof v === "number") {
      // Keep cockpit + common launch knobs only if already listed; skip huge bags
      if (CAPTURE_KEYS.includes(k as (typeof CAPTURE_KEYS)[number])) out[k] = v;
    }
  }
  return out;
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
  modelSpecOverrides?: Record<string, string | number>;
}): LaunchSeat {
  return {
    id: newSeatId(),
    role: opts.role ?? "solo",
    label: opts.label ?? opts.model.name,
    modelPath: opts.model.path,
    modelName: opts.model.name,
    providerId: opts.providerId,
    binaryProfile: opts.binaryProfile,
    policyId: opts.policyId,
    paramOverrides: sparseOverridesFromConfig(opts.config),
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
    id: newSeatId(),
    role: opts.role,
    label: e.alias || e.model_name,
    modelPath: path,
    modelName: e.model_name,
    providerId: e.provider_type || "ggml-master",
    binaryProfile: e.binaryProfile,
    policyId: opts.policyId ?? "full_auto",
    paramOverrides: { ...fromStack, ...fromPanel },
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
}): ComboPreset {
  const now = Date.now();
  const brain = { ...opts.brain, role: "brain" as const };
  const worker = { ...opts.worker, role: "worker" as const };
  // Agents N default = worker parallel (overridable in editor via harness.agentsOverride)
  const agentsFromWorker = Math.max(1, Number(worker.paramOverrides.parallel) || 1);
  const harness: ComboPreset["harness"] = opts.harness ?? {
    tool: "pi",
    defaultMode: "twin",
    agentsOverride: undefined,
  };
  return {
    id: newPresetId(),
    name: opts.name,
    version: 1,
    kind: "twin",
    seats: [brain, worker],
    sequenceBrainFirst: opts.sequenceBrainFirst ?? false,
    harness: {
      ...harness,
      defaultMode: "twin",
      // leave agentsOverride unset so apply uses WORKER parallel unless user set it
      agentsOverride: harness.agentsOverride,
    },
    createdAt: now,
    updatedAt: now,
    // stash for docs clarity
  };
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
