import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProviderConfig } from "../lib/types";

interface FoundryModalProps {
  provider: ProviderConfig;
  environment: "vanguard" | "stable" | "fresh";
  onClose: () => void;
}

interface BuildLogEntry {
  step: string;
  text: string;
  timestamp: string;
}

type ModalPhase = "confirm" | "building" | "complete" | "error";

export default function FoundryModal({ provider, environment, onClose }: FoundryModalProps) {
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
  const logRef = useRef<HTMLDivElement>(null);
  const cleanupRef = useRef<(() => void) | null>(null);

  const envColors = (base: string): string => {
    switch (environment) {
      case "vanguard": return base === "border" ? "border-cyan-400/60 text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/25" : base === "text" ? "text-cyan-400" : "bg-cyan-400/10 border-cyan-400/60";
      case "fresh": return base === "border" ? "border-amber-400/60 text-amber-400 bg-amber-400/10 hover:bg-amber-400/25" : base === "text" ? "text-amber-400" : "bg-amber-400/10 border-amber-400/60";
      default: return base === "border" ? "border-nv-green/60 text-nv-green bg-nv-green/10 hover:bg-nv-green/25" : base === "text" ? "text-nv-green" : "bg-nv-green/10 border-nv-green/60";
    }
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

          if (payload.log_line) {
            const logText = payload.log_line as string;
            
            // Detect cmake config preview box — show proceed button
            if (logText.includes("═══════")) {
              setWaitingForConfirm(true);
            }

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
              break;
            case "Failed":
              setPhase("error");
              break;
            default:
              if (phaseRef.current === "confirm") setPhase("building");
          }
        } catch {}
      });

      // Listen for toast events
      const unsubToast = await listen("foundry-toast", (e: any) => {
        if (!mounted) return;
        try {
          const payload = e.payload as any;
          if (!payload || !payload.text) return;
          
          showToast(payload.type, payload.text);
        } catch {}
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

  const getStepLabel = (step: string): string => {
    switch (step) {
      case "Initializing": return "INIT";
      case "GitClone": return "CLONE";
        case "GitPull": return "PULL";
        case "PrCherryPick": return "PR-MERGE";
        case "CMakeConfigure": return "CONFIGURE";
      case "Building": return "BUILD";
      case "Validating": return "VALIDATE";
      case "Complete": return "DONE";
      case "Failed": return "FAIL";
      default: return step;
    }
  };

  const showToast = (_type: string, _text: string) => {};

  const handleConfirmBuild = async () => {
    try {
      // Check for running engines that will be stopped by this build
      const stackStatus = await invoke<Array<{provider_type: string; status: string; alias: string; provider_name?: string; gpu: string}>>("get_stack_status");
      const matchingEngines = stackStatus.filter(
        e => e.provider_type === provider.id && e.status !== "IDLE"
      );

      if (matchingEngines.length > 0) {
        const engineList = matchingEngines.map(e => 
          `${e.alias} (${e.provider_name || e.provider_type}) on GPU ${e.gpu}`
        ).join("\n");

        setLogLines([{
          step: "WARNING",
          text: `The following running engines will be stopped before build:\n${engineList}\n\nProceed?`,
          timestamp: new Date().toLocaleTimeString(),
        }]);
      }

      await invoke("foundry_build", {
        providerId: provider.id,
        environment,
        prUrl: prUrl.trim() || null,
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

  // ── Confirmation Phase ─────────────────────────────────────────────
  if (phase === "confirm") {
    return (
      <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
        <div className="w-[60vw] max-w-[720px] border border-yellow-400/40 bg-stealth-panel rounded-sm shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border">
            <h3 className="text-xs font-mono text-yellow-400 tracking-wider">REACTOR FOUNDRY</h3>
            <button onClick={onClose} className="text-stealth-muted hover:text-white transition-colors text-sm leading-none">
              &times;
            </button>
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
            </div>

            {/* Warning */}
            <p className="text-[8px] font-mono text-yellow-400/70">
              This will compile llama.cpp from source. The build may take several minutes. Inference engines must be stopped before building.
            </p>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-stealth-border">
            <button onClick={onClose}
              className="px-3 py-1 text-[9px] font-mono border border-stealth-border text-stealth-muted hover:text-white transition-colors">
              CANCEL
            </button>
            <button onClick={handleConfirmBuild}
              className={`px-4 py-1 text-[9px] font-mono border rounded-sm transition-all ${envColors("border")}`}>
              YES — BUILD
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ── Building / Complete / Error Phase ──────────────────────────────
  const isComplete = phase === "complete";
  const isError = phase === "error";

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className={`w-[75vw] max-w-[960px] h-[75vh] border rounded-sm shadow-2xl flex flex-col ${
        isComplete ? "border-nv-green/40" : isError ? "border-red-400/40" : "border-yellow-400/40"
      }`}>
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
          <button onClick={onClose} className="text-stealth-muted hover:text-white transition-colors text-sm leading-none">
            &times;
          </button>
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
          <button onClick={onClose}
            className={`px-3 py-1 text-[9px] font-mono border transition-colors ${
              isComplete
                ? "border-nv-green/60 text-nv-green hover:bg-nv-green/20"
                : isError
                  ? "border-red-400/60 text-red-400 hover:bg-red-500/20"
                  : waitingForConfirm
                    ? "hidden"
                    : "border-stealth-border text-stealth-muted hover:text-white"
            }`}>
            {isComplete ? "CLOSE" : isError ? "CLOSE" : "MINIMIZE"}
          </button>
        </div>
      </div>
    </div>
  );
}
