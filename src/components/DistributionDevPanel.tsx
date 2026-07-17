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
  | "pack_ship_provider";

function roleBadge(role: string): string {
  if (role === "core") return "border-nv-green/40 text-nv-green";
  if (role === "plugin") return "border-yellow-400/40 text-yellow-400";
  // local = Plugin OFF (shipping), still optional product on disk
  return "border-white/20 text-white/70";
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
      <div className="p-4 text-[10px] font-mono config-muted">
        Distribution tools are DEV-only.
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      <div className="px-4 py-3 border-b border-white/[0.06] space-y-2">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h2 className="text-xs font-mono theme-accent-text tracking-widest">DISTRIBUTION</h2>
            <p className="text-[10px] font-mono config-muted mt-1 max-w-2xl leading-relaxed">
              Pack+Ship opens a <span className="text-white/70">visible Majestic console</span>{" "}
              (survives app restart / version bump). Full pack = multi-minute{" "}
              <span className="text-white/60">npm run release</span>. Log also in{" "}
              <span className="text-white/60">.majestic-out/job-log.txt</span>.
            </p>
          </div>
          <div className="flex gap-2 flex-wrap">
            <button
              type="button"
              disabled={busy}
              onClick={() => void refresh()}
              className="value-chip text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm disabled:opacity-40"
            >
              Refresh
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void regenCatalog()}
              className="value-chip text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm disabled:opacity-40"
            >
              Regen catalog
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("bump")}
              className="text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border border-white/20 disabled:opacity-40"
              title="Bump patch version only (no pack/ship)"
            >
              Bump only
            </button>
          </div>
        </div>
        {dash && (
          <p className="text-[8px] font-mono text-stealth-muted/50 break-all">
            v{dash.appVersion} · policy: {dash.policyPath}
          </p>
        )}
      </div>

      {job?.running && (
        <p className="px-4 py-2 text-[10px] font-mono text-yellow-400/90 border-b border-yellow-400/25 bg-yellow-400/[0.06]">
          Job running: {job.chain}
          {job.message ? ` — ${job.message}` : ""} — watch the console window (not stuck on first
          log line).
        </p>
      )}
      {job && !job.running && job.state === "ok" && (
        <p className="px-4 py-2 text-[10px] font-mono text-nv-green/90 border-b border-white/[0.06]">
          Last job OK: {job.chain}
        </p>
      )}
      {job && !job.running && job.state === "failed" && (
        <div className="px-4 py-2 text-[10px] font-mono text-telemetry-red border-b border-telemetry-red/30 bg-telemetry-red/[0.06] space-y-1">
          <p>
            Last job FAILED: {job.chain} — {job.message}
          </p>
          <p className="text-white/50">
            Scroll the job log below (or open .majestic-out/job-log.txt). Retry after fixing the
            error.
          </p>
        </div>
      )}
      {error && (
        <p className="px-4 py-2 text-[10px] font-mono text-telemetry-red border-b border-white/[0.06]">
          {error}
        </p>
      )}

      <div className="flex-1 overflow-auto px-4 py-4 space-y-5">
        <section className="space-y-2">
          <h3 className="text-[10px] font-mono theme-accent-text tracking-wider uppercase">
            App / Full (chains)
          </h3>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("check_app")}
              className="text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border border-white/15 disabled:opacity-40"
            >
              Check App
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("pack_ship_app")}
              className="text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border border-yellow-400/50 text-yellow-400 disabled:opacity-40"
              title="Bump patch + pack App .7z + ship (no YES prompt)"
            >
              Pack+Ship App
            </button>
            <span className="text-stealth-muted/40 self-center text-[9px] font-mono">|</span>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("check_full")}
              className="text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border border-white/15 disabled:opacity-40"
            >
              Check Full
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("pack_ship_full")}
              className="text-[9px] font-mono uppercase tracking-wider px-2.5 py-1 rounded-sm border border-nv-green/50 text-nv-green disabled:opacity-40"
              title="Bump patch + pack Full NSIS + ship"
            >
              Pack+Ship Full
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("pack_app")}
              className="text-[8px] font-mono uppercase px-2 py-0.5 rounded-sm border border-white/10 text-stealth-muted/70 disabled:opacity-40"
            >
              Pack App only
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("ship_app")}
              className="text-[8px] font-mono uppercase px-2 py-0.5 rounded-sm border border-white/10 text-stealth-muted/70 disabled:opacity-40"
              title="Ship staged App assets for current version tag (no pack)"
            >
              Ship App only
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("pack_full")}
              className="text-[8px] font-mono uppercase px-2 py-0.5 rounded-sm border border-white/10 text-stealth-muted/70 disabled:opacity-40"
            >
              Pack Full only
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void runAction("ship_full")}
              className="text-[8px] font-mono uppercase px-2 py-0.5 rounded-sm border border-white/10 text-stealth-muted/70 disabled:opacity-40"
              title="Ship staged Full assets for current version tag (no pack)"
            >
              Ship Full only
            </button>
          </div>
          {dash?.workflowNotes && (
            <ul className="text-[9px] font-mono config-muted space-y-0.5 list-disc list-inside">
              {dash.workflowNotes.map((n) => (
                <li key={n}>{n}</li>
              ))}
              <li>Pack+Ship App auto-bumps patch version first</li>
              <li>Plugin Pack+Ship uses current version tag (no bump)</li>
            </ul>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-[10px] font-mono theme-accent-text tracking-wider uppercase">
            Providers
          </h3>
          <div className="space-y-2">
            {(dash?.providers ?? []).map((row) => (
              <div
                key={row.id}
                className="config-form-panel rounded-sm border border-white/10 p-3 space-y-2"
              >
                <div className="flex items-start justify-between gap-2 flex-wrap">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[10px] font-mono text-white/90">{row.displayName}</span>
                      <span className="text-[8px] font-mono text-stealth-muted/50">{row.id}</span>
                      <span
                        className={`text-[8px] font-mono px-1.5 py-0.5 rounded-sm border uppercase tracking-wider ${roleBadge(row.role)}`}
                      >
                        {roleLabel(row.role)}
                      </span>
                      {row.factoryExists ? (
                        <span className="text-[8px] font-mono text-nv-green/70">factory</span>
                      ) : (
                        <span className="text-[8px] font-mono text-telemetry-red/80">no factory</span>
                      )}
                    </div>
                    <div className="flex flex-wrap gap-2 text-[8px] font-mono config-muted">
                      {row.readiness.map((r) => (
                        <span
                          key={r.profile}
                          className={r.ready ? "text-nv-green/80" : "text-stealth-muted/50"}
                        >
                          {r.profile}:
                          {r.runtimeBinary ? " runtime" : ""}
                          {r.foundryArtifact ? " foundry" : ""}
                          {!r.ready ? " MISSING" : " ok"}
                        </span>
                      ))}
                    </div>
                    {row.notes.length > 0 && (
                      <ul className="text-[8px] font-mono text-yellow-400/70 space-y-0.5">
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
                        className={`text-[8px] font-mono uppercase px-2.5 py-1 rounded-sm border disabled:opacity-40 ${
                          row.role === "plugin"
                            ? "border-yellow-400/45 text-yellow-400 bg-yellow-400/10"
                            : "border-white/20 text-white/65 hover:border-yellow-400/30"
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
                            className="text-[8px] font-mono uppercase px-1.5 py-0.5 rounded-sm border border-yellow-400/35 text-yellow-400/90 hover:bg-yellow-400/10 disabled:opacity-40"
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
              <p className="text-[10px] font-mono config-muted">Loading policy…</p>
            )}
          </div>
        </section>

        <section className="space-y-1">
          <h3 className="text-[10px] font-mono theme-accent-text tracking-wider uppercase">
            Job log (also in Tauri console)
          </h3>
          <pre className="text-[8px] font-mono config-muted bg-black/30 border border-white/[0.06] rounded-sm p-2 max-h-48 overflow-auto whitespace-pre-wrap">
            {logLines.length === 0 ? "(empty — watch Tauri console for [majestic] lines)" : logLines.join("\n")}
          </pre>
        </section>
      </div>
    </div>
  );
}
