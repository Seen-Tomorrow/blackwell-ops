import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

export interface EngineReasoningCaps {
  supported: boolean;
  levels: string[];
}

/**
 * Loaded engine's chat-template effort levels from `/props`.
 * This is informational for clients; the launch `--reasoning-budget` is separate.
 */
export function useEngineReasoning(
  port: number | null | undefined,
  enabled: boolean,
  identity?: string | null,
): EngineReasoningCaps | null {
  const [caps, setCaps] = useState<EngineReasoningCaps | null>(null);

  useEffect(() => {
    let cancelled = false;
    setCaps(null);
    if (!port || !enabled) return;

    invoke<EngineReasoningCaps>("get_engine_reasoning_levels", { port })
      .then((next) => {
        if (!cancelled) setCaps(next);
      })
      .catch(() => {
        // Older engine or template without caps: leave the rail clean.
      });

    return () => {
      cancelled = true;
    };
  }, [port, enabled, identity]);

  return caps;
}
