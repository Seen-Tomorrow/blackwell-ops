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
    // The number and the gate both carry the measured per-device runtime; pin it at 512 MiB.
    gpuCalibration: [{ index: 0, median_residual_mib: 512, samples: 1 }],
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
    expect(m?.vramTotalGb).toBeCloseTo(40.5, 1);
  });

  it("INCOMPLETE: a lone launch is scaled by its own measured KV", () => {
    // 40 GB @64K, 4 GB of it KV → +4 GB per +64K tokens → 44 GB @128K.
    const m = evaluate(
      input({
        learnedCurve: [{ ctx: 65_536, vramMib: 40 * GIB, hostMib: GIB, kvMib: 4 * GIB }],
        engineConfig: {
          ...input({}).engineConfig,
          extra_params: { ctx: 131_072, split: "none", device: "GPU-0" },
        },
      }),
    );
    expect(m?.memorySourceState).toBe("launch_other");
    expect(m?.memorySource?.kind).toBe("learned");
    expect(m?.memorySource?.exact).toBe(false);
    expect(m?.vramTotalGb).toBeCloseTo(44.5, 1);
    expect(m?.memorySourceAnchorCtx).toBe(65_536);
  });

  it("INCOMPLETE: falls back to header KV geometry when the row carries no KV", () => {
    // 40 blocks, 8 KV heads, head_dim 128, f16 → 0.15625 MiB per token.
    const m = evaluate(
      input({
        learnedCurve: [{ ctx: 65_536, vramMib: 40 * GIB, hostMib: GIB }],
        engineConfig: {
          ...input({}).engineConfig,
          extra_params: { ctx: 131_072, split: "none", device: "GPU-0" },
        },
      }),
    );
    expect(m?.vramTotalGb).toBeCloseTo(50.5, 1);
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
    expect(m?.vramTotalGb).toBeCloseTo(47.17, 1);
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
    expect(m?.vramTotalGb).toBeCloseTo(50.5, 1);
  });

  it("a probe is not painted at another CTX — there is no launch point to scale", () => {
    const m = evaluate(
      input({
        fitProbeVramMib: 50 * GIB,
        fitProbeComponentsMib: [
          { model_mib: 30 * GIB, ctx_mib: 8 * GIB, compute_mib: 12 * GIB },
        ],
        fitProbeAnchorCtx: 131_072,
        fitProbeMode: "full",
        fitProbeMeasuredAt: "Nov 6, 12:00",
      }),
    );
    expect(m).toBeNull();
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
    expect(m?.vramTotalGb).toBeCloseTo(72.5, 1);
    expect(m?.lastLaunchSpillGb).toBeCloseTo(58, 1);
  });

  it("INCOMPLETE CURVE: two probes give a line the KV slope cannot", () => {
    const m = evaluate(
      input({
        fitProbeCurve: [
          { ctx: 65_536, vramMib: 30 * GIB },
          { ctx: 196_608, vramMib: 60 * GIB },
        ],
        engineConfig: {
          ...input({}).engineConfig,
          extra_params: { ctx: 131_072, split: "none", device: "GPU-0" },
        },
      }),
    );
    expect(m?.memorySourceState).toBe("probe_curve");
    expect(m?.memorySource?.kind).toBe("fit_probe");
    expect(m?.memorySource?.exact).toBe(false);
    // 30 @64K → 60 @192K, so 45 @128K.
    expect(m?.vramTotalGb).toBeCloseTo(45.5, 1);
  });

  it("INCOMPLETE CURVE: a launch level anchored on a probe slope", () => {
    const m = evaluate(
      input({
        learnedCurve: [launchPoint(65_536, 40)],
        fitProbeCurve: [
          { ctx: 65_536, vramMib: 30 * GIB },
          { ctx: 196_608, vramMib: 60 * GIB },
        ],
        engineConfig: {
          ...input({}).engineConfig,
          extra_params: { ctx: 131_072, split: "none", device: "GPU-0" },
        },
      }),
    );
    expect(m?.memorySourceState).toBe("probe_anchored");
    // The launch measured 40 at 64K where the probe said 30; the +15 the probe predicts
    // by 128K is added to the measured level → 55, not 45.
    expect(m?.vramTotalGb).toBeCloseTo(55.5, 1);
  });

  it("a measured lookup table keeps a huge host row from reading as spill", () => {
    // DeepSeek-V4.1: 127 GB host, 125.9 GB of it the by-design Engram table. The header
    // size may be missing; the launch's own measurement must win.
    const m = evaluate(
      input({
        learnedCurve: [
          {
            ctx: 65_536,
            vramMib: 162_953,
            hostMib: 130_636,
            engramMib: 128_910,
          },
        ],
      }),
    );
    expect(m?.memorySourceState).toBe("launch_exact");
    expect(m?.lastLaunchSpillGb).toBeUndefined();
  });

  it("verdict FITS: one card holds the whole launch", () => {
    const m = evaluate(input({ learnedCurve: [launchPoint(65_536, 40)] }));
    expect(m?.fits).toBe(true);
    expect(m?.style.launchPaint).toBe("fit");
    expect(m?.style.uiTemplate.launchSummary).toBe("Fits — full on GPU");
  });

  it("verdict SPILL: over the card but inside VRAM+RAM", () => {
    // 95.5 GB on a 96 GB card with 87.9 free: over its headroom, far inside 151.9.
    const m = evaluate(input({ learnedCurve: [launchPoint(65_536, 95)] }));
    expect(m?.fits).toBe(true);
    expect(m?.style.launchPaint).toBe("offload");
    expect(m?.style.uiTemplate.launchSummary).toMatch(/^Fits with spill/);
  });

  it("verdict WON'T RUN: over VRAM plus RAM", () => {
    const m = evaluate(input({ learnedCurve: [launchPoint(65_536, 200)] }));
    expect(m?.fits).toBe(false);
    expect(m?.style.launchPaint).toBe("nofit");
    expect(m?.style.uiTemplate.launchSummary).toMatch(/^Won't run/);
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
