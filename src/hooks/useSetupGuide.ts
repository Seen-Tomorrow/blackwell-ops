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

export type SetupPhase = "paths" | "scan-meta" | "ready";

export interface SetupGuideState {
  active: boolean;
  phase: SetupPhase;
  showWelcome: boolean;
  welcomeDone: boolean;
  completeWelcome: () => void;
  dismiss: () => void;
  modelsCount: number;
  scannedCount: number;
  pathCount: number;
}

interface UseSetupGuideOptions {
  models: ModelEntry[];
}

export function useSetupGuide({ models }: UseSetupGuideOptions) {
  const [dismissed, setDismissed] = useState(() => isSetupGuideDismissed());
  const [welcomeDone, setWelcomeDone] = useState(() => isSetupWelcomeSeen());
  const [pathCount, setPathCount] = useState(0);

  const refreshPaths = useCallback(async () => {
    try {
      const paths = await invoke<Array<{ path: string }>>("list_model_paths");
      setPathCount(paths.length);
    } catch {
      setPathCount(0);
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

  const phase: SetupPhase = useMemo(() => {
    if (models.length === 0) return "paths";
    if (scannedCount === 0) return "scan-meta";
    return "ready";
  }, [models.length, scannedCount]);

  const preview = isSetupGuidePreview();
  const active = preview || (!dismissed && phase !== "ready");
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
    showWelcome,
    welcomeDone,
    completeWelcome,
    dismiss,
    modelsCount: models.length,
    scannedCount,
    pathCount,
  };
}