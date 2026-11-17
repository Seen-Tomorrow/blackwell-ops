/**
 * Derive SOLO/TWIN harness bindings from the live stack + the active ENDPOINT set.
 * Endpoints assign; connect only reads. The harness gets one BRAIN and one
 * WORKER; a set may carry more workers than the harness can address, so the
 * first live worker (by slot index) is the one that connects.
 */
import type { EndpointSet } from "./catalogQuickAccess";
import type { StackEntry } from "./types";

type HarnessMode = "none" | "solo" | "twin";

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

function endpointPaths(endpoints: EndpointSet, role: "brain" | "worker"): string[] {
  return endpoints.filter((e) => e.role === role).map((e) => e.path);
}

/** First live engine whose model is one of this role's endpoints. */
function byEndpointPaths(live: StackEntry[], paths: string[]): StackEntry | null {
  if (paths.length === 0) return null;
  const wanted = new Set(paths.map(normalizePath));
  return live.find((e) => e.model_path && wanted.has(normalizePath(e.model_path))) ?? null;
}

/**
 * Resolution: alias prefix → endpoint path. No untagged 1-live/2-live fallback
 * (regular dock launches must not open harness).
 */
export function deriveHarnessBinding(
  stack: StackEntry[],
  endpoints: EndpointSet = [],
): HarnessBinding {
  const live = liveEngines(stack);
  if (live.length === 0) {
    return { mode: "none", brain: null, worker: null, reason: "Launch endpoints from catalog" };
  }

  const brain =
    byAlias(live, "brain") ?? byEndpointPaths(live, endpointPaths(endpoints, "brain"));
  const worker =
    byAlias(live, "worker") ?? byEndpointPaths(live, endpointPaths(endpoints, "worker"));

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
    reason: "Launch endpoints from catalog ▶",
  };
}

/** Bound engines still booting — veil should dim, not go fully opaque. */
export function bindingHasLoading(binding: HarnessBinding): boolean {
  if (binding.brain?.status === "LOADING") return true;
  if (binding.worker?.status === "LOADING") return true;
  return false;
}

/** OPEN requires RUNNING engines (not LOADING). */
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
