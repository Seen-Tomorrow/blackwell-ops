/**
 * Harness connect — pi status, project, agents, OPEN.
 * Catalog assigns seats; this panel only binds and launches pi.
 */
import { invoke } from "@tauri-apps/api/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { isDevBuild } from "../lib/build";
import {
  bindingReadyToOpen,
  engineParallel,
  type HarnessBinding,
} from "../lib/harnessBinding";
import { CODING_MODE_OPTIONS } from "../lib/multiAgentBooster";
import {
  PI_CODE_DISCLAIMER,
  type PiCodeStatus,
  type PiLaunchRequest,
  type PiLaunchResult,
} from "../lib/piCode";
import { KEYS, readStorage, writeStorage } from "../lib/storage";
import type { StackEntry } from "../lib/types";

export type InstallPhase = "download" | "verify" | "extract" | "finalize";

const INSTALL_PHASES: ReadonlyArray<{ id: InstallPhase; label: string; weight: number }> = [
  { id: "download", label: "Downloading", weight: 70 },
  { id: "verify", label: "Verifying", weight: 10 },
  { id: "extract", label: "Extracting", weight: 15 },
  { id: "finalize", label: "Finalizing", weight: 5 },
];

const INSTALL_PHASE_LABEL: Record<InstallPhase, string> = {
  download: "Downloading tool…",
  verify: "Verifying checksum…",
  extract: "Extracting archive…",
  finalize: "Finalizing install…",
};

function normalizeError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? raw;
  return firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine;
}

function refFromEntry(e: StackEntry) {
  const alias = (e.alias || "").trim() || "local-model";
  return {
    port: e.port,
    model: alias,
    contextWindow: e.n_ctx && e.n_ctx > 0 ? e.n_ctx : undefined,
    parallel: engineParallel(e),
    vision: Boolean(e.vision),
    displayId: `${alias} :${e.port}`,
    modelName: e.model_name || alias,
  };
}

function projectBasename(path: string | null | undefined): string {
  if (!path) return "";
  const parts = path.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || path;
}

export type HarnessConnectPanelProps = {
  binding: HarnessBinding;
  onDismiss?: () => void;
  onRelaunchSeat?: (opts: {
    slotIdx: number;
    port: number;
    alias: string;
    parallel: number;
  }) => Promise<void>;
  onSelectEngine?: (slotIdx: number) => void;
  onLaunched?: () => void;
  className?: string;
};

