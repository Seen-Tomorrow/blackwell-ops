interface ModelStatsRowProps {
  downloads: number;
  likes: number;
  quants: number;
}

export default function ModelStatsRow({ downloads, likes, quants }: ModelStatsRowProps) {
  return (
    <div className="flex items-center gap-4 mb-4 pb-3 border-b border-stealth-border/40">
      <div className="text-center">
        <div className="text-xs font-mono text-white">{formatNum(downloads)}</div>
        <div className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Downloads</div>
      </div>
      <div className="w-px h-6 bg-stealth-border/40" />
      <div className="text-center">
        <div className="text-xs font-mono text-white">{formatNum(likes)}</div>
        <div className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Likes</div>
      </div>
      <div className="w-px h-6 bg-stealth-border/40" />
      <div className="text-center">
        <div className="text-xs font-mono text-white">{quants}</div>
        <div className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Quants</div>
      </div>
    </div>
  );
}

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}