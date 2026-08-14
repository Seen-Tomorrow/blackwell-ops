import { useEffect, useMemo, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DownloadTask, DownloadStatus, DownloadHistoryEntry } from '@/lib/types';
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
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [pane, setPane] = useState<'queue' | 'history'>('queue');
  const [history, setHistory] = useState<DownloadHistoryEntry[]>([]);

  useEffect(() => {
    if (pane !== 'history') return;
    void invoke<DownloadHistoryEntry[]>('get_download_history')
      .then((rows) => setHistory(rows.slice().reverse()))
      .catch(() => setHistory([]));
  }, [pane, downloads]);

  const handleRecover = async () => {
    setRecoveryBusy(true);
    setActionError(null);
    try {
      await invoke('recover_orphaned_batch_parts');
    } catch (err) {
      const msg = typeof err === 'string' ? err : 'Recovery failed';
      setActionError(msg);
    } finally {
      setRecoveryBusy(false);
    }
  };

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
        {activeDownloads.length > 0 && pane === 'queue' && (
          <span className="text-stealth-muted/50">{activeDownloads.length} active</span>
        )}
        <button
          type="button"
          onClick={() => setPane('queue')}
          className={`value-chip px-1.5 py-0 text-[7px] font-mono rounded-sm ${pane === 'queue' ? 'value-chip-active' : ''}`}
        >
          QUEUE
        </button>
        <button
          type="button"
          onClick={() => setPane('history')}
          className={`value-chip px-1.5 py-0 text-[7px] font-mono rounded-sm ${pane === 'history' ? 'value-chip-active' : ''}`}
        >
          HISTORY
        </button>
        {pane === 'queue' && (
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
        )}
      </div>
      <p className="mb-2 text-[7px] font-mono text-stealth-muted/50 leading-snug">
        Models · app updates · engine packs · toolchain
      </p>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {pane === 'history' ? (
          history.length === 0 ? (
            <div className="py-6 text-center text-[9px] font-mono text-stealth-muted/60">
              NO DOWNLOAD HISTORY
            </div>
          ) : (
            history.map((row) => (
              <div key={row.id} className="rounded-sm border border-stealth-border/40 px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-[8px] font-mono text-white/80">
                    {row.hfModelId || row.file_name}
                  </span>
                  <span className={`shrink-0 text-[7px] font-mono ${
                    row.kind === 'header' ? 'text-cyan-400' : 'text-stealth-muted'
                  }`}>
                    {row.kind === 'header' ? 'HEADER' : 'FULL'}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center justify-between text-[7px] font-mono text-stealth-muted/70">
                  <span>{row.status}{row.quantType ? ` · ${row.quantType}` : ''}</span>
                  <span>{row.bytes > 0 ? `${(row.bytes / 1_048_576).toFixed(2)} MB` : ''}</span>
                </div>
              </div>
            ))
          )
        ) : sorted.length === 0 ? (
          <div className="py-6 text-center">
            <div className="mb-3 text-[9px] font-mono text-stealth-muted/60">
              NO ACTIVE DOWNLOADS
            </div>
            <button
              type="button"
              onClick={handleRecover}
              disabled={recoveryBusy}
              className="inline-flex items-center gap-1.5 rounded-sm border border-stealth-muted/30 px-2 py-1 text-[8px] font-mono text-stealth-muted/70 transition-colors hover:border-stealth-muted/60 hover:text-stealth-muted disabled:opacity-50"
              title="Reconcile persisted batch manifests with on-disk .part files. Use if a multi-shard download disappeared from the queue after a restart."
            >
              {recoveryBusy ? 'SCANNING...' : 'RECOVER LOST SHARDS'}
            </button>
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
