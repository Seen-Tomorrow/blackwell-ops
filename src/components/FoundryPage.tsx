import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ProviderConfig, BinaryUpdateInfo } from "../lib/types";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import { useFoundry, type Env } from "../hooks/useBuildDock";
import { getEnvColors, ENV_ORDER, ENV_META, getStepLabel } from "../lib/foundry_constants";

interface FoundryPageProps {
  providers: ProviderConfig[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
}

type UpdateStatus = "idle" | "checking" | "downloading" | "extracting" | "complete" | "error";

// Parse cmake flags string into individual flag lines for tooltip display
function parseCmakeFlags(flags: string): string[] {
  if (!flags.trim()) return [];
  const parts = flags.split(/\s+/).filter(p => p && !/^["']+$/.test(p));
  return parts.map(f => f.trim()).filter(Boolean);
}

export default function FoundryPage({ providers, onProvidersChange }: FoundryPageProps) {
  const { openBuildModal, buildProgress, attachToActiveBuild } = useFoundry();
  const [restoreConfirm, setRestoreConfirm] = useState<{ providerId: string; env: Env } | null>(null);

  // Binary update state per provider/profile
  const [binaryUpdates, setBinaryUpdates] = useState<Record<string, Record<string, BinaryUpdateInfo>>>({});
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, UpdateStatus>>({});
  const [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});

  // The provider now performs strong reconciliation on mount + visibilitychange.
  // We can rely primarily on the context's buildProgress for "is a build active".
  // The provider (after the 2026 reducer refactor) is now the authoritative source for active builds.
  // We keep `attachToActiveBuild` available for edge cases, but the auto-recovery banner is rarely needed.

  // Refresh build info after successful build completes (via Tauri event)
  useEffect(() => {
    const unsub = listen<{ build_id: number; phase: string; provider_id: string }>("foundry-progress", async (e) => {
      if (e.payload.phase === "Complete") {
        try {
          const updated = await invoke<ProviderConfig[]>("refresh_build_info", { providerId: e.payload.provider_id });
          if (updated.length > 0) onProvidersChange(updated);
        } catch (err) { console.error("[Foundry] Status check error:", err); }
      }
    });
    return () => { unsub.then(u => u()); };
  }, [onProvidersChange]);

  // Refresh build info on mount — ref guard prevents double-call in StrictMode + cooldown
  const hasRefreshed = useRef(false);
  useEffect(() => {
    if (hasRefreshed.current) return;
    hasRefreshed.current = true;

    const lastRefreshKey = `foundry_last_refresh_${providers.map(p => p.id).join(",")}`;
    const lastRefresh = parseInt(localStorage.getItem(lastRefreshKey) || "0", 10);
    const now = Date.now();
    if (now - lastRefresh < 5000) {
      // Skip refresh if done within last 5 seconds
      hasRefreshed.current = false; // Allow re-check on next mount
      return;
    }
    localStorage.setItem(lastRefreshKey, String(now));

    const foundryProviders = providers.filter(p => p.git_url && p.branch);
    let cancelled = false;
    foundryProviders.forEach(async (p) => {
      try {
        const updated = await invoke<ProviderConfig[]>("refresh_build_info", { providerId: p.id });
        if (!cancelled && updated.length > 0) onProvidersChange(updated);
      } catch (err) {
        console.error("[Foundry] Failed to refresh build info for", p.id, err);
      }
    });

    let cachedUpdates: Record<string, BinaryUpdateInfo[]> | null = null;
    try {
      const raw = localStorage.getItem("blackwell_startup_updates");
      if (raw) {
        const parsed = JSON.parse(raw);
        // Use cache only if less than 5 minutes old
        if (parsed.timestamp && Date.now() - parsed.timestamp < 300_000 && parsed.binaryUpdates) {
          cachedUpdates = {};
          parsed.binaryUpdates.forEach((bu: any) => {
            cachedUpdates[bu.providerId] = bu.updates;
          });
        }
      }
    } catch (err) { console.error("[Foundry] Build info refresh error:", err); }

    foundryProviders.forEach(async (p) => {
      try {
        let updates: BinaryUpdateInfo[];
        if (cachedUpdates && cachedUpdates[p.id]) {
          // Use cached data from startup check
          updates = cachedUpdates[p.id];
        } else {
          // Fetch fresh — no cache or stale
          updates = await invoke<BinaryUpdateInfo[]>("check_binary_updates", { providerId: p.id });
        }
        if (!cancelled && updates.length > 0) {
          // Fill in installed versions from downloadedVersionPerEnv (GitHub release tag, not internal version)
          const withInstalled = updates.map(u => ({
            ...u,
            installedVersion: (p.downloadedVersionPerEnv?.[u.profile] || null),
            available: u.available && !(p.downloadedVersionPerEnv?.[u.profile] === `v${u.latestVersion}`),
          }));
          setBinaryUpdates(prev => {
            const next = { ...prev };
            next[p.id] = {};
            withInstalled.forEach(u => { next[p.id]![u.profile] = u; });
            return next;
          });
        }
      } catch (err) {
        console.error("[Foundry] Failed to check binary updates for", p.id, err);
      }
    });

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Listen for binary update events
  useEffect(() => {
    let unsubStart: (() => void) | null = null;
    let unsubProgress: (() => void) | null = null;
    let unsubComplete: (() => void) | null = null;
    let unsubError: (() => void) | null = null;

    listen("binary-update:download-start", (e: any) => {
      const p = e.payload as { provider_id: string; profile: string };
      const key = `${p.provider_id}:${p.profile}`;
      setUpdateStatuses(prev => ({ ...prev, [key]: "downloading" }));
    }).then(u => { unsubStart = u; });

    listen("binary-update:download-progress", (e: any) => {
      const p = e.payload as { provider_id: string; profile: string; status: string };
      const key = `${p.provider_id}:${p.profile}`;
      setUpdateStatuses(prev => ({ ...prev, [key]: p.status === "extracting" ? "extracting" : "downloading" }));
    }).then(u => { unsubProgress = u; });

    listen("binary-update:download-complete", (e: any) => {
      const p = e.payload as { provider_id: string; profile: string };
      const key = `${p.provider_id}:${p.profile}`;
      setUpdateStatuses(prev => ({ ...prev, [key]: "complete" }));
      // Refresh build info after update completes
      invoke<ProviderConfig[]>("refresh_build_info", { providerId: p.provider_id })
        .then(updated => { if (updated.length > 0) onProvidersChange(updated); })
        .catch((err) => console.error("[Foundry] Binary update event error:", err));
    }).then(u => { unsubComplete = u; });

    return () => {
      unsubStart?.();
      unsubProgress?.();
      unsubComplete?.();
      unsubError?.();
    };
  }, [onProvidersChange]);

  const handleRestore = async () => {
    if (!restoreConfirm) return;
    try {
      await invoke("foundry_restore", {
        providerId: restoreConfirm.providerId,
        environment: restoreConfirm.env,
      });
      await invoke<ProviderConfig[]>("refresh_build_info", { providerId: restoreConfirm.providerId })
        .then(updated => { if (updated.length > 0) onProvidersChange(updated); })
        .catch((err) => console.error("[Foundry] Binary update event error:", err));
    } catch (err) {
      console.error("[Foundry] Restore failed:", err);
    } finally {
      setRestoreConfirm(null);
    }
  };

  const handleBinaryUpdate = useCallback(async (providerId: string, profile: Env) => {
    const key = `${providerId}:${profile}`;
    setUpdateStatuses(prev => ({ ...prev, [key]: "checking" }));
    setUpdateErrors(prev => { const next = { ...prev }; delete next[key]; return next; });

    try {
      await invoke("download_binary_update", { providerId, profile });
    } catch (err) {
      const msg = typeof err === "string" ? err : String(err);
      setUpdateStatuses(prev => ({ ...prev, [key]: "error" }));
      setUpdateErrors(prev => ({ ...prev, [key]: msg }));
      console.error("[Foundry] Binary update failed:", err);
    }
  }, []);

  const handleRevert = useCallback(async (providerId: string, profile: Env) => {
    try {
      await invoke("revert_binary_to_bundled", { providerId, profile });
      // Refresh to pick up reverted paths
      invoke<ProviderConfig[]>("refresh_build_info", { providerId: providerId })
        .then(updated => { if (updated.length > 0) onProvidersChange(updated); })
        .catch((err) => console.error("[Foundry] Binary update event error:", err));
    } catch (err) {
      console.error("[Foundry] Revert failed:", err);
    }
  }, [onProvidersChange]);

  const foundryProviders = providers.filter(p => p.git_url && p.branch);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-stealth-border flex items-center gap-2">
        <span style={{ fontSize: '16px' }}>⚒</span>
        <h2 className="text-[11px] font-mono text-nv-green tracking-wider">REACTOR FOUNDRY</h2>
        <span className="text-[9px] font-mono text-stealth-muted ml-2">{foundryProviders.length} provider{foundryProviders.length !== 1 ? "s" : ""} with build config</span>
      </div>

      {/* Legend */}
      <div className="px-4 py-2 border-b border-stealth-border/50 flex items-center gap-3">
        <span className="text-[8px] font-mono text-stealth-muted tracking-wider">LEGEND:</span>
        <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-yellow-400" /> PRE-BUILT (GitHub)</span>
        <span className="flex items-center gap-1"><span className="inline-block w-1.5 h-1.5 rounded-full bg-nv-green" /> CUSTOM BUILD (Foundry)</span>
      </div>

      {/* Recovery affordance — only shown when the UI has no session but we suspect a build might still be relevant on the backend.
          We deliberately hide it after a build has cleanly reached Complete/Error (user should close the modal to dismiss). */}
      {!buildProgress && (
        <div className="mx-4 mt-2 p-2 border border-yellow-400/30 bg-yellow-400/[0.03] rounded-sm flex items-center justify-between text-[9px] font-mono">
          <span className="text-yellow-400/80">UI lost track of the build (common after minimize/close). If something is still running on the backend:</span>
          <button
            onClick={() => attachToActiveBuild()}
            className="px-2 py-0.5 text-[8px] font-mono border border-yellow-400/60 text-yellow-400 hover:bg-yellow-400/10"
          >
            SYNC WITH BACKEND
          </button>
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {foundryProviders.length === 0 && (
          <div className="flex items-center justify-center h-full text-stealth-muted text-xs font-mono">
            NO PROVIDERS WITH FOUNDRY CONFIG — ADD GIT URL IN PROVIDER SETTINGS
          </div>
        )}

        {foundryProviders.map(p => (
          <FoundryProviderCard
            key={p.id}
            provider={p}
            onBuild={(env) => openBuildModal(p.id, env)}
            onRestoreConfirm={(env) => setRestoreConfirm({ providerId: p.id, env })}
            buildProgress={buildProgress}
            binaryUpdates={binaryUpdates[p.id] || {}}
            updateStatuses={updateStatuses}
            updateErrors={updateErrors}
            onUpdateBinary={handleBinaryUpdate}
            onRevert={handleRevert}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-stealth-border flex items-center justify-between">
        <span className="text-[9px] font-mono text-stealth-muted">
          {foundryProviders.length}/{providers.length} providers with Foundry build config
        </span>
      </div>

      {/* Restore Confirmation Modal */}
      {restoreConfirm && (
        <RestoreConfirmModal
          providerId={restoreConfirm.providerId}
          env={restoreConfirm.env}
          onConfirm={handleRestore}
          onCancel={() => setRestoreConfirm(null)}
        />
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────

interface FoundryProviderCardProps {
  provider: ProviderConfig;
  onBuild: (env: Env) => void;
  onRestoreConfirm: (env: Env) => void;
  buildProgress?: { providerId: string; environment: string } | null;
  binaryUpdates: Record<string, BinaryUpdateInfo>;
  updateStatuses: Record<string, UpdateStatus>;
  updateErrors: Record<string, string>;
  onUpdateBinary: (providerId: string, profile: Env) => void;
  onRevert: (providerId: string, profile: Env) => void;
}

function FoundryProviderCard({ provider, onBuild, onRestoreConfirm, buildProgress: bp, binaryUpdates, updateStatuses, updateErrors, onUpdateBinary, onRevert }: FoundryProviderCardProps) {
  const latestEnv = (() => {
    let latestDate = "";
    let latestKey: Env | null = null;
    for (const env of ENV_ORDER) {
      const info = provider.buildInfoPerEnv?.[env];
      if (info && info.buildDate > latestDate) {
        latestDate = info.buildDate;
        latestKey = env;
      }
    }
    return latestKey;
  })();

  const cmakeFlags = provider.build_profile?.trim() || "";
  const isCustomFlags = cmakeFlags.length > 0;
  const flagLines = parseCmakeFlags(cmakeFlags);

  return (
    <div className="rounded border border-stealth-border overflow-hidden">
      {/* Provider header */}
      <div className="flex items-center gap-4 px-4 py-2.5 bg-[#0a0a1a] border-b border-stealth-border/30">
        <span className="text-[10px] font-mono text-yellow-400">{provider.id}</span>
        <span className="text-[10px] font-mono text-white truncate max-w-[200px]" title={provider.display_name}>
          {provider.display_name}
        </span>
        {provider.id === DEFAULT_PROVIDER_ID && (
          <span className="text-[7px] font-mono tracking-wider text-nv-green/60 px-1.5 py-0 border border-nv-green/20 rounded-sm flex-shrink-0">DEFAULT</span>
        )}
        <div className="flex-1" />
        {/* CMake flags badge */}
        <div className="relative inline-block group">
          <span
            className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm border cursor-help ${
              isCustomFlags
                ? "border-purple-400/30 bg-purple-400/10 text-purple-400"
                : "border-stealth-border/30 bg-stealth-panel/50 text-white/40"
            }`}
          >
            {isCustomFlags ? "CUSTOM FLAGS" : "DEFAULT"}
          </span>
          <div className="absolute top-full right-0 mt-1 w-[320px] bg-[#0a0a1a] border border-stealth-border rounded-sm p-2 pointer-events-none z-[9999] opacity-0 group-hover:opacity-100 transition-opacity shadow-2xl">
            {flagLines.length > 0 ? (
              <div className="space-y-0.5">
                {flagLines.map((f, i) => (
                  <div key={i} className="text-[7px] font-mono text-white/60 whitespace-pre-wrap break-all">{f}</div>
                ))}
              </div>
            ) : (
              <div className="text-[7px] font-mono text-stealth-muted">Using default cmake flags for {provider.template_type || "ggml-llama"}</div>
            )}
          </div>
        </div>
        <span className="text-[8px] font-mono text-stealth-muted truncate max-w-[240px]" title={provider.git_url}>
          {provider.git_url.replace(/.*\/\/|\.git$/g, "")} :{provider.branch}
        </span>
      </div>

      {/* Build profiles — vertical stack */}
      <div className="p-3 space-y-2">
        {ENV_ORDER.map(env => {
          const meta = ENV_META[env];
          const hasBackup = provider.binaryPathPerEnv?.[env] || provider.buildInfoPerEnv?.[env];
          return (
            <BuildProfileRow
              key={env}
              env={env}
              meta={meta}
              provider={provider}
              isLatestBuild={latestEnv === env}
              hasBackup={!!hasBackup}
              isBuilding={bp?.providerId === provider.id && bp?.environment.toLowerCase() === env}
              onBuild={() => onBuild(env)}
              onRestoreConfirm={() => onRestoreConfirm(env)}
              binaryUpdate={binaryUpdates[env]}
              updateStatus={updateStatuses[`${provider.id}:${env}`] || "idle"}
              updateError={updateErrors[`${provider.id}:${env}`]}
              onUpdateBinary={() => onUpdateBinary(provider.id, env)}
              onRevert={() => onRevert(provider.id, env)}
            />
          );
        })}
      </div>
    </div>
  );
}

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

function getPrNumberForEnv(provider: ProviderConfig, env: string): string | undefined {
  return provider.lastPrPerEnv?.[env];
}

function isDownloadedBinary(path: string): boolean {
  const normalized = path.toLowerCase();
  return normalized.includes("updates\\") || normalized.includes("updates/");
}

function BuildProfileRow({ env, meta, provider, isLatestBuild, hasBackup, isBuilding, onBuild, onRestoreConfirm, binaryUpdate, updateStatus, updateError, onUpdateBinary, onRevert }: BuildProfileRowProps) {
  const buildInfo = provider.buildInfoPerEnv?.[env];
  const c = getEnvColors(meta.color);
  const binaryPath = provider.binaryPathPerEnv?.[env];
  const isDownloaded = !!binaryPath && isDownloadedBinary(binaryPath);

  // Determine update state for display
  const hasUpdateInfo = !!binaryUpdate;
  // Use downloaded version (GitHub release tag) for comparison — build info is internal llama.cpp version
  const installedVersion = provider.downloadedVersionPerEnv?.[env] || null;
  const latestVersion = binaryUpdate?.latestVersion || null;
  const isLatest = installedVersion === `v${latestVersion}` && installedVersion !== null;

  // Custom build detection: has a per-env path but no download version tag → Foundry-built
  const isCustomBuild = !!binaryPath && !installedVersion && !isDownloaded;
  const needsDownload = !installedVersion && hasUpdateInfo;

  return (
    <div className={`flex items-center gap-3 px-3 py-2 rounded border ${c.border} ${c.bg}`}>
      {/* Env label */}
      <div className="flex-shrink-0 w-24">
        <span className={`text-xl font-mono tracking-wider ${c.text}`}>{meta.label}</span>
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

// ── Restore Confirmation Modal ───────────────────────────────────────
function RestoreConfirmModal({ providerId, env, onConfirm, onCancel }: {
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
