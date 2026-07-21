/**
 * Compact active-download indicator for the tab page header (far right).
 * Relays HF download completion so the catalog refreshes even outside Model Hub.
 */

import { useEffect, useRef } from "react";
import type { DownloadTask } from "@/lib/types";
import { useDownloadTasks } from "@/hooks/useDownloadTasks";
import { dispatchAppEvent, dispatchNavigateModelHub, EVENTS } from "@/lib/events";
import DownloadProgressRow from "./DownloadProgressRow";

function isActiveTask(t: DownloadTask): boolean {
  return (
    t.status === "queued" ||
    t.status === "downloading" ||
    t.status === "paused" ||
    t.status === "scanning"
  );
}

/** Most recently initiated active task (task ids are UTC micros). */
function pickPrimary(tasks: DownloadTask[]): DownloadTask | undefined {
  const active = tasks.filter(isActiveTask);
  if (active.length === 0) return undefined;
  return active.reduce((best, t) => (t.id > best.id ? t : best));
}

export default function HeaderDownloadStrip() {
  const downloads = useDownloadTasks();
  const completedRefs = useRef(new Set<string>());

  useEffect(() => {
    for (const t of downloads) {
      if (t.status !== "completed" || completedRefs.current.has(t.id)) continue;
      completedRefs.current.add(t.id);
      // HF model finishes (incl. DFlash Get draft) — refresh library everywhere.
      if (!t.taskKind || t.taskKind === "hf") {
        dispatchAppEvent(EVENTS.downloadCompleted);
      }
    }
  }, [downloads]);

  const primary = pickPrimary(downloads);
  if (!primary) return null;

  const activeCount = downloads.filter(isActiveTask).length;

  return (
    <button
      type="button"
      className="tab-page-header__downloads flex items-center gap-2 flex-shrink-0 justify-end cursor-pointer hover:opacity-95 text-left"
      title="Open download manager (MODEL HUB)"
      onClick={() => dispatchNavigateModelHub()}
    >
      <DownloadProgressRow task={primary} inline />
      {activeCount > 1 ? (
        <span className="text-[7px] font-mono text-stealth-muted/70 whitespace-nowrap flex-shrink-0">
          +{activeCount - 1}
        </span>
      ) : null}
    </button>
  );
}
