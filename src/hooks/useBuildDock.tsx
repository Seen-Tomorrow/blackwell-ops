import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { useDock, DOCK_SLOT_BUILD } from "../context/DockContext";
import { getStepLabel } from "../lib/foundry_constants";

export interface BuildProgressState {
  providerId: string;
  environment: string;
  step: string;
  logLine?: string;
  buildId?: number;
}

export type Env = "vanguard" | "stable" | "fresh";

export interface FoundryCtx {
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

export const FoundryProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [buildProgress, setBuildProgress] = useState<BuildProgressState | null>(null);
  const [foundryModal, setFoundryModal] = useState<{ providerId: string; environment: Env } | null>(null);
  const [foundryModalVisible, setFoundryModalVisible] = useState(false);
  const { registerWidget, clearSlot } = useDock();

  const lastBuildIdRef = useRef<number | null>(null);
  const closedRef = useRef(false);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const hasRehydratedRef = useRef(false);
  const rehydratingRef = useRef(false);
  // Guards against rehydrateFromStatus (which is async and can be triggered by the
  // !buildProgress dock sync effect) from destroying a freshly opened build modal.
  // openBuildModal intentionally does setBuildProgress(null) + set modal visible;
  // at that exact moment foundry_status() will still return null (no backend build yet).
  const openingBuildRef = useRef(false);

  const mapPhase = useCallback((phase: string) => PHASE_MAP[phase] ?? phase.toLowerCase(), []);

  const updateDock = useCallback((state: BuildProgressState) => {
    registerWidget(DOCK_SLOT_BUILD, {
      title: `${state.providerId} ${state.environment}`,
      icon: "⚒",
      type: "build",
      inlineContent: (
        <span className="text-[9px] font-mono text-yellow-400 truncate max-w-[180px]" title={state.logLine || ""}>
          {getStepLabel(state.step)}...
        </span>
      ),
    });
  }, [registerWidget]);

  const rehydrateFromStatus = useCallback(async () => {
    if (openingBuildRef.current) {
      // We are in the middle of an explicit openBuildModal call (new build session).
      // A concurrent rehydrate (from the dock sync effect after setBuildProgress(null),
      // or from a visibility event, etc.) must not nuke the modal we are trying to show.
      openingBuildRef.current = false;
      rehydratingRef.current = false;
      return;
    }
    if (rehydratingRef.current) return;
    rehydratingRef.current = true;
    try {
      const status = await invoke<any>("foundry_status");
      if (!status) {
        // No active build on backend.
        // IMPORTANT: if we currently have a foundryModal set, we are intentionally
        // showing the build UI (either a fresh open or an existing one). Do not
        // destroy the user's action just because foundry_status is currently null.
        if (foundryModal) {
          rehydratingRef.current = false;
          return;
        }
        // Safe to clear stale recovery state only when no explicit modal intent exists.
        if (buildProgress) {
          setBuildProgress(null);
        }
        clearSlot(DOCK_SLOT_BUILD);
        setFoundryModal(null);
        setFoundryModalVisible(false);
        return;
      }

      const frontendStep = mapPhase(status.phase || "configuring");
      const progress: BuildProgressState = {
        providerId: status.provider_id,
        environment: status.environment,
        step: frontendStep,
        logLine: status.log_line || undefined,
        buildId: undefined,
      };

      const modalState = { providerId: status.provider_id, environment: status.environment as Env };

      // Seed local state from backend truth
      setFoundryModal(prev => {
        if (prev && prev.providerId === modalState.providerId && prev.environment === modalState.environment) return prev;
        lastBuildIdRef.current = null;
        return modalState;
      });

      setBuildProgress(progress);

      // For WaitingForConfirm (paused builds) we want the dock present and the user able to restore.
      // Default to visible on recovery so the PAUSED banner + PROCEED is reachable;
      // caller can minimize again if desired. This prevents the "dock vanished, page says building, no way back" state.
      if (frontendStep === "waiting-confirm") {
        setFoundryModalVisible(true);
      } else if (!foundryModalVisible) {
        // For other active non-paused phases, keep previous visibility preference (usually minimized is fine)
        // but ensure dock is populated.
      }

      if (frontendStep !== "complete" && frontendStep !== "error") {
        updateDock(progress);
      }
    } catch (err) {
      console.error("[Foundry] Rehydrate from status failed:", err);
    } finally {
      rehydratingRef.current = false;
    }
  }, [mapPhase, updateDock, clearSlot, buildProgress, foundryModalVisible, foundryModal]);

