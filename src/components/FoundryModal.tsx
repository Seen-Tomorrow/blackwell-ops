import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProviderConfig } from "../lib/types";
import { useTelemetry } from "../context/TelemetryContext";
import { getStepLabel, getEnvColors } from "../lib/foundry_constants";

interface FoundryModalProps {
  provider: ProviderConfig;
  environment: "vanguard" | "stable" | "fresh";
  onClose: () => void; // Called on Complete/Failed or cancel during confirm phase
  onComplete?: (providerId: string) => void;
  visible: boolean; // true = show overlay, false = hidden but mounted (minimized to dock)
  onMinimize?: () => void; // Called when MINIMIZE button clicked — hides overlay but keeps modal alive
}

interface BuildLogEntry {
  step: string;
  text: string;
  timestamp: string;
}

type ModalPhase = "confirm" | "building" | "complete" | "error" | "backup-locked";

export default function FoundryModal({ provider, environment, onClose, onComplete, visible, onMinimize }: FoundryModalProps) {
  const [phase, setPhase] = useState<ModalPhase>("confirm");
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const [buildId, setBuildId] = useState<number | null>(null);
  const buildIdRef = useRef<number | null>(null);
  buildIdRef.current = buildId;
  const [logLines, setLogLines] = useState<BuildLogEntry[]>([]);
  const [currentStep, setCurrentStep] = useState("");
  const [waitingForConfirm, setWaitingForConfirm] = useState(false);
  const [prUrl, setPrUrl] = useState("");
  const [maxCores, setMaxCores] = useState<number | null>(null);
  const [backupRetryCount, setBackupRetryCount] = useState(0);
  const [showEngineWarning, setShowEngineWarning] = useState(false);
  const [engineListText, setEngineListText] = useState("");
  const logRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const { cpu } = useTelemetry();
  const cpuThreads = cpu?.threads ?? 0;
  const cpuPhysical = cpu?.cores ?? 0;

  const envColors = (base: string): string => {
    return getEnvColors(environment)[base as keyof ReturnType<typeof getEnvColors>] || "";
  };

  useEffect(() => {
    let mounted = true;

    const init = async () => {
      const unsubProgress = await listen("foundry-build-progress", (e: any) => {
        if (!mounted) return;
        try {
          const payload = e.payload as any;
          if (!payload || !payload.provider_id) return;

          // Capture buildId from first event, then filter by it
          if (buildIdRef.current === null) {
            setBuildId(payload.build_id);
            buildIdRef.current = payload.build_id;
          } else if (payload.build_id !== buildIdRef.current) return;

          const stepLabel = getStepLabel(payload.step);
          setCurrentStep(stepLabel);

          if (payload.log_lines) {
            const batch = payload.log_lines as string[];
            const ts = new Date().toLocaleTimeString();
            setLogLines(prev => {
              const next = [...prev, ...batch.map(text => ({
                step: stepLabel,
                text,
                timestamp: ts,
              }))];
              // Cap at 150 lines during Building phase (~3 pages) — trim from front
              if (stepLabel === "BUILD" && next.length > 150) {
                return next.slice(next.length - 150);
              }
              return next;
            });
          } else if (payload.log_line) {
            const logText = payload.log_line as string;

            setLogLines(prev => [...prev, {
              step: stepLabel,
              text: logText,
              timestamp: new Date().toLocaleTimeString(),
            }]);
          }

          // Phase transitions based on step — stay in "confirm" until cmake preview appears
          switch (payload.step) {
            case "Complete":
              setPhase("complete");
              if (onComplete) onComplete(provider.id);
              break;
            case "Failed":
              setPhase("error");
              break;
            case "BackupLocked":
              setPhase("backup-locked");
              setBackupRetryCount(prev => prev + 1);
              break;
            case "WaitingForConfirm":
              // CMake done — show PROCEED/ABORT buttons
              setWaitingForConfirm(true);
              if (phaseRef.current === "confirm") setPhase("building");
              break;
            default:
              if (phaseRef.current === "confirm") setPhase("building");
          }
        } catch (err) { console.error("[Foundry] Progress event error:", err); }
      });

      // Listen for toast events
      const unsubToast = await listen("foundry-toast", (e: any) => {
        if (!mounted) return;
        try {
          const payload = e.payload as any;
          if (!payload || !payload.text) return;
          
          showToast(payload.type, payload.text);
        } catch (err) { console.error("[Foundry] Progress event error:", err); }
      });

      cleanupRef.current = () => { unsubProgress(); unsubToast(); };
    };
    init();

    return () => {
      mounted = false;
      if (cleanupRef.current) cleanupRef.current();
    };
  }, []);

  useEffect(() => {
    // Auto-scroll log to bottom
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logLines]);

  // Reset internal state when provider or environment changes (reopening modal)
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
    setBuildId(null);
    buildIdRef.current = null;
    setPrUrl("");
    setMaxCores(null);
    setBackupRetryCount(0);
    setShowEngineWarning(false);
    setEngineListText("");
  }, [provider.id, environment]);

  // Listen for reset signal on Complete/Failed — clears logs and resets phase
  useEffect(() => {
    const handler = () => {
      setPhase("confirm");
      setLogLines([]);
      setCurrentStep("");
      setWaitingForConfirm(false);
      setBuildId(null);
      buildIdRef.current = null;
      setPrUrl("");
      setMaxCores(null);
      setBackupRetryCount(0);
      setShowEngineWarning(false);
      setEngineListText("");
    };
    window.addEventListener("blackops-foundry-reset", handler);
    return () => window.removeEventListener("blackops-foundry-reset", handler);
  }, []);

  const showToast = (type: string, text: string) => {
    try {
      const toastFn = (window as any).__blackopsToasts?.addToast;
      if (toastFn) {
        toastFn(text, type === "error" ? "error" : "success", 5000);
      }
    } catch (err) { console.error("[Foundry] Reset handler error:", err); }
  };

  const handleConfirmBuild = async () => {
    try {
      // Check for running engines that will be stopped by this build
      const stackStatus = await invoke<Array<{provider_type: string; status: string; alias: string; provider_name?: string; gpu: string}>>("get_stack_status");
      const matchingEngines = stackStatus.filter(
        e => e.provider_type === provider.id && e.status !== "IDLE"
      );

      if (matchingEngines.length > 0) {
        // Show blocking warning — require explicit confirmation before proceeding
        setEngineListText(matchingEngines.map(e => 
          `${e.alias} (${e.provider_name || e.provider_type}) on GPU ${e.gpu}`
        ).join("\n"));
        setShowEngineWarning(true);
        return;
      }

      await invoke("foundry_build", {
        providerId: provider.id,
        environment,
        prUrl: prUrl.trim() || null,
        maxCores: maxCores ?? undefined,
      });
    } catch (err) {
      setPhase("error");
      setLogLines(prev => [...prev, {
        step: "ERROR",
        text: typeof err === "string" ? err : JSON.stringify(err),
        timestamp: new Date().toLocaleTimeString(),
      }]);
    }
  };

  const handleEngineWarningProceed = async () => {
    setShowEngineWarning(false);
    setEngineListText("");
    try {
      await invoke("foundry_build", {
        providerId: provider.id,
        environment,
        prUrl: prUrl.trim() || null,
        maxCores: maxCores ?? undefined,
      });
    } catch (err) {
      setPhase("error");
      setLogLines(prev => [...prev, {
        step: "ERROR",
        text: typeof err === "string" ? err : JSON.stringify(err),
        timestamp: new Date().toLocaleTimeString(),
      }]);
    }
  };

  const handleEngineWarningCancel = () => {
    setShowEngineWarning(false);
    setEngineListText("");
  };

  const handleCancel = async () => {
    try {
      await invoke("foundry_cancel");
      // Don't close modal — let the "Failed" event transition to error phase
    } catch (err) {
      console.error("[Foundry] Cancel failed:", err);
    }
  };

  const handleConfirmProceed = async () => {
    setWaitingForConfirm(false);
    try {
      await invoke("foundry_confirm_build");
    } catch (err) {
      console.error("[Foundry] Confirm failed:", err);
    }
  };

  const handleBackupLockedYes = async () => {
    // User chose YES — stop engines and resume backup
    try {
      await invoke("foundry_resume_backup");
    } catch (err) {
      console.error("[Foundry] Resume backup failed:", err);
    }
  };

  const handleBackupLockedPause = async () => {
    // User chose PAUSE — cancel the build, user will sort out engines manually
    try {
      await invoke("foundry_cancel");
    } catch (err) {
      console.error("[Foundry] Cancel failed:", err);
    }
  };

  // ── BackupLocked Phase ─────────────────────────────────────────────
  if (phase === "backup-locked") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm" style={{ display: visible ? 'flex' : 'none' }}>
        <div className="w-[50vw] max-w-[520px] border border-yellow-400/40 bg-stealth-panel rounded-sm shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border">
            <h3 className="text-xs font-mono text-yellow-400 tracking-wider">⚠ BINARY LOCKED</h3>
          </div>

          {/* Body */}
          <div className="px-4 py-5 space-y-4">
            <p className="text-[10px] font-mono text-stealth-muted uppercase tracking-wider">
              Engine binary is currently in use
            </p>

            <div className="border border-yellow-400/20 bg-yellow-400/[0.03] rounded-sm p-3 space-y-2">
              <p className="text-[10px] font-mono text-white/80">
                The binary for <span className="text-yellow-400">{provider.display_name}</span> ({environment.toLowerCase()}) is locked by a running process.
              </p>
              {backupRetryCount > 1 && (
                <p className="text-[9px] font-mono text-red-400">
                  Still locked after {backupRetryCount - 1} attempt(s). Are you sure you don't have the engine binary running externally somewhere? Check Task Manager for lingering processes.
                </p>
              )}
              <p className="text-[9px] font-mono text-stealth-muted">
                You can stop engines now, retry after checking manually, or cancel to handle it yourself.
              </p>
            </div>

            {/* Log lines showing current state */}
            {logLines.length > 0 && (
              <div className="border border-stealth-border/50 bg-black/40 rounded-sm p-2 font-mono text-[8px] max-h-[120px] overflow-y-auto">
                {logLines.slice(-3).map((entry, i) => (
                  <div key={i} className="py-0.5 text-white/60">
                    <span className="text-stealth-muted/40">[{entry.timestamp}]</span>{" "}
                    <span className="text-stealth-muted/60">{entry.step.padEnd(10)}</span>{" "}
                    {entry.text}
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-stealth-border">
            <button onClick={handleBackupLockedPause}
              className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
              CANCEL BUILD
            </button>
            {backupRetryCount > 1 && (
              <button onClick={handleBackupLockedYes}
                className="px-3 py-1 text-[9px] font-mono border border-yellow-400/60 text-yellow-400 hover:bg-yellow-500/20 transition-colors">
                RETRY — I CHECKED EXTERNAL PROCESSES
              </button>
            )}
            <button onClick={handleBackupLockedYes}
              className="px-4 py-1 text-[9px] font-mono border rounded-sm bg-nv-green/20 border-nv-green/60 text-nv-green hover:bg-nv-green/30 transition-all">
              YES — STOP ENGINES & PROCEED
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Confirmation Phase ─────────────────────────────────────────────
  if (phase === "confirm") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm" style={{ display: visible ? 'flex' : 'none' }}>
        <div className="w-[60vw] max-w-[720px] border border-yellow-400/40 bg-stealth-panel rounded-sm shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border">
            <h3 className="text-xs font-mono text-yellow-400 tracking-wider">REACTOR FOUNDRY</h3>
          </div>
          {/* Body */}
          <div className="px-4 py-5 space-y-4">
            <p className="text-[10px] font-mono text-stealth-muted uppercase tracking-wider">
              Ready to build?
            </p>

            {/* Provider info card */}
            <div className="border border-stealth-border/60 bg-black/30 rounded-sm p-3 space-y-2">
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-yellow-400">{provider.id}</span>
                <span className="text-[9px] font-mono text-stealth-muted">&mdash;</span>
                <span className="text-[10px] font-mono text-white truncate">{provider.display_name}</span>
              </div>

              {provider.git_url && (
                <p className="text-[8px] font-mono text-telemetry-cyan/70 break-all">
                  {provider.git_url} @{provider.branch || "main"}
                </p>
              )}

              {/* Environment badge */}
              <div className="flex items-center gap-2 pt-1">
                <span className="text-[8px] font-mono text-stealth-muted uppercase">Environment:</span>
                <span className={`px-2 py-0.5 text-[9px] font-mono border rounded-sm ${envColors("border")}`}>
                  {environment.toUpperCase()}
                </span>
              </div>

              {/* Optional PR cherry-pick input */}
              <div className="pt-1">
                <label className="text-[8px] font-mono text-stealth-muted uppercase block mb-1.5">
                  Apply PR patch (optional)
                </label>
                <input
                  type="text"
                  placeholder="https://github.com/owner/repo/pull/N"
                  className="w-full px-2 py-1.5 text-[8px] font-mono bg-black/50 border border-stealth-border rounded-sm text-white placeholder:text-stealth-muted/40 focus:border-purple-400/60 outline-none transition-colors"
                  value={prUrl}
                  onChange={(e) => setPrUrl(e.target.value)}
                />
              </div>

              {/* Build cores selector */}
              {cpuThreads > 0 && (
                <div className="pt-1">
                  <label className="text-[8px] font-mono text-stealth-muted uppercase block mb-1.5">
                    Max build threads
                  </label>
                  <p className="text-[7px] font-mono text-yellow-400/60 mb-2 leading-relaxed">
                    Your CPU has {cpuThreads} threads ({cpuPhysical} physical). Leaving 2+ free keeps the system responsive while building.
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {[4, 6, 8, 10, 12, 14, 16].map((n) => (
                      <button key={n} onClick={() => setMaxCores(n)}
                        className={`px-2 py-0.5 text-[9px] font-mono border rounded-sm transition-all ${
                          maxCores === n
                            ? "bg-nv-green/30 border-nv-green/60 text-nv-green"
                            : "border-stealth-border text-stealth-muted hover:text-white hover:border-stealth-border/80"
                        }`}>
                        {n}
                      </button>
                    ))}
                    <button onClick={() => setMaxCores(null)}
                      className={`px-2 py-0.5 text-[9px] font-mono border rounded-sm transition-all ${
                        maxCores === null
                          ? "bg-nv-green/30 border-nv-green/60 text-nv-green"
                          : "border-stealth-border text-stealth-muted hover:text-white hover:border-stealth-border/80"
                      }`}>
                      ALL ({cpuThreads})
                    </button>
                  </div>
                </div>
              )}
            </div>

            {/* Engine warning overlay */}
            {showEngineWarning && (
              <div className="border border-red-400/30 bg-red-400/[0.05] rounded-sm p-3 space-y-2">
                <p className="text-[10px] font-mono text-red-400 font-bold">⚠ RUNNING ENGINES DETECTED</p>
                <pre className="text-[8px] font-mono text-white/70 whitespace-pre-wrap">{engineListText}</pre>
                <p className="text-[9px] font-mono text-stealth-muted">
                  These engines will be stopped before the build starts. Click STOP ENGINES & PROCEED to continue, or CANCEL to handle manually.
                </p>
              </div>
            )}

            {/* Warning */}
            {!showEngineWarning && (
              <p className="text-[8px] font-mono text-yellow-400/70">
                This will compile llama.cpp from source. The build may take several minutes. Inference engines must be stopped before building.
              </p>
            )}
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-stealth-border">
            {showEngineWarning ? (
              <>
                <button onClick={handleEngineWarningCancel}
                  className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
                  CANCEL — HANDLE MANUALLY
                </button>
                <button onClick={handleEngineWarningProceed}
                  className="px-4 py-1 text-[9px] font-mono border rounded-sm bg-red-400/20 border-red-400/60 text-red-400 hover:bg-red-500/30 transition-all">
                  STOP ENGINES & PROCEED
                </button>
              </>
            ) : (
              <>
                <button onClick={onClose}
                  className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
                  CLOSE
                </button>
                <button onClick={() => onMinimize?.()}
                  className="px-3 py-1 text-[9px] font-mono border border-stealth-border text-stealth-muted hover:text-white transition-colors">
                  MINIMIZE TO STATUS BAR
                </button>
                <button onClick={handleConfirmBuild}
                  className={`px-4 py-1 text-[9px] font-mono border rounded-sm transition-all ${envColors("border")}`}>
                  YES — BUILD
                </button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ── Building / Complete / Error Phase ──────────────────────────────
  const isComplete = phase === "complete";
  const isError = phase === "error";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm" style={{ display: visible ? 'flex' : 'none' }}>
      <div className={`w-[75vw] max-w-[960px] border rounded-sm shadow-2xl flex flex-col ${
        isComplete ? "border-nv-green/40" : isError ? "border-red-400/40" : "border-yellow-400/40"
      }`} style={{ height: 'var(--dock-panel-height, 75vh)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-mono tracking-wider ${
              isComplete ? "text-nv-green" : isError ? "text-red-400" : "text-yellow-400"
            }`}>
              {isComplete ? "\u2713 BUILD COMPLETE" : isError ? "\u2716 BUILD FAILED" : "\u25CF BUILDING..."}
            </span>
            <span className={`px-1.5 py-0.5 text-[8px] font-mono border rounded-sm ${envColors("border")}`}>
              {environment.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-2 flex flex-col flex-1 min-h-0 overflow-hidden">
          {/* Provider info */}
          <p className="text-[9px] font-mono text-stealth-muted">
            <span className="text-yellow-400">{provider.id}</span> &mdash; {provider.display_name}
          </p>

          {/* Current step indicator */}
          {!isComplete && !isError && (
            <div className="flex items-center gap-2">
              <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Step:</span>
              <span className="text-[9px] font-mono text-telemetry-cyan animate-pulse">{currentStep || "INITIALIZING..."}</span>
            </div>
          )}

          {/* WAIT-CONFIRM banner */}
          {waitingForConfirm && (
            <div className="border border-yellow-400/30 bg-yellow-400/[0.05] rounded-sm px-3 py-2 text-center">
              <span className="text-[9px] font-mono text-yellow-400 animate-pulse">⏸ PAUSED — REVIEW CMAKE OUTPUT ABOVE, THEN CLICK PROCEED TO START COMPILATION</span>
            </div>
          )}

          {/* Build log */}
          <div ref={logRef} className="flex-1 min-h-0 overflow-y-auto border border-stealth-border/50 bg-black/40 rounded-sm p-2 font-mono text-[8px]">
            {logLines.length === 0 ? (
              <span className="text-stealth-muted/50">Initializing build pipeline...</span>
            ) : (
              logLines.map((entry, i) => {
                const isCmakeBox = entry.text.includes("═══════") || 
                  entry.text.startsWith("SET ") || 
                  entry.text.startsWith("cmake ");
                return (
                  <div key={i} className={`py-0.5 ${
                    entry.step === "ERROR" || entry.step === "FAIL" ? "text-red-400" :
                    entry.step === "WARNING" ? "text-yellow-400 font-bold" :
                    entry.step === "DONE" ? "text-nv-green" :
                    isCmakeBox ? "text-telemetry-cyan font-bold" :
                    entry.step.startsWith("INIT") || entry.step.startsWith("CLONE") || entry.step.startsWith("PULL") ? "text-telemetry-cyan/80" :
                    entry.step === "BUILD" ? "text-yellow-400/70" :
                    "text-white/60"
                  }`}>
                    {!isCmakeBox && (
                      <>
                        <span className="text-stealth-muted/40">[{entry.timestamp}]</span>{" "}
                        <span className="text-stealth-muted/60">{entry.step.padEnd(10)}</span>{" "}
                      </>
                    )}
                    {entry.text}
                  </div>
                );
              })
            )}
          </div>

          {/* Error details */}
          {isError && logLines.length > 0 && (
            <p className="text-[8px] font-mono text-red-400/70 break-all">
              Last error: {logLines[logLines.length - 1].text}
            </p>
          )}

          {/* Success details */}
          {isComplete && (
            <p className="text-[8px] font-mono text-nv-green/70">
              Provider binary path has been updated to point to the new build output.
            </p>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-stealth-border">
          {waitingForConfirm && (
            <>
              <button onClick={handleCancel}
                className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
                REJECT — ABORT
              </button>
              <button onClick={handleConfirmProceed}
                className="px-4 py-1 text-[9px] font-mono border rounded-sm bg-nv-green/20 border-nv-green/60 text-nv-green hover:bg-nv-green/30 transition-all animate-pulse">
                PROCEED WITH BUILD
              </button>
            </>
          )}
          {!isComplete && !isError && !waitingForConfirm && (
            <button onClick={handleCancel}
              className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
              CANCEL BUILD
            </button>
          )}
          {isComplete && (
            <button onClick={onClose}
              className="px-3 py-1 text-[9px] font-mono border border-nv-green/60 text-nv-green hover:bg-nv-green/20 transition-colors">
              CLOSE
            </button>
          )}
          {isError && (
            <button onClick={onClose}
              className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
              CLOSE
            </button>
          )}
          {!isComplete && !isError && (
            <button onClick={() => onMinimize?.()}
              className="px-3 py-1 text-[9px] font-mono border border-stealth-border text-stealth-muted hover:text-white transition-colors">
              MINIMIZE TO STATUS BAR
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
