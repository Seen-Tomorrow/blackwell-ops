import { useFoundry } from "../hooks/useFoundry";
import { useCompileElapsed } from "../hooks/useCompileElapsed";
import { useCompileEta } from "../hooks/useCompileEta";
import { ENV_META, normalizeBinaryProfile } from "../lib/foundry_constants";
import { isCompileStep, phaseKey, phaseLabel } from "../lib/foundryPhases";
import { formatEdgeCounter, formatEta, overallPercent } from "../lib/foundryProgress";

/**
 * Rich FOUNDRY primary-nav segment content.
 *
 * The segment is permanently wide (see `.app-header__primary-option--foundry`), so
 * the background process can show env, stage/counter, percent, timer and a progress
 * bar without resizing the whole switch. Idle it reads FOUNDRY / NO BUILD.
 */
export default function FoundryNavBadge() {
  const { buildProgress, compileStartedAt } = useFoundry();

  const key = buildProgress ? phaseKey(buildProgress.step) : "idle";
  const complete = key === "complete";
  const failed = key === "error";
  const waiting = key === "waiting-confirm";
  const starting = Boolean(buildProgress) && !buildProgress?.buildId;
  const edge = buildProgress?.progress ?? null;
  const compileActive =
    Boolean(buildProgress) &&
    isCompileStep(buildProgress?.step ?? "") &&
    !waiting &&
    !complete &&
    !failed;
  // Hooks must run unconditionally, before the idle early-return.
  const eta = useCompileEta(edge, compileActive);
  const elapsed = useCompileElapsed(compileStartedAt, compileActive, complete || failed);

  if (!buildProgress) {
    return (
      <span className="fnd-nav-badge fnd-nav-badge--idle">
        <span className="fnd-nav-badge__name">FOUNDRY</span>
        <span className="fnd-nav-badge__idle">NO BUILD</span>
      </span>
    );
  }

  const env = normalizeBinaryProfile(buildProgress.environment);
  const envLabel = ENV_META[env].label;
  const counter = formatEdgeCounter(edge);
  const percent = complete
    ? 100
    : Math.max(0, Math.min(100, overallPercent(buildProgress.step, edge)));
  const etaLabel = eta != null && eta > 0.5 ? formatEta(eta) : null;
  const queue = buildProgress.queuedEnvironments
    .map((queued) => ENV_META[normalizeBinaryProfile(queued)].label)
    .join(" + ");

  if (starting) {
    return (
      <span className="fnd-nav-badge fnd-nav-badge--starting">
        <span className="fnd-nav-badge__name">FOUNDRY</span>
        <span className="fnd-nav-badge__idle">STARTING…</span>
      </span>
    );
  }

  const stage = complete
    ? "DONE"
    : failed
      ? "FAILED"
      : waiting
        ? "REVIEW"
        : phaseLabel(buildProgress.step);
  const tone = complete ? "done" : failed ? "error" : waiting ? "paused" : "active";

  return (
    <span
      className={`fnd-nav-badge fnd-nav-badge--${tone}`}
      title={[
        `${envLabel} · ${stage}`,
        counter ? `${counter} edges` : null,
        etaLabel ? `~${etaLabel} left` : null,
        queue ? `next ${queue}` : null,
        buildProgress.providerId,
      ].filter(Boolean).join(" · ")}
    >
      <span className="fnd-nav-badge__top">
        <span className="fnd-nav-badge__mark" aria-hidden>⚒</span>
        <span className="fnd-nav-badge__env">{envLabel}</span>
        <span className="fnd-nav-badge__stage">{stage}</span>
        {counter && <span className="fnd-nav-badge__counter">{counter}</span>}
        <span className="fnd-nav-badge__pct">{Math.round(percent)}%</span>
      </span>
      <span className="fnd-nav-badge__bottom">
        <span
          className="fnd-nav-badge__track"
          role="progressbar"
          aria-label="Build progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <span className="fnd-nav-badge__fill" style={{ width: `${percent}%` }} />
        </span>
        {etaLabel && <span className="fnd-nav-badge__eta">~{etaLabel}</span>}
        <span className="fnd-nav-badge__timer">{elapsed}</span>
      </span>
    </span>
  );
}
