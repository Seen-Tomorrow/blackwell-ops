import { invoke } from "@tauri-apps/api/core";
import type { BuildInfo, ProviderConfig } from "./types";

const PLACEHOLDER_VERSIONS = new Set([
  "",
  "unknown",
  "bundled",
  "disk-scanned",
  "foundry-artifact",
  "downloaded",
  "catalog",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** True when any inventory row still has a mtime-only placeholder (needs --version probe). */
function inventoryVersionsNeedRetry(provider: ProviderConfig): boolean {
  const rows: { paths?: Record<string, string>; infos?: Record<string, BuildInfo> }[] = [
    { paths: provider.bundledBinaryPathPerEnv, infos: provider.bundledBuildInfoPerEnv },
    { paths: provider.foundryBinaryPathPerEnv, infos: provider.foundryBuildInfoPerEnv },
    { paths: provider.catalogBinaryPathPerEnv, infos: provider.catalogBuildInfoPerEnv },
  ];
  return rows.some(({ paths, infos }) =>
    Object.keys(paths ?? {}).some((env) => {
      const version = infos?.[env]?.version ?? "";
      return PLACEHOLDER_VERSIONS.has(version);
    }),
  );
}

export type RefreshBuildInfoHandlers = {
  /** Called when a single provider's probe starts. */
  onProviderStart?: (providerId: string) => void;
  /**
   * Called as soon as that provider's `refresh_build_info` returns (full provider list
   * from backend — apply immediately so UI updates per provider).
   */
  onProvidersUpdated?: (providers: ProviderConfig[]) => void;
  onProviderDone?: (providerId: string) => void;
};

async function refreshOnce(
  providers: ProviderConfig[],
  handlers?: RefreshBuildInfoHandlers,
): Promise<ProviderConfig[]> {
  const targets = providers.filter((p) => p.git_url && p.branch);
  if (targets.length === 0) return providers;

  let latest = providers;
  for (const provider of targets) {
    handlers?.onProviderStart?.(provider.id);
    try {
      const updated = await invoke<ProviderConfig[]>("refresh_build_info", {
        providerId: provider.id,
      });
      if (updated.length > 0) {
        latest = updated;
        handlers?.onProvidersUpdated?.(updated);
      }
    } catch (err) {
      console.error("[Foundry] refresh_build_info failed for", provider.id, err);
    } finally {
      handlers?.onProviderDone?.(provider.id);
    }
  }
  return latest;
}

/** Probe bundled/foundry binaries via `--version` and merge into provider list. */
export async function refreshProvidersBuildInfo(
  providers: ProviderConfig[],
  handlers?: RefreshBuildInfoHandlers,
): Promise<ProviderConfig[]> {
  let latest = await refreshOnce(providers, handlers);
  if (!latest.some(inventoryVersionsNeedRetry)) {
    return latest;
  }
  await sleep(200);
  return refreshOnce(latest, handlers);
}

export function isPlaceholderBuildVersion(info: BuildInfo | undefined): boolean {
  return PLACEHOLDER_VERSIONS.has(info?.version ?? "");
}
