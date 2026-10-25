//! CONFIG -> ENGINE.
//!
//! One engine, two modes. Everything a user needs to know about "which engine am I running,
//! and how do I get the other one" is here; runtime packs, sources and build tools are
//! implementation detail behind "Manage" and the Foundry card.

import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useDownloadTasks } from "../hooks/useDownloadTasks";
import { useFoundry } from "../hooks/useBuildDock";
import { buildEngineOverview, modeSourceLabel } from "../lib/engineOverview";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import type { BinaryUpdateInfo, DownloadTask, ProviderConfig } from "../lib/types";
import type { ToolchainInstallInfo } from "./FoundryToolchainPanel";

interface EngineConfigProps {
  providers?: ProviderConfig[];
  onProvidersChange?: (providers: ProviderConfig[]) => void;
}

const ACTIVE_STATUSES = ["queued", "downloading", "paused", "scanning"];

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const mb = Math.round(bytes / (1024 * 1024));
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function taskForProfile(
  tasks: DownloadTask[],
  providerId: string,
  profile: string,
): DownloadTask | undefined {
  return tasks.find(
    (t) =>
      t.hfAuthor === providerId &&
      (t.quantType === profile || t.quantType === `${providerId}:${profile}`) &&
      ACTIVE_STATUSES.includes(t.status),
  );
}

