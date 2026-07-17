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

  const pollDownloads = useCallback(async () => {
    try {
      const tasks = await invoke<DownloadTask[]>("get_download_tasks");
      setDownloads(tasks.filter((t) => matchesKind(t, kind)));
    } catch {
      console.error("Failed to poll download tasks");
    }
  }, [kind]);

  useEffect(() => {
    pollRef.current = () => {
      void pollDownloads();
    };
  }, [pollDownloads]);

  useEffect(() => {
    void pollDownloads();
    const interval = setInterval(() => {
      void pollDownloads();
    }, 500);
    return () => clearInterval(interval);
  }, [pollDownloads]);

  useTauriListen<{ type?: string }>("download-event", () => {
    pollRef.current?.();
  }, []);

  return downloads;
}