//! Engine presentation model — the single place that turns provider config, release packs
//! and the runtime/toolchain state into what the UI shows. Screens render this and never
//! re-derive states or sizes themselves.

import { DEFAULT_BINARY_PROFILE } from "./foundry_constants";
import { DEFAULT_PROVIDER_ID, envBinaryLookup, isProfileSourceActive } from "./types";
import type { BinarySourceKind, BinaryUpdateInfo, ProviderConfig } from "./types";
import type { ToolchainInstallInfo } from "../components/FoundryToolchainPanel";

export type EngineModeState = "ready" | "install" | "driver";

export interface EngineModeOverview {
  id: string;
  label: string;
  tagline: string;
  blurb: string;
  cuda: string;
  driverFloor: number | null;
  driverMajor: number | null;
  version: string | null;
  source: BinarySourceKind | undefined;
  state: EngineModeState;
  engineMissing: boolean;
  runtimeMissing: boolean;
  /** Engine pack + missing runtime, in bytes. 0 when nothing needs downloading. */
  sizeBytes: number;
  updateAvailable: boolean;
  /** Which sources actually exist on disk for this mode. */
  sources: { bundled: boolean; catalog: boolean; foundry: boolean };
}

export interface EngineOverview {
  id: string;
  label: string;
  buildVersion: string | null;
  hasUpdate: boolean;
  modes: EngineModeOverview[];
}

export const MODE_META = [
  {
    id: "edge",
    label: "EDGE",
    tagline: "Max speed",
    blurb: "Newest CUDA. Fastest kernels, needs a very recent driver.",
  },
  {
    id: "stable",
    label: "STABLE",
    tagline: "Maximum compatibility",
    blurb: "Older CUDA. Runs on two-year-old drivers and lagging models.",
  },
] as const;

function realVersion(version: string | undefined): string | null {
  if (!version) return null;
  return /disk-scanned|unknown/i.test(version) ? null : version;
}

export function buildEngineOverview(
  providers: ProviderConfig[],
  updates: BinaryUpdateInfo[],
  toolchain: ToolchainInstallInfo | null,
): EngineOverview | null {
  const engine = providers.find((p) => p.id === DEFAULT_PROVIDER_ID);
  if (!engine) return null;

  const modes: EngineModeOverview[] = MODE_META.map((meta) => {
    const runtime = toolchain?.runtime_versions.find((v) => v.id === meta.id);
    const runtimePack = toolchain?.packs.find(
      (p) => p.kind === "runtime" && p.cuda === runtime?.cuda,
    );
    const update = updates.find((u) => u.profile === meta.id);
    const version = realVersion(engine.buildInfoPerEnv?.[meta.id]?.version);
    const has = (s: "bundled" | "foundry" | "catalog") => {
      const entry = envBinaryLookup(engine, meta.id, s);
      return Boolean(entry?.path?.trim() || entry?.info);
    };
    const sources = { bundled: has("bundled"), foundry: has("foundry"), catalog: has("catalog") };
    const source: BinarySourceKind =
      (["foundry", "catalog", "bundled"] as const).find((s) =>
        isProfileSourceActive(engine, meta.id, s),
      ) ??
      (sources.bundled ? "bundled" : sources.catalog ? "catalog" : "foundry");
    const runtimeMissing = runtime ? !runtime.ready : true;
    const driverBlocked = runtime ? !runtime.driver_ok : false;
    const engineMissing = !version;

    // Downloading happens when the mode is missing, or when the pack is newer than what
    // is installed; either way the engine pack is the payload, plus the runtime if absent.
    let sizeBytes = 0;
    if (engineMissing || update?.available) sizeBytes += update?.packSizeBytes ?? 0;
    if (runtimeMissing) sizeBytes += runtimePack?.size_bytes ?? 0;

    const state: EngineModeState = driverBlocked
      ? "driver"
      : engineMissing || runtimeMissing
        ? "install"
        : "ready";

    return {
      id: meta.id,
      label: meta.label,
      tagline: meta.tagline,
      blurb: meta.blurb,
      cuda: runtime?.cuda ?? update?.cuda ?? "",
      driverFloor: runtime?.min_driver_major ?? null,
      driverMajor: runtime?.driver_major ?? null,
      version,
      source,
      state,
      engineMissing,
      runtimeMissing,
      sizeBytes,
      updateAvailable: Boolean(update?.available),
      sources,
    };
  });

  return {
    id: engine.id,
    label: engine.display_name || "GGML Master",
    buildVersion: realVersion(engine.buildInfoPerEnv?.[DEFAULT_BINARY_PROFILE]?.version),
    hasUpdate: modes.some((m) => m.updateAvailable),
    modes,
  };
}

export function modeSourceLabel(source: BinarySourceKind | undefined): string {
  switch (source) {
    case "catalog":
      return "Downloaded";
    case "foundry":
      return "Built locally";
    case "bundled":
      return "Bundled";
    default:
      return "Bundled";
  }
}
