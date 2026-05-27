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
}

interface BuildLogEntry {
  step: string;
  text: string;
  timestamp: string;
}

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
          if (mapping.frontend) {
            setPhase(mapping.frontend);
            if (mapping.frontend === "complete" && onComplete) onComplete(provider.id);
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
    try {
      await invoke("foundry_build", {
        providerId: provider.id,
        environment,
        prUrl: prUrl.trim() || null,
        maxCores: maxCores ?? undefined,
        cmakeFlags: cmakeFlags.trim() || null,
      });
    } catch (err) {
      setPhase("error");
      setLogLines(prev => [...prev, {
        step: "ERROR",
        text: typeof err === "string" ? err : JSON.stringify(err),
        timestamp: new Date().toLocaleTimeString(),
      }]);
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
  }, []);

  const handleConfirmProceed = useCallback(async () => {
    setWaitingForConfirm(false);
    try { await invoke("foundry_confirm_build"); } catch {}
  }, []);

  const handleBackupLockedYes = useCallback(async () => {
    try { await invoke("foundry_resume_backup"); } catch {}
  }, []);

  const isComplete = phase === "complete";
  const isError = phase === "error";

  if (!visible) return null;

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

  // Build / Complete / Error Phase
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
