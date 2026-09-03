import { describe, expect, it } from "vitest";
import type { UserEditedTemplateParam } from "./types";
import { specShareFields } from "./specProfiles";

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

const MTP_GROUP = "SPECULATIVE-MTP";
const DFLASH_GROUP = "SPECULATIVE-DFLASH";

const params: UserEditedTemplateParam[] = [
  knob("mtp_n_max", MTP_GROUP),
  knob("mtp_n_min", MTP_GROUP, { defaultValue: 1 }),
  knob("mtp_p_min", MTP_GROUP, { defaultValue: 0.5, values: [0.5] }),
  knob("dflash_n_max", DFLASH_GROUP),
  knob("dflash_n_min", DFLASH_GROUP, { defaultValue: 1 }),
  knob("dflash_p_min", DFLASH_GROUP, { defaultValue: 0.5, values: [0.5] }),
  knob("dflash_draft_model", DFLASH_GROUP, { values: ["auto"], defaultValue: "auto" }),
];

describe("specShareFields", () => {
  it("derives the MTP row from Boost + mtp_* knobs", () => {
    expect(
      specShareFields("mtp", { mtp_n_max: 4, mtp_n_min: 1 }, params),
    ).toEqual({ specType: "draft-mtp", nMax: 4, nMin: 1 });
  });

  it("derives DSpark from Boost with the shared DFlash knobs", () => {
    expect(
      specShareFields(
        "dspark",
        { dflash_n_max: 2, dflash_n_min: 1, dflash_draft_model: "C:\\m\\draft.gguf" },
        params,
      ),
    ).toEqual({ specType: "draft-dspark", nMax: 2, nMin: 1 });
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
});
