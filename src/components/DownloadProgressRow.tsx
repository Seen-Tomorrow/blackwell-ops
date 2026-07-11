import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadStatus, DownloadTask } from "@/lib/types";

function statusColor(status: DownloadStatus): string {
  switch (status) {
    case "downloading":
      return "text-nv-green";
    case "paused":
      return "text-yellow-400";
    case "failed":
      return "text-red-400";
    case "scanning":
      return "text-blue-400";
    default:
      return "text-stealth-muted/40";
  }
}

function progressColor(status: DownloadStatus): string {
  switch (status) {
    case "downloading":
      return "bg-nv-green";
    case "paused":
      return "bg-yellow-400";
    case "failed":
      return "bg-red-400";
    case "scanning":
      return "bg-blue-400 animate-pulse";
    default:
      return "bg-stealth-muted/20";
  }
}

function formatSpeed(bps: number): string {
  if (bps < 1024 * 1024) return `${Math.round(bps / 1024)} KB`;
  return `${(bps / (1024 * 1024)).toFixed(1)} MB`;
}

function formatETA(seconds: number): string {
  if (seconds === 0 || seconds > 36000) return "—";
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function statusLabel(task: DownloadTask): string {
  if (task.status === "scanning" && task.taskKind === "toolchain") {
    return "extracting";
  }
  return task.status;
}

interface DownloadProgressRowProps {
  task: DownloadTask;
  onActionError?: (msg: string | null) => void;
  compact?: boolean;
}

export default function DownloadProgressRow({
  task,
  onActionError,
  compact = false,
}: DownloadProgressRowProps) {
  const pct =
    task.totalBytes > 0
      ? Math.round((task.downloadedBytes / task.totalBytes) * 100)
      : 0;
  const speedStr = formatSpeed(task.speedBps);
  const etaStr = formatETA(task.etaSeconds);
  const canResume =
    task.status === "paused" ||
    (task.taskKind === "toolchain" && task.status === "failed");

  const reportActionError = useCallback(
    (action: string, e: unknown) => {
      console.error(`Failed to ${action} download:`, e);
      const detail = typeof e === "string" ? e : "unknown error";
      onActionError?.(`${action.toUpperCase()} FAILED: ${detail}`);
    },
    [onActionError],
  );

  const handlePause = useCallback(async () => {
    onActionError?.(null);
    try {
      await invoke("pause_download", { taskId: task.id });
    } catch (e) {
      reportActionError("pause", e);
    }
  }, [task.id, onActionError, reportActionError]);

  const handleResume = useCallback(async () => {
    onActionError?.(null);
    try {
      await invoke("resume_download", { taskId: task.id });
    } catch (e) {
      reportActionError("resume", e);
    }
  }, [task.id, onActionError, reportActionError]);

  const handleCancel = useCallback(async () => {
    onActionError?.(null);
    try {
      await invoke("cancel_download", { taskId: task.id });
    } catch (e) {
      reportActionError("cancel", e);
    }
  }, [task.id, onActionError, reportActionError]);

  const title = task.hfModelId || task.fileName;
  const showProgress =
    task.status === "downloading" ||
    task.status === "paused" ||
    task.status === "failed" ||
    task.status === "scanning";

  return (
    <div
      className={`rounded-sm border border-stealth-border/60 bg-stealth-surface/40 space-y-1.5 ${
        compact ? "p-1.5" : "p-2"
      }`}
    >
      <div className={`flex items-center justify-between gap-2 font-mono ${compact ? "text-[8px]" : "text-[9px]"}`}>
        <span className="truncate text-white/80">{title}</span>
        {!compact && (
          <span className="shrink-0 text-stealth-muted/40">
            {formatSize(task.downloadedBytes)} / {formatSize(task.totalBytes)}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {task.status === "downloading" && !compact && (
            <>
              <span className="text-nv-green">{speedStr}/s</span>
              <span className="text-stealth-muted/40">{etaStr}</span>
            </>
          )}
          <span className={`uppercase ${statusColor(task.status)}`}>
            {statusLabel(task)}
          </span>
        </div>
      </div>
      {showProgress && (
        <div className={`overflow-hidden rounded-full bg-stealth-dark ${compact ? "h-1" : "h-1.5"}`}>
          <div
            className={`h-full transition-all duration-300 ${progressColor(task.status)}`}
            style={{
              width: `${task.status === "scanning" ? 100 : pct}%`,
            }}
          />
        </div>
      )}
      {task.status === "scanning" && task.taskKind === "toolchain" && (
        <p className={`font-mono text-blue-400/80 ${compact ? "text-[7px]" : "text-[8px]"}`}>
          {task.error ?? "Extracting toolchain…"} (~4 GB, may take a few minutes)
        </p>
      )}
      {task.status === "scanning" && task.taskKind !== "toolchain" && task.error && (
        <p className={`font-mono text-stealth-muted/70 ${compact ? "text-[7px]" : "text-[8px]"}`}>
          {task.error}
        </p>
      )}
      <div className="flex items-center gap-1.5">
        {task.status === "downloading" && (
          <button
            type="button"
            onClick={handlePause}
            className="rounded-sm border border-yellow-400/30 px-1.5 py-0.5 text-[8px] font-mono text-yellow-400 transition-all hover:bg-yellow-400/10"
          >
            PAUSE
          </button>
        )}
        {canResume && (
          <button
            type="button"
            onClick={handleResume}
            className="rounded-sm border border-nv-green/30 px-1.5 py-0.5 text-[8px] font-mono text-nv-green transition-all hover:bg-nv-green/10"
          >
            RESUME
          </button>
        )}
        {(task.status === "downloading" ||
          task.status === "paused" ||
          task.status === "queued") && (
          <button
            type="button"
            onClick={handleCancel}
            className="rounded-sm border border-red-400/30 px-1.5 py-0.5 text-[8px] font-mono text-red-400 transition-all hover:bg-red-400/10"
          >
            CANCEL
          </button>
        )}
        {task.status === "failed" && task.error && (
          <span className="truncate text-[8px] font-mono text-red-400/60">
            {task.error}
          </span>
        )}
      </div>
    </div>
  );
}