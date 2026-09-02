/**
 * Harness connect — pi status, seats, project, agents, OPEN.
 * Catalog assigns seats; this panel only binds and launches the harness tool.
 * Tool rail reserves a second slot for a future harness (chrome stays neutral).
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
import {
  buildAgentOptions,
  CODING_MODE_OPTIONS,
} from "../lib/multiAgentBooster";
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
  /** Cockpit Agents / parallel value set (factory + user). */
  parallelValues?: (string | number)[];
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
  parallelValues,
  onDismiss,
  onRelaunchSeat,
  onSelectEngine: _onSelectEngine,
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

  /** Same option set as cockpit Agents — template parallel values (presets fill when empty). */
  const agentOptions = useMemo(() => {
    const fromCockpit = buildAgentOptions(parallelValues, {
      markNonPresetAsCustom: true,
      onlyTemplateValues: Boolean(parallelValues && parallelValues.length > 0),
    });
    if (fromCockpit.length > 0) return fromCockpit;
    return buildAgentOptions(undefined, { onlyTemplateValues: false });
  }, [parallelValues]);

  useEffect(() => {
    if (agentOptions.some((o) => o.parallel === agentsN)) return;
    const nearest = agentOptions.reduce((best, o) =>
      Math.abs(o.parallel - agentsN) < Math.abs(best.parallel - agentsN) ? o : best,
    agentOptions[0] ?? CODING_MODE_OPTIONS[0]);
    if (nearest) setHarnessAgents(nearest.parallel);
  }, [agentOptions, agentsN]);

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
            // Solo: agentsN is BRAIN concurrency. Twin: BRAIN stays lean; WORKER carries agents.
            parallel: mode === "solo" ? agentsN : Math.max(1, primary.parallel ?? 1),
            vision: primary.vision,
          },
          worker: workerRef
            ? {
                port: workerRef.port,
                model: workerRef.model,
                contextWindow: workerRef.contextWindow,
                parallel: agentsN,
                vision: workerRef.vision,
              }
            : undefined,
          projectDir,
          elevated: piElevated,
        };
        const result = await invoke<PiLaunchResult>("pi_code_launch", {
          request: req,
        });
        setHarnessMsg(
          mode === "solo"
            ? `Opened pi SOLO · AGENTS ×${agentsN} · ${result.projectDir}`
            : `Opened pi TWIN · AGENTS ×${agentsN} · ${result.projectDir}`,
        );
        setConfirmMode(null);
        onLaunched?.();
      } catch (e) {
        setHarnessError(normalizeError(e));
      } finally {
        setHarnessBusy("idle");
      }
    },
    [
      binding,
      piStatus?.lastProject,
      ensurePiInstalled,
      pickProjectDir,
      agentsN,
      piElevated,
      onLaunched,
    ],
  );

  const requestHarnessOpen = useCallback((mode: "solo" | "brain_workers") => {
    setConfirmMode(mode);
  }, []);

  const acceptDisclaimerAndInstall = useCallback(async () => {
    setHarnessError(null);
    try {
      await invoke("pi_code_accept_disclaimer");
      setShowDisclaimer(false);
      const s = await ensurePiInstalled();
      if (s) setPiStatus(s);
    } catch (e) {
      setHarnessError(normalizeError(e));
    }
  }, [ensurePiInstalled]);

  const workerEngineParallel = engineParallel(
    binding.mode === "twin" ? binding.worker : binding.brain,
  );
  const needsEngineParallelBump = agentsN > 1 && workerEngineParallel < agentsN;

  const relaunchTarget = useMemo(() => {
    const entry = binding.mode === "twin" ? binding.worker : binding.brain;
    if (!entry) return null;
    return {
      slotIdx: entry.idx,
      port: entry.port,
      alias: (entry.alias || "").trim() || "local-model",
    };
  }, [binding]);

  const doRelaunchSeat = useCallback(async () => {
    if (!onRelaunchSeat || !relaunchTarget) return;
    setRelaunchBusy(true);
    setHarnessError(null);
    try {
      await onRelaunchSeat({
        slotIdx: relaunchTarget.slotIdx,
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
                <p className="harness-confirm-elevated font-mono type-label m-0 mb-2">
                  UAC prompt — admin pi console after approval
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
              <p className="harness-confirm-elevated font-mono type-label m-0 mb-2">
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

  const modeLabel =
    binding.mode === "twin" ? "TWIN" : binding.mode === "solo" ? "SOLO" : "STANDBY";

  return (
    <div
      className={`harness-connect harness-connect--veil font-mono ${className}`}
      data-harness-connect="veil"
      data-harness-mode={binding.mode}
      data-harness-tool="pi"
    >
      {confirmPortal}
      {closePiFirstPortal}

      <header className="harness-connect__header">
        <div className="harness-connect__title-row">
          <div className="harness-connect__brand">
            <span className="harness-connect__title tracking-[0.18em] uppercase">
              Harness connect
            </span>
            <span className={`harness-connect__mode harness-connect__mode--${binding.mode}`}>
              <span className="harness-connect__mode-dot" aria-hidden />
              {modeLabel}
            </span>
          </div>
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
        <p className="harness-connect__empty m-0">
          {binding.reason ?? "Launch seats from catalog"}
        </p>
      ) : (
        <>
          <div className="harness-connect__body">
          {/* Left — bound seats (stacked) */}
          <div className="harness-connect__seats">
            {binding.brain ? (
              <div className="harness-connect__seat harness-connect__seat--brain">
                <span className="harness-connect__seat-role">
                  BRAIN
                  <span
                    className={`harness-connect__seat-status${
                      binding.brain.status === "RUNNING"
                        ? " harness-connect__seat-status--run"
                        : ""
                    }`}
                    aria-hidden
                  />
                </span>
                <span className="harness-connect__seat-meta">
                  ×{engineParallel(binding.brain)} · {binding.brain.status}
                </span>
              </div>
            ) : null}
            {binding.mode === "twin" ? (
              <div className="harness-connect__link" aria-hidden>
                <span className="harness-connect__link-line" />
              </div>
            ) : null}
            {binding.worker ? (
              <div className="harness-connect__seat harness-connect__seat--worker">
                <span className="harness-connect__seat-role">
                  WORKER
                  <span
                    className={`harness-connect__seat-status${
                      binding.worker.status === "RUNNING"
                        ? " harness-connect__seat-status--run"
                        : ""
                    }`}
                    aria-hidden
                  />
                </span>
                <span className="harness-connect__seat-meta">
                  ×{engineParallel(binding.worker)} · {binding.worker.status}
                </span>
              </div>
            ) : null}
          </div>

          {/* Right — config readout: label / value / action rows */}
          <div className="harness-connect__config">
            <div className="harness-connect__row">
              <span className="harness-connect__row-label">PROJECT</span>
              <span
                className="harness-connect__row-value"
                title={piStatus?.lastProject ?? undefined}
              >
                {piStatus?.lastProject ? piStatus.lastProject : "Pick folder for pi read/write"}
              </span>
              <button
                type="button"
                className="harness-connect__row-action"
                onClick={() => void changeProjectDir()}
              >
                {piStatus?.lastProject ? "CHANGE" : "POINT"}
              </button>
            </div>
            <div className="harness-connect__row">
              <span className="harness-connect__row-label">PI</span>
              <span
                className="harness-connect__row-value"
                title={piStatus?.launcherPath ?? undefined}
              >
                {piStatus?.installed
                  ? `pi ${piStatus.version ?? piStatus.pinnedVersion ?? "ok"}`
                  : "~46 MB first open"}
              </span>
              {isDevBuild() ? (
                <button
                  type="button"
                  className="harness-connect__row-action"
                  disabled={piUpdating || harnessBusy !== "idle"}
                  onClick={() => void updatePiToLatest()}
                  title="DEV: update pi + pi-ext to latest"
                >
                  {piUpdating ? "UPDATING…" : "UPDATE"}
                </button>
              ) : null}
            </div>
          {/* AGENTS row — right column, grouped with its chips */}
            <div className="harness-connect__row">
              <span className="harness-connect__row-label">AGENTS</span>
              <span className="harness-connect__row-value">
                ×{agentsN}
                <span
                  className={`harness-connect__row-note${
                    needsEngineParallelBump ? " harness-connect__row-note--warn" : ""
                  }`}
                >
                  {"  · engine ×"}
                  {workerEngineParallel}
                  {needsEngineParallelBump ? " · NEEDS RESTART" : " · MATCHED"}
                </span>
              </span>
              <span className="harness-connect__chips" role="group" aria-label="Concurrent agents">
                {agentOptions.map((o) => {
                  const active = o.parallel === agentsN;
                  const overEngine = o.parallel > workerEngineParallel;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      className={`harness-connect__agent-chip${
                        active ? " harness-connect__agent-chip--on" : ""
                      }${overEngine ? " harness-connect__agent-chip--over" : ""}`}
                      title={
                        overEngine
                          ? `${o.blurb} — engine has ×${workerEngineParallel}; restart seat to raise slots`
                          : o.blurb
                      }
                      onClick={() => setHarnessAgents(o.parallel)}
                    >
                      ×{o.parallel}
                    </button>
                  );
                })}
              </span>
            </div>
            {needsEngineParallelBump && relaunchTarget && onRelaunchSeat ? (
              <div className="harness-connect__relaunch">
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
            </div>
          </div>

          {/* Launch row — full width, pinned to the bottom */}
            <div className="harness-connect__launch-row">
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
              <span>Admin (UAC prompt)</span>
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
                      ? `Open pi · TWIN · ×${agentsN}`
                      : binding.mode === "solo"
                        ? `Open pi · SOLO · ×${agentsN}`
                        : "Open pi"}
              </button>
            </div>
        </>
      )}

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
