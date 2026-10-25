//! Foundry package + CUDA runtime panel.
//!
//! Two independent things, side by side: the CUDA runtime packs the engines launch with, and
//! the Foundry package that compiles engines. Everything else (cache paths, archive names,
//! per-profile build detail) is deliberately not surfaced.

import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

import { useDownloadTasks } from "../hooks/useDownloadTasks";
import { DEFAULT_BINARY_PROFILE } from "../lib/foundry_constants";
import type { DownloadTask } from "../lib/types";

interface ProfileCheck {
  id: string;
  cuda: string;
  vs_label: string;
  ready: boolean;
  missing: string[];
}

interface RuntimeVersion {
  id: string;
  label: string;
  cuda: string;
  ready: boolean;
  min_driver_major?: number | null;
  driver_major?: number | null;
  driver_ok: boolean;
}

interface PackOffering {
  id: string;
  kind: string;
  cuda?: string | null;
  asset: string;
  size_bytes: number;
  installed: boolean;
}

export interface ToolchainInstallInfo {
  app_root: string;
  archive_cache_dir: string;
  toolchain_dir: string;
  release_url: string;
  archive_name: string;
  archive_parts: string[];
  compressed_size_label: string;
  uncompressed_size_label: string;
  manifest_present: boolean;
  runtime_ready: boolean;
  runtime_versions: RuntimeVersion[];
  packs: PackOffering[];
  msvc_crt_ready: boolean;
  msvc_crt_error?: string | null;
  profiles_ready: number;
  profiles_total: number;
  all_ready: boolean;
  profile_checks: ProfileCheck[];
  pack_installed_version: number;
  pack_expected_version: number;
  pack_outdated: boolean;
}

interface FoundryToolchainPanelProps {
  compact?: boolean;
  onboarding?: boolean;
  requiredProfile?: string;
  onReadyChange?: (ready: boolean) => void;
  onInstallStatusChange?: (status: { foundryReady: boolean; runtimeReady: boolean }) => void;
}

