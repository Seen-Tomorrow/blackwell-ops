/**
 * Setup wizard — pure phase machine and step-completion rules.
 *
 * Layering (top → bottom):
 * 1. **Phase** — derived from step flags below; never persisted.
 * 2. **Step flags** — pathsDone, toolchainDone, metaDone from disk + session state.
 * 3. **Persistence** — localStorage caches (dismissed, welcome, defer, meta summary);
 *    `app_config.setup_completed` is authority for “setup finished”.
 * 4. **Activation** — `useSetupGuide` decides whether the wizard is shown (recovery / wipe edge cases).
 *
 * Portable CUDA toolchain is a hard requirement (no skip). FIT scan and driver
 * confirmation are optional UI sub-steps inside `fit-scan`; not separate phases.
 *
 * While setup is active, header nav allows only OPERATIONS, MODEL HUB, and CONFIG.
 */

export type SetupPhase = "paths" | "toolchain" | "scan-meta" | "fit-scan";

/** Tabs usable during first-run setup (wizard + paths + download models). */
export const SETUP_ALLOWED_TABS = ["catalog", "modelhub", "config"] as const;

export function isSetupNavTabAllowed(tab: string): boolean {
  return (SETUP_ALLOWED_TABS as readonly string[]).includes(tab);
}

export interface MetaScanSummary {
  scanned: number;
  failed: number;
  total: number;
}

export function computePathsDone(opts: {
  pathsConfigured: boolean;
  modelsDeferred: boolean;
  catalogLoaded: boolean;
  modelsCount: number;
}): boolean {
  return (
    opts.pathsConfigured
    || opts.modelsDeferred
    || (opts.catalogLoaded && opts.modelsCount > 0)
  );
}

/** Portable CUDA runtime is a hard requirement — no skip path. */
export function computeToolchainDone(runtimeReady: boolean): boolean {
  return runtimeReady;
}

/** Metadata scan is required when local models exist (powers VRAM forecast badges). */
export function computeMetaDone(opts: {
  modelsDeferred: boolean;
  modelsCount: number;
  scannedCount: number;
  metaScanSummary: MetaScanSummary | null;
}): boolean {
  if (opts.modelsDeferred || opts.modelsCount === 0) return true;
  if (opts.scannedCount >= opts.modelsCount) return true;
  if (!opts.metaScanSummary) return false;
  const processed = opts.metaScanSummary.scanned + opts.metaScanSummary.failed;
  return processed >= opts.metaScanSummary.total && opts.metaScanSummary.total >= opts.modelsCount;
}

export function computeSetupPhase(opts: {
  pathsDone: boolean;
  toolchainDone: boolean;
  modelsCount: number;
  modelsDeferred: boolean;
  metaDone: boolean;
}): SetupPhase {
  if (!opts.pathsDone) return "paths";
  if (!opts.toolchainDone) return "toolchain";
  if (opts.modelsCount > 0 && !opts.modelsDeferred && !opts.metaDone) return "scan-meta";
  return "fit-scan";
}

/** Toolchain download/extract in flight, or waiting for post-extract disk verify. */
export function computeToolchainBusy(
  tasks: { status: string }[],
  runtimeReady: boolean,
): boolean {
  const active = tasks.some((t) =>
    ["queued", "downloading", "paused", "scanning"].includes(t.status),
  );
  const awaitingVerify = !runtimeReady && tasks.some((t) => t.status === "completed");
  return active || awaitingVerify;
}