import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-shell";
import { ENV_ORDER, TOOLCHAIN_RELEASE_URL, type Env } from "../lib/foundry_constants";
import type { DownloadStatus } from "../lib/types";
import { useDownloadTasks } from "../hooks/useDownloadTasks";
import DownloadProgressRow from "./DownloadProgressRow";

interface ProfileCheck {
  id: string;
  label: string;
  cuda: string;
  vs_label: string;
  ready: boolean;
  missing: string[];
}

export interface CachedToolchainArchive {
  pack: string;
  archive_name: string;
  size_bytes: number;
  location: "cache" | "download";
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
  profiles_ready: number;
  profiles_total: number;
  all_ready: boolean;
  profile_checks: ProfileCheck[];
  cached_archives: CachedToolchainArchive[];
}

interface FoundryToolchainPanelProps {
  /** Compact: ready state is one line; incomplete still shows full guide. */
  compact?: boolean;
  /** Onboarding checklist — emphasize download + allow skip. */
  onboarding?: boolean;
  /** When set (e.g. Foundry confirm), onReadyChange reflects only this profile. */
  requiredProfile?: Env;
  onReadyChange?: (ready: boolean) => void;
  onInstallStatusChange?: (status: { foundryReady: boolean; runtimeReady: boolean }) => void;
}

const ACTIVE_TOOLCHAIN_STATUSES: DownloadStatus[] = [
  "queued",
  "downloading",
  "paused",
  "scanning",
  "failed",
];

function profileReadyForBuild(
  checks: ProfileCheck[],
  requiredProfile?: Env,
): boolean {
  if (!requiredProfile) {
    return checks.length > 0 && checks.every((c) => c.ready);
  }
  const key = requiredProfile.toLowerCase();
  return checks.find((c) => c.id.toLowerCase() === key)?.ready ?? false;
}

