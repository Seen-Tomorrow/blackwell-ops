// ── Env Type ─────────────────────────────────────────────────────────
export type Env = "vanguard" | "frontier" | "stable" | "fresh";

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

/** UI + selection order (mirrors toolchain/manifest.json). */
export const ENV_ORDER: Env[] = ["frontier", "vanguard", "fresh", "stable"];

export interface EnvMeta {
  label: string;
  cuda: string;
  vs: string;
  color: Env;
  description?: string;
}

export const ENV_META: Record<Env, EnvMeta> = {
  vanguard: { label: "VANGUARD", cuda: "13.2", vs: "VS Build Tools 2026 (v18)", color: "vanguard", description: "Primary cutting-edge profile" },
  frontier: { label: "FRONTIER", cuda: "13.3", vs: "VS Build Tools 2026 (v18)", color: "frontier", description: "Experimental — newest CUDA" },
  fresh:    { label: "FRESH",    cuda: "13.1", vs: "VS Build Tools 2022",        color: "fresh",    description: "Recent stable CUDA on VS2022" },
  stable:   { label: "STABLE",   cuda: "12.8", vs: "VS Build Tools 2022",        color: "stable",   description: "Long-lived compatibility profile" },
};

/** Pinned GitHub release for the portable Foundry toolchain (manual download). */
export const TOOLCHAIN_RELEASE_TAG = "toolchain";
export const TOOLCHAIN_RELEASE_URL =
  "https://github.com/Seen-Tomorrow/blackwell-ops/releases/tag/toolchain";
export const TOOLCHAIN_ARCHIVE_PARTS = [
  "toolchain.7z.001",
  "toolchain.7z.002",
  "toolchain.7z.003",
] as const;