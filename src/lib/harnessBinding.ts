/**
 * Derive SOLO/TWIN harness seats from the live stack + catalog seat paths.
 * Catalog assigns; connect only reads. No click-cycle roles.
 */
import type { CatalogSeatsState } from "./catalogQuickAccess";
import type { StackEntry } from "./types";

export type HarnessMode = "none" | "solo" | "twin";

export type HarnessBinding = {
  mode: HarnessMode;
  brain: StackEntry | null;
  worker: StackEntry | null;
  /** Why mode is none / partial — for empty UI. */
  reason?: string;
};

function normalizePath(path: string): string {
  return path.replace(/\//g, "\\").toLowerCase();
}

function isLiveEngine(e: StackEntry): boolean {
  return (e.status === "RUNNING" || e.status === "LOADING") && e.port > 0;
}

/** BRAIN / BRAIN-2 / brain_worker style aliases from catalog launch. */
export function aliasRole(alias: string | undefined): "brain" | "worker" | null {
  const a = (alias || "").trim();
  if (!a) return null;
  if (/^brain\b/i.test(a) || /^brain[-_]/i.test(a)) return "brain";
  if (/^worker\b/i.test(a) || /^worker[-_]/i.test(a)) return "worker";
  return null;
}

function liveEngines(stack: StackEntry[]): StackEntry[] {
  return stack
    .filter(isLiveEngine)
    .slice()
    .sort((a, b) => a.idx - b.idx);
}

function byAlias(live: StackEntry[], role: "brain" | "worker"): StackEntry | null {
  return live.find((e) => aliasRole(e.alias) === role) ?? null;
}

function byCatalogPath(
  live: StackEntry[],
  seats: CatalogSeatsState,
  role: "brain" | "worker",
): StackEntry | null {
  const path = seats[role]?.path;
  if (!path?.trim()) return null;
  const want = normalizePath(path);
  return live.find((e) => e.model_path && normalizePath(e.model_path) === want) ?? null;
}

/**
 * Resolution: alias prefix → catalog path. No untagged 1-live/2-live fallback
 * (regular dock launches must not open harness).
 */
export function deriveHarnessBinding(
  stack: StackEntry[],
  catalogSeats: CatalogSeatsState = {},
): HarnessBinding {
  const live = liveEngines(stack);
  if (live.length === 0) {
    return { mode: "none", brain: null, worker: null, reason: "Launch seats from catalog" };
  }

  const brain =
    byAlias(live, "brain") ?? byCatalogPath(live, catalogSeats, "brain");
  const worker =
    byAlias(live, "worker") ?? byCatalogPath(live, catalogSeats, "worker");

  if (brain && worker && brain.port === worker.port) {
    return {
      mode: "none",
      brain: null,
      worker: null,
      reason: "BRAIN and WORKER resolved to the same engine",
    };
  }

  if (brain && worker) {
    return { mode: "twin", brain, worker };
  }
  if (brain) {
    return { mode: "solo", brain, worker: null };
  }
  return {
    mode: "none",
    brain: null,
    worker: worker,
    reason: "Launch seats from catalog ▶",
  };
}

/** Bound seats still booting — veil should dim, not go fully opaque. */
export function bindingHasLoading(binding: HarnessBinding): boolean {
  if (binding.brain?.status === "LOADING") return true;
  if (binding.worker?.status === "LOADING") return true;
  return false;
}

/** OPEN requires RUNNING seats (not LOADING). */
export function bindingReadyToOpen(binding: HarnessBinding): boolean {
  if (binding.mode === "solo") {
    return Boolean(binding.brain && binding.brain.status === "RUNNING" && binding.brain.port > 0);
  }
  if (binding.mode === "twin") {
    return Boolean(
      binding.brain
        && binding.worker
        && binding.brain.status === "RUNNING"
        && binding.worker.status === "RUNNING"
        && binding.brain.port !== binding.worker.port,
    );
  }
  return false;
}

export function engineParallel(entry: StackEntry | null | undefined): number {
  return Math.max(1, Number(entry?.parallel) || 1);
}