export default function EngineConfig({ providers: external, onProvidersChange }: EngineConfigProps) {
  const [providers, setProviders] = useState<ProviderConfig[]>(external ?? []);
  const [updates, setUpdates] = useState<BinaryUpdateInfo[]>([]);
  const [toolchain, setToolchain] = useState<ToolchainInstallInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manage, setManage] = useState<string | null>(null);
  const { openBuildModal } = useFoundry();
  const providerTasks = useDownloadTasks("provider");
  const toolchainTasks = useDownloadTasks("toolchain");

  const refresh = useCallback(async () => {
    try {
      const [provs, ups, tc] = await Promise.all([
        invoke<ProviderConfig[]>("list_providers").catch(() => [] as ProviderConfig[]),
        invoke<BinaryUpdateInfo[]>("check_binary_updates", {
          providerId: DEFAULT_PROVIDER_ID,
        }).catch(() => [] as BinaryUpdateInfo[]),
        invoke<ToolchainInstallInfo>("foundry_get_toolchain_install_info").catch(() => null),
      ]);
      let next = provs;
      // Inventory scans label unknown binaries "catalog"/"bundled"; probe once so the page
      // shows the real engine identity instead of a source name.
      const needsProbe = provs.some((p) =>
        Object.values(p.buildInfoPerEnv ?? {}).some((b) =>
          /^(catalog|bundled|downloaded|foundry-artifact|disk-scanned)$/i.test(b.version?.trim() ?? ""),
        ),
      );
      if (needsProbe) {
        next = await invoke<ProviderConfig[]>("refresh_build_info", {
          providerId: DEFAULT_PROVIDER_ID,
        }).catch(() => provs);
      }
      if (next.length > 0) {
        setProviders(next);
        onProvidersChange?.(next);
      }
      setUpdates(ups);
      setToolchain(tc);
    } catch (e) {
      setError(typeof e === "string" ? e : "Could not read the engine state");
    }
  }, [onProvidersChange]);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const overview = useMemo(
    () => buildEngineOverview(providers, updates, toolchain),
    [providers, updates, toolchain],
  );
  const modes = overview?.modes ?? [];

  const installMode = useCallback(
    async (profile: string, runtimeOnly = false) => {
      setError(null);
      try {
        await invoke("download_binary_update", {
          providerId: DEFAULT_PROVIDER_ID,
          profile,
          runtimeOnly,
        });
        await refresh();
      } catch (e) {
        setError(typeof e === "string" ? e : "Install failed");
      }
    },
    [refresh],
  );

  const setSource = useCallback(
    async (profile: string, source: "bundled" | "catalog" | "foundry") => {
      setError(null);
      try {
        await invoke("set_profile_binary_source", {
          providerId: DEFAULT_PROVIDER_ID,
          profile,
          source,
        });
        await refresh();
      } catch (e) {
        setError(typeof e === "string" ? e : "Could not switch the source");
      }
    },
    [refresh],
  );

  const buildPack = toolchain?.packs.find((p) => p.kind === "build");
  const foundryTask = toolchainTasks.find(
    (t) => t.quantType === "build" || t.quantType === "toolchain:build",
  );
  const foundryBusy = Boolean(foundryTask && ACTIVE_STATUSES.includes(foundryTask.status));
  const foundryReady = Boolean(
    toolchain &&
      toolchain.profiles_total > 0 &&
      toolchain.profiles_ready >= toolchain.profiles_total &&
      !toolchain.pack_outdated,
  );

  const installFoundry = useCallback(async () => {
    setError(null);
    try {
      await invoke("start_toolchain_download", { pack: "build" });
      await refresh();
    } catch (e) {
      setError(typeof e === "string" ? e : "Foundry install failed");
    }
  }, [refresh]);

  return (
    <div className="h-full flex flex-col overflow-hidden" data-config-page>
      <div className="px-4 py-2.5 config-section-bar flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-mono theme-accent-text tracking-widest">ENGINE</h2>
          <span className="type-tiny font-mono config-muted opacity-60">
            {overview?.label ?? "GGML Master"}
          </span>
        </div>
        {overview?.buildVersion ? (
          <span className="type-micro font-mono config-muted">Build {overview.buildVersion}</span>
        ) : null}
      </div>

      <div className="flex-1 overflow-y-auto eink-scrollbar p-4 min-h-0 space-y-3">
        <p className="type-body font-mono config-muted max-w-3xl">
          Two ways to run the same models. Pick the one your driver supports — the app brings the
          runtime with it, there is no separate download to track.
        </p>

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {modes.map((mode) => {
            const task = taskForProfile(providerTasks, DEFAULT_PROVIDER_ID, mode.id);
            return (
              <article key={mode.id} className="rounded-sm border p-3 space-y-2.5">
                <header className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="type-label font-mono uppercase tracking-wider">
                        {mode.label}
                      </span>
                    </div>
                    <div className="type-micro font-mono config-muted mt-0.5">{mode.tagline}</div>
                  </div>
                  <span className="type-micro font-mono uppercase config-muted shrink-0">
                    {mode.state === "ready"
                      ? "ready"
                      : mode.state === "driver"
                        ? "driver too old"
                        : "not installed"}
                  </span>
                </header>

                <p className="type-micro font-mono config-muted leading-relaxed">{mode.blurb}</p>

                <div className="type-micro font-mono config-muted">
                  CUDA {mode.cuda || "—"}
                  {mode.driverFloor ? ` · driver ${mode.driverFloor}+` : ""}
                  {mode.driverMajor ? ` (you have ${mode.driverMajor})` : ""}
                </div>

                <div className="type-micro font-mono config-muted">
                  {mode.version ? (
                    <>
                      Build {mode.version} · {modeSourceLabel(mode.source)}
                      {mode.sourceBuildDate ? ` · ${mode.sourceBuildDate}` : ""}
                    </>
                  ) : (
                    "No engine installed for this mode"
                  )}
                </div>

                <div className="flex flex-wrap items-center gap-2 pt-0.5">
                  {task ? (
                    <>
                      <span className="type-micro font-mono config-muted">{task.status}</span>
                      <button
                        type="button"
                        className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                        onClick={() => void invoke("cancel_download", { taskId: task.id })}
                      >
                        CANCEL
                      </button>
                    </>
                  ) : mode.state === "driver" ? (
                    <span className="type-micro font-mono config-muted">
                      Update your NVIDIA driver to use this mode.
                    </span>
                  ) : mode.state === "install" ? (
                    <button
                      type="button"
                      className="foundry-toolchain-btn foundry-toolchain-btn--action"
                      onClick={() =>
                        void installMode(mode.id, mode.runtimeMissing && !mode.engineMissing)
                      }
                    >
                      {mode.engineMissing ? "INSTALL" : "INSTALL RUNTIME"}{" "}
                      {formatSize(mode.sizeBytes)}
                    </button>
                  ) : mode.updateAvailable ? (
                    <button
                      type="button"
                      className="foundry-toolchain-btn foundry-toolchain-btn--action"
                      onClick={() => void installMode(mode.id)}
                    >
                      UPDATE {formatSize(mode.sizeBytes)}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                    title="Build this mode with Foundry"
                    onClick={() => openBuildModal(DEFAULT_PROVIDER_ID, mode.id as "edge" | "stable")}
                  >
                    BUILD
                  </button>
                  <button
                    type="button"
                    className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                    onClick={() => setManage(manage === mode.id ? null : mode.id)}
                  >
                    {manage === mode.id ? "HIDE" : "MANAGE"}
                  </button>
                </div>

                {manage === mode.id && (
                  <div className="rounded-sm border p-2 space-y-1.5">
                    <p className="type-micro font-mono config-muted">
                      Source: {modeSourceLabel(mode.source)}
                      {mode.version ? ` · ${mode.version}` : ""}
                    </p>
                    <div className="space-y-1">
                      {mode.sources.map((source) => (
                        <div
                          key={source.id}
                          className="flex items-center justify-between gap-2 type-micro font-mono"
                        >
                          <span className="min-w-0">
                            {source.label}
                            <span className="config-muted">
                              {source.version ? ` · ${source.version}` : ""}
                              {source.buildDate ? ` · ${source.buildDate}` : ""}
                            </span>
                          </span>
                          <span className="flex items-center gap-1.5 shrink-0">
                            {source.newest && !source.active && (
                              <span className="uppercase config-muted">newest</span>
                            )}
                            {source.active ? (
                              <span className="uppercase config-muted">in use</span>
                            ) : (
                              <button
                                type="button"
                                disabled={!source.available}
                                className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                                onClick={() => void setSource(mode.id, source.id)}
                              >
                                USE
                              </button>
                            )}
                          </span>
                        </div>
                      ))}
                    </div>
                    <p className="type-micro font-mono config-muted leading-relaxed">
                      Run the installer's copy, a downloaded pack, or a local Foundry build. Only
                      sources present on disk can be selected.
                    </p>
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <section className="rounded-sm border p-3 space-y-2">
          <div className="flex items-start justify-between gap-2">
            <div>
              <p className="type-label font-mono uppercase tracking-wider">FOUNDRY</p>
              <p className="type-micro font-mono config-muted mt-0.5">
                Build the engine yourself. Only needed for compiling — running does not use it.
              </p>
            </div>
            <span className="type-micro font-mono uppercase config-muted shrink-0">
              {foundryBusy ? foundryTask?.status : foundryReady ? "installed" : "not installed"}
            </span>
          </div>
          <div className="flex items-center gap-2">
            {foundryBusy ? (
              foundryTask && (
                <button
                  type="button"
                  className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                  onClick={() => void invoke("cancel_download", { taskId: foundryTask.id })}
                >
                  CANCEL
                </button>
              )
            ) : foundryReady ? null : (
              <button
                type="button"
                className="foundry-toolchain-btn foundry-toolchain-btn--action"
                onClick={() => void installFoundry()}
                disabled={!buildPack}
              >
                INSTALL {formatSize(buildPack?.size_bytes ?? 0)}
              </button>
            )}
          </div>
        </section>

        {error && <p className="type-micro font-mono cfg-dng">{error}</p>}
      </div>
    </div>
  );
}
