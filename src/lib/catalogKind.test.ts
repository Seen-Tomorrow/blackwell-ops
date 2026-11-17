import { describe, expect, it } from "vitest";
import {
  isAttachmentModel,
  isLaunchableMain,
  matchesCatalogDraftFilter,
} from "./specDraft";
import type { ModelEntry } from "./types";

/**
 * Invariants for the catalog kind filter. The values it cycles are part of the
 * feature: MAIN lists launchable models, EXTRAS is a separate list (never these),
 * ALL shows everything.
 */
const row = (over: Partial<ModelEntry> = {}): ModelEntry => ({
  path: "C:/models/x.gguf",
  author: "unsloth",
  name: "x",
  quant: "Q4_K_M",
  size_str: "1.0 GB",
  vision: false,
  ...over,
});

describe("catalog kind filter", () => {
  it("keeps launchable models in MAIN", () => {
    const model = row();
    expect(isLaunchableMain(model)).toBe(true);
    expect(matchesCatalogDraftFilter(model, "main")).toBe(true);
    expect(matchesCatalogDraftFilter(model, "extras")).toBe(false);
    expect(matchesCatalogDraftFilter(model, "all")).toBe(true);
  });

  it("treats PLE/Engram tables and projectors as attachments", () => {
    for (const role of ["ple", "mmproj", "adapter"]) {
      const file = row({ fileRole: role });
      expect(isAttachmentModel(file)).toBe(true);
      expect(isLaunchableMain(file)).toBe(false);
      expect(matchesCatalogDraftFilter(file, "main")).toBe(false);
      expect(matchesCatalogDraftFilter(file, "all")).toBe(true);
    }
  });

  it("keeps external draft heads out of MAIN but visible in ALL", () => {
    const head = row({ draftRoleHint: "external_mtp" });
    expect(isLaunchableMain(head)).toBe(false);
    expect(matchesCatalogDraftFilter(head, "main")).toBe(false);
    expect(matchesCatalogDraftFilter(head, "all")).toBe(true);
    expect(isAttachmentModel(head)).toBe(false);
  });
});
