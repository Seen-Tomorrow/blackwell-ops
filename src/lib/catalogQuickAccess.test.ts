/**
 * The v4 store's job is to make an illegal endpoint set unrepresentable.
 * These are shape invariants, not a mirror of the implementation.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CATALOG_ENDPOINTS_MAX,
  CATALOG_SET_COUNT,
  clampSetIndex,
  loadCatalogEndpoints,
  putCatalogEndpoint,
  removeCatalogEndpoint,
  sanitizeCatalogStore,
  setCatalogActiveSet,
  type Endpoint,
} from "./catalogQuickAccess";

function ep(id: string, role: Endpoint["role"], path: string): Endpoint {
  return { id, role, path };
}

function rawStore(sets: unknown[], extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 4,
    pins: [],
    recents: [],
    activeSet: 0,
    sets,
    ...extra,
  };
}

describe("sanitizeCatalogStore", () => {
  it("degrades a malformed store to five empty sets", () => {
    for (const raw of [null, undefined, {}, "nope", { version: 3, sets: [] }]) {
      const s = sanitizeCatalogStore(raw);
      expect(s.sets).toHaveLength(CATALOG_SET_COUNT);
      expect(s.sets.every((set) => set.length === 0)).toBe(true);
      expect(s.activeSet).toBe(0);
    }
  });

  it("keeps only the first brain and turns the extra into a worker", () => {
    const s = sanitizeCatalogStore(
      rawStore([[ep("a", "brain", "C:/m/a.gguf"), ep("b", "brain", "C:/m/b.gguf")]]),
    );
    expect(s.sets[0].filter((e) => e.role === "brain")).toHaveLength(1);
    expect(s.sets[0]).toHaveLength(2);
    expect(s.sets[0][0].role).toBe("brain");
    expect(s.sets[0][1].role).toBe("worker");
  });

  it("drops duplicate paths and malformed entries instead of throwing", () => {
    const s = sanitizeCatalogStore(
      rawStore([
        [
          ep("a", "brain", "C:/m/a.gguf"),
          ep("b", "worker", "c:\\M\\A.GGUF"),
          { id: "", role: "worker", path: "C:/m/x.gguf" },
          { id: "c", role: "worker", path: "   " },
          null,
        ],
      ]),
    );
    expect(s.sets[0]).toHaveLength(1);
  });

  it("refuses a seventh endpoint", () => {
    const seven = Array.from({ length: CATALOG_ENDPOINTS_MAX + 1 }, (_, i) =>
      ep(`e${i}`, i === 0 ? "brain" : "worker", `C:/m/${i}.gguf`),
    );
    const s = sanitizeCatalogStore(rawStore([seven]));
    expect(s.sets[0]).toHaveLength(CATALOG_ENDPOINTS_MAX);
  });

  it("clamps activeSet and never returns a fifth-plus index", () => {
    expect(sanitizeCatalogStore(rawStore([], { activeSet: 9 })).activeSet).toBe(4);
    expect(sanitizeCatalogStore(rawStore([], { activeSet: -3 })).activeSet).toBe(0);
    expect(clampSetIndex(2.9)).toBe(2);
  });

  it("drops unknown fields", () => {
    const s = sanitizeCatalogStore(
      rawStore([[{ ...ep("a", "brain", "C:/a.gguf"), path2: "nope" }]], { comboIds: ["x"] }),
    );
    expect(Object.keys(s.sets[0][0]).sort()).toEqual(["id", "path", "role"]);
    expect("comboIds" in s).toBe(false);
  });
});

describe("endpoint writes", () => {
  beforeEach(() => {
    const mem = new Map<string, string>();
    vi.stubGlobal("localStorage", {
      getItem: (k: string): string | null => mem.get(k) ?? null,
      setItem: (k: string, v: string): void => {
        mem.set(k, v);
      },
      removeItem: (k: string): void => {
        mem.delete(k);
      },
      clear: (): void => {
        mem.clear();
      },
      key: (i: number): string | null => [...mem.keys()][i] ?? null,
      get length(): number {
        return mem.size;
      },
    });
  });

  it("assigning brain twice replaces the path and keeps one brain", () => {
    const first = putCatalogEndpoint(0, "brain", "C:/m/a.gguf");
    expect(first.ok).toBe(true);
    const second = putCatalogEndpoint(0, "brain", "C:/m/b.gguf");
    expect(second.ok).toBe(true);
    expect(second.endpoints).toHaveLength(1);
    expect(second.endpoints[0].path).toBe("C:/m/b.gguf");
  });

  it("a duplicate worker path is refused", () => {
    putCatalogEndpoint(0, "brain", "C:/m/a.gguf");
    const r = putCatalogEndpoint(0, "worker", "c:\\m\\A.GGUF");
    expect(r.ok).toBe(false);
    expect(r.reason).toBe("duplicate");
  });

  it("stops at the endpoint cap with a reason", () => {
    putCatalogEndpoint(0, "brain", "C:/m/brain.gguf");
    for (let i = 0; i < CATALOG_ENDPOINTS_MAX - 1; i++) {
      expect(putCatalogEndpoint(0, "worker", `C:/m/w${i}.gguf`).ok).toBe(true);
    }
    const refused = putCatalogEndpoint(0, "worker", "C:/m/one-too-many.gguf");
    expect(refused.ok).toBe(false);
    expect(refused.reason).toBe("limit");
    expect(loadCatalogEndpoints()).toHaveLength(CATALOG_ENDPOINTS_MAX);
  });

  it("removes by id and keeps the set's brain", () => {
    putCatalogEndpoint(0, "brain", "C:/m/brain.gguf");
    const added = putCatalogEndpoint(0, "worker", "C:/m/w.gguf");
    const worker = added.endpoints.find((e) => e.role === "worker")!;
    const left = removeCatalogEndpoint(0, worker.id);
    expect(left).toHaveLength(1);
    expect(left[0].role).toBe("brain");
  });

  it("switching sets reads back that set's endpoints", () => {
    putCatalogEndpoint(0, "brain", "C:/m/set0.gguf");
    setCatalogActiveSet(3);
    expect(loadCatalogEndpoints()).toHaveLength(0);
    putCatalogEndpoint(3, "brain", "C:/m/set3.gguf");
    expect(loadCatalogEndpoints()[0].path).toBe("C:/m/set3.gguf");
  });
});
