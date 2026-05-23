import { createContext, useContext, useState, useCallback, useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { useDock } from "./DockContext";

export interface BuildProgressState {
  providerId: string;
  environment: string;
  step: string;
  logLine?: string;
  buildId?: number;
}

export type Env = "vanguard" | "stable" | "fresh";

export interface StatusBarCtx {
  totalParams: number;
  hiddenCount: number;
  onShowAll?: () => void;
  flashMessage: string | null;
  triggerFlash: (message: string) => void;
  buildProgress: BuildProgressState | null;
  foundryModal: { providerId: string; environment: Env } | null;
  foundryModalVisible: boolean; // true = overlay visible, false = minimized to dock
  openBuildModal: (providerId: string, environment: Env) => void;
  minimizeBuildModal: () => void; // Hide overlay but keep modal mounted (preserves logs/phase)
  closeBuildModal: () => void;    // Clear everything (Complete/Failed or cancel during confirm)
}

const StatusContext = createContext<StatusBarCtx>({
  totalParams: 0,
  hiddenCount: 0,
  flashMessage: null,
  triggerFlash: () => {},
  buildProgress: null,
  foundryModal: null,
  foundryModalVisible: false,
  openBuildModal: () => {},
  minimizeBuildModal: () => {},
  closeBuildModal: () => {},
});

export const StatusProvider: React.FC<{ value: any; children?: React.ReactNode }> = ({ value, children }) => {
  const [flashMessage, setFlashMessage] = useState<string | null>(null);
  const [buildProgress, setBuildProgress] = useState<BuildProgressState | null>(null);
  const [foundryModal, setFoundryModal] = useState<{ providerId: string; environment: Env } | null>(null);
  const [foundryModalVisible, setFoundryModalVisible] = useState(false); // Separate from foundryModal — controls CSS visibility
  const { registerWidget, clearSlot } = useDock();

  const DOCK_SLOT_BUILD = 0;

  const openBuildModal = useCallback((providerId: string, environment: Env) => {
    // Reset stale state from previous build before opening new one
    setBuildProgress(null);
    clearSlot(DOCK_SLOT_BUILD);
    window.dispatchEvent(new Event("blackops-foundry-reset"));
    setFoundryModal({ providerId, environment });
    setFoundryModalVisible(true);
  }, [clearSlot, DOCK_SLOT_BUILD]);

  // Minimize: hide overlay but keep foundryModal alive (preserves logs/phase in mounted component)
  const minimizeBuildModal = useCallback(() => {
    setFoundryModalVisible(false);
  }, []);

  // Close: clear everything (used on Complete/Failed or cancel during confirm phase)
  const closeBuildModal = useCallback(() => {
    setFoundryModal(null);
    setFoundryModalVisible(false);
    setBuildProgress(null);
    clearSlot(DOCK_SLOT_BUILD);
    // Clear FoundryModal internal state (logLines, DOM nodes) to free memory
    window.dispatchEvent(new Event("blackops-foundry-reset"));
  }, [clearSlot, DOCK_SLOT_BUILD]);

  // Auto-clear flash after 4 seconds
  useEffect(() => {
    if (!flashMessage) return;
    const timer = setTimeout(() => setFlashMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [flashMessage]);

  // Listen for launch events to show in status bar
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as { alias: string; port: number };
      if (detail?.alias && detail.port) {
        setFlashMessage(`${detail.alias} ignited @ :${detail.port}`);
      }
    };
    window.addEventListener("blackops-launch-success", handler);
    return () => window.removeEventListener("blackops-launch-success", handler);
  }, []);

  // Listen for foundry build progress globally — survives page navigation
  useEffect(() => {
    (async () => {
      let lastBuildId: number | null = null;
      const unsub = await listen("foundry-build-progress", (e: any) => {
        const data = e.payload as { build_id?: number; step: string; provider_id: string; environment: string; log_line?: string };

        // Track build_id — ignore events from stale builds
        if (data.build_id !== undefined) {
          if (lastBuildId === null) lastBuildId = data.build_id;
          else if (data.build_id < lastBuildId) return;
          else if (data.build_id > lastBuildId) lastBuildId = data.build_id;
        }

        const stepLabel = getStepShort(data.step);

        if (data.step === "Complete" || data.step === "Failed") {
          console.log(`[StatusBar] → Build ${data.step} for ${data.provider_id}/${data.environment}`);
          // Keep buildProgress and dock slot showing result until user manually closes
          setBuildProgress({
            providerId: data.provider_id,
            environment: data.environment,
            step: data.step,
            logLine: data.log_line,
            buildId: data.build_id,
          });
          if (data.step === "Complete") {
            window.dispatchEvent(new CustomEvent("blackops-foundry-complete", { detail: data.provider_id }));
          }
          lastBuildId = null;
        } else {
          setBuildProgress({
            providerId: data.provider_id,
            environment: data.environment,
            step: data.step,
            logLine: data.log_line,
            buildId: data.build_id,
          });

          // Register/update dock slot with inline progress indicator
          registerWidget(DOCK_SLOT_BUILD, {
            title: `${data.provider_id} ${data.environment}`,
            icon: "⚒",
            inlineContent: (
              <span className="text-[9px] font-mono text-yellow-400 truncate max-w-[180px]" title={data.log_line || ""}>
                {stepLabel}...
              </span>
            ),
          });
        }
      });
      return unsub;
    })();
  }, [registerWidget]);

  // Keep dock slot registered as long as buildProgress is active (survives navigation + idle phases)
  useEffect(() => {
    if (buildProgress) {
      const stepLabel = getStepShort(buildProgress.step);
      registerWidget(DOCK_SLOT_BUILD, {
        title: `${buildProgress.providerId} ${buildProgress.environment}`,
        icon: "⚒",
        inlineContent: (
          <span className="text-[9px] font-mono text-yellow-400 truncate max-w-[180px]" title={buildProgress.logLine || ""}>
            {stepLabel}...
          </span>
        ),
      });
    } else {
      clearSlot(DOCK_SLOT_BUILD);
    }
  }, [buildProgress, registerWidget, clearSlot, DOCK_SLOT_BUILD]);

  const triggerFlash = useCallback((message: string) => {
    setFlashMessage(message);
  }, []);

  // Merge flash state into provided value
  const mergedValue = { ...value, flashMessage, triggerFlash, buildProgress, foundryModal, foundryModalVisible, openBuildModal, minimizeBuildModal, closeBuildModal };

  return <StatusContext.Provider value={mergedValue}>{children}</StatusContext.Provider>;
};

function getStepShort(step: string): string {
  switch (step) {
    case "Initializing": return "INIT";
    case "GitClone": return "CLONE";
    case "GitPull": return "PULL";
    case "PrCherryPick": return "PR-MERGE";
    case "CMakeConfigure": return "CONFIGURE";
    case "WaitingForConfirm": return "WAIT-CONFIRM";
    case "Building": return "BUILD";
    case "Validating": return "VALIDATE";
    default: return step;
  }
}

export function useStatus() {
  return useContext(StatusContext);
}
