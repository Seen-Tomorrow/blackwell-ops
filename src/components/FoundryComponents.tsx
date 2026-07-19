import type { ReactNode } from "react";
import {
  ProviderConfig,
  BinaryUpdateInfo,
  BuildInfo,
  type BinarySourceKind,
  isProfileSourceActive,
  profileEnvLookup,
} from "../lib/types";
import type { Env } from "../hooks/useBuildDock";
import { ENV_META } from "../lib/foundry_constants";
import { cudaArchOptimizedLabel, resolveProfileCudaArchitectures } from "../lib/cudaArchUtils";

export type UpdateStatus = "idle" | "checking" | "downloading" | "extracting" | "complete" | "error";

export type { BinarySourceKind };

export function parseCmakeFlags(flags: string): string[] {
  if (!flags.trim()) return [];
  const parts = flags.split(/\s+/).filter(p => p && !/^["']+$/.test(p));
  return parts.map(f => f.trim()).filter(Boolean);
}

export function getPrNumberForEnv(provider: ProviderConfig, env: string): string | undefined {
  return provider.lastPrPerEnv?.[env];
}

/** True when this inventory row has the newer build date vs the other source for the same profile. */
function isNewestSourceForProfile(provider: ProviderConfig, env: string, source: BinarySourceKind): boolean {
  const foundryDate = profileEnvLookup(provider.foundryBuildInfoPerEnv, env)?.buildDate ?? "";
  const bundledDate = profileEnvLookup(provider.bundledBuildInfoPerEnv, env)?.buildDate ?? "";
  const catalogDate = profileEnvLookup(provider.catalogBuildInfoPerEnv, env)?.buildDate ?? "";
  const dates = (
    [
      { s: "foundry" as const, d: foundryDate },
      { s: "bundled" as const, d: bundledDate },
      { s: "catalog" as const, d: catalogDate },
    ] satisfies { s: BinarySourceKind; d: string }[]
  ).filter((x) => !!x.d);
  if (dates.length === 0) return false;
  const best = dates.reduce((a, b) => (a.d >= b.d ? a : b));
  return best.s === source;
}

function originBadge(origin: string | null): ReactNode {
  if (origin === "foundry") return <span className="value-chip text-[6px] font-mono px-1 py-0.5 rounded-sm">FOUNDRY</span>;
  if (origin === "catalog" || origin === "downloaded") {
    return <span className="value-chip text-[6px] font-mono px-1 py-0.5 rounded-sm">CATALOG</span>;
  }
  if (origin === "bundled") return <span className="value-chip text-[6px] font-mono px-1 py-0.5 rounded-sm">BUNDLED</span>;
  return null;
}

function sourceLabel(source: BinarySourceKind, provider: ProviderConfig): string {
  if (source === "foundry") return "Foundry build";
  if (source === "catalog") {
    return provider.optionalDownload ? "Catalog pack" : "Catalog pack (overlay)";
  }
  return "Bundled with installer";
}

function inventoryPath(provider: ProviderConfig, env: string, source: BinarySourceKind): string | undefined {
  if (source === "foundry") return profileEnvLookup(provider.foundryBinaryPathPerEnv, env);
  if (source === "catalog") return profileEnvLookup(provider.catalogBinaryPathPerEnv, env);
  return profileEnvLookup(provider.bundledBinaryPathPerEnv, env);
}

function inventoryBuildInfo(
  provider: ProviderConfig,
  env: string,
  source: BinarySourceKind,
): BuildInfo | undefined {
  if (source === "foundry") return profileEnvLookup(provider.foundryBuildInfoPerEnv, env);
  if (source === "catalog") return profileEnvLookup(provider.catalogBuildInfoPerEnv, env);
  return profileEnvLookup(provider.bundledBuildInfoPerEnv, env);
}

function isPlaceholderBuildInfo(info: BuildInfo | undefined): boolean {
  const verRaw = (info?.version || "").trim();
  return !verRaw || /^(catalog|bundled|foundry-artifact|downloaded|disk-scanned|unknown)$/i.test(verRaw);
}

function BuildInfoProbingDots() {
  return (
    <span className="foundry-buildinfo-dots" aria-hidden="true">
      <i>.</i>
      <i>.</i>
      <i>.</i>
    </span>
  );
}

/** Engine build-info primary; optional product tag secondary (catalog packs). */
function buildInfoLine(
  buildInfo: BuildInfo | undefined,
  provider: ProviderConfig,
  env: string,
  source: BinarySourceKind,
) {
  if (!buildInfo) {
    return <span className="text-[8px] font-mono config-muted opacity-60">not available</span>;
  }
  const cudaArchitectures = resolveProfileCudaArchitectures(provider, buildInfo);
  const cudaArchLabel = cudaArchOptimizedLabel(cudaArchitectures);
  const productTag = source === "catalog" ? profileEnvLookup(provider.downloadedVersionPerEnv, env) : undefined;
  const shipped =
    productTag && !/^catalog|bundled|foundry|disk/i.test(productTag)
      ? productTag.startsWith("v") || productTag.startsWith("V")
        ? productTag
        : `v${productTag}`
      : null;
  const verRaw = (buildInfo.version || "").trim();
  const isPlaceholder = /^(catalog|bundled|foundry-artifact|downloaded|disk-scanned|unknown)$/i.test(
    verRaw,
  );
  const engineLabel = isPlaceholder
    ? "engine"
    : verRaw.startsWith("v")
      ? verRaw
      : `v${verRaw}`;
  return (
    <>
      <span
        className="text-[8px] font-mono config-muted truncate"
        title={`Engine ${buildInfo.version}${buildInfo.cudaVersion ? ` · CUDA ${buildInfo.cudaVersion}` : ""} · Built: ${buildInfo.buildDate}${shipped ? ` · shipped ${shipped}` : ""}${cudaArchLabel ? ` · ${cudaArchLabel}` : ""}`}
      >
        {engineLabel}
        {buildInfo.cudaVersion ? ` · CUDA ${buildInfo.cudaVersion}` : ""} · {buildInfo.buildDate}
        {shipped ? (
          <span className="text-stealth-muted/55"> · shipped {shipped}</span>
        ) : null}
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
  /** True while this provider's --version probe is in flight. */
  isProbingBuildInfo?: boolean;
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
  isProbingBuildInfo,
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
  const label = sourceLabel(source, provider);
  const path = inventoryPath(provider, env, source);
  const buildInfo = inventoryBuildInfo(provider, env, source);
  const available = !!(path?.trim() || buildInfo);

  const productTag = profileEnvLookup(provider.downloadedVersionPerEnv, env) || null;
  const latestVersion = binaryUpdate?.latestVersion || null;
  const isLatest =
    !!productTag &&
    !!latestVersion &&
    productTag.replace(/^v/i, "") === latestVersion.replace(/^v/i, "");
  const showUpdateChrome = source === "catalog" && !!binaryUpdate;
  const needsDownload = source === "catalog" && !productTag && !!binaryUpdate?.packAvailable;
  const isNewestBuild = isNewestSourceForProfile(provider, env, source);
  const badgeOrigin = source === "foundry" ? "foundry" : source === "catalog" ? "catalog" : "bundled";

  return (
    <div className={`foundry-profile-row flex items-center gap-2 px-3 py-1.5 flex-wrap ${isActive ? "foundry-profile-row--active" : ""}`}>
      <span className="foundry-source-label text-[8px] font-mono config-muted shrink-0 w-[132px] truncate" title={label}>
        {label}
      </span>

      <div className="foundry-profile-badges flex items-center gap-1 shrink-0">
        {originBadge(badgeOrigin)}
      </div>

      <div className="flex-1 min-w-[120px] flex items-center gap-2 flex-wrap">
        {isProbingBuildInfo && (!buildInfo || isPlaceholderBuildInfo(buildInfo)) ? (
          <span className="foundry-buildinfo-probing text-[8px] font-mono config-muted">
            probing
            <BuildInfoProbingDots />
          </span>
        ) : (
          buildInfoLine(buildInfo, provider, env, source)
        )}
        {isNewestBuild && !!buildInfo && source !== "catalog" && !isProbingBuildInfo && (
          <span className="value-chip text-[7px] font-mono px-1.5 py-0.5 rounded-sm shrink-0">LATEST</span>
        )}
        {showUpdateChrome && !isBuilding && (
          <div className="flex-shrink-0 flex items-center gap-1.5">
            {updateStatus === "idle" && isLatest && (
              <span className="text-[7px] font-mono theme-accent-text">✓ Latest pack</span>
            )}
            {updateStatus === "idle" && binaryUpdate?.available && productTag && (
              <>
                <span className="text-[7px] font-mono config-muted">→ pack v{latestVersion}</span>
                <button onClick={onUpdateBinary} className="value-chip text-[7px] font-mono px-2 py-0.5 rounded-sm">
                  UPDATE
                </button>
              </>
            )}
            {updateStatus === "idle" && needsDownload && (
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

      {showDownloadedRevert && onRevert && source === "catalog" && !provider.optionalDownload && isActive && (
        <button
          onClick={onRevert}
          className="value-chip text-[7px] font-mono px-2 py-1 shrink-0"
          title="Use NSIS-bundled binary (keeps catalog overlay on disk)"
        >
          ↻ USE BUNDLED
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
          {isBuilding ? "BUILDING..." : "FOUNDRY BUILD"}
        </button>
      )}

      {available ? (
        isActive ? (
          <span className="foundry-active-binary-badge text-[7px] font-mono px-2 py-1 shrink-0">ACTIVE BINARY</span>
        ) : (
          <button onClick={onSelect} className="value-chip text-[7px] font-mono px-2 py-1 shrink-0" title={`Use ${label.toLowerCase()} for launch`}>
            ACTIVATE
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
  isProbingBuildInfo?: boolean;
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
  isProbingBuildInfo,
  onBuild,
  onRestoreConfirm,
  onSelectSource,
  binaryUpdate,
  updateStatus,
  updateError,
  onUpdateBinary,
  onRevert,
}: BuildProfileRowProps) {
  const foundryActive = isProfileSourceActive(provider, env, "foundry");
  const bundledActive = isProfileSourceActive(provider, env, "bundled");
  const catalogActive = isProfileSourceActive(provider, env, "catalog");
  const hasCatalog =
    !!profileEnvLookup(provider.catalogBinaryPathPerEnv, env) ||
    !!profileEnvLookup(provider.downloadedVersionPerEnv, env) ||
    !!binaryUpdate?.packAvailable ||
    !!provider.optionalDownload;
  // Bundled only when NSIS (or equivalent) actually left engines on disk — not a grey "not available" row.
  const hasBundled =
    !!profileEnvLookup(provider.bundledBinaryPathPerEnv, env)?.trim() ||
    !!profileEnvLookup(provider.bundledBuildInfoPerEnv, env);
  const showBundled = !provider.optionalDownload && hasBundled;
  const showCatalog = hasCatalog || provider.optionalDownload;

  return (
    <div className="foundry-profile-group space-y-1">
      <div className="foundry-profile-header flex items-center gap-2 px-3 pt-1">
        <span className="foundry-profile-label text-[10px] font-mono tracking-wider shrink-0 w-[76px]">
          {meta.label}
        </span>
        <div className="foundry-profile-badges flex items-center gap-1 shrink-0">
          {catalogActive && originBadge("catalog")}
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
        isActive={foundryActive}
        hasBackup={hasFoundryBackup}
        isBuilding={isBuilding}
        isProbingBuildInfo={isProbingBuildInfo}
        onSelect={() => onSelectSource("foundry")}
        onBuild={onBuild}
        onRestoreConfirm={onRestoreConfirm}
        updateStatus={updateStatus}
      />

      {showBundled && (
        <BinarySourceRow
          source="bundled"
          env={env}
          provider={provider}
          isActive={bundledActive}
          hasBackup={false}
          isProbingBuildInfo={isProbingBuildInfo}
          onSelect={() => onSelectSource("bundled")}
          updateStatus={updateStatus}
        />
      )}

      {showCatalog && (
        <BinarySourceRow
          source="catalog"
          env={env}
          provider={provider}
          isProbingBuildInfo={isProbingBuildInfo}
          isActive={catalogActive}
          hasBackup={false}
          onSelect={() => onSelectSource("catalog")}
          binaryUpdate={binaryUpdate}
          updateStatus={updateStatus}
          updateError={updateError}
          onUpdateBinary={onUpdateBinary}
          onRevert={onRevert}
          showDownloadedRevert={catalogActive && !provider.optionalDownload}
        />
      )}
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