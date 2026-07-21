import { useEffect, useRef } from 'react';
import ModelHubSearch from './ModelHubSearch';
import ModelHubDownloadPaths from './ModelHubDownloadPaths';
import ModelHubDownloads from './ModelHubDownloads';
import { dispatchAppEvent, EVENTS } from '@/lib/events';
import { useDownloadTasks } from '../hooks/useDownloadTasks';
import TabPageHeader from './TabPageHeader';

interface ModelHubProps {
  /** When true, parent ExtrasPage owns the page chrome. */
  embedded?: boolean;
}

export default function ModelHub({ embedded = false }: ModelHubProps) {
  // All task kinds (HF models, app update, provider packs, toolchain) — top = download manager.
  const downloads = useDownloadTasks();
  const completedRefs = useRef(new Set<string>());

  useEffect(() => {
    for (const t of downloads) {
      if (t.status === 'completed' && !completedRefs.current.has(t.id)) {
        completedRefs.current.add(t.id);
        // Catalog only cares about model files landing on disk.
        if (!t.taskKind || t.taskKind === 'hf') {
          dispatchAppEvent(EVENTS.downloadCompleted);
        }
      }
    }
  }, [downloads]);

  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" data-model-hub>
      {!embedded && <TabPageHeader title="MODEL HUB" />}

      <div className={`flex-1 overflow-hidden flex flex-col min-h-0 gap-0 ${embedded ? "px-3 py-2" : "px-4 py-3"}`}>
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