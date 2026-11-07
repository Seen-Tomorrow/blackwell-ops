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
    }, 8000);
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

  // A completed setup is the only state worth collapsing into one line — but it
  // still names the toolchain that will actually compile, so READY is verifiable.
  if (compact && !onboarding && readyBadge) {
    const readyCheck =
      info.profile_checks.find(
        (c) => c.id.toLowerCase() === (requiredProfile ?? "").toLowerCase(),
      ) ?? info.profile_checks.find((c) => c.ready);
    return (
      <div className="fnd-ready-strip">
        <span className="fnd-ready-strip__label">TOOLCHAIN</span>
        <span className="fnd-ready-strip__state">
          <span className="fnd-ready-strip__tick" aria-hidden>✓</span> READY
        </span>
        {readyCheck && (
          <span className="fnd-ready-strip__detail">
            {readyCheck.vs_label} · CUDA {readyCheck.cuda}
          </span>
        )}
      </div>
    );
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
      <div key={profile} className={`fnd-tc-row${installed ? " fnd-tc-row--ready" : ""}`}>
        <span className="fnd-tc-row__dot" aria-hidden />
        <span className="fnd-tc-row__name">
          {label}
          {active && <span className="fnd-tc-row__tag">ACTIVE</span>}
        </span>
        <span className="fnd-tc-row__meta">CUDA {runtime.cuda}</span>
        <span
          className={`fnd-tc-row__state${
            busy ? " fnd-tc-row__state--busy" : installed ? " fnd-tc-row__state--ready" : ""
          }`}
        >
          {busy ? task?.status ?? "QUEUED" : installed ? "INSTALLED" : "NOT INSTALLED"}
        </span>
        <span className="fnd-tc-row__action">
          {busy ? (
            task && (
              <button
                type="button"
                className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                onClick={() => void cancelTask(task.id)}
              >
                CANCEL
              </button>
            )
          ) : installed ? null : (
            <button
              type="button"
              className="foundry-toolchain-btn foundry-toolchain-btn--action"
              onClick={() => void startPack(pack.id)}
            >
              INSTALL {formatSize(pack.size_bytes)}
            </button>
          )}
        </span>
      </div>
    );
  };

  const buildTask = buildPack ? taskForPack(tasks, buildPack.id) : undefined;
  const buildBusy = Boolean(buildTask && ACTIVE_STATUSES.includes(buildTask.status));
  const buildInstalled = foundryReady;
  const buildOutdated = buildInstalled && info.pack_outdated;
  const runtimeRows = [runtimeRow("edge", "EDGE"), runtimeRow("stable", "STABLE")].filter(Boolean);

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
    <section className="fnd-tc-setup">
      <div className="fnd-tc-setup__head">
        <span className="fnd-tc-setup__label">TOOLCHAIN</span>
        <span className="fnd-tc-setup__state">SETUP NEEDED</span>
        <span className="fnd-tc-setup__note">
          Foundry compiles engines here — running them does not need it.
        </span>
      </div>

      <div className="fnd-tc-setup__rows">
        {runtimeRows.length > 0 && (
          <>
            <p className="fnd-tc-setup__group">CUDA RUNTIMES</p>
            {runtimeRows}
          </>
        )}

        <p className="fnd-tc-setup__group">COMPILER PACK</p>
        <div
          className={`fnd-tc-row${
            buildInstalled && !buildOutdated ? " fnd-tc-row--ready" : ""
          }`}
        >
          <span className="fnd-tc-row__dot" aria-hidden />
          <span className="fnd-tc-row__name">BUILD TOOLS</span>
          <span className="fnd-tc-row__meta">VS Build Tools · CMake · ninja</span>
          <span
            className={`fnd-tc-row__state${
              buildBusy
                ? " fnd-tc-row__state--busy"
                : buildInstalled && !buildOutdated
                  ? " fnd-tc-row__state--ready"
                  : ""
            }`}
          >
            {buildBusy
              ? buildTask?.status ?? "QUEUED"
              : !buildInstalled
                ? "NOT INSTALLED"
                : buildOutdated
                  ? "OUTDATED"
                  : "INSTALLED"}
          </span>
          <span className="fnd-tc-row__action">
            {buildBusy ? (
              buildTask && (
                <button
                  type="button"
                  className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                  onClick={() => void cancelTask(buildTask.id)}
                >
                  CANCEL
                </button>
              )
            ) : buildInstalled && !buildOutdated ? null : (
              <button
                type="button"
                className="foundry-toolchain-btn foundry-toolchain-btn--action"
                onClick={() => buildPack && void startPack(buildPack.id)}
                disabled={!buildPack}
              >
                {buildOutdated ? "UPDATE" : "INSTALL"}{" "}
                {buildPack ? formatSize(buildPack.size_bytes) : ""}
              </button>
            )}
          </span>
        </div>
      </div>

      {error && <p className="fnd-tc-setup__error">{error}</p>}
    </section>
  );
}
