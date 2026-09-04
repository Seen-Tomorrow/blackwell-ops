import { useState, useCallback, useEffect, useRef, type MutableRefObject } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProviderConfig } from "../lib/types";
import { profileEnvLookup } from "../lib/types";
import { useFoundry, type FoundryStatusPayload } from "../hooks/useBuildDock";
import { dispatchAppEvent, EVENTS } from "../lib/events";

interface StackEngineStatus {
  alias: string;
  provider_type: string;
  provider_name?: string;
  status: string;
  gpu?: string;
  binaryProfile?: string;
}
import FoundryConfirmForm from "./FoundryConfirmForm";
import FoundryBuildProgress from "./FoundryBuildProgress";
import FoundryWindowShell from "./FoundryWindowShell";
import {
  DEFAULT_FOUNDRY_CMAKE_BASE,
  mergeBuildProfileWithArchitectures,
  resolveSelectedCudaArchitectures,
  stripCudaArchitecturesFromCmake,
} from "../lib/cudaArchUtils";

function splitFoundryBuildProfile(raw: string): { base: string; archCodes: string[] } {
  const trimmed = raw.trim();
  const archCodes = resolveSelectedCudaArchitectures(trimmed);
  const base = stripCudaArchitecturesFromCmake(trimmed) || DEFAULT_FOUNDRY_CMAKE_BASE;
  return { base, archCodes };
}

interface FoundryModalProps {
  provider: ProviderConfig;
  environment: "frontier" | "stable";
  onClose: () => void;
  onComplete?: (providerId: string) => void;
  visible: boolean;
  onMinimize?: () => void;
  // When this key changes (even for the same provider), React will remount the component,
  // guaranteeing all local useState is reset. This is used by the parent to force a fresh
  // start when the user clicks "Build" again after a previous cancel or failure.
}

interface BuildLogEntry {
  step: string;
  text: string;
  timestamp: string;
}

/**
 * The build flow has TWO distinct consent points where the user must explicitly approve:
 *
 * 1. Initial Build Confirmation (this modal in "confirm" phase)
 *    - User sets PR, custom flags, thread count, etc.
 *    - Clicks "PROCEED TO CONFIGURE" → starts `foundry_build` (engine stop + configure).
 *    - Component: FoundryConfirmForm
 *
 * 2. Compilation Confirmation (WaitingForConfirm phase, rendered inside FoundryBuildProgress)
 *    - After successful CMake configure, the backend pauses and asks for final approval.
 *    - User sees the configure log and must click "BUILD THE ENGINE" or "REJECT — ABORT".
 *    - This is the last chance before the long/expensive MSBuild compilation starts.
 *
 * These two points used to have overlapping/confusing "confirm" names. We are trying to keep
 * the distinction clear in code and UI.
 */
type ModalPhase = "confirm" | "building" | "complete" | "error" | "backup-locked";

function mapBackendPhase(bp: string): { frontend: ModalPhase | null; special?: string } {
  switch (bp) {
    case "GitClone":
    case "GitPull":
    case "Configuring": return { frontend: null };
    case "WaitingForConfirm": return { frontend: "building", special: "wait-confirm" };
    case "Building": return { frontend: "building" };
    case "Validating": return { frontend: "building" };
    case "Complete": return { frontend: "complete" };
    case "Failed": return { frontend: "error" };
    case "BackupLocked": return { frontend: "backup-locked" };
    default: return { frontend: null };
  }
}

function stepToModalPhase(step: string): ModalPhase {
  if (step === "complete") return "complete";
  if (step === "error") return "error";
  if (step === "backup-locked") return "backup-locked";
  if (
    step === "configuring"
    || step === "building"
    || step === "validating"
    || step === "waiting-confirm"
    || step === "clone"
    || step === "pull"
  ) {
    return "building";
  }
  return "confirm";
}

const ACTIVE_BACKEND_PHASES = new Set([
  "GitClone",
  "GitPull",
  "Configuring",
  "WaitingForConfirm",
  "Building",
  "Validating",
  "BackupLocked",
]);

