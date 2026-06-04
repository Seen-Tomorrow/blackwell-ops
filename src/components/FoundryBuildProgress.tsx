import React, { useEffect, useRef } from "react";
import type { ProviderConfig } from "../lib/types";
import { getEnvColors } from "../lib/foundry_constants";

interface BuildLogEntry {
  step: string;
  text: string;
  timestamp: string;
}

interface FoundryBuildProgressProps {
  provider: ProviderConfig;
  environment: "vanguard" | "stable" | "fresh";
  logLines: BuildLogEntry[];
  currentStep: string;
  waitingForConfirm: boolean;
  isComplete: boolean;
  isError: boolean;
  onMinimize: () => void;
  onClose: () => void;
  onCancel: () => void;
  onConfirmProceed: () => void;
  logRef?: React.RefObject<HTMLDivElement>;
}

export default function FoundryBuildProgress({
  provider,
  environment,
  logLines,
  currentStep,
  waitingForConfirm,
  isComplete,
  isError,
  onMinimize,
  onClose,
  onCancel,
  onConfirmProceed,
  logRef,
}: FoundryBuildProgressProps) {
  const internalLogRef = useRef<HTMLDivElement>(null);
  const effectiveLogRef = logRef || internalLogRef;

  const envColors = (base: string): string => {
    return getEnvColors(environment)[base as keyof ReturnType<typeof getEnvColors>] || "";
  };

  // Auto-scroll
  useEffect(() => {
    if (effectiveLogRef.current) {
      effectiveLogRef.current.scrollTop = effectiveLogRef.current.scrollHeight;
    }
  }, [logLines, effectiveLogRef]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className={`w-[75vw] max-w-[960px] border rounded-sm shadow-2xl flex flex-col ${
        isComplete ? "border-nv-green/40" : isError ? "border-red-400/40" : "border-yellow-400/40"
      }`} style={{ height: 'var(--dock-panel-height, 75vh)' }}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border">
          <div className="flex items-center gap-2">
            <span className={`text-[10px] font-mono tracking-wider ${
              isComplete ? "text-nv-green" : isError ? "text-red-400" : "text-yellow-400"
            }`}>
              {isComplete ? "✓ BUILD COMPLETE" : isError ? "✖ BUILD FAILED" : "● BUILDING..."}
            </span>
            <span className={`px-1.5 py-0.5 text-[8px] font-mono border rounded-sm ${envColors("border")}`}>
              {environment.toUpperCase()}
            </span>
          </div>
        </div>

        {/* Body */}
        <div className="px-4 py-3 space-y-2 flex flex-col flex-1 min-h-0 overflow-hidden">
          <p className="text-[9px] font-mono text-stealth-muted">
            <span className="text-yellow-400">{provider.id}</span> &mdash; {provider.display_name}
          </p>

          {!isComplete && !isError && (
            <div className="flex items-center gap-2">
              <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Step:</span>
              <span className="text-[9px] font-mono text-telemetry-cyan animate-pulse">{currentStep || "INITIALIZING..."}</span>
            </div>
          )}

          {waitingForConfirm && (
            <div className="border border-yellow-400/30 bg-yellow-400/[0.05] rounded-sm px-3 py-2 text-center">
              <span className="text-[9px] font-mono text-yellow-400 animate-pulse">⏸ PAUSED — REVIEW CMAKE OUTPUT ABOVE, THEN CLICK PROCEED TO START COMPILATION</span>
            </div>
          )}

          {/* Build log */}
          <div ref={effectiveLogRef} className="flex-1 min-h-0 overflow-y-auto border border-stealth-border/50 bg-black/40 rounded-sm p-2 font-mono text-[8px]">
            {logLines.length === 0 ? (
              <span className="text-stealth-muted/50">Initializing build pipeline...</span>
            ) : (
              // Cap at ~200 lines for memory safety (see FOUNDRY_DIRECTORY_STRUCTURE_MAP §7 and implementation plan)
              logLines.slice(-200).map((entry, i) => {
                const isCmakeBox = entry.text.includes("═════") ||
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

          {isError && logLines.length > 0 && (
            <p className="text-[8px] font-mono text-red-400/70 break-all">
              Last error: {logLines[logLines.length - 1].text}
            </p>
          )}

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
              <button onClick={onCancel}
                className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
                REJECT — ABORT
              </button>
              <button onClick={onConfirmProceed}
                className="px-4 py-1 text-[9px] font-mono border rounded-sm bg-nv-green/20 border-nv-green/60 text-nv-green hover:bg-nv-green/30 transition-all animate-pulse">
                PROCEED WITH BUILD
              </button>
            </>
          )}
          {!isComplete && !isError && !waitingForConfirm && (
            <button onClick={onCancel}
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
            <div className="flex flex-col items-end gap-0.5">
              <button onClick={onClose}
                className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
                HIDE WINDOW
              </button>
              <span className="text-[7px] font-mono text-red-400/50 text-right leading-none">
                Only hides — failed attempt remains.<br />Start a new build to reset.
              </span>
            </div>
          )}
          {!isComplete && !isError && (
            <button onClick={onMinimize}
              className="px-3 py-1 text-[9px] font-mono border border-stealth-border text-stealth-muted hover:text-white transition-colors">
              MINIMIZE TO STATUS BAR
            </button>
          )}
        </div>
      </div>
    </div>
  );
}