import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadStatus } from "../lib/types";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  computePathsDone,
  computeSetupPhase,
  computeRuntimeBusy,
  computeRuntimeDone,
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
import { DEFAULT_BINARY_PROFILE } from "../lib/foundry_constants";

export interface SetupGuideState {
  active: boolean;
  /** Both probes (`is_setup_completed`, `model_library_configured`) have answered.
   *  Until then `active` is false for a *pending* reason, not a finished setup. */
  resolved: boolean;
  phase: SetupPhase;
  pathsDone: boolean;
  runtimeReady: boolean;
  /** False until the first runtime-pack status fetch completes. */
  runtimeChecked: boolean;
  /** Download or 7z extract in flight. */
  runtimeBusy: boolean;
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
  const [runtimeChecked, setRuntimeChecked] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [pathsConfigured, setPathsConfigured] = useState(false);
  const [pathsReady, setPathsReady] = useState(false);
  const runtimeTasks = useDownloadTasks("toolchain");

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

  const refreshRuntime = useCallback(async () => {
    try {
      const info = await invoke<{
        runtime_ready: boolean;
        runtime_versions?: { id: string; ready: boolean }[];
      }>("foundry_get_toolchain_install_info");
      // Onboarding gates on the SEEDED profile's runtime only. `runtime_ready` is the
      // "every manifest profile" aggregate and would force a second 424 MB CUDA 12.8 download
      // on an EDGE user (docs/ENGINE-PACKS.md).
      const seeded = info.runtime_versions?.find((v) => v.id === DEFAULT_BINARY_PROFILE);
      const ready = seeded ? seeded.ready : info.runtime_ready;
      setRuntimeReady(ready);
      // Drop legacy skip flag if present (toolchain is no longer skippable).
      if (ready) clearToolchainOnboardingSkipped();
    } catch {
      setRuntimeReady(false);
    } finally {
      setRuntimeChecked(true);
    }
  }, []);

  const refreshPathsAndRuntime = useCallback(() => {
    void refreshPaths();
    void refreshRuntime();
  }, [refreshPaths, refreshRuntime]);

  useEffect(() => {
    // Legacy localStorage: toolchain skip is no longer valid.
    clearToolchainOnboardingSkipped();
    refreshPathsAndRuntime();
  }, [refreshPathsAndRuntime]);

  useEffect(() => {
    window.addEventListener(EVENTS.modelPathsChanged, refreshPathsAndRuntime);
    window.addEventListener(EVENTS.downloadCompleted, refreshPathsAndRuntime);
    return () => {
      window.removeEventListener(EVENTS.modelPathsChanged, refreshPathsAndRuntime);
      window.removeEventListener(EVENTS.downloadCompleted, refreshPathsAndRuntime);
    };
  }, [refreshPathsAndRuntime]);

  useTauriListen("download-event", refreshRuntime, [refreshRuntime]);

  const prevRuntimeTaskStatusRef = useRef<Record<string, DownloadStatus>>({});
  useEffect(() => {
    for (const t of runtimeTasks) {
      const prev = prevRuntimeTaskStatusRef.current[t.id];
      if (prev && prev !== "completed" && t.status === "completed") {
        void refreshRuntime();
        dispatchAppEvent(EVENTS.downloadCompleted);
      }
      prevRuntimeTaskStatusRef.current[t.id] = t.status;
    }
  }, [runtimeTasks, refreshRuntime]);

  const scannedCount = useMemo(
    () => models.filter((m) => m.metadata).length,
    [models],
  );
  const modelsCount = models.length;

  const pathsDone = computePathsDone({ modelsDeferred, modelsCount });
  const runtimeDone = computeRuntimeDone(runtimeReady);

  const phase = useMemo(
    () => computeSetupPhase({ pathsDone, runtimeDone }),
    [pathsDone, runtimeDone],
  );

  const runtimeBusy = useMemo(
    () => computeRuntimeBusy(runtimeTasks, runtimeReady),
    [runtimeTasks, runtimeReady],
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
    void refreshRuntime();
  }, [active, refreshRuntime]);

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
    runtimeChecked,
    runtimeBusy,
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
