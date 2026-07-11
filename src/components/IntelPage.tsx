import { useEffect, useMemo, useState } from "react";
import IntelWidget from "./IntelWidget";
import { useIntelFeed } from "../hooks/useIntelFeed";
import {
  defaultIntelChannelId,
  filterIntelItems,
  INTEL_TYPE_FILTERS,
  loadOverridesByProvider,
  providerBuildSummary,
  splitBreakingItems,
  type IntelTypeFilter,
} from "../lib/intelUtils";
import { KEYS, readStorage } from "../lib/storage";
import TabPageHeader from "./TabPageHeader";

interface IntelPageProps {
  /** When true, parent ExtrasPage owns the page chrome. */
  embedded?: boolean;
}

export default function IntelPage({ embedded = false }: IntelPageProps) {
  const { feed, providers, status, refresh } = useIntelFeed();
  const channels = feed?.channels ?? [];

  const [channelId, setChannelId] = useState<string>("all");
  const [channelInitialized, setChannelInitialized] = useState(false);
  const [typeFilter, setTypeFilter] = useState<IntelTypeFilter>("all");

  useEffect(() => {
    if (!channelInitialized && channels.length > 0) {
      setChannelId(defaultIntelChannelId(channels, readStorage(KEYS.lastProvider)));
      setChannelInitialized(true);
    }
  }, [channels, channelInitialized]);

  const effectiveChannel = channelId;

  const overridesByProvider = useMemo(
    () => loadOverridesByProvider(channels.map((c) => c.id)),
    [channels],
  );

  const filtered = useMemo(() => {
    if (!feed) return [];
    return filterIntelItems(feed.items, effectiveChannel, typeFilter);
  }, [feed, effectiveChannel, typeFilter]);

  const { breaking, rest } = useMemo(() => splitBreakingItems(filtered), [filtered]);

  const showPinnedBreaking = typeFilter === "all" || typeFilter === "breaking";
  const pinnedBreaking = showPinnedBreaking ? breaking.slice(0, 5) : [];
  const listItems =
    typeFilter === "all"
      ? rest
      : typeFilter === "breaking"
        ? breaking.slice(pinnedBreaking.length)
        : filtered;

  const activeProvider = providers.find((p) => p.id === effectiveChannel);
  const buildSummary = providerBuildSummary(activeProvider);

  const refreshBtn = (
    <button
      type="button"
      onClick={() => void refresh()}
      disabled={status === "loading"}
      className="intel-refresh-btn shrink-0"
    >
      {status === "loading" ? "FETCHING..." : "REFRESH"}
    </button>
  );

  return (
    <div className="h-full flex flex-col min-h-0 overflow-hidden" data-intel-page>
      {!embedded && (
        <TabPageHeader title="INTEL" actions={refreshBtn} />
      )}
      <p className={`flex-shrink-0 py-1 text-[8px] font-mono text-stealth-muted/60 border-b border-stealth-border/30 ${embedded ? "px-3" : "px-4"}`}>
        Multi-provider backend news — discussions, PRs, releases from your enabled provider repos
        {buildSummary && effectiveChannel !== "all" ? ` · Active stack · ${buildSummary}` : ""}
      </p>

      <div className={`flex-shrink-0 flex flex-wrap items-center gap-2 pt-2 ${embedded ? "px-3" : "px-4"}`}>
        <div className="intel-channel-tabs flex items-center gap-1 flex-wrap">
          <button
            type="button"
            className={`intel-tab ${effectiveChannel === "all" ? "intel-tab--active" : ""}`}
            onClick={() => setChannelId("all")}
          >
            ALL
          </button>
          {channels.map((ch) => (
            <button
              key={ch.id}
              type="button"
              className={`intel-tab ${effectiveChannel === ch.id ? "intel-tab--active" : ""}`}
              onClick={() => setChannelId(ch.id)}
              title={ch.repo}
            >
              {ch.tab_label}
            </button>
          ))}
        </div>

        <span className="intel-filter-divider" />

        <div className="intel-type-filters flex items-center gap-1 flex-wrap">
          {INTEL_TYPE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={`intel-filter ${typeFilter === f.id ? "intel-filter--active" : ""}`}
              onClick={() => setTypeFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>

        {embedded && <span className="ml-auto">{refreshBtn}</span>}
      </div>

      <div className={`flex-1 min-h-0 pb-4 ${embedded ? "px-3" : "px-4"}`}>
        <IntelWidget
          items={listItems}
          pinnedBreaking={pinnedBreaking}
          channels={channels}
          providers={providers}
          overridesByProvider={overridesByProvider}
          status={status}
          cacheTtlSeconds={feed?.cache_ttl_seconds}
          activeChannelId={effectiveChannel}
        />
      </div>
    </div>
  );
}