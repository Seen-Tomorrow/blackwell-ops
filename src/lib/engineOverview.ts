//! Engine presentation model — the single place that turns provider config, release packs
//! and the runtime/toolchain state into what the UI shows. Screens render this and never
//! re-derive states or sizes themselves.

import { DEFAULT_BINARY_PROFILE } from "./foundry_constants";
import { DEFAULT_PROVIDER_ID, envBinaryLookup, isProfileBuilt, isProfileSourceActive } from "./types";
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
  sourceBuildDate: string | null;
  state: EngineModeState;
  /** Binary present on disk, regardless of whether its identity could be probed. */
  installed: boolean;
  engineMissing: boolean;
  runtimeMissing: boolean;
  /** Engine pack + missing runtime, in bytes. 0 when nothing needs downloading. */
  sizeBytes: number;
  updateAvailable: boolean;
  /** A published engine pack exists for this mode (false when offline or unpublished). */
  packAvailable: boolean;
  /** Engine version carried by the published pack, if any. */
  packVersion: string | null;
  /** Pack size, plus the runtime when that is missing (the real download a click triggers). */
  downloadSizeBytes: number;
  /** Every engine source present on disk, with its identity and build time. */
  sources: EngineSourceOption[];
}

export interface EngineSourceOption {
  id: BinarySourceKind;
  label: string;
  available: boolean;
  active: boolean;
  /** Real engine identity, or null when the scan only has a placeholder. */
  version: string | null;
  /** File build time ("YYYY-MM-DD HH:MM"), sortable. */
  buildDate: string | null;
  /** Newest source on disk (by build time) — the one to recommend. */
  newest: boolean;
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
    blurb: "Newest CUDA. Fastest kernels, needs recent GPU driver.",
  },
  {
    id: "stable",
    label: "STABLE",
    tagline: "Maximum compatibility",
    blurb: "Most compatible CUDA. Runs on older drivers and lagging models.",
  },
] as const;

function realVersion(version: string | undefined): string | null {
  if (!version) return null;
  return /disk-scanned|unknown|catalog|bundled|downloaded|foundry-artifact/i.test(version) ? null : version;
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
    const sources: EngineSourceOption[] = (["bundled", "catalog", "foundry"] as const).map(
      (s) => {
        const entry = envBinaryLookup(engine, meta.id, s);
        return {
          id: s,
          label: s === "bundled" ? "Bundled" : s === "catalog" ? "Downloaded" : "Built locally",
          available: Boolean(entry?.path?.trim() || entry?.info),
          active: isProfileSourceActive(engine, meta.id, s),
          version: realVersion(entry?.info?.version),
          buildDate: entry?.info?.buildDate?.trim() || null,
          newest: false,
        };
      },
    );
    // Freshest by build time; ties fall back to the first available entry.
    const dated = sources
      .filter((s) => s.available && s.buildDate)
      .sort((a, b) => (a.buildDate! < b.buildDate! ? 1 : -1));
    if (dated.length > 0) dated[0].newest = true;
    const source: BinarySourceKind =
      sources.find((s) => s.active)?.id ??
      (sources.find((s) => s.id === "bundled" && s.available)?.id ?? "foundry");
    const runtimeMissing = runtime ? !runtime.ready : true;
    const driverBlocked = runtime ? !runtime.driver_ok : false;
    // Existence is a filesystem fact; a version string is only an identity hint. Treating a
    // placeholder identity as "not installed" is what made SOFTWARE claim no engines.
    const installed = isProfileBuilt(engine, meta.id);
    const engineMissing = !installed;

    // Downloading happens when the mode is missing, or when the pack is newer than what
    // is installed; either way the engine pack is the payload, plus the runtime if absent.
    const runtimeSizeBytes = runtimeMissing ? runtimePack?.size_bytes ?? 0 : 0;
    let sizeBytes = 0;
    if (engineMissing || update?.available) sizeBytes += update?.packSizeBytes ?? 0;
    if (runtimeMissing) sizeBytes += runtimePack?.size_bytes ?? 0;
    // Catalogue download size: the pack itself plus the runtime when it is not installed yet.
    const downloadSizeBytes = (update?.packSizeBytes ?? 0) + runtimeSizeBytes;

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
      sourceBuildDate: sources.find((s) => s.active)?.buildDate ?? null,
      state,
      installed,
      engineMissing,
      runtimeMissing,
      sizeBytes,
      updateAvailable: Boolean(update?.available),
      packAvailable: Boolean(update?.packAvailable),
      packVersion: realVersion(update?.latestVersion),
      downloadSizeBytes,
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
