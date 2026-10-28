import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, useReducer } from "react";
import { invoke } from "@tauri-apps/api/core";
import { type BuildPhase } from "../lib/foundry_constants";
import type { EdgeProgress } from "../lib/foundryProgress";
import { isCompileStep, phaseKey } from "../lib/foundryPhases";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import { useTauriListen } from "./useTauriListen";

// Configure + compile output. Keep a head segment so the configure phase survives
// even when a long compile would otherwise push it out of the tail.
const MAX_BUILD_LOG_LINES = 20000;
const BUILD_LOG_HEAD_LINES = 2000;

export interface BuildLogEntry {
  step: string;
  text: string;
  timestamp: string;
}

export interface FoundryTarget {
  providerId: string;
  environment: Env;
}

export interface FoundryBuildRequest {
  providerId: string;
  environment: Env;
  /** BOTH: queue the other profile after this one. */
  alsoEnvironment?: Env | null;
  prUrl?: string | null;
  maxCores?: number | null;
  cmakeFlags?: string | null;
  generator?: string | null;
  includeExtraTools?: boolean;
}

/**
 * Professional, robust Foundry build state management.
 *
 * Core model:
 * - A BuildSession represents the authoritative view of an in-flight (or recently completed) build.
 * - Events from the backend are treated as deltas.
 * - `foundry_status` is treated as source-of-truth for reconciliation (on mount/visibility).
 * - The FOUNDRY page and nav badge consume the session; there is no modal/dock surface.
 *
 * This eliminates the previous accumulation of refs and fragile cross-effect races.
 */

export interface BuildProgressState {
  providerId: string;
  environment: string;
  step: string;
  logLine?: string;
  buildId?: number;
  /** Ninja `[N/M]` edge counter — live compile granularity, null outside BUILD. */
  progress?: EdgeProgress | null;
  /** Profiles queued behind the active one (build-both). Empty for a single build. */
  queuedEnvironments: string[];
}

/** Authoritative snapshot from `foundry_status` (Rust `BuildProgress`). */
export interface FoundryStatusPayload {
  build_id: number;
  phase: string;
  provider_id: string;
  environment: string;
  log_line?: string | null;
  progress?: EdgeProgress | null;
  queued_environments?: string[];
}

import { normalizeBinaryProfile, type Env as FoundryEnv } from "../lib/foundry_constants";

export type Env = FoundryEnv;

// Internal clean session model (preferred)
interface BuildSession {
  id: number;
  providerId: string;
  environment: Env;
  phase: BuildPhase;
  logLine?: string;
  progress?: EdgeProgress | null;
  queuedEnvironments: string[];
}

export interface FoundryCtx {
  buildProgress: BuildProgressState | null;
  /** Full build log, provider-owned so leaving the FOUNDRY tab never loses it. */
  buildLog: BuildLogEntry[];
  /** Target selected by an ENGINE shortcut; the FOUNDRY page consumes it. */
  foundryTarget: FoundryTarget | null;
  openFoundryBuild: (providerId: string, environment: Env) => void;
  startBuild: (request: FoundryBuildRequest) => Promise<void>;
  confirmConfigure: () => Promise<void>;
  cancelBuild: () => Promise<void>;
  dismissBuild: () => Promise<void>;

  /** Wall-clock ms when compile started (first Building phase after user confirms). */
  compileStartedAt: number | null;
}

const FoundryContext = createContext<FoundryCtx>({
  buildProgress: null,
  buildLog: [],
  foundryTarget: null,
  openFoundryBuild: () => {},
  startBuild: async () => {},
  confirmConfigure: async () => {},
  cancelBuild: async () => {},
  dismissBuild: async () => {},
  compileStartedAt: null,
});

const IN_PROGRESS_PHASES = new Set([
  "GitClone",
  "GitPull",
  "Configuring",
  "WaitingForConfirm",
  "Building",
  "Validating",
  "BackupLocked",
]);

function isInProgressPhase(phase: string): boolean {
  return IN_PROGRESS_PHASES.has(phase);
}

