import type { Env } from "../hooks/useBuildDock";

// ── Build Step Labels ────────────────────────────────────────────────
// Single source of truth for step-to-short-label mapping.
// Used by StatusBarContext.tsx (dock slot) and FoundryModal.tsx (modal display).
export const STEP_LABELS: Record<string, string> = {
  Initializing: "INIT",
  GitClone: "CLONE",
  GitPull: "PULL",
  PrCherryPick: "PR-MERGE",
  CMakeConfigure: "CONFIGURE",
  WaitingForConfirm: "WAIT-CONFIRM",
  Building: "BUILD",
  Validating: "VALIDATE",
  Complete: "DONE",
  Failed: "FAIL",
  BackupLocked: "LOCKED",
};

export function getStepLabel(step: string): string {
  return STEP_LABELS[step] ?? step;
}

// ── Environment Colors ───────────────────────────────────────────────
// Single source of truth for environment-specific Tailwind classes.
export interface EnvColorSet {
  border: string;
  text: string;
  bg: string;
  badgeBg: string;
  badgeBorder: string;
}

const ENV_COLORS_MAP: Record<Env, EnvColorSet> = {
  vanguard: {
    border: "border-cyan-400/60 text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/25",
    text: "text-cyan-400",
    bg: "bg-cyan-400/10 border-cyan-400/60",
    badgeBg: "bg-cyan-400/10",
    badgeBorder: "border-cyan-400/30",
  },
  fresh: {
    border: "border-amber-400/60 text-amber-400 bg-amber-400/10 hover:bg-amber-400/25",
    text: "text-amber-400",
    bg: "bg-amber-400/10 border-amber-400/60",
    badgeBg: "bg-amber-400/10",
    badgeBorder: "border-amber-400/30",
  },
  stable: {
    border: "border-nv-green/60 text-nv-green bg-nv-green/10 hover:bg-nv-green/25",
    text: "text-nv-green",
    bg: "bg-nv-green/10 border-nv-green/60",
    badgeBg: "bg-nv-green/10",
    badgeBorder: "border-nv-green/30",
  },
};

export function getEnvColors(env: Env): EnvColorSet {
  return ENV_COLORS_MAP[env];
}

// ── Environment Ordering ─────────────────────────────────────────────
// Single source of truth for environment iteration order.
export const ENV_ORDER: Env[] = ["vanguard", "fresh", "stable"];

// ── Environment Metadata ─────────────────────────────────────────────
// Combined metadata per environment (label, CUDA version, VS toolchain, color).
export interface EnvMeta {
  label: string;
  cuda: string;
  vs: string;
  color: Env;
}

export const ENV_META: Record<Env, EnvMeta> = {
  vanguard: { label: "VANGUARD", cuda: "13.2", vs: "VS Build Tools 2026 (v18)", color: "vanguard" },
  fresh:    { label: "FRESH",    cuda: "13.1", vs: "VS Build Tools 2022",        color: "fresh" },
  stable:   { label: "STABLE",   cuda: "12.8", vs: "VS Build Tools 2022",        color: "stable" },
};