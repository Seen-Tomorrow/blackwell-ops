import { describe, expect, it } from "vitest";
import type { StackEntry } from "./types";
import {
  buildSoloCombo,
  buildTwinCombo,
  captureSeatFromPanel,
  captureSeatFromStack,
  normalizeModelPath,
  orderSeatsForLaunch,
  resolveAgentsN,
  resolveComboApply,
  resolveSeatLaunchPort,
  sparseOverridesFromConfig,
} from "./launchPresets";

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
});

describe("resolveComboApply", () => {
  it("binds running seats by model path and launches the rest", () => {
    const brain = captureSeatFromPanel({
      model,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: { parallel: 1, ctx: 32768 },
      role: "brain",
    });
    const workerModel = { ...model, path: "C:\\models\\worker.gguf", name: "Worker" };
    const worker = captureSeatFromPanel({
      model: workerModel,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: { parallel: 8, ctx: 8192 },
      role: "worker",
    });
    const combo = buildTwinCombo({ name: "twin", brain, worker });

    const stack = [
      running({
        idx: 1,
        port: 8080,
        model_path: "C:/models/brain.gguf",
        alias: "BRAIN",
        parallel: 1,
      }),
    ];

    const plan = resolveComboApply({ combo, stack });
    expect(plan.errors).toEqual([]);
    expect(plan.bind).toHaveLength(1);
    expect(plan.bind[0]!.port).toBe(8080);
    expect(plan.bind[0]!.role).toBe("brain");
    expect(plan.launch).toHaveLength(1);
    expect(plan.launch[0]!.role).toBe("worker");
    expect(plan.agentsN).toBe(8);
  });

  it("agentsN prefers harness override", () => {
    const seat = captureSeatFromPanel({
      model,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: { parallel: 4 },
    });
    const combo = buildSoloCombo({
      name: "s",
      seat,
      harness: { tool: "pi", defaultMode: "solo", agentsOverride: 16 },
    });
    expect(resolveAgentsN(combo)).toBe(16);
  });

  it("errors when model missing from disk set", () => {
    const seat = captureSeatFromPanel({
      model,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: {},
    });
    const combo = buildSoloCombo({ name: "s", seat });
    const plan = resolveComboApply({
      combo,
      stack: [],
      availableModelPaths: ["C:/other/x.gguf"],
    });
    expect(plan.errors.length).toBeGreaterThan(0);
    expect(plan.launch).toHaveLength(0);
  });
});

describe("orderSeatsForLaunch", () => {
  it("sequences brain before worker when requested", () => {
    const brain = captureSeatFromPanel({
      model,
      providerId: "ggml-master",
      policyId: "full_auto",
      config: {},
      role: "brain",
    });
    const worker = captureSeatFromPanel({
      model: { ...model, path: "C:\\w.gguf" },
      providerId: "ggml-master",
      policyId: "full_auto",
      config: {},
      role: "worker",
    });
    const ordered = orderSeatsForLaunch([worker, brain], true);
    expect(ordered[0]!.role).toBe("brain");
    expect(ordered[1]!.role).toBe("worker");
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

describe("captureSeatFromStack", () => {
  it("merges panel when paths match", () => {
    const entry = running({
      port: 1,
      model_path: "C:/models/brain.gguf",
      parallel: 2,
      n_ctx: 4096,
    });
    const seat = captureSeatFromStack({
      entry,
      role: "brain",
      panelModelPath: "C:\\models\\brain.gguf",
      panelConfig: { parallel: 8, kv_quant: "q8_0" },
    });
    expect(normalizeModelPath(seat.modelPath)).toBe(normalizeModelPath(model.path));
    expect(seat.paramOverrides.parallel).toBe(8);
    expect(seat.paramOverrides.kv_quant).toBe("q8_0");
    expect(seat.paramOverrides.ctx).toBe(4096);
  });
});
