import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadStatus } from "../lib/types";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  computeMetaDone,
  computePathsDone,
  computeSetupPhase,
  computeToolchainBusy,
  computeToolchainDone,
  type MetaScanSummary,
  type SetupPhase,
} from "../lib/setupGuide";
import {
  clearToolchainOnboardingSkipped,
  clearSetupModelsDeferred,
  isSetupModelsDeferred,
  isSetupWelcomeSeen,
  isToolchainOnboardingSkipped,
  loadSetupMetaScanSummary,
  saveSetupGuideDismissed,
  saveSetupMetaScanSummary,
  saveSetupModelsDeferred,
  saveSetupWelcomeSeen,
  saveToolchainOnboardingSkipped,
  isSetupGuideDismissed,
} from "../lib/storage";
import { useDownloadTasks } from "./useDownloadTasks";
import { isSetupGuidePreviewMode, useSetupGuideActivation } from "./useSetupGuideActivation";
import { useTauriListen } from "./useTauriListen";

export type { SetupPhase } from "../lib/setupGuide";

export interface SetupGuideState {
  active: boolean;
  phase: SetupPhase;
  pathsDone: boolean;
  toolchainSkipped: boolean;
  runtimeReady: boolean;
  /** False until first toolchain status fetch completes — avoids DOWNLOAD LATER flash on replay. */
  toolchainChecked: boolean;
  /** Download or 7z extract in flight — hide skip until idle. */
  toolchainBusy: boolean;
  modelsDeferred: boolean;
  metaDone: boolean;
  /** Models that failed GGUF metadata scan in the last completed batch. */
  metaScanFailed: number;
  showWelcome: boolean;
  welcomeDone: boolean;
  completeWelcome: () => void;
  deferModels: () => void;
  skipToolchain: () => void;
  skipMetaScan: () => void;
  dismiss: () => void;
  modelsCount: number;
  scannedCount: number;
  catalogLoaded: boolean;
}

interface BatchScanSnapshot {
  active: boolean;
  scanned: number;
  failed: number;
  total: number;
}

interface UseSetupGuideOptions {
  models: { metadata?: unknown }[];
  /** True after the first `list_models` fetch completes (avoids paths-step flash on replay). */
  catalogLoaded?: boolean;
  batchScanState?: BatchScanSnapshot;
}

