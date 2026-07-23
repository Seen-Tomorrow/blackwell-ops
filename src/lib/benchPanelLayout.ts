import {
  buildBenchGpuTopoEntries,
  buildFusionShareGpuTopoEntries,
  type BenchGpuTopoEntry,
} from "./benchHwTopo";
import type { BenchSessionMode } from "./benchPortStore";
import { FORECAST_PHOSPHOR_HEIGHT_PX } from "./onboardingDisplay";
import type { GpuInfo } from "./types";

/** Vertical padding on `.bench-widget-panel` (p-1.5 × 2). */
export const BENCH_PANEL_PAD_Y = 12;
/** One TG/PP result grid row at text-xl (label + value + unit). */
export const BENCH_RESULT_ROW_PX = 42;
/** One stacked result band in RUN BOTH (label + 15px value + unit slot + ×N badge overhang). */
export const BENCH_RESULT_ROW_DUAL_PX = 40;
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
export const FUSION_BENCH_IDLE_SLACK_PX = 18;

/** Fixed hero row height (slots + TG + PP) — PP progress slot always reserved. */
export const FUSION_HERO_ROW_PX = 122;

/** Benchmark tray latch row (drawer lip control + open/stowed margins). */
export const FUSION_BENCH_TRAY_LATCH_PX = 28;

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
    && !opts.inlineActions
  );
}

/** Share PNG phosphor — dashboard chrome + max bench slot; no tray latch or in-panel GPU topo. */
export function computeFusionShareCapturePhosphorHeightPx(
  opts: Pick<BenchPanelLayoutOpts, "gpus" | "gpuMask"> = {},
): number {
  const slotH = computeFusionBenchSlotHeight({
    gpus: opts.gpus,
    gpuMask: opts.gpuMask,
    inlineActions: true,
  });
  return FUSION_DASHBOARD_TIGHT_CHROME_PX + slotH;
}

/** Share capture logo lockup in bottom-right bezel corner. */
export const FUSION_SHARE_BRAND_LOGO_PX = 30;

const SHARE_HW_CHIP_GAP_PX = 6;
const SHARE_HW_CHIP_ROW_H_PX = 11;
const SHARE_HW_CHIP_ROW_GAP_PX = 3;
const SHARE_HW_HEADLINE_H_PX = 8;
const SHARE_HW_HEADLINE_GAP_PX = 3;
const SHARE_HW_BAND_PAD_PX = 4;
/** Pre-aspect inner width estimate for first-pass row wrap. */
const SHARE_HW_BAND_EST_WIDTH_PX = 640;

function estimateShareHwChipWidthPx(entry: BenchGpuTopoEntry): number {
  const label = `${entry.count}× ${entry.label}`;
  const driver = entry.driverVersion ? ` drv ${entry.driverVersion}` : "";
  return Math.ceil((label.length + driver.length) * 5.4) + 11;
}

function estimateShareHwChipRows(entries: BenchGpuTopoEntry[], bandWidthPx: number): number {
  if (entries.length === 0) return 0;
  let rows = 1;
  let rowUsed = 0;
  for (const entry of entries) {
    const chipW = estimateShareHwChipWidthPx(entry);
    const gap = rowUsed > 0 ? SHARE_HW_CHIP_GAP_PX : 0;
    if (rowUsed > 0 && rowUsed + gap + chipW > bandWidthPx) {
      rows += 1;
      rowUsed = chipW;
    } else {
      rowUsed += gap + chipW;
    }
  }
  return rows;
}

/** GPU topo row below share bezel (brand lives in bezel corner). */
export function computeFusionShareHwBandHeightPx(
  gpus?: GpuInfo[],
  gpuMask?: string,
  hwTopo?: string,
  bandWidthPx = SHARE_HW_BAND_EST_WIDTH_PX,
): number {
  const entries = gpus ? buildFusionShareGpuTopoEntries(gpus, gpuMask) : [];
  if (entries.length === 0) {
    return hwTopo?.trim() ? SHARE_HW_HEADLINE_H_PX + SHARE_HW_BAND_PAD_PX : 0;
  }
  const rows = estimateShareHwChipRows(entries, bandWidthPx);
  const chipsH = rows * SHARE_HW_CHIP_ROW_H_PX + Math.max(0, rows - 1) * SHARE_HW_CHIP_ROW_GAP_PX;
  return SHARE_HW_HEADLINE_H_PX + SHARE_HW_HEADLINE_GAP_PX + chipsH + SHARE_HW_BAND_PAD_PX;
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

/** Results body inside the bench slot (fusion overlay docks share actions separately). */
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

const FUSION_BENCH_SLOT_STUB = {} as unknown;

/** Fusion overlay bench slot — max height across idle / running / results (no state jumps). */
export function computeFusionBenchSlotHeight(
  opts: Pick<BenchPanelLayoutOpts, "gpus" | "gpuMask" | "inlineActions">,
): number {
  const base: BenchPanelLayoutOpts = {
    showResults: false,
    tgRunning: false,
    ppRunning: false,
    sessionMode: "idle",
    tgResult: null,
    ppResult: null,
    inlineActions: opts.inlineActions ?? true,
    gpus: opts.gpus,
    gpuMask: opts.gpuMask,
  };
  const candidates: BenchPanelLayoutOpts[] = [
    base,
    { ...base, showResults: true, tgRunning: true },
    { ...base, showResults: true, ppRunning: true },
    { ...base, showResults: true, sessionMode: "tg", tgResult: FUSION_BENCH_SLOT_STUB, ppResult: null },
    { ...base, showResults: true, sessionMode: "pp", tgResult: null, ppResult: FUSION_BENCH_SLOT_STUB },
    {
      ...base,
      showResults: true,
      sessionMode: "both",
      tgResult: FUSION_BENCH_SLOT_STUB,
      ppResult: FUSION_BENCH_SLOT_STUB,
    },
  ];
  return Math.max(...candidates.map(computeBenchPanelHeight));
}

/** Fixed fusion phosphor height when bench tray is open — chrome + latch + max bench slot. */
export function computeFusionPhosphorFixedHeight(
  opts: Pick<BenchPanelLayoutOpts, "gpus" | "gpuMask" | "inlineActions">,
): number {
  return (
    FUSION_DASHBOARD_TIGHT_CHROME_PX
    + FUSION_BENCH_TRAY_LATCH_PX
    + computeFusionBenchSlotHeight(opts)
  );
}

/** Metrics-only phosphor — header + hero + tray latch (no bench slack). */
export function computeFusionPhosphorStowedHeight(): number {
  // +16px: room for bench latch fully visible (was only showing the top lip)
  return FUSION_DASHBOARD_TIGHT_CHROME_PX + FUSION_BENCH_TRAY_LATCH_PX + 16;
}

/** Fusion overlay phosphor height from tray open/closed. */
export function computeFusionPhosphorHeightForTray(
  benchTrayOpen: boolean,
  opts: Pick<BenchPanelLayoutOpts, "gpus" | "gpuMask" | "inlineActions">,
): number {
  if (!benchTrayOpen) return computeFusionPhosphorStowedHeight();
  return computeFusionPhosphorFixedHeight(opts);
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