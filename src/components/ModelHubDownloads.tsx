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
        <div className="dl-mgr-error mb-2 truncate font-mono">
          {actionError}
        </div>
      )}
      <div className="dl-mgr-heading mb-2 flex items-center gap-2 font-mono tracking-wider uppercase">
        <span>Download manager</span>
        {activeDownloads.length > 0 && pane === 'queue' && (
          <span className="dl-mgr-active">{activeDownloads.length} active</span>
        )}
        <button
          type="button"
          onClick={() => setPane('queue')}
          className={`dl-mgr-tab value-chip px-1.5 py-0 font-mono rounded-sm ${pane === 'queue' ? 'value-chip-active' : ''}`}
        >
          QUEUE
        </button>
        <button
          type="button"
          onClick={() => setPane('history')}
          className={`dl-mgr-tab value-chip px-1.5 py-0 font-mono rounded-sm ${pane === 'history' ? 'value-chip-active' : ''}`}
        >
          HISTORY
        </button>
        {pane === 'queue' && (
          <button
            type="button"
            onClick={cycleSizeSort}
            className={`dl-mgr-tab ml-auto value-chip px-1.5 py-0 font-mono rounded-sm transition-colors ${
              sizeSort !== 'default' ? 'value-chip-active' : ''
            }`}
            title="Sort by total size — click to cycle: default (newest) → largest → smallest"
          >
            {sortLabel}
          </button>
        )}
      </div>
      <p className="dl-mgr-caption mb-2 font-mono leading-snug">
        Models · app updates · engine packs · toolchain
      </p>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {pane === 'history' ? (
          history.length === 0 ? (
            <div className="dl-mgr-empty py-6 text-center font-mono">
              NO DOWNLOAD HISTORY
            </div>
          ) : (
            history.map((row) => (
              <div key={row.id} className="dl-mgr-history rounded-sm border px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="dl-mgr-history-name truncate font-mono">
                    {row.hfModelId || row.file_name}
                  </span>
                  <span className={`dl-mgr-history-kind shrink-0 font-mono ${
                    row.kind === 'header' ? 'dl-mgr-history-kind--header' : 'dl-mgr-history-kind--full'
                  }`}>
                    {row.kind === 'header' ? 'HEADER' : 'FULL'}
                  </span>
                </div>
                <div className="dl-mgr-history-meta mt-0.5 flex items-center justify-between font-mono">
                  <span>{row.status}{row.quantType ? ` · ${row.quantType}` : ''}</span>
                  <span>{row.bytes > 0 ? `${(row.bytes / 1_048_576).toFixed(2)} MB` : ''}</span>
                </div>
              </div>
            ))
          )
        ) : sorted.length === 0 ? (
          <div className="py-6 text-center">
            <div className="dl-mgr-empty mb-3 text-center font-mono">
              NO ACTIVE DOWNLOADS
            </div>
            <button
              type="button"
              onClick={handleRecover}
              disabled={recoveryBusy}
              className="dl-mgr-recover inline-flex items-center gap-1.5 rounded-sm border px-2 py-1 font-mono transition-colors disabled:opacity-50"
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
