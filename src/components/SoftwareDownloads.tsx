//! DOWNLOADS -> SOFTWARE.
//!
//! The only place software arrives: app update, engine modes, Foundry. Transfers in flight are
//! listed underneath; models stay in the MODELS tab of the same page.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

// Shares the ModelHub panel/row styling (heading, label, sub-line).
import "../styles/modelhub-page.css";
import TabPageHeader from "./TabPageHeader";

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

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" data-software-page>
      <TabPageHeader title="SOFTWARE" />
      <div className="flex-1 overflow-y-auto eink-scrollbar px-4 py-3 space-y-2">
      <section className="industrial-panel-face px-3 py-2.5">
        <div className="dl-paths-heading">Application</div>
        <div className="theme-surface-row flex items-center justify-between gap-3 rounded-sm px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="dl-paths-label truncate font-mono">Blackwell Ops</span>
              {appUpdate && (
                <span className="value-chip shrink-0 font-mono px-1.5 py-0.5">
                  {appUpdate.currentVersion}
                </span>
              )}
            </div>
            <div className="dl-paths-sub truncate font-mono">
              {!appUpdate
                ? "Could not check for updates"
                : appUpdate.available
                  ? `Version ${appUpdate.version} available`
                  : "Up to date"}
            </div>
          </div>
          {appUpdate?.available && (
            <button
              type="button"
              className="value-chip shrink-0 px-2 py-0.5 font-mono whitespace-nowrap"
              onClick={() => void run(() => invoke("install_app_update", { channel: "app_only" }))}
            >
              UPDATE {appUpdate.version}
            </button>
          )}
        </div>
      </section>

      <section className="industrial-panel-face px-3 py-2.5 space-y-1.5">
        <div className="dl-paths-heading">
          Engine{overview?.label ? ` · ${overview.label}` : ""}
        </div>
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
            <div
              key={mode.id}
              className="theme-surface-row flex items-center justify-between gap-3 rounded-sm px-2.5 py-1.5"
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="dl-paths-label truncate font-mono">{mode.label}</span>
                  <span className="dl-paths-sub truncate font-mono">{mode.tagline}</span>
                </div>
                <div className="dl-paths-sub truncate font-mono">
                  {mode.packAvailable ? (
                    <>
                      Published <EngineVersionLabel version={mode.packVersion} /> ·{" "}
                      {formatSize(mode.downloadSizeBytes)}
                    </>
                  ) : (
                    "No published pack yet"
                  )}
                </div>
                <div className="dl-paths-sub truncate font-mono">
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
                <span className="dl-paths-sub shrink-0 font-mono">{task.status}</span>
              ) : !mode.packAvailable ? (
                <span className="dl-paths-sub shrink-0 font-mono">not published yet</span>
              ) : (
                <button
                  type="button"
                  className="value-chip shrink-0 px-2 py-0.5 font-mono whitespace-nowrap"
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

      <section className="industrial-panel-face px-3 py-2.5">
        <div className="dl-paths-heading">Foundry</div>
        <div className="theme-surface-row flex items-center justify-between gap-3 rounded-sm px-2.5 py-1.5">
          <div className="min-w-0 flex-1">
            <span className="dl-paths-label truncate font-mono">Build engines yourself</span>
            <div className="dl-paths-sub truncate font-mono">
              {foundryReady
                ? "Installed"
                : `Not installed · ${formatSize(buildPack?.size_bytes ?? 0)}`}
            </div>
          </div>
          {!foundryReady && (
            <button
              type="button"
              className="value-chip shrink-0 px-2 py-0.5 font-mono whitespace-nowrap"
              onClick={() => void run(() => invoke("start_toolchain_download", { pack: "build" }))}
            >
              INSTALL
            </button>
          )}
        </div>
      </section>

      {inFlight.length > 0 && (
        <section className="industrial-panel-face px-3 py-2.5 space-y-1.5">
          <div className="dl-paths-heading">In progress</div>
          {inFlight.map((task) => {
            const pct =
              task.totalBytes > 0
                ? Math.min(100, Math.round((task.downloadedBytes / task.totalBytes) * 100))
                : null;
            return (
              <div
                key={task.id}
                className="theme-surface-row flex items-center justify-between gap-3 rounded-sm px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <span className="dl-paths-label truncate font-mono">
                    {task.fileName || task.id}
                  </span>
                  <div className="dl-paths-sub truncate font-mono">
                    {task.status}
                    {pct !== null ? ` · ${pct}%` : ""}
                  </div>
                </div>
                <button
                  type="button"
                  className="value-chip shrink-0 px-2 py-0.5 font-mono whitespace-nowrap"
                  onClick={() => void run(() => invoke("cancel_download", { taskId: task.id }))}
                >
                  CANCEL
                </button>
              </div>
            );
          })}
        </section>
      )}

        {error && <p className="type-micro font-mono cfg-dng px-1">{error}</p>}
      </div>
    </div>
  );
}
