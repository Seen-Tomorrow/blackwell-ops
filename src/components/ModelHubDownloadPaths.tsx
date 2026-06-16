import { useCallback, useEffect, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { DownloadStatus, DownloadTask, ModelPathEntry } from '@/lib/types';
import { dispatchAppEvent, EVENTS } from '@/lib/events';

const ACTIVE_DOWNLOAD_STATUSES: DownloadStatus[] = ['downloading', 'queued', 'paused', 'scanning'];

function normalizeModelPathKey(path: string): string {
  return displayModelPath(path).replace(/[/\\]+$/, '').toLowerCase();
}

function pathHasActiveDownloads(path: string, downloads: DownloadTask[]): boolean {
  const root = normalizeModelPathKey(path);
  if (!root) return false;
  const rootPrefix = `${root}/`;
  const rootPrefixBackslash = `${root}\\`;
  return downloads.some((task) => {
    if (!ACTIVE_DOWNLOAD_STATUSES.includes(task.status)) return false;
    const dest = normalizeModelPathKey(task.destPath);
    return dest === root || dest.startsWith(rootPrefix) || dest.startsWith(rootPrefixBackslash);
  });
}

function displayModelPath(path: string): string {
  if (path.startsWith('\\\\?\\UNC\\')) {
    return `\\\\${path.slice('\\\\?\\UNC\\'.length)}`;
  }
  if (path.startsWith('\\\\?\\')) {
    return path.slice('\\\\?\\'.length);
  }
  return path;
}

interface ModelHubDownloadPathsProps {
  downloads: DownloadTask[];
}

export default function ModelHubDownloadPaths({ downloads }: ModelHubDownloadPathsProps) {
  const [paths, setPaths] = useState<ModelPathEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [pathError, setPathError] = useState<string | null>(null);

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
      setPathError(null);
      await invoke('set_default_model_path', { path });
      loadPaths();
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      const msg = typeof e === 'string' ? e : 'Failed to set default download folder';
      console.error('Failed to set default model path:', msg);
      setPathError(msg);
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
      {pathError && (
        <div className="mb-2 rounded-sm border border-telemetry-red/30 bg-telemetry-red/5 px-2 py-1 text-[8px] font-mono text-telemetry-red">
          {pathError}
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
      {paths.map((entry) => {
        const activeHere = pathHasActiveDownloads(entry.path, downloads);
        return (
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
              {activeHere && (
                <span className="shrink-0 text-[8px] font-mono text-yellow-400/80 bg-yellow-400/10 px-1.5 py-0.5 rounded-sm">
                  DOWNLOADING
                </span>
              )}
              <span className="truncate text-[10px] font-mono text-white/90">
                {entry.label || entry.path}
              </span>
            </div>
            <div className="truncate text-[8px] font-mono text-stealth-muted/80">
              {displayModelPath(entry.path)}
            </div>
            {activeHere && !entry.isDefault && (
              <div className="mt-0.5 text-[7px] font-mono text-stealth-muted/60">
                In-progress downloads stay in this folder
              </div>
            )}
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
        );
      })}
      </div>
    </div>
  );
}