import { sanitizeAlias } from "../lib/types";

interface EngineBannerProps {
  slotIndex: number;
  alias?: string;
  providerName?: string;
  providerType?: string;
  status?: string;
  gpuMask?: string;
  buildInfo?: { version: string; buildDate: string; cudaVersion?: string };
}

function statusDotClass(status?: string): string {
  switch (status) {
    case "RUNNING": return "status-online";
    case "LOADING": return "status-loading";
    case "ERROR": return "status-error";
    default: return "status-offline";
  }
}

function resolveProviderName(providerName?: string): string | undefined {
  if (providerName && providerName.trim().length > 0) return providerName;
  return undefined;
}

export default function EngineBanner({ slotIndex, alias, providerName, providerType: _providerType, status, gpuMask, buildInfo }: EngineBannerProps) {
  const displayName = resolveProviderName(providerName);
  const hasProvider = !!displayName && displayName.trim().length > 0;
  const aliasLabel = alias ? sanitizeAlias(alias).toUpperCase() : String(slotIndex + 1).padStart(2, "0");

  return (
    <div className="engine-stack-banner flex items-center gap-2 px-3 py-2 border-b border-stealth-border/30 min-w-0">
      <span className={`status-dot shrink-0 ${statusDotClass(status)}`} />

      <div className="flex flex-col min-w-0 shrink-0">
        <span className="text-[8px] font-mono text-stealth-muted tracking-wider uppercase">
          SLOT {slotIndex + 1}{gpuMask ? ` · GPU ${gpuMask}` : ""}
        </span>
        <span className="text-[10px] font-mono tracking-wider truncate" title={aliasLabel}>
          #{aliasLabel}
        </span>
      </div>

      {hasProvider && status !== "IDLE" && (
        <span className="provider-pill-active border text-[8px] font-mono px-2 py-0.5 rounded-sm truncate max-w-[140px]" title={displayName}>
          {displayName}
        </span>
      )}

      <div className="flex-1 min-w-0" />

      {hasProvider && status === "RUNNING" && buildInfo && (
        <span className="text-[7px] font-mono text-stealth-muted whitespace-nowrap shrink-0 hidden sm:inline">
          build {buildInfo.version}
          {buildInfo.cudaVersion ? ` · CUDA ${buildInfo.cudaVersion}` : ""}
        </span>
      )}
    </div>
  );
}