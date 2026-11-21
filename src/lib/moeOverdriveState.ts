/**
 * Whether MOE OVERDRIVE owns the glass. A page-level flag because two places care: the badge
 * (which screen to draw) and the forecast layout (fusion must not auto-open over it).
 */
import { useEffect, useState } from "react";

let active = false;
const listeners = new Set<() => void>();

export function setOverdriveActive(next: boolean): void {
  if (active === next) return;
  active = next;
  for (const cb of listeners) cb();
}

function subscribeOverdrive(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

export function useOverdriveActive(): boolean {
  const [value, setValue] = useState(active);
  useEffect(() => subscribeOverdrive(() => setValue(active)), []);
  return value;
}
