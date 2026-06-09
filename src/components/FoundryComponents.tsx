import type { ReactNode } from "react";
import { ProviderConfig, BinaryUpdateInfo } from "../lib/types";
import { getProviderOrigin } from "../lib/types";
import type { Env } from "../hooks/useBuildDock";
import { ENV_META } from "../lib/foundry_constants";

export type UpdateStatus = "idle" | "checking" | "downloading" | "extracting" | "complete" | "error";

export function parseCmakeFlags(flags: string): string[] {
  if (!flags.trim()) return [];
  const parts = flags.split(/\s+/).filter(p => p && !/^["']+$/.test(p));
  return parts.map(f => f.trim()).filter(Boolean);
}

export function getPrNumberForEnv(provider: ProviderConfig, env: string): string | undefined {
  return provider.lastPrPerEnv?.[env];
}

function isDownloadedBinary(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.includes("updates\\") || normalized.includes("updates/");
}

function originBadge(origin: string | null): ReactNode {
  if (origin === "foundry") return <span className="value-chip text-[6px] font-mono px-1 py-0.5 rounded-sm">FOUNDRY</span>;
  if (origin === "downloaded") return <span className="value-chip text-[6px] font-mono px-1 py-0.5 rounded-sm">DOWNLOADED</span>;
  return null;
}

// ── Build Profile Row ────────────────────────────────────────

interface BuildProfileRowProps {
  env: Env;
  meta: { label: string; cuda: string; vs: string; color: Env };
  provider: ProviderConfig;
  isLatestBuild: boolean;
  hasBackup: boolean;
  isBuilding?: boolean;
  onBuild: () => void;
  onRestoreConfirm: () => void;
  binaryUpdate?: BinaryUpdateInfo;
  updateStatus: UpdateStatus;
  updateError?: string;
  onUpdateBinary: () => void;
  onRevert: () => void;
}

export function BuildProfileRow({ env, meta, provider, isLatestBuild, hasBackup, isBuilding, onBuild, onRestoreConfirm, binaryUpdate, updateStatus, updateError, onUpdateBinary, onRevert }: BuildProfileRowProps) {
  const buildInfo = provider.buildInfoPerEnv?.[env];
  const binaryPath = provider.binaryPathPerEnv?.[env];
  const isDownloaded = !!binaryPath && isDownloadedBinary(binaryPath);

  const hasUpdateInfo = !!binaryUpdate;
  const installedVersion = provider.downloadedVersionPerEnv?.[env] || null;
  const latestVersion = binaryUpdate?.latestVersion || null;
  const isLatest = installedVersion === `v${latestVersion}` && installedVersion !== null;

  const isCustomBuild = !!binaryPath && !installedVersion && !isDownloaded;
  const needsDownload = !installedVersion && hasUpdateInfo;

  return (
    <div className="foundry-profile-row flex items-center gap-2 px-3 py-2 rounded-sm flex-wrap">
      <span className="foundry-profile-label text-[10px] font-mono tracking-wider shrink-0 w-[76px]">
        {meta.label}
      </span>

      <div className="foundry-profile-badges flex items-center gap-1 shrink-0">
        {originBadge(getProviderOrigin(provider, env))}
        <span className="cuda-badge text-[7px] font-mono px-1.5 py-0.5 rounded-sm">CUDA {meta.cuda}</span>
        <span className="value-chip text-[7px] font-mono px-1.5 py-0.5 rounded-sm opacity-80 max-w-[140px] truncate" title={meta.vs}>
          {meta.vs}
        </span>
        {getPrNumberForEnv(provider, env) && (
          <span className="value-chip text-[7px] font-mono px-1.5 py-0.5 rounded-sm">
            PR #{getPrNumberForEnv(provider, env)}
          </span>
        )}
      </div>

      <div className="flex-1 min-w-[120px] flex items-center gap-2">
        {buildInfo ? (
          <>
            <span
              className="text-[8px] font-mono config-muted truncate"
              title={`v${buildInfo.version}${buildInfo.cudaVersion ? ` · CUDA ${buildInfo.cudaVersion}` : ""} · Built: ${buildInfo.buildDate}`}
            >
              v{buildInfo.version}{buildInfo.cudaVersion ? ` · CUDA ${buildInfo.cudaVersion}` : ""} · {buildInfo.buildDate}
            </span>
            {isLatestBuild && (
              <span className="value-chip-active text-[7px] font-mono px-1.5 py-0.5 rounded-sm shrink-0">LATEST</span>
            )}
          </>
        ) : (
          <span className="text-[8px] font-mono config-muted opacity-60">not yet built</span>
        )}

        {hasUpdateInfo && !isBuilding && (
          <div className="flex-shrink-0 flex items-center gap-1.5">
            {updateStatus === "idle" && isCustomBuild && (
              <span className="value-chip text-[7px] font-mono px-1.5 py-0.5 rounded-sm">CUSTOM</span>
            )}
            {updateStatus === "idle" && isLatest && (
              <span className="text-[7px] font-mono theme-accent-text">✓ Latest</span>
            )}
            {updateStatus === "idle" && binaryUpdate?.available && installedVersion && !isCustomBuild && (
              <>
                <span className="text-[7px] font-mono config-muted">→ v{latestVersion}</span>
                <button onClick={onUpdateBinary} className="value-chip text-[7px] font-mono px-2 py-0.5 rounded-sm">
                  UPDATE
                </button>
              </>
            )}
            {updateStatus === "idle" && needsDownload && !isCustomBuild && (
              <button onClick={onUpdateBinary} className="value-chip text-[7px] font-mono px-2 py-0.5 rounded-sm">
                DOWNLOAD v{latestVersion}
              </button>
            )}
            {updateStatus === "checking" && (
              <span className="text-[7px] font-mono config-muted">Checking...</span>
            )}
            {(updateStatus === "downloading" || updateStatus === "extracting") && (
              <span className="text-[7px] font-mono config-muted animate-pulse">
                {updateStatus === "downloading" ? "Downloading..." : "Extracting..."}
              </span>
            )}
            {updateStatus === "complete" && (
              <span className="text-[7px] font-mono theme-accent-text">Updated ✓</span>
            )}
            {updateStatus === "error" && (
              <>
                <span className="text-[7px] font-mono text-red-400 truncate max-w-[120px]" title={updateError}>
                  Error: {updateError?.split("\n")[0]}
                </span>
                <button onClick={onUpdateBinary} className="value-chip text-[7px] font-mono px-1.5 py-0.5 rounded-sm text-red-400">
                  RETRY
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {isDownloaded && (
        <button onClick={onRevert} className="value-chip text-[7px] font-mono px-2 py-1 shrink-0" title="Revert to bundled binary">
          ↻ REVERT
        </button>
      )}

      {hasBackup && buildInfo && !isDownloaded && (
        <button onClick={onRestoreConfirm} className="value-chip text-[7px] font-mono px-2 py-1 shrink-0" title={`Restore previous build for ${meta.label}`}>
          ↻ RESTORE
        </button>
      )}

      <button
        onClick={onBuild}
        disabled={!provider.git_url || !!isBuilding}
        className={`foundry-build-btn value-chip shrink-0 disabled:opacity-30 disabled:cursor-not-allowed ${isBuilding ? "foundry-build-btn--active" : ""}`}
      >
        {isBuilding && (
          <span className="foundry-hammer-icon foundry-hammer-icon--shake" aria-hidden="true">⚒</span>
        )}
        {isBuilding ? "BUILDING..." : "BUILD"}
      </button>
    </div>
  );
}

// ── Restore Confirmation Modal ────────────────────────────────

export function RestoreConfirmModal({ providerId, env, onConfirm, onCancel }: {
  providerId: string;
  env: Env;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const meta = ENV_META[env];
  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="config-form-panel rounded-sm shadow-2xl w-[45vw] max-w-[480px]">
        <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border/30">
          <h3 className="text-xs font-mono theme-accent-text tracking-wider">↻ RESTORE PREVIOUS BUILD</h3>
          <button onClick={onCancel} className="config-muted hover:theme-accent-text transition-colors text-sm leading-none">&times;</button>
        </div>
        <div className="px-4 py-5 space-y-3">
          <p className="text-[10px] font-mono config-muted uppercase tracking-wider">Confirm restore action</p>
          <div className="foundry-profile-row rounded-sm p-3 space-y-2">
            <p className="text-[10px] font-mono leading-relaxed">
              This will restore the previous build for <span className="theme-accent-text">{providerId}</span> ({meta.label.toLowerCase()}).
            </p>
            <p className="text-[9px] font-mono config-muted">
              Only engines using the {meta.label} profile for this provider will be stopped. The current binary will be replaced with the backup.
            </p>
          </div>
        </div>
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-stealth-border/30">
          <button onClick={onCancel} className="value-chip text-[9px] font-mono px-3 py-1 rounded-sm text-red-400">NO — CANCEL</button>
          <button onClick={onConfirm} className="value-chip-active text-[9px] font-mono px-4 py-1 rounded-sm">YES — RESTORE</button>
        </div>
      </div>
    </div>
  );
}