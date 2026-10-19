import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadStatus } from "../lib/types";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  computePathsDone,
  computeSetupPhase,
  computeToolchainBusy,
  computeToolchainDone,
  type SetupPhase,
} from "../lib/setupGuide";
import {
  clearSetupModelsDeferred,
  clearToolchainOnboardingSkipped,
  isSetupModelsDeferred,
  isSetupWelcomeSeen,
  saveSetupGuideDismissed,
  saveSetupModelsDeferred,
  saveSetupWelcomeSeen,
  isSetupGuideDismissed,
} from "../lib/storage";
import { useDownloadTasks } from "./useDownloadTasks";
import { isSetupGuidePreviewMode, useSetupGuideActivation } from "./useSetupGuideActivation";
import { useTauriListen } from "./useTauriListen";
import { errorMessage } from "../lib/blackwellError";

export interface SetupGuideState {
  active: boolean;
  /** Both probes (`is_setup_completed`, `model_library_configured`) have answered.
   *  Until then `active` is false for a *pending* reason, not a finished setup. */
  resolved: boolean;
  phase: SetupPhase;
  pathsDone: boolean;
  runtimeReady: boolean;
  /** False until first toolchain status fetch completes. */
  toolchainChecked: boolean;
  /** Download or 7z extract in flight. */
  toolchainBusy: boolean;
  modelsDeferred: boolean;
  /** A configured library path holds GGUF files on disk — the catalog can still
   *  be empty when none of them is usable (draft-only, partial shards). */
  libraryLinked: boolean;
  /** FINISH failed to persist `setup_completed` — the wizard stays open, say why. */
  dismissError: string | null;
  showWelcome: boolean;
  welcomeDone: boolean;
  completeWelcome: () => void;
  deferModels: () => void;
  dismiss: () => void;
  modelsCount: number;
  scannedCount: number;
  catalogLoaded: boolean;
}

interface UseSetupGuideOptions {
  models: { metadata?: unknown }[];
  /** True after the first `list_models` fetch completes (avoids paths-step flash on replay). */
  catalogLoaded?: boolean;
}

/**
 * First-run wizard state.
 *
 * The wizard now ends at **library + runtime**. Metadata scanning and the VRAM
 * fit scan are background passes (`useLibrarySchedule`) reported in the page
 * header — a first-run user should never wait on minutes of GPU fitting to reach
 * the cockpit. The NVIDIA driver result is shown on the finish step as a warning,
 * not as a gate.
 */
