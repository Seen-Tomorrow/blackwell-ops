/** Shared utility functions — single source of truth */

import { invoke } from "@tauri-apps/api/core";

export async function revealPathInExplorer(path: string): Promise<void> {
  try {
    await invoke("reveal_path_in_explorer", { path });
  } catch (e) {
    console.error("[revealPathInExplorer]", e);
  }
}

export function isMobileDevice(): boolean {
  try {
    if (typeof window === "undefined") return false;
    const width = window.innerWidth;
    if (width <= 768) return true;
    const ua = navigator.userAgent.toLowerCase();
    return /android|iphone|ipad|ipod|mobi/i.test(ua);
  } catch {
    return false;
  }
}