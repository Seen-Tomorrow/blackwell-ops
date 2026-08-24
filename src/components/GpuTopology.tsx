import type { CSSProperties } from "react";
import type { ForecastNeedTone, GpuAllocation } from "../lib/types";
import { splitGpuTopoBarUsage } from "../services/vram/scenarios/scenarios_factory";
/** Visible row bank in forecast glass — extra rows scroll (wheel). */
export const GPU_TOPO_MAX_ROWS = 2;

interface GpuTopologyProps {
  gpuAllocations: GpuAllocation[];
  gpuBarColor: string;
  /** Free-pool NEED tone for projected load G (manufactured % stays uncolored). */
  needTone?: ForecastNeedTone;
  ramVisible: boolean;
  ramTotalGb: number;
  ramManufacturedGb: number;
  /** Per-GPU NVML used (MiB) while idle — session baseline before first engine launch. */
  gpuIdleBaselineMib?: Record<number, number>;
  selectedGpuIndices?: number[];
  onDeviceSelect?: (gpuIndex: number) => void;
  /** Cards per row (2 default, 3 for denser multi-GPU). */
  perRow?: 2 | 3;
  /**
   * Forecast phosphor mode: cards flex-fill remaining glass height
   * (slot-bank style). Density by visible bank; max 3 rows then scroll.
   */
  fill?: boolean;
}

const HATCH_PATTERN = `repeating-linear-gradient(-45deg, transparent, transparent 2px, rgba(0,0,0,0.35) 2px, rgba(0,0,0,0.35) 4px)`;

function formatExternalTooltip(systemReservedMib: number, foreignAppsMib: number): string {
  const parts: string[] = [];
  if (systemReservedMib >= 48) {
    parts.push(`System: ${(systemReservedMib / 1024).toFixed(1)} GB`);
  }
  if (foreignAppsMib >= 64) {
    parts.push(`External apps: ${(foreignAppsMib / 1024).toFixed(1)} GB`);
  }
  if (parts.length === 0) return "External: 0 GB";
  return parts.join(" | ");
}

/** Density tier — fat 1–2, med 3–4, dense 5+ (slot-bank style). */
export function gpuTopoDensity(count: number): "fat" | "med" | "dense" {
  // fat was too tall for 1-row Assisted phosphor; med is the default compact card.
  if (count <= 4) return "med";
  return "dense";
}

