import { invoke } from "@tauri-apps/api/core";

/**
 * HF listing cache.
 *
 * Anonymous Hub API calls are rate-limited per hour, and the picker asks for the same
 * repo tree every time a slot opens — opening MMPROJ, then ENGRAM, then MMPROJ again is
 * three listings of the same repo. The draft *search* already caches its offers
 * (`dflashGetDraft`), but the companion listings went to the network every time.
 *
 * Cache the command result for a short TTL and de-duplicate in-flight calls, so a panel
 * that opens twice while the first listing is still streaming makes one request.
 * Deliberately frontend-only: repo trees change rarely, and a stale tree for half an
 * hour costs nothing while a 429 costs the whole feature.
 */

const DEFAULT_TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 60;

interface Entry {
  at: number;
  value: unknown;
}

const store = new Map<string, Entry>();
const inflight = new Map<string, Promise<unknown>>();

function keyOf(cmd: string, args?: Record<string, unknown>): string {
  // Args are small and flat here (paths + role), but sort keys so call sites that build
  // the object in a different order still share the entry.
  const arg = args
    ? Object.keys(args)
        .sort()
        .map((k) => `${k}=${String(args[k])}`)
        .join("&")
    : "";
  return `${cmd}?${arg}`;
}


function evictIfNeeded(): void {
  if (store.size <= MAX_ENTRIES) return;
  const oldest = [...store.entries()].sort((a, b) => a[1].at - b[1].at)[0];
  if (oldest) store.delete(oldest[0]);
}

export async function cachedInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
  ttlMs = DEFAULT_TTL_MS,
): Promise<T> {
  const key = keyOf(cmd, args);
  const hit = store.get(key);
  if (hit && Date.now() - hit.at <= ttlMs) return hit.value as T;

  const running = inflight.get(key);
  if (running) return running as Promise<T>;

  const pending = invoke<T>(cmd, args)
    .then((value) => {
      store.set(key, { at: Date.now(), value });
      evictIfNeeded();
      return value;
    })
    .finally(() => {
      inflight.delete(key);
    });

  inflight.set(key, pending);
  return pending;
}

/** Drop one listing (or everything) — call after something is known to have changed. */
export function forgetHfListing(cmd?: string, args?: Record<string, unknown>): void {
  if (!cmd) {
    store.clear();
    return;
  }
  store.delete(keyOf(cmd, args));
}
