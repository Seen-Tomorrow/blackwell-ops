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
      <div className="dl-paths-state animate-pulse">
        LOADING DOWNLOAD FOLDER...
      </div>
    );
  }

  if (paths.length === 0) {
    return (
      <div className="dl-paths-state">
        NO MODEL FOLDER CONFIGURED — ADD ONE IN CONFIG / PATHS
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-2.5">
      <div className="dl-paths-heading">
        Download folder
      </div>
      {pathError && (
        <div className="dl-paths-error mb-2 rounded-sm border px-2 py-1 font-mono">
          {pathError}
        </div>
      )}
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto">
      {paths.map((entry) => {
        const activeHere = pathHasActiveDownloads(entry.path, downloads);
        return (
        <div
          key={entry.path}
          className={`theme-surface-row flex items-center justify-between gap-3 rounded-sm px-2.5 py-1.5 ${
            entry.isDefault ? "model-hub-path-row--default" : ""
          }`}
        >
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              {entry.isDefault && (
                <span className="value-chip value-chip-active shrink-0 font-mono px-1.5 py-0.5">
                  DEFAULT
                </span>
              )}
              {activeHere && (
                <span className="model-hub-badge-download type-tiny shrink-0 font-mono px-1.5 py-0.5 rounded-sm">
                  DOWNLOADING
                </span>
              )}
              <span className="dl-paths-label truncate font-mono">
                {entry.label || entry.path}
              </span>
            </div>
            <div className="dl-paths-sub truncate font-mono">
              {displayModelPath(entry.path)}
            </div>
            {activeHere && !entry.isDefault && (
              <div className="dl-paths-note mt-0.5 font-mono">
                In-progress downloads stay in this folder
              </div>
            )}
          </div>
          {!entry.isDefault && (
            <button
              type="button"
              onClick={() => handleSetDefault(entry.path)}
              title="Set as default for download"
              className="value-chip shrink-0 px-2 py-0.5 font-mono whitespace-nowrap"
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