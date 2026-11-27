import { useEffect, useRef } from "react";
import type { DownloadTask } from "@/lib/types";
import { useDownloadTasks } from "@/hooks/useDownloadTasks";
import { dispatchAppEvent, EVENTS } from "@/lib/events";

function isActiveTask(t: DownloadTask): boolean {
  return (
    t.status === "queued" ||
    t.status === "downloading" ||
    t.status === "paused" ||
    t.status === "scanning"
  );
}

/** Prefer an actively downloading task, else the most recently initiated active task. */
function pickPrimary(tasks: DownloadTask[]): DownloadTask | undefined {
  const active = tasks.filter(isActiveTask);
  if (active.length === 0) return undefined;
  const downloading = active.filter((t) => t.status === "downloading" || t.status === "scanning");
  const pool = downloading.length > 0 ? downloading : active;
  return pool.reduce((best, t) => (t.id > best.id ? t : best));
}

function fmtSpeed(bps: number): string {
  if (!bps || bps <= 0) return "";
  const mb = bps / 1_048_576;
  if (mb >= 1) return `${mb >= 100 ? mb.toFixed(0) : mb.toFixed(1)} MB/s`;
  return `${Math.round(bps / 1024)} KB/s`;
}

function shortTaskLabel(t: DownloadTask): string {
  if (t.hfModelId) {
    const repo = t.hfModelId.split("/").pop() || t.hfModelId;
    return repo.replace(/-GGUF$/i, "");
  }
  return t.fileName.replace(/\.gguf$/i, "");
}

/**
 * Rich DOWNLOAD primary-nav segment content (mirrors FoundryNavBadge).
 * Relays HF / Xet download completion so the model catalog refreshes everywhere.
 */
export default function DownloadNavBadge() {
  const downloads = useDownloadTasks();
  const completedRefs = useRef(new Set<string>());

  useEffect(() => {
    for (const t of downloads) {
      if (t.status !== "completed" || completedRefs.current.has(t.id)) continue;
      completedRefs.current.add(t.id);
      if (!t.taskKind || t.taskKind === "hf" || t.taskKind === "xet") {
        dispatchAppEvent(EVENTS.downloadCompleted);
      }
    }
  }, [downloads]);

  const active = downloads.filter(isActiveTask);
  const primary = pickPrimary(downloads);

  if (!primary) {
    return (
      <span className="fnd-nav-badge fnd-nav-badge--idle dl-nav-badge--idle">
        <span className="fnd-nav-badge__name">DOWNLOAD</span>
      </span>
    );
  }

  const percent =
    primary.totalBytes > 0
      ? Math.max(0, Math.min(100, (primary.downloadedBytes / primary.totalBytes) * 100))
      : 0;
  const isPaused = primary.status === "paused";
  const isQueued = primary.status === "queued";
  const tone = isPaused || isQueued ? "paused" : "active";
  const speed = !isPaused && !isQueued ? fmtSpeed(primary.speedBps) : "";
  const stateLabel = isPaused
    ? "PAUSED"
    : isQueued
      ? "QUEUED"
      : primary.status === "scanning"
        ? "VERIFY"
        : speed || "DL";
  const extraCount = active.length > 1 ? `+${active.length - 1}` : null;
  const label = shortTaskLabel(primary);

  return (
    <span
      className={`fnd-nav-badge fnd-nav-badge--${tone}`}
      title={[
        primary.hfModelId || primary.fileName,
        primary.statusMessage || primary.status.toUpperCase(),
        `${Math.round(percent)}%`,
        speed || null,
        extraCount ? `${extraCount} more in queue` : null,
      ]
        .filter(Boolean)
        .join(" · ")}
    >
      <span className="fnd-nav-badge__top">
        <span className="fnd-nav-badge__mark" aria-hidden>⬇</span>
        <span className="fnd-nav-badge__stage">{label}</span>
        {extraCount && <span className="fnd-nav-badge__env">{extraCount}</span>}
        <span className="fnd-nav-badge__pct">{Math.round(percent)}%</span>
      </span>
      <span className="fnd-nav-badge__bottom">
        <span
          className="fnd-nav-badge__track"
          role="progressbar"
          aria-label="Download progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(percent)}
        >
          <span className="fnd-nav-badge__fill" style={{ width: `${percent}%` }} />
        </span>
        <span className="fnd-nav-badge__timer">{stateLabel}</span>
      </span>
    </span>
  );
}
