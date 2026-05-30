import { ProviderConfig, BinaryUpdateInfo } from "../lib/types";
import { getProviderOrigin } from "../lib/types";
import type { Env } from "../hooks/useBuildDock";
import { getEnvColors, ENV_META } from "../lib/foundry_constants";

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
  const c = getEnvColors(meta.color);
  const binaryPath = provider.binaryPathPerEnv?.[env];
  const isDownloaded = !!binaryPath && isDownloadedBinary(binaryPath);

  const hasUpdateInfo = !!binaryUpdate;
  const installedVersion = provider.downloadedVersionPerEnv?.[env] || null;
  const latestVersion = binaryUpdate?.latestVersion || null;
  const isLatest = installedVersion === `v${latestVersion}` && installedVersion !== null;

  const isCustomBuild = !!binaryPath && !installedVersion && !isDownloaded;
  const needsDownload = !installedVersion && hasUpdateInfo;

  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded border ${c.border} ${c.bg}`}>
      {/* Env label + origin badge */}
      <div className="flex-shrink-0 w-24 flex items-center gap-1.5">
        <span className={`text-xl font-mono tracking-wider ${c.text}`}>{meta.label}</span>
        {(() => {
          const origin = getProviderOrigin(provider, env);
          if (origin === 'foundry') return <span className="text-[6px] font-mono px-1 py-0.5 rounded-sm border border-purple-400/30 bg-purple-400/10 text-purple-400">FOUNDRY</span>;
          if (origin === 'downloaded') return <span className="text-[6px] font-mono px-1 py-0.5 rounded-sm border border-yellow-400/30 bg-yellow-400/10 text-yellow-400">DOWNLOADED</span>;
          return null;
        })()}
      </div>

      {/* Toolchain badges */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className="text-[7px] font-mono px-1.5 py-0.5 rounded-sm border text-[#4ade80] bg-[#4ade80]/10 border-[#4ade80]/30">
          CUDA {meta.cuda}
        </span>
        <span className="text-[7px] font-mono px-1.5 py-0.5 rounded-sm border border-stealth-border/30 bg-stealth-panel/50 text-white/70">
          {meta.vs}
        </span>
        {getPrNumberForEnv(provider, env) && (
          <span className="text-[7px] font-mono px-1.5 py-0.5 rounded-sm border border-purple-400/30 bg-purple-400/10 text-purple-400">
            PR #{getPrNumberForEnv(provider, env)}
          </span>
        )}
      </div>

      {/* Build info / version or placeholder */}
      <div className="flex-1 min-w-0 flex items-center gap-2">
        {buildInfo ? (
          <>
            <span className="text-[8px] font-mono text-white/80 truncate block" title={`v${buildInfo.version}${buildInfo.cudaVersion ? ` · CUDA ${buildInfo.cudaVersion}` : ""} · Built: ${buildInfo.buildDate}`}>
              v{buildInfo.version}{buildInfo.cudaVersion ? ` · CUDA ${buildInfo.cudaVersion}` : ""} · {buildInfo.buildDate}
            </span>
            {isLatestBuild && (
              <span className="flex-shrink-0 text-[7px] font-mono tracking-wider text-[#4ade80] border-2 border-double border-[#4ade80]/40 px-1.5 py-0.5 rounded-sm">
                LATEST BUILD
              </span>
            )}
          </>
        ) : (
          <span className="text-[8px] font-mono text-white/25">not yet built</span>
        )}

        {/* Binary update status */}
        {hasUpdateInfo && !isBuilding && (
          <div className="flex-shrink-0 flex items-center gap-1.5">
            {updateStatus === "idle" && isCustomBuild && (
              <span className="text-[7px] font-mono tracking-wider text-purple-400 border border-purple-400/30 bg-purple-400/10 px-1.5 py-0.5 rounded-sm">CUSTOM BUILD</span>
            )}
            {updateStatus === "idle" && isLatest && (
              <span className="text-[7px] font-mono text-[#4ade80]">✓ Latest</span>
            )}
            {updateStatus === "idle" && binaryUpdate?.available && installedVersion && !isCustomBuild && (
              <>
                <span className="text-[7px] font-mono text-yellow-400/60">→ v{latestVersion}</span>
                <button
                  onClick={onUpdateBinary}
                  className="px-2 py-0.5 text-[7px] font-mono border border-yellow-400/30 bg-yellow-400/10 text-yellow-400 hover:bg-yellow-400/20 transition-colors"
                >
                  UPDATE
                </button>
              </>
            )}
            {updateStatus === "idle" && needsDownload && !isCustomBuild && (
              <button
                onClick={onUpdateBinary}
                className="px-2 py-0.5 text-[7px] font-mono border border-yellow-400/30 bg-yellow-400/10 text-yellow-400 hover:bg-yellow-400/20 transition-colors"
              >
                DOWNLOAD v{latestVersion}
              </button>
            )}
            {updateStatus === "checking" && (
              <span className="text-[7px] font-mono text-stealth-muted">Checking...</span>
            )}
            {updateStatus === "downloading" && (
              <span className="text-[7px] font-mono text-yellow-400/80 animate-pulse">Downloading...</span>
            )}
            {updateStatus === "extracting" && (
              <span className="text-[7px] font-mono text-yellow-400/80 animate-pulse">Extracting...</span>
            )}
            {updateStatus === "complete" && (
              <span className="text-[7px] font-mono text-[#4ade80]">Updated ✓</span>
            )}
            {updateStatus === "error" && (
              <>
                <span className="text-[7px] font-mono text-red-400 truncate max-w-[120px]" title={updateError}>
                  Error: {updateError?.split("\n")[0]}
                </span>
                <button
                  onClick={onUpdateBinary}
                  className="px-1.5 py-0.5 text-[7px] font-mono border border-red-400/30 text-red-400 hover:bg-red-400/10 transition-colors"
                >
                  RETRY
                </button>
              </>
            )}
          </div>
        )}
      </div>

      {/* Revert button — appears if binary came from download */}
      {isDownloaded && (
        <button
          onClick={onRevert}
          className="flex-shrink-0 px-2 py-1 text-[7px] font-mono border border-blue-400/30 text-blue-400 hover:bg-blue-400/10 transition-colors"
          title="Revert to bundled binary"
        >
          ↻ REVERT
        </button>
      )}

      {/* Restore button — appears if backup exists */}
      {hasBackup && buildInfo && !isDownloaded && (
        <button
          onClick={onRestoreConfirm}
          className="flex-shrink-0 px-2 py-1 text-[7px] font-mono border border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/10 transition-colors"
          title={`Restore previous build for ${meta.label}`}
        >
          ↻ RESTORE
        </button>
      )}

      {/* Build button */}
      <button
        onClick={onBuild}
        disabled={!provider.git_url || !!isBuilding}
        className={`flex-shrink-0 px-3 py-1 text-[8px] font-mono border transition-colors ${
          isBuilding 
            ? "border-yellow-400/20 text-yellow-400/50" 
            : `${c.border} ${c.text}`
        } hover:${isBuilding ? "" : c.badgeBg} disabled:opacity-30 disabled:cursor-not-allowed`}
      >
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
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="w-[45vw] max-w-[480px] border border-yellow-400/40 bg-stealth-panel rounded-sm shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-stealth-border">
          <h3 className="text-xs font-mono text-yellow-400 tracking-wider">↻ RESTORE PREVIOUS BUILD</h3>
          <button onClick={onCancel} className="text-stealth-muted hover:text-white transition-colors text-sm leading-none">
            &times;
          </button>
        </div>

        {/* Body */}
        <div className="px-4 py-5 space-y-3">
          <p className="text-[10px] font-mono text-stealth-muted uppercase tracking-wider">
            Confirm restore action
          </p>

          <div className="border border-yellow-400/20 bg-yellow-400/[0.03] rounded-sm p-3 space-y-2">
            <p className="text-[10px] font-mono text-white/80">
              This will restore the previous build for <span className="text-yellow-400">{providerId}</span> ({meta.label.toLowerCase()}).
            </p>
            <p className="text-[9px] font-mono text-stealth-muted">
              Any running engines for this provider will be stopped. The current binary will be replaced with the backup.
            </p>
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-stealth-border">
          <button onClick={onCancel}
            className="px-3 py-1 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors">
            NO — CANCEL
          </button>
          <button onClick={onConfirm}
            className="px-4 py-1 text-[9px] font-mono border rounded-sm bg-nv-green/20 border-nv-green/60 text-nv-green hover:bg-nv-green/30 transition-all">
            YES — RESTORE
          </button>
        </div>
      </div>
    </div>
  );
}
