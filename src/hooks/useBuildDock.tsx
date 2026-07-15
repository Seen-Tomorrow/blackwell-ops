import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, useReducer } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { type BuildPhase } from "../lib/foundry_constants";

/**
 * Professional, robust Foundry build state management.
 *
 * Core model:
 * - A BuildSession represents the authoritative view of an in-flight (or recently completed) build.
 * - Events from the backend are treated as deltas.
 * - `foundry_status` is treated as source-of-truth for reconciliation (on mount, visibility restore, explicit attach).
 * - UI concerns (modal visibility intent, dock widget) are derived from the session + explicit user intent.
 *
 * This eliminates the previous accumulation of refs and fragile cross-effect races.
 */

export interface BuildProgressState {
  providerId: string;
  environment: string;
  step: string;
  logLine?: string;
  buildId?: number;
}

/** Authoritative snapshot from `foundry_status` (Rust `BuildProgress`). */
export interface FoundryStatusPayload {
  build_id: number;
  phase: string;
  provider_id: string;
  environment: string;
  log_line?: string | null;
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
}

export interface FoundryCtx {
  // Shape kept for backward compatibility with ProvidersConfig expanded section + existing consumers
  buildProgress: BuildProgressState | null;
  foundryModal: { providerId: string; environment: Env } | null;
  foundryModalVisible: boolean;
  /** True after HMR/remount reattached to an in-flight backend build (dev recovery signal). */
  reattachedFromBackend: boolean;

  openBuildModal: (providerId: string, environment: Env) => void;
  minimizeBuildModal: () => void;
  restoreBuildModal: () => void;
  closeBuildModal: () => void;
  attachToActiveBuild: () => void;

  /** Increments every time the user explicitly clicks to start a new build (used to force-reset modal internal state) */
  buildAttempt: number;
  /** Wall-clock ms when compile started (first Building phase after user confirms). */
  compileStartedAt: number | null;
}

const FoundryContext = createContext<FoundryCtx>({
  buildProgress: null,
  foundryModal: null,
  foundryModalVisible: false,
  openBuildModal: () => {},
  minimizeBuildModal: () => {},
  restoreBuildModal: () => {},
  closeBuildModal: () => {},
  attachToActiveBuild: () => {},
  buildAttempt: 0,
  reattachedFromBackend: false,
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
  };
}

const PHASE_MAP: Record<string, string> = {
  GitClone: "clone",
  GitPull: "pull",
  Configuring: "configuring",
  WaitingForConfirm: "waiting-confirm",
  Building: "building",
  Validating: "validating",
  Complete: "complete",
  Failed: "error",
};

interface BuildProgressEvent {
  build_id: number;
  phase: string;
  provider_id: string;
  environment: string;
  log_line?: string;
  log_lines?: string[];
}

// ── Internal Reducer (the heart of the robust design) ─────────────────

type FoundryAction =
  | { type: 'OPEN'; providerId: string; environment: Env }
  | { type: 'MINIMIZE' }
  | { type: 'RESTORE' }
  | { type: 'CLOSE' }
  | { type: 'PROGRESS'; event: BuildProgressEvent }
  | { type: 'RECONCILE'; session: BuildSession | null; reason?: string }
  | { type: 'CANCELLED' };

interface FoundryInternalState {
  session: BuildSession | null;
  userWantsModalVisible: boolean;
  closed: boolean; // user explicitly closed/cancelled this session
  buildAttempt: number; // increments every time user explicitly starts a new build attempt (even for same provider)
  reattachedFromBackend: boolean;
}

