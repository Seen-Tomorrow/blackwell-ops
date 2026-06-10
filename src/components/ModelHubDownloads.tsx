import { useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DownloadTask, DownloadStatus } from '@/lib/types';

const ACTIVE_STATUSES: DownloadStatus[] = ['downloading', 'queued', 'paused', 'scanning'];

function statusColor(status: DownloadStatus): string {
  switch (status) {
    case 'downloading': return 'text-nv-green';
    case 'paused': return 'text-yellow-400';
    case 'failed': return 'text-red-400';
    case 'scanning': return 'text-blue-400';
    default: return 'text-stealth-muted/40';
  }
}

function progressColor(status: DownloadStatus): string {
  switch (status) {
    case 'downloading': return 'bg-nv-green';
    case 'paused': return 'bg-yellow-400';
    case 'failed': return 'bg-red-400';
    case 'scanning': return 'bg-blue-400 animate-pulse';
    default: return 'bg-stealth-muted/20';
  }
}

function formatSpeed(bps: number): string {
  if (bps < 1024 * 1024) return `${Math.round(bps / 1024)} KB`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB`;
}

function formatETA(seconds: number): string {
  if (seconds === 0 || seconds > 36000) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

interface ModelHubDownloadsProps {
  downloads: DownloadTask[];
}

export default function ModelHubDownloads({ downloads }: ModelHubDownloadsProps) {
  const activeDownloads = downloads.filter((d) => ACTIVE_STATUSES.includes(d.status));

  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2 text-[9px] font-mono tracking-wider uppercase text-stealth-muted">
        <span>Downloads</span>
        {activeDownloads.length > 0 && (
          <span className="text-stealth-muted/50">{activeDownloads.length} active</span>
        )}
      </div>

      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
        {activeDownloads.length === 0 ? (
          <div className="py-6 text-center text-[9px] font-mono text-stealth-muted/60">
            NO ACTIVE DOWNLOADS
          </div>
        ) : (
          activeDownloads.map((task) => (
            <DownloadProgressRow key={task.id} task={task} />
          ))
        )}
      </div>
    </div>
  );
}

function DownloadProgressRow({ task }: { task: DownloadTask }) {
  const pct = task.totalBytes > 0 ? Math.round((task.downloadedBytes / task.totalBytes) * 100) : 0;
  const speedStr = formatSpeed(task.speedBps);
  const etaStr = formatETA(task.etaSeconds);

  const handlePause = useCallback(async () => {
    try {
      await invoke('pause_download', { taskId: task.id });
    } catch (e) {
      console.error('Failed to pause download:', e);
    }
  }, [task.id]);

  const handleResume = useCallback(async () => {
    try {
      await invoke('resume_download', { taskId: task.id });
    } catch (e) {
      console.error('Failed to resume download:', e);
    }
  }, [task.id]);

  const handleCancel = useCallback(async () => {
    try {
      await invoke('cancel_download', { taskId: task.id });
    } catch (e) {
      console.error('Failed to cancel download:', e);
    }
  }, [task.id]);

  return (
    <div className="rounded-sm border border-stealth-border/60 bg-stealth-surface/40 p-2 space-y-1.5">
      <div className="flex items-center justify-between gap-2 text-[9px] font-mono">
        <span className="truncate text-white/80">{task.hfModelId}</span>
        <div className="flex shrink-0 items-center gap-2">
          {task.status === 'downloading' && (
            <>
              <span className="text-nv-green">{speedStr}/s</span>
              <span className="text-stealth-muted/40">{etaStr}</span>
            </>
          )}
          <span className={`uppercase ${statusColor(task.status)}`}>{task.status}</span>
        </div>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-stealth-dark">
        <div
          className={`h-full transition-all duration-300 ${progressColor(task.status)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-1.5">
        {task.status === 'downloading' && (
          <button
            type="button"
            onClick={handlePause}
            className="rounded-sm border border-yellow-400/30 px-1.5 py-0.5 text-[8px] font-mono text-yellow-400 transition-all hover:bg-yellow-400/10"
          >
            PAUSE
          </button>
        )}
        {task.status === 'paused' && (
          <button
            type="button"
            onClick={handleResume}
            className="rounded-sm border border-nv-green/30 px-1.5 py-0.5 text-[8px] font-mono text-nv-green transition-all hover:bg-nv-green/10"
          >
            RESUME
          </button>
        )}
        {(task.status === 'downloading' || task.status === 'paused' || task.status === 'queued') && (
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-sm border border-red-400/30 px-1.5 py-0.5 text-[8px] font-mono text-red-400 transition-all hover:bg-red-400/10"
          >
            CANCEL
          </button>
        )}
        {task.status === 'failed' && task.error && (
          <span className="truncate text-[8px] font-mono text-red-400/60">{task.error}</span>
        )}
      </div>
    </div>
  );
}