  const attachToActiveBuild = useCallback(() => {
    // Fire-and-forget recovery entrypoint for UI (page, dock click, etc.)
    void rehydrateFromStatus();
  }, [rehydrateFromStatus]);

  const openBuildModal = useCallback((providerId: string, environment: Env) => {
    closedRef.current = false;
    openingBuildRef.current = true; // tell any concurrent rehydrate "do not touch our new modal"
    clearSlot(DOCK_SLOT_BUILD);
    setBuildProgress(null);
    setFoundryModal(prev => {
      if (prev && prev.providerId === providerId && prev.environment === environment) return prev;
      lastBuildIdRef.current = null;
      return { providerId, environment };
    });
    setFoundryModalVisible(true);

    // Allow future recovery rehydrates once this explicit open has taken effect.
    // Use microtask so it happens after the current render/effect batch.
    queueMicrotask(() => {
      openingBuildRef.current = false;
    });
  }, [clearSlot]);

  const minimizeBuildModal = useCallback(() => {
    setFoundryModalVisible(false);
  }, []);

  const restoreBuildModal = useCallback(() => {
    setFoundryModalVisible(true);
    // Ensure we reconcile with backend in case local state was lost (e.g. after minimize + visibility cycle)
    void rehydrateFromStatus();
  }, [rehydrateFromStatus]);

  const closeBuildModal = useCallback(async () => {
    closedRef.current = true;
    openingBuildRef.current = false; // defensive
    try { await invoke("foundry_cancel"); } catch { /* not running */ }
    setFoundryModal(null);
    setFoundryModalVisible(false);
    setBuildProgress(null);
    lastBuildIdRef.current = null;
    clearSlot(DOCK_SLOT_BUILD);
  }, [clearSlot]);

  useEffect(() => {
    listen<BuildProgressEvent>("foundry-progress", (e) => {
      if (closedRef.current) return;

      const data = e.payload;

      if (data.build_id !== undefined && data.build_id != null) {
        if (lastBuildIdRef.current === null) {
          lastBuildIdRef.current = data.build_id;
          openingBuildRef.current = false; // real events flowing — suppress window no longer needed
        } else if (data.build_id < lastBuildIdRef.current) return;
        else if (data.build_id > lastBuildIdRef.current) {
          lastBuildIdRef.current = data.build_id;
          openingBuildRef.current = false;
        }
      }

      const frontendStep = mapPhase(data.phase);
      let logLine = data.log_line;
      if (data.log_lines && data.log_lines.length > 0) {
        logLine = data.log_lines[data.log_lines.length - 1];
      }

      const progress: BuildProgressState = {
        providerId: data.provider_id,
        environment: data.environment,
        step: frontendStep,
        logLine,
        buildId: data.build_id ?? undefined,
      };

      setBuildProgress(progress);

      if (frontendStep === "complete" || frontendStep === "error") {
        lastBuildIdRef.current = null;
      } else {
        updateDock(progress);
      }
    }).then(unlisten => { unlistenRef.current = unlisten; });

    return () => { unlistenRef.current?.(); };
  }, [mapPhase, updateDock]);

  useEffect(() => {
    if (buildProgress && buildProgress.step !== "complete" && buildProgress.step !== "error") {
      updateDock(buildProgress);
    } else if (!buildProgress) {
      // Recovery path only. Never trigger rehydrate (which may clear state) while we
      // have an explicit foundryModal — that means the user or openBuildModal wants
      // the build confirmation/progress UI to be visible right now.
      // The openingBuildRef + the `if (foundryModal)` guard inside rehydrate provide
      // additional protection against the async !status clear path.
      if (!foundryModal) {
        void rehydrateFromStatus();
      }
    }
  }, [buildProgress, updateDock, clearSlot, rehydrateFromStatus, foundryModal]);

  // Rehydrate from backend status on mount and on window visibility restore.
  // This is the key fix for "dock vanished while WaitingForConfirm" after minimize + OS window cycles.
  useEffect(() => {
    // Initial mount hydration (guarded like the refresh guard in FoundryPage)
    if (!hasRehydratedRef.current) {
      hasRehydratedRef.current = true;
      void rehydrateFromStatus();
    }

    const handleVisibility = () => {
      if (document.visibilityState === "visible") {
        void rehydrateFromStatus();
      }
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const ctxValue = useMemo(() => ({
    buildProgress,
    foundryModal,
    foundryModalVisible,
    openBuildModal,
    minimizeBuildModal,
    restoreBuildModal,
    closeBuildModal,
    attachToActiveBuild,
  }), [buildProgress, foundryModal, foundryModalVisible, openBuildModal, minimizeBuildModal, restoreBuildModal, closeBuildModal, attachToActiveBuild]);

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
