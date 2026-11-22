import { describe, expect, it } from "vitest";
import type { EngineConfig, GpuInfo, ModelMetadata } from "../../../lib/types";
import { fitProbeKey, learnedIdentityKey, liveEvalKey } from "../../../hooks/useScenarioEvaluator";
import { chooseSecondCtx } from "../../../lib/forecastCurveRun";
import { evaluate } from "./evaluate";
import { computeAutoMoeCacheGb } from "./adapters/ggml_master";
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

  it("the expert cache is part of the launch's VRAM need, not of host RAM", () => {
    const base = evaluate(input({ learnedVramMib: 4 * GIB, learnedHostMib: 32 * GIB }));
    const cached = evaluate(
      input({ learnedVramMib: 4 * GIB, learnedHostMib: 32 * GIB, moeCacheMib: 16 * GIB }),
    );
    expect(cached!.vramTotalGb - base!.vramTotalGb).toBeCloseTo(16, 1);
    expect(cached!.ramTotalGb).toBeCloseTo(base!.ramTotalGb, 1);
  });

  it("a deliberate CPU-expert launch is not discarded as a weight spill", () => {
    const row = {
      learnedVramMib: 4 * GIB,
      learnedHostMib: 32 * GIB,
      learnedHostModelMib: 32 * GIB,
    };
    const plain = evaluate(input(row));
    const experts = evaluate(input({ ...row, moeCpuExperts: true, moeCacheMib: 16 * GIB }));
    expect(plain?.memorySourceState).not.toBe("launch_exact");
    expect(experts?.memorySourceState).toBe("launch_exact");
    expect(experts?.vramTotalGb).toBeCloseTo(20.5, 1);
    expect(experts?.ramTotalGb).toBeGreaterThan(31);
  });

  it("a stale draft path with spec off adds nothing", () => {
    const m = evaluate(
      input({
        learnedVramMib: 20 * GIB,
        learnedHostMib: GIB,
        draftSizeMib: 2048,
        engineConfig: {
          ...input({}).engineConfig,
          extra_params: {
            ctx: 65_536,
            split: "none",
            device: "GPU-0",
            spec_type: "none",
            dflash_draft_model: "C:/models/draft.gguf",
          },
        },
      }),
    );
    expect(m?.vramTotalGb).toBeCloseTo(20.5, 1);
  });

  it("a learned row that excludes the draft gets the draft addon", () => {
    const withDraft = input({
      learnedVramMib: 40 * GIB,
      learnedHostMib: GIB,
      learnedSpecIncluded: false,
      draftSizeMib: 10 * GIB,
      engineConfig: {
        ...input({}).engineConfig,
        extra_params: {
          ctx: 65_536,
          split: "none",
          device: "GPU-0",
          spec_type: "draft-dflash",
          dflash_draft_model: "C:/models/draft.gguf",
        },
      },
    });
    const withoutDraft = evaluate({ ...withDraft, learnedSpecIncluded: true });
    // 10 GiB of draft + its measured overhead, not a confidence trick.
    expect(evaluate(withDraft)!.vramTotalGb).toBeGreaterThan(50);
    expect(withoutDraft!.vramTotalGb).toBeCloseTo(40.5, 1);
  });

  it("vision projector is charged to one card and disappears when off", () => {
    const base = {
      learnedVramMib: 20 * GIB,
      learnedHostMib: GIB,
      mmprojSizeMib: 888,
    };
    const off = evaluate(input({ ...base, visionOn: false }))!;
    const on = evaluate(input({ ...base, visionOn: true }))!;
    // 888 MiB on one card, not spread across the pool.
    expect(on.vramTotalGb - off.vramTotalGb).toBeCloseTo(888 / 1024, 2);
    expect(on.gpuAllocations[0].projectedLoadGb - off.gpuAllocations[0].projectedLoadGb)
      .toBeCloseTo(888 / 1024, 2);
  });

  it("a PLE lookup table is host need, not VRAM", () => {
    const m = evaluate(
      input({
        learnedVramMib: 80 * GIB,
        learnedHostMib: 0.9 * GIB,
        modelEngramMib: 27_466,
      }),
    )!;
    // The 27.4 GB PLE table is mapped on the host; it must not inflate the GPU bars or read
    // as a weight spill.
    expect(m.vramTotalGb).toBeCloseTo(80.5, 1);
    expect(m.ramTotalGb).toBeGreaterThan(27);
    expect(m.ramSpillGb).toBeCloseTo(0, 1);
  });

  it("draft host buffers are not a weight spill", () => {
    // A spec row has no host component breakdown; 5 GB of host buffers is normal, not a
    // reason to throw away the exact learned row and fall back to a base-only probe.
    const m = evaluate(
      input({
        learnedVramMib: 40 * GIB,
        learnedHostMib: 5 * GIB,
        learnedHostModelMib: undefined,
      }),
    );
    expect(m?.memorySourceState).toBe("launch_exact");
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

  it("a probe adds the vision projector; an anchored launch adds it once", () => {
    // 50 GB probe + 2 GB mmproj.
    const probe = evaluate(
      input({
        mmprojSizeMib: 2048,
        visionOn: true,
        fitProbeVramMib: 50 * GIB,
        fitProbeAnchorCtx: 65_536,

        fitProbeMeasuredAt: "Nov 6, 12:00",
      }),
    );
    expect(probe?.vramTotalGb).toBeCloseTo(52.5, 1);

    // Anchored: the learned launch level is engine-self and excludes the projector, so the
    // launch needs the same +2 GB exactly once (not once per source).
    const anchored = evaluate(
      input({
        mmprojSizeMib: 2048,
        visionOn: true,
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
    expect(anchored?.memorySourceState).toBe("probe_anchored");
    expect(anchored?.vramTotalGb).toBeCloseTo(57.5, 1);
  });

  it("a probe adds the external draft head on our side", () => {
    // 2 GB draft weights + max(0.4, 55%) overhead = 3.1 GB.
    const m = evaluate(
      input({
        draftSizeMib: 2048,
        engineConfig: {
          ...input({}).engineConfig,
          extra_params: {
            ctx: 65_536,
            split: "none",
            device: "GPU-0",
            spec_type: "draft-dflash",
            dflash_draft_model: "C:/models/draft.gguf",
          },
        },
        fitProbeVramMib: 50 * GIB,
        fitProbeAnchorCtx: 65_536,

        fitProbeMeasuredAt: "Nov 6, 12:00",
      }),
    );
    expect(m?.vramTotalGb).toBeCloseTo(53.6, 1);
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

  it("forecastCurve includes runtime overhead, vision, and expert cache, sorted ascending", () => {
    const m = evaluate(
      input({
        learnedCurve: [launchPoint(131_072, 20), launchPoint(32_768, 12)],
        mmprojSizeMib: 1024,
        visionOn: true,
        moeCpuExperts: true,
        moeCacheMib: 8 * GIB,
      }),
    )!;
    // 65,536 interpolated between 12 @32K and 20 @128K = 14.67 + 0.5 runtime + 1.0 vision + 8.0 cache = 24.17
    expect(m.forecastCurve?.map((p) => p.ctx)).toEqual([32_768, 65_536, 131_072]);
    const atLive = m.forecastCurve?.find((p) => p.ctx === 65_536);
    expect(atLive?.gb).toBeCloseTo(m.vramTotalGb, 2);
    expect(m.forecastCurve![0].gb).toBeCloseTo(12 + 0.5 + 1 + 8, 1);
  });

  it("reactive keys: cpu_moe invalidates probe/learned; moe_cache_mib invalidates liveEvalKey only", () => {
    const base = { backend_type: "ggml-master", kv_quant: "q8_0", split: "none", ctx: 65_536, cpu_moe: "off", moe_cache_auto: "off", moe_cache_mib: 0 };
    const cmoe0 = { ...base, cpu_moe: "on", moe_cache_mib: 0 };
    const cmoe8 = { ...base, cpu_moe: "on", moe_cache_mib: 8192 };

    expect(fitProbeKey(cmoe0, false)).not.toBe(fitProbeKey(base, false));
    expect(learnedIdentityKey(cmoe0, false)).not.toBe(learnedIdentityKey(base, false));

    expect(fitProbeKey(cmoe8, false)).toBe(fitProbeKey(cmoe0, false));
    expect(learnedIdentityKey(cmoe8, false)).toBe(learnedIdentityKey(cmoe0, false));
    expect(liveEvalKey(cmoe8, false)).not.toBe(liveEvalKey(cmoe0, false));
  });

  it("chooseSecondCtx picks furthest lower for >=32K and ~32K for <32K", () => {
    expect(chooseSecondCtx(65_536, [4096, 8192, 32_768, 65_536])).toBe(4096);
    expect(chooseSecondCtx(4096, [4096, 8192, 16_384, 32_768, 65_536])).toBe(32_768);
  });

  it("computeAutoMoeCacheGb sizes single and asymmetric multi-GPU caches safely", () => {
    // Single 16 GB GPU: 16 - 4 base - 1.0 headroom = 11.0 GB, snapped to 256 MiB, capped by hostExpertsGb
    const single = computeAutoMoeCacheGb({
      perGpuBaseGb: [4],
      gpuAvailableGb: [16],
      hostExpertsGb: 40,
      targetIdx: 0,
    });
    expect(single.totalCacheGb).toBeCloseTo(11.0, 1);

    // Asymmetric 16 GB + 96 GB with 0.5 / 0.5 split: tightest card (16 GB) caps total cache
    const multi = computeAutoMoeCacheGb({
      perGpuBaseGb: [2, 2],
      gpuAvailableGb: [16, 96],
      hostExpertsGb: 40,
      targetIdx: 0,
    });
    // 16 - 2 - 1.0 = 13.0 avail on GPU0 -> / 0.5 = 26.0 GB total (13.0 per card)
    expect(multi.totalCacheGb).toBeCloseTo(26.0, 1);
    expect(multi.perGpuCacheGb[0]).toBeCloseTo(13.0, 1);
    expect(multi.perGpuCacheGb[1]).toBeCloseTo(13.0, 1);
  });

  it("evaluate with moeCpuExperts + moeCacheAuto sizes cache and keeps CTX ribbon on base", () => {
    const m = evaluate(
      input({
        learnedCurve: [launchPoint(32_768, 4, 32), launchPoint(131_072, 8, 32)],
        moeCpuExperts: true,
        moeCacheAuto: true,
      }),
    )!;
    expect(m.moeOverdrive?.active).toBe(true);
    expect(m.moeOverdrive?.autoCache).toBe(true);
    expect(m.moeOverdrive?.cacheMib).toBeGreaterThan(0);
    expect(m.style.vramNeedTone).toBe("ok");
    expect(m.ramSpillGb).toBe(0);
    const atLive = m.forecastCurve?.find((p) => p.ctx === 65_536);
    expect(atLive?.gb).toBeCloseTo(m.moeOverdrive!.baseVramGb, 1);
  });
});
