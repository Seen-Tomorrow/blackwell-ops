// ── Env Type ─────────────────────────────────────────────────────────
export type Env = "edge" | "stable";

// ── Build Phases (single source of truth) ────────────────────────────
// These match the phases emitted by the Rust backend (reactor_foundry.rs).
// Labels/bands live in `foundryPhases.ts`; this union only names them.
export type BuildPhase =
  | "Idle"
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

// ── Environment ordering (mirrors toolchain/manifest.json) ───────────
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
  stable:   { label: "STABLE",   cuda: "12.9", vs: "VS Build Tools 2022",        color: "stable",   description: "Long-lived compatibility profile" },
};

/** Mirror of `BINARY_UPDATES_ENABLED` in `src-tauri/src/binary_update.rs`. */
export const BINARY_UPDATES_ENABLED = true;

/** NVIDIA driver download landing page. */
export const NVIDIA_DRIVERS_URL = "https://www.nvidia.com/en-us/drivers/";

/** Minimum NVIDIA driver *major* version required per CUDA version (from official release notes).
 *  See: CUDA Toolkit Release Notes "Table 2 CUDA Toolkit and Minimum Required Driver Version"
 *  + CUDA Compatibility guide. Newer drivers always work.
 *  edge (13.4) → prefer recent driver (R610+); 13.x floor 580.
 */
export function getMinDriverMajorForCuda(cuda: string): number {
  const c = (cuda || "").trim();
  if (c.startsWith("13.4")) return 610;
  if (c.startsWith("13")) return 580;
  if (c.startsWith("12.9")) return 576;
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