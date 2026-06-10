import { useState, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import ModelHubSearch from './ModelHubSearch';
import ModelHubDownloadPaths from './ModelHubDownloadPaths';
import ModelHubDownloads from './ModelHubDownloads';
import type { DownloadTask } from '@/lib/types';
import { dispatchAppEvent, EVENTS } from '@/lib/events';

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
    const interval = setInterval(poll, 500);
    return () => { cancelled = true; clearInterval(interval); };
  }, []);

  return (
    <div className="flex flex-col h-full px-6 py-4 gap-3" data-model-hub>
      <div className="flex items-center gap-2 border-b border-stealth-border pb-2">
        <span className="px-4 py-1.5 text-xs font-mono tracking-wider value-chip-active">
          SEARCH & DOWNLOAD
        </span>
      </div>

      <div className="flex-1 overflow-hidden flex flex-col min-h-0 gap-0">
        <div className="grid shrink-0 grid-cols-2 min-h-[160px] max-h-[40%] border border-stealth-border/60 rounded-sm overflow-hidden divide-x divide-stealth-border/60">
          <ModelHubDownloadPaths />
          <ModelHubDownloads downloads={downloads} />
        </div>

        <div className="flex-1 overflow-hidden min-h-0 mt-2">
          <ModelHubSearch />
        </div>
      </div>
    </div>
  );
}