// ── Env Type ─────────────────────────────────────────────────────────
export type Env = "edge" | "stable";

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

const ALL_BUILD_PHASES: readonly BuildPhase[] = [
  "Initializing", "GitClone", "GitPull", "PrCherryPick", "Configuring",
  "WaitingForConfirm", "Building", "Validating", "Complete", "Failed", "BackupLocked",
] as const;

// ── Build Step Labels ────────────────────────────────────────────────
const STEP_LABELS: Record<BuildPhase, string> = {
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

const MAPPED_STEP_LABELS: Record<string, string> = {
  init: "INIT",
  initializing: "INIT",
  clone: "CLONE",
  pull: "PULL",
  prcherrypick: "PR-MERGE",
  "pr-cherry-pick": "PR-MERGE",
  configuring: "CONFIGURE",
  "waiting-confirm": "WAIT-CONFIRM",
  building: "BUILD",
  validating: "VALIDATE",
  complete: "DONE",
  error: "FAIL",
  "backup-locked": "LOCKED",
};

export function getStepLabel(step: string): string {
  return STEP_LABELS[step as BuildPhase] ?? MAPPED_STEP_LABELS[step] ?? step.toUpperCase();
}

const PHASE_STEP_MAP: Record<string, string> = {
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

function getStepFromPhase(phase: string): string {
  return PHASE_STEP_MAP[phase] ?? phase.toUpperCase();
}

// ── Environment styling — unified accent (no per-profile color coding) ───
interface EnvColorSet {
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

function getEnvColors(_env: Env): EnvColorSet {
  return UNIFIED_ENV_COLORS;
}

// ── Environment Ordering (mirrors toolchain/manifest.json) ───────────
/** Default runtime profile for new installs / no saved preference. */
export const DEFAULT_BINARY_PROFILE: Env = "edge";

/** Normalize a saved profile id. Anything unknown — including a retired id — falls
 *  back to the default. No aliasing: a stale preference is simply replaced. */
export function normalizeBinaryProfile(profile: string | null | undefined): Env {
  const key = (profile || DEFAULT_BINARY_PROFILE).toLowerCase();
  return key === "stable" ? "stable" : DEFAULT_BINARY_PROFILE;
}

/** UI + selection order (mirrors toolchain/manifest.json). */
export const ENV_ORDER: Env[] = ["edge", "stable"];

export interface EnvMeta {
  label: string;
  cuda: string;
  vs: string;
  color: Env;
  description?: string;
}

export const ENV_META: Record<Env, EnvMeta> = {
  edge:     { label: "EDGE",   cuda: "13.4", vs: "VS Build Tools 2026 (v18)", color: "edge",   description: "Bleeding-edge CUDA 13.4 — fastest path" },
  stable:   { label: "STABLE",   cuda: "12.8", vs: "VS Build Tools 2022",        color: "stable",   description: "Long-lived compatibility profile" },
};

/** Mirror of `BINARY_UPDATES_ENABLED` in `src-tauri/src/binary_update.rs`. */
export const BINARY_UPDATES_ENABLED = true;

/** Pinned GitHub release for the portable Foundry toolchain (manual download). */
const TOOLCHAIN_RELEASE_TAG = "toolchain";
export const TOOLCHAIN_RELEASE_URL =
  "https://github.com/Seen-Tomorrow/blackwell-ops/releases/tag/toolchain";
const TOOLCHAIN_ARCHIVE_NAME = "toolchain.7z" as const;
const TOOLCHAIN_ARCHIVE_PARTS = [TOOLCHAIN_ARCHIVE_NAME] as const;

/** Minimum NVIDIA driver *major* version required per CUDA version (from official release notes).
 *  See: CUDA Toolkit Release Notes "Table 2 CUDA Toolkit and Minimum Required Driver Version"
 *  + CUDA Compatibility guide. Newer drivers always work.
 *  edge (13.4) → prefer recent driver (R610+); 13.x floor 580.
 */
export const NVIDIA_DRIVERS_URL = "https://www.nvidia.com/en-us/drivers/";

const CUDA_MIN_DRIVER_MAJOR: Record<string, number> = {
  "13.4": 610,
  "13": 580,
  "12.8": 570,
  "12": 525,
};

export function getMinDriverMajorForCuda(cuda: string): number {
  const c = (cuda || "").trim();
  if (c.startsWith("13.4")) return 610;
  if (c.startsWith("13")) return 580;
  if (c.startsWith("12.8")) return 570;
  if (c.startsWith("12")) return 525;
  return 525;
}

/** Parse major from "610.47.23" style string. */
function parseDriverMajor(version: string | null | undefined): number | null {
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