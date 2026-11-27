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
 * DFlash2, DSpark and LiliCorr are NOT separate adapters or Boost stops: they share
 * SPECULATIVE-DFLASH's group and knobs and differ only in the `--spec-type` string
 * (`draft-dflash`, `draft-dflash2`, `draft-dspark`, `draft-lilicorr`), which is
 * auto-detected from the selected draft GGUF header (`ggufShape.dflashVariant`).
 */

import {
  SPEC_PROFILE_DFLASH_GROUP,
  SPEC_PROFILE_MTP_GROUP,
  SPEC_PROFILE_NGRAM_GROUP,
} from "../systemParams";
import type { SpecProfileGroup } from "../specProfiles";
import type { SpecBoostMethod } from "../specProfiles";
import type { DraftRole, SpecCapability } from "../specDraft";

export type { SpecBoostMethod };

export type SpecAdapterId = "ngram" | "mtp" | "dflash" | "eagle3";

/** Exact DFlash-family draft head variant (llama.cpp PR #32016). */
export type DflashVariant = "dflash" | "dflash2" | "dspark" | "lilicorr";

interface SpecKnobs {
  /** ngram-mod lookup prefix length; absent for draft-head methods. */
  nMatch?: string;
  nMax: string;
  nMin: string;
  /** Minimum probability threshold; absent for ngram-mod. */
  pMin?: string;
  /** DFlash2 draft sampling mode; absent for methods that do not use it. */
  sampling?: string;
  /** Absent ⇒ the method is baked-in/zero-draft and never takes an external draft path. */
  draftModel?: string;
}

export interface SpecAdapter {
  id: SpecAdapterId;
  /** `--spec-type` value for the default variant. */
  cliType: string;
  /** Badge text. */
  label: string;
  /** Template group that owns this method's knobs, or null for zero-knob methods like ngram-mod. */
  group: SpecProfileGroup | null;
  /** Capability this method satisfies, or null when universal (works on every model). */
  capability: SpecCapability | null;
  knobs: SpecKnobs | null;
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

const NGRAM: SpecAdapter = {
  id: "ngram",
  cliType: "ngram-mod",
  label: "NGRAM",
  group: SPEC_PROFILE_NGRAM_GROUP,
  capability: null,
  knobs: { nMatch: "ngram_n_match", nMin: "ngram_n_min", nMax: "ngram_n_max" },
  draftRoles: [],
  memory: { learnedIncludesDraft: () => true },
};

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
    sampling: "dflash_sampling",
    draftModel: "dflash_draft_model",
  },
  // external_mtp stays listed: an MTP head is a valid external draft for the DFlash
  // lane too (draftRolesMatch), even though the MTP adapter now has its own lane.
  draftRoles: ["external_dflash", "external_mtp"],
  variants: {
    dflash2: "draft-dflash2",
    dspark: "draft-dspark",
    lilicorr: "draft-lilicorr",
  },
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
  ngram: NGRAM,
  mtp: MTP,
  dflash: DFLASH,
  eagle3: EAGLE3,
};

const ALL: readonly SpecAdapter[] = [NGRAM, MTP, DFLASH, EAGLE3];

/**
 * Resolve a Boost selection to an adapter. `off` resolves to nothing.
 */
export function adapterForMethod(
  method: SpecBoostMethod | SpecAdapterId | "off",
): SpecAdapter | null {
  if (method === "off") return null;
  return SPEC_ADAPTERS[method as SpecAdapterId] ?? null;
}

/**
 * The `--spec-type` a selection emits.
 *
 * For `dflash`, pass the draft's detected `DflashVariant` (`dflash` / `dflash2` /
 * `dspark` / `lilicorr`) so launch and VRAM forecast emit the exact upstream CLI type.
 */
export function cliTypeForMethod(
  method: SpecBoostMethod | SpecAdapterId | "off",
  variant?: DflashVariant | string,
): string | null {
  const adapter = adapterForMethod(method);
  if (!adapter) return null;
  if (variant && adapter.variants?.[variant]) return adapter.variants[variant];
  return adapter.cliType;
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

/** Adapters whose capability a main model has, in Boost-chip order. */
function adaptersForCapabilities(
  capabilities: readonly SpecCapability[],
): SpecAdapter[] {
  return ALL.filter((a) => a.capability === null || capabilities.includes(a.capability));
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
