import type { ReactNode } from "react";
import { ProviderConfig, BinaryUpdateInfo, BuildInfo } from "../lib/types";
import { isProfileSourceActive, profileEnvLookup } from "../lib/types";
import type { Env } from "../hooks/useBuildDock";
import { ENV_META } from "../lib/foundry_constants";
import { cudaArchOptimizedLabel, resolveProfileCudaArchitectures } from "../lib/cudaArchUtils";

export type UpdateStatus = "idle" | "checking" | "downloading" | "extracting" | "complete" | "error";

export type BinarySourceKind = "foundry" | "bundled";

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

/** True when this inventory row has the newer build date vs the other source for the same profile. */
function isNewestSourceForProfile(provider: ProviderConfig, env: string, source: BinarySourceKind): boolean {
  const foundryDate = profileEnvLookup(provider.foundryBuildInfoPerEnv, env)?.buildDate ?? "";
  const bundledDate = profileEnvLookup(provider.bundledBuildInfoPerEnv, env)?.buildDate ?? "";
  if (!foundryDate && !bundledDate) return false;
  if (foundryDate && !bundledDate) return source === "foundry";
  if (!foundryDate && bundledDate) return source === "bundled";
  if (source === "foundry") return foundryDate >= bundledDate;
  return bundledDate > foundryDate;
}

function originBadge(origin: string | null): ReactNode {
  if (origin === "foundry") return <span className="value-chip text-[6px] font-mono px-1 py-0.5 rounded-sm">FOUNDRY</span>;
  if (origin === "downloaded") return <span className="value-chip text-[6px] font-mono px-1 py-0.5 rounded-sm">DOWNLOADED</span>;
  if (origin === "bundled") return <span className="value-chip text-[6px] font-mono px-1 py-0.5 rounded-sm">BUNDLED</span>;
  return null;
}

function buildInfoLine(buildInfo: BuildInfo | undefined, provider: ProviderConfig, _env: string) {
  if (!buildInfo) {
    return <span className="text-[8px] font-mono config-muted opacity-60">not available</span>;
  }
  const cudaArchitectures = resolveProfileCudaArchitectures(provider, buildInfo);
  const cudaArchLabel = cudaArchOptimizedLabel(cudaArchitectures);
  return (
    <>
      <span
        className="text-[8px] font-mono config-muted truncate"
        title={`v${buildInfo.version}${buildInfo.cudaVersion ? ` · CUDA ${buildInfo.cudaVersion}` : ""} · Built: ${buildInfo.buildDate}${cudaArchLabel ? ` · ${cudaArchLabel}` : ""}`}
      >
        v{buildInfo.version}{buildInfo.cudaVersion ? ` · CUDA ${buildInfo.cudaVersion}` : ""} · {buildInfo.buildDate}
      </span>
      {cudaArchLabel && (
        <span className="foundry-cuda-arch-inline text-[7px] font-mono shrink-0">
          {cudaArchLabel}
        </span>
      )}
    </>
  );
}

// ── Per-source inventory row ─────────────────────────────────

interface BinarySourceRowProps {
  source: BinarySourceKind;
  env: Env;
  provider: ProviderConfig;
  isActive: boolean;
  hasBackup: boolean;
  isBuilding?: boolean;
  onSelect: () => void;
  onBuild?: () => void;
  onRestoreConfirm?: () => void;
  binaryUpdate?: BinaryUpdateInfo;
  updateStatus: UpdateStatus;
  updateError?: string;
  onUpdateBinary?: () => void;
  onRevert?: () => void;
  showDownloadedRevert?: boolean;
}

