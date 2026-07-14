import type { AppTheme } from "../themes/app-themes";

const LIGHT_APP_THEME_IDS = new Set(["arctic"]);

export function nativeThemeForAppTheme(theme: AppTheme): "dark" | "light" {
  return LIGHT_APP_THEME_IDS.has(theme.id) ? "light" : "dark";
}

/** Sync Windows/macOS/Linux native chrome (title bar, caption buttons) with app theme. */
export async function applyNativeWindowTheme(theme: AppTheme): Promise<void> {
  if (typeof window === "undefined" || !window.__TAURI__) return;
  try {
    const { getCurrentWindow } = await import("@tauri-apps/api/window");
    await getCurrentWindow().setTheme(nativeThemeForAppTheme(theme));
  } catch {
    // Non-Tauri surfaces (plain Vite) — no-op.
  }
}