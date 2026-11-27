/**
 * Launch planning for catalog ENDPOINTS.
 *
 * An endpoint is a model path + role; the cockpit owns every knob. This module
 * turns endpoints into launch seats at the moment of launch and decides which
 * ones are already running. There is no saved combo here — pairing lives in the
 * endpoint store, knobs live in the cockpit.
 */

import type { LaunchPolicyId } from "./launchPolicy";
import { isLaunchPolicyId } from "./launchPolicy";
import type { SpecBoostMethod } from "./specProfiles";
import { SPEC_PROFILE_PARAM_KEYS } from "./specProfiles";
import type { ModelEntry, StackEntry } from "./types";

// ── Types ───────────────────────────────────────────────────────────────────

export type PortPolicyMode = "auto" | "prefer" | "fixed";

export type PortPolicy = {
  mode: PortPolicyMode;
  /** Used when mode is prefer | fixed */
  port?: number;
};

export type SeatRole = "brain" | "worker" | "solo";

export type LaunchSeat = {
  id: string;
  role: SeatRole;
  label?: string;
  modelPath: string;
  modelName?: string;
  providerId: string;
  binaryProfile?: string;
  policyId: LaunchPolicyId;
  /** Sparse param bag captured from the cockpit at launch time. */
  paramOverrides: Record<string, string | number>;
  /** Product Boost method (MTP / DFLASH / DSPARK / off) — not a CLI key. */
  boostMethod?: SpecBoostMethod;
  modelSpecOverrides?: Record<string, string | number>;
  portPolicy: PortPolicy;
};

// ── Path / id helpers ───────────────────────────────────────────────────────

export function normalizeModelPath(path: string): string {
  return path.replace(/\\/g, "/").toLowerCase().trim();
}

function newSeatId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `launch-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

function defaultPortPolicy(): PortPolicy {
  return { mode: "auto" };
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
  "base_port",
  "device",
  // Boost / speculative pack (natural panel knobs — both BRAIN and WORKER)
  "dflash_draft_model",
  "mtp_draft_model",
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

function normalizeBoostMethod(raw: unknown): SpecBoostMethod {
  if (raw === "ngram" || raw === "mtp" || raw === "dflash" || raw === "off") return raw;
  return "off";
}

export function boostMethodFromSeat(seat: LaunchSeat): SpecBoostMethod {
  return normalizeBoostMethod(seat.boostMethod);
}

/**
 * Capture the cockpit's current knobs as a launch seat for one endpoint.
 * Callers pass an empty config for an endpoint whose model is not the model the
 * cockpit is currently showing: those knobs belong to another model.
 */
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
  /** Preserve seat id when re-capturing the same endpoint. */
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

// ── Apply plan ──────────────────────────────────────────────────────────────

export type LaunchBindTarget = {
  seatId: string;
  role: SeatRole;
  port: number;
  slotIdx: number;
  alias: string;
  modelPath: string;
};

export type LaunchPlan = {
  /** Seats already running — bind only. */
  bind: LaunchBindTarget[];
  /** Seats that need launch_engine. */
  launch: LaunchSeat[];
  errors: string[];
};

function findRunningForSeat(
  stack: StackEntry[],
  seat: LaunchSeat,
): StackEntry | null {
  const want = normalizeModelPath(seat.modelPath);
  if (!want) return null;
  const running = stack.filter((s) => s.status === "RUNNING" && s.port > 0);
  return running.find((s) => s.model_path && normalizeModelPath(s.model_path) === want) ?? null;
}

/**
 * Pure apply plan: reuse Running engines by model path; rest must launch.
 * Port fixed/prefer is advisory for the launch step (handled by the launcher).
 */
export function resolveLaunchPlan(opts: {
  seats: LaunchSeat[];
  stack: StackEntry[];
  /** Paths known present on disk (optional). */
  availableModelPaths?: Iterable<string>;
}): LaunchPlan {
  const available = opts.availableModelPaths
    ? new Set([...opts.availableModelPaths].map(normalizeModelPath))
    : null;

  const bind: LaunchBindTarget[] = [];
  const launch: LaunchSeat[] = [];
  const errors: string[] = [];

  if (opts.seats.length === 0) {
    errors.push("No endpoints to launch");
    return { bind, launch, errors };
  }

  for (const seat of opts.seats) {
    if (!seat.modelPath?.trim()) {
      errors.push(`Endpoint ${seat.role}: missing model path`);
      continue;
    }
    if (available && !available.has(normalizeModelPath(seat.modelPath))) {
      errors.push(`Endpoint ${seat.role}: model not found — ${seat.modelName || seat.modelPath}`);
      continue;
    }
    if (!isLaunchPolicyId(seat.policyId)) {
      errors.push(`Endpoint ${seat.role}: invalid policy`);
      continue;
    }

    const hit = findRunningForSeat(opts.stack, seat);
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

  const brain = bind.find((b) => b.role === "brain");
  const worker = bind.find((b) => b.role === "worker");
  if (brain && worker && brain.port === worker.port) {
    errors.push("BRAIN and WORKER resolved to the same running engine");
  }

  return { bind, launch, errors };
}

/** BRAIN first; workers keep their endpoint order. Stable for cold start. */
export function orderSeatsForLaunch(seats: LaunchSeat[]): LaunchSeat[] {
  const rank = (r: SeatRole) => (r === "brain" ? 0 : 1);
  return [...seats].sort((a, b) => rank(a.role) - rank(b.role));
}

/** Resolve requested port for a seat (0 = auto / backend picks). */
export function resolveSeatLaunchPort(seat: LaunchSeat): number {
  if (seat.portPolicy.mode === "auto") return 0;
  const p = Number(seat.portPolicy.port);
  if (!Number.isFinite(p) || p <= 0) return 0;
  return Math.floor(p);
}
