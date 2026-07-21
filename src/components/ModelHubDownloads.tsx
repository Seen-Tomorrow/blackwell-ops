import { useMemo, useState } from 'react';
import type { DownloadTask, DownloadStatus } from '@/lib/types';
import DownloadProgressRow from './DownloadProgressRow';

const ACTIVE_STATUSES: DownloadStatus[] = ['downloading', 'queued', 'paused', 'scanning'];

type SizeSort = 'default' | 'size-desc' | 'size-asc';

interface ModelHubDownloadsProps {
  downloads: DownloadTask[];
}

export default function ModelHubDownloads({ downloads }: ModelHubDownloadsProps) {
  const activeDownloads = useMemo(
    () => downloads.filter((d) => ACTIVE_STATUSES.includes(d.status)),
    [downloads],
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [sizeSort, setSizeSort] = useState<SizeSort>('default');

  const sorted = useMemo(() => {
    if (sizeSort === 'default') {
      // Newest first (task ids are UTC micros)
      return [...activeDownloads].sort((a, b) => (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
    }
    const mul = sizeSort === 'size-desc' ? -1 : 1;
    return [...activeDownloads].sort((a, b) => {
      const da = a.totalBytes || 0;
      const db = b.totalBytes || 0;
      if (da !== db) return (da - db) * mul;
      return a.id < b.id ? 1 : -1;
    });
  }, [activeDownloads, sizeSort]);

  const cycleSizeSort = () => {
    setSizeSort((s) =>
      s === 'default' ? 'size-desc' : s === 'size-desc' ? 'size-asc' : 'default',
    );
  };

  const sortLabel =
    sizeSort === 'size-desc' ? 'SIZE ↓' : sizeSort === 'size-asc' ? 'SIZE ↑' : 'SIZE';

  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-2.5">
      {actionError && (
        <div className="mb-2 truncate text-[8px] font-mono text-red-400/80">
          {actionError}
        </div>
      )}
      <div className="mb-2 flex items-center gap-2 text-[9px] font-mono tracking-wider uppercase text-stealth-muted">
        <span>Download manager</span>
        {activeDownloads.length > 0 && (
          <span className="text-stealth-muted/50">{activeDownloads.length} active</span>
        )}
        <button
          type="button"
          onClick={cycleSizeSort}
          className={`ml-auto value-chip px-1.5 py-0 text-[7px] font-mono rounded-sm transition-colors ${
            sizeSort !== 'default' ? 'value-chip-active' : ''
          }`}
          title="Sort by total size — click to cycle: default (newest) → largest → smallest"
        >
          {sortLabel}
        </button>
      </div>
      <p className="mb-2 text-[7px] font-mono text-stealth-muted/50 leading-snug">
        Models · app updates · engine packs · toolchain
      </p>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {sorted.length === 0 ? (
          <div className="py-6 text-center text-[9px] font-mono text-stealth-muted/60">
            NO ACTIVE DOWNLOADS
          </div>
        ) : (
          sorted.map((task) => (
            <DownloadProgressRow key={task.id} task={task} onActionError={setActionError} />
          ))
        )}
      </div>
    </div>
  );
}
