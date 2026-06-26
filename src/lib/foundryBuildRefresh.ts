import { invoke } from "@tauri-apps/api/core";
import type { BuildInfo, ProviderConfig } from "./types";

const PLACEHOLDER_VERSIONS = new Set([
  "",
  "unknown",
  "bundled",
  "disk-scanned",
  "foundry-artifact",
  "downloaded",
]);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bundledVersionsNeedRetry(provider: ProviderConfig): boolean {
  const paths = provider.bundledBinaryPathPerEnv ?? {};
  const infos = provider.bundledBuildInfoPerEnv ?? {};
  return Object.keys(paths).some((env) => {
    const version = infos[env]?.version ?? "";
    return PLACEHOLDER_VERSIONS.has(version);
  });
}

async function refreshOnce(providers: ProviderConfig[]): Promise<ProviderConfig[]> {
  const targets = providers.filter((p) => p.git_url && p.branch);
  if (targets.length === 0) return providers;

  let latest = providers;
  for (const provider of targets) {
    try {
      const updated = await invoke<ProviderConfig[]>("refresh_build_info", {
        providerId: provider.id,
      });
      if (updated.length > 0) latest = updated;
    } catch (err) {
      console.error("[Foundry] refresh_build_info failed for", provider.id, err);
    }
  }
  return latest;
}

/** Probe bundled/foundry binaries via `--version` and merge into provider list. */
export async function refreshProvidersBuildInfo(
  providers: ProviderConfig[],
): Promise<ProviderConfig[]> {
  const maxAttempts = 4;
  let latest = providers;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    latest = await refreshOnce(latest);
    const needsRetry = latest.some(bundledVersionsNeedRetry);
    if (!needsRetry || attempt === maxAttempts - 1) {
      return latest;
    }
    await sleep(600 * (attempt + 1));
  }

  return latest;
}

export function isPlaceholderBuildVersion(info: BuildInfo | undefined): boolean {
  return PLACEHOLDER_VERSIONS.has(info?.version ?? "");
}