import { useEffect, useRef, useState, type CSSProperties, type MouseEvent } from "react";
import type { BuildProgressState } from "../hooks/useBuildDock";
import { ENV_META, getStepLabel, normalizeBinaryProfile } from "../lib/foundry_constants";

const PHASE_PROGRESS: Record<string, number> = {
  init: 8,
  initializing: 8,
  clone: 18,
  pull: 26,
  "pr-cherry-pick": 34,
  configuring: 42,
  "waiting-confirm": 52,
  building: 72,
  validating: 88,
  complete: 100,
  error: 100,
  "backup-locked": 48,
};

const COMPILE_STEPS = new Set(["building", "validating"]);

function resolvePhaseProgress(step: string): number {
  return PHASE_PROGRESS[step] ?? 12;
}

function formatCompileElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

interface FoundryStatusChipProps {
  buildProgress: BuildProgressState;
  providerLabel: string;
  isMinimized: boolean;
  compileStartedAt: number | null;
  onClick: (event: MouseEvent<HTMLButtonElement>) => void;
}

export default function FoundryStatusChip({
  buildProgress,
  providerLabel,
  isMinimized,
  compileStartedAt,
  onClick,
}: FoundryStatusChipProps) {
  const [now, setNow] = useState(() => Date.now());
  const compileEndedAtRef = useRef<number | null>(null);

  const step = buildProgress.step;
  const stepLabel = getStepLabel(step);
  const envKey = normalizeBinaryProfile(buildProgress.environment);
  const envLabel = ENV_META[envKey].label;
  const progress = resolvePhaseProgress(step);
  const waitingConfirm = step === "waiting-confirm";
  const compileActive = COMPILE_STEPS.has(step);
  useEffect(() => {
    if (step === "complete" || step === "error") {
      if (compileStartedAt != null && compileEndedAtRef.current == null) {
        compileEndedAtRef.current = Date.now();
      }
      return;
    }
    compileEndedAtRef.current = null;
  }, [step, compileStartedAt]);

  useEffect(() => {
    if (!compileStartedAt || !compileActive) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [compileStartedAt, compileActive]);

  const timerLabel = !compileStartedAt
    ? "—:—"
    : formatCompileElapsed(
        (compileActive ? now : (compileEndedAtRef.current ?? now)) - compileStartedAt,
      );

  return (
    <button
      type="button"
      onClick={onClick}
      className={`foundry-status-chip${isMinimized ? " foundry-status-chip--minimized" : ""}${
        waitingConfirm ? " foundry-status-chip--paused" : ""
      }`}
      style={{ "--foundry-progress": `${progress}%` } as CSSProperties}
      title="Build progress — click to restore"
    >
      <span className="foundry-status-chip__glow" aria-hidden />
      <span className="foundry-status-chip__scan" aria-hidden />

      <span className="foundry-hammer-icon foundry-hammer-icon--forge" aria-hidden>
        ⚒
      </span>

      {isMinimized ? (
        <span className="foundry-status-chip__body">
          <span className="foundry-status-chip__row foundry-status-chip__row--title">
            <span className="foundry-status-chip__kicker">FOUNDRY BUILD</span>
            <span className="foundry-status-chip__env">{envLabel}</span>
          </span>
          <span className="foundry-status-chip__row foundry-status-chip__row--detail">
            <span className="foundry-status-chip__step">{stepLabel}</span>
            <span
              className={`foundry-status-chip__timer${
                compileActive ? " foundry-status-chip__timer--live" : ""
              }`}
            >
              {timerLabel}
            </span>
          </span>
          <span className="foundry-status-chip__provider">{providerLabel}</span>
        </span>
      ) : (
        <span className="foundry-status-chip__label">{stepLabel}…</span>
      )}

      {isMinimized ? (
        <span className="foundry-status-chip__progress" aria-hidden>
          <span className="foundry-status-chip__progress-fill" />
          <span className="foundry-status-chip__progress-shine" />
        </span>
      ) : null}
    </button>
  );
}