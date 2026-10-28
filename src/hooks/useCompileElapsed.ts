import { useEffect, useRef, useState } from "react";

function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/**
 * Compile timer shared by the ear and the build hero.
 *
 * Ticks only while compilation is active; once the build reaches a terminal phase
 * the elapsed value freezes instead of continuing to climb behind a "DONE" badge.
 */
export function useCompileElapsed(
  compileStartedAt: number | null,
  active: boolean,
  terminal: boolean,
): string {
  const [now, setNow] = useState(() => Date.now());
  const [endedAt, setEndedAt] = useState<number | null>(null);

  useEffect(() => {
    if (terminal) {
      setEndedAt((prev) => prev ?? Date.now());
      return;
    }
    setEndedAt(null);
  }, [terminal]);

  useEffect(() => {
    if (!compileStartedAt || !active || terminal) return;
    const id = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, [compileStartedAt, active, terminal]);

  if (!compileStartedAt) return "—:—";
  const end = terminal ? (endedAt ?? now) : now;
  return formatElapsed(end - compileStartedAt);
}
