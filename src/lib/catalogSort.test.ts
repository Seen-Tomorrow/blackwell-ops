import { describe, expect, it } from "vitest";

import {
  compareCatalogModels,
  SORT_FIRST_DIRECTION,
  type SortDirection,
  type SortField,
} from "./catalogSort";
import type { ModelEntry, ModelMetadata } from "./types";

function model(path: string, overrides: Partial<ModelEntry> = {}): ModelEntry {
  return {
    path,
    author: "author",
    name: path,
    quant: "Q4",
    size_str: "",
    vision: false,
    ...overrides,
  };
}

function order(models: ModelEntry[], field: SortField, direction: SortDirection): string[] {
  return [...models].sort((a, b) => compareCatalogModels(a, b, field, direction)).map((m) => m.path);
}

function scanned(path: string, fileCreated: number): ModelEntry {
  return model(path, {
    metadata: { file_created: fileCreated } as unknown as ModelMetadata,
  });
}

describe("compareCatalogModels — size", () => {
  it("ranks by bytes, so an MB label never outranks a GB label", () => {
    // The catalog renders sub-gigabyte packs as "754MB". Comparing the digits
    // alone put that model ahead of a 46 GB one — biggest-first must not.
    const models = [model("small", { size_str: "754MB" }), model("big", { size_str: "46.2GB" })];
    expect(order(models, "size_str", "desc")).toEqual(["big", "small"]);
    expect(order(models, "size_str", "asc")).toEqual(["small", "big"]);
  });

  it("puts a model with no readable size last in both directions", () => {
    const models = [
      model("unscanned", { size_str: "" }),
      model("small", { size_str: "999MB" }),
      model("big", { size_str: "1.0GB" }),
    ];
    expect(order(models, "size_str", "desc")).toEqual(["big", "small", "unscanned"]);
    expect(order(models, "size_str", "asc")).toEqual(["small", "big", "unscanned"]);
  });
});

describe("compareCatalogModels — date", () => {
  it("newest first for desc, oldest first for asc, unscanned last", () => {
    const models = [scanned("old", 100), model("unscanned"), scanned("new", 200)];
    expect(order(models, "date", "desc")).toEqual(["new", "old", "unscanned"]);
    expect(order(models, "date", "asc")).toEqual(["old", "new", "unscanned"]);
  });
});

describe("compareCatalogModels — text", () => {
  it("orders author A→Z on asc", () => {
    const models = [model("z", { author: "zeta" }), model("a", { author: "alpha" })];
    expect(order(models, "author", "asc")).toEqual(["a", "z"]);
  });
});

describe("SORT_FIRST_DIRECTION", () => {
  it("shows the useful end first: biggest and newest", () => {
    expect(SORT_FIRST_DIRECTION.size_str).toBe("desc");
    expect(SORT_FIRST_DIRECTION.date).toBe("desc");
  });
});
