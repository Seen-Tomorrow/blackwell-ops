/**
 * Spec adapter registry.
 *
 * One object per speculative-decoding method, so adding a method is one adapter file
 * plus one template group instead of an if-chain edited in six places. Mirrors the
 * pattern already shipped twice as `fusion/adapters/` and `fit_adapters/`.
 *
 * Two axes, kept separate on purpose:
 *   - `SpecBoostMethod` — what the Boost chips can select today.
 *   - `SpecAdapterId`   — what the registry can resolve. `eagle3` is here but not
 *     there: it has always had a role, a capability and a CLI type, and Boost has
 *     never been able to reach it (§1.3). Registering it is the fix; promoting it to
 *     a Boost method is a product decision, not this refactor.
 *
 * DSpark is deliberately NOT an adapter: it shares SPECULATIVE-DFLASH's group and
 * knobs and differs only in the `--spec-type` string, so it is a `variant` on the
 * DFlash adapter. A fifth near-copy file would make "adding a method = one file" false.
 */

import { SPEC_PROFILE_DFLASH_GROUP, SPEC_PROFILE_MTP_GROUP } from "../systemParams";
import type { SpecProfileGroup } from "../specProfiles";
import type { SpecBoostMethod } from "../specProfiles";
import type { DraftRole, SpecCapability } from "../specDraft";

export type { SpecBoostMethod, SpecCapability };

export type SpecAdapterId = "mtp" | "dflash" | "eagle3";

export interface SpecKnobs {
  nMax: string;
  nMin: string;
  pMin: string;
  /** Absent ⇒ the method is baked-in only and never takes an external draft path. */
  draftModel?: string;
}

export interface SpecAdapter {
  id: SpecAdapterId;
  /** `--spec-type` value for the default variant. */
  cliType: string;
  /** Badge text. */
  label: string;
  /** Template group that owns this method's knobs. */
  group: SpecProfileGroup;
  /** Capability this method satisfies. */
  capability: SpecCapability;
  knobs: SpecKnobs;
  /** Catalog draft roles this method can consume. */
  draftRoles: readonly DraftRole[];
  /**
   * Alternative `--spec-type` strings, keyed by the UI's speed selector. DSpark lives
   * here: same knobs and group, different CLI string.
   */
  variants?: Readonly<Record<string, string>>;
  /**
   * Whether `-np > 1` is refused. No adapter sets it: `draft-mtp` was excluded on
   * assumption and never measured. Re-add only against a measured engine failure.
   */
  blocksParallel?: boolean;
  memory: {
    /**
     * A learned launch snapshot already contains this method's own buffers, so the
     * forecast must not add the draft term on top. Baked-in MTP is always true —
     * its nextn layers load with the target. An external head is true only when a
     * draft path is configured: same CLI string, different footprint.
     */
    learnedIncludesDraft: (draftPathConfigured: boolean) => boolean;
  };
}

const MTP: SpecAdapter = {
  id: "mtp",
  cliType: "draft-mtp",
  label: "MTP",
  group: SPEC_PROFILE_MTP_GROUP,
  capability: "mtp",
  knobs: { nMax: "mtp_n_max", nMin: "mtp_n_min", pMin: "mtp_p_min", draftModel: "mtp_draft_model" },
  draftRoles: ["none", "external_mtp"],
  memory: { learnedIncludesDraft: () => true },
};

const DFLASH: SpecAdapter = {
  id: "dflash",
  cliType: "draft-dflash",
  label: "DFLASH",
  group: SPEC_PROFILE_DFLASH_GROUP,
  capability: "dflash",
  knobs: {
    nMax: "dflash_n_max",
    nMin: "dflash_n_min",
    pMin: "dflash_p_min",
    draftModel: "dflash_draft_model",
  },
  // external_mtp stays listed: an MTP head is a valid external draft for the DFlash
  // lane too (draftRolesMatch), even though the MTP adapter now has its own lane.
  draftRoles: ["external_dflash", "external_mtp"],
  variants: { dspark: "draft-dspark" },
  memory: { learnedIncludesDraft: (p) => p },
};