export default function GpuTopology({
  gpuAllocations,
  gpuBarColor,
  needTone = "ok",
  ramVisible,
  ramTotalGb,
  ramManufacturedGb,
  gpuIdleBaselineMib,
  selectedGpuIndices,
  onDeviceSelect,
  perRow = 2,
  fill = false,
}: GpuTopologyProps) {
  const total = gpuAllocations.length;
  /** 1 GPU → full-width single column (no half-empty 2-col row). */
  const cols = total <= 1 ? 1 : perRow === 3 ? 3 : 2;
  /** All cards render; scroll kicks in past max visible rows. */
  const bank = gpuAllocations;
  const n = bank.length;
  const rows = Math.max(1, Math.ceil(Math.max(n, 1) / cols));
  const visibleRows = Math.min(rows, fill ? GPU_TOPO_MAX_ROWS : rows);
  const densityCount = Math.min(n, visibleRows * cols);
  const density = gpuTopoDensity(Math.max(1, densityCount));
  const scroll = fill && rows > GPU_TOPO_MAX_ROWS;

  return (
    <div
      className={`gpu-topology-root${fill ? " gpu-topology-root--fill" : ""}`}
      data-gpu-per-row={cols}
      data-gpu-count={n}
      data-gpu-total={total}
      data-gpu-density={density}
      data-gpu-rows={rows}
      data-gpu-visible-rows={visibleRows}
      data-gpu-max-rows={fill ? Math.min(visibleRows, GPU_TOPO_MAX_ROWS) : undefined}
      data-gpu-scroll={scroll ? "1" : undefined}
      data-gpu-fill={fill ? "1" : undefined}
      style={
        fill
          ? ({
              // Geometry follows visible bank (1-row vs 2-row), not a fixed 2-row cqh split.
              ["--gpu-topo-max-rows" as string]: String(Math.max(1, Math.min(visibleRows, GPU_TOPO_MAX_ROWS))),
            } as CSSProperties)
          : undefined
      }
    >
      <div
        className="gpu-topology-grid"
        style={{
          gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
          gridTemplateRows:
            fill && !scroll
              ? visibleRows <= 1
                ? "minmax(0, 1fr)"
                : `repeat(${visibleRows}, minmax(0, 1fr))`
              : undefined,
        }}
      >
        {bank.map((alloc) => {
          const totalMib = alloc.vramManufacturedGb * 1024;
          const usedMib =
            (alloc.nvmlUsedGb ?? alloc.vramManufacturedGb - alloc.vramAvailableGb) * 1024;
          const projectedPct = totalMib > 0 ? (alloc.projectedLoadGb * 1024 / totalMib) * 100 : 0;

          const breakdownMib = alloc.runningEngines.reduce((sum, e) => sum + e.vramUsedMib, 0);
          const hasOurEngines = alloc.runningEngines.length > 0;
          const idleBaselineMib = gpuIdleBaselineMib?.[alloc.gpuIndex] ?? 0;
          const {
            engineBarMib,
            osOtherMib,
            attributedOverheadMib,
            breakdownUnderReports,
            systemReservedMib,
            foreignAppsMib,
          } = splitGpuTopoBarUsage(usedMib, breakdownMib, hasOurEngines, idleBaselineMib, alloc.gpuIndex);
          const enginePct = totalMib > 0 ? (engineBarMib / totalMib) * 100 : 0;
          const osPct = totalMib > 0 ? (osOtherMib / totalMib) * 100 : 0;

          const totalUsedMib = alloc.projectedLoadGb * 1024 + usedMib;
          const totalUsedPct = Math.min(totalMib > 0 ? (totalUsedMib / totalMib) * 100 : 0, 100);
          const liveFreeGb = Math.max(0, alloc.vramManufacturedGb - usedMib / 1024);
          // Engine hatch fill still needs a concrete color; readout uses CSS tokens.
          const barColorHex =
            gpuBarColor.includes("yellow")
              ? "var(--theme-telemetry-amber, #FBBF24)"
              : gpuBarColor.includes("telemetry-red") || gpuBarColor.includes("red-5")
                ? "var(--theme-telemetry-red, #EF4444)"
                : gpuBarColor.includes("red-6") || gpuBarColor.includes("red-7")
                  ? "#B91C1C"
                  : gpuBarColor.includes("orange")
                    ? "var(--theme-telemetry-amber, #FB923C)"
                    : gpuBarColor.includes("cyan")
                      ? "var(--theme-telemetry-cyan, #22D3EE)"
                      : gpuBarColor.includes("gray")
                        ? "#4B5563"
                        : "var(--display-face-gpu-readout, var(--theme-accent))";

          // Projected load G follows free-pool NEED tone; manufactured % is capacity context only.
          const existingOnlyPct = totalMib > 0 ? (usedMib / totalMib) * 100 : 0;
          const existingBarColor =
            existingOnlyPct > 95
              ? "var(--theme-telemetry-red, #ff3333)"
              : existingOnlyPct > 85
                ? "var(--theme-telemetry-amber, #FB923C)"
                : barColorHex;

          const isSelected = selectedGpuIndices?.includes(alloc.gpuIndex) ?? false;

          const overheadLabel = breakdownUnderReports ? "KV/runtime" : "CUDA/runtime";
          const externalDetail = formatExternalTooltip(systemReservedMib, foreignAppsMib);
          const tooltipText = hasOurEngines
            ? attributedOverheadMib >= 64
              ? `Engines: ${(engineBarMib / 1024).toFixed(1)} GB (${(breakdownMib / 1024).toFixed(1)} GB tracked + ${(attributedOverheadMib / 1024).toFixed(1)} GB ${overheadLabel}) | ${externalDetail}`
              : `Engines: ${(engineBarMib / 1024).toFixed(1)} GB | ${externalDetail}`
            : `Running engines: ${(breakdownMib / 1024).toFixed(1)} GB | ${externalDetail}`;

          return (
            <div
              key={alloc.gpuIndex}
              onClick={() => onDeviceSelect?.(alloc.gpuIndex)}
              className={`gpu-card gpu-card--rail gpu-card-enter${
                isSelected
                  ? " gpu-selected"
                  : onDeviceSelect
                    ? " cursor-pointer hover:border-stealth-muted/50"
                    : ""
              }`}
              title={tooltipText}
            >
              <div className="gpu-card__meta">
                <span className="gpu-card-name" title={alloc.name}>
                  {alloc.name}
                </span>
                <span className="gpu-card__readout">
                  <span
                    className={`gpu-card__stat gpu-card__bar-need gpu-card__bar-need--${needTone}`}
                    title="Projected new load on this GPU"
                  >
                    <span className="gpu-card__stat-lab">new</span>
                    {alloc.projectedLoadGb.toFixed(1)}G
                  </span>
                  <span
                    className="gpu-card__stat gpu-card__pct"
                    title={`After load: ${(usedMib / 1024 + alloc.projectedLoadGb).toFixed(1)} GB · live free ${liveFreeGb.toFixed(1)} GB`}
                  >
                    <span className="gpu-card__stat-lab">after</span>
                    {(usedMib / 1024 + alloc.projectedLoadGb).toFixed(1)}G
                    <span className="gpu-card__stat-pct">({totalUsedPct.toFixed(0)}%)</span>
                  </span>
                </span>
              </div>

              <div className="gpu-card__bar gpu-card__bar--3d">
                <div
                  style={{ width: `${Math.min(projectedPct, 100)}%` }}
                  className={`gpu-card__bar-fill gpu-card__bar-fill--bevel gpu-bar-fill ${gpuBarColor}`}
                />

                {osOtherMib > 0 && (
                  <div
                    style={{
                      width: `${Math.min(osPct, 100)}%`,
                      backgroundColor: "#585858",
                      backgroundImage: HATCH_PATTERN,
                    }}
                    className="gpu-card__bar-fill gpu-card__bar-fill--os gpu-card__bar-fill--bevel gpu-bar-fill"
                  />
                )}

                {engineBarMib > 0 && (
                  <div
                    style={{
                      width: `${Math.min(enginePct, 100)}%`,
                      right: `${osPct}%`,
                      backgroundColor: existingBarColor,
                      backgroundImage: HATCH_PATTERN,
                    }}
                    className="gpu-card__bar-fill gpu-card__bar-fill--engine gpu-card__bar-fill--bevel gpu-bar-fill"
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>


      {ramVisible && (
        <div className="pt-2 border-t border-stealth-border/20 gpu-ram-enter">
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[9px] font-mono text-theme-accent">SYSTEM RAM</span>
            <span className="text-[8px] font-mono text-stealth-muted/40">|</span>
            {ramManufacturedGb > 0 ? (
              <span className="text-[8px] font-mono text-theme-accent">
                {ramTotalGb.toFixed(0)} GB spill / {ramManufacturedGb.toFixed(0)} GB ({((ramTotalGb / ramManufacturedGb) * 100).toFixed(0)}%)
              </span>
            ) : (
              <span className="text-[8px] font-mono text-stealth-muted/60">
                RAM offload active — {ramTotalGb.toFixed(1)} GB in system memory
              </span>
            )}
          </div>

          <div
            style={{ backgroundColor: "rgb(20,20,20)" }}
            className="relative h-4 rounded-sm overflow-hidden border border-stealth-border/30"
          >
            <div
              style={{
                width: `${ramManufacturedGb > 0 ? Math.min((ramTotalGb / ramManufacturedGb) * 100, 100) : 0}%`,
              }}
              className="h-full rounded-sm bg-theme-accent gpu-bar-fill"
            />
          </div>

          <div className="flex justify-start mt-1">
            <span className="text-[8px] font-mono text-theme-accent">
              {ramTotalGb.toFixed(0)} GB will spill to RAM — expect slower inference
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
