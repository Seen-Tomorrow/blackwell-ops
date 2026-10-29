import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface ArchRule {
  tensor_split?: boolean;
  reason?: string;
}

export interface ArchCapabilities {
  version: number;
  arches: Record<string, ArchRule>;
}

/** Shared arch-capability table; same JSON the launch guard reads. */
export function useArchCapabilities(): ArchCapabilities | null {
  const [caps, setCaps] = useState<ArchCapabilities | null>(null);

  useEffect(() => {
    let cancelled = false;
    invoke<ArchCapabilities>("get_arch_capabilities")
      .then((next) => {
        if (!cancelled) setCaps(next);
      })
      .catch(() => {
        // Missing table/broken command = keep provider defaults; backend still guards.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return caps;
}
