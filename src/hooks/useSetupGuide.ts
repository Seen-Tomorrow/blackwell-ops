import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry } from "../lib/types";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import { useTauriListen } from "./useTauriListen";
import {
  isSetupGuideDismissed,
  isSetupGuidePreview,
  isSetupModelsDeferred,
  isSetupWelcomeSeen,
  isToolchainOnboardingSkipped,
  loadSetupMetaScanSummary,
  resetSetupGuideState,
  saveToolchainOnboardingSkipped,
  saveSetupGuideDismissed,
  saveSetupMetaScanSummary,
  clearSetupModelsDeferred,
  saveSetupModelsDeferred,
  saveSetupWelcomeSeen,
} from "../lib/storage";

export type SetupPhase = "paths" | "toolchain" | "scan-meta" | "fit-scan" | "drivers";

interface MetaScanSummary {
  scanned: number;
  failed: number;
  total: number;
}

export interface SetupGuideState {
  active: boolean;
  phase: SetupPhase;
  pathsDone: boolean;
  toolchainDone: boolean;
  runtimeReady: boolean;
  modelsDeferred: boolean;
  metaDone: boolean;
  /** Models that failed GGUF metadata scan in the last completed batch. */
  metaScanFailed: number;
  showWelcome: boolean;
  welcomeDone: boolean;
  completeWelcome: () => void;
  deferModels: () => void;
  skipToolchain: () => void;
  dismiss: () => void;
  modelsCount: number;
  scannedCount: number;
}

interface BatchScanSnapshot {
  active: boolean;
  scanned: number;
  failed: number;
  total: number;
}

interface UseSetupGuideOptions {
  models: ModelEntry[];
  batchScanState?: BatchScanSnapshot;
}

