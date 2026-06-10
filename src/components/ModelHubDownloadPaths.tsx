import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { ModelPathEntry } from '@/lib/types';
import { dispatchAppEvent, EVENTS } from '@/lib/events';

function displayModelPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`;
  }
  if (path.startsWith('\\\\?\\')) {
    return path.slice('\\\\?\\'.length);
  }
  return path;
}

export default function ModelHubDownloadPaths() {
  const [paths, setPaths] = useState<ModelPathEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const loadPaths = useCallback(async () => {
    try {
      const entries = await invoke<ModelPathEntry[]>('list_model_paths');
      setPaths(entries);
    } catch (e) {
      console.error('Failed to load model paths:', e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPaths();
  }, [loadPaths]);

  useEffect(() => {
    const handler = () => { loadPaths(); };
    window.addEventListener(EVENTS.modelPathsChanged, handler);
    return () => window.removeEventListener(EVENTS.modelPathsChanged, handler);
  }, [loadPaths]);

  const handleSetDefault = useCallback(async (path: string) => {
    try {
      await invoke('set_default_model_path', { path });
      loadPaths();
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      console.error('Failed to set default model path:', e);
    }
  }, [loadPaths]);

  if (loading) {
    return (
      <div className="flex h-full min-h-0 flex-col px-3 py-2.5 text-[9px] font-mono text-stealth-muted animate-pulse">
        LOADING DOWNLOAD FOLDER...
      </div>
    );
  }

  if (paths.length === 0) {
    return (
      <div className="flex h-full min-h-0 flex-col px-3 py-2.5 text-[9px] font-mono text-stealth-muted">
        NO MODEL FOLDER CONFIGURED — ADD ONE IN CONFIG / PATHS
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-2.5">
      <div className="mb-2 text-[9px] font-mono text-stealth-muted tracking-wider uppercase">
        Download folder
      </div>
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
      {paths.map((entry) => (
        <div
          key={entry.path}
          className={`flex items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 ${
            entry.isDefault ? 'border border-nv-green/30 bg-nv-green/5' : 'border border-stealth-border/60 bg-stealth-surface/40'
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {entry.isDefault && (
                <span className="shrink-0 text-[8px] font-mono text-nv-green bg-nv-green/15 px-1.5 py-0.5 rounded-sm">
                  DEFAULT
                </span>
              )}
              <span className="truncate text-[10px] font-mono text-white/90">
                {entry.label || entry.path}
              </span>
            </div>
            <div className="truncate text-[8px] font-mono text-stealth-muted/80">
              {displayModelPath(entry.path)}
            </div>
          </div>
          {!entry.isDefault && (
            <button
              type="button"
              onClick={() => handleSetDefault(entry.path)}
              title="Set as default for download"
              className="shrink-0 px-2 py-0.5 text-[8px] font-mono border border-yellow-400/30 text-yellow-400/70 hover:bg-yellow-400/10 transition-colors whitespace-nowrap"
            >
              SET AS DEFAULT FOR DOWNLOAD
            </button>
          )}
        </div>
      ))}
      </div>
    </div>
  );
}