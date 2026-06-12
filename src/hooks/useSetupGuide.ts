import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry } from "../lib/types";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  isSetupGuideDismissed,
  isSetupGuidePreview,
  isSetupWelcomeSeen,
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
  const [dismissed, setDismissed] = useState(() => isSetupGuideDismissed());
  const [welcomeDone, setWelcomeDone] = useState(() => isSetupWelcomeSeen());
  const [pathsConfigured, setPathsConfigured] = useState(false);

  const refreshPaths = useCallback(async () => {
    try {
      const configured = await invoke<boolean>("model_library_configured");
      setPathsConfigured(configured);
    } catch {
      setPathsConfigured(false);
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
  const active = preview || !dismissed;

  const showWelcome = active && !welcomeDone;

  const completeWelcome = useCallback(() => {
    if (!preview) saveSetupWelcomeSeen();
    setWelcomeDone(true);
  }, [preview]);

  const dismiss = useCallback(() => {
    if (!preview) saveSetupGuideDismissed();
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