export default function FoundryToolchainPanel({
  compact = false,
  onboarding = false,
  requiredProfile,
  onReadyChange,
  onInstallStatusChange,
}: FoundryToolchainPanelProps) {
  const [info, setInfo] = useState<ToolchainInstallInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionError, setActionError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const toolchainDownloads = useDownloadTasks("toolchain");

  const activeTask = toolchainDownloads.find((t) =>
    ACTIVE_TOOLCHAIN_STATUSES.includes(t.status),
  );
  const busyTask = toolchainDownloads.find((t) =>
    ["queued", "downloading", "paused", "scanning"].includes(t.status),
  );
  const downloading = Boolean(busyTask);

  const refresh = useCallback(async () => {
    setLoading(true);
    setActionError(null);
    try {
      const data = await invoke<ToolchainInstallInfo>("foundry_get_toolchain_install_info");
      setInfo(data);
      onReadyChange?.(profileReadyForBuild(data.profile_checks, requiredProfile));
      onInstallStatusChange?.({
        foundryReady: data.all_ready,
        runtimeReady: data.runtime_ready,
      });
    } catch (e) {
      setActionError(String(e));
      onReadyChange?.(false);
    } finally {
      setLoading(false);
    }
  }, [onReadyChange, onInstallStatusChange, requiredProfile]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const prevTaskStatusRef = useRef<Record<string, DownloadStatus>>({});
  useEffect(() => {
    for (const t of toolchainDownloads) {
      const prev = prevTaskStatusRef.current[t.id];
      if (prev && prev !== "completed" && t.status === "completed") {
        void refresh();
      }
      prevTaskStatusRef.current[t.id] = t.status;
    }
  }, [toolchainDownloads, refresh]);

  const handleDownload = useCallback(async () => {
    setActionError(null);
    try {
      await invoke("start_toolchain_download", {});
    } catch (e) {
      setActionError(String(e));
    }
  }, []);

  const handleReextract = useCallback(async () => {
    setActionError(null);
    try {
      await invoke("retry_toolchain_extract", {});
    } catch (e) {
      setActionError(String(e));
    }
  }, []);

  const handleOpenRelease = useCallback(async () => {
    setActionError(null);
    try {
      await open(info?.release_url ?? TOOLCHAIN_RELEASE_URL);
    } catch (e) {
      setActionError(`Failed to open release page: ${e}`);
    }
  }, [info?.release_url]);

  const handleCopyCachePath = useCallback(async () => {
    if (!info?.archive_cache_dir) return;
    setActionError(null);
    try {
      await navigator.clipboard.writeText(info.archive_cache_dir);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch (e) {
      setActionError(`Failed to copy path: ${e}`);
    }
  }, [info?.archive_cache_dir]);

  const handleOpenCacheFolder = useCallback(async () => {
    setActionError(null);
    try {
      await invoke("foundry_open_toolchain_cache_folder");
    } catch (e) {
      setActionError(String(e));
    }
  }, []);

  if (loading && !info) {
    return (
      <div className="text-[8px] font-mono text-stealth-muted/60">
        Checking portable toolchain…
      </div>
    );
  }

  if (!info) {
    return (
      <div className="text-[8px] font-mono text-red-400/80">
        {actionError ?? "Toolchain status unavailable."}
      </div>
    );
  }

  const checkByEnv = Object.fromEntries(
    info.profile_checks.map((c) => [c.id.toLowerCase(), c]),
  ) as Partial<Record<Env, ProfileCheck>>;

  const buildReady = profileReadyForBuild(info.profile_checks, requiredProfile);
  const requiredCheck = requiredProfile
    ? checkByEnv[requiredProfile]
    : undefined;

  if (buildReady && compact) {
    return (
      <div className="text-[8px] font-mono text-nv-green">
        {requiredCheck
          ? `✓ Portable toolchain ready (${requiredCheck.vs_label} + CUDA ${requiredCheck.cuda})`
          : `✓ Portable toolchain ready — all ${info.profiles_total} build profiles`}
      </div>
    );
  }

  const cached = info.cached_archives?.find((a) => a.pack === "full");
  const packActive =
    Boolean(busyTask) ||
    (activeTask?.status === "failed" && activeTask.quantType === "full");
  const canInstallFromCache = Boolean(cached) && !downloading;

  const statusLabel = info.all_ready
    ? "READY"
    : info.runtime_ready
      ? "PARTIAL"
      : `${info.profiles_ready}/${info.profiles_total} PROFILES`;

  const statusClass = info.all_ready
    ? "text-nv-green border-nv-green/40 bg-nv-green/10"
    : info.runtime_ready
      ? "text-yellow-400 border-yellow-400/40 bg-yellow-400/10"
      : "text-yellow-400 border-yellow-400/40 bg-yellow-400/10";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">
          Foundry Toolchain
        </span>
        <span className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm border ${statusClass}`}>
          {statusLabel}
        </span>
      </div>

      <div className="flex flex-wrap gap-1">
        {ENV_ORDER.map((env) => {
          const check = checkByEnv[env];
          const ready = check?.ready ?? false;
          return (
            <span
              key={env}
              title={
                ready
                  ? `${check?.label} ready`
                  : check?.missing.join("\n") ?? "Not checked"
              }
              className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm border ${
                ready
                  ? "text-nv-green/90 border-nv-green/30"
                  : "text-stealth-muted/70 border-stealth-border/50"
              }`}
            >
              {ready ? "✓" : "○"} {check?.label ?? env.toUpperCase()}
            </span>
          );
        })}
      </div>

      {activeTask && (
        <DownloadProgressRow
          task={activeTask}
          onActionError={setActionError}
          compact
        />
      )}

      {info.all_ready ? (
        <p className="text-[8px] font-mono text-nv-green leading-relaxed">
          Portable VS Build Tools, Windows SDK, CUDA, and CMake are installed. Foundry builds and bundled engines are ready.
        </p>
      ) : (
        <div className="foundry-toolchain-install-guide border border-yellow-400/30 bg-yellow-400/5 rounded-sm p-2.5 space-y-2">
          <p className="foundry-toolchain-install-guide__title text-[8px] font-mono text-yellow-400/90 font-bold uppercase tracking-wide">
            {onboarding ? "One-click toolchain" : "Install portable toolchain"}
          </p>

          <p className="text-[8px] font-mono text-white/70 leading-relaxed">
            Single download (~{info.compressed_size_label}): VS Build Tools, Windows SDK, both CUDA versions, and CMake.
            Required for Foundry cmake builds and for running bundled CUDA engines.
          </p>

          {!info.all_ready && info.profiles_ready < info.profiles_total && (
            <div className="rounded-sm border border-yellow-400/20 bg-black/20 px-2 py-1.5 space-y-0.5">
              <p className="text-[7px] font-mono text-yellow-400/80 uppercase tracking-wide">
                {info.profiles_ready}/{info.profiles_total} build profiles ready
              </p>
              {info.profile_checks
                .filter((c) => !c.ready)
                .map((c) => (
                  <p
                    key={c.id}
                    className="text-[7px] font-mono text-stealth-muted/80 leading-relaxed"
                    title={c.missing.join("\n")}
                  >
                    ○ {c.label}: {c.missing[0] ?? "incomplete"}
                    {c.missing.length > 1 ? ` (+${c.missing.length - 1} more)` : ""}
                  </p>
                ))}
            </div>
          )}

          <div className="rounded-sm border border-nv-green/40 bg-nv-green/5 px-2 py-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-[8px] font-mono text-white/90 font-bold uppercase">
                {info.archive_name}
              </span>
              <span className="text-[7px] font-mono text-stealth-muted">
                {info.compressed_size_label} download · {info.uncompressed_size_label} installed
              </span>
            </div>
            <p className="text-[7px] font-mono text-white/60 leading-relaxed">
              One-click download extracts automatically. Already have the archive? Drop it in the cache
              folder and use Install from cache.
            </p>
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => void handleDownload()}
                disabled={downloading || info.all_ready || (packActive && downloading)}
                className="foundry-toolchain-btn foundry-toolchain-btn--action"
              >
                {packActive && busyTask
                  ? busyTask.status === "scanning"
                    ? "EXTRACTING…"
                    : busyTask.status === "downloading"
                      ? "DOWNLOADING…"
                      : busyTask.status === "paused"
                        ? "PAUSED"
                        : busyTask.status === "queued"
                          ? "QUEUED…"
                          : `DOWNLOAD ${info.archive_name.toUpperCase()}`
                  : info.all_ready
                    ? "INSTALLED"
                    : `DOWNLOAD ${info.archive_name.toUpperCase()}`}
              </button>
              <button
                type="button"
                onClick={() => void handleReextract()}
                disabled={!canInstallFromCache || info.all_ready}
                className={`foundry-toolchain-btn ${
                  cached && !info.all_ready && !downloading
                    ? "catalog-scan-btn foundry-toolchain-btn--action foundry-toolchain-btn--cache-ready"
                    : "foundry-toolchain-btn--neutral"
                }`}
                title={
                  cached
                    ? cached.location === "cache"
                      ? "Extract toolchain.7z from cache (no download)"
                      : "Extract local copy (no download)"
                    : `Place ${info.archive_name} in the cache folder, then click here`
                }
              >
                INSTALL FROM CACHE
              </button>
              <button
                type="button"
                onClick={() => setShowManual((v) => !v)}
                className={`foundry-toolchain-btn foundry-toolchain-btn--neutral${
                  showManual ? " ring-1 ring-telemetry-cyan/50" : ""
                }`}
              >
                {showManual ? "HIDE MANUAL" : "MANUAL"}
              </button>
            </div>
          </div>

          {showManual && (
            <div className="foundry-toolchain-install-guide border border-stealth-border/40 bg-black/25 rounded-sm p-2.5 space-y-2">
              <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wide">
                Manual install
              </p>
              <ol className="foundry-toolchain-install-guide__body list-decimal list-inside space-y-1 text-[8px] font-mono text-white/65 leading-relaxed">
                <li>
                  Download <span className="text-nv-green">{info.archive_name}</span> from the GitHub
                  release (or use Download above).
                </li>
                <li>
                  Place the file in the cache folder below — do not extract it yourself.
                </li>
                <li>
                  Click <span className="text-nv-green">Install from cache</span> — the app extracts
                  and verifies into <span className="text-nv-green">toolchain\</span> automatically.
                </li>
              </ol>

              <div className="rounded-sm border border-stealth-border/50 bg-black/30 px-2 py-1.5 space-y-0.5">
                <div className="text-[7px] font-mono text-stealth-muted uppercase">Cache folder</div>
                <div className="text-[8px] font-mono text-telemetry-cyan break-all">
                  {info.archive_cache_dir}
                </div>
                {!info.manifest_present && (
                  <div className="text-[7px] font-mono text-stealth-muted/80">
                    {cached
                      ? `${info.archive_name} found — click Install from cache`
                      : `Waiting for ${info.archive_name} in cache`}
                  </div>
                )}
              </div>

              <div className="foundry-toolchain-install-guide__actions flex flex-wrap gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => void handleOpenCacheFolder()}
                  className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                >
                  OPEN CACHE FOLDER
                </button>
                <button
                  type="button"
                  onClick={() => void handleCopyCachePath()}
                  className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
                >
                  {copied ? "COPIED" : "COPY CACHE PATH"}
                </button>
                <button
                  type="button"
                  onClick={() => void handleOpenRelease()}
                  className="foundry-toolchain-btn foundry-toolchain-btn--link"
                >
                  OPEN RELEASE PAGE
                </button>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  disabled={loading || downloading}
                  className="foundry-toolchain-btn foundry-toolchain-btn--action"
                >
                  {loading ? "CHECKING…" : "RE-CHECK"}
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {actionError && (
        <p className="text-[7px] font-mono text-red-400/80 break-all">{actionError}</p>
      )}
    </div>
  );
}