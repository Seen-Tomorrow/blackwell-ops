import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { SetupPhase } from "../../hooks/useSetupGuide";
import { dispatchAppEvent, dispatchNavigateConfig, EVENTS } from "../../lib/events";
import { FIT_SCAN_PARALLEL_OPTIONS } from "../../lib/onboarding";
import type {
  FitScanComplete,
  FitScanProgress,
  ModelLibraryValidation,
  ProviderConfig,
} from "../../lib/types";

const DEFAULT_FIT_PROVIDER = "ggml-master";

type FitScanStep = "idle" | "running" | "done" | "skipped";
type FitScanParallel = (typeof FIT_SCAN_PARALLEL_OPTIONS)[number];

interface SetupGuideDisplayProps {
  phase: SetupPhase;
  pathsDone: boolean;
  metaDone: boolean;
  modelsCount: number;
  scannedCount: number;
  onDismiss: () => void;
}

interface ChecklistItemProps {
  done: boolean;
  current: boolean;
  title: string;
  detail: string;
  optional?: boolean;
}

function ChecklistItem({ done, current, title, detail, optional }: ChecklistItemProps) {
  return (
    <li
      className={`setup-checklist__item${done ? " setup-checklist__item--done" : ""}${
        current ? " setup-checklist__item--current" : ""
      }`}
    >
      <span className="setup-checklist__mark" aria-hidden="true">
        {done ? "✓" : "○"}
      </span>
      <span className="setup-checklist__body">
        <span className="setup-checklist__title">
          {title}
          {optional ? <span className="setup-checklist__optional"> optional</span> : null}
        </span>
        <span className="setup-checklist__detail">{detail}</span>
      </span>
    </li>
  );
}

