/**
 * DEV-only DISTRIBUTION — release dashboard + plan runner.
 * Spec: docs/DISTRIBUTION-PANEL.md.
 *
 * Artifact state comes from get_distribution_state (staged vs published); every pack/ship
 * action is a ReleasePlan executed by the detached runner, never an ad-hoc action string.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isDevBuild } from "@/lib/build";
import { useDistributionSplitResize } from "@/hooks/useCatalogSplitResize";

type Tab = "app" | "engines" | "link" | "toolchain";

interface ArtifactStatus {
  id: string;
  kind: string;
  channel: string;
  label: string;
  version: string;
  build: string;
  staged: boolean;
  stagedBytes: number;
  stagedSha256: string;
  published: boolean;
  publishedVersion: string;
  publishedBuild: string;
  packedVersion: string;
  packedBuild: string;
  state: string;
  notes: string[];
}

interface Preflight {
  shipUnlocked: boolean;
  releaseExe: boolean;
  piPinned: string;
  foundryReady: string[];
  foundryMissing: string[];
}

interface ChannelStatus {
  tag: string;
  title: string;
  latestVersion: string;
  latestBuild: string;
}

interface JobStepStatus {
  id: string;
  label: string;
  state: string;
}

interface JobStatus {
  state: string;
  chain: string;
  message: string;
  updatedAt: string;
  providerId: string;
  profileId: string;
  logTail: string[];
  steps: JobStepStatus[];
  running: boolean;
}

interface JobSummary {
  id: string;
  startedAt: string;
  endedAt: string;
  result: string;
  summary: string;
}

interface DistributionState {
  appVersion: string;
  policyPath: string;
  artifacts: ArtifactStatus[];
  preflight: Preflight;
  channels: ChannelStatus[];
  job: JobStatus;
  history: JobSummary[];
}

interface PlannedJob {
  id: string;
  version: string;
  summary: string;
  steps: { id: string; label: string }[];
}

type Phase = "pack" | "ship";

interface ReleasePlan {
  artifacts: string[];
  phases: Phase[];
  bump: "none" | "patch";
  dryRun: boolean;
  allowRepair: boolean;
}

function formatMb(bytes: number): string {
  return bytes > 0 ? `${Math.round(bytes / (1024 * 1024))} MB` : "—";
}

function stateLabel(state: string): string {
  switch (state) {
    case "published":
      return "published";
    case "needs-pack":
      return "needs pack";
    case "needs-ship":
      return "needs ship";
    case "packed":
      return "staged";
    default:
      return "not packed";
  }
}

function Chip({ ok, label, title }: { ok: boolean; label: string; title?: string }) {
  return (
    <span className={`dist-chip${ok ? " dist-chip--ok" : " dist-chip--bad"}`} title={title}>
      {ok ? "✓" : "✕"} {label}
    </span>
  );
}

function ArtifactRow({
  artifact,
  checked,
  onToggle,
  children,
}: {
  artifact: ArtifactStatus;
  checked: boolean;
  onToggle: () => void;
  children?: React.ReactNode;
}) {
  const meta = [
    artifact.version || null,
    artifact.build || null,
    artifact.staged ? formatMb(artifact.stagedBytes) : null,
  ].filter(Boolean) as string[];
  const packed = artifact.packedBuild
    ? `packed ${[artifact.packedVersion, artifact.packedBuild].filter(Boolean).join(" ")}`
    : "";
  return (
    <div className={`dist-artifact${artifact.state === "published" ? " dist-artifact--published" : ""}`}>
      <label className="dist-artifact__check">
        <input type="checkbox" checked={checked} onChange={onToggle} />
      </label>
      <div className="dist-artifact__body min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="dist-artifact__label type-body font-mono">{artifact.label}</span>
          <span className={`dist-state dist-state--${artifact.state}`}>{stateLabel(artifact.state)}</span>
          <span className="dist-artifact__meta type-tiny font-mono">{meta.join(" · ")}</span>
        </div>
        <div className="dist-artifact__sub type-tiny font-mono">
          {artifact.published
            ? `channel: ${artifact.publishedVersion || "?"}${artifact.publishedBuild ? ` (${artifact.publishedBuild})` : ""}`
            : "channel: not published"}
          {packed ? ` · ${packed}` : ""}
          {artifact.notes.length > 0 ? ` — ${artifact.notes[0]}` : ""}
        </div>
      </div>
      {children && <div className="dist-artifact__actions flex gap-1 shrink-0">{children}</div>}
    </div>
  );
}

export default function DistributionDevPanel() {
  const [dash, setDash] = useState<DistributionState | null>(null);
  const [tab, setTab] = useState<Tab>("app");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bump, setBump] = useState(true);
  const [dryRun, setDryRun] = useState(false);
  const [busy, setBusy] = useState(false);
  /** True only after run_release_plan returned — polling earlier reads the *previous* job
   *  and can stop on "idle" while the new plan is still being built. */
  const [pollJob, setPollJob] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [planned, setPlanned] = useState<PlannedJob | null>(null);
  /** Server-computed plan for the current selection (same validation as the run). */
  const [preview, setPreview] = useState<PlannedJob | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const logRef = useRef<HTMLPreElement>(null);
  const { containerRef, panelWidth, isDragging, startDrag, resetWidth } =
    useDistributionSplitResize();

  const job = dash?.job ?? null;

  const refresh = useCallback(async (force = false) => {
    if (!isDevBuild()) return;
    try {
      const next = await invoke<DistributionState>("get_distribution_state", { force });
      setDash(next);
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh(false);
  }, [refresh]);

  const idlePollsRef = useRef(0);

  // Poll the job only after the plan has been spawned; refresh the dashboard when it ends.
  useEffect(() => {
    if (!pollJob) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      try {
        const j = await invoke<JobStatus>("get_dev_release_job_status");
        if (cancelled) return;
        // A single "idle" read can be a status file being replaced; only a terminal state, or
        // three consecutive idle polls, may stop polling (that used to freeze a live job).
        if (j.running || j.state === "running") {
          idlePollsRef.current = 0;
          setDash((prev) => (prev ? { ...prev, job: j } : prev));
          return;
        }
        if (j.state !== "ok" && j.state !== "failed") {
          idlePollsRef.current += 1;
          if (idlePollsRef.current < 3) return;
        }
        setDash((prev) => (prev ? { ...prev, job: j } : prev));
        setPollJob(false);
        setBusy(false);
        await refresh(false);
      } catch {
        /* keep polling */
      }
    };
    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [pollJob, refresh]);

  // A job may already be running when the panel mounts (started before a reload).
  useEffect(() => {
    if (job?.running && !pollJob) {
      idlePollsRef.current = 0;
      setPollJob(true);
      setBusy(true);
    }
  }, [job?.running, pollJob]);

  const logLines = useMemo(
    () => (job?.logTail ?? []).filter((line) => !line.includes("@@STEP")),
    [job?.logTail],
  );

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [logLines.length]);

  const runPlan = useCallback(
    async (plan: ReleasePlan) => {
      setBusy(true);
      setPollJob(false);
      idlePollsRef.current = 0;
      setError(null);
      setPlanned(null);
      try {
        const plannedJob = await invoke<PlannedJob>("run_release_plan", { plan });
        setPlanned(plannedJob);
        // Seed the job immediately so the step strip appears before the first poll.
        setDash((prev) =>
          prev
            ? {
                ...prev,
                job: {
                  ...prev.job,
                  state: "running",
                  running: true,
                  message: plannedJob.summary,
                  steps: plannedJob.steps.map((s) => ({ ...s, state: "pending" })),
                },
              }
            : prev,
        );
        // Only now may polling start: before the spawn, get_dev_release_job_status still
        // describes the previous job and would report "idle", stopping the poller.
        setPollJob(true);
      } catch (e) {
        setError(typeof e === "string" ? e : String(e));
        setPollJob(false);
        setBusy(false);
      }
    },
    [],
  );

  const refreshLocalRel = useCallback(async () => {
    setBusy(true);
    setPollJob(false);
    idlePollsRef.current = 0;
    setError(null);
    setPlanned(null);
    try {
      const p = await invoke<PlannedJob>("run_local_rel_refresh");
      setPlanned(p);
      setDash((prev) =>
        prev
          ? {
              ...prev,
              job: {
                ...prev.job,
                state: "running",
                running: true,
                message: p.summary,
                steps: p.steps.map((s) => ({ ...s, state: "pending" })),
              },
            }
          : prev,
      );
      setPollJob(true);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
      setPollJob(false);
      setBusy(false);
    }
  }, []);

  const runInline = useCallback(
    async (action: string) => {
      setBusy(true);
      setError(null);
      try {
        await invoke("run_dev_release_action", { action: { action } });
        await refresh(false);
      } catch (e) {
        setError(typeof e === "string" ? e : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const artifactsByKind = useCallback(
    (kinds: string[]): ArtifactStatus[] =>
      (dash?.artifacts ?? []).filter((a) => kinds.includes(a.kind)),
    [dash],
  );

  const selectedArtifacts = useMemo(
    () => (dash?.artifacts ?? []).filter((a) => selected.has(a.id)),
    [dash, selected],
  );

  // Preview uses the server's own planner, so the shown steps/version guard cannot drift from
  // what run_release_plan will accept. Phases are "pack+ship"; a run with fewer phases re-checks.
  useEffect(() => {
    if (!dash || busy) return;
    const ids = selectedArtifacts.map((a) => a.id);
    if (ids.length === 0) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const bumpMode: "none" | "patch" =
      bump && ids.some((id) => id === "app" || id === "full") ? "patch" : "none";
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void invoke<PlannedJob>("preview_release_plan", {
        plan: {
          artifacts: ids,
          phases: ["pack", "ship"],
          bump: bumpMode,
          dryRun,
          allowRepair: false,
        },
      })
        .then((p) => {
          if (cancelled) return;
          setPreview(p);
          setPreviewError(null);
        })
        .catch((e) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(typeof e === "string" ? e : String(e));
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [dash, busy, selectedArtifacts, bump, dryRun]);

  const planText = useMemo(() => {
    if (!dash) return "";
    if (busy && job?.message) return "";
    if (previewError) return previewError;
    if (preview) return preview.summary;
    const ids = selectedArtifacts.map((a) => a.id);
    if (ids.length === 0) return "Select artifacts to pack or ship.";
    return `${ids.length} artifact(s) selected`;
  }, [dash, busy, job?.message, preview, previewError, selectedArtifacts]);

  const actionsFor = useCallback(
    (phases: Phase[]) => {
      const ids = selectedArtifacts.map((a) => a.id);
      if (ids.length === 0) return;
      const bumpMode: "none" | "patch" =
        bump && ids.some((id) => id === "app" || id === "full") ? "patch" : "none";
      void runPlan({ artifacts: ids, phases, bump: bumpMode, dryRun, allowRepair: false });
    },
    [selectedArtifacts, bump, dryRun, runPlan],
  );

  const runPreset = useCallback(
    (kind: "app" | "full" | "link") => {
      void runPlan({
        artifacts: [kind],
        phases: ["pack", "ship"],
        bump: kind === "link" ? "none" : "patch",
        dryRun,
        allowRepair: false,
      });
    },
    [dryRun, runPlan],
  );

  const runEngine = useCallback(
    (ids: string[], phases: Phase[]) => {
      if (ids.length === 0) return;
      void runPlan({ artifacts: ids, phases, bump: "none", dryRun, allowRepair: false });
    },
    [dryRun, runPlan],
  );

  if (!isDevBuild()) {
    return (
      <div className="p-4 type-body font-mono config-muted">
        Distribution tools are DEV-only.
      </div>
    );
  }

  const preflight = dash?.preflight;
  const engineRows = artifactsByKind(["engine"]);
  const selectedEngineIds = engineRows.filter((a) => selected.has(a.id)).map((a) => a.id);

  return (
    <div className="dist-panel flex h-full min-h-0 flex-col overflow-hidden">
      <header className="fnd-dev-header px-4 py-2.5 space-y-1.5 shrink-0">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex items-baseline gap-3 flex-wrap">
            <h2 className="text-xs font-mono theme-accent-text tracking-widest">DISTRIBUTION</h2>
            <span className="dist-version type-tiny font-mono">v{dash?.appVersion ?? "…"}</span>
            {(dash?.channels ?? []).map((c) => (
              <span key={c.tag} className="dist-channel type-tiny font-mono" title={c.title}>
                {c.tag} {c.latestVersion}
                {c.latestBuild ? ` · ${c.latestBuild}` : ""}
              </span>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void refresh(true)}
              className="value-chip fnd-dev-btn fnd-dev-btn--info-ghost type-label font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border disabled:opacity-40"
              title="Re-read staged files and channel manifests"
            >
              Refresh
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runInline("check_full")}
              className="value-chip fnd-dev-btn fnd-dev-btn--accent-ghost type-label font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border disabled:opacity-40"
              title="Run the full release check (foundry artifacts, pi pin)"
            >
              Check
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runInline("bump")}
              className="value-chip fnd-dev-btn fnd-dev-btn--accent-ghost type-label font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border disabled:opacity-40"
              title="Bump patch version only"
            >
              Bump
            </button>
          </div>
        </div>

        {preflight && (
          <div className="dist-preflight flex flex-wrap gap-1.5">
            <Chip ok={preflight.shipUnlocked} label="ship unlock" />
            <Chip ok={preflight.releaseExe} label="REL exe" />
            <Chip ok={!!preflight.piPinned} label={`pi ${preflight.piPinned || "?"}`} />
            <Chip
              ok={preflight.foundryMissing.length === 0}
              label={
                preflight.foundryMissing.length === 0
                  ? `foundry ${preflight.foundryReady.length}/${preflight.foundryReady.length}`
                  : `foundry missing ${preflight.foundryMissing.join(", ")}`
              }
              title={`Ready: ${preflight.foundryReady.join(", ") || "none"}`}
            />
          </div>
        )}

        {error && <p className="dist-error type-label font-mono">{error}</p>}
      </header>

      <div ref={containerRef} className="catalog-split-workspace flex flex-1 overflow-hidden min-h-0">
        <div className="dist-controls flex flex-col min-h-0 overflow-hidden" style={{ width: panelWidth }}>
          <nav className="dist-tabs flex gap-1 px-3 pt-2 pb-1 shrink-0">
            {(
              [
                ["app", "MAIN APP"],
                ["engines", "ENGINES"],
                ["link", "LINK"],
                ["toolchain", "TOOLCHAIN"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => {
                  setTab(id);
                  setSelected(new Set());
                }}
                className={`dist-tab type-tiny font-mono uppercase tracking-wider px-2 py-1 rounded-sm border${
                  tab === id ? " dist-tab--active" : ""
                }`}
              >
                {label}
              </button>
            ))}
          </nav>

          <div className="flex-1 overflow-y-auto px-3 py-2 space-y-2 eink-scrollbar">
            {tab === "app" && (
              <>
                <div className="dist-presets grid gap-2">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => runPreset("app")}
                    className="dist-preset"
                  >
                    <span className="dist-preset__title type-body font-mono uppercase tracking-wider">
                      App update
                    </span>
                    <span className="dist-preset__sub type-tiny font-mono">
                      bump → pack App .7z → ship app channel
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => runPreset("full")}
                    className="dist-preset"
                  >
                    <span className="dist-preset__title type-body font-mono uppercase tracking-wider">
                      Full release
                    </span>
                    <span className="dist-preset__sub type-tiny font-mono">
                      bump → engines → app + NSIS → ship app/full/engines
                    </span>
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => void refreshLocalRel()}
                    className="dist-preset dist-preset--local"
                    title="Build a REL exe and copy it + the EDGE artifact + factory template into the local portable install. No release is published."
                  >
                    <span className="dist-preset__title type-body font-mono uppercase tracking-wider">
                      Refresh local REL
                    </span>
                    <span className="dist-preset__sub type-tiny font-mono">
                      build REL → copy exe + EDGE + template + learned cache to the portable test install · no release
                    </span>
                  </button>
                </div>
                {artifactsByKind(["app", "full"]).map((a) => (
                  <ArtifactRow
                    key={a.id}
                    artifact={a}
                    checked={selected.has(a.id)}
                    onToggle={() => toggle(a.id)}
                  />
                ))}
              </>
            )}

            {tab === "engines" && (
              <>
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => runEngine(engineRows.map((a) => a.id), ["pack"])}
                    className="value-chip fnd-dev-btn fnd-dev-btn--accent-ghost type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
                  >
                    Pack all
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => runEngine(engineRows.map((a) => a.id), ["pack", "ship"])}
                    className="value-chip fnd-dev-btn fnd-dev-btn--accent type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
                  >
                    Pack+Ship all
                  </button>
                  <button
                    type="button"
                    disabled={busy || selectedEngineIds.length === 0}
                    onClick={() => runEngine(selectedEngineIds, ["pack", "ship"])}
                    className="value-chip fnd-dev-btn fnd-dev-btn--warn type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
                  >
                    Pack+Ship selected
                  </button>
                </div>
                {engineRows.map((a) => (
                  <ArtifactRow
                    key={a.id}
                    artifact={a}
                    checked={selected.has(a.id)}
                    onToggle={() => toggle(a.id)}
                  >
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => runEngine([a.id], ["pack"])}
                      className="dist-rowbtn type-tiny font-mono uppercase px-1.5 py-0.5 rounded-sm border disabled:opacity-40"
                    >
                      Pack
                    </button>
                    <button
                      type="button"
                      disabled={busy || !a.staged || a.state === "published"}
                      onClick={() => runEngine([a.id], ["ship"])}
                      className="dist-rowbtn type-tiny font-mono uppercase px-1.5 py-0.5 rounded-sm border disabled:opacity-40"
                      title={a.staged ? "Publish the staged pack" : "Nothing staged — pack first"}
                    >
                      Ship
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => runEngine([a.id], ["pack", "ship"])}
                      className="dist-rowbtn dist-rowbtn--accent type-tiny font-mono uppercase px-1.5 py-0.5 rounded-sm border disabled:opacity-40"
                    >
                      Pack+Ship
                    </button>
                  </ArtifactRow>
                ))}
                {engineRows.length === 0 && (
                  <p className="type-label font-mono config-muted">
                    No engine packs declared in this build's engines.json.
                  </p>
                )}
              </>
            )}

            {tab === "link" && (
              <div className="space-y-2">
                <p className="type-label font-mono config-muted leading-relaxed">
                  OYM-Link is its own product line. It still publishes to its legacy
                  <span className="font-mono"> link-v* </span>
                  tag until its client migrates to the <span className="font-mono">link</span> /{" "}
                  <span className="font-mono">link-setup</span> channels.
                </p>
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() =>
                      void runPlan({
                        artifacts: ["link"],
                        phases: ["pack"],
                        bump: "none",
                        dryRun,
                        allowRepair: false,
                      })
                    }
                    className="value-chip fnd-dev-btn fnd-dev-btn--accent-ghost type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
                  >
                    Pack link
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => runPreset("link")}
                    className="value-chip fnd-dev-btn fnd-dev-btn--accent type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
                  >
                    Pack+Ship link
                  </button>
                </div>
              </div>
            )}

            {tab === "toolchain" && (
              <div className="space-y-2">
                <p className="type-label font-mono config-muted leading-relaxed">
                  CUDA runtimes and Foundry build tools. Changes rarely; the installer and the
                  setup wizard normally cover it.
                </p>
                <div className="flex gap-1.5 flex-wrap">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => runEngine(["toolchain"], ["ship"])}
                    className="value-chip fnd-dev-btn fnd-dev-btn--warn type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
                  >
                    Ship toolchain
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => runEngine(["toolchain"], ["pack", "ship"])}
                    className="value-chip fnd-dev-btn fnd-dev-btn--accent-ghost type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
                  >
                    Build + ship
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="dist-actionbar shrink-0 px-3 py-2 space-y-1.5">
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <span className={`dist-plan type-tiny font-mono${previewError ? " dist-plan--error" : ""}`}>
                {planText}
              </span>
              <div className="flex items-center gap-2">
                <label className="dist-opt type-tiny font-mono">
                  <input
                    type="checkbox"
                    checked={bump}
                    onChange={(e) => setBump(e.target.checked)}
                  />{" "}
                  bump
                </label>
                <label className="dist-opt type-tiny font-mono">
                  <input
                    type="checkbox"
                    checked={dryRun}
                    onChange={(e) => setDryRun(e.target.checked)}
                  />{" "}
                  dry run
                </label>
              </div>
            </div>
            <div className="flex gap-1.5 flex-wrap">
              <button
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => actionsFor(["pack"])}
                className="value-chip fnd-dev-btn fnd-dev-btn--accent-ghost type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
              >
                Pack
              </button>
              <button
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => actionsFor(["ship"])}
                className="value-chip fnd-dev-btn fnd-dev-btn--accent-ghost type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
              >
                Ship
              </button>
              <button
                type="button"
                disabled={busy || selected.size === 0}
                onClick={() => actionsFor(["pack", "ship"])}
                className="value-chip fnd-dev-btn fnd-dev-btn--accent type-tiny font-mono uppercase px-2 py-1 rounded-sm border disabled:opacity-40"
              >
                Pack+Ship
              </button>
            </div>
          </div>
        </div>

        <div
          className={`catalog-split-handle${isDragging ? " is-dragging" : ""}`}
          onMouseDown={startDrag}
          onDoubleClick={resetWidth}
          role="separator"
          aria-orientation="vertical"
          title="Drag to resize · double-click to reset"
        />

        <section className="dist-output flex-1 flex flex-col min-w-0 min-h-0">
          <div className="dist-jobbar px-3 py-1.5 flex items-center justify-between gap-2 shrink-0">
            <span className="type-tiny font-mono uppercase tracking-wider">
              Job · {job?.state ?? "idle"}
              {job?.running ? ` · ${job.message}` : planned ? ` · ${planned.summary}` : ""}
            </span>
            <span className="type-tiny font-mono dist-muted">
              {job?.updatedAt ? new Date(job.updatedAt).toLocaleTimeString() : ""}
            </span>
          </div>

          {(job?.steps?.length ?? 0) > 0 && (
            <div className="dist-steps flex flex-wrap gap-1 px-3 py-1.5 shrink-0">
              {job?.steps.map((s) => (
                <span key={s.id} className={`dist-step dist-step--${s.state}`} title={s.label}>
                  {s.state === "ok" ? "✓" : s.state === "failed" ? "✕" : s.state === "running" ? "●" : "○"}{" "}
                  {s.label}
                </span>
              ))}
            </div>
          )}

          <pre ref={logRef} className="dist-log flex-1 min-h-0 overflow-auto type-tiny font-mono px-3 py-2 whitespace-pre-wrap eink-scrollbar">
            {logLines.length > 0 ? logLines.join("\n") : "(no job output yet)"}
          </pre>

          <div className="dist-history px-3 py-1.5 shrink-0">
            <div className="type-tiny font-mono uppercase tracking-wider dist-muted mb-1">
              Recent
            </div>
            <div className="space-y-0.5">
              {(dash?.history ?? []).slice(0, 5).map((h) => (
                <div key={h.id} className="type-tiny font-mono flex gap-2">
                  <span className={`dist-hist dist-hist--${h.result}`}>{h.result}</span>
                  <span className="truncate">{h.summary || h.id}</span>
                </div>
              ))}
              {(dash?.history?.length ?? 0) === 0 && (
                <span className="type-tiny font-mono dist-muted">no jobs yet</span>
              )}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
