import React, { useEffect, useRef, useState } from "react";
import type { ProviderConfig } from "../lib/types";
import FoundryWindowShell, { type FoundryWindowTone } from "./FoundryWindowShell";
import { getStepLabel, type Env } from "../lib/foundry_constants";
import { useFoundry } from "../hooks/useBuildDock";
import {
  ETA_WINDOW_MS,
  etaAnchor,
  etaRemaining,
  formatEdgeCounter,
  formatEta,
  overallPercent,
  pushSamples,
  type EtaAnchor,
  type EdgeSample,
} from "../lib/foundryProgress";

interface BuildLogEntry {
  step: string;
  text: string;
  timestamp: string;
}

interface FoundryBuildProgressProps {
  provider: ProviderConfig;
  environment: Env;
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

  // Compile progress comes straight from the dock context: the modal already receives
  // `buildProgress`, and adding a prop here would mean another wire through it.
  const { buildProgress } = useFoundry();
  const edge = buildProgress?.progress ?? null;
  const samplesRef = useRef<EdgeSample[]>([]);
  const etaAnchorRef = useRef<EtaAnchor | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const edgeDone = edge?.done ?? null;
  const edgeTotal = edge?.total ?? null;

  useEffect(() => {
    if (edgeDone == null || edgeTotal == null || edgeTotal <= 0) {
      samplesRef.current = [];
      etaAnchorRef.current = null;
      setEta(null);
      return;
    }
    const now = Date.now();
    samplesRef.current = pushSamples(
      samplesRef.current,
      { t: now, done: edgeDone, total: edgeTotal },
      ETA_WINDOW_MS,
    );
    etaAnchorRef.current = etaAnchor(samplesRef.current);
    setEta(etaRemaining(etaAnchorRef.current, now));
  }, [edgeDone, edgeTotal]);

  // Count the anchor down while the counter stands still: a single fatbin instance can
  // compile for minutes, and dropping the number there was a bug, not honesty. The
  // estimate only disappears once it is actually spent (or when there is none yet).
  useEffect(() => {
    if (edgeTotal == null || isComplete || isError) return;
    const id = window.setInterval(() => {
      setEta(etaRemaining(etaAnchorRef.current, Date.now()));
    }, 2000);
    return () => window.clearInterval(id);
  }, [edgeTotal, isComplete, isError]);

  // The log is noise while the compile runs, and the only thing worth reading during
  // configure / the build gate / a failure. Follow the phase by default; a manual
  // toggle sticks until the next phase change.
  const stepKey = (currentStep || "").toLowerCase();
  const compiling = stepKey === "building" || stepKey === "validating";
  const [logOpen, setLogOpen] = useState(() => !compiling);

  useEffect(() => {
    setLogOpen(waitingForConfirm || isError || !compiling);
  }, [waitingForConfirm, isError, compiling]);

  useEffect(() => {
    if (effectiveLogRef.current) {
      effectiveLogRef.current.scrollTop = effectiveLogRef.current.scrollHeight;
    }
  }, [logLines, logOpen, effectiveLogRef]);

  const edgeCounter = formatEdgeCounter(edge);
  const edgePercent = Math.max(0, Math.min(100, overallPercent(currentStep, edge)));
  const etaLabel = eta != null && eta > 0.5 ? formatEta(eta) : null;
  const showEdgeBar = Boolean(edgeCounter) && !isComplete && !isError;

  const tone: FoundryWindowTone = isComplete ? "green" : isError ? "red" : "amber";
  const title = isComplete
    ? "✓ BUILD COMPLETE"
    : isError
      ? "✖ BUILD FAILED"
      : edgeCounter
        ? `● BUILDING… ${edgeCounter}`
        : "● BUILDING…";

  const footer = waitingForConfirm ? (
    <>
      <button onClick={onCancel}
        className="fnd-build-btn fnd-build-btn--danger px-3 py-1 font-mono transition-colors">
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
        className="fnd-build-btn fnd-build-btn--danger px-3 py-1 font-mono transition-colors">
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
        className="fnd-build-btn fnd-build-btn--danger px-3 py-1 font-mono transition-colors">
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
      autoHeight={!logOpen}
      onMinimize={onMinimize}
      headerExtra={(
        <span className="foundry-env-badge px-1.5 py-0.5 type-tiny font-mono rounded-sm">
          {environment.toUpperCase()}
        </span>
      )}
      footer={footer}
    >
      <div className="fnd-build-panel px-4 py-3 space-y-2 flex flex-col h-full min-h-0">
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

        {showEdgeBar && (
          <div className="fnd-edge">
            <div className="fnd-edge__meta font-mono">
              <span className="fnd-edge__counter type-tiny">{edgeCounter}</span>
              {edge?.kind && <span className="fnd-edge__kind type-micro">{edge.kind}</span>}
              {etaLabel && <span className="fnd-edge__eta type-micro">~{etaLabel} LEFT</span>}
            </div>
            <div
              className="fnd-edge__track"
              role="progressbar"
              aria-label="Compile progress"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(edgePercent)}
            >
              <span className="fnd-edge__fill" style={{ width: `${edgePercent}%` }} />
            </div>
            {edge?.label && (
              <span className="fnd-edge__label type-micro font-mono" title={edge.label}>
                {edge.label}
              </span>
            )}
          </div>
        )}

        {waitingForConfirm && (
          <div className="fnd-build-pause rounded-sm px-3 py-2 text-center">
            <span className="fnd-build-pause__text type-body font-mono animate-pulse">⏸ PAUSED — REVIEW THE CONFIGURATION, THAN REJECT OR BUILD.</span>
          </div>
        )}

        <button
          type="button"
          className="fnd-logbar font-mono"
          onClick={() => setLogOpen(open => !open)}
          aria-expanded={logOpen}
          title={logOpen ? "Hide build log" : "Show build log"}
        >
          <span className="fnd-logbar__title type-micro">LOG</span>
          <span className="fnd-logbar__count type-micro">{logLines.length} LINES</span>
          <span className="fnd-logbar__action type-micro">{logOpen ? "HIDE ▾" : "SHOW ▸"}</span>
        </button>

        {logOpen && (
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
        )}

        {isError && logLines.length > 0 && (
          <p className="fnd-build-last-error type-label font-mono break-all m-0">
            Last error: {logLines[logLines.length - 1].text}
          </p>
        )}

        {isComplete && (
          <p className="fnd-build-ready type-label font-mono m-0">
            ENGINE build and set as the actual source.
          </p>
        )}
      </div>
    </FoundryWindowShell>
  );
}