function applyStatusHydration(
  status: FoundryStatusPayload,
  providerId: string,
  refs: {
    buildIdRef: MutableRefObject<number | null>;
    setPhase: (p: ModalPhase) => void;
    setCurrentStep: (s: string) => void;
    setWaitingForConfirm: (v: boolean) => void;
    setStoppingEngines: (v: boolean) => void;
  },
): boolean {
  if (status.provider_id !== providerId) return false;

  refs.buildIdRef.current = status.build_id;
  refs.setCurrentStep(status.phase);
  refs.setStoppingEngines(false);

  const mapping = mapBackendPhase(status.phase);
  if (mapping.frontend) {
    refs.setPhase(mapping.frontend);
  } else if (status.phase === "Configuring") {
    refs.setPhase("building");
  }
  if (mapping.special === "wait-confirm" || status.phase === "WaitingForConfirm") {
    refs.setWaitingForConfirm(true);
  }
  return ACTIVE_BACKEND_PHASES.has(status.phase);
}

export default function FoundryModal({ provider, environment, onClose, onComplete, visible, onMinimize }: FoundryModalProps) {
  const { buildProgress, reattachedFromBackend } = useFoundry();

  const [phase, setPhase] = useState<ModalPhase>(() => {
    if ((buildProgress?.buildId ?? 0) > 0 && buildProgress?.providerId === provider.id) {
      return stepToModalPhase(buildProgress.step);
    }
    return "confirm";
  });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Transient state for immediate feedback when user clicks the final BUILD button.
  // We show this *before* the heavy engine-stop work starts in the backend (which can take 5-15s).
  const [stoppingEngines, setStoppingEngines] = useState(false);

  const buildIdRef = useRef<number | null>(buildProgress?.buildId ?? null);
  const [logLines, setLogLines] = useState<BuildLogEntry[]>([]);
  const [currentStep, setCurrentStep] = useState(buildProgress?.step ?? "");
  const [waitingForConfirm, setWaitingForConfirm] = useState(
    buildProgress?.step === "waiting-confirm",
  );

  // Confirm form state (only relevant before build starts)
  // PR field starts EMPTY by design: history is opt-in via the HISTORY chips.
  const [prUrl, setPrUrl] = useState("");
  const [maxCores, setMaxCores] = useState<number | null>(null);
  const [buildProfile, setBuildProfile] = useState(() => splitFoundryBuildProfile(provider.build_profile ?? "").base);
  const [selectedArchs, setSelectedArchs] = useState<string[]>(
    () => splitFoundryBuildProfile(provider.build_profile ?? "").archCodes,
  );
  const [generator, setGenerator] = useState(provider.foundry_generator ?? "");
  /** Offline llama-cli + llama-quantize; product needs server + fit-params + llama-bench. */
  const [includeExtraTools, setIncludeExtraTools] = useState(false);
  const [backupRetryCount, setBackupRetryCount] = useState(0);
  const [showEngineWarning, setShowEngineWarning] = useState(false);
  const [engineListText, setEngineListText] = useState("");

  const logRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);
  const buildInvokeInFlightRef = useRef(false);
  const completeNotifiedRef = useRef(false);

  // Reset when provider or environment changes. Also re-seed confirm-form flags when the
  // same provider's build_profile / foundry_generator is edited on the Providers page
  // (App reloads providers → Layout passes a new object; without this, local state stays stale
  // until full app restart because we only keyed off provider.id before).
  const prevProviderIdRef = useRef(provider.id);
  const prevEnvironmentRef = useRef(environment);
  const prevBuildProfileRef = useRef(provider.build_profile ?? "");
  const prevGeneratorRef = useRef(provider.foundry_generator ?? "");
  useEffect(() => {
    const idChanged = prevProviderIdRef.current !== provider.id;
    const envChanged = prevEnvironmentRef.current !== environment;
    const profileChanged = prevBuildProfileRef.current !== (provider.build_profile ?? "");
    const generatorChanged = prevGeneratorRef.current !== (provider.foundry_generator ?? "");

    prevProviderIdRef.current = provider.id;
    prevEnvironmentRef.current = environment;
    prevBuildProfileRef.current = provider.build_profile ?? "";
    prevGeneratorRef.current = provider.foundry_generator ?? "";

    if (!idChanged && !envChanged && !profileChanged && !generatorChanged) return;

    // Full reset only when switching provider/env (or opening a different build target).
    // Flag-only updates keep phase/log so an in-flight build isn't wiped mid-run.
    if (idChanged || envChanged) {
      setPhase("confirm");
      setLogLines([]);
      setCurrentStep("");
      setWaitingForConfirm(false);
      setStoppingEngines(false);
      buildIdRef.current = null;
      setPrUrl("");
      setMaxCores(null);
      setIncludeExtraTools(false);
      setBackupRetryCount(0);
      setShowEngineWarning(false);
      setEngineListText("");
    }

    // Always re-seed cmake/generator from the live provider when not mid-build.
    // If a build is already running, leave the form values that were snapshotted at start.
    const midBuild =
      phaseRef.current === "building" ||
      phaseRef.current === "complete" ||
      phaseRef.current === "error" ||
      phaseRef.current === "backup-locked";
    if (!midBuild || idChanged || envChanged) {
      const split = splitFoundryBuildProfile(provider.build_profile ?? "");
      setBuildProfile(split.base);
      setSelectedArchs(split.archCodes);
      setGenerator(provider.foundry_generator ?? "");
    }
  }, [provider.id, provider.build_profile, provider.foundry_generator, environment]);

  // When the confirm form is shown, always re-pull build_profile from the backend.
  // Covers App/Layout provider lag after Providers-page save (reloadProviders is async).
  // Only on hidden→visible edge so minimize/restore does not clobber in-progress edits.
  const prevVisibleRef = useRef(false);

  useEffect(() => {
    const becameVisible = visible && !prevVisibleRef.current;
    prevVisibleRef.current = visible;
    if (!becameVisible) return;
    if (phaseRef.current !== "confirm") return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await invoke<ProviderConfig[]>("list_providers");
        if (cancelled) return;
        const live = list.find((p) => p.id === provider.id);
        if (!live) return;
        const split = splitFoundryBuildProfile(live.build_profile ?? "");
        setBuildProfile(split.base);
        setSelectedArchs(split.archCodes);
        setGenerator(live.foundry_generator ?? "");
        prevBuildProfileRef.current = live.build_profile ?? "";
        prevGeneratorRef.current = live.foundry_generator ?? "";
      } catch (err) {
        console.warn("[Foundry] confirm-form provider refresh failed:", err);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, provider.id, environment]);




  // Rehydrate from backend after HMR/remount (source of truth when UI state was wiped).
  useEffect(() => {
    let cancelled = false;

    const hydrate = async () => {
      try {
        const status = await invoke<FoundryStatusPayload | null>("foundry_status");
        if (cancelled || !status) return;
        applyStatusHydration(status, provider.id, {
          buildIdRef,
          setPhase,
          setCurrentStep,
          setWaitingForConfirm,
          setStoppingEngines,
        });
      } catch (err) {
        console.error("[Foundry] Status hydration failed:", err);
      }
    };

    void hydrate();
    return () => { cancelled = true; };
  }, [provider.id]);

  // Sync when parent context reconciles before/at mount.
  useEffect(() => {
    if (!buildProgress?.buildId || buildProgress.providerId !== provider.id) return;
    buildIdRef.current = buildProgress.buildId;
    const mapped = stepToModalPhase(buildProgress.step);
    if (mapped !== "confirm") {
      setPhase(mapped);
      setCurrentStep(buildProgress.step);
      setStoppingEngines(false);
    }
    if (buildProgress.step === "waiting-confirm") {
      setWaitingForConfirm(true);
    }
  }, [buildProgress?.buildId, buildProgress?.step, buildProgress?.providerId, provider.id]);

  // Single progress listener owned by the orchestrator
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      interface FoundryProgressPayload {
        build_id: number;
        phase: string;
        provider_id: string;
        environment?: string;
        log_line?: string;
        log_lines?: string[];
      }

      const unsub = await listen<FoundryProgressPayload>("foundry-progress", (e) => {
        if (!mounted) return;
        try {
          const payload = e.payload;
          if (!payload || !payload.provider_id) return;

          if (buildIdRef.current === null) {
            buildIdRef.current = payload.build_id;
          } else if (payload.build_id !== buildIdRef.current) return;

          const stepLabel = payload.phase || "";
          setCurrentStep(stepLabel);

          const ts = new Date().toLocaleTimeString();
          if (payload.log_lines?.length > 0) {
            setLogLines(prev => {
              const next = [...prev, ...payload.log_lines.map((text: string) => ({ step: stepLabel, text, timestamp: ts }))];
              if (stepLabel === "BUILD" && next.length > 150) return next.slice(next.length - 150);
              return next;
            });
          } else if (payload.log_line) {
            setLogLines(prev => [...prev, { step: stepLabel, text: payload.log_line, timestamp: ts }]);
          }

          const mapping = mapBackendPhase(payload.phase);

          // As soon as *any* progress event arrives from this build, the heavy "stopping engines" phase is over.
          // We no longer need the big overlay — dismiss it early so the user sees real configure/compile output promptly.
          if (payload.build_id != null && buildIdRef.current === payload.build_id) {
            setStoppingEngines(false);
          }

          if (mapping.frontend) {
            setPhase(mapping.frontend);
            if (mapping.frontend === "complete" || mapping.frontend === "error") {
              // Do NOT auto-clear the log here.
              // User wants to review the full build log on the success/error screen.
              // The log will be cleared when they explicitly close the modal (or start a new build for a different provider).
              if (mapping.frontend === "complete" && onComplete && !completeNotifiedRef.current) {
                completeNotifiedRef.current = true;
                onComplete(provider.id);
              }
            }
            if (mapping.frontend === "backup-locked") setBackupRetryCount(p => p + 1);
          }
          if (mapping.special === "wait-confirm") {
            setWaitingForConfirm(true);
            if (phaseRef.current === "confirm") setPhase("building");
          } else if (!mapping.frontend && phaseRef.current === "confirm" && payload.log_line) {
            setPhase("building");
          }
        } catch (err) {
          console.error("[Foundry] Progress event error:", err);
        }
      });

      cleanupRef.current = () => unsub();
    };
    init();

    return () => {
      mounted = false;
      if (cleanupRef.current) cleanupRef.current();
    };
  }, [provider.id, onComplete]);

  // ── Confirm flow handlers ───────────────────────────────────────────
  const startBuild = useCallback(async () => {
    if (buildInvokeInFlightRef.current) return;
    completeNotifiedRef.current = false;

    // Never start a duplicate while the backend still owns an in-flight build.
    try {
      const status = await invoke<FoundryStatusPayload | null>("foundry_status");
      if (status && applyStatusHydration(status, provider.id, {
        buildIdRef,
        setPhase,
        setCurrentStep,
        setWaitingForConfirm,
        setStoppingEngines,
      })) {
        return;
      }
    } catch (err) {
      console.error("[Foundry] Pre-build status check failed:", err);
    }

    buildInvokeInFlightRef.current = true;

    const trimmedProfile = mergeBuildProfileWithArchitectures(buildProfile, selectedArchs);
    const savedProfile = provider.build_profile?.trim() ?? "";
    const chosenGenerator = generator.trim();
    const savedGenerator = provider.foundry_generator?.trim() ?? "";
    // Persist the build profile + generator choice to the provider when either changed
    // (so the confirm-modal selection becomes the provider default, like build profile).
    if (trimmedProfile !== savedProfile || chosenGenerator !== savedGenerator) {
      try {
        await invoke("save_provider", {
          provider: {
            ...provider,
            build_profile: trimmedProfile,
            foundry_generator: chosenGenerator,
          },
        });
        dispatchAppEvent(EVENTS.reloadProviders);
      } catch (persistErr) {
        console.error("[Foundry] Failed to persist build profile/generator:", persistErr);
      }
    }

    // Give the user *immediate* visible feedback that we are now stopping engines.
    // This is the moment the long delay used to be completely silent.
    setStoppingEngines(true);
    setPhase("building");
    setCurrentStep("STOPPING ENGINES");

    // Hard safety timeout: never let the "STOPPING ENGINES" overlay stay visible more than ~7 seconds.
    // If the backend is slow to emit the first progress, we still want the user to see the real configure output.
    const overlayTimeout = setTimeout(() => {
      setStoppingEngines(false);
    }, 7000);

    try {
      // Fire-and-forget: the command returns immediately; progress comes via foundry-progress events.
      // Awaiting the full build blocked confirm/cancel IPC under Tauri 2.11+.
      await invoke("foundry_build", {
        providerId: provider.id,
        environment,
        prUrl: prUrl.trim() || null,
        maxCores: maxCores ?? undefined,
        cmakeFlags: trimmedProfile || null,
        generator: chosenGenerator || null,
        includeExtraTools,
      });
    } catch (err) {
      clearTimeout(overlayTimeout);
      setStoppingEngines(false);

      // Duplicate invoke (double-click) can reject while the first build is still healthy.
      try {
        const status = await invoke<FoundryStatusPayload | null>("foundry_status");
        if (status && applyStatusHydration(status, provider.id, {
          buildIdRef,
          setPhase,
          setCurrentStep,
          setWaitingForConfirm,
          setStoppingEngines,
        })) {
          return;
        }
      } catch {
        // fall through to error UI
      }

      const errText = typeof err === "string" ? err : JSON.stringify(err);
      setPhase("error");
      setLogLines(prev => [...prev, {
        step: "ERROR",
        text: errText,
        timestamp: new Date().toLocaleTimeString(),
      }]);
    } finally {
      clearTimeout(overlayTimeout);
      buildInvokeInFlightRef.current = false;
    }
  }, [provider, environment, prUrl, maxCores, buildProfile, selectedArchs, generator, includeExtraTools]);

  const handleConfirmBuild = useCallback(async () => {
    try {
      const stackStatus = await invoke<StackEngineStatus[]>("get_stack_status");
      const profileKey = environment.toLowerCase();
      const matching = stackStatus.filter((e: StackEngineStatus) =>
        e.provider_type === provider.id
        && e.status !== "IDLE"
        && (e.binaryProfile || "frontier").toLowerCase() === profileKey
      );

      if (matching.length > 0) {
        setEngineListText(matching.map((e) => `${e.alias} (${e.provider_name || e.provider_type}) · ${environment.toUpperCase()} on GPU ${e.gpu ?? "?"}`).join("\n"));
        setShowEngineWarning(true);
        return;
      }
      await startBuild();
    } catch (err) {
      setPhase("error");
      setLogLines(p => [...p, { step: "ERROR", text: String(err), timestamp: new Date().toLocaleTimeString() }]);
    }
  }, [provider.id, startBuild]);

  const handleEngineWarningProceed = useCallback(async () => {
    setShowEngineWarning(false);
    setEngineListText("");
    await startBuild();
  }, [startBuild]);

  const handleEngineWarningCancel = useCallback(() => {
    setShowEngineWarning(false);
    setEngineListText("");
  }, []);

  const handleCancel = useCallback(async () => {
    setStoppingEngines(false);
    setWaitingForConfirm(false);
    setLogLines([]);
    setCurrentStep("");

    // Close UI first — never let a hung cancel invoke trap the modal open.
    onClose();
    try { await invoke("foundry_cancel"); } catch (err) {
      console.error("[Foundry] Cancel invoke failed:", err);
    }
  }, [onClose]);

  const handleConfirmProceed = useCallback(async () => {
    setWaitingForConfirm(false);
    setCurrentStep("Building");
    try {
      await invoke("foundry_confirm_build");
    } catch (err) {
      console.error("[Foundry] Confirm invoke failed:", err);
      setWaitingForConfirm(true);
    }
  }, []);

  const handleBackupLockedYes = useCallback(async () => {
    try { await invoke("foundry_resume_backup"); } catch {}
  }, []);

  const isComplete = phase === "complete";
  const isError = phase === "error";

  if (!visible) {
    return null;
  }

  // Backup Locked state (rare, keep inline for now)
  if (phase === "backup-locked") {
    return (
      <FoundryWindowShell
        title="⚠ BINARY LOCKED"
        tone="amber"
        variant="compact"
        onMinimize={onMinimize}
        footer={(
          <>
            <button onClick={handleCancel} className="fnd-confirm-btn--danger px-3 py-1 font-mono">CANCEL BUILD</button>
            <button onClick={handleBackupLockedYes} className="fnd-confirm-btn--accent px-4 py-1 font-mono rounded-sm">YES — STOP ENGINES &amp; PROCEED</button>
          </>
        )}
      >
        <div className="px-4 py-5">
          <p className="fnd-modal-caption type-body font-mono uppercase tracking-wider">Engine binary is currently in use</p>
        </div>
      </FoundryWindowShell>
    );
  }

  // Confirmation Phase
  if (phase === "confirm") {
    return (
      <FoundryConfirmForm
        provider={provider}
        environment={environment}
        prUrl={prUrl}
        setPrUrl={setPrUrl}
        buildProfile={buildProfile}
        setBuildProfile={setBuildProfile}
        generator={generator}
        setGenerator={setGenerator}
        selectedArchs={selectedArchs}
        setSelectedArchs={setSelectedArchs}
        maxCores={maxCores}
        setMaxCores={setMaxCores}
        includeExtraTools={includeExtraTools}
        setIncludeExtraTools={setIncludeExtraTools}
        showEngineWarning={showEngineWarning}
        engineListText={engineListText}
        onClose={onClose}
        onMinimize={onMinimize || (() => {})}
        onConfirmBuild={handleConfirmBuild}
        onEngineWarningProceed={handleEngineWarningProceed}
        onEngineWarningCancel={handleEngineWarningCancel}
      />
    );
  }

  // Special immediate feedback screen while we are stopping engines (before any real progress events arrive).
  if (stoppingEngines && !isComplete && !isError) {
    return (
      <FoundryWindowShell
        title="STOPPING ENGINES"
        tone="amber"
        variant="compact"
        onMinimize={onMinimize}
        footer={(
          <button
            onClick={handleCancel}
            className="fnd-confirm-btn--danger px-4 py-1 font-mono"
          >
            CANCEL BUILD
          </button>
        )}
      >
        <div className="px-6 py-6 text-center space-y-3">
          <div className="fnd-stop-body type-sm font-mono">
            BUILD needs exclusive access.<br />
            Automatically stopping engines using <span className="fnd-stop-body__hl font-bold">{provider.display_name}</span> · <span className="fnd-stop-body__hl font-bold">{environment.toUpperCase()}</span> profile...
          </div>
          <div className="fnd-stop-note type-label font-mono">This can take 5–15 seconds. The build will start automatically after engines are stopped.</div>
        </div>
      </FoundryWindowShell>
    );
  }

  // Build / Complete / Error Phase (normal progress UI)
  return (
    <>
      {reattachedFromBackend && (
        <div className="fnd-reattach-banner fixed top-2 left-1/2 -translate-x-1/2 z-[95] px-3 py-1 font-mono rounded-sm pointer-events-none">
          Build still running — UI reattached after reload
        </div>
      )}
      <FoundryBuildProgress
        provider={provider}
        environment={environment}
        logLines={logLines}
        currentStep={currentStep}
        waitingForConfirm={waitingForConfirm}
        isComplete={isComplete}
        isError={isError}
        onMinimize={onMinimize || (() => {})}
        onClose={onClose}
        onCancel={handleCancel}
        onConfirmProceed={handleConfirmProceed}
        logRef={logRef}
      />
    </>
  );
}
