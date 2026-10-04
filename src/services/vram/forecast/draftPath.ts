import type { ForecastInput } from "./types";
import { cfgStr } from "../shared";
import { normalizeDraftPath } from "../../../lib/spec/adapters";

/**
 * Whether this launch has an external draft/head configured.
 *
 * One definition for the whole forecast path. The template defaults `dflash_draft_model`
 * and `mtp_draft_model` to `"off"`, so a plain non-empty check reports a draft for every
 * baked-in MTP launch — which would add a phantom draft term to the forecast and key
 * learned VRAM as if a head were loaded.
 */
export function specDraftPathConfigured(input: ForecastInput): boolean {
  const cfg = input.engineConfig;
  return (
    normalizeDraftPath(cfg.extra_params?.dflash_draft_model) !== null
    || normalizeDraftPath(cfg.extra_params?.mtp_draft_model) !== null
    || normalizeDraftPath(cfg.extra_params?.spec_draft_model) !== null
  );
}
