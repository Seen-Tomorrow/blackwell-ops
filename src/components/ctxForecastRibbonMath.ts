/**
 * DEV CTX forecast ribbon — paint math only.
 * Isolated from ggml_master / evaluate(). Same free-pool gates as the VRAM bar.
 */

import {
  findMaxFittingCtx,
  interpolateGbAtCtx,
} from "../lib/sliderParamUtils";
import { FREE_POOL_OOM_CAUTION, FREE_POOL_OOM_WARN, freePoolHeadroomGb } from "../services/vram/shared";

export type RibbonTone = "ok" | "caution" | "warn" | "hot";

export type RibbonStop = {
  pct: number;
  ctx: number;
  gb: number;
  tone: RibbonTone;
};

export function ribbonToneAt(gb: number, freeGb: number): RibbonTone {
  if (!(freeGb > 0) || !(gb > 0)) return "ok";
  const headroom = freePoolHeadroomGb(freeGb);
  if (gb > freeGb - headroom) return "hot";
  const util = gb / freeGb;
  if (util > FREE_POOL_OOM_WARN) return "warn";
  if (util > FREE_POOL_OOM_CAUTION) return "caution";
  return "ok";
}

export function sampleRibbonStops(
  min: number,
  max: number,
  freeGb: number,
  curve: Array<{ ctx: number; gb: number }>,
  samples = 40,
): RibbonStop[] {
  if (!(max > min) || curve.length === 0 || !(freeGb > 0)) return [];
  const out: RibbonStop[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const ctx = min + t * (max - min);
    const gb = interpolateGbAtCtx(curve, ctx);
    if (gb == null) continue;
    out.push({
      pct: t * 100,
      ctx,
      gb,
      tone: ribbonToneAt(gb, freeGb),
    });
  }
  return out;
}

export function ribbonCssGradient(stops: RibbonStop[]): string {
  if (stops.length === 0) return "transparent";
  const color = (tone: RibbonTone): string => {
    switch (tone) {
      case "hot":
        return "var(--theme-telemetry-red, #ef4444)";
      case "warn":
        return "var(--theme-telemetry-amber, #fbbf24)";
      case "caution":
        return "#fcd34d";
      default:
        return "var(--theme-accent)";
    }
  };
  const parts = stops.map((s, i) => {
    const prev = i > 0 ? stops[i - 1] : s;
    const c = color(s.tone);
    if (i > 0 && prev.tone !== s.tone) {
      return `${color(prev.tone)} ${s.pct.toFixed(2)}%, ${c} ${s.pct.toFixed(2)}%`;
    }
    return `${c} ${s.pct.toFixed(2)}%`;
  });
  return `linear-gradient(90deg, ${parts.join(", ")})`;
}

export function ribbonTooltip(
  ctx: number,
  gb: number,
  freeGb: number,
  learnedMarks: number[],
): string {
  const exact = learnedMarks.some((m) => m === Math.round(ctx) || Math.abs(m - ctx) < 1);
  const tone = ribbonToneAt(gb, freeGb);
  const kind = exact ? "EXACT" : learnedMarks.length >= 2 ? "CURVE" : "ESTIMATE";
  const tok =
    ctx >= 1024 ? `${(ctx / 1024).toFixed(ctx >= 10240 ? 0 : 1)}k` : `${Math.round(ctx)}`;
  return `${tok} · ${gb.toFixed(1)}G · ${kind}${tone === "hot" ? " · OVER FREE" : ""}`;
}

export function ribbonFitsBoundary(
  min: number,
  max: number,
  step: number,
  freeGb: number,
  curve: Array<{ ctx: number; gb: number }>,
): number | null {
  return findMaxFittingCtx(min, max, step, freeGb, curve);
}
