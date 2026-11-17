import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LaunchSeat } from "./launchPlan";
import {
  deleteEndpointBag,
  loadEndpointBag,
  pruneEndpointBags,
  saveEndpointBag,
} from "./endpointBags";
import { KEYS } from "./storage";

function seat(overrides: Partial<LaunchSeat> = {}): LaunchSeat {
  return {
    id: "ep-1",
    role: "brain",
    modelPath: "C:/models/brain.gguf",
    providerId: "ggml-master",
    policyId: "full_auto",
    paramOverrides: { ctx: 32768, parallel: 1, dflash_draft_model: "C:/d.gguf" },
    boostMethod: "dflash",
    portPolicy: { mode: "auto" },
    ...overrides,
  };
}

describe("endpoint bags", () => {
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

  it("round-trips the knobs and keeps the endpoint id out of the bag", () => {
    saveEndpointBag("ep-1", seat());
    const bag = loadEndpointBag("ep-1");
    expect(bag?.paramOverrides.ctx).toBe(32768);
    expect(bag?.paramOverrides.dflash_draft_model).toBe("C:/d.gguf");
    expect(bag?.boostMethod).toBe("dflash");
    expect(bag?.policyId).toBe("full_auto");
    expect(loadEndpointBag("missing")).toBeNull();
  });

  it("sanitizes a hand-edited bag instead of trusting it", () => {
    localStorage.setItem(
      KEYS.endpointBags,
      JSON.stringify({
        version: 1,
        bags: {
          "ep-1": {
            providerId: "",
            policyId: "nonsense",
            paramOverrides: { ctx: 1024, junk: { nested: true }, __x: 1 },
            portPolicy: { mode: "fixed", port: -4 },
          },
        },
      }),
    );
    const bag = loadEndpointBag("ep-1");
    expect(bag?.providerId).toBe("ggml-master");
    expect(bag?.policyId).toBe("full_auto");
    expect(bag?.paramOverrides).toEqual({ ctx: 1024 });
    expect(bag?.portPolicy).toEqual({ mode: "auto" });
  });

  it("drops the bag with its endpoint and prunes orphans", () => {
    saveEndpointBag("ep-1", seat());
    saveEndpointBag("ep-2", seat({ id: "ep-2", role: "worker" }));
    deleteEndpointBag("ep-1");
    expect(loadEndpointBag("ep-1")).toBeNull();
    pruneEndpointBags(["ep-2"]);
    expect(loadEndpointBag("ep-2")?.providerId).toBe("ggml-master");
  });

  it("ignores a store that is not version 1", () => {
    localStorage.setItem(KEYS.endpointBags, JSON.stringify({ version: 2, bags: {} }));
    expect(loadEndpointBag("ep-1")).toBeNull();
  });
});
