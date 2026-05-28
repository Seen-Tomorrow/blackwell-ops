import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProviderConfig } from "../lib/types";
import FoundryConfirmForm from "./FoundryConfirmForm";
import FoundryBuildProgress from "./FoundryBuildProgress";

interface FoundryModalProps {
  provider: ProviderConfig;
  environment: "vanguard" | "stable" | "fresh";
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
 *    - Clicks "YES — BUILD" → this starts the real `foundry_build` (engine stop + configure).
 *    - Component: FoundryConfirmForm
 *
 * 2. Compilation Confirmation (WaitingForConfirm phase, rendered inside FoundryBuildProgress)
 *    - After successful CMake configure, the backend pauses and asks for final approval.
 *    - User sees the configure log and must click "PROCEED WITH BUILD" or "REJECT — ABORT".
 *    - This is the last chance before the long/expensive MSBuild compilation starts.
 *
 * These two points used to have overlapping/confusing "confirm" names. We are trying to keep
 * the distinction clear in code and UI.
 */
type ModalPhase = "confirm" | "building" | "complete" | "error" | "backup-locked";

function mapBackendPhase(bp: string): { frontend: ModalPhase | null; special?: string } {
  switch (bp) {
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

export default function FoundryModal({ provider, environment, onClose, onComplete, visible, onMinimize }: FoundryModalProps) {
  const [phase, setPhase] = useState<ModalPhase>("confirm");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  // Transient state for immediate feedback when user clicks the final BUILD button.
  // We show this *before* the heavy engine-stop work starts in the backend (which can take 5-15s).
  const [stoppingEngines, setStoppingEngines] = useState(false);

  const buildIdRef = useRef<number | null>(null);
  const [logLines, setLogLines] = useState<BuildLogEntry[]>([]);
  const [currentStep, setCurrentStep] = useState("");
  const [waitingForConfirm, setWaitingForConfirm] = useState(false);

  // Confirm form state (only relevant before build starts)
  const [prUrl, setPrUrl] = useState("");
  const [maxCores, setMaxCores] = useState<number | null>(null);
  const [cmakeFlags, setCmakeFlags] = useState("");
  const [backupRetryCount, setBackupRetryCount] = useState(0);
  const [showEngineWarning, setShowEngineWarning] = useState(false);
  const [engineListText, setEngineListText] = useState("");

  const logRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  // Reset when provider or environment changes
  const prevProviderIdRef = useRef(provider.id);
  const prevEnvironmentRef = useRef(environment);
  useEffect(() => {
    if (prevProviderIdRef.current === provider.id && prevEnvironmentRef.current === environment) return;
    prevProviderIdRef.current = provider.id;
    prevEnvironmentRef.current = environment;

    setPhase("confirm");
    setLogLines([]);
    setCurrentStep("");
    setWaitingForConfirm(false);
    setStoppingEngines(false);
    buildIdRef.current = null;
    setPrUrl("");
    setMaxCores(null);
    setCmakeFlags("");
    setBackupRetryCount(0);
    setShowEngineWarning(false);
    setEngineListText("");
  }, [provider.id, environment]);

  // Single progress listener owned by the orchestrator
  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const unsub = await listen("foundry-progress", (e: any) => {
        if (!mounted) return;
        try {
          const payload = e.payload as any;
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
              if (mapping.frontend === "complete" && onComplete) onComplete(provider.id);
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
      await invoke("foundry_build", {
        providerId: provider.id,
        environment,
        prUrl: prUrl.trim() || null,
        maxCores: maxCores ?? undefined,
        cmakeFlags: cmakeFlags.trim() || null,
      });
    } catch (err) {
      clearTimeout(overlayTimeout);
      setStoppingEngines(false);
      setPhase("error");
      setLogLines(prev => [...prev, {
        step: "ERROR",
        text: typeof err === "string" ? err : JSON.stringify(err),
        timestamp: new Date().toLocaleTimeString(),
      }]);
    } finally {
      clearTimeout(overlayTimeout);
    }
  }, [provider.id, environment, prUrl, maxCores, cmakeFlags]);

  const handleConfirmBuild = useCallback(async () => {
    try {
      const stackStatus = await invoke<any[]>("get_stack_status");
      const matching = stackStatus.filter((e: any) => e.provider_type === provider.id && e.status !== "IDLE");

      if (matching.length > 0) {
        setEngineListText(matching.map((e: any) => `${e.alias} (${e.provider_name || e.provider_type}) on GPU ${e.gpu}`).join("\n"));
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
    try { await invoke("foundry_cancel"); } catch {}
    setStoppingEngines(false);
    setLogLines([]);
    setCurrentStep("");

    // Important: actually close the modal through the dock state machine.
    // Without this, cancelling from WaitingForConfirm or error states leaves
    // the dock thinking there's still an active (stuck) build session.
    onClose();
  }, [onClose]);

  const handleConfirmProceed = useCallback(async () => {
    setWaitingForConfirm(false);
    try { await invoke("foundry_confirm_build"); } catch {}
  }, []);

  const handleBackupLockedYes = useCallback(async () => {
    try { await invoke("foundry_resume_backup"); } catch {}
  }, []);

  const isComplete = phase === "complete";
  const isError = phase === "error";

  // Drain logLines only on true terminal states (complete/error).
  // We no longer auto-drain just because the modal is minimized/hidden.
  // This preserves log history across minimize/restore during configure and build phases.
  // Memory is controlled by:
  //   - BUILD-phase cap inside the listener (150 lines)
  //   - Visual slice(-200) in the renderer
  //   - Full history available in the Blackwell Output Console
  const hasDrainedRef = useRef(false);

  useEffect(() => {
    const shouldDrain = isComplete || isError;
    if (shouldDrain && !hasDrainedRef.current && logLines.length > 0) {
      hasDrainedRef.current = true;
      setLogLines([]);
      setCurrentStep("");
    }
    // Reset guard when a brand new build session starts
    if (phase === "confirm") {
      hasDrainedRef.current = false;
    }
  }, [isComplete, isError, phase, logLines.length]);

  if (!visible) {
    return null;
  }

  // Backup Locked state (rare, keep inline for now)
  if (phase === "backup-locked") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
        <div className="w-[50vw] max-w-[520px] border border-yellow-400/40 bg-stealth-panel rounded-sm shadow-2xl">
          <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border">
            <h3 className="text-xs font-mono text-yellow-400 tracking-wider">⚠ BINARY LOCKED</h3>
          </div>
          <div className="px-4 py-5 space-y-4">
            <p className="text-[10px] font-mono text-stealth-muted uppercase tracking-wider">Engine binary is currently in use</p>
          </div>
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-stealth-border">
            <button onClick={handleCancel} className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400">CANCEL BUILD</button>
            <button onClick={handleBackupLockedYes} className="px-4 py-1 text-[9px] font-mono border rounded-sm bg-nv-green/20 border-nv-green/60 text-nv-green">YES — STOP ENGINES &amp; PROCEED</button>
          </div>
        </div>
      </div>
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
        cmakeFlags={cmakeFlags}
        setCmakeFlags={setCmakeFlags}
        maxCores={maxCores}
        setMaxCores={setMaxCores}
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
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 backdrop-blur-sm">
        <div className="w-[min(92vw,620px)] border border-yellow-400/40 bg-stealth-panel rounded-sm p-8 text-center space-y-4">
          <div className="text-yellow-400 text-2xl font-mono tracking-[4px]">STOPPING ENGINES</div>
          <div className="text-[11px] font-mono text-white/80">
            BUILD needs exclusive access.<br />
            Automatically stopping any running inference engines for <span className="text-yellow-400 font-bold">{provider.display_name}</span>...
          </div>
          <div className="text-[9px] font-mono text-stealth-muted pt-2">This can take 5–15 seconds. The build will start automatically after engines are stopped.</div>
          <button
            onClick={handleCancel}
            className="mt-4 px-4 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20"
          >
            CANCEL BUILD
          </button>
        </div>
      </div>
    );
  }

  // Build / Complete / Error Phase (normal progress UI)
  return (
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
  );
}