function foundryReducer(state: FoundryInternalState, action: FoundryAction): FoundryInternalState {
  switch (action.type) {
    case 'OPEN': {
      // Starting a fresh build session. We create an optimistic local session immediately.
      // Real data will arrive via progress events or reconciliation.
      return {
        session: {
          id: -1, // placeholder until first real event
          providerId: action.providerId,
          environment: action.environment,
          phase: 'Configuring',
        },
        userWantsModalVisible: true,
        closed: false,
        buildAttempt: state.buildAttempt + 1, // force fresh modal state even for same provider
        reattachedFromBackend: false,
      };
    }
    case 'MINIMIZE':
      return { ...state, userWantsModalVisible: false };
    case 'RESTORE':
      return { ...state, userWantsModalVisible: true };
    case 'CLOSE':
      return { session: null, userWantsModalVisible: false, closed: true, buildAttempt: state.buildAttempt, reattachedFromBackend: false };
    case 'PROGRESS': {
      const e = action.event;
      if (!e.provider_id) return state;

      const phase = (e.phase as BuildPhase) || "Configuring";

      const newSession: BuildSession = {
        id: e.build_id ?? state.session?.id ?? -1,
        providerId: e.provider_id,
        environment: normalizeBinaryProfile(e.environment),
        phase,
        logLine: e.log_lines?.[e.log_lines.length - 1] ?? e.log_line,
      };

      // If we are closed, ignore progress for old sessions
      if (state.closed && state.session && newSession.id < (state.session.id ?? 0)) {
        return state;
      }

      return {
        ...state,
        session: newSession,
        closed: false,
        reattachedFromBackend: false,
      };
    }
    case 'RECONCILE': {
      if (!action.session) {
        // Backend says nothing is running right now.

        // Important: If our local session has already reached a terminal state (Complete/Error),
        // we should keep it. The user may still want to review the result via the dock.
        // Only clear if the local session was still "in progress".
        if (state.session && !state.closed) {
          // Use case-insensitive check because session.phase holds raw BuildPhase ("Complete")
          // while some other places use the mapped lowercase step.
          const phaseLower = state.session.phase.toLowerCase();
          const isTerminal = phaseLower === 'complete' || phaseLower === 'error' || phaseLower === 'failed';

          if (isTerminal) {
            // Keep the finished session so clicking the dock widget can still show the review screen.
            return {
              ...state,
              userWantsModalVisible: true,
            };
          }

          // We thought a build was still active, but backend says no → clear it.
          return { session: null, userWantsModalVisible: false, closed: false, buildAttempt: state.buildAttempt, reattachedFromBackend: false };
        }
        return { ...state, reattachedFromBackend: false };
      }

      const inProgress = isInProgressPhase(action.session.phase);
      const isMountRecovery = action.reason === 'mount' || action.reason === 'visibility';

      // Merge authoritative session from backend
      return {
        ...state,
        session: action.session,
        closed: false,
        reattachedFromBackend: inProgress && isMountRecovery,
        // Respect explicit minimize; only auto-show on cold mount (WAIT-CONFIRM) or attach.
        userWantsModalVisible: state.userWantsModalVisible
          || (action.reason === 'mount' && action.session.phase === 'WaitingForConfirm')
          || (inProgress && action.reason === 'attach'),
      };
    }
    case 'CANCELLED':
      return { session: null, userWantsModalVisible: false, closed: true, buildAttempt: state.buildAttempt, reattachedFromBackend: false };
    default:
      return state;
  }
}

const initialInternalState: FoundryInternalState = {
  session: null,
  userWantsModalVisible: false,
  closed: false,
  buildAttempt: 0,
  reattachedFromBackend: false,
};

const COMPILE_STEPS = new Set(["building", "validating"]);

