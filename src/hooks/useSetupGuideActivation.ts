import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  isSetupGuideDismissed,
  isSetupGuidePreview,
  resetSetupGuideState,
  saveSetupGuideDismissed,
  saveSetupWelcomeSeen,
} from "../lib/storage";

interface UseSetupGuideActivationOptions {
  preview: boolean;
  pathsReady: boolean;
  pathsConfigured: boolean;
  modelsCount: number;
  scannedCount: number;
  metaDone: boolean;
  modelsDeferred: boolean;
  dismissed: boolean;
  welcomeDone: boolean;
  setDismissed: (v: boolean) => void;
  setWelcomeDone: (v: boolean) => void;
  setModelsDeferred: (v: boolean) => void;
  setToolchainSkipped: (v: boolean) => void;
}

/**
 * Decides whether the setup wizard is active — handles config wipe vs localStorage mismatch
 * and “metadata already on disk” recovery after CLEAR LOCAL STORAGE.
 */
export function useSetupGuideActivation({
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
}: UseSetupGuideActivationOptions) {
  const hadDismissedOnMount = useRef(isSetupGuideDismissed());
  const staleWipeHandled = useRef(false);
  const [catalogBaselineReady, setCatalogBaselineReady] = useState(false);
  const [catalogHadMetadataAtBaseline, setCatalogHadMetadataAtBaseline] = useState(false);
  const [diskSetupCompleted, setDiskSetupCompleted] = useState(false);
  const [diskSetupReady, setDiskSetupReady] = useState(false);

  useEffect(() => {
    invoke<boolean>("is_setup_completed")
      .then((completed) => setDiskSetupCompleted(completed))
      .catch(() => setDiskSetupCompleted(false))
      .finally(() => setDiskSetupReady(true));
  }, []);

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

  const catalogReady = pathsReady && modelsCount > 0;
  const recoveredFromClearStorage =
    catalogBaselineReady
    && catalogHadMetadataAtBaseline
    && catalogReady
    && (scannedCount > 0 || metaDone);
  const bareCatalog = pathsReady && !pathsConfigured && modelsCount === 0;
  const staleLsAfterConfigWipe =
    bareCatalog && hadDismissedOnMount.current && !diskSetupCompleted;
  const setupSatisfied = diskSetupCompleted || recoveredFromClearStorage;
  const active = preview || (pathsReady && diskSetupReady && !setupSatisfied);

  useEffect(() => {
    if (staleWipeHandled.current) return;
    if (!diskSetupReady || preview || diskSetupCompleted || !staleLsAfterConfigWipe) return;
    staleWipeHandled.current = true;
    resetSetupGuideState();
    setDismissed(false);
    setWelcomeDone(false);
    setModelsDeferred(false);
    setToolchainSkipped(false);
  }, [
    diskSetupReady,
    diskSetupCompleted,
    staleLsAfterConfigWipe,
    preview,
    setDismissed,
    setWelcomeDone,
    setModelsDeferred,
    setToolchainSkipped,
  ]);

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
  }, [
    preview,
    recoveredFromClearStorage,
    diskSetupCompleted,
    dismissed,
    welcomeDone,
    setDismissed,
    setWelcomeDone,
  ]);

  return { active, setupSatisfied, diskSetupCompleted, setDiskSetupCompleted };
}

export function isSetupGuidePreviewMode(): boolean {
  return isSetupGuidePreview();
}