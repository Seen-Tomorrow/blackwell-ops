import { type ReactNode } from "react";
import type { IntelChannel, IntelItem, ProviderConfig } from "../lib/types";
import {
  formatIntelTimestamp,
  INTEL_GENESIS_KEYS,
  isBuildBehindBreaking,
  itemMatchesUserConfig,
  providerBuildSummary,
  sourceBadgeLabel,
} from "../lib/intelUtils";

function highlightGenesisKeys(text: string): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;
  const regex = new RegExp(
    `(${INTEL_GENESIS_KEYS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "gi",
  );
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }
    parts.push(
      <span key={match.index} className="intel-genesis-flag">
        {match[0]}
      </span>,
    );
    lastIndex = regex.lastIndex;
  }

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts.length > 0 ? parts : [text];
}

interface IntelWidgetProps {
  items: IntelItem[];
  pinnedBreaking?: IntelItem[];
  channels: IntelChannel[];
  providers: ProviderConfig[];
  overridesByProvider: Record<string, Record<string, unknown>>;
  status: "loading" | "online" | "offline";
  cacheTtlSeconds?: number;
  activeChannelId: string;
}

function channelLabel(channelId: string, channels: IntelChannel[]): string {
  return channels.find((c) => c.id === channelId)?.tab_label ?? channelId.toUpperCase();
}

function sourceBadge(item: IntelItem): ReactNode {
  const label = sourceBadgeLabel(item.source);
  const tone =
    item.source === "release"
      ? "intel-badge--release"
      : item.source === "open_pr"
        ? "intel-badge--open"
        : item.source === "pr"
          ? "intel-badge--pr"
          : "intel-badge--disc";

  return (
    <span className={`intel-badge ${tone}`}>
      {label}
    </span>
  );
}

function IntelRow({
  item,
  channels,
  providers,
  overridesByProvider,
  showChannel,
}: {
  item: IntelItem;
  channels: IntelChannel[];
  providers: ProviderConfig[];
  overridesByProvider: Record<string, Record<string, unknown>>;
  showChannel: boolean;
}) {
  const provider = providers.find((p) => p.id === item.channel);
  const configMatch = itemMatchesUserConfig(item, overridesByProvider);
  const behindBuild = isBuildBehindBreaking(item, provider);

  return (
    <a
      href={item.url}
      target="_blank"
      rel="noopener noreferrer"
      className={`intel-row ${item.is_breaking ? "intel-row--breaking" : ""}`}
    >
      <div className="intel-row__title">
        {sourceBadge(item)}
        {showChannel && (
          <span className="intel-badge intel-badge--channel">{channelLabel(item.channel, channels)}</span>
        )}
        {item.is_breaking && <span className="intel-badge intel-badge--warn">BREAKING</span>}
        {configMatch && <span className="intel-badge intel-badge--config">YOUR CONFIG</span>}
        {behindBuild && <span className="intel-badge intel-badge--warn">BUILD BEHIND</span>}
        <span className="intel-row__title-text">{item.title}</span>
      </div>

      <div className="intel-row__meta">
        <span>{item.author}</span>
        <span className="intel-row__sep">|</span>
        <span>{formatIntelTimestamp(item.timestamp)}</span>
        {item.labels.length > 0 && (
          <>
            <span className="intel-row__sep">|</span>
            <span className="intel-row__labels">{item.labels.slice(0, 3).join(" · ")}</span>
          </>
        )}
      </div>

      {item.body_preview && (
        <p className="intel-row__preview">{highlightGenesisKeys(item.body_preview)}</p>
      )}
    </a>
  );
}

export default function IntelWidget({
  items,
  pinnedBreaking = [],
  channels,
  providers,
  overridesByProvider,
  status,
  cacheTtlSeconds,
  activeChannelId,
}: IntelWidgetProps) {
  const showChannel = activeChannelId === "all";
  const repoFooter =
    activeChannelId === "all"
      ? channels.map((c) => c.repo).join(" · ")
      : channels.find((c) => c.id === activeChannelId)?.repo ?? "";

  const buildLine = activeChannelId === "all"
    ? null
    : providerBuildSummary(providers.find((p) => p.id === activeChannelId));

  return (
    <div className="intel-panel theme-surface flex flex-col h-full min-h-0 overflow-hidden rounded-sm">
      <div className="intel-panel__body theme-surface-inset flex-1 min-h-0 overflow-y-auto eink-scrollbar">
        {status === "offline" ? (
          <p className="intel-empty">NO INTERNET — INTEL UNAVAILABLE</p>
        ) : status === "loading" && items.length === 0 ? (
          <p className="intel-empty intel-empty--pulse">FETCHING BACKEND INTEL...</p>
        ) : items.length === 0 && pinnedBreaking.length === 0 ? (
          <p className="intel-empty">NO ITEMS FOR THIS FILTER</p>
        ) : (
          <>
            {pinnedBreaking.length > 0 && (
              <div className="intel-pinned">
                <div className="intel-pinned__label">BREAKING CHANGES</div>
                {pinnedBreaking.map((item) => (
                  <IntelRow
                    key={`pin-${item.id}`}
                    item={item}
                    channels={channels}
                    providers={providers}
                    overridesByProvider={overridesByProvider}
                    showChannel={showChannel}
                  />
                ))}
              </div>
            )}
            {items.map((item) => (
              <IntelRow
                key={item.id}
                item={item}
                channels={channels}
                providers={providers}
                overridesByProvider={overridesByProvider}
                showChannel={showChannel}
              />
            ))}
          </>
        )}
      </div>

      <div className="intel-panel__footer theme-surface-header">
        <span className="intel-panel__footer-repo">{repoFooter || "GITHUB"}</span>
        {buildLine && <span className="intel-panel__footer-build">{buildLine}</span>}
        {status === "online" && cacheTtlSeconds != null && (
          <span className="intel-panel__footer-cache">{Math.round(cacheTtlSeconds / 3600)}h CACHE</span>
        )}
      </div>
    </div>
  );
}