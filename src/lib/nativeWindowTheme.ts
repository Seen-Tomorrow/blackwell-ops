import type { AppTheme } from "../themes/app-themes";


/** Sync Windows/macOS/Linux native chrome (title bar, caption buttons) with app theme. */
export async function applyNativeWindowTheme(theme: AppTheme): Promise<void> {
  if (typeof window === "undefined" || !window.__TAURI__) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(theme.native === "light" ? "light" : "dark");
  } catch {
    // Non-Tauri surfaces (plain Vite) — no-op.
  }
}