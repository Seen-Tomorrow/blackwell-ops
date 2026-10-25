//! DOWNLOADS -> SOFTWARE.
//!
//! The only place software arrives: app update, engine modes, Foundry. Transfers in flight are
//! listed underneath; models stay in the MODELS tab of the same page.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useDownloadTasks } from "../hooks/useDownloadTasks";
import { buildEngineOverview, packDownloadAction } from "../lib/engineOverview";
import EngineVersionLabel from "./EngineVersionLabel";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import type { BinaryUpdateInfo, DownloadTask, ProviderConfig } from "../lib/types";
import type { ToolchainInstallInfo } from "./FoundryToolchainPanel";

interface AppUpdateInfo {
  available: boolean;
  version: string;
  currentVersion: string;
  releaseNotes: string | null;
}

const ACTIVE_STATUSES = ["queued", "downloading", "paused", "scanning"];

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const mb = Math.round(bytes / (1024 * 1024));
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function active(task: DownloadTask): boolean {
  return ACTIVE_STATUSES.includes(task.status);
}

export default function SoftwareDownloads() {
  const [appUpdate, setAppUpdate] = useState<AppUpdateInfo | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [updates, setUpdates] = useState<BinaryUpdateInfo[]>([]);
  const [toolchain, setToolchain] = useState<ToolchainInstallInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const probedRef = useRef(false);
  const providerTasks = useDownloadTasks("provider");
  const toolchainTasks = useDownloadTasks("toolchain");
  const appTasks = useDownloadTasks("app");

  const refresh = useCallback(async () => {
    try {
      const [app, provs, ups, tc] = await Promise.all([
        invoke<AppUpdateInfo>("check_app_update").catch(() => null),
        invoke<ProviderConfig[]>("list_providers").catch(() => [] as ProviderConfig[]),
        invoke<BinaryUpdateInfo[]>("check_binary_updates", {
          providerId: DEFAULT_PROVIDER_ID,
        }).catch(() => [] as BinaryUpdateInfo[]),
        invoke<ToolchainInstallInfo>("foundry_get_toolchain_install_info").catch(() => null),
      ]);
      // Identity probe once per mount so rows can show the build, not just "Installed".
      let next = provs;
      const needsProbe = provs.some((p) =>
        Object.values(p.buildInfoPerEnv ?? {}).some((b) =>
          /^(catalog|bundled|downloaded|foundry-artifact|disk-scanned)$/i.test(b.version?.trim() ?? ""),
        ),
      );
      if (needsProbe && !probedRef.current) {
        probedRef.current = true;
        next = await invoke<ProviderConfig[]>("refresh_build_info", {
          providerId: DEFAULT_PROVIDER_ID,
        }).catch(() => provs);
      }
      setAppUpdate(app);
      setProviders(next);
      setUpdates(ups);
      setToolchain(tc);
    } catch (e) {
      setError(typeof e === "string" ? e : "Could not read update state");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refresh();
    }, 15000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const overview = useMemo(
    () => buildEngineOverview(providers, updates, toolchain),
    [providers, updates, toolchain],
  );

  const buildPack = toolchain?.packs.find((p) => p.kind === "build");
  const foundryReady = Boolean(
    toolchain &&
      toolchain.profiles_total > 0 &&
      toolchain.profiles_ready >= toolchain.profiles_total &&
      !toolchain.pack_outdated,
  );

  const inFlight = [...appTasks, ...providerTasks, ...toolchainTasks].filter(active);

  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      setError(null);
      try {
        await fn();
        await refresh();
      } catch (e) {
        setError(typeof e === "string" ? e : "Action failed");
      }
    },
    [refresh],
  );

  const rowClass = "flex items-center justify-between gap-3 py-1.5";

  return (
    <div className="h-full overflow-y-auto eink-scrollbar p-4 space-y-3">
      <section className="rounded-sm border p-3 space-y-1.5">
        <p className="type-tiny font-mono uppercase tracking-wide config-muted">Application</p>
        <div className={rowClass}>
          <div>
            <div className="type-tiny font-mono">Blackwell Ops</div>
            <div className="type-micro font-mono config-muted">
              {!appUpdate
                ? "Could not check for updates"
                : appUpdate.available
                  ? `Version ${appUpdate.version} available (you have ${appUpdate.currentVersion})`
                  : `Up to date · ${appUpdate.currentVersion}`}
            </div>
          </div>
          {appUpdate?.available && (
            <button
              type="button"
              className="foundry-toolchain-btn foundry-toolchain-btn--action"
              onClick={() => void run(() => invoke("install_app_update", { channel: "app_only" }))}
            >
              UPDATE {appUpdate.version}
            </button>
          )}
        </div>
      </section>

      <section className="rounded-sm border p-3 space-y-1.5">
        <p className="type-tiny font-mono uppercase tracking-wide config-muted">
          Engine {overview?.label ? `· ${overview.label}` : ""}
        </p>
        {(overview?.modes ?? []).map((mode) => {
          const task = providerTasks.find(
            (t) =>
              t.hfAuthor === DEFAULT_PROVIDER_ID &&
              (t.quantType === mode.id || t.quantType === `${DEFAULT_PROVIDER_ID}:${mode.id}`) &&
              active(t),
          );
          const catalog = mode.sources.find((s) => s.id === "catalog");
          const action = packDownloadAction(mode.packVersion, catalog?.version ?? null);
          return (
            <div key={mode.id} className={rowClass}>
              <div className="min-w-0">
                <div className="type-tiny font-mono">
                  {mode.label}
                  <span className="config-muted"> · {mode.tagline}</span>
                </div>
                <div className="type-micro font-mono config-muted">
                  {mode.packAvailable ? (
                    <>
                      Published <EngineVersionLabel version={mode.packVersion} /> ·{" "}
                      {formatSize(mode.downloadSizeBytes)}
                    </>
                  ) : (
                    "No published pack yet"
                  )}
                </div>
                <div className="type-micro font-mono config-muted">
                  {catalog?.available ? (
                    <>
                      Downloaded <EngineVersionLabel version={catalog.version} />
                      {catalog.buildDate ? ` · ${catalog.buildDate}` : ""}
                    </>
                  ) : (
                    "Not downloaded"
                  )}
                </div>
              </div>
              {task ? (
                <span className="type-micro font-mono config-muted">{task.status}</span>
              ) : !mode.packAvailable ? (
                <span className="type-micro font-mono config-muted">not published yet</span>
              ) : (
                <button
                  type="button"
                  className="foundry-toolchain-btn foundry-toolchain-btn--action"
                  onClick={() =>
                    void run(() =>
                      invoke("download_binary_update", {
                        providerId: DEFAULT_PROVIDER_ID,
                        profile: mode.id,
                        runtimeOnly: mode.runtimeMissing && !mode.engineMissing,
                      }),
                    )
                  }
                >
                  {action === "update"
                    ? "UPDATE"
                    : action === "redownload"
                      ? "RE-DOWNLOAD"
                      : "DOWNLOAD"}{" "}
                  {formatSize(mode.downloadSizeBytes)}
                </button>
              )}
            </div>
          );
        })}
      </section>

      <section className="rounded-sm border p-3 space-y-1.5">
        <p className="type-tiny font-mono uppercase tracking-wide config-muted">Foundry</p>
        <div className={rowClass}>
          <div>
            <div className="type-tiny font-mono">Build engines yourself</div>
            <div className="type-micro font-mono config-muted">
              {foundryReady ? "Installed" : `Not installed · ${formatSize(buildPack?.size_bytes ?? 0)}`}
            </div>
          </div>
          {!foundryReady && (
            <button
              type="button"
              className="foundry-toolchain-btn foundry-toolchain-btn--action"
              onClick={() => void run(() => invoke("start_toolchain_download", { pack: "build" }))}
            >
              INSTALL
            </button>
          )}
        </div>
      </section>

      {inFlight.length > 0 && (
        <section className="rounded-sm border p-3 space-y-1.5">
          <p className="type-tiny font-mono uppercase tracking-wide config-muted">In progress</p>
          {inFlight.map((task) => {
            const pct =
              task.totalBytes > 0
                ? Math.min(100, Math.round((task.downloadedBytes / task.totalBytes) * 100))
                : null;
            return (
              <div key={task.id} className={rowClass}>
                <div className="min-w-0">
                  <div className="type-micro font-mono truncate">{task.fileName || task.id}</div>
                  <div className="type-micro font-mono config-muted">
                    {task.status}
                    {pct !== null ? ` · ${pct}%` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                  onClick={() => void run(() => invoke("cancel_download", { taskId: task.id }))}
                >
                  CANCEL
                </button>
              </div>
            );
          })}
        </section>
      )}

      {error && <p className="type-micro font-mono cfg-dng">{error}</p>}
    </div>
  );
}
