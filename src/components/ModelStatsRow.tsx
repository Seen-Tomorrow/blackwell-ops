interface ModelStatsRowProps {
  downloads: number;
  likes: number;
  quants: number;
  tags?: string[];
}

export default function ModelStatsRow({ downloads, likes, quants, tags }: ModelStatsRowProps) {
  const visibleTags = tags?.slice(0, 12) ?? [];

  return (
    <div className="mb-3 flex flex-wrap items-center gap-3 border-b border-stealth-border/40 pb-2">
      <div className="text-center">
        <div className="text-xs font-mono text-white">{formatNum(downloads)}</div>
        <div className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Downloads</div>
      </div>
      <div className="h-6 w-px bg-stealth-border/40" />
      <div className="text-center">
        <div className="text-xs font-mono text-white">{formatNum(likes)}</div>
        <div className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Likes</div>
      </div>
      <div className="h-6 w-px bg-stealth-border/40" />
      <div className="text-center">
        <div className="text-xs font-mono text-white">{quants}</div>
        <div className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Quants</div>
      </div>
      {visibleTags.length > 0 && (
        <>
          <div className="h-6 w-px bg-stealth-border/40" />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {visibleTags.map((tag) => (
              <span key={tag} className="theme-tag rounded-sm px-2 py-0.5 text-[8px] font-mono">
                {tag}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}