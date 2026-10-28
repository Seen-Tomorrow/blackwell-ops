import { useFoundry } from "../hooks/useFoundry";
import { useCompileElapsed } from "../hooks/useCompileElapsed";
import { useCompileEta } from "../hooks/useCompileEta";
import { isCompileStep, phaseKey, phaseLabel } from "../lib/foundryPhases";
import {
  formatEdgeCounter,
  formatEta,
  overallPercent,
} from "../lib/foundryProgress";
import { ENV_META, normalizeBinaryProfile } from "../lib/foundry_constants";

const STAGE_RAIL = ["REPO", "CONFIGURE", "BUILD", "VALIDATE", "PUBLISH"] as const;

function railIndex(percent: number): number {
  if (percent >= 99) return 4;
  if (percent >= 96) return 3;
  if (percent >= 24) return 2;
  if (percent >= 18) return 1;
  return 0;
}

interface FoundryBuildViewProps {
  /** Open the FOUNDRY → LOG sub-tab; the inline drawer is gone. */
  onOpenLog?: () => void;
}

/**
 * Live build/result view on the FOUNDRY page.
 *
 * Progress, result and actions only. The full configure/compile log lives in the
 * LOG sub-tab, provider-owned so leaving the page never loses it.
 */
export default function FoundryBuildView({ onOpenLog }: FoundryBuildViewProps) {
  const {
    buildProgress,
    buildLog,
    compileStartedAt,
    confirmConfigure,
    cancelBuild,
    dismissBuild,
  } = useFoundry();

  const step = buildProgress?.step ?? "initializing";
  const key = phaseKey(step);
  const waiting = key === "waiting-confirm";
  const complete = key === "complete";
  const failed = key === "error";
  const starting = Boolean(buildProgress) && !buildProgress?.buildId;
  const compiling = isCompileStep(step);
  const compileActive = compiling && !waiting && !complete && !failed;
  const env = normalizeBinaryProfile(buildProgress?.environment);
  const envLabel = ENV_META[env].label;
  const edge = buildProgress?.progress ?? null;
  const counter = formatEdgeCounter(edge);
  const percent = Math.max(0, Math.min(100, overallPercent(step, edge)));
  const eta = useCompileEta(edge, compileActive);
  const etaLabel = eta != null && eta > 0.5 ? formatEta(eta) : null;
  const elapsed = useCompileElapsed(compileStartedAt, compileActive, complete || failed);
  const queue = buildProgress?.queuedEnvironments ?? [];
  const queueLabel = queue
    .map((queued) => ENV_META[normalizeBinaryProfile(queued)].label)
    .join(" + ");

  const stage = starting
    ? "STARTING"
    : complete
      ? "DONE"
      : failed
        ? "FAILED"
        : waiting
          ? "REVIEW"
          : phaseLabel(step);

  return (
    <section className="fnd-build-view">
      <div className="fnd-build-view__head">
        <span className="fnd-build-view__env">{envLabel}</span>
        <span className="fnd-build-view__provider">{buildProgress?.providerId}</span>
        {queueLabel && <span className="fnd-build-view__next">NEXT {queueLabel}</span>}
        {onOpenLog && (
          <button type="button" className="fnd-build-view__log-link" onClick={onOpenLog}>
            LOG · {buildLog.length}
          </button>
        )}
      </div>

      {complete ? (
        <div className="fnd-complete-plate" role="status" aria-live="polite">
          <span className="fnd-complete-plate__icon" aria-hidden>✓</span>
          <span className="fnd-complete-plate__body">
            <span className="fnd-complete-plate__kicker">ENGINE BUILD COMPLETE</span>
            <span className="fnd-complete-plate__title">SET AS THE ACTUAL SOURCE</span>
            <span className="fnd-complete-plate__meta">
              {envLabel} · BUILD {buildProgress?.buildId ?? "—"} · {buildProgress?.providerId}
            </span>
          </span>
          <span className="fnd-complete-plate__stamp" aria-hidden>FOUNDRY</span>
        </div>
      ) : failed ? (
        <div className="fnd-fail-plate" role="alert">
          <span className="fnd-fail-plate__title">✖ BUILD FAILED</span>
          <span className="fnd-fail-plate__meta">
            {envLabel} · {buildProgress?.providerId}
          </span>
        </div>
      ) : (
        <div className="fnd-hero fnd-build-view__hero">
          <div className="fnd-hero__top">
            <span className="fnd-hero__stage">
              <span className="fnd-hero__kicker">STAGE</span>
              <span className="fnd-hero__stage-label">{stage}</span>
            </span>
            <span className="fnd-hero__pct">
              {Math.round(percent)}
              <span className="fnd-hero__pct-unit">%</span>
            </span>
          </div>

          <div
            className="fnd-hero__bar"
            role="progressbar"
            aria-label="Build progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(percent)}
          >
            <span className="fnd-hero__fill" style={{ width: `${percent}%` }} />
          </div>

          <div className="fnd-hero__meta">
            <span className="fnd-hero__counter">{counter ?? "—"}</span>
            {edge?.kind && <span className="fnd-hero__kind">{edge.kind}</span>}
            <span className="fnd-hero__eta">
              {etaLabel ? `~${etaLabel} LEFT` : compileActive ? "ESTIMATING…" : "WAITING"}
            </span>
            <span className="fnd-hero__timer">{elapsed}</span>
          </div>

          {edge?.label && (
            <p className="fnd-hero__file" title={edge.label}>{edge.label}</p>
          )}

          <ol className="fnd-stage-rail" aria-label="Build stages">
            {STAGE_RAIL.map((label, index) => {
              const state = index < railIndex(percent) ? "done" : index === railIndex(percent) ? "active" : "pending";
              return (
                <li
                  key={label}
                  className={`fnd-stage-rail__step fnd-stage-rail__step--${state}`}
                  aria-current={index === railIndex(percent) ? "step" : undefined}
                >
                  <span className="fnd-stage-rail__dot" aria-hidden />
                  <span className="fnd-stage-rail__label">{label}</span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {waiting && (
        <div className="fnd-build-pause">
          <span className="fnd-build-pause__text">
            Configure finished. Review the LOG tab, then start the compile.
          </span>
          <button type="button" className="fnd-form__build" onClick={() => void confirmConfigure()}>
            BUILD NOW
          </button>
        </div>
      )}

      {failed && buildLog.length > 0 && (
        <p className="fnd-build-last-error">Last error: {buildLog[buildLog.length - 1].text}</p>
      )}

      <div className="fnd-build-view__actions">
        <span className="fnd-build-view__hint">
          Leave this page anytime — the build keeps running in the FOUNDRY tab.
        </span>
        {waiting ? (
          <button type="button" className="fnd-form__btn" onClick={() => void cancelBuild()}>
            CANCEL BUILD
          </button>
        ) : complete || failed ? (
          <>
            <button type="button" className="fnd-form__btn" onClick={() => void dismissBuild()}>
              DISMISS
            </button>
            <button type="button" className="fnd-form__build" onClick={() => void dismissBuild()}>
              BUILD AGAIN
            </button>
          </>
        ) : (
          <button type="button" className="fnd-form__btn fnd-form__btn--danger" onClick={() => void cancelBuild()}>
            CANCEL BUILD
          </button>
        )}
      </div>
    </section>
  );
}
