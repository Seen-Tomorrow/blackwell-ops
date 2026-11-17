import { describe, expect, it } from "vitest";
import type { StackEntry } from "./types";
import {
  captureSeatFromPanel,
  normalizeModelPath,
  orderSeatsForLaunch,
  resolveLaunchPlan,
  resolveSeatLaunchPort,
  sparseOverridesFromConfig,
} from "./launchPlan";

const model = {
  path: "C:\\models\\brain.gguf",
  author: "a",
  name: "BrainModel",
  quant: "Q4",
  size_str: "10G",
  vision: false,
};

function running(partial: Partial<StackEntry> & { port: number; model_path: string }): StackEntry {
  return {
    idx: partial.idx ?? 0,
    alias: partial.alias ?? "E0",
    model_name: partial.model_name ?? "m",
    port: partial.port,
    gpu: "GPU-0",
    status: "RUNNING",
    model_path: partial.model_path,
    parallel: partial.parallel ?? 4,
    n_ctx: partial.n_ctx ?? 8192,
    provider_type: partial.provider_type ?? "ggml-master",
  };
}

describe("sparseOverridesFromConfig", () => {
  it("keeps cockpit keys only", () => {
    const o = sparseOverridesFromConfig({
      ctx: 32768,
      parallel: 8,
      __memory_mode: "full_auto",
      junk: { x: 1 },
    });
    expect(o.ctx).toBe(32768);
    expect(o.parallel).toBe(8);
    expect(o.__memory_mode).toBeUndefined();
  });

  it("captures device and boost/spec pack keys", () => {
    const o = sparseOverridesFromConfig({
      device: "GPU-1",
      dflash_draft_model: "C:\\models\\draft.gguf",
      mtp_n_max: 4,
      __noise: 1,
    });
    expect(o.device).toBe("GPU-1");
    expect(o.dflash_draft_model).toBe("C:\\models\\draft.gguf");
    expect(o.mtp_n_max).toBe(4);
    expect(o.__noise).toBeUndefined();
  });
});

describe("resolveLaunchPlan", () => {
  it("binds running endpoints by model path and launches the rest", () => {
    const brain = captureSeatFromPanel({
      model,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: { parallel: 1, ctx: 32768 },
      role: "brain",
    });
    const worker = captureSeatFromPanel({
      model: { ...model, path: "C:\\models\\worker.gguf", name: "Worker" },
      providerId: "ggml-master",
      policyId: "full_auto",
      config: {},
      role: "worker",
    });

    const plan = resolveLaunchPlan({
      seats: [brain, worker],
      stack: [
        running({
          idx: 1,
          port: 8080,
          model_path: "C:/models/brain.gguf",
          alias: "BRAIN",
          parallel: 1,
        }),
      ],
    });
    expect(plan.errors).toEqual([]);
    expect(plan.bind).toHaveLength(1);
    expect(plan.bind[0].port).toBe(8080);
    expect(plan.bind[0].role).toBe("brain");
    expect(plan.launch).toHaveLength(1);
    expect(plan.launch[0].role).toBe("worker");
  });

  it("errors when a model is missing from the library", () => {
    const seat = captureSeatFromPanel({
      model,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: {},
    });
    const plan = resolveLaunchPlan({
      seats: [seat],
      stack: [],
      availableModelPaths: ["C:/other/x.gguf"],
    });
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.launch).toHaveLength(0);
  });
});

describe("orderSeatsForLaunch", () => {
  it("puts brain before workers and keeps worker order", () => {
    const seat = (path: string, role: "brain" | "worker") =>
      captureSeatFromPanel({
        model: { ...model, path },
        providerId: "ggml-master",
        policyId: "full_auto",
        config: {},
        role,
      });
    const ordered = orderSeatsForLaunch([
      seat("C:\\w1.gguf", "worker"),
      seat("C:\\w2.gguf", "worker"),
      seat("C:\\b.gguf", "brain"),
    ]);
    expect(ordered.map((s) => s.role)).toEqual(["brain", "worker", "worker"]);
    expect(ordered[1].modelPath).toBe("C:\\w1.gguf");
    expect(ordered[2].modelPath).toBe("C:\\w2.gguf");
  });
});

describe("port policy", () => {
  it("auto → 0", () => {
    const seat = captureSeatFromPanel({
      model,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: {},
      portPolicy: { mode: "auto" },
    });
    expect(resolveSeatLaunchPort(seat)).toBe(0);
  });

  it("prefer/fixed use port", () => {
    const seat = captureSeatFromPanel({
      model,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: {},
      portPolicy: { mode: "fixed", port: 9090 },
    });
    expect(resolveSeatLaunchPort(seat)).toBe(9090);
  });
});

describe("captureSeatFromPanel", () => {
  it("keeps the model path and accepts a stable endpoint id", () => {
    const seat = captureSeatFromPanel({
      model,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: { ctx: 8192 },
      role: "brain",
      seatId: "endpoint-1",
    });
    expect(seat.id).toBe("endpoint-1");
    expect(normalizeModelPath(seat.modelPath)).toBe(normalizeModelPath(model.path));
    expect(seat.paramOverrides.ctx).toBe(8192);
  });
});
