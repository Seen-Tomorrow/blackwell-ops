interface ModelStatsRowProps {
  downloads: number;
  likes: number;
  quants: number;
  tags?: string[];
}

export default function ModelStatsRow({ downloads, likes, quants, tags }: ModelStatsRowProps) {
  const visibleTags = tags?.slice(0, 12) ?? [];

  return (
    <div className="stats-row mb-3 flex flex-wrap items-center gap-3 border-b pb-2">
      <div className="text-center">
        <div className="stats-row__num text-xs font-mono">{formatNum(downloads)}</div>
        <div className="stats-row__lab type-tiny font-mono uppercase tracking-wider">Downloads</div>
      </div>
      <div className="stats-row__rule h-6 w-px" />
      <div className="text-center">
        <div className="stats-row__num text-xs font-mono">{formatNum(likes)}</div>
        <div className="stats-row__lab type-tiny font-mono uppercase tracking-wider">Likes</div>
      </div>
      <div className="stats-row__rule h-6 w-px" />
      <div className="text-center">
        <div className="stats-row__num text-xs font-mono">{quants}</div>
        <div className="stats-row__lab type-tiny font-mono uppercase tracking-wider">Quants</div>
      </div>
      {visibleTags.length > 0 && (
        <>
          <div className="stats-row__rule h-6 w-px" />
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
            {visibleTags.map((tag) => (
              <span key={tag} className="stats-row__tag theme-tag rounded-sm px-2 py-0.5 type-tiny font-mono">
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