import { describe, expect, it } from "vitest";
import type { UserEditedTemplateParam } from "./types";
import { buildSpecCliExtraParams, specShareFields } from "./specProfiles";

/**
 * The share card's SPEC chip row is derived from Boost state, never from the legacy
 * `spec_type` / `spec_draft_n_*` bag keys (those are OBSOLETE_SPEC_PARAM_KEYS and are
 * stripped on load — reading them made the whole SPEC row silently disappear, leaving
 * a dead band under the ctx/batch chips).
 */

function knob(
  key: string,
  uiGroup: string,
  extra: Partial<UserEditedTemplateParam> = {},
): UserEditedTemplateParam {
  return {
    key,
    label: key,
    values: [1, 2, 4],
    order: 0,
    defaultValue: 4,
    ui_group: uiGroup,
    ...extra,
  };
}

const NGRAM_GROUP = "SPECULATIVE-NGRAM";
const MTP_GROUP = "SPECULATIVE-MTP";
const DFLASH_GROUP = "SPECULATIVE-DFLASH";

const params: UserEditedTemplateParam[] = [
  knob("ngram_n_match", NGRAM_GROUP, { defaultValue: 24, values: [12, 16, 24, 32] }),
  knob("ngram_n_min", NGRAM_GROUP, { defaultValue: 48, values: [8, 16, 24, 32, 48] }),
  knob("ngram_n_max", NGRAM_GROUP, { defaultValue: 64, values: [16, 24, 32, 48, 64] }),
  knob("mtp_n_max", MTP_GROUP),
  knob("mtp_n_min", MTP_GROUP, { defaultValue: 1 }),
  knob("mtp_p_min", MTP_GROUP, { defaultValue: 0.5, values: [0.5] }),
  knob("dflash_n_max", DFLASH_GROUP),
  knob("dflash_n_min", DFLASH_GROUP, { defaultValue: 1 }),
  knob("dflash_p_min", DFLASH_GROUP, { defaultValue: 0.5, values: [0.5] }),
  knob("dflash_sampling", DFLASH_GROUP, { defaultValue: "greedy", values: ["greedy", "probabilistic"] }),
  knob("dflash_draft_model", DFLASH_GROUP, { values: ["auto"], defaultValue: "auto" }),
];

describe("specShareFields", () => {
  it("emits ngram-mod with its n_match / n_min / n_max knobs for NGRAM boost", () => {
    expect(
      buildSpecCliExtraParams("ngram", { ngram_n_match: 16, ngram_n_min: 16, ngram_n_max: 32 }, params),
    ).toEqual({
      spec_type: "ngram-mod",
      ngram_n_match: 16,
      ngram_n_min: 16,
      ngram_n_max: 32,
    });
    expect(specShareFields("ngram", { ngram_n_min: 16, ngram_n_max: 32 }, params)).toEqual({
      specType: "ngram-mod",
      nMin: 16,
      nMax: 32,
    });
  });

  it("derives the MTP row from Boost + mtp_* knobs", () => {
    expect(
      specShareFields("mtp", { mtp_n_max: 4, mtp_n_min: 1 }, params),
    ).toEqual({ specType: "draft-mtp", nMax: 4, nMin: 1 });
  });

  it("derives DSpark / DFlash2 / LiliCorr from DFlash Boost + detected variant", () => {
    expect(
      specShareFields(
        "dflash",
        { dflash_n_max: 2, dflash_n_min: 1, dflash_draft_model: "C:\\m\\draft.gguf" },
        params,
        "dspark",
      ),
    ).toEqual({ specType: "draft-dspark", nMax: 2, nMin: 1 });
    expect(
      specShareFields("dflash", { dflash_n_max: 4, dflash_n_min: 1 }, params, "dflash2"),
    ).toEqual({ specType: "draft-dflash2", nMax: 4, nMin: 1 });
    expect(
      specShareFields("dflash", { dflash_n_max: 4, dflash_n_min: 1 }, params, "lilicorr"),
    ).toEqual({ specType: "draft-lilicorr", nMax: 4, nMin: 1 });
  });

  it("falls back to template defaults for unset knobs (same as launch)", () => {
    expect(specShareFields("dflash", {}, params)).toEqual({
      specType: "draft-dflash",
      nMax: 4,
      nMin: 1,
    });
  });

  it("omits knobs hidden in Config — the CLI never receives them", () => {
    const withHidden = params.map((p) =>
      p.key === "mtp_n_min" ? { ...p, userHidden: true } : p,
    );
    expect(specShareFields("mtp", { mtp_n_max: 2, mtp_n_min: 1 }, withHidden)).toEqual({
      specType: "draft-mtp",
      nMax: 2,
    });
  });

  it("prints nothing when Boost is off, even with legacy keys left in the bag", () => {
    expect(
      specShareFields("off", { spec_type: "ngram", spec_draft_n_max: 8 }, params),
    ).toEqual({});
  });

  it("emits dflash_sampling only for dflash2 and omits dflash_p_min when probabilistic", () => {
    const prob = buildSpecCliExtraParams(
      "dflash",
      { dflash_sampling: "probabilistic", dflash_p_min: 0.25 },
      params,
      "dflash2",
    );
    expect(prob).toMatchObject({ spec_type: "draft-dflash2", dflash_sampling: "probabilistic" });
    expect(prob).not.toHaveProperty("dflash_p_min");

    const greedy = buildSpecCliExtraParams(
      "dflash",
      { dflash_sampling: "greedy", dflash_p_min: 0.25 },
      params,
      "dflash2",
    );
    expect(greedy).toMatchObject({ dflash_sampling: "greedy", dflash_p_min: 0.25 });

    expect(
      buildSpecCliExtraParams("dflash", { dflash_sampling: "probabilistic" }, params, "dspark"),
    ).not.toHaveProperty("dflash_sampling");
    expect(
      buildSpecCliExtraParams("dflash", { dflash_sampling: "probabilistic" }, params, "dflash"),
    ).not.toHaveProperty("dflash_sampling");
    expect(
      buildSpecCliExtraParams("dflash", { dflash_sampling: "probabilistic" }, params, "lilicorr"),
    ).not.toHaveProperty("dflash_sampling");
  });
});
