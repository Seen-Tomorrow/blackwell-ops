/**
 * DEV-only: distribution policy + thin wrappers over Majestic pack/ship scripts.
 * Job output goes to the Tauri/cargo console (log::info) + a plain text panel log.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTauriListen } from "@/hooks/useTauriListen";
import { isDevBuild } from "@/lib/build";
import { dispatchAppEvent, EVENTS } from "@/lib/events";

export interface ProfileReadiness {
  profile: string;
  runtimeBinary: boolean;
  foundryArtifact: boolean;
  ready: boolean;
}

export interface ProviderDistributionRow {
  id: string;
  displayName: string;
  role: string;
  optionalDownload: boolean;
  factoryExists: boolean;
  profiles: string[];
  readiness: ProfileReadiness[];
  allReady: boolean;
  packCommands: string[];
  notes: string[];
}

export interface DistributionDashboard {
  policyPath: string;
  catalogPath: string;
  appVersion: string;
  nsisCore: Record<string, string[]>;
  plugins: Record<string, string[]>;
  providers: ProviderDistributionRow[];
  releaseJobRunning: boolean;
  workflowNotes: string[];
}

type ReleaseAction =
  | "bump"
  | "bump_pi"
  | "pack_app"
  | "ship_app"
  | "pack_full"
  | "ship_full"
  | "check_app"
  | "check_full"
  | "pack_provider"
  | "ship_provider"
  | "pack_ship_app"
  | "pack_ship_full"
  | "pack_ship_provider"
  | "pack_ship_all_providers";

function roleBadge(role: string): string {
  if (role === "core") return "fnd-dev-role-badge--core";
  if (role === "plugin") return "fnd-dev-role-badge--plugin";
  // local = Plugin OFF (shipping), still optional product on disk
  return "fnd-dev-role-badge--local";
}

function roleLabel(role: string): string {
  if (role === "core") return "core (NSIS)";
  if (role === "plugin") return "catalog ON";
  return "catalog OFF";
}

interface DevReleaseJobStatus {
  state: string;
  chain: string;
  message: string;
  updatedAt: string;
  providerId: string;
  profileId: string;
  logTail: string[];
  running: boolean;
}

export default function DistributionDevPanel() {
  const [dash, setDash] = useState<DistributionDashboard | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [logLines, setLogLines] = useState<string[]>([]);
  const [job, setJob] = useState<DevReleaseJobStatus | null>(null);
  /** True once we have observed a detached job as running — used to clear busy only on job end. */
  const sawJobRunningRef = useRef(false);

  const refresh = useCallback(async () => {
    if (!isDevBuild()) return;
    try {
      const d = await invoke<DistributionDashboard>("get_distribution_dashboard");
      setDash(d);
      setError(null);
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    }
  }, []);

  const pollJob = useCallback(async () => {
    if (!isDevBuild()) return null;
    try {
      const j = await invoke<DevReleaseJobStatus>("get_dev_release_job_status");
      setJob(j);
      if (j.logTail?.length) {
        setLogLines(j.logTail);
      }
      // Only drive busy from pack/ship job lifecycle — not idle status during Catalog toggle etc.
      if (j.running) {
        sawJobRunningRef.current = true;
        setBusy(true);
      } else if (sawJobRunningRef.current) {
        sawJobRunningRef.current = false;
        setBusy(false);
        void refresh();
      }
      return j;
    } catch {
      return null;
    }
  }, [refresh]);

  useEffect(() => {
    void refresh();
    void pollJob();
  }, [refresh, pollJob]);

  // Poll while busy (Pack click / spawn) or job.running. Depending only on
  // job.running missed completion until remount when the interval never started.
  useEffect(() => {
    if (!busy && !job?.running) return;
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      await pollJob();
    };

    void tick();
    const id = window.setInterval(() => {
      void tick();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [busy, job?.running, pollJob]);

  useTauriListen<{ line: string }>("dev-release-log", (payload) => {
    if (payload?.line) {
      setLogLines((prev) => [...prev.slice(-200), payload.line]);
    }
  });

  const setRole = useCallback(
    async (providerId: string, role: "plugin" | "local") => {
      setBusy(true);
      setError(null);
      try {
        const d = await invoke<DistributionDashboard>("set_provider_distribution", {
          input: { providerId, role },
        });
        setDash(d);
        dispatchAppEvent(EVENTS.reloadProviders);
      } catch (e) {
        setError(typeof e === "string" ? e : String(e));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const regenCatalog = useCallback(async () => {
    setBusy(true);
    try {
      const path = await invoke<string>("regenerate_distribution_catalog");
      setLogLines((p) => [...p, `Catalog regenerated: ${path}`]);
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : String(e));
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const runAction = useCallback(
    async (action: ReleaseAction, providerId?: string, profileId?: string) => {
      setBusy(true);
      setError(null);
      setLogLines((p) => [
        ...p,
        `--- ${action}${providerId ? ` ${providerId}/${profileId ?? ""}` : ""} ---`,
      ]);
      try {
        const result = await invoke<string>("run_dev_release_action", {
          action: {
            action,
            providerId: providerId ?? null,
            profileId: profileId ?? null,
          },
        });
        if (result === "detached") {
          setLogLines((p) => [
            ...p,
            "Detached job started — a Majestic console window should open. Polling job-log.txt …",
          ]);
          // Seed running so the poll effect keeps ticking even if the first status read lags.
          sawJobRunningRef.current = true;
          setJob((prev) => ({
            state: "running",
            chain: action,
            message: "Detached spawn returned",
            updatedAt: new Date().toISOString(),
            providerId: providerId ?? "",
            profileId: profileId ?? "",
            logTail: prev?.logTail ?? [],
            running: true,
          }));
          void pollJob();
          // busy stays true until poll sees job end
        } else {
          setLogLines((p) => [...p, `OK: ${action}`]);
          setBusy(false);
          await refresh();
          if (action === "bump") {
            setLogLines((p) => [
              ...p,
              "Version bumped — Pack+Ship App/Full will use the new tag. (Dev rebuild may pick up Cargo.toml on next cargo run.)",
            ]);
          } else if (action === "bump_pi") {
            setLogLines((p) => [
              ...p,
              "pi pinned to the DEV-installed (tested) version — Pack Full/App will embed it. Bundle should already be refreshed via Harness UPDATE.",
            ]);
          }
        }
      } catch (e) {
        const msg = typeof e === "string" ? e : String(e);
        setError(msg);
        setLogLines((p) => [...p, `FAIL: ${msg}`]);
        setBusy(false);
      }
    },
    [refresh, pollJob],
  );

  if (!isDevBuild()) {
    return (
      <div className="p-4 type-body font-mono config-muted">
        Distribution tools are DEV-only.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="fnd-dev-header px-4 py-3 space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xs font-mono theme-accent-text tracking-widest">DISTRIBUTION</h2>
            <p className="fnd-dev-desc type-body font-mono config-muted mt-1 max-w-2xl leading-relaxed">
              Pack+Ship opens a <span className="fnd-dev-desc__hl">visible Majestic console</span>{" "}
              (survives app restart / version bump). Full pack = multi-minute{" "}
              <span className="fnd-dev-desc__hl--dim">npm run release</span>. Log also in{" "}
              <span className="fnd-dev-desc__hl--dim">.majestic-out/job-log.txt</span>.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
              className="value-chip fnd-dev-action type-label font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm disabled:opacity-40"
            >
              Refresh
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void regenCatalog()}
              className="value-chip fnd-dev-action type-label font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm disabled:opacity-40"
            >
              Regen catalog
            </button>
          </div>
        </div>
        {dash && (
          <p className="fnd-dev-version type-tiny font-mono break-all">
            v{dash.appVersion} · policy: {dash.policyPath}
          </p>
        )}
      </div>

      {job?.running && (
        <p className="fnd-dev-job-running px-4 py-2 type-body font-mono">
          Job running: {job.chain}
          {job.message ? ` — ${job.message}` : ""} — watch the console window (not stuck on first
          log line).
        </p>
      )}
      {job && !job.running && job.state === "ok" && (
        <p className="fnd-dev-job-ok px-4 py-2 type-body font-mono">
          Last job OK: {job.chain}
        </p>
      )}
      {job && !job.running && job.state === "failed" && (
        <div className="fnd-dev-job-failed px-4 py-2 type-body font-mono space-y-1">
          <p>
            Last job FAILED: {job.chain} — {job.message}
          </p>
          <p className="fnd-dev-job-failed__note">
            Scroll the job log below (or open .majestic-out/job-log.txt). Retry after fixing the
            error.
          </p>
        </div>
      )}
      {error && (
        <p className="fnd-dev-error px-4 py-2 type-body font-mono">
          {error}
        </p>
      )}

      <div className="flex-1 overflow-auto px-4 py-4 space-y-5">
        <section className="space-y-2">
          <h3 className="fnd-dev-section-title type-body font-mono tracking-wider uppercase">
            Version
          </h3>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("bump")}
              className="fnd-dev-btn--warn type-body font-mono uppercase tracking-wider px-3 py-1.5 rounded-sm border disabled:opacity-40"
              title="Bump patch version only (e.g. 1.0.18 → 1.0.19). No pack/ship."
            >
              BUMP
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("bump_pi")}
              className="fnd-dev-btn--danger type-body font-mono uppercase tracking-wider px-3 py-1.5 rounded-sm border disabled:opacity-40"
              title="Pin the shipped pi to the DEV-installed (tested) version (src-tauri/pi-pinned-version.txt). Release binary embeds it. No pack/ship."
            >
              BUMP HARNESS
            </button>
            {dash && (
              <span className="fnd-dev-current type-label font-mono config-muted">
                current <span className="fnd-dev-current__v">v{dash.appVersion}</span> → patch only
              </span>
            )}
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="fnd-dev-section-title--info type-body font-mono tracking-wider uppercase">
            App update
          </h3>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("pack_ship_app")}
              className="fnd-dev-btn--info type-label font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border disabled:opacity-40"
              title="Bump patch + pack App .7z + ship (no YES prompt)"
            >
              Pack+Ship App
            </button>
            <span className="fnd-dev-btn--info-ghost type-label font-mono uppercase px-2 py-0.5 rounded-sm border disabled:opacity-40">
              <button type="button" disabled={busy} onClick={() => void runAction("check_app")} className="disabled:opacity-40">Check</button>
            </span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("pack_app")}
              className="fnd-dev-btn--info-ghost type-tiny font-mono uppercase px-2 py-0.5 rounded-sm border disabled:opacity-40"
            >
              Pack only
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("ship_app")}
              className="fnd-dev-btn--info-ghost type-tiny font-mono uppercase px-2 py-0.5 rounded-sm border disabled:opacity-40"
              title="Ship staged App assets for current version tag (no pack)"
            >
              Ship only
            </button>
          </div>
        </section>

        <section className="space-y-2">
          <h3 className="fnd-dev-section-title--accent type-body font-mono tracking-wider uppercase">
            Full bundle (ggml-master only)
          </h3>
          <div className="flex flex-wrap gap-2 items-center">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("pack_ship_full")}
              className="fnd-dev-btn--accent type-label font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border disabled:opacity-40"
              title="Bump patch + pack Full NSIS (ggml-master) + ship"
            >
              Pack+Ship Full
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("check_full")}
              className="fnd-dev-btn--accent-ghost type-label font-mono uppercase tracking-wider px-2 py-1 rounded-sm border disabled:opacity-40"
            >
              Check
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("pack_full")}
              className="fnd-dev-btn--accent-ghost type-tiny font-mono uppercase px-2 py-0.5 rounded-sm border disabled:opacity-40"
            >
              Pack only
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("ship_full")}
              className="fnd-dev-btn--accent-ghost type-tiny font-mono uppercase px-2 py-0.5 rounded-sm border disabled:opacity-40"
              title="Ship staged Full assets for current version tag (no pack)"
            >
              Ship only
            </button>
          </div>
          {dash?.workflowNotes && (
            <ul className="fnd-dev-workflow-notes type-label font-mono config-muted space-y-0.5 list-disc list-inside">
              {dash.workflowNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li>Pack+Ship App: bump → clean REL rebuild → PE assert → ship</li>
              <li>Ship refuses DEV ProductName or version mismatch in App .7z</li>
              <li>Plugin Pack+Ship uses current version tag (no bump)</li>
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2 flex-wrap">
            <h3 className="fnd-dev-section-title--warn type-body font-mono tracking-wider uppercase">
              Providers (engine packs)
            </h3>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("pack_ship_all_providers")}
              className="fnd-dev-btn--warn type-label font-mono uppercase tracking-wider px-3 py-1.5 rounded-sm border disabled:opacity-40"
              title="Pack + ship EVERY provider/profile in distribution-policy.json in one pass (plugins + core ggml-master), one after another. Uses current version tag (no bump)."
            >
              Pack+Ship All Providers (Plugins + Core GGML)
            </button>
          </div>
          <div className="space-y-2">
            {(dash?.providers ?? []).map((row) => (
              <div
                key={row.id}
                className="fnd-dev-provider-card config-form-panel rounded-sm p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="fnd-dev-provider-name type-body font-mono">{row.displayName}</span>
                      <span className="fnd-dev-provider-id type-tiny font-mono">{row.id}</span>
                      <span
                        className={`fnd-dev-role-badge type-tiny font-mono px-1.5 py-0.5 rounded-sm border uppercase tracking-wider ${roleBadge(row.role)}`}
                      >
                        {roleLabel(row.role)}
                      </span>
                      {row.factoryExists ? (
                        <span className="fnd-dev-factory type-tiny font-mono">factory</span>
                      ) : (
                        <span className="fnd-dev-no-factory type-tiny font-mono">no factory</span>
                      )}
                    </div>
                    <div className="fnd-dev-readiness flex flex-wrap gap-2 type-tiny font-mono config-muted">
                      {row.readiness.map((r) => (
                        <span
                          key={r.profile}
                          className={r.ready ? "fnd-dev-readiness__ready" : "fnd-dev-readiness__missing"}
                        >
                          {r.profile}:
                          {r.runtimeBinary ? " runtime" : ""}
                          {r.foundryArtifact ? " foundry" : ""}
                          {!r.ready ? " MISSING" : " ok"}
                        </span>
                      ))}
                    </div>
                    {row.notes.length > 0 && (
                      <ul className="fnd-dev-provider-notes type-tiny font-mono space-y-0.5">
                        {row.notes.map((n) => (
                          <li key={n}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div className="flex flex-col gap-1.5 items-end shrink-0">
                    {row.role !== "core" && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void setRole(row.id, row.role === "plugin" ? "local" : "plugin")
                        }
                        className={`fnd-dev-catalog-btn type-tiny font-mono uppercase px-2.5 py-1 rounded-sm border disabled:opacity-40 ${
                          row.role === "plugin"
                            ? "fnd-dev-catalog-btn--on"
                            : "fnd-dev-catalog-btn--off"
                        }`}
                        title={
                          row.role === "plugin"
                            ? "Catalog shipping ON — click to turn OFF (engines stay; not in App catalog)"
                            : "Catalog shipping OFF — click to turn ON (include in App catalog + Majestic packs)"
                        }
                      >
                        Catalog {row.role === "plugin" ? "ON" : "OFF"}
                      </button>
                    )}
                    {(row.role === "plugin" || row.role === "core") && (
                      <div className="flex flex-wrap gap-1 justify-end">
                        {row.profiles.map((pr) => (
                          <button
                            key={pr}
                            type="button"
                            disabled={busy}
                            onClick={() => void runAction("pack_ship_provider", row.id, pr)}
                            className="fnd-dev-pack-btn type-tiny font-mono uppercase px-1.5 py-0.5 rounded-sm border disabled:opacity-40"
                            title={`Pack + ship ${row.id}-${pr}.7z (current tag, no bump). Plugin ON required for catalog.`}
                          >
                            Pack+Ship {pr}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            ))}
            {!dash && (
              <p className="type-body font-mono config-muted">Loading policy…</p>
            )}
          </div>
        </section>

        <section className="space-y-1">
          <h3 className="fnd-dev-section-title type-body font-mono tracking-wider uppercase">
            Job log (also in Tauri console)
          </h3>
          <pre className="fnd-dev-job-log type-tiny font-mono config-muted rounded-sm p-2 max-h-48 overflow-auto whitespace-pre-wrap">
            {logLines.length === 0 ? "(empty — watch Tauri console for [majestic] lines)" : logLines.join("\n")}
          </pre>
        </section>
      </div>
    </div>
  );
}
