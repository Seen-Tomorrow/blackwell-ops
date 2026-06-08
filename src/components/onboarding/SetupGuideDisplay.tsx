import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SetupPhase } from "../../hooks/useSetupGuide";
import { LM_STUDIO_MODEL_PATH_TEMPLATE } from "../../lib/onboarding";
import { dispatchAppEvent, EVENTS, type NavigateConfigDetail } from "../../lib/events";

interface SetupGuideDisplayProps {
  phase: SetupPhase;
  modelsCount: number;
  scannedCount: number;
  onDismiss: () => void;
}

export default function SetupGuideDisplay({
  phase,
  modelsCount,
  scannedCount,
  onDismiss,
}: SetupGuideDisplayProps) {
  const [lmStudioAvailable, setLmStudioAvailable] = useState<boolean | null>(null);
  const [migrating, setMigrating] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [lmStudioLinked, setLmStudioLinked] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<boolean>("lmstudio_models_available")
      .then((available) => {
        if (!cancelled) setLmStudioAvailable(available);
      })
      .catch(() => {
        if (!cancelled) setLmStudioAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const openPaths = () => {
    dispatchAppEvent(EVENTS.navigateConfig, { subTab: "paths" } satisfies NavigateConfigDetail);
  };

  const migrateFromLmStudio = useCallback(async () => {
    setMigrating(true);
    setActionError(null);
    try {
      const added = await invoke<boolean>("add_lmstudio_model_path");
      setLmStudioLinked(true);
      dispatchAppEvent(EVENTS.modelPathsChanged);
      if (!added) {
        setActionError("LM Studio folder is already linked.");
      }
    } catch (err) {
      const msg = typeof err === "string" ? err : "Could not link LM Studio models folder.";
      setActionError(msg);
    } finally {
      setMigrating(false);
    }
  }, []);

  return (
    <div className="setup-guide px-3 py-2.5 min-h-[200px]">
      <div className="flex items-baseline gap-1 mb-3">
        <span className="text-xl font-mono text-nv-green">FORECAST: setup</span>
      </div>

      <p className="text-[9px] font-mono text-stealth-muted tracking-wider mb-3 uppercase">
        Quick start
      </p>

      <ol className="space-y-2 text-[9px] font-mono text-stealth-muted/80 list-decimal list-inside">
        <li className={phase === "paths" ? "text-nv-green" : ""}>
          Point at your model library — LM Studio one-click or CONFIG → PATHS
        </li>
        <li className={phase === "scan-meta" ? "text-nv-green" : ""}>
          CATALOG → SCAN META — read GGUF metadata ({scannedCount}/{modelsCount})
        </li>
        <li>Optional — CONFIG → PROVIDERS → SCAN LIBRARY for measured VRAM</li>
      </ol>

      {actionError && (
        <p className="mt-3 text-[8px] font-mono text-telemetry-red">{actionError}</p>
      )}

      {lmStudioLinked && modelsCount > 0 && phase === "scan-meta" && (
        <p className="mt-3 text-[8px] font-mono text-nv-green">
          {modelsCount} models loaded — run SCAN META next (button pulses above catalog).
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        {phase === "paths" && (
          <>
            <button
              type="button"
              onClick={() => void migrateFromLmStudio()}
              disabled={migrating || lmStudioAvailable === false}
              title={
                lmStudioAvailable === false
                  ? `LM Studio folder not found at ${LM_STUDIO_MODEL_PATH_TEMPLATE}`
                  : `Link ${LM_STUDIO_MODEL_PATH_TEMPLATE}`
              }
              className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-telemetry-cyan/50 text-telemetry-cyan hover:bg-telemetry-cyan/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {migrating ? "LINKING…" : "MIGRATING FROM LM STUDIO"}
            </button>
            <button
              type="button"
              onClick={openPaths}
              className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-nv-green/50 text-nv-green hover:bg-nv-green/10 transition-colors"
            >
              OPEN PATHS
            </button>
          </>
        )}
        <button
          type="button"
          onClick={onDismiss}
          className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-stealth-muted/40 text-stealth-muted hover:text-white hover:border-stealth-muted transition-colors"
        >
          DON&apos;T SHOW AGAIN
        </button>
      </div>
    </div>
  );
}