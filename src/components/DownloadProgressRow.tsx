import { useCallback, useState, type MouseEvent as ReactMouseEvent } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadStatus, DownloadTask } from "@/lib/types";

function statusColor(status: DownloadStatus): string {
  switch (status) {
    case "downloading":
      return "dl-row-status--active";
    case "paused":
      return "dl-row-status--warn";
    case "failed":
      return "dl-row-status--danger";
    case "scanning":
      return "dl-row-status--info";
    default:
      return "dl-row-status--idle";
  }
}

function progressColor(status: DownloadStatus): string {
  switch (status) {
    case "downloading":
      return "dl-progress-fill--active";
    case "paused":
      return "dl-progress-fill--warn";
    case "failed":
      return "dl-progress-fill--danger";
    case "scanning":
      return "dl-progress-fill--info animate-pulse";
    default:
      return "dl-progress-fill--idle";
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
  if (task.status === "scanning" && task.taskKind === "provider") {
    return "extracting";
  }
  if (task.status === "scanning" && task.taskKind === "app") {
    return "installing";
  }
  return task.status;
}

interface DownloadProgressRowProps {
  task: DownloadTask;
  onActionError?: (msg: string | null) => void;
  /** Stacked card (Model Hub). */
  compact?: boolean;
  /** Single horizontal row for tab page header — no name truncation. */
  inline?: boolean;
}

export default function DownloadProgressRow({
  task,
  onActionError,
  compact = false,
  inline = false,
}: DownloadProgressRowProps) {
  const pct =
    task.totalBytes > 0
      ? Math.round((task.downloadedBytes / task.totalBytes) * 100)
      : 0;
  const speedStr = formatSpeed(task.speedBps);
  const etaStr = formatETA(task.etaSeconds);
  // Explicit user cancellation (backend sets error = "Cancelled") is NOT resumable — the
  // partial file is deleted and the task is meant to go away, not be picked back up.
  const isCancelled = task.status === "failed" && task.error === "Cancelled";
  const canResume =
    task.status === "paused" ||
    ((task.taskKind === "toolchain" || task.taskKind === "app" || task.taskKind === "provider") &&
      task.status === "failed" &&
      !isCancelled);

  const reportActionError = useCallback(
    (action: string, e: unknown) => {
      console.error(`Failed to ${action} download:`, e);
      const detail = typeof e === "string" ? e : "unknown error";
      onActionError?.(`${action.toUpperCase()} FAILED: ${detail}`);
    },
    [onActionError],
  );

  const handlePause = useCallback(async (e?: ReactMouseEvent) => {
    e?.stopPropagation();
    onActionError?.(null);
    try {
      await invoke("pause_download", { taskId: task.id });
    } catch (err) {
      reportActionError("pause", err);
    }
  }, [task.id, onActionError, reportActionError]);

  const handleResume = useCallback(async (e?: ReactMouseEvent) => {
    e?.stopPropagation();
    onActionError?.(null);
    try {
      await invoke("resume_download", { taskId: task.id });
    } catch (err) {
      reportActionError("resume", err);
    }
  }, [task.id, onActionError, reportActionError]);

  const handleCancel = useCallback(async (e?: ReactMouseEvent) => {
    e?.stopPropagation();
    onActionError?.(null);
    try {
      await invoke("cancel_download", { taskId: task.id });
    } catch (err) {
      reportActionError("cancel", err);
    }
  }, [task.id, onActionError, reportActionError]);

  const [confirmCancel, setConfirmCancel] = useState(false);
  const title = task.hfModelId || task.fileName;
  const showProgress =
    task.status === "downloading" ||
    task.status === "paused" ||
    task.status === "failed" ||
    task.status === "scanning";

  const handleCancelClick = useCallback((e?: ReactMouseEvent) => {
    e?.stopPropagation();
    // Ask first — PAUSE and CANCEL sit side by side, and cancel deletes the partial file.
    setConfirmCancel(true);
  }, []);

  const priority = task.priority ?? 100;
  const canReprioritize = task.status === "queued" || task.status === "paused";

  const handlePriorityUp = useCallback(async (e?: ReactMouseEvent) => {
    e?.stopPropagation();
    try {
      await invoke("move_download_up", { taskId: task.id });
    } catch (err) {
      reportActionError("reprioritize", err);
    }
  }, [task.id, reportActionError]);

  const handlePriorityDown = useCallback(async (e?: ReactMouseEvent) => {
    e?.stopPropagation();
    try {
      await invoke("move_download_down", { taskId: task.id });
    } catch (err) {
      reportActionError("reprioritize", err);
    }
  }, [task.id, reportActionError]);

  const actionBtns = (
    <>
      {canReprioritize && (
        <button
          type="button"
          onClick={(e) => { void handlePriorityUp(e); }}
          className="dl-row-btn dl-row-btn--idle rounded-sm border px-1 py-0.5 font-mono transition-all whitespace-nowrap"
          title="Move up in queue (higher priority)"
        >
          ▲
        </button>
      )}
      {canReprioritize && (
        <button
          type="button"
          onClick={(e) => { void handlePriorityDown(e); }}
          className="dl-row-btn dl-row-btn--idle rounded-sm border px-1 py-0.5 font-mono transition-all whitespace-nowrap"
          title="Move down in queue (lower priority)"
        >
          ▼
        </button>
      )}
      {task.status === "downloading" && (
        <button
          type="button"
          onClick={(e) => { void handlePause(e); }}
          className="dl-row-btn dl-row-btn--warn rounded-sm border px-1.5 py-0.5 font-mono transition-all whitespace-nowrap"
        >
          PAUSE
        </button>
      )}
      {canResume && (
        <button
          type="button"
          onClick={(e) => { void handleResume(e); }}
          className="dl-row-btn dl-row-btn--active rounded-sm border px-1.5 py-0.5 font-mono transition-all whitespace-nowrap"
        >
          RESUME
        </button>
      )}
      {(task.status === "downloading" ||
        task.status === "paused" ||
        task.status === "queued") && (
        <button
          type="button"
          onClick={(e) => { handleCancelClick(e); }}
          className="dl-row-btn dl-row-btn--danger rounded-sm border px-1.5 py-0.5 font-mono transition-all whitespace-nowrap"
        >
          CANCEL
        </button>
      )}
    </>
  );

  const confirmModal = confirmCancel ? (
    <div className="download-confirm-overlay" onClick={(e) => { e.stopPropagation(); setConfirmCancel(false); }}>
      <div className="download-confirm" onClick={(e) => e.stopPropagation()}>
        <p className="download-confirm__title">Cancel this download?</p>
        <p className="download-confirm__body">
          This will remove the unfinished download from disk. Pause keeps your progress instead.
        </p>
        <div className="download-confirm__actions">
          <button
            type="button"
            className="download-confirm__btn download-confirm__btn--no"
            onClick={(e) => { e.stopPropagation(); setConfirmCancel(false); }}
          >
            NO — KEEP IT
          </button>
          <button
            type="button"
            className="download-confirm__btn download-confirm__btn--yes"
            onClick={(e) => {
              e.stopPropagation();
              setConfirmCancel(false);
              void handleCancel(e);
            }}
          >
            YES — REMOVE
          </button>
        </div>
      </div>
    </div>
  ) : null;

  if (inline) {
    return (
      <>
      <div className="download-progress-inline flex items-center gap-2 min-w-0 font-mono">
        <span className="download-progress-inline__name dl-row-name whitespace-nowrap">
          {title}
        </span>
        {task.fileName && task.hfModelId && task.fileName !== task.hfModelId ? (
          <span className="dl-row-file whitespace-nowrap">{task.fileName}</span>
        ) : null}
        <span className="dl-row-size whitespace-nowrap tabular-nums">
          {formatSize(task.downloadedBytes)}/{formatSize(task.totalBytes)}
        </span>
        {task.status === "downloading" ? (
          <>
            <span className="dl-row-speed whitespace-nowrap">{speedStr}/s</span>
            <span className="dl-row-eta whitespace-nowrap">{etaStr}</span>
          </>
        ) : null}
        <span className={`dl-row-status uppercase whitespace-nowrap ${statusColor(task.status)}`}>
          {statusLabel(task)}
          {task.status !== "scanning" && task.totalBytes > 0 ? ` ${pct}%` : ""}
        </span>
        {showProgress ? (
          <div className="download-progress-inline__bar dl-row-bar overflow-hidden rounded-full h-1.5 flex-shrink-0">
            <div
              className={`h-full transition-all duration-300 ${progressColor(task.status)}`}
              style={{ width: `${task.status === "scanning" ? 100 : pct}%` }}
            />
          </div>
        ) : null}
        <div className="flex items-center gap-1 flex-shrink-0">{actionBtns}</div>
        {task.status === "failed" && task.error ? (
          <span className="dl-row-error whitespace-nowrap" title={task.error}>
            {task.error}
          </span>
        ) : null}
        {task.retryCount && task.retryCount > 0 && (
          <span className="dl-row-retry whitespace-nowrap"
            title={`Retried ${task.retryCount} time(s) due to transient network errors`}>
            RETRY×{task.retryCount}
          </span>
        )}
      </div>
      {confirmModal}
      </>
    );
  }

  return (
    <>
    <div
      className={`dl-row-card rounded-sm border ${
        compact ? "p-1.5" : "p-2"
      }`}
    >
      <div className={`dl-row-head flex items-center justify-between gap-2 font-mono ${compact ? 'dl-row-head--compact' : 'dl-row-head--full'}`}>
        <span className="dl-row-title truncate">{title}</span>
        {!compact && (
          <span className="dl-row-size shrink-0">
            {formatSize(task.downloadedBytes)} / {formatSize(task.totalBytes)}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-2">
          {task.status === "downloading" && !compact && (
            <>
              <span className="dl-row-speed">{speedStr}/s</span>
              <span className="dl-row-eta">{etaStr}</span>
            </>
          )}
          <span className={`dl-row-status uppercase ${statusColor(task.status)}`}>
            {statusLabel(task)}
          </span>
        </div>
      </div>
      {showProgress && (
        <div className={`dl-row-bar overflow-hidden rounded-full ${compact ? "h-1" : "h-1.5"}`}>
          <div
            className={`h-full transition-all duration-300 ${progressColor(task.status)}`}
            style={{
              width: `${task.status === "scanning" ? 100 : pct}%`,
            }}
          />
        </div>
      )}
      {task.status === "scanning" && task.taskKind === "toolchain" && (
        <p className={`dl-row-scan font-mono ${compact ? 'dl-row-scan--compact' : 'dl-row-scan--full'}`}>
          {task.statusMessage ?? task.error ?? "Extracting toolchain…"} (~4 GB, may take a few minutes)
        </p>
      )}
      {task.status === "scanning" && task.taskKind === "app" && (
        <p className={`dl-row-scan font-mono ${compact ? 'dl-row-scan--compact' : 'dl-row-scan--full'}`}>
          {task.statusMessage ?? task.error ?? "Applying app update…"} (app will restart)
        </p>
      )}
      {task.status === "scanning" && task.taskKind === "provider" && (
        <p className={`dl-row-scan font-mono ${compact ? 'dl-row-scan--compact' : 'dl-row-scan--full'}`}>
          {task.statusMessage ?? task.error ?? "Extracting engine pack…"}
        </p>
      )}
      {task.status === "scanning" &&
        task.taskKind !== "toolchain" &&
        task.taskKind !== "app" &&
        task.taskKind !== "provider" &&
        (task.statusMessage || task.error) && (
        <p className={`dl-row-statusmsg font-mono ${compact ? 'dl-row-statusmsg--compact' : 'dl-row-statusmsg--full'}`}>
          {task.statusMessage ?? task.error}
        </p>
      )}
      {/* Non-scanning status messages (e.g. "Verifying integrity…", "Retrying…"). */}
      {task.status !== "scanning" && task.statusMessage && (
        <p className={`dl-row-statusmsg font-mono ${compact ? 'dl-row-statusmsg--compact' : 'dl-row-statusmsg--full'}`}>
          {task.statusMessage}
        </p>
      )}
      <div className="flex items-center gap-1.5">{actionBtns}</div>
      {task.status === "failed" && task.error && (
        <span className="dl-row-error truncate font-mono">
          {task.error}
        </span>
      )}
    </div>
    {confirmModal}
    </>
  );
}
