// One authoritative description of every Foundry build phase.
//
// The page, nav badge, progress bar and log all read this table. Add a phase here
// and every consumer follows; aliases absorb the backend's CamelCase phase names
// and older hyphenated spellings.
//
// Canonical `step` keys are the lowercase names the UI stores (`building`,
// `validating`, …) so existing step checks keep working.

export interface FoundryPhaseSpec {
  /** Canonical lowercase step key used across the UI. */
  step: string;
  /** Short uppercase label (`BUILD`, `CONFIGURE`, …). */
  label: string;
  /** Wall-clock share of the build this stage owns, as `[start, end]` bar percent. */
  band: readonly [number, number];
}

/**
 * Stage table. The BUILD band is deliberately wide: the compile is ~80 % of wall
 * clock, and a linear bar must give it most of the width or it sits frozen through
 * the only phase worth watching.
 */
const PHASES: Record<string, FoundryPhaseSpec> = {
  idle: { step: "idle", label: "READY", band: [0, 0] },
  init: { step: "init", label: "INIT", band: [0, 4] },
  clone: { step: "clone", label: "CLONE", band: [4, 10] },
  pull: { step: "pull", label: "PULL", band: [10, 14] },
  "pr-merge": { step: "pr-merge", label: "PR-MERGE", band: [14, 18] },
  configuring: { step: "configuring", label: "CONFIGURE", band: [18, 24] },
  "waiting-confirm": {
    step: "waiting-confirm",
    label: "WAIT-CONFIRM",
    band: [18, 24],
  },
  "backup-locked": {
    step: "backup-locked",
    label: "LOCKED",
    band: [18, 24],
  },
  building: { step: "building", label: "BUILD", band: [24, 96] },
  validating: { step: "validating", label: "VALIDATE", band: [96, 99] },
  complete: { step: "complete", label: "DONE", band: [100, 100] },
  error: { step: "error", label: "FAIL", band: [100, 100] },
};

const ALIASES: Record<string, string> = {
  idle: "idle",
  initializing: "init",
  init: "init",
  gitclone: "clone",
  clone: "clone",
  gitpull: "pull",
  pull: "pull",
  prcherrypick: "pr-merge",
  "pr-cherry-pick": "pr-merge",
  merge: "pr-merge",
  configuring: "configuring",
  configure: "configuring",
  waitingforconfirm: "waiting-confirm",
  "waiting-confirm": "waiting-confirm",
  confirm: "waiting-confirm",
  backuplocked: "backup-locked",
  "backup-locked": "backup-locked",
  locked: "backup-locked",
  building: "building",
  build: "building",
  validating: "validating",
  validate: "validating",
  complete: "complete",
  done: "complete",
  failed: "error",
  error: "error",
  fail: "error",
};

const FALLBACK = PHASES.idle;

function normalize(phase: string): string {
  return (phase || "").trim().toLowerCase();
}

/**
 * Canonical step key for a backend phase or a UI step.
 *
 * Empty input maps to `idle`. An unknown phase keeps its normalized key so the
 * label can still show it, while `phaseSpec` falls back to the idle spec.
 */
export function phaseKey(phase: string): string {
  const key = normalize(phase);
  if (!key) return "idle";
  return ALIASES[key] ?? key;
}

/** Spec for a phase; unknown phases use the pre-build spec. */
export function phaseSpec(phase: string): FoundryPhaseSpec {
  return PHASES[phaseKey(phase)] ?? FALLBACK;
}

/** Short uppercase label; unknown phases keep their own name rather than lying. */
export function phaseLabel(phase: string): string {
  const key = phaseKey(phase);
  return PHASES[key]?.label ?? (normalize(phase).toUpperCase() || FALLBACK.label);
}

export function phaseBand(phase: string): readonly [number, number] {
  return phaseSpec(phase).band;
}

/** Pre-build session (confirm form open, no `foundry_build` yet). */
export function isPreBuild(phase: string): boolean {
  return phaseKey(phase) === "idle";
}

/** Ninja's counter exists only while these stages run. */
export function isCompileStep(phase: string): boolean {
  const key = phaseKey(phase);
  return key === "building" || key === "validating";
}

export function isTerminalStep(phase: string): boolean {
  const key = phaseKey(phase);
  return key === "complete" || key === "error";
}
