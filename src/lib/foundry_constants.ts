// ── Env Type ─────────────────────────────────────────────────────────
export type Env = "frontier" | "stable";

// ── Build Phases (single source of truth) ────────────────────────────
// These match the phases emitted by the Rust backend (reactor_foundry.rs)
export type BuildPhase =
  | "Initializing"
  | "GitClone"
  | "GitPull"
  | "PrCherryPick"
  | "Configuring"
  | "WaitingForConfirm"
  | "Building"
  | "Validating"
  | "Complete"
  | "Failed"
  | "BackupLocked";

export const ALL_BUILD_PHASES: readonly BuildPhase[] = [
  "Initializing", "GitClone", "GitPull", "PrCherryPick", "Configuring",
  "WaitingForConfirm", "Building", "Validating", "Complete", "Failed", "BackupLocked",
] as const;

// ── Build Step Labels ────────────────────────────────────────────────
export const STEP_LABELS: Record<BuildPhase, string> = {
  Initializing: "INIT",
  GitClone: "CLONE",
  GitPull: "PULL",
  PrCherryPick: "PR-MERGE",
  Configuring: "CONFIGURE",
  WaitingForConfirm: "WAIT-CONFIRM",
  Building: "BUILD",
  Validating: "VALIDATE",
  Complete: "DONE",
  Failed: "FAIL",
  BackupLocked: "LOCKED",
};

export function getStepLabel(step: string): string {
  return STEP_LABELS[step as BuildPhase] ?? step;
}

export const PHASE_STEP_MAP: Record<string, string> = {
  init: "INIT",
  clone: "CLONE",
  pull: "PULL",
  merge: "PR-MERGE",
  configure: "CONFIGURE",
  confirm: "WAIT-CONFIRM",
  build: "BUILD",
  validate: "VALIDATE",
  done: "DONE",
  fail: "FAIL",
  locked: "LOCKED",
};

export function getStepFromPhase(phase: string): string {
  return PHASE_STEP_MAP[phase] ?? phase.toUpperCase();
}

// ── Environment styling — unified accent (no per-profile color coding) ───
export interface EnvColorSet {
  border: string;
  text: string;
  bg: string;
  badgeBg: string;
  badgeBorder: string;
}

const UNIFIED_ENV_COLORS: EnvColorSet = {
  border: "value-chip",
  text: "theme-accent-text",
  bg: "foundry-profile-row",
  badgeBg: "value-chip",
  badgeBorder: "value-chip",
};

export function getEnvColors(_env: Env): EnvColorSet {
  return UNIFIED_ENV_COLORS;
}

// ── Environment Ordering (mirrors toolchain/manifest.json) ───────────
/** Default runtime profile for new installs / no saved preference. */
export const DEFAULT_BINARY_PROFILE: Env = "frontier";

/** Retired profiles — migrated to frontier on load. */
export const RETIRED_ENVS = ["vanguard", "fresh"] as const;

/** Normalize saved profile id (vanguard/fresh → frontier). */
export function normalizeBinaryProfile(profile: string | null | undefined): Env {
  const key = (profile || DEFAULT_BINARY_PROFILE).toLowerCase();
  if (key === "stable") return "stable";
  if (RETIRED_ENVS.includes(key as (typeof RETIRED_ENVS)[number])) return "frontier";
  if (key === "frontier") return "frontier";
  return DEFAULT_BINARY_PROFILE;
}

/** UI + selection order (mirrors toolchain/manifest.json). */
export const ENV_ORDER: Env[] = ["frontier", "stable"];

export interface EnvMeta {
  label: string;
  cuda: string;
  vs: string;
  color: Env;
  description?: string;
}

export const ENV_META: Record<Env, EnvMeta> = {
  frontier: { label: "FRONTIER", cuda: "13.3", vs: "VS Build Tools 2026 (v18)", color: "frontier", description: "Bleeding-edge CUDA 13.3" },
  stable:   { label: "STABLE",   cuda: "12.8", vs: "VS Build Tools 2022",        color: "stable",   description: "Long-lived compatibility profile" },
};

/** Mirror of `BINARY_UPDATES_ENABLED` in `src-tauri/src/binary_update.rs`. */
export const BINARY_UPDATES_ENABLED = false;

/** Pinned GitHub release for the portable Foundry toolchain (manual download). */
export const TOOLCHAIN_RELEASE_TAG = "toolchain";
export const TOOLCHAIN_RELEASE_URL =
  "https://github.com/Seen-Tomorrow/blackwell-ops/releases/tag/toolchain";
export const TOOLCHAIN_ARCHIVE_NAME = "toolchain.7z" as const;
export const TOOLCHAIN_RUNTIME_ARCHIVE_NAME = "toolchain-runtime.7z" as const;
export const TOOLCHAIN_ARCHIVE_PARTS = [TOOLCHAIN_ARCHIVE_NAME] as const;

export type ToolchainPackId = "full" | "runtime";

/** Minimum NVIDIA driver *major* version required per CUDA version (from official release notes).
 *  See: CUDA Toolkit Release Notes "Table 2 CUDA Toolkit and Minimum Required Driver Version"
 *  + CUDA Compatibility guide. Newer drivers always work.
 *  frontier (13.3) → prefer recent driver (R610+); 13.x floor 580.
 */
export const CUDA_MIN_DRIVER_MAJOR: Record<string, number> = {
  "13.3": 610,
  "13": 580,
  "12.8": 570,
  "12": 525,
};

export function getMinDriverMajorForCuda(cuda: string): number {
  const c = (cuda || "").trim();
  if (c.startsWith("13.3")) return 610;
  if (c.startsWith("13")) return 580;
  if (c.startsWith("12.8")) return 570;
  if (c.startsWith("12")) return 525;
  return 525;
}

/** Parse major from "610.47.23" style string. */
export function parseDriverMajor(version: string | null | undefined): number | null {
  if (!version) return null;
  const m = version.trim().split(".")[0];
  const n = parseInt(m, 10);
  return Number.isFinite(n) ? n : null;
}

export function isDriverSufficientForProfile(
  driverVersion: string | null | undefined,
  cudaVersion: string,
): boolean {
  const major = parseDriverMajor(driverVersion);
  if (major == null) return false;
  return major >= getMinDriverMajorForCuda(cudaVersion);
}