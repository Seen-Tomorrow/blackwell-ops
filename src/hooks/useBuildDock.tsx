import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef, useReducer } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useDock, DOCK_SLOT_BUILD } from "../context/DockContext";
import { getStepLabel, type BuildPhase } from "../lib/foundry_constants";

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

export type Env = "vanguard" | "stable" | "fresh";

// Internal clean session model (preferred)
interface BuildSession {
  id: number;
  providerId: string;
  environment: Env;
  phase: BuildPhase;
  logLine?: string;
}

export interface FoundryCtx {
  // Legacy shape kept for backward compatibility with FoundryPage + existing consumers
  buildProgress: BuildProgressState | null;
  foundryModal: { providerId: string; environment: Env } | null;
  foundryModalVisible: boolean;

  openBuildModal: (providerId: string, environment: Env) => void;
  minimizeBuildModal: () => void;
  restoreBuildModal: () => void;
  closeBuildModal: () => void;
  attachToActiveBuild: () => void;
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
});

const PHASE_MAP: Record<string, string> = {
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
  | { type: 'RECONCILE'; session: BuildSession | null }
  | { type: 'CANCELLED' };

interface FoundryInternalState {
  session: BuildSession | null;
  userWantsModalVisible: boolean;
  closed: boolean; // user explicitly closed/cancelled this session
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
      };
    }
    case 'MINIMIZE':
      return { ...state, userWantsModalVisible: false };
    case 'RESTORE':
      return { ...state, userWantsModalVisible: true };
    case 'CLOSE':
      return { session: null, userWantsModalVisible: false, closed: true };
    case 'PROGRESS': {
      const e = action.event;
      if (!e.provider_id) return state;

      const phase = (e.phase as BuildPhase) || "Configuring";

      const newSession: BuildSession = {
        id: e.build_id ?? state.session?.id ?? -1,
        providerId: e.provider_id,
        environment: e.environment as Env,
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
      };
    }
    case 'RECONCILE': {
      if (!action.session) {
        // Backend says nothing is running
        if (state.session && !state.closed) {
          // We had something locally — backend disagrees. Clear unless user is in middle of starting one.
          return { session: null, userWantsModalVisible: false, closed: false };
        }
        return state;
      }

      // Merge authoritative session from backend
      return {
        ...state,
        session: action.session,
        closed: false,
        // If we were minimized and backend is in a paused state, we keep user's previous visibility preference.
        // For WaitingForConfirm we lean towards making it visible on recovery (user can minimize again).
        userWantsModalVisible: state.userWantsModalVisible || action.session.phase === 'WaitingForConfirm',
      };
    }
    case 'CANCELLED':
      return { session: null, userWantsModalVisible: false, closed: true };
    default:
      return state;
  }
}

const initialInternalState: FoundryInternalState = {
  session: null,
  userWantsModalVisible: false,
  closed: false,
};

export const FoundryProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [internal, dispatch] = useReducer(foundryReducer, initialInternalState);
  const [legacyProgress, setLegacyProgress] = useState<BuildProgressState | null>(null);

  const { registerWidget, clearSlot } = useDock();

  // Only a few refs remain — for build id sequencing and listener cleanup
  const lastBuildIdRef = useRef<number | null>(null);
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

  // ── Single source of dock registration ─────────────────────────────
  const updateDock = useCallback((progress: BuildProgressState) => {
    registerWidget(DOCK_SLOT_BUILD, {
      title: `${progress.providerId} ${progress.environment}`,
      icon: "⚒",
      type: "build",
      inlineContent: (
        <span className="text-[9px] font-mono text-yellow-400 truncate max-w-[180px]" title={progress.logLine || ""}>
          {getStepLabel(progress.step)}...
        </span>
      ),
    });
  }, [registerWidget]);

  // One clean reconciliation function
  const reconcileWithBackend = useCallback(async (reason: string) => {
    try {
      const status = await invoke<any>("foundry_status");
      if (status) {
        const reconciledSession: BuildSession = {
          id: status.build_id ?? -1,
          providerId: status.provider_id,
          environment: status.environment as Env,
          phase: (status.phase as BuildPhase) || "Configuring",
          logLine: status.log_line,
        };
        dispatch({ type: 'RECONCILE', session: reconciledSession });
      } else {
        dispatch({ type: 'RECONCILE', session: null });
      }
    } catch (err) {
      console.error(`[Foundry] Reconciliation failed (${reason}):`, err);
    }
  }, []);

  // ── Public API (stable contract) ───────────────────────────────────
  const openBuildModal = useCallback((providerId: string, environment: Env) => {
    dispatch({ type: 'OPEN', providerId, environment });
    // Optimistically clear any stale dock widget
    clearSlot(DOCK_SLOT_BUILD);
  }, [clearSlot]);

  const minimizeBuildModal = useCallback(() => {
    dispatch({ type: 'MINIMIZE' });
  }, []);

  const restoreBuildModal = useCallback(() => {
    dispatch({ type: 'RESTORE' });
    // Reconcile on explicit restore so user sees latest truth
    void reconcileWithBackend('restore');
  }, [reconcileWithBackend]);

  const closeBuildModal = useCallback(async () => {
    try { await invoke("foundry_cancel"); } catch { /* best effort */ }
    dispatch({ type: 'CLOSE' });
    clearSlot(DOCK_SLOT_BUILD);
    setLegacyProgress(null);
    lastBuildIdRef.current = null;
  }, [clearSlot]);

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

      // Keep legacy shape in sync for consumers that still read buildProgress directly
      const step = mapPhase(payload.phase);
      const logLine = payload.log_lines?.[payload.log_lines.length - 1] ?? payload.log_line;
      setLegacyProgress({
        providerId: payload.provider_id,
        environment: payload.environment,
        step,
        logLine,
        buildId: payload.build_id ?? undefined,
      });

      // Terminal states clean up
      if (step === "complete" || step === "error") {
        lastBuildIdRef.current = null;
      }
    });

    unsubPromise.then((unsub) => { unlistenRef.current = unsub; });
    return () => { unlistenRef.current?.(); };
  }, [mapPhase]);

  // ── Single effect that keeps the dock in sync from derived state ───
  useEffect(() => {
    if (buildProgress && !['complete', 'error'].includes(buildProgress.step)) {
      updateDock(buildProgress);
    } else if (!session) {
      clearSlot(DOCK_SLOT_BUILD);
    }
  }, [buildProgress, session, updateDock, clearSlot]);

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
    openBuildModal,
    minimizeBuildModal,
    restoreBuildModal,
    closeBuildModal,
    attachToActiveBuild,
  }), [
    buildProgress,
    foundryModal,
    foundryModalVisible,
    openBuildModal,
    minimizeBuildModal,
    restoreBuildModal,
    closeBuildModal,
    attachToActiveBuild,
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

/** @deprecated Use {@link useFoundry} instead. */
export function useBuildDock(): FoundryCtx {
  return useFoundry();
}

/** @deprecated Use {@link FoundryProvider} instead. */
export const BuildDockProvider = FoundryProvider;