function sessionFromStatus(status: FoundryStatusPayload): BuildSession {
  return {
    id: status.build_id,
    providerId: status.provider_id,
    environment: status.environment as Env,
    phase: (status.phase as BuildPhase) || "Configuring",
    logLine: status.log_line ?? undefined,
    progress: status.progress ?? null,
    queuedEnvironments: status.queued_environments ?? [],
  };
}

interface BuildProgressEvent {
  build_id: number;
  phase: string;
  provider_id: string;
  environment: string;
  log_line?: string;
  log_lines?: string[];
  progress?: EdgeProgress | null;
  queued_environments?: string[];
}

// ── Internal Reducer (the heart of the robust design) ─────────────────

type FoundryAction =
  | { type: 'CLOSE' }
  | { type: 'PROGRESS'; event: BuildProgressEvent }
  | { type: 'RECONCILE'; session: BuildSession | null; reason?: string };

interface FoundryInternalState {
  session: BuildSession | null;
}

function foundryReducer(state: FoundryInternalState, action: FoundryAction): FoundryInternalState {
  switch (action.type) {
    case 'CLOSE':
      return { session: null };
    case 'PROGRESS': {
      const e = action.event;
      if (!e.provider_id) return state;

      const phase = (e.phase as BuildPhase) || "Configuring";
      const session: BuildSession = {
        id: e.build_id ?? state.session?.id ?? -1,
        providerId: e.provider_id,
        environment: normalizeBinaryProfile(e.environment),
        phase,
        logLine: e.log_lines?.[e.log_lines.length - 1] ?? e.log_line,
        // Events that predate the compile stage omit the key entirely — keep the last
        // known counter for the SAME build, but never inherit the previous profile's
        // counter when build-both advances to the next build id.
        progress:
          e.progress ??
          (state.session?.id === e.build_id ? state.session.progress ?? null : null),
        queuedEnvironments: e.queued_environments ?? state.session?.queuedEnvironments ?? [],
      };
      return { session };
    }
    case 'RECONCILE': {
      if (!action.session) {
        // Keep a locally terminal result so the page can still show completion/failure;
        // clear only a session the backend says is no longer running.
        if (state.session) {
          const phaseLower = state.session.phase.toLowerCase();
          if (phaseLower === 'complete' || phaseLower === 'error' || phaseLower === 'failed') {
            return state;
          }
        }
        return { session: null };
      }
      return { session: action.session };
    }
    default:
      return state;
  }
}

const initialInternalState: FoundryInternalState = {
  session: null,
};