const EAGLE3: SpecAdapter = {
  id: "eagle3",
  cliType: "draft-eagle3",
  label: "EAGLE3",
  group: SPEC_PROFILE_DFLASH_GROUP,
  capability: "eagle3",
  knobs: {
    nMax: "dflash_n_max",
    nMin: "dflash_n_min",
    pMin: "dflash_p_min",
    draftModel: "dflash_draft_model",
  },
  draftRoles: ["external_eagle3"],
  memory: { learnedIncludesDraft: (p) => p },
};

/** Registry keyed by adapter id. */
export const SPEC_ADAPTERS: Readonly<Record<SpecAdapterId, SpecAdapter>> = {
  mtp: MTP,
  dflash: DFLASH,
  eagle3: EAGLE3,
};

const ALL: readonly SpecAdapter[] = [MTP, DFLASH, EAGLE3];

/**
 * Resolve a Boost selection to an adapter. `dspark` resolves to DFlash — its CLI
 * string comes from `variants`. `off` resolves to nothing.
 */
export function adapterForMethod(
  method: SpecBoostMethod | SpecAdapterId | "off",
): SpecAdapter | null {
  if (method === "off") return null;
  if (method === "dspark") return DFLASH;
  return SPEC_ADAPTERS[method as SpecAdapterId] ?? null;
}

/** The variant key a selection implies, if it is one. `dspark` → `"dspark"`. */
function variantKeyFor(method: SpecBoostMethod | SpecAdapterId): string | undefined {
  return method === "dspark" ? "dspark" : undefined;
}

/** Reverse lookup from a `--spec-type` string, variants included. */
export function adapterForCliType(cliType: string): SpecAdapter | null {
  const lower = cliType.trim().toLowerCase();
  for (const adapter of ALL) {
    if (adapter.cliType === lower) return adapter;
    if (adapter.variants && Object.values(adapter.variants).includes(lower)) {
      return adapter;
    }
  }
  return null;
}

/**
 * Resolve the adapter for an **actual launch**, not for the Boost chip.
 *
 * `draft-mtp` is one CLI string with two memory footprints: baked-in nextn layers
 * load with the target (no separate draft buffers in a launch snapshot), while an
 * external MTP head rides the draft path and its buffers are separate. The draft
 * path is the disambiguator, so with a path configured `draft-mtp` resolves to the
 * DFlash adapter — external-draft memory semantics, path-dependent — and without a
 * path it resolves to MTP. Every other string is a plain reverse lookup.
 */
export function resolveSpecAdapter(
  cliType: string | null | undefined,
  draftPathConfigured: boolean,
): SpecAdapter | null {
  if (cliType == null) return null;
  const lower = cliType.trim().toLowerCase();
  if (lower === MTP.cliType) return draftPathConfigured ? DFLASH : MTP;
  return adapterForCliType(lower);
}

/**
 * The `--spec-type` a selection emits.
 *
 * A variant's own id selects its own CLI string: `cliTypeForMethod("dspark")` is
 * `draft-dspark`, not the DFlash default. Callers pass only a method everywhere
 * (`EngineConfigPanel`, `specShareFields`, `catalogSeatLearnedMem`), and a wrong
 * string here would launch the engine with the wrong `--spec-type` and key the
 * learned-VRAM cache under the wrong method.
 */
export function cliTypeForMethod(
  method: SpecBoostMethod | SpecAdapterId | "off",
  variant?: string,
): string | null {
  const adapter = adapterForMethod(method);
  if (!adapter) return null;
  const key = variant ?? variantKeyFor(method as SpecBoostMethod | SpecAdapterId);
  if (key && adapter.variants?.[key]) return adapter.variants[key];
  return adapter.cliType;
}

/** Adapters whose capability a main model has, in Boost-chip order. */
export function adaptersForCapabilities(
  capabilities: readonly SpecCapability[],
): SpecAdapter[] {
  return ALL.filter((a) => capabilities.includes(a.capability));
}

/**
 * A configured draft path, or `null`.
 *
 * `off` and `none` are the template defaults, not paths. Treating them as set would make
 * baked-in MTP look like an external head everywhere the answer matters: the forecast
 * draft term, the learned-VRAM identity key, and launch validation.
 */
export function normalizeDraftPath(raw: unknown): string | null {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const lower = s.toLowerCase();
  if (lower === "off" || lower === "none") return null;
  return s;
}
