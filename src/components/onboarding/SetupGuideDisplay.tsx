import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import type { SetupPhase } from "../../lib/setupGuide";
import {
  ENV_META,
  ENV_ORDER,
  getMinDriverMajorForCuda,
  isDriverSufficientForProfile,
  NVIDIA_DRIVERS_URL,
} from "../../lib/foundry_constants";
import { useSetupPathsActions } from "../../hooks/useSetupPathsActions";
import FoundryToolchainPanel from "../FoundryToolchainPanel";

interface SetupGuideDisplayProps {
  phase: SetupPhase;
  pathsDone: boolean;
  runtimeReady: boolean;
  runtimeChecked: boolean;
  modelsDeferred: boolean;
  modelsCount: number;
  catalogLoaded: boolean;
  libraryLinked: boolean;
  /** `mark_setup_completed` was rejected — FINISH stays available for a retry. */
  finishError: string | null;
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

/**
 * First-run guide — two decisions, then finish.
 *
 * Deliberately short: where the models are, and the portable CUDA runtime. The
 * metadata scan and library VRAM fit scan are background passes with their own
 * header strip, so nothing here blocks on a GPU measurement. The driver row is
 * informational — an old driver warns about EDGE but never gates FINISH.
 */
export default function SetupGuideDisplay({
  phase,
  pathsDone,
  runtimeReady,
  runtimeChecked,
  modelsDeferred,
  modelsCount,
  catalogLoaded,
  libraryLinked,
  finishError,
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
  } = useSetupPathsActions();

  const [driverVersion, setDriverVersion] = useState<string | null>(null);
  const [driverLoading, setDriverLoading] = useState(false);

  const runtimeStepDone = runtimeReady;
  const runtimeStepCurrent = phase === "runtime";
  const finishStep = phase === "finish";
  const edgeDriverOk = isDriverSufficientForProfile(driverVersion, ENV_META.edge.cuda);

  useEffect(() => {
    if (!finishStep) return;
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
  }, [finishStep]);

  const driverChecklistDetail = useMemo(() => {
    if (!finishStep) return "Checked before launch — EDGE needs a current driver";
    if (driverLoading) return "Checking NVIDIA driver via nvidia-smi…";
    if (!driverVersion) return "Could not detect driver — confirm manually or install from NVIDIA";
    if (edgeDriverOk) {
      return `Driver ${driverVersion} — OK for EDGE (CUDA ${ENV_META.edge.cuda})`;
    }
    return `Driver ${driverVersion} — below EDGE minimum (need ${getMinDriverMajorForCuda(
      ENV_META.edge.cuda,
    )}+); STABLE still works`;
  }, [driverLoading, driverVersion, edgeDriverOk, finishStep]);

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
              ? "Skipped — use DOWNLOADS (nav stays open during setup)"
              : "LM Studio one-click, BROWSE, or CONFIG → PATHS"
          }
        />
        <ChecklistItem
          done={runtimeStepDone}
          current={runtimeStepCurrent}
          title="Engine runtime"
          detail={
            runtimeStepDone
              ? "Installed — the engine can launch"
              : "One download, handled here — required to run the engine"
          }
        />
        <ChecklistItem
          done={finishStep && edgeDriverOk}
          current={finishStep && !edgeDriverOk}
          accent="amber"
          optional
          title="NVIDIA driver"
          detail={driverChecklistDetail}
        />
      </ul>

      {actionError && (
        <p className="setup-guide__note setup-guide__note--error">{actionError}</p>
      )}

      {/* Folder is linked, yet nothing selectable came out of it (draft-only,
          partial shards, filtered files). Without this the step looks broken. */}
      {phase === "paths" && catalogLoaded && modelsCount === 0 && libraryLinked && (
        <p className="setup-guide__note setup-guide__note--amber">
          Library folder linked, but no launchable GGUF model was found in it. Browse to the folder
          that actually holds your models, or download one.
        </p>
      )}

      {phase === "runtime" && !runtimeStepDone && (
        <p className="setup-guide__note setup-guide__note--amber">
          The engine runtime is required for the installed engine. Download it here, or install it from cache if you already have it.
          install from cache.{" "}
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
            {/* Always offered with an empty catalog — migration can fail for
                reasons we cannot guess (custom LM Studio folder, empty folder),
                and the user must never be unable to leave this step. */}
            {modelsCount === 0 && (
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

        {phase === "runtime" && !runtimeStepDone && (
          <>
            {!runtimeChecked ? (
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

        {finishStep && (
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
                      edgeDriverOk
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
                {!edgeDriverOk && (
                  <>
                    <p className="setup-guide__note setup-guide__note--amber">
                      Update NVIDIA drivers before launching EDGE engines — STABLE works below this
                      minimum. You can finish setup now.
                    </p>
                    <button
                      type="button"
                      onClick={() => void open(NVIDIA_DRIVERS_URL)}
                      className="setup-guide__link"
                    >
                      Download drivers at nvidia.com
                    </button>
                  </>
                )}
              </>
            )}
          </div>
        )}

        {finishStep && finishError && (
          <p className="setup-guide__note setup-guide__note--error">{finishError}</p>
        )}

        {finishStep && (
          <button
            type="button"
            onClick={onDismiss}
            disabled={!runtimeReady}
            title={
              !runtimeReady
                ? "Install the engine runtime before finishing setup"
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