export default function SetupGuideDisplay({
  phase,
  pathsDone,
  metaDone,
  modelsCount,
  scannedCount,
  onDismiss,
}: SetupGuideDisplayProps) {
  const [migrating, setMigrating] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [needsBrowse, setNeedsBrowse] = useState(false);
  const [libraryLinked, setLibraryLinked] = useState(false);
  const [lmStudioDefaultPath, setLmStudioDefaultPath] = useState<string | null>(null);
  const [fitStep, setFitStep] = useState<FitScanStep>("idle");
  const [fitRunning, setFitRunning] = useState(false);
  const [showFitScanMenu, setShowFitScanMenu] = useState(false);
  const [driversConfirmed, setDriversConfirmed] = useState(false);
  const [showDriversStep, setShowDriversStep] = useState(false);

  useEffect(() => {
    let cancelled = false;
    invoke<string>("get_lm_studio_default_path")
      .then((path) => {
        if (!cancelled) setLmStudioDefaultPath(path);
      })
      .catch(() => {
        if (!cancelled) setLmStudioDefaultPath(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!metaDone) {
      setShowDriversStep(false);
      setFitStep("idle");
      setDriversConfirmed(false);
    }
  }, [metaDone]);

  const openPaths = () => {
    dispatchNavigateConfig({ subTab: "paths" });
  };

  const browseModelLibrary = useCallback(async () => {
    setBrowsing(true);
    setActionError(null);
    try {
      const selected = await invoke<string | null>("open_folder_dialog", {
        title: "Select model library folder",
      });
      if (!selected) return;

      const validation = await invoke<ModelLibraryValidation>("validate_model_library", {
        path: selected,
      });
      if (!validation.exists) {
        setActionError("That folder does not exist.");
        setNeedsBrowse(true);
        return;
      }
      if (validation.ggufCount === 0) {
        setActionError(
          `No GGUF models found in ${validation.resolvedPath}. Pick a folder that contains your models.`,
        );
        setNeedsBrowse(true);
        return;
      }

      await invoke("add_model_path", { path: selected, label: null });
      setLibraryLinked(true);
      setNeedsBrowse(false);
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (err) {
      const msg = typeof err === "string" ? err : "Could not add model folder.";
      setActionError(msg);
      setNeedsBrowse(true);
    } finally {
      setBrowsing(false);
    }
  }, []);

  const migrateFromLmStudio = useCallback(async () => {
    setMigrating(true);
    setActionError(null);
    setNeedsBrowse(false);
    try {
      const added = await invoke<boolean>("add_lmstudio_model_path");
      if (added) {
        setLibraryLinked(true);
        setNeedsBrowse(false);
        dispatchAppEvent(EVENTS.modelPathsChanged);
      } else {
        setActionError("LM Studio folder is already linked.");
      }
    } catch (err) {
      const msg = typeof err === "string" ? err : "Could not link LM Studio models folder.";
      setActionError(msg);
      setNeedsBrowse(true);
    } finally {
      setMigrating(false);
    }
  }, []);

  const skipFitScan = useCallback(() => {
    setFitStep("skipped");
    setShowDriversStep(true);
  }, []);

  const runFitScan = useCallback(async (parallel: FitScanParallel) => {
    setShowFitScanMenu(false);
    setFitRunning(true);
    setFitStep("running");
    setActionError(null);

    void invoke("emit_to_blackwell_console", {
      category: "utils",
      content: `[FIT-SCAN] Starting library VRAM fit scan (${DEFAULT_FIT_PROVIDER}, ${parallel}x parallel)…`,
      style: "Normal",
    });

    try {
      const allProviders = await invoke<ProviderConfig[]>("list_providers");
      const provider = allProviders.find((p) => p.id === DEFAULT_FIT_PROVIDER);
      const batch = provider?.params?.batch || 2048;
      const ubatch = provider?.params?.ubatch || provider?.params?.ubatch_size || 512;

      await invoke<FitScanComplete>("fit_scan_library", {
        providerId: DEFAULT_FIT_PROVIDER,
        modelBase: "",
        parallelCount: parallel,
        batch,
        ubatch,
        forceRescan: false,
      });

      setFitStep("done");
      setShowDriversStep(true);
    } catch (err) {
      const msg = typeof err === "string" ? err : "VRAM fit scan failed.";
      setActionError(msg);
      setFitStep("idle");
      void invoke("emit_to_blackwell_console", {
        category: "error",
        content: `[FIT-SCAN] ${msg}`,
        style: "Error",
      });
    } finally {
      setFitRunning(false);
    }
  }, []);

  useEffect(() => {
    let unsub: (() => void) | null = null;
    let cancelled = false;

    void listen<FitScanProgress>("fit-scan-progress", (e) => {
      const evt = e.payload;
      if (!evt?.model_path || cancelled || evt.status === "error") return;
      void invoke("emit_to_blackwell_console", {
        category: "utils",
        content: `[FIT-SCAN] ${evt.model_path} | ${evt.status} | ${evt.label || ""} | ${
          evt.vram_mib != null ? `${evt.vram_mib} MiB` : ""
        }`,
        style: evt.status === "complete" ? "Success" : "Normal",
      });
    }).then((u) => {
      if (!cancelled) unsub = u;
    });

    return () => {
      cancelled = true;
      unsub?.();
    };
  }, []);

  const fitDone = fitStep === "done" || fitStep === "skipped";
  const driversStepActive = showDriversStep || (metaDone && fitDone);
  const fitCurrent = metaDone && !fitDone && !showDriversStep;

  return (
    <div className="setup-guide px-3 py-2.5 min-h-[200px]">
      <div className="flex items-baseline gap-1 mb-3">
        <span className="text-xl font-mono text-nv-green">FORECAST: setup</span>
      </div>

      <p className="text-[9px] font-mono text-stealth-muted tracking-wider mb-3 uppercase">
        Quick start checklist
      </p>

      <ul className="setup-checklist">
        <ChecklistItem
          done={pathsDone}
          current={phase === "paths"}
          title="Link your model library"
          detail="LM Studio one-click or CONFIG → PATHS"
        />
        <ChecklistItem
          done={metaDone}
          current={phase === "scan-meta"}
          title="Scan GGUF metadata"
          detail={`CATALOG → SCAN META (${scannedCount}/${modelsCount})`}
        />
        <ChecklistItem
          done={fitDone}
          current={fitCurrent}
          optional
          title="VRAM fit scan (29-point)"
          detail="Measured VRAM per model — runs in background, logs to Output Console"
        />
        <ChecklistItem
          done={driversConfirmed}
          current={driversStepActive && !driversConfirmed}
          title="Confirm NVIDIA drivers"
          detail="Recent Game Ready / Studio driver recommended for CUDA inference"
        />
      </ul>

      {actionError && (
        <p className="mt-3 text-[8px] font-mono text-telemetry-red">{actionError}</p>
      )}

      {needsBrowse && phase === "paths" && (
        <p className="mt-3 text-[8px] font-mono text-stealth-muted leading-relaxed">
          Default LM Studio path missing or empty. Browse to the folder where your GGUF models live.
        </p>
      )}

      {libraryLinked && modelsCount > 0 && phase === "scan-meta" && (
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
              disabled={migrating || browsing}
              title={
                lmStudioDefaultPath
                  ? `Try default LM Studio folder (${lmStudioDefaultPath})`
                  : "Try default LM Studio models folder"
              }
              className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-telemetry-cyan/50 text-telemetry-cyan hover:bg-telemetry-cyan/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {migrating ? "LINKING…" : "MIGRATING FROM LM STUDIO"}
            </button>
            <button
              type="button"
              onClick={() => void browseModelLibrary()}
              disabled={migrating || browsing}
              className={`px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                needsBrowse
                  ? "border-nv-green/70 text-nv-green hover:bg-nv-green/10"
                  : "border-stealth-muted/40 text-stealth-muted hover:text-white hover:border-stealth-muted"
              }`}
            >
              {browsing ? "BROWSING…" : "BROWSE"}
            </button>
            <button
              type="button"
              onClick={openPaths}
              disabled={migrating || browsing}
              className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-nv-green/50 text-nv-green hover:bg-nv-green/10 transition-colors disabled:opacity-30"
            >
              OPEN PATHS
            </button>
          </>
        )}

        {metaDone && !fitDone && !showDriversStep && (
          <>
            {fitRunning ? (
              <button
                type="button"
                disabled
                className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-nv-green/50 text-nv-green opacity-40 cursor-not-allowed"
              >
                FIT SCAN RUNNING…
              </button>
            ) : showFitScanMenu ? (
              <div className="flex items-center gap-1">
                {FIT_SCAN_PARALLEL_OPTIONS.map((parallel) => (
                  <button
                    key={parallel}
                    type="button"
                    onClick={() => void runFitScan(parallel)}
                    className="catalog-scan-btn px-2 py-0.5 text-[8px] font-mono transition-colors rounded-sm"
                    title={`VRAM fit scan with ${parallel}x parallelism`}
                  >
                    SPEED {parallel}×
                  </button>
                ))}
              </div>
            ) : (
              <button
                type="button"
                onClick={() => setShowFitScanMenu(true)}
                className="catalog-scan-btn px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-nv-green/50 text-nv-green hover:bg-nv-green/10 transition-colors"
              >
                RUN VRAM FIT SCAN ▾
              </button>
            )}
            <button
              type="button"
              onClick={skipFitScan}
              disabled={fitRunning}
              className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-stealth-muted/40 text-stealth-muted hover:text-white hover:border-stealth-muted transition-colors disabled:opacity-40"
            >
              SKIP
            </button>
          </>
        )}

        {driversStepActive && (
          <label className="flex items-center gap-2 text-[8px] font-mono text-stealth-muted cursor-pointer select-none">
            <input
              type="checkbox"
              checked={driversConfirmed}
              onChange={(e) => setDriversConfirmed(e.target.checked)}
              className="setup-checklist__checkbox"
            />
            I have recent NVIDIA drivers installed, v610+ required for cuda 13.3 (FRONTIER)
          </label>
        )}

        <button
          type="button"
          onClick={onDismiss}
          disabled={!driversConfirmed}
          className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-nv-green/50 text-nv-green hover:bg-nv-green/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
        >
          FINISH SETUP
        </button>
      </div>
    </div>
  );
}