import { useState, useCallback } from "react";
import type { ProviderConfig } from "../lib/types";
import FoundryModal from "./FoundryModal";

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

export default function FoundryPage({ providers, onProvidersChange }: FoundryPageProps) {
  const [foundryModal, setFoundryModal] = useState<{ provider: ProviderConfig; environment: Env } | null>(null);

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
            onBuild={(env) => setFoundryModal({ provider: p, environment: env })}
          />
        ))}
      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-stealth-border flex items-center justify-between">
        <span className="text-[9px] font-mono text-stealth-muted">
          {foundryProviders.length}/{providers.length} providers with Foundry build config
        </span>
      </div>

      {/* Reactor Foundry Build Modal */}
      {foundryModal && (
        <FoundryModal
          provider={foundryModal.provider}
          environment={foundryModal.environment}
          onClose={() => setFoundryModal(null)}
        />
      )}
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────

interface FoundryProviderCardProps {
  provider: ProviderConfig;
  onBuild: (env: Env) => void;
}

function FoundryProviderCard({ provider, onBuild }: FoundryProviderCardProps) {
  const currentInfo = provider.buildInfoPerEnv?.["current"];

  return (
    <div className="rounded border border-stealth-border overflow-hidden">
      {/* Provider header */}
      <div className="flex items-center gap-4 px-4 py-2.5 bg-[#0a0a1a] border-b border-stealth-border/30">
        <span className="text-[10px] font-mono text-yellow-400">{provider.id}</span>
        <span className="text-[10px] font-mono text-white truncate max-w-[200px]" title={provider.display_name}>
          {provider.display_name}
        </span>
        <div className="flex-1" />
        <span className="text-[8px] font-mono text-stealth-muted truncate max-w-[240px]" title={provider.git_url}>
          {provider.git_url.replace(/.*\/\/|\.git$/g, "")} :{provider.branch}
        </span>
      </div>

      {/* Build profiles — vertical stack */}
      <div className="p-3 space-y-2">
        {(["vanguard", "fresh", "stable"] as Env[]).map(env => {
          const meta = ENV_META[env];
          return (
            <BuildProfileRow
              key={env}
              env={env}
              meta={meta}
              provider={provider}
              currentInfo={currentInfo}
              onBuild={() => onBuild(env)}
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
  currentInfo: { version: string; buildDate: string; cudaVersion?: string } | undefined;
  onBuild: () => void;
}

function getPrNumberForEnv(provider: ProviderConfig, env: string): string | undefined {
  return provider.lastPrPerEnv?.[env];
}

function BuildProfileRow({ env, meta, provider, currentInfo, onBuild }: BuildProfileRowProps) {
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
        <span className={`text-[9px] font-mono tracking-wider ${c.text}`}>{meta.label}</span>
      </div>

      {/* Toolchain badges */}
      <div className="flex items-center gap-1.5 flex-shrink-0">
        <span className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm border ${c.badgeBg} ${c.badgeBorder}`}>
          CUDA {meta.cuda}
        </span>
        <span className="text-[7px] font-mono px-1.5 py-0.5 rounded-sm border border-stealth-border/30 bg-stealth-panel/50 text-stealth-muted">
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
      <div className="flex-1 min-w-0">
        {currentInfo ? (
          <span className="text-[8px] font-mono text-stealth-muted/70 truncate block" title={`v${currentInfo.version}${currentInfo.cudaVersion ? ` · CUDA ${currentInfo.cudaVersion}` : ""} · Built: ${currentInfo.buildDate}`}>
            v{currentInfo.version}{currentInfo.cudaVersion ? ` · CUDA ${currentInfo.cudaVersion}` : ""} · {currentInfo.buildDate}
          </span>
        ) : (
          <span className="text-[8px] font-mono text-stealth-muted/30">not yet built</span>
        )}
      </div>

      {/* Build button */}
      <button
        onClick={onBuild}
        disabled={!provider.git_url}
        className={`flex-shrink-0 px-3 py-1 text-[8px] font-mono border transition-colors ${c.border} ${c.text} hover:${c.badgeBg} disabled:opacity-30 disabled:cursor-not-allowed`}
      >
        BUILD
      </button>
    </div>
  );
}