export const FoundryProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [internal, dispatch] = useReducer(foundryReducer, initialInternalState);
  const [compileStartedAt, setCompileStartedAt] = useState<number | null>(null);
  const [buildLog, setBuildLog] = useState<BuildLogEntry[]>([]);
  const [foundryTarget, setFoundryTarget] = useState<FoundryTarget | null>(null);
  /** Last profile seen in the log — used for the build-both divider. */
  const lastLogEnvRef = useRef<string | null>(null);

  // Only a few refs remain — build id sequencing and the compile clock.
  const lastBuildIdRef = useRef<number | null>(null);
  const compileBuildIdRef = useRef<number | null>(null);
  const prevBuildStepRef = useRef<string | null>(null);
  const hasReconciledRef = useRef(false);

  const mapPhase = useCallback((phase: string) => phaseKey(phase), []);

  // ── Derived values (the clean public surface) ───────────────────────
  const session = internal.session;

  const buildProgress: BuildProgressState | null = session
    ? {
        providerId: session.providerId,
        environment: session.environment,
        step: mapPhase(session.phase),
        logLine: session.logLine,
        buildId: session.id > 0 ? session.id : undefined,
        progress: session.progress ?? null,
        queuedEnvironments: session.queuedEnvironments,
      }
    : null;

  // Compile timer — starts when user proceeds past cmake confirm into Building.
  useEffect(() => {
    if (!buildProgress?.buildId) {
      if (!buildProgress) {
        setCompileStartedAt(null);
        compileBuildIdRef.current = null;
        prevBuildStepRef.current = null;
      }
      return;
    }

    const { buildId, step } = buildProgress;

    if (compileBuildIdRef.current != null && compileBuildIdRef.current !== buildId) {
      setCompileStartedAt(null);
      prevBuildStepRef.current = null;
    }

    const enteringCompile =
      step === "building" && prevBuildStepRef.current !== "building" && prevBuildStepRef.current !== "validating";

    if (enteringCompile) {
      setCompileStartedAt(Date.now());
      compileBuildIdRef.current = buildId;
    } else if (isCompileStep(step) && compileBuildIdRef.current !== buildId) {
      setCompileStartedAt(Date.now());
      compileBuildIdRef.current = buildId;
    }

    prevBuildStepRef.current = step;
  }, [buildProgress]);

  // One clean reconciliation function
  const reconcileWithBackend = useCallback(async (reason: string) => {
    try {
      const status = await invoke<FoundryStatusPayload | null>("foundry_status");
      if (status) {
        const reconciledSession = sessionFromStatus(status);
        if (status.build_id > 0) {
          lastBuildIdRef.current = status.build_id;
        }
        dispatch({ type: 'RECONCILE', session: reconciledSession, reason });
      } else {
        dispatch({ type: 'RECONCILE', session: null, reason });
      }
    } catch (err) {
      console.error(`[Foundry] Reconciliation failed (${reason}):`, err);
    }
  }, []);

  // ── Page-owned build flow ───────────────────────────────────────────
  const openFoundryBuild = useCallback((providerId: string, environment: Env) => {
    setFoundryTarget({ providerId, environment });
    dispatchAppEvent(EVENTS.navigateFoundry, { providerId, environment });
  }, []);

  const startBuild = useCallback(async (request: FoundryBuildRequest) => {
    // Never start a duplicate while the backend owns an in-flight build.
    try {
      const status = await invoke<FoundryStatusPayload | null>("foundry_status");
      if (status && isInProgressPhase(status.phase)) {
        void reconcileWithBackend('attach');
        throw new Error("A Foundry build is already running.");
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("already running")) throw err;
      // Status probe failed — let foundry_build be the authority.
    }

    setFoundryTarget({ providerId: request.providerId, environment: request.environment });
    setBuildLog([]);
    lastLogEnvRef.current = null;
    lastBuildIdRef.current = null;
    setCompileStartedAt(null);
    compileBuildIdRef.current = null;
    prevBuildStepRef.current = null;

    // Do NOT create an optimistic session here: if foundry_build rejects, the form
    // must stay mounted with its error. The backend's first progress event flips the
    // page to the build view; until then the form's STARTING… state is the feedback.
    try {
      await invoke("foundry_build", {
        providerId: request.providerId,
        environment: request.environment,
        alsoEnvironment: request.alsoEnvironment ?? null,
        autoConfirm: true,
        prUrl: request.prUrl?.trim() || null,
        maxCores: request.maxCores ?? undefined,
        cmakeFlags: request.cmakeFlags || null,
        generator: request.generator || null,
        includeExtraTools: request.includeExtraTools ?? false,
      });
    } catch (err) {
      throw err;
    }
  }, [reconcileWithBackend]);

  const confirmConfigure = useCallback(async () => {
    await invoke("foundry_confirm_build");
  }, []);

  /** Clear the page session + log, and retire late backend events. */
  const closeBuildSession = useCallback(async () => {
    dispatch({ type: 'CLOSE' });
    setBuildLog([]);
    lastLogEnvRef.current = null;
    lastBuildIdRef.current = Number.MAX_SAFE_INTEGER;
    setCompileStartedAt(null);
    compileBuildIdRef.current = null;
    prevBuildStepRef.current = null;
    try { await invoke("foundry_cancel"); } catch { /* best effort */ }
  }, []);

  const cancelBuild = useCallback(async () => {
    await closeBuildSession();
  }, [closeBuildSession]);

  const dismissBuild = useCallback(async () => {
    await closeBuildSession();
  }, [closeBuildSession]);

  // ── Event listener (progress deltas) ───────────────────────────────
  useTauriListen<BuildProgressEvent>("foundry-progress", (payload) => {
    if (!payload?.provider_id) return;

    // Build id sequencing guard (same as before, but simpler)
    const previousBuildId = lastBuildIdRef.current;
    if (payload.build_id != null) {
      if (lastBuildIdRef.current === null) {
        lastBuildIdRef.current = payload.build_id;
      } else if (payload.build_id < lastBuildIdRef.current) {
        return;
      } else {
        lastBuildIdRef.current = payload.build_id;
      }
    }

    // Log is provider-owned: the FOUNDRY page can be left and reopened without
    // losing the compile output. A higher build id inside one session is the
    // build-both queue advancing to its next profile.
    const queuedAdvance =
      previousBuildId != null &&
      payload.build_id != null &&
      payload.build_id > previousBuildId;
    const stepLabel = payload.phase || "";
    const ts = new Date().toLocaleTimeString();
    const incoming: BuildLogEntry[] = [];
    if (queuedAdvance) {
      incoming.push({
        step: "QUEUE",
        text: `── ${(lastLogEnvRef.current ?? "previous").toUpperCase()} PUBLISHED · ${payload.environment.toUpperCase()} BUILD STARTED ──`,
        timestamp: ts,
      });
    }
    if (payload.log_lines?.length) {
      for (const text of payload.log_lines) {
        incoming.push({ step: stepLabel, text, timestamp: ts });
      }
    } else if (payload.log_line) {
      incoming.push({ step: stepLabel, text: payload.log_line, timestamp: ts });
    }
    if (incoming.length > 0) {
      setBuildLog(prev => {
        const next = [...prev];
        for (const entry of incoming) {
          // Some cmake/ninja lines are mirrored to stdout AND stderr, and a phase
          // event can race the batch that carries the same sentence. Drop exact
          // repeats within a short window — not only the immediately previous line.
          let duplicate = false;
          for (let i = next.length - 1; i >= Math.max(0, next.length - 8); i--) {
            if (next[i].step === entry.step && next[i].text === entry.text) {
              duplicate = true;
              break;
            }
          }
          if (duplicate) continue;
          next.push(entry);
        }
        return next.length > MAX_BUILD_LOG_LINES
          ? [
              ...next.slice(0, BUILD_LOG_HEAD_LINES),
              ...next.slice(BUILD_LOG_HEAD_LINES + (next.length - MAX_BUILD_LOG_LINES)),
            ]
          : next;
      });
    }
    lastLogEnvRef.current = payload.environment ?? lastLogEnvRef.current;

    dispatch({ type: 'PROGRESS', event: payload });

    // Keep the terminal session alive for the page's completion/failure view.
    const step = mapPhase(payload.phase);
    if (step === "complete" || step === "error") {
      lastBuildIdRef.current = null;
    }
  }, []);

  // ── Mount + Visibility reconciliation (the robust recovery path) ───
  useEffect(() => {
    if (!hasReconciledRef.current) {
      hasReconciledRef.current = true;
      void reconcileWithBackend('mount');
    }

    const onVisibility = () => {
      if (document.visibilityState === "visible") {
        void reconcileWithBackend('visibility');
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, [reconcileWithBackend]);

  // ── Public context value ───────────────────────────────────────────
  const ctxValue = useMemo<FoundryCtx>(() => ({
    buildProgress,
    buildLog,
    foundryTarget,
    openFoundryBuild,
    startBuild,
    confirmConfigure,
    cancelBuild,
    dismissBuild,
    compileStartedAt,
  }), [
    buildProgress,
    buildLog,
    foundryTarget,
    openFoundryBuild,
    startBuild,
    confirmConfigure,
    cancelBuild,
    dismissBuild,
    compileStartedAt,
  ]);

  return (
    <FoundryContext.Provider value={ctxValue}>
      {children}
    </FoundryContext.Provider>
  );
};

export function useFoundry(): FoundryCtx {
  return useContext(FoundryContext);
}
