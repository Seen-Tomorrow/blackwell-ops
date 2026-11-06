import { describe, expect, it } from "vitest";
import type { EngineConfig, GpuInfo, ModelMetadata } from "../../../lib/types";
import { evaluate } from "./evaluate";
import type { ForecastInput } from "./types";

/**
 * The resolver's rules, not its numbers.
 *
 * A point is only valid at the CTX it was measured at. Scaling a lone point is what made
 * every CTX read EXACT; the four states are the contract that keeps the label honest.
 */

const GIB = 1024;

function gpu(): GpuInfo {
  return {
    index: 0,
    name: "test gpu",
    memory_total: 98_304,
    memory_total_manufactured: 98_304,
    memory_used: 4_000,
    memory_free: 90_000,
    driver_model: "TCC",
  } as unknown as GpuInfo;
}

function input(over: Partial<ForecastInput>): ForecastInput {
  const engineConfig = {
    alias: "",
    model_path: "C:/models/test.gguf",
    port: 0,
    backend_type: "ggml-master",
    extra_params: { ctx: 65_536, split: "none", device: "GPU-0", kv_quant: "f16" },
  } as unknown as EngineConfig;
  return {
    modelMeta: {
      file_size_bytes: 20 * GIB ** 3,
      n_layer: 40,
      n_embd: 5120,
      n_head: 40,
      n_head_kv: 8,
      architecture: "test",
    } as unknown as ModelMetadata,
    engineConfig,
    gpus: [gpu()],
    runningSlots: [],
    ramAvailableGb: 64,
    ramManufacturedGb: 128,
    fullAutoMode: false,
    ...over,
  };
}

const launchPoint = (ctx: number, gb: number, hostGb = 1) => ({
  ctx,
  vramMib: gb * GIB,
  hostMib: hostGb * GIB,
});

describe("forecast resolver states", () => {
  it("EXACT: a launch measured at this CTX", () => {
    const m = evaluate(input({ learnedCurve: [launchPoint(65_536, 40)] }));
    expect(m?.memorySourceState).toBe("launch_exact");
    expect(m?.memorySource?.kind).toBe("learned");
    expect(m?.memorySource?.exact).toBe(true);
    expect(m?.vramTotalGb).toBeCloseTo(40, 1);
  });

  it("ESTIMATE: a lone launch is shown where it was measured, never scaled", () => {
    const m = evaluate(
      input({
        learnedCurve: [launchPoint(65_536, 40)],
        engineConfig: {
          ...input({}).engineConfig,
          extra_params: { ctx: 131_072, split: "none", device: "GPU-0" },
        },
      }),
    );
    expect(m?.memorySourceState).toBe("launch_other");
    expect(m?.memorySource?.kind).toBe("learned");
    expect(m?.memorySource?.exact).toBe(false);
    // The 64K figure, unchanged — not a ctx-scaled 80-ish number.
    expect(m?.vramTotalGb).toBeCloseTo(40, 1);
    expect(m?.memorySourceAnchorCtx).toBe(65_536);
  });

  it("CURVE: two launches define a line at any CTX", () => {
    const m = evaluate(
      input({
        learnedCurve: [launchPoint(65_536, 40), launchPoint(262_144, 60)],
        engineConfig: {
          ...input({}).engineConfig,
          extra_params: { ctx: 131_072, split: "none", device: "GPU-0" },
        },
      }),
    );
    expect(m?.memorySourceState).toBe("launch_curve");
    expect(m?.memorySource?.kind).toBe("learned_curve");
    expect(m?.learnedInterpolated).toBe(true);
    // Linear between 40 @64K and 60 @256K → 46.67 @128K.
    expect(m?.vramTotalGb).toBeCloseTo(46.67, 1);
  });

  it("MEASURED: a probe at this CTX", () => {
    const m = evaluate(
      input({
        fitProbeVramMib: 50 * GIB,
        fitProbeHostMib: 1024,
        fitProbeAnchorCtx: 65_536,
        fitProbeMode: "full",
        fitProbeMeasuredAt: "Nov 6, 12:00",
      }),
    );
    expect(m?.memorySourceState).toBe("probe_exact");
    expect(m?.memorySource?.kind).toBe("fit_probe");
    expect(m?.memorySource?.exact).toBe(true);
    expect(m?.vramTotalGb).toBeCloseTo(50, 1);
  });

  it("ESTIMATE: a probe is not applied at another CTX", () => {
    const m = evaluate(
      input({
        fitProbeVramMib: 50 * GIB,
        fitProbeAnchorCtx: 131_072,
        fitProbeMode: "full",
        fitProbeMeasuredAt: "Nov 6, 12:00",
      }),
    );
    expect(m?.memorySourceState).toBe("probe_other");
    expect(m?.memorySource?.kind).toBe("fit_probe");
    expect(m?.memorySource?.exact).toBe(false);
    expect(m?.vramTotalGb).toBeCloseTo(50, 1);
    expect(m?.memorySourceAnchorCtx).toBe(131_072);
  });

  it("a launch that spilled weights to host is not a need measurement", () => {
    const spilled = { ctx: 65_536, vramMib: 20 * GIB, hostMib: 60 * GIB };
    // Alone: it cannot paint an EXACT need, and there is nothing else to paint.
    expect(evaluate(input({ learnedCurve: [spilled] }))).toBeNull();
    // With a probe it still paints, but from the probe, and keeps the spill as history.
    const m = evaluate(
      input({
        learnedCurve: [spilled],
        learnedVramMib: 20 * GIB,
        learnedHostMib: 60 * GIB,
        learnedHostModelMib: 58 * GIB,
        learnedAnchorCtx: 65_536,
        learnedMeasuredAt: "2026-11-06T10:00:00Z",
        fitProbeVramMib: 72 * GIB,
        fitProbeAnchorCtx: 65_536,
        fitProbeMode: "full",
        fitProbeMeasuredAt: "Nov 6, 12:00",
      }),
    );
    expect(m?.memorySourceState).toBe("probe_exact");
    expect(m?.vramTotalGb).toBeCloseTo(72, 1);
    expect(m?.lastLaunchSpillGb).toBeCloseTo(58, 1);
  });

  it("a by-design host lookup table is not spill", () => {
    // 120 GB host row, all of it the model's Engram table: still a full-GPU launch point.
    const m = evaluate(
      input({
        modelEngramMib: 120 * GIB,
        learnedCurve: [{ ctx: 65_536, vramMib: 40 * GIB, hostMib: 121 * GIB }],
      }),
    );
    expect(m?.memorySourceState).toBe("launch_exact");
    expect(m?.lastLaunchSpillGb).toBeUndefined();
  });
});
