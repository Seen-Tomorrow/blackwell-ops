import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { invoke } from '@tauri-apps/api/core';
import ModelHubSearch from './ModelHubSearch';
import type { DownloadTask, DownloadStatus } from '@/lib/types';
import { dispatchAppEvent, EVENTS } from '@/lib/events';

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
  if (bps < 1024 * 1024) return Math.round(bps / 1024).toString();
  return (bps / (1024 * 1024)).toFixed(1);
}

function formatETA(seconds: number): string {
  if (seconds === 0 || seconds > 36000) return '—';
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

export default function ModelHub() {
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const completedRefs = useRef(new Set<string>());

  useEffect(() => {
    let cancelled = false;
    const poll = async () => {
      try {
        const tasks = await invoke<DownloadTask[]>('get_download_tasks');
        if (cancelled) return;
        setDownloads(tasks);
        for (const t of tasks) {
          if (t.status === 'completed' && !completedRefs.current.has(t.id)) {
            completedRefs.current.add(t.id);
            dispatchAppEvent(EVENTS.downloadCompleted);
          }
        }
      } catch {
        if (!cancelled) {
          console.error('Failed to poll download tasks');
        }
      }
    };
    poll();
    const interval = setInterval(poll, 1000);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  const activeDownloads = useMemo(() => downloads.filter(d => ACTIVE_STATUSES.includes(d.status)), [downloads]);

  return (
    <div className="flex flex-col h-full px-6 py-4 gap-3" data-model-hub>
      <div className="flex items-center gap-2 border-b border-stealth-border pb-2">
        <span className="px-4 py-1.5 text-xs font-mono tracking-wider value-chip-active">
          SEARCH & DOWNLOAD
        </span>
      </div>

      <div className="flex-1 overflow-hidden">
        <ModelHubSearch />
      </div>

      {activeDownloads.length > 0 && (
        <div className="eink-panel-wrapper p-3 space-y-2">
          <div className="text-[10px] font-mono text-nv-green tracking-wider flex items-center gap-2">
            <span>⬇ DOWNLOADS</span>
            <span className="text-stealth-muted/40">{activeDownloads.length} active</span>
          </div>
          {activeDownloads.map(task => (
            <DownloadProgressRow key={task.id} task={task} />
          ))}
        </div>
      )}
    </div>
  );
}

function DownloadProgressRow({ task }: { task: DownloadTask }) {
  const pct = task.totalBytes > 0 ? Math.round((task.downloadedBytes / task.totalBytes) * 100) : 0;
  const speedStr = formatSpeed(task.speedBps);
  const etaStr = formatETA(task.etaSeconds);

  const handlePause = useCallback(async () => {
    try { await invoke('pause_download', { taskId: task.id }); } catch { /* silent */ }
  }, [task.id]);

  const handleResume = useCallback(async () => {
    try { await invoke('resume_download', { taskId: task.id }); } catch { /* silent */ }
  }, [task.id]);

  const handleCancel = useCallback(async () => {
    try { await invoke('cancel_download', { taskId: task.id }); } catch { /* silent */ }
  }, [task.id]);

  return (
    <div className="eink-card p-2.5 space-y-1.5">
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-white/80 truncate mr-2">{task.hfModelId}</span>
        <div className="flex items-center gap-2 flex-shrink-0">
          {task.status === 'downloading' && (
            <>
              <span className="text-nv-green">{speedStr}/s</span>
              <span className="text-stealth-muted/40">{etaStr}</span>
            </>
          )}
          <span className={`uppercase ${statusColor(task.status)}`}>{task.status}</span>
        </div>
      </div>
      <div className="h-1.5 bg-stealth-dark rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${progressColor(task.status)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex items-center gap-1.5">
        {task.status === 'downloading' && (
          <button onClick={handlePause} className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-yellow-400/30 text-yellow-400 hover:bg-yellow-400/10 transition-all">
            PAUSE
          </button>
        )}
        {task.status === 'paused' && (
          <button onClick={handleResume} className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-nv-green/30 text-nv-green hover:bg-nv-green/10 transition-all">
            RESUME
          </button>
        )}
        {(task.status === 'downloading' || task.status === 'paused' || task.status === 'queued') && (
          <button onClick={handleCancel} className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-red-400/30 text-red-400 hover:bg-red-400/10 transition-all">
            CANCEL
          </button>
        )}
        {task.status === 'failed' && task.error && (
          <span className="text-[8px] font-mono text-red-400/60 truncate">{task.error}</span>
        )}
      </div>
    </div>
  );
}
