import { describe, expect, it } from "vitest";
import {
  computeFusionShareExportLayout,
  computeFusionShareGlassFit,
  FUSION_SHARE_EXPORT_CARD_WIDTH,
  FUSION_SHARE_EXPORT_FRAME_PAD_BOTTOM,
  FUSION_SHARE_EXPORT_FRAME_PAD_TOP,
  FUSION_SHARE_EXPORT_FRAME_PAD_X,
  FUSION_SHARE_EXPORT_GAP,
  FUSION_SHARE_EXPORT_HEADER_HEIGHT,
} from "./fusionShareCapture";
import type { GpuInfo } from "./types";

/**
 * The card canvas is fixed and 16:9; the glass is measured and scaled to fit. These
 * guard the invariants that make the card self-correcting: content can never be too
 * tall or too wide for it, because the fit is computed from a measurement.
 */

function gpu(index: number): GpuInfo {
  return {
    index,
    name: "NVIDIA RTX PRO 6000 Blackwell Workstation Edition",
    memory_total: 100663296,
    memory_total_manufactured: 100663296,
    memory_used: 0,
    memory_free: 100663296,
    temperature_gpu: 40,
    temperature_hot_spot: null,
    temperature_memory: null,
    power_draw: 120,
    power_limit: 600,
    utilization_gpu: 0,
    utilization_memory: 0,
    driver_version: "610.47.23",
    driver_model: "WDDM",
  };
}

describe("computeFusionShareExportLayout", () => {
  it("is a fixed 16:9 canvas regardless of GPU count or HW band", () => {
    const plain = computeFusionShareExportLayout();
    const busy = computeFusionShareExportLayout({
      shareGpus: [gpu(0), gpu(1)],
      shareGpuMask: "0,1",
      hwTopo: "2x",
    });

    expect(plain.cardWidthPx).toBe(FUSION_SHARE_EXPORT_CARD_WIDTH);
    expect((plain.cardWidthPx * 9) / 16).toBeCloseTo(plain.cardHeightPx, 0);
    expect(busy.cardWidthPx).toBe(plain.cardWidthPx);
    expect(busy.cardHeightPx).toBe(plain.cardHeightPx);
  });

  it("stacks header + gap + frame to exactly the card height", () => {
    const layout = computeFusionShareExportLayout();
    expect(layout.headerHeightPx).toBe(FUSION_SHARE_EXPORT_HEADER_HEIGHT);
    expect(layout.headerHeightPx + FUSION_SHARE_EXPORT_GAP + layout.frameHeightPx).toBe(
      layout.cardHeightPx,
    );
    expect(layout.glassAreaWidthPx).toBe(
      FUSION_SHARE_EXPORT_CARD_WIDTH - FUSION_SHARE_EXPORT_FRAME_PAD_X * 2,
    );
    expect(layout.glassAreaHeightPx).toBe(
      layout.frameHeightPx
        - FUSION_SHARE_EXPORT_FRAME_PAD_TOP
        - FUSION_SHARE_EXPORT_FRAME_PAD_BOTTOM,
    );
  });
});

describe("computeFusionShareGlassFit", () => {
  const layout = computeFusionShareExportLayout();

  it("leaves a glass that already fits unscaled", () => {
    const fit = computeFusionShareGlassFit(layout, {
      widthPx: layout.glassAreaWidthPx,
      heightPx: 200,
    });
    expect(fit.scale).toBe(1);
    expect(fit.heightPx).toBe(200);
    expect(fit.widthPx).toBe(layout.glassAreaWidthPx);
  });

  it("shrinks a too-tall glass uniformly into the area (dual stack)", () => {
    const fit = computeFusionShareGlassFit(layout, {
      widthPx: layout.glassAreaWidthPx,
      heightPx: 600,
    });
    expect(fit.heightPx).toBeLessThanOrEqual(layout.glassAreaHeightPx);
    expect(fit.scale).toBeLessThan(1);
    expect(fit.heightPx / fit.widthPx).toBeCloseTo(
      600 / layout.glassAreaWidthPx,
      2,
    );
  });

  it("shrinks a clone that refused to reach the reference width", () => {
    const fit = computeFusionShareGlassFit(layout, { widthPx: 1400, heightPx: 300 });
    expect(fit.widthPx).toBeLessThanOrEqual(layout.glassAreaWidthPx);
    expect(fit.heightPx).toBeLessThanOrEqual(layout.glassAreaHeightPx);
  });
});
