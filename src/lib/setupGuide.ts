/**
 * Setup wizard — pure phase machine and step-completion rules.
 *
 * Layering (top → bottom):
 * 1. **Phase** — derived from step flags below; never persisted.
 * 2. **Step flags** — pathsDone, runtimeDone from disk + session state.
 * 3. **Persistence** — localStorage caches (dismissed, welcome, defer);
 *    `app_config.setup_completed` is authority for “setup finished”.
 * 4. **Activation** — `useSetupGuide` decides whether the wizard is shown (recovery / wipe edge cases).
 *
 * Two decisions only: where the models are, and whether the portable CUDA
 * runtime is installed. Metadata probing and the VRAM fit scan are background
 * passes (`useLibrarySchedule`) — they no longer gate first contact, and the
 * NVIDIA driver result is a warning on the finish step, not a checkbox.
 *
 * While setup is active, header nav allows only OPERATIONS, MODEL HUB, and CONFIG.
 */

export type SetupPhase = "paths" | "runtime" | "finish";

/** Tabs usable during first-run setup (wizard + paths + download models). */
const SETUP_ALLOWED_TABS = ["catalog", "modelhub", "config"] as const;

export function isSetupNavTabAllowed(tab: string): boolean {
  return (SETUP_ALLOWED_TABS as readonly string[]).includes(tab);
}

/**
 * The catalog is the authority for “library linked” — never the config alone.
 *
 * A configured folder can hold `.gguf` files the catalog refuses (draft-only
 * weights, incomplete shards, every file filtered out). Counting those as done
 * sent the user past the wizard into an OPERATIONS pane with nothing selectable,
 * so the step completes only when `list_models` actually returns a model — or the
 * user explicitly chose to download later.
 */
export function computePathsDone(opts: {
  modelsDeferred: boolean;
  modelsCount: number;
}): boolean {
  return opts.modelsDeferred || opts.modelsCount > 0;
}

/** The seeded engine needs its CUDA runtime pack — no skip path. */
export function computeRuntimeDone(runtimeReady: boolean): boolean {
  return runtimeReady;
}

export function computeSetupPhase(opts: {
  pathsDone: boolean;
  runtimeDone: boolean;
}): SetupPhase {
  if (!opts.pathsDone) return "paths";
  if (!opts.runtimeDone) return "runtime";
  return "finish";
}

/** Runtime-pack download/extract in flight, or waiting for post-extract disk verify. */
export function computeRuntimeBusy(
  tasks: { status: string }[],
  runtimeReady: boolean,
): boolean {
  const active = tasks.some((t) =>
    ["queued", "downloading", "paused", "scanning"].includes(t.status),
  );
  const awaitingVerify = !runtimeReady && tasks.some((t) => t.status === "completed");
  return active || awaitingVerify;
}