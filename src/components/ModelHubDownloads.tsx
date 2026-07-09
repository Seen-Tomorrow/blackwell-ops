import { useState } from 'react';
import type { DownloadTask, DownloadStatus } from '@/lib/types';
import DownloadProgressRow from './DownloadProgressRow';

const ACTIVE_STATUSES: DownloadStatus[] = ['downloading', 'queued', 'paused', 'scanning'];

interface ModelHubDownloadsProps {
  downloads: DownloadTask[];
}

export default function ModelHubDownloads({ downloads }: ModelHubDownloadsProps) {
  const activeDownloads = downloads.filter((d) => ACTIVE_STATUSES.includes(d.status));
  const [actionError, setActionError] = useState<string | null>(null);

  return (
    <div className="flex h-full min-h-0 flex-col px-3 py-2.5">
      {actionError && (
        <div className="mb-2 truncate text-[8px] font-mono text-red-400/80">
          {actionError}
        </div>
      )}
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
            <DownloadProgressRow key={task.id} task={task} onActionError={setActionError} />
          ))
        )}
      </div>
    </div>
  );
}