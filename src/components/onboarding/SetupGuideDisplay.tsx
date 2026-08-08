import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import type { SetupPhase } from "../../lib/setupGuide";
import { FIT_SCAN_PARALLEL_OPTIONS } from "../../lib/onboarding";
import {
  ENV_META,
  ENV_ORDER,
  getMinDriverMajorForCuda,
  isDriverSufficientForProfile,
  NVIDIA_DRIVERS_URL,
} from "../../lib/foundry_constants";
import { useSetupPathsActions } from "../../hooks/useSetupPathsActions";
import { useTauriListen } from "../../hooks/useTauriListen";
import FoundryToolchainPanel from "../FoundryToolchainPanel";
import type { FitScanComplete, FitScanProgress } from "../../lib/types";

const DEFAULT_FIT_PROVIDER = "ggml-master";

type FitScanStep = "idle" | "running" | "done" | "skipped" | "stopped";
type FitScanParallel = (typeof FIT_SCAN_PARALLEL_OPTIONS)[number];

interface SetupGuideDisplayProps {
  phase: SetupPhase;
  pathsDone: boolean;
  runtimeReady: boolean;
  toolchainChecked: boolean;
  modelsDeferred: boolean;
  metaDone: boolean;
  metaScanFailed: number;
  modelsCount: number;
  scannedCount: number;
  catalogLoaded: boolean;
  onDeferModels: () => void;
  onDismiss: () => void;
}

interface ChecklistItemProps {
  done: boolean;
  current: boolean;
  title: string;
  detail: string;
  optional?: boolean;
  accent?: "green" | "cyan" | "amber";
}

