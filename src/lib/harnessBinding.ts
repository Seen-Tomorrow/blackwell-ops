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
 * Resolution: alias prefix → catalog path → 1-live solo / 2-live slot-order fallback.
 * ≥3 untagged lives without alias/path → none (never silent wrong twin).
 */
export function deriveHarnessBinding(
  stack: StackEntry[],
  catalogSeats: CatalogSeatsState = {},
): HarnessBinding {
  const live = liveEngines(stack);
  if (live.length === 0) {
    return { mode: "none", brain: null, worker: null, reason: "Launch seats from catalog" };
  }

  let brain =
    byAlias(live, "brain") ?? byCatalogPath(live, catalogSeats, "brain");
  let worker =
    byAlias(live, "worker") ?? byCatalogPath(live, catalogSeats, "worker");

  // Fallback only when neither side resolved via alias/path.
  if (!brain && !worker) {
    if (live.length === 1) {
      return { mode: "solo", brain: live[0]!, worker: null };
    }
    if (live.length === 2) {
      brain = live[0]!;
      worker = live[1]!;
    } else {
      return {
        mode: "none",
        brain: null,
        worker: null,
        reason: "Tag seats via catalog ▶ (alias BRAIN/WORKER) or launch SOLO/TWIN",
      };
    }
  } else if (!brain && worker) {
    // Worker-only: treat as solo on that seat if single live, else incomplete twin.
    if (live.length === 1) {
      return { mode: "solo", brain: worker, worker: null };
    }
    const other = live.find((e) => e.port !== worker!.port) ?? null;
    if (other && live.length === 2) {
      brain = other;
    } else {
      return {
        mode: "none",
        brain: null,
        worker,
        reason: "BRAIN seat missing — launch from catalog",
      };
    }
  } else if (brain && !worker) {
    if (live.length === 1 || live.every((e) => e.port === brain!.port)) {
      return { mode: "solo", brain, worker: null };
    }
    // Prefer remaining live as worker only when exactly one other.
    const others = live.filter((e) => e.port !== brain!.port);
    if (others.length === 1) {
      worker = others[0]!;
    } else {
      return { mode: "solo", brain, worker: null };
    }
  }

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
  return { mode: "none", brain: null, worker: null, reason: "Launch seats from catalog" };
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
