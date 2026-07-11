import { useCallback, useEffect, useMemo, useState } from "react";
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
import type {
  FitScanComplete,
  FitScanProgress,
  ProviderConfig,
} from "../../lib/types";

const DEFAULT_FIT_PROVIDER = "ggml-master";

type FitScanStep = "idle" | "running" | "done" | "skipped";
type FitScanParallel = (typeof FIT_SCAN_PARALLEL_OPTIONS)[number];

interface SetupGuideDisplayProps {
  phase: SetupPhase;
  pathsDone: boolean;
  toolchainSkipped: boolean;
  runtimeReady: boolean;
  toolchainChecked: boolean;
  toolchainBusy: boolean;
  modelsDeferred: boolean;
  metaDone: boolean;
  metaScanFailed: number;
  modelsCount: number;
  scannedCount: number;
  catalogLoaded: boolean;
  onDeferModels: () => void;
  onSkipToolchain: () => void;
  onSkipMetaScan: () => void;
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
  toolchainSkipped,
  runtimeReady,
  toolchainChecked,
  toolchainBusy,
  modelsDeferred,
  metaDone,
  metaScanFailed,
  modelsCount,
  scannedCount,
  catalogLoaded,
  onDeferModels,
  onSkipToolchain,
  onSkipMetaScan,
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

  const fitDone = fitStep === "done" || fitStep === "skipped";
  const driversStepActive = showDriversStep || (metaDone && fitDone);
  const frontierDriverOk = isDriverSufficientForProfile(driverVersion, ENV_META.frontier.cuda);
  const driverNeedsAck = !frontierDriverOk;

