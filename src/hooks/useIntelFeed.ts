import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { IntelFeed, ProviderConfig } from "../lib/types";

export type IntelFeedStatus = "loading" | "online" | "offline";

export function useIntelFeed() {
  const [feed, setFeed] = useState<IntelFeed | null>(null);
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [status, setStatus] = useState<IntelFeedStatus>("loading");

  const load = useCallback(async (force = false) => {
    setStatus("loading");
    try {
      const [nextFeed, nextProviders] = await Promise.all([
        invoke<IntelFeed>("fetch_github_intel", { force }),
        invoke<ProviderConfig[]>("list_providers"),
      ]);
      setFeed(nextFeed);
      setProviders(nextProviders.filter((p) => p.enabled));
      setStatus("online");
    } catch {
      setStatus("offline");
    }
  }, []);

  useEffect(() => {
    void load(false);
  }, [load]);

  const refresh = useCallback(() => load(true), [load]);

  return { feed, providers, status, refresh };
}