export function useSetupGuide({ models, batchScanState }: UseSetupGuideOptions) {
  const hadDismissedOnMount = useRef(isSetupGuideDismissed());
  const staleWipeHandled = useRef(false);
  const [catalogBaselineReady, setCatalogBaselineReady] = useState(false);
  const [catalogHadMetadataAtBaseline, setCatalogHadMetadataAtBaseline] = useState(false);
  const [dismissed, setDismissed] = useState(() => isSetupGuideDismissed());
  const [welcomeDone, setWelcomeDone] = useState(() => isSetupWelcomeSeen());
  const [modelsDeferred, setModelsDeferred] = useState(() => isSetupModelsDeferred());
  const [toolchainSkipped, setToolchainSkipped] = useState(() => isToolchainOnboardingSkipped());
  const [runtimeReady, setRuntimeReady] = useState(false);
  const [toolchainReady, setToolchainReady] = useState(false);
  const [diskSetupCompleted, setDiskSetupCompleted] = useState(false);
  const [diskSetupReady, setDiskSetupReady] = useState(false);
  const [pathsConfigured, setPathsConfigured] = useState(false);
  const [pathsReady, setPathsReady] = useState(false);
  const [metaScanSummary, setMetaScanSummary] = useState<MetaScanSummary | null>(
    () => loadSetupMetaScanSummary(),
  );
  const prevModelsCountRef = useRef(0);

  useEffect(() => {
    invoke<boolean>("is_setup_completed")
      .then((completed) => setDiskSetupCompleted(completed))
      .catch(() => setDiskSetupCompleted(false))
      .finally(() => setDiskSetupReady(true));
  }, []);

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
      const info = await invoke<{ runtime_ready: boolean; all_ready: boolean }>(
        "foundry_get_toolchain_install_info",
      );
      setRuntimeReady(info.runtime_ready);
      setToolchainReady(info.all_ready);
    } catch {
      setRuntimeReady(false);
      setToolchainReady(false);
    }
  }, []);

  useEffect(() => {
    void refreshPaths();
    void refreshToolchain();
  }, [refreshPaths, refreshToolchain]);

  useEffect(() => {
    const handler = () => {
      void refreshPaths();
      void refreshToolchain();
    };
    window.addEventListener(EVENTS.modelPathsChanged, handler);
    window.addEventListener(EVENTS.downloadCompleted, handler);
    return () => {
      window.removeEventListener(EVENTS.modelPathsChanged, handler);
      window.removeEventListener(EVENTS.downloadCompleted, handler);
    };
  }, [refreshPaths, refreshToolchain]);

  const scannedCount = useMemo(
    () => models.filter((m) => m.metadata).length,
    [models],
  );

  const modelsCount = models.length;
  const pathsDone = pathsConfigured || modelsDeferred;
  /** Only gate onboarding on toolchain when local GGUF scan will run. */
  const toolchainRequired = modelsCount > 0 && !modelsDeferred;
  const toolchainDone =
    !toolchainRequired || toolchainSkipped || toolchainReady;
  const metaScanFailed = metaScanSummary?.failed ?? 0;

  const metaDone = useMemo(() => {
    if (modelsDeferred || modelsCount === 0) return true;
    if (scannedCount >= modelsCount) return true;
    if (!metaScanSummary) return false;
    const processed = metaScanSummary.scanned + metaScanSummary.failed;
    return processed >= metaScanSummary.total && metaScanSummary.total >= modelsCount;
  }, [modelsDeferred, modelsCount, scannedCount, metaScanSummary]);

  const clearMetaScanSummary = useCallback(() => {
    setMetaScanSummary(null);
    saveSetupMetaScanSummary(null);
  }, []);

  useTauriListen<{ total?: number }>("gguf-scan-start", () => {
    clearMetaScanSummary();
  }, [clearMetaScanSummary]);

  useTauriListen<{ scanned: number; failed: number; total?: number }>(
    "gguf-scan-complete",
    (payload) => {
      const total = payload.total ?? payload.scanned + payload.failed;
      const summary = {
        scanned: payload.scanned,
        failed: payload.failed,
        total,
      };
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

  // User linked a library after deferring — require metadata scan again.
  useEffect(() => {
    if (!modelsDeferred || modelsCount === 0) return;
    setModelsDeferred(false);
    clearSetupModelsDeferred();
  }, [modelsDeferred, modelsCount]);

  // Same-session bootstrap when batch scan finished before meta summary was persisted (pre-fix).
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

  const phase: SetupPhase = useMemo(() => {
    if (!pathsDone) return "paths";
    if (toolchainRequired && !toolchainDone) return "toolchain";
    if (modelsCount > 0 && !modelsDeferred && !metaDone) return "scan-meta";
    return "fit-scan";
  }, [pathsDone, toolchainRequired, toolchainDone, modelsCount, modelsDeferred, metaDone]);

  const preview = isSetupGuidePreview();

  // Snapshot whether metadata existed before this session — SCAN META during first-run must not auto-finish.
  useEffect(() => {
    if (!pathsReady || catalogBaselineReady) return;
    if (!pathsConfigured && modelsCount === 0) {
      setCatalogBaselineReady(true);
      setCatalogHadMetadataAtBaseline(false);
      return;
    }
    if (modelsCount === 0) return;
    setCatalogBaselineReady(true);
    setCatalogHadMetadataAtBaseline(scannedCount > 0);
  }, [pathsReady, pathsConfigured, modelsCount, scannedCount, catalogBaselineReady]);

  /** Catalog has models — may be true even when `model_library_configured` is false (factory `models/` path). */
  const catalogReady = pathsReady && modelsCount > 0;
  /**
   * Metadata already on disk at session start (CLEAR LOCAL STORAGE recovery / legacy upgrade).
   * Metadata gained from SCAN META during the current checklist does not count.
   */
  const recoveredFromClearStorage =
    catalogBaselineReady
    && catalogHadMetadataAtBaseline
    && catalogReady
    && (scannedCount > 0 || metaDone);
  /** Empty catalog — normal during first-run, also true after a manual config/ wipe. */
  const bareCatalog = pathsReady && !pathsConfigured && modelsCount === 0;
  /** Prior setup finished in LS but portable config/ was wiped — not a fresh install. */
  const staleLsAfterConfigWipe =
    bareCatalog && hadDismissedOnMount.current && !diskSetupCompleted;
  const setupSatisfied = diskSetupCompleted || recoveredFromClearStorage;

  // Config folder wiped while localStorage still says setup was finished.
  useEffect(() => {
    if (staleWipeHandled.current) return;
    if (!diskSetupReady || preview || diskSetupCompleted || !staleLsAfterConfigWipe) return;
    staleWipeHandled.current = true;
    resetSetupGuideState();
    setDismissed(false);
    setWelcomeDone(false);
    setModelsDeferred(false);
    setToolchainSkipped(false);
  }, [diskSetupReady, diskSetupCompleted, staleLsAfterConfigWipe, preview]);

  // Pre-`setup_completed` builds — backfill disk flag when library still exists on disk.
  useEffect(() => {
    if (!diskSetupReady || preview || diskSetupCompleted || !dismissed) return;
    if (!pathsConfigured && !recoveredFromClearStorage && !modelsDeferred) return;
    void invoke("mark_setup_completed").then(() => setDiskSetupCompleted(true));
  }, [
    diskSetupReady,
    diskSetupCompleted,
    dismissed,
    pathsConfigured,
    recoveredFromClearStorage,
    modelsDeferred,
    preview,
  ]);

  const active = preview || (pathsReady && diskSetupReady && !setupSatisfied);

  const showWelcome = active && !welcomeDone;

  // Re-persist onboarding keys after CLEAR LOCAL STORAGE — not during first-run checklist.
  useEffect(() => {
    if (preview || !recoveredFromClearStorage) return;
    if (!diskSetupCompleted) {
      void invoke("mark_setup_completed").then(() => setDiskSetupCompleted(true));
    }
    if (!dismissed) {
      saveSetupGuideDismissed();
      setDismissed(true);
    }
    if (!welcomeDone) {
      saveSetupWelcomeSeen();
      setWelcomeDone(true);
    }
  }, [preview, recoveredFromClearStorage, diskSetupCompleted, dismissed, welcomeDone]);

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

  const dismiss = useCallback(() => {
    if (!preview) {
      saveSetupGuideDismissed();
      saveSetupMetaScanSummary(null);
      void invoke("mark_setup_completed").then(() => setDiskSetupCompleted(true));
    }
    setDismissed(true);
  }, [preview]);

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
    toolchainDone,
    runtimeReady,
    modelsDeferred,
    metaDone,
    metaScanFailed,
    showWelcome,
    welcomeDone,
    completeWelcome,
    deferModels,
    skipToolchain,
    dismiss,
    modelsCount,
    scannedCount,
  };
}