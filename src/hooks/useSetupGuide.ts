import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry } from "../lib/types";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  isSetupGuideDismissed,
  isSetupGuidePreview,
  isSetupWelcomeSeen,
  resetSetupGuideState,
  saveSetupGuideDismissed,
  saveSetupWelcomeSeen,
} from "../lib/storage";

export type SetupPhase = "paths" | "scan-meta" | "fit-scan" | "drivers";

export interface SetupGuideState {
  active: boolean;
  phase: SetupPhase;
  pathsDone: boolean;
  metaDone: boolean;
  showWelcome: boolean;
  welcomeDone: boolean;
  completeWelcome: () => void;
  dismiss: () => void;
  modelsCount: number;
  scannedCount: number;
}

interface UseSetupGuideOptions {
  models: ModelEntry[];
}

export function useSetupGuide({ models }: UseSetupGuideOptions) {
  const hadDismissedOnMount = useRef(isSetupGuideDismissed());
  const staleWipeHandled = useRef(false);
  const [catalogBaselineReady, setCatalogBaselineReady] = useState(false);
  const [catalogHadMetadataAtBaseline, setCatalogHadMetadataAtBaseline] = useState(false);
  const [dismissed, setDismissed] = useState(() => isSetupGuideDismissed());
  const [welcomeDone, setWelcomeDone] = useState(() => isSetupWelcomeSeen());
  const [diskSetupCompleted, setDiskSetupCompleted] = useState(false);
  const [diskSetupReady, setDiskSetupReady] = useState(false);
  const [pathsConfigured, setPathsConfigured] = useState(false);
  const [pathsReady, setPathsReady] = useState(false);

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

  useEffect(() => {
    void refreshPaths();
  }, [refreshPaths]);

  useEffect(() => {
    const handler = () => { void refreshPaths(); };
    window.addEventListener(EVENTS.modelPathsChanged, handler);
    window.addEventListener(EVENTS.downloadCompleted, handler);
    return () => {
      window.removeEventListener(EVENTS.modelPathsChanged, handler);
      window.removeEventListener(EVENTS.downloadCompleted, handler);
    };
  }, [refreshPaths]);

  const scannedCount = useMemo(
    () => models.filter((m) => m.metadata).length,
    [models],
  );

  const modelsCount = models.length;
  const pathsDone = pathsConfigured;
  const metaDone = modelsCount > 0 && scannedCount >= modelsCount;

  const phase: SetupPhase = useMemo(() => {
    if (!pathsDone) return "paths";
    if (!metaDone) return "scan-meta";
    return "fit-scan";
  }, [pathsDone, metaDone]);

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
  }, [diskSetupReady, diskSetupCompleted, staleLsAfterConfigWipe, preview]);

  // Pre-`setup_completed` builds — backfill disk flag when library still exists on disk.
  useEffect(() => {
    if (!diskSetupReady || preview || diskSetupCompleted || !dismissed) return;
    if (!pathsConfigured && !recoveredFromClearStorage) return;
    void invoke("mark_setup_completed").then(() => setDiskSetupCompleted(true));
  }, [
    diskSetupReady,
    diskSetupCompleted,
    dismissed,
    pathsConfigured,
    recoveredFromClearStorage,
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

  const dismiss = useCallback(() => {
    if (!preview) {
      saveSetupGuideDismissed();
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
    metaDone,
    showWelcome,
    welcomeDone,
    completeWelcome,
    dismiss,
    modelsCount,
    scannedCount,
  };
}