  const driverChecklistDetail = useMemo(() => {
    if (driverLoading) return "Checking NVIDIA driver via nvidia-smi…";
    if (!driverVersion) return "Could not detect driver — confirm manually or install from NVIDIA";
    if (frontierDriverOk) {
      return `Driver ${driverVersion} — OK for FRONTIER (CUDA ${ENV_META.frontier.cuda})`;
    }
    return `Driver ${driverVersion} — below minimum for FRONTIER (need ${getMinDriverMajorForCuda(ENV_META.frontier.cuda)}+)`;
  }, [driverLoading, driverVersion, frontierDriverOk]);

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
    setFitStep("skipped");
    setShowDriversStep(true);
  }, []);

  const runFitScan = useCallback(async (parallel: FitScanParallel) => {
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
      reportActionError(msg);
      setFitStep("idle");
      void invoke("emit_to_blackwell_console", {
        category: "error",
        content: `[FIT-SCAN] ${msg}`,
        style: "Error",
      });
    } finally {
      setFitRunning(false);
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
  const fitCurrent = metaDone && !fitDone && !showDriversStep;
  const toolchainStepDone = runtimeReady;
  const toolchainStepCurrent = phase === "toolchain";
  const canScanMeta = runtimeReady;

  const handleDeferModels = useCallback(() => {
    onDeferModels();
    clearActionError();
  }, [onDeferModels, clearActionError]);

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
          detail={
            modelsDeferred
              ? "Skipped — download models later from Model Hub"
              : "LM Studio one-click or CONFIG → PATHS"
          }
        />
        <ChecklistItem
          done={toolchainStepDone}
          current={toolchainStepCurrent}
          optional={modelsDeferred || modelsCount === 0}
          title="Portable toolchain"
          detail={
            modelsDeferred || modelsCount === 0
              ? "Optional until you scan local GGUFs or run CUDA engines"
              : "Hard requirement — CUDA runtimes + Foundry auto-build engine ~1.15 GB one-time download"
          }
        />
        {scanStepApplicable && (
          <ChecklistItem
            done={metaDone}
            current={phase === "scan-meta"}
            title="Scan GGUF metadata"
            detail={
              metaScanFailed > 0
                ? `CATALOG → SCAN META (${scannedCount}/${modelsCount}, ${metaScanFailed} failed)`
                : `CATALOG → SCAN META (${scannedCount}/${modelsCount})`
            }
          />
        )}
        <ChecklistItem
          done={fitDone}
          current={fitCurrent}
          optional
          title="VRAM fit scan (29-point)"
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
        <p className="mt-3 text-[8px] font-mono text-telemetry-red">{actionError}</p>
      )}

      {needsBrowse && phase === "paths" && (
        <p className="mt-3 text-[8px] font-mono text-stealth-muted leading-relaxed">
          Default LM Studio path missing or empty. Browse to the folder where your GGUF models live.
        </p>
      )}

      {phase === "toolchain" && !toolchainStepDone && (
        <p className="mt-3 text-[8px] font-mono text-yellow-400/90 leading-relaxed">
          SCAN META needs the portable toolchain (~1.15 GB). Use Download or drop toolchain.7z in
          the cache folder and Install from cache.
        </p>
      )}

      {modelsCount > 0 && phase === "scan-meta" && canScanMeta && (
        <p className="mt-3 text-[8px] font-mono text-nv-green">
          {modelsCount} models loaded — run SCAN META next (button pulses above catalog).
        </p>
      )}

      {phase === "scan-meta" && !canScanMeta && !toolchainSkipped && (
        <p className="mt-3 text-[8px] font-mono text-yellow-400/90 leading-relaxed">
          SCAN META needs the portable toolchain — use Download or Install from cache in the
          toolchain step above.
        </p>
      )}

      {metaScanFailed > 0 && metaDone && (
        <p className="mt-3 text-[8px] font-mono text-yellow-400/90 leading-relaxed">
          {metaScanFailed} model{metaScanFailed !== 1 ? "s" : ""} could not be parsed (corrupt or
          unrecognized GGUF) — skipped for metadata. Continue setup; fix or remove those files later
          in CATALOG.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2 mt-4">
        {phase === "paths" && !catalogLoaded && (
          <p className="w-full text-[8px] font-mono text-stealth-muted/80">
            Loading model catalog…
          </p>
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
              {browsing ? "BROWSING…" : "BROWSE FOR MODEL PATH"}
            </button>
            <button
              type="button"
              onClick={openPaths}
              disabled={migrating || browsing}
              className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-nv-green/50 text-nv-green hover:bg-nv-green/10 transition-colors disabled:opacity-30"
            >
              OPEN PATHS
            </button>
            {modelsCount === 0 && needsBrowse && (
              <button
                type="button"
                onClick={handleDeferModels}
                disabled={migrating || browsing}
                className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-stealth-muted/40 text-stealth-muted hover:text-white hover:border-stealth-muted transition-colors disabled:opacity-30"
              >
                I&apos;LL DOWNLOAD LATER
              </button>
            )}
          </>
        )}

        {phase === "toolchain" && !toolchainStepDone && (
          <>
            {!toolchainChecked ? (
              <p className="w-full text-[8px] font-mono text-stealth-muted/80">
                Checking portable toolchain…
              </p>
            ) : (
              <>
                <div className="w-full mt-2 mb-1">
                  <FoundryToolchainPanel onboarding />
                </div>
                {!toolchainBusy && (
                  <button
                    type="button"
                    onClick={onSkipToolchain}
                    className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-stealth-muted/40 text-stealth-muted hover:text-white hover:border-stealth-muted transition-colors"
                  >
                    DOWNLOAD LATER
                  </button>
                )}
              </>
            )}
          </>
        )}

        {phase === "scan-meta" && !metaDone && (
          <>
            {canScanMeta ? (
              <p className="w-full text-[8px] font-mono text-nv-green leading-relaxed">
                Run SCAN META in the catalog (pulsing button above), or skip for now.
              </p>
            ) : toolchainSkipped ? (
              <p className="w-full text-[8px] font-mono text-stealth-muted leading-relaxed">
                Toolchain download was skipped — metadata scan is unavailable. Use NEXT to continue.
              </p>
            ) : null}
            <button
              type="button"
              onClick={onSkipMetaScan}
              className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-stealth-muted/40 text-stealth-muted hover:text-white hover:border-stealth-muted transition-colors"
            >
              {canScanMeta ? "SKIP SCAN" : "NEXT"}
            </button>
          </>
        )}

        {phase === "fit-scan" && !fitDone && !showDriversStep && (
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

        {driversStepActive && (!scanStepApplicable || toolchainStepDone) && (
          <div className="setup-driver-check w-full space-y-1.5">
            {driverLoading ? (
              <p className="text-[8px] font-mono text-stealth-muted/75">Checking NVIDIA driver…</p>
            ) : (
              <>
                <p className="text-[8px] font-mono text-stealth-muted/80">
                  Detected:{" "}
                  <span className={frontierDriverOk ? "text-nv-green" : driverVersion ? "text-red-400" : "text-yellow-400/90"}>
                    {driverVersion ?? "not found (nvidia-smi)"}
                  </span>
                </p>
                <ul className="space-y-0.5">
                  {ENV_ORDER.map((profile) => {
                    const meta = ENV_META[profile];
                    const minMajor = getMinDriverMajorForCuda(meta.cuda);
                    const ok = isDriverSufficientForProfile(driverVersion, meta.cuda);
                    return (
                      <li
                        key={profile}
                        className={`text-[8px] font-mono leading-snug ${
                          ok ? "text-nv-green/90" : "text-red-400"
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
                      className="text-[8px] font-mono text-telemetry-cyan hover:text-telemetry-cyan/80 underline underline-offset-2 transition-colors"
                    >
                      Download drivers at nvidia.com
                    </button>
                    <label className="flex items-center gap-2 text-[8px] font-mono text-stealth-muted cursor-pointer select-none">
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
            disabled={!driversConfirmed}
            className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-nv-green/50 text-nv-green hover:bg-nv-green/10 transition-colors disabled:opacity-30 disabled:cursor-not-allowed"
          >
            FINISH SETUP
          </button>
        )}
      </div>
    </div>
  );
}