import { describe, expect, it } from "vitest";
import type { CatalogSeatsState } from "./catalogQuickAccess";
import {
  aliasRole,
  bindingHasLoading,
  bindingReadyToOpen,
  deriveHarnessBinding,
} from "./harnessBinding";
import type { StackEntry } from "./types";

function eng(partial: Partial<StackEntry> & { port: number; idx?: number }): StackEntry {
  return {
    idx: partial.idx ?? 0,
    alias: partial.alias ?? "E0",
    model_name: partial.model_name ?? "m",
    port: partial.port,
    gpu: partial.gpu ?? "0",
    status: partial.status ?? "RUNNING",
    model_path: partial.model_path,
    parallel: partial.parallel ?? 1,
    vision: partial.vision,
    n_ctx: partial.n_ctx,
  };
}

describe("aliasRole", () => {
  it("matches BRAIN and WORKER prefixes", () => {
    expect(aliasRole("BRAIN")).toBe("brain");
    expect(aliasRole("BRAIN-2")).toBe("brain");
    expect(aliasRole("brain_x")).toBe("brain");
    expect(aliasRole("WORKER")).toBe("worker");
    expect(aliasRole("WORKER-1")).toBe("worker");
    expect(aliasRole("ENGINE-0")).toBe(null);
  });
});

describe("deriveHarnessBinding", () => {
  it("returns none when no live engines", () => {
    const b = deriveHarnessBinding([eng({ port: 1, status: "IDLE" as string })]);
    expect(b.mode).toBe("none");
  });

  it("solo from single live", () => {
    const e = eng({ port: 8080, idx: 0, alias: "Qwen" });
    const b = deriveHarnessBinding([e]);
    expect(b.mode).toBe("solo");
    expect(b.brain?.port).toBe(8080);
    expect(b.worker).toBeNull();
  });

  it("twin from BRAIN/WORKER aliases", () => {
    const brain = eng({ port: 8888, idx: 0, alias: "BRAIN" });
    const worker = eng({ port: 8889, idx: 1, alias: "WORKER" });
    const b = deriveHarnessBinding([worker, brain]);
    expect(b.mode).toBe("twin");
    expect(b.brain?.alias).toBe("BRAIN");
    expect(b.worker?.alias).toBe("WORKER");
  });

  it("twin from catalog paths", () => {
    const seats: CatalogSeatsState = {
      brain: { path: "C:/models/brain.gguf", updatedAt: 1 },
      worker: { path: "C:/models/worker.gguf", updatedAt: 1 },
    };
    const brain = eng({
      port: 1,
      idx: 0,
      alias: "E0",
      model_path: "C:\\models\\brain.gguf",
    });
    const worker = eng({
      port: 2,
      idx: 1,
      alias: "E1",
      model_path: "C:/models/worker.gguf",
    });
    const b = deriveHarnessBinding([brain, worker], seats);
    expect(b.mode).toBe("twin");
    expect(b.brain?.port).toBe(1);
    expect(b.worker?.port).toBe(2);
  });

  it("two untagged lives → slot-order twin", () => {
    const a = eng({ port: 1, idx: 0, alias: "A" });
    const b = eng({ port: 2, idx: 1, alias: "B" });
    const r = deriveHarnessBinding([b, a]);
    expect(r.mode).toBe("twin");
    expect(r.brain?.idx).toBe(0);
    expect(r.worker?.idx).toBe(1);
  });

  it("three untagged lives → none", () => {
    const r = deriveHarnessBinding([
      eng({ port: 1, idx: 0, alias: "A" }),
      eng({ port: 2, idx: 1, alias: "B" }),
      eng({ port: 3, idx: 2, alias: "C" }),
    ]);
    expect(r.mode).toBe("none");
  });

  it("alias uniquify BRAIN-2 still brain", () => {
    const r = deriveHarnessBinding([
      eng({ port: 1, idx: 0, alias: "BRAIN-2" }),
      eng({ port: 2, idx: 1, alias: "WORKER-3" }),
    ]);
    expect(r.mode).toBe("twin");
    expect(r.brain?.alias).toBe("BRAIN-2");
  });
});

describe("binding readiness", () => {
  it("loading dims / not ready", () => {
    const brain = eng({ port: 1, alias: "BRAIN", status: "LOADING" });
    const worker = eng({ port: 2, idx: 1, alias: "WORKER", status: "RUNNING" });
    const b = deriveHarnessBinding([brain, worker]);
    expect(bindingHasLoading(b)).toBe(true);
    expect(bindingReadyToOpen(b)).toBe(false);
  });

  it("both running ready", () => {
    const b = deriveHarnessBinding([
      eng({ port: 1, alias: "BRAIN" }),
      eng({ port: 2, idx: 1, alias: "WORKER" }),
    ]);
    expect(bindingHasLoading(b)).toBe(false);
    expect(bindingReadyToOpen(b)).toBe(true);
  });
});
