/**
 * Dev-only guard for React 19's performance-track measures.
 *
 * React's development build emits a `performance.measure("<ComponentName>")` for every
 * component render — the "performance tracks" flame chart in Chrome DevTools. Those entries
 * live in the renderer's native performance timeline, **not** the JS heap, so V8 can never
 * GC them: a DEV app left open for a day accumulated 3.4 M measures (~1.2 KB each) and a
 * ~4 GB private working set in the renderer while `JSHeapUsedSize` stayed at ~60 MB. REL
 * builds emit none, which is why only DEV appeared to leak.
 *
 * Bounded rather than disabled: entries are only cleared past a threshold, so a short
 * DevTools recording still captures what the user asked for.
 */
const MEASURE_LIMIT = 20_000;
const CHECK_INTERVAL_MS = 10_000;

export function installPerfTimelineGuard(): () => void {
  if (
    typeof performance === "undefined"
    || typeof performance.getEntriesByType !== "function"
    || typeof performance.clearMeasures !== "function"
  ) {
    return () => {};
  }

  const timer = window.setInterval(() => {
    try {
      if (performance.getEntriesByType("measure").length < MEASURE_LIMIT) return;
      performance.clearMeasures();
      performance.clearMarks();
    } catch {
      /* a dev-only guard must never break the app */
    }
  }, CHECK_INTERVAL_MS);

  return () => window.clearInterval(timer);
}
