import { createContext, useContext, useState, useCallback, useEffect, useMemo, useRef } from "react";
import { listen } from "@tauri-apps/api/event";
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

export interface BuildDockCtx {
  buildProgress: BuildProgressState | null;
  foundryModal: { providerId: string; environment: Env } | null;
  foundryModalVisible: boolean;
  openBuildModal: (providerId: string, environment: Env) => void;
  minimizeBuildModal: () => void;
  closeBuildModal: () => void;
}

const BuildDockContext = createContext<BuildDockCtx>({
  buildProgress: null,
  foundryModal: null,
  foundryModalVisible: false,
  openBuildModal: () => {},
  minimizeBuildModal: () => {},
  closeBuildModal: () => {},
});

export const BuildDockProvider: React.FC<{ children?: React.ReactNode }> = ({ children }) => {
  const [buildProgress, setBuildProgress] = useState<BuildProgressState | null>(null);
  const [foundryModal, setFoundryModal] = useState<{ providerId: string; environment: Env } | null>(null);
  const [foundryModalVisible, setFoundryModalVisible] = useState(false);
  const { registerWidget, clearSlot } = useDock();

  // ── Build modal lifecycle ───────────────────────────────────────────
  const lastBuildIdRef = useRef<number | null>(null);
  const closedRef = useRef(false);

  const openBuildModal = useCallback((providerId: string, environment: Env) => {
    closedRef.current = false;
    // Reset lastBuildId when opening a different provider/env to accept new events
    setFoundryModal(prev => {
      if (prev && prev.providerId === providerId && prev.environment === environment) return prev;
      lastBuildIdRef.current = null;
      setBuildProgress(null);
      clearSlot(DOCK_SLOT_BUILD);
      return { providerId, environment };
    });
    setFoundryModalVisible(true);
  }, [clearSlot]);

  const minimizeBuildModal = useCallback(() => {
    setFoundryModalVisible(false);
  }, []);

  const closeBuildModal = useCallback(async () => {
    closedRef.current = true;
    // Cancel any active build on the backend
    try { await invoke("foundry_cancel"); } catch (e) { /* ignore — may not be running */ }
    setFoundryModal(null);
    setFoundryModalVisible(false);
    setBuildProgress(null);
    lastBuildIdRef.current = null;
    clearSlot(DOCK_SLOT_BUILD);
    window.dispatchEvent(new Event("blackops-foundry-reset"));
  }, [clearSlot]);

  // ── Listen for build progress (survives page navigation) ────────────
  useEffect(() => {
    const unsubPromise = listen("foundry-build-progress", (e: any) => {
      if (closedRef.current) return; // Ignore events after close

      const data = e.payload as { build_id?: number; step: string; provider_id: string; environment: string; log_line?: string };

      if (data.build_id !== undefined) {
        if (lastBuildIdRef.current === null) lastBuildIdRef.current = data.build_id;
        else if (data.build_id < lastBuildIdRef.current) return;
        else if (data.build_id > lastBuildIdRef.current) lastBuildIdRef.current = data.build_id;
      }

      const stepLabel = getStepLabel(data.step);
      const progress: BuildProgressState = {
        providerId: data.provider_id,
        environment: data.environment,
        step: data.step,
        logLine: data.log_line,
        buildId: data.build_id,
      };

      if (data.step === "Complete" || data.step === "Failed") {
        setBuildProgress(progress);
        if (data.step === "Complete") {
          window.dispatchEvent(new CustomEvent("blackops-foundry-complete", { detail: data.provider_id }));
        }
        lastBuildIdRef.current = null;
      } else {
        setBuildProgress(progress);

        // Single registration — no double-registration
        registerWidget(DOCK_SLOT_BUILD, {
          title: `${data.provider_id} ${data.environment}`,
          icon: "⚒",
          type: 'build',
          inlineContent: (
            <span className="text-[9px] font-mono text-yellow-400 truncate max-w-[180px]" title={data.log_line || ""}>
              {stepLabel}...
            </span>
          ),
        });
      }
    });

    return () => { unsubPromise.then(u => u()); };
  }, [registerWidget]);

  // ── Keep dock slot registered as long as buildProgress is active ───
  useEffect(() => {
    if (buildProgress) {
      const stepLabel = getStepLabel(buildProgress.step);
      registerWidget(DOCK_SLOT_BUILD, {
        title: `${buildProgress.providerId} ${buildProgress.environment}`,
        icon: "⚒",
        type: 'build',
        inlineContent: (
          <span className="text-[9px] font-mono text-yellow-400 truncate max-w-[180px]" title={buildProgress.logLine || ""}>
            {stepLabel}...
          </span>
        ),
      });
    } else {
      clearSlot(DOCK_SLOT_BUILD);
    }
  }, [buildProgress, registerWidget, clearSlot]);

  const ctxValue = useMemo(() => ({
    buildProgress,
    foundryModal,
    foundryModalVisible,
    openBuildModal,
    minimizeBuildModal,
    closeBuildModal,
  }), [buildProgress, foundryModal, foundryModalVisible, openBuildModal, minimizeBuildModal, closeBuildModal]);

  return (
    <BuildDockContext.Provider value={ctxValue}>
      {children}
    </BuildDockContext.Provider>
  );
};

export function useBuildDock(): BuildDockCtx {
  return useContext(BuildDockContext);
}