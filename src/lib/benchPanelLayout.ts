import { buildBenchGpuTopoEntries } from "./benchHwTopo";
import type { BenchSessionMode } from "./benchPortStore";
import { FORECAST_PHOSPHOR_HEIGHT_PX } from "./onboardingDisplay";
import type { GpuInfo } from "./types";

/** Vertical padding on `.bench-widget-panel` (p-1.5 × 2). */
export const BENCH_PANEL_PAD_Y = 12;
/** One TG/PP result grid row at text-xl (label + value + unit). */
export const BENCH_RESULT_ROW_PX = 42;
/** Share + HIDE footer row. */
export const BENCH_SHARE_FOOTER_PX = 28;
/** Margin above GPU topo band (bench-hw-topo mt-2.5). */
export const BENCH_GPU_TOPO_GAP_PX = 10;
/** GPU topo band (headline + chip grid + driver line). */
export const BENCH_GPU_TOPO_BODY_PX = 50;
/** Full GPU topo block including gap above. */
export const BENCH_GPU_TOPO_PX = BENCH_GPU_TOPO_GAP_PX + BENCH_GPU_TOPO_BODY_PX;
/** In-flight status + STOP row. */
export const BENCH_RUNNING_ROW_PX = 20;
/** Idle control stack (4 × 18px rows). */
export const BENCH_IDLE_PANEL_PX = 84;
/** Extra phosphor height when bench results replace idle controls. */
export const BENCH_PHOSPHOR_EXTRA_PX = 64;
/**
 * Flex slack between the fusion hero row and idle bench controls in the base phosphor.
 * Omitted when bench results sit flush under the hero.
 */
export const FUSION_BENCH_IDLE_SLACK_PX = 46;

/**
 * Header + hero + dashboard padding when bench is flush under the hero (no flex spacer).
 * Includes ~14px headroom for 6vh hero clamp + micro-stats row.
 */
export const FUSION_DASHBOARD_TIGHT_CHROME_PX =
  FORECAST_PHOSPHOR_HEIGHT_PX - BENCH_IDLE_PANEL_PX - FUSION_BENCH_IDLE_SLACK_PX + 14;

/** Results + topo area inside the bench slot (footer docked separately in FusionOverlay). */
export function computeBenchContentHeight(
  opts: Parameters<typeof computeBenchPanelHeight>[0],
  shareFooterVisible: boolean,
): number {
  const total = computeBenchPanelHeight(opts);
  return shareFooterVisible ? Math.max(0, total - BENCH_SHARE_FOOTER_PX) : total;
}

export function isBenchPanelExpanded(panelHeight: number): boolean {
  return panelHeight > BENCH_IDLE_PANEL_PX;
}

/** Live forecast phosphor height for fusion overlay + bench panel state. */
export function computeFusionPhosphorHeight(benchPanelHeight: number): number {
  if (!isBenchPanelExpanded(benchPanelHeight)) return FORECAST_PHOSPHOR_HEIGHT_PX;
  return FUSION_DASHBOARD_TIGHT_CHROME_PX + benchPanelHeight;
}

/** Grow forecast phosphor only when the bench panel is taller than the idle control stack. */
export function computeBenchPhosphorExtra(opts: Parameters<typeof computeBenchPanelHeight>[0]): number {
  const panelH = computeBenchPanelHeight(opts);
  return Math.max(0, computeFusionPhosphorHeight(panelH) - FORECAST_PHOSPHOR_HEIGHT_PX);
}

export function computeBenchPanelHeight(opts: {
  showResults: boolean;
  tgRunning: boolean;
  ppRunning: boolean;
  sessionMode: BenchSessionMode;
  tgResult: unknown;
  ppResult: unknown;
  compact?: boolean;
  gpus?: GpuInfo[];
  gpuMask?: string;
}): number {
  const compact = opts.compact ?? false;
  const isAnyRunning = opts.tgRunning || opts.ppRunning;
  const idlePanelHeight = compact ? 70 : BENCH_IDLE_PANEL_PX;

  if (!opts.showResults && !isAnyRunning) return idlePanelHeight;

  const showTgResults =
    (opts.sessionMode === "tg" || opts.sessionMode === "both") && Boolean(opts.tgResult) && !opts.tgRunning;
  const showPpResults =
    (opts.sessionMode === "pp" || opts.sessionMode === "both") && Boolean(opts.ppResult) && !opts.ppRunning;
  const hasResults = showTgResults || showPpResults;

  const gpuTopoEntries =
    opts.gpus && hasResults && !isAnyRunning
      ? buildBenchGpuTopoEntries(opts.gpus, opts.gpuMask)
      : [];
  const showGpuTopo = hasResults && !isAnyRunning && gpuTopoEntries.length > 0 && !compact;

  if (compact) {
    if (!opts.showResults && isAnyRunning) return 52;
    const rows = (showTgResults ? 1 : 0) + (showPpResults ? 1 : 0);
    let h = 8 + (isAnyRunning ? 16 : 0) + rows * 28;
    if (showGpuTopo) h += 22;
    if (!isAnyRunning && hasResults) h += 18;
    return h;
  }

  let height = BENCH_PANEL_PAD_Y;
  if (isAnyRunning) height += BENCH_RUNNING_ROW_PX;
  if (showTgResults) height += BENCH_RESULT_ROW_PX;
  if (showPpResults) height += BENCH_RESULT_ROW_PX;
  if (showGpuTopo) height += BENCH_GPU_TOPO_PX;
  if (!isAnyRunning && hasResults) height += BENCH_SHARE_FOOTER_PX;

  return Math.max(height, isAnyRunning ? 56 : BENCH_IDLE_PANEL_PX);
}