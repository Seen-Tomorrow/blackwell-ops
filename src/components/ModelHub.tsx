import { useState, useEffect, useRef, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import ModelHubSearch from './ModelHubSearch';
import ModelHubDownloadPaths from './ModelHubDownloadPaths';
import ModelHubDownloads from './ModelHubDownloads';
import type { DownloadTask } from '@/lib/types';
import { dispatchAppEvent, EVENTS } from '@/lib/events';
import { useTauriListen } from '../hooks/useTauriListen';
import TabPageHeader from './TabPageHeader';

export default function ModelHub() {
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const completedRefs = useRef(new Set<string>());
  const pollRef = useRef<(() => void) | null>(null);

  const pollDownloads = useCallback(async () => {
    try {
      const tasks = await invoke<DownloadTask[]>('get_download_tasks');
      setDownloads(tasks);
      for (const t of tasks) {
        if (t.status === 'completed' && !completedRefs.current.has(t.id)) {
          completedRefs.current.add(t.id);
          dispatchAppEvent(EVENTS.downloadCompleted);
        }
      }
    } catch {
      console.error('Failed to poll download tasks');
    }
  }, []);

  useEffect(() => {
    pollRef.current = () => { void pollDownloads(); };
  }, [pollDownloads]);

  useEffect(() => {
    void pollDownloads();
    const interval = setInterval(() => { void pollDownloads(); }, 500);
    return () => clearInterval(interval);
  }, [pollDownloads]);

  useTauriListen<{ type?: string }>('download-event', () => {
    pollRef.current?.();
  }, []);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" data-model-hub>
      <TabPageHeader title="MODEL HUB" />

      <div className="flex-1 overflow-hidden flex flex-col min-h-0 gap-0 px-4 py-3">
        <div className="grid shrink-0 grid-cols-2 min-h-[160px] max-h-[40%] border border-stealth-border/60 rounded-sm overflow-hidden divide-x divide-stealth-border/60">
          <ModelHubDownloadPaths downloads={downloads} />
          <ModelHubDownloads downloads={downloads} />
        </div>

        <div className="flex-1 overflow-hidden min-h-0 mt-2">
          <ModelHubSearch />
        </div>
      </div>
    </div>
  );
}