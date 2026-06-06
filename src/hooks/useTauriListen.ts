import { useEffect, useRef } from "react";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * StrictMode-safe Tauri event subscription.
 * Generation counter drops stale listen() resolutions after unmount/remount.
 */
export function useTauriListen<T>(
  event: string,
  handler: (payload: T) => void,
  deps: unknown[] = [],
): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    const gen = ++generationRef.current;
    let cancelled = false;

    const setup = async () => {
      const tauriListen = window.__TAURI__?.event?.listen;
      if (!tauriListen) return;

      const unlisten = await tauriListen(event, (e: { payload: T }) => {
        if (cancelled || generationRef.current !== gen) return;
        handlerRef.current(e.payload);
      });

      if (cancelled || generationRef.current !== gen) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;
    };

    void setup();

    return () => {
      cancelled = true;
      const u = unlistenRef.current;
      unlistenRef.current = null;
      u?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- caller controls deps
  }, deps);
}