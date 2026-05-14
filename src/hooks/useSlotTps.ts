import { useState, useEffect, useRef, useCallback } from "react";

interface SlotTpsData {
  id: number;
  tps: number;
  isProcessing: boolean;
  nDecoded: number;
  nCtx: number;
  tokensThisRequest: number;
}

interface RawSlotToken {
  has_next_token: boolean;
  has_new_line: boolean;
  n_remain: number;
  n_decoded: number;
}

interface RawSlotParams {
  // Only the fields we care about exist here, rest is ignored
  [key: string]: unknown;
}

interface RawSlot {
  id: number;
  n_ctx: number;
  speculative: boolean;
  is_processing: boolean;
  id_task: number;
  params: RawSlotParams;
  next_token: RawSlotToken[];
}

interface UseSlotTpsReturn {
  slots: SlotTpsData[];
  error: string | null;
}

export function useSlotTps(port: number): UseSlotTpsReturn {
  const [slots, setSlots] = useState<SlotTpsData[]>([]);
  const [error, setError] = useState<string | null>(null);

  const prevRef = useRef<Map<number, { nDecoded: number; ts: number; isProcessing: boolean }>>(new Map());
  const sessionStartRef = useRef<Map<number, number>>(new Map()); // slot id -> n_decoded at request start
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    try {
      const resp = await fetch(`http://localhost:${port}/slots`, { signal: AbortSignal.timeout(1500) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

      const data: RawSlot[] = await resp.json();
      const now = performance.now();

      setSlots((prev) => {
        const next: SlotTpsData[] = [];

        for (const slot of data) {
          const tokenInfo = slot.next_token?.[0];
          const nDecoded = tokenInfo?.n_decoded ?? 0;
          const prev = prevRef.current.get(slot.id);
          const wasProcessing = prev ? prev.isProcessing : false;

          // Detect new request: is_processing just went true, or n_decoded jumped (new session)
          if (slot.is_processing && !wasProcessing) {
            sessionStartRef.current.set(slot.id, nDecoded);
          }

          const sessionStart = sessionStartRef.current.get(slot.id) ?? 0;
          let tokensThisRequest = Math.max(0, nDecoded - sessionStart);

          // When processing stops, clear the session boundary
          if (!slot.is_processing && wasProcessing) {
            sessionStartRef.current.delete(slot.id);
          }

          let tps = 0;
          if (prev && nDecoded > prev.nDecoded) {
            const dtSec = (now - prev.ts) / 1000;
            if (dtSec > 0) {
              tps = (nDecoded - prev.nDecoded) / dtSec;
            }
          }

          prevRef.current.set(slot.id, { nDecoded, ts: now, isProcessing: slot.is_processing });

          next.push({
            id: slot.id,
            tps,
            isProcessing: slot.is_processing,
            nDecoded,
            nCtx: slot.n_ctx,
            tokensThisRequest,
          });
        }

        // Preserve slots that disappeared from response (set to zero)
        const ids = new Set(next.map((s) => s.id));
        for (const s of prev) {
          if (!ids.has(s.id)) next.push({ ...s, tps: 0, isProcessing: false, tokensThisRequest: 0 });
        }

        return next;
      });

      setError(null);
    } catch (e: any) {
      setError(e.message ?? "Failed to fetch /slots");
    }
  }, [port]);

  useEffect(() => {
    poll();
    intervalRef.current = setInterval(poll, 200);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [poll]);

  return { slots, error };
}