function ChecklistItem({ done, current, title, detail, optional, accent = "green" }: ChecklistItemProps) {
  const stateClass = done
    ? "setup-checklist__item--done"
    : current
      ? `setup-checklist__item--current setup-checklist__item--accent-${accent}`
      : "";
  return (
    <li className={`setup-checklist__item ${stateClass}`}>
      <span className="setup-checklist__mark" aria-hidden="true">
        {done ? "✓" : current ? "▶" : "○"}
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
  runtimeReady,
  toolchainChecked,
  modelsDeferred,
  metaDone,
  metaScanFailed,
  modelsCount,
  scannedCount,
  catalogLoaded,
  onDeferModels,
  onDismiss,
}: SetupGuideDisplayProps) {
  const {
    migrating,
    browsing,
    actionError,
    needsBrowse,
    lmStudioDefaultPath,
    openPaths,
    browseModelLibrary,
    migrateFromLmStudio,
    clearActionError,
    reportActionError,
  } = useSetupPathsActions();

  const [fitStep, setFitStep] = useState<FitScanStep>("idle");
  const [fitRunning, setFitRunning] = useState(false);
  const [showFitScanMenu, setShowFitScanMenu] = useState(false);
  const [driversConfirmed, setDriversConfirmed] = useState(false);
  const [showDriversStep, setShowDriversStep] = useState(false);
  const [driverVersion, setDriverVersion] = useState<string | null>(null);
  const [driverLoading, setDriverLoading] = useState(false);
  /** User hit STOP — don't let the in-flight invoke resolve reset the step to idle. */
  const fitStopRequestedRef = useRef(false);

  const fitDone = fitStep === "done" || fitStep === "skipped" || fitStep === "stopped";
  const driversStepActive = showDriversStep || (metaDone && fitDone);
  const frontierDriverOk = isDriverSufficientForProfile(driverVersion, ENV_META.frontier.cuda);
  const driverNeedsAck = !frontierDriverOk;

  const driverChecklistDetail = useMemo(() => {
    // Until the wizard actually reaches the driver row, keep it a neutral placeholder.
    // The verbose detect/confirm message only appears once we're checking that step.
    if (!driversStepActive) return "Verify your NVIDIA drivers before using CUDA engines";
    if (driverLoading) return "Checking NVIDIA driver via nvidia-smi…";
    if (!driverVersion) return "Could not detect driver — confirm manually or install from NVIDIA";
    if (frontierDriverOk) {
      return `Driver ${driverVersion} — OK for FRONTIER (CUDA ${ENV_META.frontier.cuda})`;
    }
    return `Driver ${driverVersion} — below minimum for FRONTIER (need ${getMinDriverMajorForCuda(ENV_META.frontier.cuda)}+)`;
  }, [driverLoading, driverVersion, frontierDriverOk, driversStepActive]);

  useEffect(() => {
    if (!metaDone) {
      setShowDriversStep(false);
      setFitStep("idle");
      setDriversConfirmed(false);
      setDriverVersion(null);
      setDriverLoading(false);
    }
  }, [metaDone]);

  useEffect(() => {
    if (!driversStepActive) return;
    let mounted = true;
    setDriverLoading(true);
    void invoke<string | null>("get_nvidia_driver_version")
      .then((v) => {
        if (mounted) setDriverVersion(v ?? null);
      })
      .catch(() => {
        if (mounted) setDriverVersion(null);
      })
      .finally(() => {
        if (mounted) setDriverLoading(false);
      });
    return () => {
      mounted = false;
    };
  }, [driversStepActive]);

  useEffect(() => {
    if (frontierDriverOk) {
      setDriversConfirmed(true);
    } else if (driverVersion != null) {
      setDriversConfirmed(false);
    }
  }, [frontierDriverOk, driverVersion]);

  const skipFitScan = useCallback(() => {
    fitStopRequestedRef.current = false;
    setFitStep("skipped");
    setShowDriversStep(true);
  }, []);

  const stopFitScan = useCallback(() => {
    fitStopRequestedRef.current = true;
    void invoke("fit_stop_scan").catch(() => {
      // Cancel flag may already be set / scan already finishing.
    });
    setFitStep("stopped");
    setShowDriversStep(true);
  }, []);

  const runFitScan = useCallback(async (parallel: FitScanParallel) => {
    fitStopRequestedRef.current = false;
    setShowFitScanMenu(false);
    setFitRunning(true);
    setFitStep("running");
    clearActionError();

    void invoke("emit_to_blackwell_console", {
      category: "utils",
      content: `[FIT-SCAN] Starting library VRAM fit scan (${DEFAULT_FIT_PROVIDER}, ${parallel}x parallel)…`,
      style: "Normal",
    });

    try {
      await invoke<FitScanComplete>("fit_scan_library", {
        providerId: DEFAULT_FIT_PROVIDER,
        modelBase: "",
        parallelCount: parallel,
        batch: 2048,
        ubatch: 512,
        forceRescan: false,
      });

      // STOP may have advanced the wizard already — don't clobber that.
      if (fitStopRequestedRef.current) {
        setFitStep("stopped");
      } else {
        setFitStep("done");
      }
      setShowDriversStep(true);
    } catch (err) {
      if (fitStopRequestedRef.current) {
        setFitStep("stopped");
        setShowDriversStep(true);
      } else {
        const msg = typeof err === "string" ? err : "VRAM fit scan failed.";
        reportActionError(msg);
        setFitStep("idle");
        void invoke("emit_to_blackwell_console", {
          category: "error",
          content: `[FIT-SCAN] ${msg}`,
          style: "Error",
        });
      }
    } finally {
      setFitRunning(false);
      fitStopRequestedRef.current = false;
    }
  }, [clearActionError, reportActionError]);

  useTauriListen<FitScanProgress>("fit-scan-progress", (evt) => {
    if (!evt?.model_path || evt.status === "error") return;
    void invoke("emit_to_blackwell_console", {
      category: "utils",
      content: `[FIT-SCAN] ${evt.model_path} | ${evt.status} | ${evt.label || ""} | ${
        evt.vram_mib != null ? `${evt.vram_mib} MiB` : ""
      }`,
      style: evt.status === "complete" ? "Success" : "Normal",
    });
  }, []);

  const scanStepApplicable = modelsCount > 0 && !modelsDeferred;
  // FIT row is only "current" once the wizard has actually reached the fit-scan phase.
  // metaDone alone can be true early (e.g. no models yet), which would wrongly show the chevron
  // on the first screen next to LINK YOUR MODEL LIBRARY.
  const fitCurrent = phase === "fit-scan" && metaDone && !fitDone && !showDriversStep;
  const toolchainStepDone = runtimeReady;
  const toolchainStepCurrent = phase === "toolchain";
  const canScanMeta = runtimeReady;
  const metaStepActive = phase === "scan-meta" && !metaDone && canScanMeta;

  const handleDeferModels = useCallback(() => {
    onDeferModels();
    clearActionError();
  }, [onDeferModels, clearActionError]);

  return (
    <div className="setup-guide">
      {/* Header row */}
      <div className="setup-guide__header">
        <span className="setup-guide__title">FORECAST: setup</span>
        <span className="setup-guide__eyebrow">Quick start checklist</span>
      </div>

      <ul className="setup-checklist">
        <ChecklistItem
          done={pathsDone}
          current={phase === "paths"}
          title="Link your model library"
          detail={
            modelsDeferred
              ? "Skipped — use MODEL HUB (nav stays open during setup)"
              : "LM Studio one-click, BROWSE, or CONFIG → PATHS"
          }
        />
        <ChecklistItem
          done={toolchainStepDone}
          current={toolchainStepCurrent}
          title="CUDA runtime"
          detail="Portable toolkit — engines, metadata scan, and build-from-source"
        />
        {scanStepApplicable && (
          <ChecklistItem
            done={metaDone}
            current={metaStepActive}
            accent="cyan"
            title="Scan your models"
            detail={
              metaScanFailed > 0
                ? `Metadata for ${scannedCount}/${modelsCount} models (${metaScanFailed} failed)`
                : `Metadata for ${scannedCount}/${modelsCount} models — powers the VRAM forecast`
            }
          />
        )}
        <ChecklistItem
          done={fitDone}
          current={fitCurrent}
          optional
          title="VRAM fit scan"
          detail="Measured VRAM per model — runs in background, logs to Output Console"
        />
        <ChecklistItem
          done={driversConfirmed}
          current={driversStepActive && toolchainStepDone && !driversConfirmed}
          title="NVIDIA driver check"
          detail={driverChecklistDetail}
        />
      </ul>

      {actionError && (
        <p className="setup-guide__note setup-guide__note--error">{actionError}</p>
      )}

      {needsBrowse && phase === "paths" && (
        <p className="setup-guide__note setup-guide__note--muted">
          Default LM Studio path missing or empty. Browse to the folder where your GGUF models live.
        </p>
      )}

      {phase === "toolchain" && !toolchainStepDone && (
        <p className="setup-guide__note setup-guide__note--amber">
          Portable CUDA runtime is required. Download it, or drop the archive in the cache folder and
          install from cache. 
        </p>
      )}

      {metaStepActive && (
        <p className="setup-guide__note setup-guide__note--cyan">
          {modelsCount} models loaded — scan them below to power the VRAM forecast.
        </p>
      )}

      {metaScanFailed > 0 && metaDone && (
        <p className="setup-guide__note setup-guide__note--amber">
          {metaScanFailed} model{metaScanFailed !== 1 ? "s" : ""} could not be parsed (corrupt or
          unrecognized GGUF) — skipped. Fix or remove those files later in CATALOG.
        </p>
      )}

      <div className="setup-guide__actions">
        {phase === "paths" && !catalogLoaded && (
          <p className="setup-guide__note setup-guide__note--muted">Loading model catalog…</p>
        )}

        {phase === "paths" && catalogLoaded && (
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
              className="setup-guide__btn setup-guide__btn--cyan"
            >
              {migrating ? "LINKING…" : "MIGRATE FROM LM STUDIO"}
            </button>
            <button
              type="button"
              onClick={() => void browseModelLibrary()}
              disabled={migrating || browsing}
              className={`setup-guide__btn ${
                needsBrowse ? "setup-guide__btn--primary" : "setup-guide__btn--neutral"
              }`}
            >
              {browsing ? "BROWSING…" : "BROWSE FOR MODEL PATH"}
            </button>
            <button
              type="button"
              onClick={openPaths}
              disabled={migrating || browsing}
              className="setup-guide__btn setup-guide__btn--green"
            >
              OPEN PATHS
            </button>
            {modelsCount === 0 && needsBrowse && (
              <button
                type="button"
                onClick={handleDeferModels}
                disabled={migrating || browsing}
                className="setup-guide__btn setup-guide__btn--neutral"
              >
                I&apos;LL DOWNLOAD LATER
              </button>
            )}
          </>
        )}

        {phase === "toolchain" && !toolchainStepDone && (
          <>
            {!toolchainChecked ? (
              <p className="setup-guide__note setup-guide__note--muted">
                Checking portable toolchain…
              </p>
            ) : (
              <div className="setup-guide__block">
                <FoundryToolchainPanel onboarding />
              </div>
            )}
          </>
        )}

        {metaStepActive && (
          <p className="setup-guide__note setup-guide__note--cyan setup-guide__note--scan-hint">
            Scan in progress? Use <span className="setup-guide__btn-inline-label">SCAN META</span> in
            the catalog — it pulses while setup is active.
          </p>
        )}

        {phase === "fit-scan" && !fitDone && !showDriversStep && (
          <>
            {fitRunning ? (
              <div className="setup-guide__fit-row">
                <button
                  type="button"
                  disabled
                  className="setup-guide__btn setup-guide__btn--green setup-guide__btn--running"
                >
                  FIT SCAN RUNNING…
                </button>
                <button
                  type="button"
                  onClick={stopFitScan}
                  className="setup-guide__btn setup-guide__btn--danger"
                  title="Stop the running VRAM fit scan"
                >
                  STOP
                </button>
              </div>
            ) : showFitScanMenu ? (
              <div className="setup-guide__fit-row">
                {FIT_SCAN_PARALLEL_OPTIONS.map((parallel) => (
                  <button
                    key={parallel}
                    type="button"
                    onClick={() => void runFitScan(parallel)}
                    className="setup-guide__btn setup-guide__btn--primary"
                    title={`VRAM fit scan with ${parallel}x parallelism`}
                  >
                    SPEED {parallel}×
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setShowFitScanMenu(false)}
                  className="setup-guide__btn setup-guide__btn--neutral"
                >
                  CANCEL
                </button>
              </div>
            ) : (
              <div className="setup-guide__fit-row">
                <button
                  type="button"
                  onClick={() => setShowFitScanMenu(true)}
                  className="setup-guide__btn setup-guide__btn--primary"
                >
                  RUN VRAM FIT SCAN ▾
                </button>
                <button
                  type="button"
                  onClick={skipFitScan}
                  disabled={fitRunning}
                  className="setup-guide__btn setup-guide__btn--neutral"
                >
                  SKIP
                </button>
              </div>
            )}
          </>
        )}

        {driversStepActive && (!scanStepApplicable || toolchainStepDone) && (
          <div className="setup-driver-check">
            {driverLoading ? (
              <p className="setup-guide__note setup-guide__note--muted">
                Checking NVIDIA driver…
              </p>
            ) : (
              <>
                <p className="setup-guide__note setup-guide__note--muted">
                  Detected:{" "}
                  <span
                    className={
                      frontierDriverOk
                        ? "setup-driver-check__ok"
                        : driverVersion
                          ? "setup-driver-check__bad"
                          : "setup-driver-check__warn"
                    }
                  >
                    {driverVersion ?? "not found (nvidia-smi)"}
                  </span>
                </p>
                <ul className="setup-driver-check__list">
                  {ENV_ORDER.map((profile) => {
                    const meta = ENV_META[profile];
                    const minMajor = getMinDriverMajorForCuda(meta.cuda);
                    const ok = isDriverSufficientForProfile(driverVersion, meta.cuda);
                    return (
                      <li
                        key={profile}
                        className={`setup-driver-check__row ${
                          ok ? "setup-driver-check__ok" : "setup-driver-check__bad"
                        }`}
                      >
                        {meta.label} · CUDA {meta.cuda} · min driver {minMajor}+ —{" "}
                        {driverVersion ? (ok ? "OK" : "TOO OLD") : "unknown"}
                      </li>
                    );
                  })}
                </ul>
                {driverNeedsAck && (
                  <>
                    <button
                      type="button"
                      onClick={() => void open(NVIDIA_DRIVERS_URL)}
                      className="setup-guide__link"
                    >
                      Download drivers at nvidia.com
                    </button>
                    <label className="setup-driver-check__ack">
                      <input
                        type="checkbox"
                        checked={driversConfirmed}
                        onChange={(e) => setDriversConfirmed(e.target.checked)}
                        className="setup-checklist__checkbox"
                      />
                      I will update NVIDIA drivers before using CUDA engines
                    </label>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {driversStepActive && (
          <button
            type="button"
            onClick={onDismiss}
            disabled={!driversConfirmed || !runtimeReady}
            title={
              !runtimeReady
                ? "Install the portable toolchain before finishing setup"
                : !driversConfirmed
                  ? "Confirm NVIDIA drivers first"
                  : "Complete first-run setup"
            }
            className="setup-guide__btn setup-guide__btn--primary setup-guide__btn--finish"
          >
            FINISH SETUP
          </button>
        )}
      </div>
    </div>
  );
}
