import type { IntelItem, ProviderConfig } from "./types";
import { DEFAULT_BINARY_PROFILE } from "./foundry_constants";
import { binaryProfileKey, catalogOverrideKey, readJsonStorage, readStorage } from "./storage";

export const INTEL_GENESIS_KEYS = [
  "--ctx-size",
  "--batch-size",
  "--ubatch-size",
  "--parallel",
  "--split-mode",
  "--mmproj",
  "--reasoning",
  "--reasoning-budget",
  "--reasoning-format",
  "--jinja",
  "--cont-batching",
  "--metrics",
  "--flash-attn",
  "--cache-type-k",
  "--cache-type-v",
  "-ot",
  "--no-mmap",
  "--no-kv-unified",
] as const;

const PARAM_TO_CLI: Record<string, string[]> = {
  ctx: ["--ctx-size", "ctx-size", "context"],
  batch: ["--batch-size", "batch-size"],
  ubatch: ["--ubatch-size", "ubatch"],
  parallel: ["--parallel", "parallel"],
  split: ["--split-mode", "split-mode", "split"],
  kv_quant: ["--cache-type-k", "cache-type-k", "kv cache", "kv_quant"],
  flash_attn: ["--flash-attn", "flash-attn", "flash attention"],
  unified_kv: ["--no-kv-unified", "kv-unified", "unified kv"],
  offload_mode: ["offload", "moe"],
  device: ["--device", "gpu"],
  vision: ["--mmproj", "mmproj", "multimodal", "vision"],
};

export type IntelTypeFilter = "all" | "pr" | "open_pr" | "discussion" | "breaking" | "release";

export const INTEL_TYPE_FILTERS: { id: IntelTypeFilter; label: string }[] = [
  { id: "all", label: "ALL" },
  { id: "pr", label: "PR" },
  { id: "open_pr", label: "OPEN" },
  { id: "discussion", label: "DISC" },
  { id: "breaking", label: "BREAKING" },
  { id: "release", label: "RELEASE" },
];

export function defaultIntelChannelId(
  channels: { id: string }[],
  lastProvider: string | null,
): string {
  if (lastProvider && channels.some((c) => c.id === lastProvider)) {
    return lastProvider;
  }
  return "all";
}

export function loadOverridesByProvider(providerIds: string[]): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const id of providerIds) {
    const stored = readJsonStorage<Record<string, unknown>>(catalogOverrideKey(id));
    if (stored && Object.keys(stored).length > 0) {
      out[id] = stored;
    }
  }
  return out;
}

export function itemMatchesUserConfig(
  item: IntelItem,
  overridesByProvider: Record<string, Record<string, unknown>>,
): boolean {
  const overrides = overridesByProvider[item.channel];
  if (!overrides) return false;

  const haystack = `${item.title} ${item.body_preview}`.toLowerCase();
  for (const key of Object.keys(overrides)) {
    const terms = PARAM_TO_CLI[key] ?? [`--${key.replace(/_/g, "-")}`, key.replace(/_/g, "-")];
    if (terms.some((term) => haystack.includes(term.toLowerCase()))) {
      return true;
    }
  }
  return false;
}

export function filterIntelItems(
  items: IntelItem[],
  channelId: string,
  typeFilter: IntelTypeFilter,
): IntelItem[] {
  return items.filter((item) => {
    if (channelId !== "all" && item.channel !== channelId) return false;
    switch (typeFilter) {
      case "pr":
        return item.source === "pr";
      case "open_pr":
        return item.source === "open_pr";
      case "discussion":
        return item.source === "discussion";
      case "breaking":
        return item.is_breaking;
      case "release":
        return item.source === "release";
      default:
        return true;
    }
  });
}

export function splitBreakingItems(items: IntelItem[]): {
  breaking: IntelItem[];
  rest: IntelItem[];
} {
  const breaking: IntelItem[] = [];
  const rest: IntelItem[] = [];
  for (const item of items) {
    if (item.is_breaking) breaking.push(item);
    else rest.push(item);
  }
  return { breaking, rest };
}

export function extractPrNumber(item: IntelItem): number | null {
  const match = item.id.match(/-(?:pr|open_pr)-(\d+)$/);
  if (!match) return null;
  const n = Number.parseInt(match[1], 10);
  return Number.isFinite(n) ? n : null;
}

export function providerBuildSummary(provider: ProviderConfig | undefined): string | null {
  if (!provider) return null;
  const env = readStorage(binaryProfileKey(provider.id)) ?? DEFAULT_BINARY_PROFILE;
  const build = provider.buildInfoPerEnv?.[env];
  const lastPr = provider.lastPrPerEnv?.[env];
  const parts: string[] = [];
  if (build?.version) parts.push(`build ${build.version}`);
  if (lastPr) parts.push(`last PR #${lastPr}`);
  return parts.length > 0 ? parts.join(" · ") : null;
}

export function isBuildBehindBreaking(
  item: IntelItem,
  provider: ProviderConfig | undefined,
): boolean {
  if (!item.is_breaking || !provider) return false;
  const prNum = extractPrNumber(item);
  if (prNum == null) return false;
  const env = readStorage(binaryProfileKey(provider.id)) ?? DEFAULT_BINARY_PROFILE;
  const lastPrRaw = provider.lastPrPerEnv?.[env];
  if (!lastPrRaw) return true;
  const lastPr = Number.parseInt(lastPrRaw.replace(/\D/g, ""), 10);
  if (!Number.isFinite(lastPr)) return true;
  return prNum > lastPr;
}

export function formatIntelTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return (
      d.toLocaleDateString("en-US", { month: "short", day: "numeric" }) +
      " " +
      d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })
    );
  } catch {
    return ts.slice(0, 10);
  }
}

export function sourceBadgeLabel(source: string): string {
  switch (source) {
    case "pr":
      return "PR";
    case "open_pr":
      return "OPEN";
    case "release":
      return "REL";
    default:
      return "DISC";
  }
}