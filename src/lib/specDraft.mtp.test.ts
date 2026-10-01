import { describe, expect, it } from "vitest";
import {
  draftRoleBadge,
  draftRoleFromModel,
  isExternalDraftOnly,
  isLaunchableMain,
  signalContainsEmbeddedMtp,
  specCapabilitiesForMain,
} from "./specDraft";
import type { ModelEntry } from "./types";

const istaMtp = {
  path: String.raw`C:\models\ISTA-DASLab\Qwen3.8-27B-GSQ-RCO-GGUF\Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp.gguf`,
  name: "Qwen3.8-27B-GSQ-RCO",
  hfModelId: "ISTA-DASLab/Qwen3.8-27B-GSQ-RCO-GGUF",
} as ModelEntry;

describe("ISTA -mtp.gguf catalog classification", () => {
  it("classifies the suffix as a baked-in MTP main", () => {
    expect(signalContainsEmbeddedMtp(istaMtp.path)).toBe(true);
    expect(draftRoleFromModel(istaMtp)).toBe("mtp_embedded");
    expect(isExternalDraftOnly(istaMtp)).toBe(false);
    expect(isLaunchableMain(istaMtp)).toBe(true);
    expect(draftRoleBadge("mtp_embedded", istaMtp)).toBe("MTP");
    expect(specCapabilitiesForMain(istaMtp, [], "ggml-master")).toContain("mtp");
  });

  it("does not mark the non-mtp sibling in the same folder", () => {
    const plain = {
      ...istaMtp,
      path: istaMtp.path.replace("-mtp.gguf", ".gguf"),
    };
    expect(signalContainsEmbeddedMtp(plain.path)).toBe(false);
    expect(draftRoleFromModel(plain)).toBe("none");
    expect(specCapabilitiesForMain(plain, [], "ggml-master")).not.toContain("mtp");
  });

  it("keeps dot-mtp head exports external", () => {
    const head = {
      path: String.raw`C:\models\heads\qwen.mtp.gguf`,
      name: "qwen.mtp",
    } as ModelEntry;
    expect(draftRoleFromModel(head)).toBe("external_mtp");
    expect(isExternalDraftOnly(head)).toBe(true);
  });

  it("does not treat a mid-name MTP head filename as baked-in", () => {
    const head = {
      path: String.raw`C:\models\ddh0\DeepSeek-V4-Flash-GGUF\DeepSeek-V4-Flash-MTP-Q8_0.gguf`,
      name: "DeepSeek-V4-Flash-MTP-Q8_0",
      metadata: {
        architecture: "deepseek4",
        nextn_predict_layers: 1,
        vocab_size: 0,
        file_size_bytes: 4_734_696_224,
      },
    } as ModelEntry;
    expect(signalContainsEmbeddedMtp(head.path)).toBe(false);
    expect(draftRoleFromModel(head)).toBe("external_mtp");
  });
});
