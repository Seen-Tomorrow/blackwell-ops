import { buildBenchGpuTopoEntries } from "./benchHwTopo";
import type { BenchSessionMode } from "./benchPortStore";
import { FORECAST_PHOSPHOR_HEIGHT_PX } from "./onboardingDisplay";
import type { GpuInfo } from "./types";

/** Vertical padding on `.bench-widget-panel` (p-1.5 × 2). */
export const BENCH_PANEL_PAD_Y = 12;
/** One TG/PP result grid row at text-xl (label + value + unit). */
export const BENCH_RESULT_ROW_PX = 42;
/** One stacked result band in RUN BOTH (smaller dual typography). */
export const BENCH_RESULT_ROW_DUAL_PX = 32;
/** Vertical gap between TG and PP rows in RUN BOTH (gap-y-2.5). */
export const BENCH_DUAL_ROW_GAP_PX = 10;
/** Share + HIDE footer row. */
export const BENCH_SHARE_FOOTER_PX = 28;
/** Margin above GPU topo band (bench-hw-topo mt-2.5). */
export const BENCH_GPU_TOPO_GAP_PX = 10;
/** GPU topo band (headline + chip grid + driver line) — single grid row baseline. */
export const BENCH_GPU_TOPO_BODY_PX = 50;
/** Per extra GPU topo grid row (2 columns). */
export const BENCH_GPU_TOPO_ROW_PX = 14;
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

export type BenchPanelLayoutOpts = {
  showResults: boolean;
  tgRunning: boolean;
  ppRunning: boolean;
  sessionMode: BenchSessionMode;
  tgResult: unknown;
  ppResult: unknown;
  compact?: boolean;
  /** Engine stack card — compact controls + results + HIDE only (no share / GPU topo). */
  stackMode?: boolean;
  gpus?: GpuInfo[];
  gpuMask?: string;
  /** SHARE/HIDE in results grid — no separate footer row (fusion overlay). */
  inlineActions?: boolean;
};

function benchResultVisibility(opts: BenchPanelLayoutOpts) {
  const isAnyRunning = opts.tgRunning || opts.ppRunning;
  const showTgResults =
    (opts.sessionMode === "tg" || opts.sessionMode === "both") && Boolean(opts.tgResult) && !opts.tgRunning;
  const showPpResults =
    (opts.sessionMode === "pp" || opts.sessionMode === "both") && Boolean(opts.ppResult) && !opts.ppRunning;
  return { isAnyRunning, showTgResults, showPpResults, hasResults: showTgResults || showPpResults };
}

export function isDualBenchResults(opts: BenchPanelLayoutOpts): boolean {
  const { showTgResults, showPpResults } = benchResultVisibility(opts);
  return opts.sessionMode === "both" && showTgResults && showPpResults;
}

function benchResultRowHeightPx(opts: BenchPanelLayoutOpts): number {
  return opts.sessionMode === "both" ? BENCH_RESULT_ROW_DUAL_PX : BENCH_RESULT_ROW_PX;
}

function addBenchResultRowsHeight(
  height: number,
  opts: BenchPanelLayoutOpts,
  showTgResults: boolean,
  showPpResults: boolean,
): number {
  const rowPx = benchResultRowHeightPx(opts);
  if (showTgResults) height += rowPx;
  if (showPpResults) height += rowPx;
  if (isDualBenchResults(opts)) height += BENCH_DUAL_ROW_GAP_PX;
  return height;
}

/** GPU topo block height from entry count (2-column grid + headline). */
export function computeBenchGpuTopoHeightPx(gpus?: GpuInfo[], gpuMask?: string): number {
  const entries = gpus ? buildBenchGpuTopoEntries(gpus, gpuMask) : [];
  if (entries.length === 0) return 0;
  const gridRows = Math.ceil(entries.length / 2);
  const bodyPx = 8 + gridRows * BENCH_GPU_TOPO_ROW_PX;
  return BENCH_GPU_TOPO_GAP_PX + bodyPx;
}