export function useSetupGuide({ models, catalogLoaded = false, batchScanState }: UseSetupGuideOptions) {
  const preview = isSetupGuidePreviewMode();
  const [dismissed, setDismissed] = useState(() => isSetupGuideDismissed());
  const [welcomeDone, setWelcomeDone] = useState(() => isSetupWelcomeSeen());
  const [modelsDeferred, setModelsDeferred] = useState(() => isSetupModelsDeferred());
  const [toolchainSkipped, setToolchainSkipped] = useState(() => isToolchainOnboardingSkipped());
  const [metaScanSkipped, setMetaScanSkipped] = useState(false);
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [toolchainChecked, setToolchainChecked] = useState(false);
  const [pathsConfigured, setPathsConfigured] = useState(false);
  const [pathsReady, setPathsReady] = useState(false);
  const [metaScanSummary, setMetaScanSummary] = useState<MetaScanSummary | null>(
    () => loadSetupMetaScanSummary(),
  );
  const prevModelsCountRef = useRef(0);
  const prevToolchainTaskStatusRef = useRef<Record<string, DownloadStatus>>({});
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
      if (info.runtime_ready) {
        setToolchainSkipped((skipped) => {
          if (skipped) clearToolchainOnboardingSkipped();
          return false;
        });
      }
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

  const pathsDone = computePathsDone({
    pathsConfigured,
    modelsDeferred,
    catalogLoaded,
    modelsCount,
  });
  const toolchainDone = computeToolchainDone(toolchainSkipped, runtimeReady);
  const metaScanFailed = metaScanSummary?.failed ?? 0;
  const metaDone = useMemo(
    () =>
      computeMetaDone({
        modelsDeferred,
        modelsCount,
        metaScanSkipped,
        scannedCount,
        metaScanSummary,
      }),
    [modelsDeferred, modelsCount, metaScanSkipped, scannedCount, metaScanSummary],
  );

  const phase = useMemo(
    () =>
      computeSetupPhase({
        pathsDone,
        toolchainDone,
        modelsCount,
        modelsDeferred,
        metaDone,
      }),
    [pathsDone, toolchainDone, modelsCount, modelsDeferred, metaDone],
  );

  const toolchainBusy = useMemo(
    () => computeToolchainBusy(toolchainTasks, runtimeReady),
    [toolchainTasks, runtimeReady],
  );

  const { active, diskSetupCompleted, setDiskSetupCompleted } = useSetupGuideActivation({
    preview,
    pathsReady,
    pathsConfigured,
    modelsCount,
    scannedCount,
    metaDone,
    modelsDeferred,
    dismissed,
    welcomeDone,
    setDismissed,
    setWelcomeDone,
    setModelsDeferred,
    setToolchainSkipped,
  });

  const showWelcome = active && !welcomeDone;

  useEffect(() => {
    if (!active) return;
    void refreshToolchain();
  }, [active, refreshToolchain]);

  const clearMetaScanSummary = useCallback(() => {
    setMetaScanSummary(null);
    saveSetupMetaScanSummary(null);
  }, []);

  useTauriListen<{ total?: number }>("gguf-scan-start", clearMetaScanSummary, [clearMetaScanSummary]);

  useTauriListen<{ scanned: number; failed: number; total?: number }>(
    "gguf-scan-complete",
    (payload) => {
      const total = payload.total ?? payload.scanned + payload.failed;
      const summary = { scanned: payload.scanned, failed: payload.failed, total };
      setMetaScanSummary(summary);
      saveSetupMetaScanSummary(summary);
    },
    [],
  );

  useEffect(() => {
    if (modelsCount > prevModelsCountRef.current) {
      clearMetaScanSummary();
    }
    prevModelsCountRef.current = modelsCount;
  }, [modelsCount, clearMetaScanSummary]);

  useEffect(() => {
    if (!modelsDeferred || modelsCount === 0) return;
    setModelsDeferred(false);
    clearSetupModelsDeferred();
  }, [modelsDeferred, modelsCount]);

  useEffect(() => {
    if (metaScanSummary || !batchScanState || batchScanState.active) return;
    const processed = batchScanState.scanned + batchScanState.failed;
    const total = batchScanState.total || processed;
    if (processed <= 0 || total <= 0 || processed < total) return;
    const summary = {
      scanned: batchScanState.scanned,
      failed: batchScanState.failed,
      total,
    };
    setMetaScanSummary(summary);
    saveSetupMetaScanSummary(summary);
  }, [batchScanState, metaScanSummary]);

  const completeWelcome = useCallback(() => {
    if (!preview) saveSetupWelcomeSeen();
    setWelcomeDone(true);
  }, [preview]);

  const deferModels = useCallback(() => {
    if (!preview) saveSetupModelsDeferred();
    setModelsDeferred(true);
  }, [preview]);

  const skipToolchain = useCallback(() => {
    if (!preview) saveToolchainOnboardingSkipped();
    setToolchainSkipped(true);
  }, [preview]);

  const skipMetaScan = useCallback(() => {
    setMetaScanSkipped(true);
  }, []);

  const dismiss = useCallback(() => {
    if (!preview) {
      saveSetupGuideDismissed();
      saveSetupMetaScanSummary(null);
      void invoke("mark_setup_completed").then(() => setDiskSetupCompleted(true));
    }
    setDismissed(true);
  }, [preview, setDiskSetupCompleted]);

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
    phase,
    pathsDone,
    toolchainSkipped,
    runtimeReady,
    toolchainChecked,
    toolchainBusy,
    modelsDeferred,
    metaDone,
    metaScanFailed,
    showWelcome,
    welcomeDone,
    completeWelcome,
    deferModels,
    skipToolchain,
    skipMetaScan,
    dismiss,
    modelsCount,
    scannedCount,
    catalogLoaded,
  };
}