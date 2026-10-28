import { useEffect, useRef, useState } from "react";
import {
  ETA_WINDOW_MS,
  etaAnchor,
  etaRemaining,
  pushSamples,
  type EdgeProgress,
  type EdgeSample,
  type EtaAnchor,
} from "../lib/foundryProgress";

/**
 * Windowed compile ETA shared by the build hero and the ear.
 *
 * The anchor is kept because the ninja counter legitimately stands still while one
 * fatbin instance compiles for minutes; the number counts down against the wall
 * clock instead of vanishing, and only gives up once the estimate is spent.
 */
export function useCompileEta(edge: EdgeProgress | null, active: boolean): number | null {
  const samplesRef = useRef<EdgeSample[]>([]);
  const anchorRef = useRef<EtaAnchor | null>(null);
  const [eta, setEta] = useState<number | null>(null);
  const done = edge?.done ?? null;
  const total = edge?.total ?? null;

  useEffect(() => {
    if (done == null || total == null || total <= 0) {
      samplesRef.current = [];
      anchorRef.current = null;
      setEta(null);
      return;
    }
    const now = Date.now();
    samplesRef.current = pushSamples(
      samplesRef.current,
      { t: now, done, total },
      ETA_WINDOW_MS,
    );
    anchorRef.current = etaAnchor(samplesRef.current);
    setEta(etaRemaining(anchorRef.current, now));
  }, [done, total]);

  useEffect(() => {
    if (total == null || !active) return;
    const id = window.setInterval(() => {
      setEta(etaRemaining(anchorRef.current, Date.now()));
    }, 2000);
    return () => window.clearInterval(id);
  }, [total, active]);

  return eta;
}
