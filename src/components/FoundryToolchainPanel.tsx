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
  /** x64 MSVC C runtime resolvable for every profile (app-local, toolchain, or system). */
  msvc_crt_ready: boolean;
  msvc_crt_error?: string | null;
  profiles_ready: number;
  profiles_total: number;
  all_ready: boolean;
  profile_checks: ProfileCheck[];
  cached_archives: CachedToolchainArchive[];
}

interface FoundryToolchainPanelProps {
  /** Compact: ready state is one line; incomplete still shows full guide. */
  compact?: boolean;
  /** Onboarding checklist — emphasize required one-click download. */
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

  // A task the user explicitly cancelled (backend sets error = "Cancelled") is treated as
  // absent — it must not keep the DOWNLOAD button disabled or linger as a fake "failed".
  const isCancelled = (t: { status: string; error?: string | null }) =>
    t.status === "failed" && t.error === "Cancelled";
  const activeTask = toolchainDownloads.find(
    (t) => ACTIVE_TOOLCHAIN_STATUSES.includes(t.status) && !isCancelled(t),
  );
  const busyTask = toolchainDownloads.find(
    (t) =>
      ["queued", "downloading", "paused", "scanning"].includes(t.status) && !isCancelled(t),
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

  const handleCancelDownload = useCallback(async () => {
    if (!activeTask?.id) return;
    setActionError(null);
    try {
      await invoke("cancel_download", { taskId: activeTask.id });
    } catch (e) {
      setActionError(String(e));
    }
  }, [activeTask?.id]);

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
      <div className="fnd-tc-loading type-tiny font-mono">
        Checking portable toolchain…
      </div>
    );
  }

  if (!info) {
    return (
      <div className="fnd-tc-error type-tiny font-mono">
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
      <div className="fnd-tc-ready type-tiny font-mono">
        {requiredCheck
          ? `✓ Portable toolchain ready (${requiredCheck.vs_label} + CUDA ${requiredCheck.cuda})`
          : `✓ Portable toolchain ready — all ${info.profiles_total} build profiles`}
      </div>
    );
  }

  // CUDA is present but the MSVC C runtime is not: engines would die at LoadLibrary with a
  // raw Windows "MSVCP140.dll was not found" dialog and no engine log. Say it plainly.
  // Not gated behind all_ready — this must surface even when everything else is green.
  const crtError = !info.msvc_crt_ready
    ? info.msvc_crt_error ??
      "Missing the x64 Microsoft Visual C++ runtime (vcruntime140, msvcp140) required by the engine binaries. Re-install the portable toolchain, or install the VC++ 2015-2022 Redistributable (x64)."
    : null;

  const cached = info.cached_archives?.find((a) => a.pack === "full");
  const packActive =
    Boolean(busyTask) ||
    (activeTask?.status === "failed" && activeTask.quantType === "full");
  const canInstallFromCache = Boolean(cached) && !downloading;
  // A download task that can be cancelled (not mid-extract, which cannot be aborted cleanly).
  const cancelable = Boolean(activeTask && activeTask.status !== "scanning");

  // Onboarding — simplified, jargon-free toolchain block.
  if (onboarding && !info.all_ready) {
    return (
      <div className="foundry-toolchain-onboarding space-y-2">
        {activeTask && <DownloadProgressRow task={activeTask} onActionError={setActionError} compact />}

        <div className="foundry-toolchain-onboarding__actions flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => void handleDownload()}
            disabled={downloading || packActive}
            className="foundry-toolchain-onboarding__download"
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
                      : "DOWNLOAD"
              : "DOWNLOAD CUDA RUNTIME"}
          </button>
          <button
            type="button"
            onClick={() => void handleReextract()}
            disabled={!canInstallFromCache}
            className="foundry-toolchain-btn foundry-toolchain-btn--neutral"
            title={
              cached
                ? "Extract toolchain.7z from cache (no download)"
                : `Place ${info.archive_name} in the cache folder, then click here`
            }
          >
            INSTALL FROM CACHE
          </button>
          <button
            type="button"
            onClick={() => setShowManual((v) => !v)}
            className={`foundry-toolchain-btn foundry-toolchain-btn--neutral${
              showManual ? " fnd-tc-btn--manual-active" : ""
            }`}
          >
            {showManual ? "HIDE MANUAL" : "MANUAL"}
          </button>
          {cancelable && (
            <button
              type="button"
              onClick={() => void handleCancelDownload()}
              className="foundry-toolchain-btn foundry-toolchain-btn--cancel"
              title="Cancel this download to switch to Install from cache or Manual"
            >
              CANCEL DOWNLOAD
            </button>
          )}
        </div>

        {crtError && (
          <p className="foundry-toolchain-onboarding__hint fnd-tc-crt-hint font-mono m-0">
            {crtError}
          </p>
        )}

        {!downloading && !cached && (
          <p className="foundry-toolchain-onboarding__hint">
            ~{info.compressed_size_label} one-time download — engines, metadata scan, and
            build-from-source.
          </p>
        )}
        {cancelable && (
          <p className="foundry-toolchain-onboarding__cancel-hint">
            Cancel the download anytime to use Install from cache or Manual instead.
          </p>
        )}

        {showManual && (
          <div className="foundry-toolchain-install-guide fnd-tc-guide border rounded-sm p-2.5 space-y-2">
            <p className="fnd-tc-guide__title type-tiny font-mono uppercase tracking-wide">
              Manual install
            </p>
            <ol className="foundry-toolchain-install-guide__body fnd-tc-guide__body list-decimal list-inside space-y-1 type-tiny font-mono leading-relaxed">
              <li>
                Download <span className="fnd-tc-guide__hl">{info.archive_name}</span> from the GitHub
                release (or use Download above).
              </li>
              <li>
                Place the file in the cache folder below — do not extract it yourself.
              </li>
              <li>
                Click <span className="fnd-tc-guide__hl">Install from cache</span> — the app extracts
                and verifies into <span className="fnd-tc-guide__hl">toolchain\</span> automatically.
              </li>
            </ol>

            <div className="fnd-tc-cache-box rounded-sm px-2 py-1.5 space-y-0.5">
              <div className="fnd-tc-cache-box__label type-micro font-mono uppercase">Cache folder</div>
              <div className="fnd-tc-cache-box__path type-tiny font-mono break-all">
                {info.archive_cache_dir}
              </div>
              {!info.manifest_present && (
                <div className="fnd-tc-cache-box__note type-micro font-mono">
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
            </div>
          </div>
        )}

        {actionError && (
          <p className="fnd-tc-error type-micro font-mono break-all">{actionError}</p>
        )}
      </div>
    );
  }

  const statusLabel = info.all_ready
    ? "READY"
    : info.runtime_ready
      ? "PARTIAL"
      : `${info.profiles_ready}/${info.profiles_total} PROFILES`;

  const statusClass = info.all_ready
    ? "fnd-tc-status--done"
    : "fnd-tc-status--warn";

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="fnd-tc-section-label type-tiny font-mono uppercase tracking-wider">
          Foundry Toolchain
        </span>
        <span className={`fnd-tc-status type-micro font-mono px-1.5 py-0.5 rounded-sm border ${statusClass}`}>
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
              className={`fnd-tc-env-badge type-micro font-mono px-1.5 py-0.5 rounded-sm border ${
                ready
                  ? "fnd-tc-env-badge--ready"
                  : "fnd-tc-env-badge--pending"
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

      {crtError && (
        <p className="fnd-tc-crt-hint type-tiny font-mono leading-relaxed">
          {crtError}
        </p>
      )}

      {info.all_ready ? (
        <p className="fnd-tc-ready type-tiny font-mono leading-relaxed">
          Portable VS Build Tools, Windows SDK, CUDA, and CMake are installed. Foundry builds and bundled engines are ready.
        </p>
      ) : (
        <div className="foundry-toolchain-install-guide fnd-tc-guide--warn border rounded-sm p-2.5 space-y-2">
          <p className="foundry-toolchain-install-guide__title fnd-tc-guide__title--warn type-tiny font-mono font-bold uppercase tracking-wide">
            {onboarding ? "One-click toolchain" : "Install portable toolchain"}
          </p>

          <p className="fnd-tc-guide__desc type-tiny font-mono leading-relaxed">
            Single download (~{info.compressed_size_label}): VS Build Tools, Windows SDK, both CUDA versions, and CMake.
            Required for Foundry cmake builds and for running bundled CUDA engines.
          </p>

          {!info.all_ready && info.profiles_ready < info.profiles_total && (
            <div className="fnd-tc-profiles-box rounded-sm px-2 py-1.5 space-y-0.5">
              <p className="fnd-tc-profiles-box__title type-micro font-mono uppercase tracking-wide">
                {info.profiles_ready}/{info.profiles_total} build profiles ready
              </p>
              {info.profile_checks
                .filter((c) => !c.ready)
                .map((c) => (
                  <p
                    key={c.id}
                    className="fnd-tc-profiles-box__row type-micro font-mono leading-relaxed"
                    title={c.missing.join("\n")}
                  >
                    ○ {c.label}: {c.missing[0] ?? "incomplete"}
                    {c.missing.length > 1 ? ` (+${c.missing.length - 1} more)` : ""}
                  </p>
                ))}
            </div>
          )}

          <div className="fnd-tc-archive-box rounded-sm px-2 py-2 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="fnd-tc-archive-box__name type-tiny font-mono font-bold uppercase">
                {info.archive_name}
              </span>
              <span className="fnd-tc-archive-box__meta type-micro font-mono">
                {info.compressed_size_label} download · {info.uncompressed_size_label} installed
              </span>
            </div>
            <p className="fnd-tc-archive-box__desc type-micro font-mono leading-relaxed">
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
                  showManual ? " fnd-tc-btn--manual-active" : ""
                }`}
              >
                {showManual ? "HIDE MANUAL" : "MANUAL"}
              </button>
            </div>
          </div>

          {showManual && (
            <div className="foundry-toolchain-install-guide fnd-tc-guide border rounded-sm p-2.5 space-y-2">
              <p className="fnd-tc-guide__title type-tiny font-mono uppercase tracking-wide">
                Manual install
              </p>
              <ol className="foundry-toolchain-install-guide__body fnd-tc-guide__body list-decimal list-inside space-y-1 type-tiny font-mono leading-relaxed">
                <li>
                  Download <span className="fnd-tc-guide__hl">{info.archive_name}</span> from the GitHub
                  release (or use Download above).
                </li>
                <li>
                  Place the file in the cache folder below — do not extract it yourself.
                </li>
                <li>
                  Click <span className="fnd-tc-guide__hl">Install from cache</span> — the app extracts
                  and verifies into <span className="fnd-tc-guide__hl">toolchain\</span> automatically.
                </li>
              </ol>

              <div className="fnd-tc-cache-box rounded-sm px-2 py-1.5 space-y-0.5">
                <div className="fnd-tc-cache-box__label type-micro font-mono uppercase">Cache folder</div>
                <div className="fnd-tc-cache-box__path type-tiny font-mono break-all">
                  {info.archive_cache_dir}
                </div>
                {!info.manifest_present && (
                  <div className="fnd-tc-cache-box__note type-micro font-mono">
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
        <p className="fnd-tc-error type-micro font-mono break-all">{actionError}</p>
      )}
    </div>
  );
}