export function shouldShowBenchGpuTopo(opts: BenchPanelLayoutOpts): boolean {
  const compact = opts.compact ?? false;
  const stackMode = opts.stackMode ?? false;
  const { isAnyRunning, hasResults } = benchResultVisibility(opts);
  const gpuTopoEntries =
    opts.gpus && hasResults && !isAnyRunning
      ? buildBenchGpuTopoEntries(opts.gpus, opts.gpuMask)
      : [];
  return (
    opts.showResults
    && hasResults
    && !isAnyRunning
    && gpuTopoEntries.length > 0
    && !compact
    && !stackMode
  );
}

/** Results-only body when SHARE/HIDE + GPU topo are docked outside BenchWidget. */
export function computeBenchWidgetBodyHeight(opts: BenchPanelLayoutOpts): number {
  const compact = opts.compact ?? false;
  const { isAnyRunning, showTgResults, showPpResults } = benchResultVisibility(opts);

  const idlePanelHeight = compact ? 70 : BENCH_IDLE_PANEL_PX;
  if (!opts.showResults && !isAnyRunning) return idlePanelHeight;

  if (compact) {
    if (!opts.showResults && isAnyRunning) return 52;
    const rows = (showTgResults ? 1 : 0) + (showPpResults ? 1 : 0);
    const compactRowPx = opts.sessionMode === "both" ? 22 : 28;
    let h = 8 + (isAnyRunning ? 16 : 0) + rows * compactRowPx;
    if (isDualBenchResults(opts)) h += BENCH_DUAL_ROW_GAP_PX;
    if (!opts.inlineActions && !isAnyRunning && rows > 0) h += 18;
    return h;
  }

  let height = BENCH_PANEL_PAD_Y;
  if (isAnyRunning) height += BENCH_RUNNING_ROW_PX;
  height = addBenchResultRowsHeight(height, opts, showTgResults, showPpResults);
  if (isAnyRunning) return Math.max(height, 56);
  return height;
}

/** Results + topo area inside the bench slot (footer docked separately in FusionOverlay). */
export function computeBenchContentHeight(
  opts: BenchPanelLayoutOpts,
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
  return FORECAST_PHOSPHOR_HEIGHT_PX + (benchPanelHeight - BENCH_IDLE_PANEL_PX);
}

/** Grow forecast phosphor only when the bench panel is taller than the idle control stack. */
export function computeBenchPhosphorExtra(opts: Parameters<typeof computeBenchPanelHeight>[0]): number {
  const panelH = computeBenchPanelHeight(opts);
  return Math.max(0, computeFusionPhosphorHeight(panelH) - FORECAST_PHOSPHOR_HEIGHT_PX);
}

export function computeBenchPanelHeight(opts: BenchPanelLayoutOpts): number {
  const compact = opts.compact ?? false;
  const { isAnyRunning, hasResults } = benchResultVisibility(opts);
  const showGpuTopo = shouldShowBenchGpuTopo(opts);

  if (compact) {
    if (!opts.showResults && !isAnyRunning) return 70;
    if (!opts.showResults && isAnyRunning) return 52;
    const rows =
      ((opts.sessionMode === "tg" || opts.sessionMode === "both") && Boolean(opts.tgResult) && !opts.tgRunning ? 1 : 0)
      + ((opts.sessionMode === "pp" || opts.sessionMode === "both") && Boolean(opts.ppResult) && !opts.ppRunning ? 1 : 0);
    const compactRowPx = opts.sessionMode === "both" ? 22 : 28;
    let h = 8 + (isAnyRunning ? 16 : 0) + rows * compactRowPx;
    if (isDualBenchResults(opts)) h += BENCH_DUAL_ROW_GAP_PX;
    if (showGpuTopo) h += computeBenchGpuTopoHeightPx(opts.gpus, opts.gpuMask);
    if (!opts.inlineActions && !isAnyRunning && hasResults) h += 18;
    return h;
  }

  let height = computeBenchWidgetBodyHeight(opts);
  if (showGpuTopo) height += computeBenchGpuTopoHeightPx(opts.gpus, opts.gpuMask);
  if (!opts.inlineActions && !isAnyRunning && hasResults) height += BENCH_SHARE_FOOTER_PX;
  return height;
}