/**
 * HW monitor readouts — pure derivations shared by the widgets.
 *
 * Every helper here is presentation-only: it formats or classifies a snapshot
 * that `scan_gpus` / `scan_cpu` already returned. Keeping the math out of the
 * components is what lets the compact density skip work it will not show
 * (clocks, PCIe) instead of computing it and hiding it with CSS.
 */

import type { CpuInfo, GpuInfo, SystemInfo } from "./types";

function pct(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

/* ── Session totals ─────────────────────────────────────────────── */

export interface HwTotalsReadout {
  powerW: number;
  powerLimitW: number;
  powerPct: number;
  vramUsedGb: number;
  vramTotalGb: number;
  vramPct: number;
  ramUsedGb: number;
  ramTotalGb: number;
  ramPct: number;
}

export function hwTotals(gpus: GpuInfo[], systemInfo: SystemInfo | null): HwTotalsReadout {
  let powerW = 0;
  let powerLimitW = 0;
  let vramUsedMib = 0;
  let vramTotalMib = 0;
  for (const gpu of gpus) {
    powerW += gpu.power_draw || 0;
    powerLimitW += gpu.power_limit || 0;
    vramUsedMib += gpu.memory_used || 0;
    vramTotalMib += gpu.memory_total_manufactured || gpu.memory_total || 0;
  }
  const ramTotalMib = systemInfo?.total_memory_manufactured_mib || systemInfo?.total_memory_mib || 0;
  const ramUsedMib = systemInfo ? systemInfo.total_memory_mib - systemInfo.available_memory_mib : 0;
  return {
    powerW,
    powerLimitW,
    powerPct: pct(powerW, powerLimitW),
    vramUsedGb: vramUsedMib / 1024,
    vramTotalGb: vramTotalMib / 1024,
    vramPct: pct(vramUsedMib, vramTotalMib),
    ramUsedGb: ramUsedMib / 1024,
    ramTotalGb: ramTotalMib / 1024,
    ramPct: pct(ramUsedMib, ramTotalMib),
  };
}

/* ── Bar / text tones (consumed as data-fill / data-tone) ─────────── */

export type FillLevel = "normal" | "high" | "critical";

/**
 * Quantize a 0-100 percentage to the bar's visual step (default 0.5 %).
 *
 * Meters are the only thing here that animates, and the tween restarts on every change of
 * the transform target. NVML power jitter (µW) and per-core usage wobble are far below one
 * pixel, but they still retargeted ~40 transitions per tick — the compositor never idled,
 * which showed up as 1→6→10 % iGPU spikes while the machine was idle. Snapping the target
 * to a visible step keeps real motion and stops invisible motion from costing anything.
 *
 * `stepPct` is the caller's pixel budget: a 20 px core bar can only show ~5 % per pixel.
 */
export function barStep(percent: number, stepPct = 0.5): number {
  const clamped = Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;
  const step = stepPct > 0 ? stepPct : 0.5;
  return Math.round(clamped / step) * step;
}

export function fillLevel(percent: number, high = 70, critical = 90): FillLevel {
  if (percent > critical) return "critical";
  if (percent > high) return "high";
  return "normal";
}

export function utilFill(kind: "gpu" | "mem", percent: number): string {
  const level = fillLevel(percent);
  return level === "normal" ? kind : `${kind}-${level}`;
}

export function powerFill(percent: number): string {
  const level = fillLevel(percent);
  return level === "normal" ? "power" : `power-${level}`;
}

export function cpuAvgFill(percent: number): string {
  const level = fillLevel(percent, 60, 85);
  return level === "normal" ? "cpu" : `cpu-${level}`;
}

export type TempTone = "cool" | "warm" | "hot";

export function tempTone(temp: number): TempTone {
  if (temp > 85) return "hot";
  if (temp > 70) return "warm";
  return "cool";
}

/* ── NVML throttle reasons ──────────────────────────────────────── */

/** `nvmlClocksThrottleReason_t` bits worth showing; idle/app-clock/reliability bits are noise. */
const THROTTLE_BITS: Array<[number, string]> = [
  [0x40, "HW THERMAL"],
  [0x20, "SW THERMAL"],
  [0x80, "PWR BRAKE"],
  [0x08, "HW SLOWDOWN"],
  [0x04, "PWR CAP"],
  [0x200, "BOARD LIMIT"],
];
const THROTTLE_HOT = 0x40 | 0x20 | 0x80 | 0x08;

export function throttleText(mask: number | undefined): string | null {
  if (mask == null) return null;
  const labels = THROTTLE_BITS.filter(([bit]) => (mask & bit) !== 0).map(([, label]) => label);
  return labels.length > 0 ? labels.join(" · ") : null;
}

export function throttleHot(mask: number | undefined): boolean {
  return ((mask ?? 0) & THROTTLE_HOT) !== 0;
}

/* ── PCIe ───────────────────────────────────────────────────────── */

/** MiB/s -> the narrowest readable unit for the PCIe column. */
export function formatPcieRate(mib: number | undefined): string {
  if (mib == null || !Number.isFinite(mib)) return "—";
  if (mib >= 1024) return `${(mib / 1024).toFixed(2)} GB/s`;
  if (mib >= 10) return `${Math.round(mib)} MB/s`;
  return `${mib.toFixed(1)} MB/s`;
}

export interface PcieReadout {
  gen?: number;
  width?: number;
  /** Negotiated-now vs card capability, shown on hover. */
  title?: string;
  rx: string;
  tx: string;
  peakRx: string;
  peakTx: string;
}

export function pcieReadout(
  gpu: GpuInfo,
  peak: { rx: number; tx: number } | undefined,
): PcieReadout {
  // NVML's max width is the CARD's capability, not the slot's: an x8/x8 bifurcated
  // board still reports max 16. Show the negotiated width (what the link really runs).
  const gen = gpu.pcie_gen_max ?? gpu.pcie_gen;
  const width = gpu.pcie_width;
  const title =
    gpu.pcie_gen != null && gpu.pcie_gen_max != null
      ? `link now Gen${gpu.pcie_gen} x${gpu.pcie_width ?? "?"} · card max Gen${gpu.pcie_gen_max} x${gpu.pcie_width_max ?? "?"}`
      : undefined;
  return {
    gen,
    width,
    title,
    rx: formatPcieRate(gpu.pcie_rx_mib_per_s),
    tx: formatPcieRate(gpu.pcie_tx_mib_per_s),
    peakRx: formatPcieRate(peak?.rx),
    peakTx: formatPcieRate(peak?.tx),
  };
}

/* ── CPU clock / hero ───────────────────────────────────────────── */

/** Live MHz (PDH) first; base is WMI MaxClockSpeed (often sticky). */
export function formatCpuClock(cpu: CpuInfo): string {
  const cur = cpu.current_clock_mhz ?? 0;
  const base = cpu.max_clock_mhz ?? 0;
  if (cur > 0) return `${cur} MHz`;
  if (base > 0) return `${base} MHz`;
  return "— MHz";
}

export function cpuClockTitle(cpu: CpuInfo): string {
  const cur = cpu.current_clock_mhz ?? 0;
  const base = cpu.max_clock_mhz ?? 0;
  if (cur > 0 && base > 0) {
    return `Live ~${cur} MHz (PDH % performance × base) · base ${base} MHz`;
  }
  if (cur > 0) return `Live ~${cur} MHz`;
  if (base > 0) return `Base ${base} MHz (live PDH unavailable)`;
  return "CPU clock unavailable";
}
