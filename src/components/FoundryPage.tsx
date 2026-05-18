import { useState, useCallback, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig } from "../lib/types";
import { useStatus } from "../context/StatusBarContext";

type Env = "vanguard" | "stable" | "fresh";

interface FoundryPageProps {
  providers: ProviderConfig[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
}

const ENV_META: Record<Env, { label: string; cuda: string; vs: string; color: string }> = {
  vanguard: { label: "VANGUARD", cuda: "13.2", vs: "VS Build Tools 2026 (v18)", color: "cyan" },
  fresh:    { label: "FRESH",    cuda: "13.1", vs: "VS Build Tools 2022",        color: "amber" },
  stable:   { label: "STABLE",   cuda: "12.8", vs: "VS Build Tools 2022",        color: "nv-green" },
};

// Parse cmake flags string into individual flag lines for tooltip display
function parseCmakeFlags(flags: string): string[] {
  if (!flags.trim()) return [];
  // Split by whitespace, filter out empty strings and standalone quotes
  const parts = flags.split(/\s+/).filter(p => p && !/^["']+$/.test(p));
  // Clean up: remove trailing spaces from each flag
  return parts.map(f => f.trim()).filter(Boolean);
}

export default function FoundryPage({ providers, onProvidersChange }: FoundryPageProps) {
  const { openBuildModal, buildProgress } = useStatus();
  const [restoreConfirm, setRestoreConfirm] = useState<{ providerId: string; env: Env } | null>(null);
  // Authoritative backend build state — queried on mount + visibility change to prevent duplicate builds
  const [activeBuild, setActiveBuild] = useState<{ providerId: string; environment: string } | null>(null);

  // Query backend for active build status on mount and tab visibility changes
  useEffect(() => {
    const checkStatus = async () => {
      try {
        const status = await invoke<any>("foundry_status");
        setActiveBuild(status ? { providerId: status.provider_id, environment: status.environment } : null);
      } catch {}
    };

    checkStatus();

    const handleVisibility = () => {
      if (document.visibilityState === "visible") checkStatus();
    };
    document.addEventListener("visibilitychange", handleVisibility);
    return () => document.removeEventListener("visibilitychange", handleVisibility);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Merge event-based progress with backend state for most reliable guard
  const effectiveBuildProgress = activeBuild || buildProgress;

  // Refresh build info after successful build completes (triggered by StatusBarContext)
  useEffect(() => {
    const handler = async (e: Event) => {
      const providerId = (e as CustomEvent).detail as string;
      try {
        const updated = await invoke<ProviderConfig[]>("refresh_build_info", { providerId });
        if (updated.length > 0) onProvidersChange(updated);
      } catch {}
    };
    window.addEventListener("blackops-foundry-complete", handler);
    return () => window.removeEventListener("blackops-foundry-complete", handler);
  }, [onProvidersChange]);

  // Refresh build info on mount — ref guard prevents double-call in StrictMode
  const hasRefreshed = useRef(false);
  useEffect(() => {
    if (hasRefreshed.current) return;
    hasRefreshed.current = true;

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
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const handleRestore = async () => {
    if (!restoreConfirm) return;
    try {
      await invoke("foundry_restore", {
        providerId: restoreConfirm.providerId,
        environment: restoreConfirm.env,
      });
      // Refresh build info after restore
      await invoke("refresh_build_info", { providerId: restoreConfirm.providerId });
    } catch (err) {
      console.error("[Foundry] Restore failed:", err);
    } finally {
      setRestoreConfirm(null);
    }
  };

  const foundryProviders = providers.filter(p => p.git_url && p.branch);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-4 py-3 border-b border-stealth-border flex items-center gap-2">
        <span style={{ fontSize: '16px' }}>⚒</span>
        <h2 className="text-[11px] font-mono text-nv-green tracking-wider">REACTOR FOUNDRY</h2>
        <span className="text-[9px] font-mono text-stealth-muted ml-2">{foundryProviders.length} provider{foundryProviders.length !== 1 ? "s" : ""} with build config</span>
      </div>

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
            buildProgress={effectiveBuildProgress}
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

// ── Sub-components ───────────────────────────────────────────────

interface FoundryProviderCardProps {
  provider: ProviderConfig;
  onBuild: (env: Env) => void;
  onRestoreConfirm: (env: Env) => void;
  buildProgress?: { providerId: string; environment: string } | null;
}

function FoundryProviderCard({ provider, onBuild, onRestoreConfirm, buildProgress: bp }: FoundryProviderCardProps) {
  const latestEnv = (() => {
    let latestDate = "";
    let latestKey: Env | null = null;
    for (const env of ["vanguard", "fresh", "stable"] as Env[]) {
      const info = provider.buildInfoPerEnv?.[env];
      if (info && info.buildDate > latestDate) {
        latestDate = info.buildDate;
        latestKey = env;
      }
    }
    return latestKey;
  })();

  // Determine cmake flags display
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
          {/* Tooltip with individual flags — floats below badge, above everything */}
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
        {(["vanguard", "fresh", "stable"] as Env[]).map(env => {
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
            />
          );
        })}
      </div>
    </div>
  );
}

interface BuildProfileRowProps {
  env: Env;
  meta: { label: string; cuda: string; vs: string; color: string };
  provider: ProviderConfig;
  isLatestBuild: boolean;
  hasBackup: boolean;
  isBuilding?: boolean;
  onBuild: () => void;
  onRestoreConfirm: () => void;
}

function getPrNumberForEnv(provider: ProviderConfig, env: string): string | undefined {
  return provider.lastPrPerEnv?.[env];
}

function BuildProfileRow({ env, meta, provider, isLatestBuild, hasBackup, isBuilding, onBuild, onRestoreConfirm }: BuildProfileRowProps) {
  const buildInfo = provider.buildInfoPerEnv?.[env];
  const colorMap: Record<string, { border: string; bg: string; text: string; badgeBg: string; badgeBorder: string }> = {
    cyan:     { border: "border-cyan-400/20",      bg: "bg-cyan-400/[0.03]",        text: "text-cyan-400",       badgeBg: "bg-cyan-400/10",         badgeBorder: "border-cyan-400/30" },
    amber:    { border: "border-amber-400/20",      bg: "bg-amber-400/[0.03]",       text: "text-amber-400",      badgeBg: "bg-amber-400/10",        badgeBorder: "border-amber-400/30" },
    "nv-green": { border: "border-[#4ade80]/20",     bg: "bg-[#4ade80]/[0.03]",      text: "text-[#4ade80]",        badgeBg: "bg-[#4ade80]/10",        badgeBorder: "border-[#4ade80]/30" },
  };

  const c = colorMap[meta.color] || colorMap.cyan;

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
        {/* Last cherry-picked PR badge */}
        {getPrNumberForEnv(provider, env) && (
          <span className="text-[7px] font-mono px-1.5 py-0.5 rounded-sm border border-purple-400/30 bg-purple-400/10 text-purple-400">
            PR #{getPrNumberForEnv(provider, env)}
          </span>
        )}
      </div>

      {/* Build info or placeholder */}
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
      </div>

      {/* Restore button — appears if backup exists */}
      {hasBackup && buildInfo && (
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
