/** Shared utility functions — single source of truth */

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