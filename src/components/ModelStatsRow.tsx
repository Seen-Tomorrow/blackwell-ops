interface ModelStatsRowProps {
  downloads: number;
  likes: number;
  quants: number;
  /** Non-quant artifacts the repo also ships (drafts, swap pieces, sidecars). */
  extras?: number;
  /** Every artifact summed — the number that decides whether the repo is even an option. */
  totalBytes?: number;
}

export default function ModelStatsRow({ downloads, likes, quants, extras = 0, totalBytes = 0 }: ModelStatsRowProps) {
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
      {extras > 0 && (
        <>
          <div className="stats-row__rule h-6 w-px" />
          <div className="text-center">
            <div className="stats-row__num stats-row__num--extra text-xs font-mono">{extras}</div>
            <div className="stats-row__lab type-tiny font-mono uppercase tracking-wider">Extras</div>
          </div>
        </>
      )}
      {totalBytes > 0 && (
        <>
          <div className="stats-row__rule h-6 w-px" />
          <div className="text-center">
            <div className="stats-row__num text-xs font-mono">{formatSize(totalBytes)}</div>
            <div className="stats-row__lab type-tiny font-mono uppercase tracking-wider">Repo</div>
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

function formatSize(bytes: number): string {
  const tb = bytes / (1024 ** 4);
  if (tb >= 1) return `${tb.toFixed(2)} TB`;
  const gb = bytes / (1024 ** 3);
  if (gb >= 1) return `${gb.toFixed(0)} GB`;
  return `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}
