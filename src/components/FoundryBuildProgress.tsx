import React, { useEffect, useRef } from "react";
import type { ProviderConfig } from "../lib/types";
import FoundryWindowShell, { type FoundryWindowTone } from "./FoundryWindowShell";
import { getStepLabel } from "../lib/foundry_constants";

interface BuildLogEntry {
  step: string;
  text: string;
  timestamp: string;
}

interface FoundryBuildProgressProps {
  provider: ProviderConfig;
  environment: "frontier" | "stable";
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

  useEffect(() => {
    if (effectiveLogRef.current) {
      effectiveLogRef.current.scrollTop = effectiveLogRef.current.scrollHeight;
    }
  }, [logLines, effectiveLogRef]);

  const tone: FoundryWindowTone = isComplete ? "green" : isError ? "red" : "amber";
  const title = isComplete
    ? "✓ BUILD COMPLETE"
    : isError
      ? "✖ BUILD FAILED"
      : "● BUILDING…";

  const footer = waitingForConfirm ? (
    <>
      <button onClick={onCancel}
        className="fnd-build-btn--danger px-3 py-1 font-mono transition-colors">
        REJECT — ABORT
      </button>
      <button
        type="button"
        onClick={onConfirmProceed}
        className="foundry-confirm-build-btn animate-pulse"
      >
        BUILD THE ENGINE
      </button>
    </>
  ) : !isComplete && !isError ? (
    <>
      <button onClick={onCancel}
        className="fnd-build-btn--danger px-3 py-1 font-mono transition-colors">
        CANCEL BUILD
      </button>
      <button type="button" onClick={onMinimize} className="foundry-minimize-btn">
        MINIMIZE TO STATUS BAR
      </button>
    </>
  ) : isComplete ? (
    <button onClick={onClose}
      className="fnd-build-btn px-3 py-1 font-mono transition-colors">
      CLOSE
    </button>
  ) : (
    <div className="flex flex-col items-end gap-0.5">
      <button onClick={onClose}
        className="fnd-build-btn--danger px-3 py-1 font-mono transition-colors">
        HIDE WINDOW
      </button>
      <span className="fnd-build-note--danger type-micro font-mono text-right leading-none">
        Only hides — failed attempt remains.<br />Start a new build to reset.
      </span>
    </div>
  );

  return (
    <FoundryWindowShell
      title={title}
      tone={tone}
      variant="build"
      onMinimize={onMinimize}
      headerExtra={(
        <span className="foundry-env-badge px-1.5 py-0.5 type-tiny font-mono rounded-sm">
          {environment.toUpperCase()}
        </span>
      )}
      footer={footer}
    >
      <div className="px-4 py-3 space-y-2 flex flex-col h-full min-h-0">
        <p className="fnd-build-provider type-body font-mono m-0">
          <span className="fnd-build-provider__id">{provider.id}</span> &mdash; {provider.display_name}
        </p>

        {!isComplete && !isError && (
          <div className="flex items-center gap-2">
            <span className="fnd-build-step-label type-label font-mono uppercase tracking-wider">Step:</span>
            <span className="fnd-build-step type-body font-mono animate-pulse">
              {currentStep ? getStepLabel(currentStep) : "INITIALIZING..."}
            </span>
          </div>
        )}

        {waitingForConfirm && (
          <div className="fnd-build-pause rounded-sm px-3 py-2 text-center">
            <span className="fnd-build-pause__text type-body font-mono animate-pulse">⏸ PAUSED — REVIEW CMAKE OUTPUT ABOVE, THEN CLICK BUILD THE ENGINE</span>
          </div>
        )}

        <div
          ref={effectiveLogRef}
          className="foundry-build-log flex-1 min-h-0 overflow-y-auto rounded-sm font-mono"
        >
          {logLines.length === 0 ? (
            <span className="foundry-build-log__idle">Initializing build pipeline...</span>
          ) : (
            logLines.slice(-200).map((entry, i) => {
              const isCmakeBox = entry.text.includes("═════") ||
                entry.text.startsWith("SET ") ||
                entry.text.startsWith("cmake ");
              const text = entry.text;
              const isErrorText =
                /\[ERROR\]|\[WARN\]\s*PATCH FAIL|PATCH FAIL/i.test(text);
              const isWarnText = /\[WARN\]/i.test(text) && !isErrorText;
              let lineTone = "foundry-build-log__line";
              if (entry.step === "ERROR" || entry.step === "FAIL" || isErrorText) {
                lineTone += " foundry-build-log__line--error";
              } else if (entry.step === "WARNING" || isWarnText) {
                lineTone += " foundry-build-log__line--warn";
              } else if (entry.step === "DONE") lineTone += " foundry-build-log__line--done";
              else if (isCmakeBox) lineTone += " foundry-build-log__line--cmake";
              else if (
                entry.step.startsWith("INIT") ||
                entry.step.startsWith("CLONE") ||
                entry.step.startsWith("PULL")
              ) {
                lineTone += " foundry-build-log__line--phase";
              } else if (entry.step === "BUILD" || entry.step === "CONFIGURE") {
                lineTone += " foundry-build-log__line--build";
              }

              return (
                <div key={i} className={`py-0.5 ${lineTone}`}>
                  {!isCmakeBox && (
                    <>
                      <span className="foundry-build-log__ts">[{entry.timestamp}]</span>{" "}
                      <span className="foundry-build-log__step">{entry.step.padEnd(10)}</span>{" "}
                    </>
                  )}
                  {entry.text}
                </div>
              );
            })
          )}
        </div>

        {isError && logLines.length > 0 && (
          <p className="fnd-build-last-error type-label font-mono break-all m-0">
            Last error: {logLines[logLines.length - 1].text}
          </p>
        )}

        {isComplete && (
          <p className="fnd-build-ready type-label font-mono m-0">
            Provider binaries build and READY TO USE.
          </p>
        )}
      </div>
    </FoundryWindowShell>
  );
}