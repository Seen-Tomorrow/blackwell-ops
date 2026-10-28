import { useMemo } from "react";
import { useFoundry } from "../hooks/useFoundry";
import { ENV_META, normalizeBinaryProfile } from "../lib/foundry_constants";
import { phaseLabel } from "../lib/foundryPhases";

/**
 * FOUNDRY → LOG — the full captured configure + compile output.
 *
 * The build view no longer shows log lines; this tab is the single place to read
 * them. It opens at the top (configure first) and never auto-scrolls, so the user
 * can inspect the beginning while the build is still writing.
 */
export default function FoundryLogView() {
  const { buildLog, buildProgress } = useFoundry();

  const logText = useMemo(
    () => buildLog
      .map((entry) => `[${entry.timestamp}] ${entry.step.padEnd(10)} ${entry.text}`)
      .join("\n"),
    [buildLog],
  );

  const env = buildProgress
    ? ENV_META[normalizeBinaryProfile(buildProgress.environment)].label
    : "";
  const phase = buildProgress ? phaseLabel(buildProgress.step) : "";

  return (
    <section className="fnd-log-view">
      <div className="fnd-log-view__head">
        <span className="fnd-log-view__title">BUILD LOG</span>
        {buildProgress ? (
          <span className="fnd-log-view__meta">
            {env} · {phase}
            {buildProgress.buildId ? ` · BUILD ${buildProgress.buildId}` : ""}
          </span>
        ) : (
          <span className="fnd-log-view__meta">NO BUILD</span>
        )}
        <span className="fnd-log-view__count">{buildLog.length} LINES</span>
      </div>

      {buildLog.length > 0 ? (
        <pre className="foundry-build-log fnd-log-view__pre">{logText}</pre>
      ) : (
        <p className="fnd-log-view__empty">
          {buildProgress
            ? "Waiting for the first build output…"
            : "No build log yet. Start a build from BUILD."}
        </p>
      )}
    </section>
  );
}