const ACTIVE_STATUSES = ["queued", "downloading", "paused", "scanning"];

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const mb = Math.round(bytes / (1024 * 1024));
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb} MB`;
}

function taskForPack(tasks: DownloadTask[], pack: string): DownloadTask | undefined {
  return tasks.find((t) => t.quantType === pack || t.quantType === `toolchain:${pack}`);
}

export default function FoundryToolchainPanel({
  compact = false,
  onboarding = false,
  requiredProfile,
  onReadyChange,
  onInstallStatusChange,
}: FoundryToolchainPanelProps) {
  const [info, setInfo] = useState<ToolchainInstallInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const tasks = useDownloadTasks("toolchain");

  const refresh = useCallback(async () => {
    try {
      const data = await invoke<ToolchainInstallInfo>("foundry_get_toolchain_install_info");
      setInfo(data);
    } catch (e) {
      setError(typeof e === "string" ? e : "Could not read the Foundry package state");
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => {
      if (document.hidden) return;
      void refresh();
    }, 4000);
    return () => window.clearInterval(timer);
  }, [refresh]);

  const runtimeForProfile = useCallback(
    (profile: string): RuntimeVersion | undefined =>
      info?.runtime_versions.find((v: RuntimeVersion) => v.id === profile),
    [info],
  );

  useEffect(() => {
    if (!info || !onReadyChange) return;
    if (requiredProfile) {
      const check = info.profile_checks.find(
        (c) => c.id.toLowerCase() === requiredProfile.toLowerCase(),
      );
      onReadyChange(Boolean(check?.ready));
    } else {
      onReadyChange(info.all_ready);
    }
  }, [info, requiredProfile, onReadyChange]);

  useEffect(() => {
    if (!info || !onInstallStatusChange) return;
    onInstallStatusChange({
      foundryReady: info.all_ready,
      runtimeReady: info.runtime_versions.some((v) => v.ready) || info.runtime_ready,
    });
  }, [info, onInstallStatusChange]);

  const startPack = useCallback(
    async (pack: string) => {
      setError(null);
      try {
        await invoke("start_toolchain_download", { pack });
        await refresh();
      } catch (e) {
        setError(typeof e === "string" ? e : "Download failed");
      }
    },
    [refresh],
  );

  const cancelTask = useCallback(
    async (taskId: string) => {
      try {
        await invoke("cancel_download", { taskId });
        await refresh();
      } catch (e) {
        setError(typeof e === "string" ? e : "Cancel failed");
      }
    },
    [refresh],
  );

  if (!info) {
    return (
      <div className="type-tiny font-mono config-muted">
        {error ?? "Reading the Foundry package…"}
      </div>
    );
  }

  const buildPack = info.packs.find((p) => p.kind === "build");
  const foundryReady = info.profiles_total > 0 && info.profiles_ready >= info.profiles_total;
  const readyBadge = foundryReady && !info.pack_outdated;

  // A completed setup is the only state worth collapsing into one line.
  if (compact && !onboarding && readyBadge) {
    return <div className="fnd-tc-ready type-tiny font-mono">✓ Foundry package ready</div>;
  }

  const runtimeRow = (profile: string, label: string) => {
    const runtime = runtimeForProfile(profile);
    const pack = info.packs.find((p) => p.kind === "runtime" && p.cuda === runtime?.cuda);
    if (!runtime || !pack) return null;
    const task = taskForPack(tasks, pack.id);
    const busy = Boolean(task && ACTIVE_STATUSES.includes(task.status));
    const installed = runtime.ready || pack.installed;
    const active = profile === DEFAULT_BINARY_PROFILE;
    return (
      <div
        key={profile}
        className="flex items-center justify-between gap-2 py-1"
      >
        <div className="min-w-0">
          <div className="type-tiny font-mono uppercase tracking-wide">
            {label}
            {active && <span className="type-micro font-mono uppercase config-muted"> active</span>}
          </div>
          <div className="type-micro font-mono config-muted">CUDA {runtime.cuda}</div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          {busy ? (
            <>
              <span className="type-micro font-mono config-muted">{task?.status}</span>
              {task && (
                <button
                  type="button"
                  className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                  onClick={() => void cancelTask(task.id)}
                >
                  CANCEL
                </button>
              )}
            </>
          ) : installed ? (
            <span className="type-micro font-mono config-muted">installed</span>
          ) : (
            <button
              type="button"
              className="foundry-toolchain-btn foundry-toolchain-btn--action"
              onClick={() => void startPack(pack.id)}
            >
              DOWNLOAD {formatSize(pack.size_bytes)}
            </button>
          )}
        </div>
      </div>
    );
  };

  const buildTask = buildPack ? taskForPack(tasks, buildPack.id) : undefined;
  const buildBusy = Boolean(buildTask && ACTIVE_STATUSES.includes(buildTask.status));

  if (onboarding) {
    const seed = runtimeForProfile(requiredProfile ?? DEFAULT_BINARY_PROFILE);
    const seedPack = info.packs.find((p) => p.kind === "runtime" && p.cuda === seed?.cuda);
    const seedTask = seedPack ? taskForPack(tasks, seedPack.id) : undefined;
    const seedBusy = Boolean(seedTask && ACTIVE_STATUSES.includes(seedTask.status));
    return (
      <div className="space-y-2">
        <p className="type-tiny font-mono uppercase tracking-wide config-muted">Engine runtime</p>
        <div className="flex items-center justify-between gap-2">
          <span className="type-tiny font-mono">
            CUDA {seed?.cuda ?? "—"}
            {seed?.ready ? " · installed" : ""}
          </span>
          {seedBusy ? (
            <span className="type-micro font-mono config-muted">{seedTask?.status}</span>
          ) : seed?.ready ? null : (
            <button
              type="button"
              className="foundry-toolchain-btn foundry-toolchain-btn--action"
              onClick={() => seedPack && void startPack(seedPack.id)}
              disabled={!seedPack}
            >
              DOWNLOAD {seedPack ? formatSize(seedPack.size_bytes) : ""}
            </button>
          )}
        </div>
        {error && <p className="type-micro font-mono">{error}</p>}
      </div>
    );
  }

  return (
    <div className="w-full space-y-2">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <section className="rounded-sm border p-2.5 space-y-1.5">
          <p className="type-tiny font-mono uppercase tracking-wide config-muted">CUDA profiles</p>
          {runtimeRow("edge", "EDGE")}
          {runtimeRow("stable", "STABLE")}
        </section>
        <section className="rounded-sm border p-2.5 space-y-1.5">
          <p className="type-tiny font-mono uppercase tracking-wide config-muted">Foundry</p>
          <p className="type-micro font-mono config-muted leading-relaxed">
            Compiles engines on this machine. Running them does not need it.
          </p>
          <div className="flex items-center gap-2">
            {buildBusy ? (
              <>
                <span className="type-micro font-mono config-muted">{buildTask?.status}</span>
                {buildTask && (
                  <button
                    type="button"
                    className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                    onClick={() => void cancelTask(buildTask.id)}
                  >
                    CANCEL
                  </button>
                )}
              </>
            ) : readyBadge ? (
              <span className="type-micro font-mono config-muted">installed</span>
            ) : (
              <button
                type="button"
                className="foundry-toolchain-btn foundry-toolchain-btn--action"
                onClick={() => buildPack && void startPack(buildPack.id)}
                disabled={!buildPack}
              >
                INSTALL {buildPack ? formatSize(buildPack.size_bytes) : ""}
              </button>
            )}
          </div>
        </section>
      </div>
      {error && <p className="type-micro font-mono">{error}</p>}
    </div>
  );
}
