import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import ModelHubSearch from './ModelHubSearch';
import type { DownloadTask } from '@/lib/types';

export default function ModelHub() {
  const [subView, setSubView] = useState<'search' | 'library'>('search');
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const completedRefs = useRef(new Set<string>());

  useEffect(() => {
    const poll = async () => {
      try {
        const tasks = await invoke<DownloadTask[]>('get_download_tasks');
        setDownloads(tasks);

        // Detect newly-completed downloads and trigger catalog refresh
        for (const t of tasks) {
          if (t.status === 'completed' && !completedRefs.current.has(t.id)) {
            completedRefs.current.add(t.id);
            window.dispatchEvent(new CustomEvent('download-completed'));
          }
        }
      } catch {}
    };
    poll();
    const interval = setInterval(poll, 1000);
    return () => clearInterval(interval);
  }, []);

  const activeDownloads = downloads.filter(d =>
    d.status === 'downloading' || d.status === 'queued' || d.status === 'paused' || d.status === 'scanning'
  );

  return (
    <div className="flex flex-col h-full px-6 py-4 gap-3">
      {/* Sub-navigation */}
      <div className="flex items-center gap-2 border-b border-stealth-border pb-2">
        <button
          onClick={() => setSubView('search')}
          className={`px-4 py-1.5 text-xs font-mono tracking-wider transition-all ${
            subView === 'search'
              ? 'bg-nv-green/20 text-nv-green border border-nv-green/40 rounded-sm'
              : 'text-stealth-muted hover:text-white border border-transparent rounded-sm'
          }`}
        >
          SEARCH & DOWNLOAD
        </button>
        <button
          onClick={() => setSubView('library')}
          className={`px-4 py-1.5 text-xs font-mono tracking-wider transition-all ${
            subView === 'library'
              ? 'bg-nv-green/20 text-nv-green border border-nv-green/40 rounded-sm'
              : 'text-stealth-muted hover:text-white border border-transparent rounded-sm'
          }`}
        >
          LIBRARY
        </button>
      </div>

      {/* Content area */}
      <div className="flex-1 overflow-hidden">
        {subView === 'search' && <ModelHubSearch />}
        {subView === 'library' && (
          <div className="flex items-center justify-center h-full text-stealth-muted/50 font-mono text-xs italic">
            LIBRARY VIEW — COMING SOON
          </div>
        )}
      </div>

      {/* Download manager floating panel */}
      {activeDownloads.length > 0 && (
        <div className="border border-stealth-border bg-stealth-panel/90 backdrop-blur-sm rounded-sm p-3 space-y-2">
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

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[10px] font-mono">
        <span className="text-white/80 truncate mr-2">{task.hfModelId}</span>
        <div className="flex items-center gap-3 flex-shrink-0">
          {task.status === 'downloading' && (
            <>
              <span className="text-nv-green">{speedStr}/s</span>
              <span className="text-stealth-muted/40">{etaStr}</span>
            </>
          )}
          <span className={`uppercase ${statusColor(task.status)}`}>{task.status}</span>
        </div>
      </div>
      <div className="h-1 bg-stealth-dark rounded-full overflow-hidden">
        <div
          className={`h-full transition-all duration-300 ${progressColor(task.status)}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
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

function statusColor(status: string): string {
  switch (status) {
    case 'downloading': return 'text-nv-green';
    case 'paused': return 'text-yellow-400';
    case 'failed': return 'text-red-400';
    case 'scanning': return 'text-blue-400';
    default: return 'text-stealth-muted/40';
  }
}

function progressColor(status: string): string {
  switch (status) {
    case 'downloading': return 'bg-nv-green';
    case 'paused': return 'bg-yellow-400';
    case 'failed': return 'bg-red-400';
    case 'scanning': return 'bg-blue-400 animate-pulse';
    default: return 'bg-stealth-muted/20';
  }
}