export const FoundryProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [internal, dispatch] = useReducer(foundryReducer, initialInternalState);
  const [legacyProgress, setLegacyProgress] = useState<BuildProgressState | null>(null);
  const [compileStartedAt, setCompileStartedAt] = useState<number | null>(null);

  // Only a few refs remain — for build id sequencing and listener cleanup
  const lastBuildIdRef = useRef<number | null>(null);
  const compileBuildIdRef = useRef<number | null>(null);
  const prevBuildStepRef = useRef<string | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const hasReconciledRef = useRef(false);

  const mapPhase = useCallback((phase: string) => PHASE_MAP[phase] ?? phase.toLowerCase(), []);

  // ── Derived values (the clean public surface) ───────────────────────
  const session = internal.session;
  const foundryModal = session
    ? { providerId: session.providerId, environment: session.environment }
    : null;

  const foundryModalVisible = !!session && internal.userWantsModalVisible;

  const buildProgress: BuildProgressState | null = legacyProgress ?? (session
    ? {
        providerId: session.providerId,
        environment: session.environment,
        step: mapPhase(session.phase),
        logLine: session.logLine,
        buildId: session.id > 0 ? session.id : undefined,
      }
    : null);

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
    } else if (COMPILE_STEPS.has(step) && compileBuildIdRef.current !== buildId) {
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
        setLegacyProgress({
          providerId: status.provider_id,
          environment: status.environment,
          step: mapPhase(status.phase),
          logLine: status.log_line ?? undefined,
          buildId: status.build_id,
        });
        dispatch({ type: 'RECONCILE', session: reconciledSession, reason });
      } else {
        dispatch({ type: 'RECONCILE', session: null, reason });
        // Backend has no active build — make sure any stale "building" UI state is gone (common after minimize + finish)
        setLegacyProgress(null);
      }
    } catch (err) {
      console.error(`[Foundry] Reconciliation failed (${reason}):`, err);
    }
  }, [mapPhase]);

  // ── Public API (stable contract) ───────────────────────────────────
  const openBuildModal = useCallback((providerId: string, environment: Env) => {
    void (async () => {
      try {
        const status = await invoke<FoundryStatusPayload | null>("foundry_status");
        if (status && isInProgressPhase(status.phase)) {
          // Reattach to the running backend build — never start a duplicate.
          const reconciledSession = sessionFromStatus(status);
          if (status.build_id > 0) {
            lastBuildIdRef.current = status.build_id;
          }
          setLegacyProgress({
            providerId: status.provider_id,
            environment: status.environment,
            step: mapPhase(status.phase),
            logLine: status.log_line ?? undefined,
            buildId: status.build_id,
          });
          dispatch({ type: 'RECONCILE', session: reconciledSession, reason: 'attach' });
          dispatch({ type: 'RESTORE' });
          return;
        }
      } catch (err) {
        console.error("[Foundry] openBuildModal status check failed:", err);
      }

      // Fresh build: clear any finished session for this provider so confirm form is clean.
      const current = latestSessionRef.current;
      if (current && current.providerId === providerId) {
        dispatch({ type: 'CLOSE' });
      }

      dispatch({ type: 'OPEN', providerId, environment });
    })();
  }, [mapPhase]);

  const minimizeBuildModal = useCallback(() => {
    dispatch({ type: 'MINIMIZE' });
  }, []);

  // Ref to the latest session so we can make decisions in callbacks without stale closures
  const latestSessionRef = useRef<BuildSession | null>(null);
  latestSessionRef.current = session;

  const restoreBuildModal = useCallback(() => {
    dispatch({ type: 'RESTORE' });

    // If we already have a terminal (finished) session locally, don't blindly reconcile
    // and risk it being nuked by "backend has no active build".
    // This is the main cause of the blink+vanish when clicking the dock widget
    // after a build finished while minimized.
    const current = latestSessionRef.current;
    const isAlreadyTerminal = current && ['complete', 'error', 'Complete', 'Failed'].some(p =>
      current.phase.toLowerCase() === p.toLowerCase()
    );

    if (!isAlreadyTerminal) {
      void reconcileWithBackend('restore');
    }
  }, [reconcileWithBackend]);

  const closeBuildModal = useCallback(async () => {
    try { await invoke("foundry_cancel"); } catch { /* best effort */ }
    dispatch({ type: 'CLOSE' });
    setLegacyProgress(null);
    lastBuildIdRef.current = null;
    setCompileStartedAt(null);
    compileBuildIdRef.current = null;
    prevBuildStepRef.current = null;
  }, []);

  const attachToActiveBuild = useCallback(() => {
    void reconcileWithBackend('attach');
  }, [reconcileWithBackend]);

  // ── Event listener (progress deltas) ───────────────────────────────
  useEffect(() => {
    const unsubPromise = listen<BuildProgressEvent>("foundry-progress", (e) => {
      const payload = e.payload;
      if (!payload?.provider_id) return;

      // Build id sequencing guard (same as before, but simpler)
      if (payload.build_id != null) {
        if (lastBuildIdRef.current === null) {
          lastBuildIdRef.current = payload.build_id;
        } else if (payload.build_id < lastBuildIdRef.current) {
          return;
        } else {
          lastBuildIdRef.current = payload.build_id;
        }
      }

      dispatch({ type: 'PROGRESS', event: payload });

      // Keep shape in sync for consumers that still read buildProgress directly
      const step = mapPhase(payload.phase);
      const logLine = payload.log_lines?.[payload.log_lines.length - 1] ?? payload.log_line;
      setLegacyProgress({
        providerId: payload.provider_id,
        environment: payload.environment,
        step,
        logLine,
        buildId: payload.build_id ?? undefined,
      });

      // Terminal states: keep the session + dock widget alive so the user can click back to review the result/log.
      // We only fully clear when the user explicitly closes the modal.
      // This fixes the "click minimized widget after build finishes → it vanishes" problem.
      if (step === "complete" || step === "error") {
        lastBuildIdRef.current = null;
        // Do NOT null legacyProgress or clear the dock slot here.
        // Let the session stay in Complete/Error phase so clicking the dock widget can restore the review screen.
      }
    });

    unsubPromise.then((unsub) => { unlistenRef.current = unsub; });
    return () => { unlistenRef.current?.(); };
  }, [mapPhase]);

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
    foundryModal,
    foundryModalVisible,
    reattachedFromBackend: internal.reattachedFromBackend,
    openBuildModal,
    minimizeBuildModal,
    restoreBuildModal,
    closeBuildModal,
    attachToActiveBuild,
    buildAttempt: internal.buildAttempt,
    compileStartedAt,
  }), [
    buildProgress,
    foundryModal,
    foundryModalVisible,
    internal.reattachedFromBackend,
    openBuildModal,
    minimizeBuildModal,
    restoreBuildModal,
    closeBuildModal,
    attachToActiveBuild,
    internal.buildAttempt,
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

// Note: Deprecated aliases (useBuildDock / BuildDockProvider) have been fully removed.
// Only modern exports (FoundryProvider + useFoundry) remain in this file.