export function useSetupGuide({ models, catalogLoaded = false }: UseSetupGuideOptions) {
  const preview = isSetupGuidePreviewMode();
  const [dismissed, setDismissed] = useState(() => isSetupGuideDismissed());
  const [welcomeDone, setWelcomeDone] = useState(() => isSetupWelcomeSeen());
  const [modelsDeferred, setModelsDeferred] = useState(() => isSetupModelsDeferred());
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [toolchainChecked, setToolchainChecked] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [pathsConfigured, setPathsConfigured] = useState(false);
  const [pathsReady, setPathsReady] = useState(false);
  const toolchainTasks = useDownloadTasks("toolchain");

  const refreshPaths = useCallback(async () => {
    try {
      const configured = await invoke<boolean>("model_library_configured");
      setPathsConfigured(configured);
    } catch {
      setPathsConfigured(false);
    } finally {
      setPathsReady(true);
    }
  }, []);

  const refreshToolchain = useCallback(async () => {
    try {
      const info = await invoke<{ runtime_ready: boolean }>("foundry_get_toolchain_install_info");
      setRuntimeReady(info.runtime_ready);
      // Drop legacy skip flag if present (toolchain is no longer skippable).
      if (info.runtime_ready) clearToolchainOnboardingSkipped();
    } catch {
      setRuntimeReady(false);
    } finally {
      setToolchainChecked(true);
    }
  }, []);

  const refreshPathsAndToolchain = useCallback(() => {
    void refreshPaths();
    void refreshToolchain();
  }, [refreshPaths, refreshToolchain]);

  useEffect(() => {
    // Legacy localStorage: toolchain skip is no longer valid.
    clearToolchainOnboardingSkipped();
    refreshPathsAndToolchain();
  }, [refreshPathsAndToolchain]);

  useEffect(() => {
    window.addEventListener(EVENTS.modelPathsChanged, refreshPathsAndToolchain);
    window.addEventListener(EVENTS.downloadCompleted, refreshPathsAndToolchain);
    return () => {
      window.removeEventListener(EVENTS.modelPathsChanged, refreshPathsAndToolchain);
      window.removeEventListener(EVENTS.downloadCompleted, refreshPathsAndToolchain);
    };
  }, [refreshPathsAndToolchain]);

  useTauriListen("download-event", refreshToolchain, [refreshToolchain]);

  const prevToolchainTaskStatusRef = useRef<Record<string, DownloadStatus>>({});
  useEffect(() => {
    for (const t of toolchainTasks) {
      const prev = prevToolchainTaskStatusRef.current[t.id];
      if (prev && prev !== "completed" && t.status === "completed") {
        void refreshToolchain();
        dispatchAppEvent(EVENTS.downloadCompleted);
      }
      prevToolchainTaskStatusRef.current[t.id] = t.status;
    }
  }, [toolchainTasks, refreshToolchain]);

  const scannedCount = useMemo(
    () => models.filter((m) => m.metadata).length,
    [models],
  );
  const modelsCount = models.length;

  const pathsDone = computePathsDone({ modelsDeferred, modelsCount });
  const toolchainDone = computeToolchainDone(runtimeReady);

  const phase = useMemo(
    () => computeSetupPhase({ pathsDone, toolchainDone }),
    [pathsDone, toolchainDone],
  );

  const toolchainBusy = useMemo(
    () => computeToolchainBusy(toolchainTasks, runtimeReady),
    [toolchainTasks, runtimeReady],
  );

  const { active, diskSetupCompleted, setDiskSetupCompleted, resolved } =
    useSetupGuideActivation({
    preview,
    pathsReady,
    pathsConfigured,
    modelsCount,
    scannedCount,
    modelsDeferred,
    dismissed,
    welcomeDone,
    setDismissed,
    setWelcomeDone,
    setModelsDeferred,
  });

  const showWelcome = active && !welcomeDone;

  useEffect(() => {
    if (!active) return;
    void refreshToolchain();
  }, [active, refreshToolchain]);

  useEffect(() => {
    if (!modelsDeferred || modelsCount === 0) return;
    setModelsDeferred(false);
    clearSetupModelsDeferred();
  }, [modelsDeferred, modelsCount]);

  const completeWelcome = useCallback(() => {
    if (!preview) saveSetupWelcomeSeen();
    setWelcomeDone(true);
  }, [preview]);

  const deferModels = useCallback(() => {
    if (!preview) saveSetupModelsDeferred();
    setModelsDeferred(true);
  }, [preview]);

  const dismiss = useCallback(() => {
    // Hard gate: never complete setup without portable CUDA runtime.
    if (!runtimeReady) return;
    if (!preview) {
      setDismissError(null);
      saveSetupGuideDismissed();
      clearToolchainOnboardingSkipped();
      // `active` is driven by the disk flag, so a rejected write must not look
      // like a dead button — surface it and let the retry stay available.
      void invoke("mark_setup_completed")
        .then(() => setDiskSetupCompleted(true))
        .catch((err) => {
          setDismissError(
            errorMessage(err) || "Could not save setup completion to disk — try again.",
          );
        });
    }
    setDismissed(true);
  }, [preview, setDiskSetupCompleted, runtimeReady]);

  useEffect(() => {
    if (active) {
      document.body.dataset.onboardingPhase = phase;
    } else {
      delete document.body.dataset.onboardingPhase;
    }
    dispatchAppEvent(EVENTS.setupGuideChanged, { active, phase });
    return () => {
      delete document.body.dataset.onboardingPhase;
    };
  }, [active, phase]);

  return {
    active,
    resolved,
    phase,
    pathsDone,
    runtimeReady,
    toolchainChecked,
    toolchainBusy,
    modelsDeferred,
    libraryLinked: pathsConfigured,
    dismissError,
    showWelcome,
    welcomeDone,
    completeWelcome,
    deferModels,
    dismiss,
    modelsCount,
    scannedCount,
    catalogLoaded,
  };
}
