import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadTask } from "@/lib/types";
import { useTauriListen } from "./useTauriListen";

export type DownloadTaskKind = "hf" | "toolchain" | "app" | "provider";

function taskKindOf(task: DownloadTask): DownloadTaskKind {
  if (task.taskKind === "toolchain") return "toolchain";
  if (task.taskKind === "app") return "app";
  if (task.taskKind === "provider") return "provider";
  return "hf";
}

function matchesKind(task: DownloadTask, kind?: DownloadTaskKind): boolean {
  if (!kind) return true;
  return taskKindOf(task) === kind;
}

export function useDownloadTasks(kind?: DownloadTaskKind) {
  const [downloads, setDownloads] = useState<DownloadTask[]>([]);
  const pollRef = useRef<(() => void) | null>(null);
  const timerRef = useRef<number | null>(null);

  const stopPolling = useCallback(() => {
    if (timerRef.current) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const pollDownloads = useCallback(async () => {
    try {
      const tasks = await invoke<DownloadTask[]>("get_download_tasks");
      const visible = tasks.filter((t) => matchesKind(t, kind));
      setDownloads(visible);
      // Byte progress is not event-pushed by the backend, so keep the 500ms poll
      // alive ONLY while a task of this kind is in flight. When idle, stop polling
      // and let the `download-event` listener (queued/paused/...) wake us back up.
      const active = visible.some(
        (t) => t.status === "queued" || t.status === "downloading" || t.status === "scanning",
      );
      if (active && timerRef.current == null) {
        timerRef.current = window.setInterval(() => void pollRef.current?.(), 500);
      } else if (!active) {
        stopPolling();
      }
    } catch {
      console.error("Failed to poll download tasks");
    }
  }, [kind, stopPolling]);

  useEffect(() => {
    pollRef.current = () => {
      void pollDownloads();
    };
  }, [pollDownloads]);

  // One poll on mount; the interval is armed on-demand inside pollDownloads.
  useEffect(() => {
    void pollDownloads();
    return stopPolling;
  }, [pollDownloads, stopPolling]);

  useTauriListen<{ type?: string }>("download-event", () => {
    pollRef.current?.();
  }, []);

  return downloads;
}