export default function HarnessConnectPanel({
  binding,
  onDismiss,
  onRelaunchSeat,
  onSelectEngine,
  onLaunched,
  className = "",
}: HarnessConnectPanelProps) {
  const [piStatus, setPiStatus] = useState<PiCodeStatus | null>(null);
  const [piUpdating, setPiUpdating] = useState(false);
  const [harnessBusy, setHarnessBusy] = useState<"idle" | "install" | "launch">("idle");
  const [harnessError, setHarnessError] = useState<string | null>(null);
  const [harnessMsg, setHarnessMsg] = useState<string | null>(null);
  const [installPhase, setInstallPhase] = useState<InstallPhase | null>(null);
  const [installTick, setInstallTick] = useState(0);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  const [confirmMode, setConfirmMode] = useState<"solo" | "brain_workers" | null>(null);
  const [relaunchBusy, setRelaunchBusy] = useState(false);
  const [piConsolePids, setPiConsolePids] = useState<number[] | null>(null);
  const [piElevated, setPiElevated] = useState(
    () => readStorage(KEYS.piCodeElevated) === "1",
  );

  const seedParallel = useMemo(() => {
    if (binding.mode === "twin" && binding.worker) return engineParallel(binding.worker);
    if (binding.brain) return engineParallel(binding.brain);
    return 1;
  }, [binding]);

  const [harnessAgents, setHarnessAgents] = useState(seedParallel);
  useEffect(() => {
    setHarnessAgents(seedParallel);
  }, [seedParallel]);

  const agentsN = Math.max(1, harnessAgents);

  const refreshPiStatus = useCallback(async () => {
    try {
      const s = await invoke<PiCodeStatus>("pi_code_status");
      setPiStatus(s);
      return s;
    } catch (e) {
      setHarnessError(normalizeError(e));
      return null;
    }
  }, []);

  useEffect(() => {
    void refreshPiStatus();
  }, [refreshPiStatus]);

  useEffect(() => {
    if (!harnessMsg) return;
    const t = window.setTimeout(() => setHarnessMsg(null), 4000);
    return () => window.clearTimeout(t);
  }, [harnessMsg]);

  useEffect(() => {
    if (installPhase == null) return;
    const id = window.setInterval(() => setInstallTick((t) => (t + 1) % 1000), 160);
    return () => window.clearInterval(id);
  }, [installPhase]);

  useEffect(() => {
    if (!confirmMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && harnessBusy === "idle") setConfirmMode(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmMode, harnessBusy]);

  const pickProjectDir = useCallback(async (): Promise<string | null> => {
    return invoke<string | null>("open_folder_dialog", {
      title: "Harness project folder",
    });
  }, []);

  const changeProjectDir = useCallback(async () => {
    const picked = await pickProjectDir();
    if (!picked) return;
    try {
      const s = await invoke<PiCodeStatus>("pi_code_set_project", {
        projectDir: picked,
      });
      setPiStatus(s);
      setHarnessMsg(`Project: ${picked}`);
    } catch (e) {
      setHarnessError(normalizeError(e));
    }
  }, [pickProjectDir]);

  const ensurePiInstalled = useCallback(async (): Promise<PiCodeStatus | null> => {
    setHarnessError(null);
    let s = piStatus ?? (await refreshPiStatus());
    if (!s) return null;
    if (!s.disclaimerAccepted) {
      setShowDisclaimer(true);
      return null;
    }
    if (!s.installed) {
      setHarnessBusy("install");
      setInstallPhase("download");
      setHarnessMsg(`Downloading pi ${s.pinnedVersion} (~46 MB standalone)…`);
      try {
        setInstallPhase("verify");
        s = await invoke<PiCodeStatus>("pi_code_install", { version: null });
        setInstallPhase("finalize");
        setPiStatus(s);
        setHarnessMsg(`Installed pi ${s.version ?? s.pinnedVersion}`);
      } catch (e) {
        setHarnessError(normalizeError(e));
        setHarnessBusy("idle");
        setInstallPhase(null);
        return null;
      }
      setHarnessBusy("idle");
      setInstallPhase(null);
    }
    return s;
  }, [piStatus, refreshPiStatus]);

  const updatePiToLatest = useCallback(async () => {
    if (piUpdating) return;
    setHarnessError(null);
    setHarnessMsg(null);
    try {
      const pids = await invoke<number[]>("pi_code_console_running");
      if (pids.length > 0) {
        setPiConsolePids(pids);
        return;
      }
    } catch {
      /* backend guard */
    }
    setPiConsolePids(null);
    setPiUpdating(true);
    setInstallPhase("download");
    try {
      setInstallPhase("verify");
      const s = await invoke<PiCodeStatus>("pi_code_update_latest");
      setInstallPhase("finalize");
      setPiStatus(s);
      setHarnessMsg(
        `pi updated to ${s.version ?? s.pinnedVersion} + pi-subagents refreshed`,
      );
    } catch (e) {
      setHarnessError(normalizeError(e));
    } finally {
      setPiUpdating(false);
      setInstallPhase(null);
    }
  }, [piUpdating]);

  const confirmUpdatePi = useCallback(async () => {
    setPiConsolePids(null);
    await updatePiToLatest();
  }, [updatePiToLatest]);

  const executeHarnessLaunch = useCallback(
    async (mode: "solo" | "brain_workers") => {
      setHarnessError(null);
      setHarnessMsg(null);
      if (!bindingReadyToOpen(binding)) {
        setHarnessError(
          mode === "solo"
            ? "Start an engine (Running) before opening the harness."
            : "Twin needs two Running engines on different ports.",
        );
        return;
      }
      const brain = binding.brain!;
      const worker = mode === "brain_workers" ? binding.worker! : null;

      let projectDir: string | null | undefined = piStatus?.lastProject;
      {
        const s = await ensurePiInstalled();
        if (!s) return;
        projectDir = s.lastProject;
      }
      if (!projectDir) {
        projectDir = await pickProjectDir();
        if (!projectDir) {
          setHarnessError("Pick a project folder to continue.");
          return;
        }
      }

      const primary = refFromEntry(brain);
      const workerRef = worker ? refFromEntry(worker) : undefined;

      setHarnessBusy("launch");
      try {
        const req: PiLaunchRequest = {
          mode,
          primary: {
            port: primary.port,
            model: primary.model,
            contextWindow: primary.contextWindow,
            parallel: primary.parallel,
            vision: primary.vision,
          },
          worker: workerRef
            ? {
                port: workerRef.port,
                model: workerRef.model,
                contextWindow: workerRef.contextWindow,
                parallel: workerRef.parallel,
                vision: workerRef.vision,
              }
            : undefined,
          projectDir,
          elevated: piElevated,
        };
        const result = await invoke<PiLaunchResult>("pi_code_launch", {
          request: req,
        });
        const elev = result.elevated || piElevated ? " · elevated" : "";
        setHarnessMsg(
          `Opened pi (${result.mode}${elev}) → :${primary.port}` +
            (workerRef ? ` + worker :${workerRef.port}` : ""),
        );
        void refreshPiStatus();
        setConfirmMode(null);
        onSelectEngine?.(brain.idx);
        onLaunched?.();
      } catch (e) {
        setHarnessError(normalizeError(e));
        setConfirmMode(null);
      } finally {
        setHarnessBusy("idle");
      }
    },
    [
      binding,
      piStatus?.lastProject,
      ensurePiInstalled,
      pickProjectDir,
      piElevated,
      refreshPiStatus,
      onSelectEngine,
      onLaunched,
    ],
  );

  const requestHarnessOpen = useCallback(
    (mode: "solo" | "brain_workers") => {
      setHarnessError(null);
      setHarnessMsg(null);
      if (!bindingReadyToOpen(binding)) {
        setHarnessError(
          mode === "solo"
            ? "Wait until the engine is Running."
            : "Wait until BRAIN + WORKER are both Running.",
        );
        return;
      }
      if (piStatus && !piStatus.disclaimerAccepted) {
        setShowDisclaimer(true);
        setConfirmMode(mode);
        return;
      }
      setConfirmMode(mode);
    },
    [binding, piStatus],
  );

  const acceptDisclaimerAndInstall = useCallback(async () => {
    setHarnessError(null);
    try {
      await invoke("pi_code_accept_disclaimer");
      setShowDisclaimer(false);
      setHarnessBusy("install");
      setInstallPhase("download");
      setHarnessMsg("Downloading pi standalone (~46 MB)…");
      setInstallPhase("verify");
      const s = await invoke<PiCodeStatus>("pi_code_install", { version: null });
      setInstallPhase("finalize");
      setPiStatus(s);
      setHarnessMsg(`Installed pi ${s.version ?? s.pinnedVersion}`);
      void refreshPiStatus();
    } catch (e) {
      setHarnessError(normalizeError(e));
    } finally {
      setHarnessBusy("idle");
      setInstallPhase(null);
    }
  }, [refreshPiStatus]);

  const relaunchTarget =
    binding.mode === "twin" && binding.worker
      ? binding.worker
      : binding.brain;

  const workerEngineParallel = engineParallel(
    binding.mode === "twin" ? binding.worker : binding.brain,
  );
  const needsEngineParallelBump = agentsN > 1 && workerEngineParallel < agentsN;

  const doRelaunchSeat = useCallback(async () => {
    if (!onRelaunchSeat || !relaunchTarget) return;
    setRelaunchBusy(true);
    setHarnessError(null);
    try {
      await onRelaunchSeat({
        slotIdx: relaunchTarget.idx,
        port: relaunchTarget.port,
        alias: relaunchTarget.alias,
        parallel: agentsN,
      });
      setHarnessMsg(
        `Relaunching ${relaunchTarget.alias} on :${relaunchTarget.port} with parallel ×${agentsN}…`,
      );
    } catch (e) {
      setHarnessError(normalizeError(e));
    } finally {
      setRelaunchBusy(false);
    }
  }, [onRelaunchSeat, relaunchTarget, agentsN]);

  const canLaunch = bindingReadyToOpen(binding) && !showDisclaimer && harnessBusy === "idle";
  const launchMode: "solo" | "brain_workers" | null =
    binding.mode === "solo"
      ? "solo"
      : binding.mode === "twin"
        ? "brain_workers"
        : null;

  const phaseIdx =
    installPhase == null
      ? -1
      : INSTALL_PHASES.findIndex((p) => p.id === installPhase);
  const phaseFrac = phaseIdx < 0 ? 0 : (phaseIdx + (installTick % 20) / 20) / INSTALL_PHASES.length;

  const confirmPortal =
    confirmMode && !showDisclaimer && typeof document !== "undefined"
      ? createPortal(
          <div
            className="harness-confirm-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="harness-confirm-title"
            onClick={(e) => {
              if (e.target === e.currentTarget && harnessBusy === "idle") setConfirmMode(null);
            }}
          >
            <div className="harness-confirm-modal font-mono">
              <h3 id="harness-confirm-title" className="harness-confirm-title">
                {confirmMode === "solo" ? "Open pi — SOLO" : "Open pi — TWIN"}
              </h3>
              {piElevated && (
                <p className="harness-confirm-elevated font-mono text-[9px] text-yellow-400/90 m-0 mb-2">
                  Elevated (gsudo) — UAC prompt, then admin pi console
                </p>
              )}
              <p className="harness-confirm-summary" aria-live="polite">
                {confirmMode === "solo" && binding.brain ? (
                  <>
                    <span className="harness-confirm-summary__mode">BRAIN SOLO</span>
                    <span className="harness-confirm-summary__engine">
                      {refFromEntry(binding.brain).displayId}
                    </span>
                    <span className="harness-confirm-summary__agents">AGENTS ×{agentsN}</span>
                  </>
                ) : binding.brain && binding.worker ? (
                  <>
                    <span className="harness-confirm-summary__mode">BRAIN TWIN</span>
                    <span className="harness-confirm-summary__engine">
                      {refFromEntry(binding.brain).model} : {binding.brain.port}
                    </span>
                    <span className="harness-confirm-summary__sep">·</span>
                    <span className="harness-confirm-summary__engine harness-confirm-summary__engine--worker">
                      WORKER {refFromEntry(binding.worker).model} : {binding.worker.port}
                    </span>
                    <span className="harness-confirm-summary__agents">AGENTS ×{agentsN}</span>
                  </>
                ) : (
                  <span className="harness-confirm-summary__mode">Not ready</span>
                )}
              </p>
              <p className="harness-confirm-path" title={piStatus?.lastProject ?? undefined}>
                <span className="harness-confirm-path__label">Project</span>
                {piStatus?.lastProject || "(pick on confirm if unset)"}
              </p>
              <div className="harness-confirm-actions">
                <button
                  type="button"
                  className="harness-launch-btn harness-launch-btn--solo font-mono tracking-wider uppercase"
                  disabled={harnessBusy !== "idle"}
                  onClick={() => void executeHarnessLaunch(confirmMode)}
                >
                  {harnessBusy === "install"
                    ? "Installing…"
                    : harnessBusy === "launch"
                      ? "Launching…"
                      : "Confirm & open"}
                </button>
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono"
                  disabled={harnessBusy !== "idle"}
                  onClick={() => setConfirmMode(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono"
                  disabled={harnessBusy !== "idle"}
                  onClick={() => void changeProjectDir()}
                >
                  Change project…
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const closePiFirstPortal =
    piConsolePids && typeof document !== "undefined"
      ? createPortal(
          <div
            className="harness-confirm-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="pi-close-first-title"
            onClick={(e) => {
              if (e.target === e.currentTarget) setPiConsolePids(null);
            }}
          >
            <div className="harness-confirm-modal font-mono">
              <h3 id="pi-close-first-title" className="harness-confirm-title">
                Close pi before updating
              </h3>
              <p className="harness-confirm-summary" aria-live="polite">
                <span className="harness-confirm-summary__mode">PI CONSOLE RUNNING</span>
                <span className="harness-confirm-summary__agents">
                  PID {piConsolePids.join(", ")}
                </span>
              </p>
              <p className="harness-confirm-elevated font-mono text-[9px] text-yellow-400/90 m-0 mb-2">
                Close the pi console window before updating the package tree.
              </p>
              <div className="harness-confirm-actions">
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono"
                  onClick={() => setPiConsolePids(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono"
                  onClick={() => void confirmUpdatePi()}
                >
                  I have closed it — update
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const disclaimerBlock = showDisclaimer ? (
    <div className="harness-connect__disclaimer font-mono">
      <p className="harness-connect__disclaimer-title m-0 mb-1">pi disclaimer</p>
      <pre className="harness-connect__disclaimer-body m-0 mb-2 whitespace-pre-wrap">
        {PI_CODE_DISCLAIMER}
      </pre>
      <button
        type="button"
        className="harness-launch-btn harness-launch-btn--solo font-mono tracking-wider uppercase"
        disabled={harnessBusy !== "idle"}
        onClick={() => void acceptDisclaimerAndInstall()}
      >
        Accept & install (~46 MB)
      </button>
    </div>
  ) : null;

  return (
    <div
      className={`harness-connect harness-connect--veil font-mono ${className}`}
      data-harness-connect="veil"
      data-harness-mode={binding.mode}
    >
      {confirmPortal}
      {closePiFirstPortal}

      <header className="harness-connect__header">
        <div className="harness-connect__title-row">
          <span className="harness-connect__title tracking-[0.16em] uppercase">
            Harness connect
          </span>
          <span className="harness-connect__pi-chip" title={piStatus?.launcherPath ?? undefined}>
            {piStatus?.installed
              ? `pi ${piStatus.version ?? piStatus.pinnedVersion ?? "ok"}`
              : "~46 MB on first open"}
          </span>
          {isDevBuild() ? (
            <button
              type="button"
              className="harness-connect__dev-btn"
              disabled={piUpdating || harnessBusy !== "idle"}
              onClick={() => void updatePiToLatest()}
              title="DEV: update pi + pi-ext to latest"
            >
              {piUpdating ? "UPDATING…" : "UPDATE"}
            </button>
          ) : null}
          {onDismiss ? (
            <button
              type="button"
              className="harness-connect__dismiss harness-connect__dismiss--stop"
              onClick={onDismiss}
              title="Close harness connect"
            >
              ✕
            </button>
          ) : null}
        </div>
        {installPhase != null ? (
          <div className="harness-connect__phase" aria-live="polite">
            <div className="harness-connect__phase-labels">
              {INSTALL_PHASES.map((p) => (
                <span
                  key={p.id}
                  className={
                    p.id === installPhase
                      ? "harness-connect__phase-label harness-connect__phase-label--on"
                      : "harness-connect__phase-label"
                  }
                >
                  {p.label}
                </span>
              ))}
            </div>
            <div className="harness-connect__phase-bar" aria-hidden>
              <div
                className="harness-connect__phase-bar-fill"
                style={{ width: `${Math.min(98, Math.max(6, phaseFrac * 100))}%` }}
              />
            </div>
            <span className="harness-connect__phase-msg">
              {INSTALL_PHASE_LABEL[installPhase]}
            </span>
          </div>
        ) : null}
      </header>

      {disclaimerBlock}

      {binding.mode === "none" ? (
        <p className="harness-connect__empty m-0">{binding.reason ?? "Launch seats from catalog"}</p>
      ) : null}

      <div className="harness-connect__project">
        <button
          type="button"
          className="harness-connect__project-btn"
          onClick={() => void changeProjectDir()}
        >
          POINT THE AGENT
        </button>
        <span className="harness-connect__project-path" title={piStatus?.lastProject ?? undefined}>
          {piStatus?.lastProject
            ? projectBasename(piStatus.lastProject)
            : "No project — pick a folder"}
        </span>
      </div>

      <div className="harness-connect__agents" role="group" aria-label="Concurrent agents">
        <span className="harness-connect__agents-label">AGENTS</span>
        {CODING_MODE_OPTIONS.map((o) => {
          const active = o.parallel === agentsN;
          return (
            <button
              key={o.id}
              type="button"
              className={`harness-connect__agent-chip${active ? " harness-connect__agent-chip--on" : ""}`}
              title={o.blurb}
              onClick={() => setHarnessAgents(o.parallel)}
            >
              ×{o.parallel}
            </button>
          );
        })}
      </div>

      {needsEngineParallelBump && relaunchTarget && onRelaunchSeat ? (
        <div className="harness-connect__relaunch">
          <p className="harness-connect__relaunch-msg m-0">
            RESTART {binding.mode === "twin" ? "WORKER" : "BRAIN"} to match AGENTS ×{agentsN}
          </p>
          <button
            type="button"
            className="harness-connect__relaunch-btn"
            disabled={relaunchBusy}
            onClick={() => void doRelaunchSeat()}
          >
            {relaunchBusy
              ? "Restarting…"
              : `RESTART ${relaunchTarget.alias} :${relaunchTarget.port} · ×${agentsN}`}
          </button>
        </div>
      ) : null}

      <footer className="harness-connect__footer">
        <label className="harness-connect__elevated">
          <input
            type="checkbox"
            checked={piElevated}
            onChange={(e) => {
              const on = e.target.checked;
              setPiElevated(on);
              writeStorage(KEYS.piCodeElevated, on ? "1" : "0");
            }}
          />
          <span>Elevated (gsudo)</span>
        </label>
        <button
          type="button"
          className={`harness-connect__go harness-connect__go--${binding.mode}`}
          disabled={!canLaunch || launchMode == null}
          onClick={() => launchMode && requestHarnessOpen(launchMode)}
        >
          {harnessBusy === "install"
            ? "Installing…"
            : harnessBusy === "launch"
              ? "Launching…"
              : binding.mode === "twin"
                ? "Open pi · BRAIN + WORKER"
                : binding.mode === "solo"
                  ? "Open pi · SOLO"
                  : "Open pi"}
        </button>
      </footer>

      {harnessError ? (
        <p className="harness-connect__error m-0" role="alert">
          {harnessError}
        </p>
      ) : null}
      {harnessMsg ? (
        <p className="harness-connect__msg m-0" aria-live="polite">
          {harnessMsg}
        </p>
      ) : null}
    </div>
  );
}