function BinarySourceRow({
  source,
  env,
  provider,
  isActive,
  hasBackup,
  isBuilding,
  onSelect,
  onBuild,
  onRestoreConfirm,
  binaryUpdate,
  updateStatus,
  updateError,
  onUpdateBinary,
  onRevert,
  showDownloadedRevert,
}: BinarySourceRowProps) {
  const label = source === "foundry" ? "Foundry build" : "Bundled with installer";
  const path =
    source === "foundry"
      ? profileEnvLookup(provider.foundryBinaryPathPerEnv, env)
      : profileEnvLookup(provider.bundledBinaryPathPerEnv, env);
  const buildInfo =
    source === "foundry"
      ? profileEnvLookup(provider.foundryBuildInfoPerEnv, env)
      : profileEnvLookup(provider.bundledBuildInfoPerEnv, env);
  const available = !!(path?.trim() || buildInfo);

  const hasUpdateInfo = source === "bundled" && !!binaryUpdate;
  const installedVersion = provider.downloadedVersionPerEnv?.[env] || null;
  const latestVersion = binaryUpdate?.latestVersion || null;
  const isLatest = installedVersion === `v${latestVersion}` && installedVersion !== null;
  const isCustomBuild = source === "bundled" && !!path && !installedVersion && !isDownloadedBinary(path);
  const needsDownload = source === "bundled" && !installedVersion && hasUpdateInfo;
  const isNewestBuild = isNewestSourceForProfile(provider, env, source);

  return (
    <div className={`foundry-profile-row flex items-center gap-2 px-3 py-1.5 flex-wrap ${isActive ? "foundry-profile-row--active" : ""}`}>
      <span className="foundry-source-label text-[8px] font-mono config-muted shrink-0 w-[132px] truncate" title={label}>
        {label}
      </span>

      <div className="foundry-profile-badges flex items-center gap-1 shrink-0">
        {originBadge(source)}
      </div>

      <div className="flex-1 min-w-[120px] flex items-center gap-2 flex-wrap">
        {buildInfoLine(buildInfo, provider, env)}
        {isNewestBuild && !!buildInfo && (
          <span className="value-chip text-[7px] font-mono px-1.5 py-0.5 rounded-sm shrink-0">LATEST</span>
        )}
        {hasUpdateInfo && !isBuilding && source === "bundled" && (
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

      {showDownloadedRevert && onRevert && (
        <button onClick={onRevert} className="value-chip text-[7px] font-mono px-2 py-1 shrink-0" title="Revert to bundled binary">
          ↻ REVERT
        </button>
      )}

      {source === "foundry" && hasBackup && buildInfo && onRestoreConfirm && (
        <button onClick={onRestoreConfirm} className="value-chip text-[7px] font-mono px-2 py-1 shrink-0" title={`Restore previous foundry build for ${ENV_META[env].label}`}>
          ↻ RESTORE
        </button>
      )}

      {source === "foundry" && onBuild && (
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
      )}

      {available ? (
        isActive ? (
          <span className="foundry-active-binary-badge text-[7px] font-mono px-2 py-1 shrink-0">ACTIVE BINARY</span>
        ) : (
          <button onClick={onSelect} className="value-chip text-[7px] font-mono px-2 py-1 shrink-0" title={`Use ${label.toLowerCase()} for launch`}>
            USE
          </button>
        )
      ) : (
        <span className="text-[7px] font-mono config-muted opacity-50 shrink-0">—</span>
      )}
    </div>
  );
}

// ── Build Profile Row (header + two source rows) ───────────────

interface BuildProfileRowProps {
  env: Env;
  meta: { label: string; cuda: string; vs: string; color: Env };
  provider: ProviderConfig;
  hasFoundryBackup: boolean;
  isBuilding?: boolean;
  onBuild: () => void;
  onRestoreConfirm: () => void;
  onSelectSource: (source: BinarySourceKind) => void;
  binaryUpdate?: BinaryUpdateInfo;
  updateStatus: UpdateStatus;
  updateError?: string;
  onUpdateBinary: () => void;
  onRevert: () => void;
}

export function BuildProfileRow({
  env,
  meta,
  provider,
  hasFoundryBackup,
  isBuilding,
  onBuild,
  onRestoreConfirm,
  onSelectSource,
  binaryUpdate,
  updateStatus,
  updateError,
  onUpdateBinary,
  onRevert,
}: BuildProfileRowProps) {
  const activePath = profileEnvLookup(provider.binaryPathPerEnv, env);
  const isDownloaded = !!activePath && isDownloadedBinary(activePath);
  const foundryActive = isProfileSourceActive(provider, env, "foundry");
  const bundledActive = isProfileSourceActive(provider, env, "bundled");

  return (
    <div className="foundry-profile-group space-y-1">
      <div className="foundry-profile-header flex items-center gap-2 px-3 pt-1">
        <span className="foundry-profile-label text-[10px] font-mono tracking-wider shrink-0 w-[76px]">
          {meta.label}
        </span>
        <div className="foundry-profile-badges flex items-center gap-1 shrink-0">
          {isDownloaded && originBadge("downloaded")}
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
      </div>

      <BinarySourceRow
        source="foundry"
        env={env}
        provider={provider}
        isActive={foundryActive && !isDownloaded}
        hasBackup={hasFoundryBackup}
        isBuilding={isBuilding}
        onSelect={() => onSelectSource("foundry")}
        onBuild={onBuild}
        onRestoreConfirm={onRestoreConfirm}
        updateStatus={updateStatus}
      />

      <BinarySourceRow
        source="bundled"
        env={env}
        provider={provider}
        isActive={bundledActive && !isDownloaded}
        hasBackup={false}
        onSelect={() => onSelectSource("bundled")}
        binaryUpdate={binaryUpdate}
        updateStatus={updateStatus}
        updateError={updateError}
        onUpdateBinary={onUpdateBinary}
        onRevert={onRevert}
        showDownloadedRevert={isDownloaded}
      />
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