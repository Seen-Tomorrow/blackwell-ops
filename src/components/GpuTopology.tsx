import type { GpuAllocation } from "../lib/types";

interface GpuTopologyProps {
  gpuAllocations: GpuAllocation[];
  gpuBarColor: string;
  ramVisible: boolean;
  ramTotalGb: number;
  ramManufacturedGb: number;
  selectedGpuIndices?: number[];
  onDeviceSelect?: (gpuIndex: number) => void;
}

const HATCH_PATTERN = `repeating-linear-gradient(-45deg, transparent, transparent 2px, rgba(0,0,0,0.35) 2px, rgba(0,0,0,0.35) 4px)`;

export default function GpuTopology({ gpuAllocations, gpuBarColor, ramVisible, ramTotalGb, ramManufacturedGb, selectedGpuIndices, onDeviceSelect }: GpuTopologyProps) {
  return (
    <div className="space-y-2 gpu-topology-root">
      {/* GPU Grid — 2 per row */}
      <div className={`grid gap-2 ${gpuAllocations.length === 1 ? 'max-w-[48%]' : 'grid-cols-2'}`}>
        {gpuAllocations.map((alloc) => {
          const totalMib = alloc.vramManufacturedGb * 1024;
          const usedMib = (alloc.vramManufacturedGb - alloc.vramAvailableGb) * 1024;

          // Projected load percentage
          const projectedPct = totalMib > 0 ? (alloc.projectedLoadGb * 1024 / totalMib) * 100 : 0;

          // Running engines + external breakdown
          const totalRunningMib = alloc.runningEngines.reduce((sum, e) => sum + e.vramUsedMib, 0);
          const osOtherMib = Math.max(0, usedMib - totalRunningMib);
          const runningPct = totalMib > 0 ? (totalRunningMib / totalMib) * 100 : 0;
          const osPct = totalMib > 0 ? (osOtherMib / totalMib) * 100 : 0;

          // Total utilization: projected + existing used (cap at 100% for display)
          const totalUsedMib = alloc.projectedLoadGb * 1024 + usedMib;
          const totalUsedPct = Math.min(totalMib > 0 ? (totalUsedMib / totalMib) * 100 : 0, 100);

          // Color hex for inline styles — derive from tailwind class name
          const barColorHex = gpuBarColor.includes('nv-green') || gpuBarColor.includes('green') ? '#76B900' :
                              gpuBarColor.includes('yellow') ? '#FBBF24' :
                              gpuBarColor.includes('telemetry-red') ? '#ff3333' :
                              gpuBarColor.includes('red-5') ? '#EF4444' :
                              gpuBarColor.includes('red-6') || gpuBarColor.includes('red-7') ? '#B91C1C' :
                              gpuBarColor.includes('orange') ? '#FB923C' :
                              gpuBarColor.includes('cyan') ? '#22D3EE' :
                              gpuBarColor.includes('gray') ? '#4B5563' :
                              '#76B900';

          // Percentage label color — based on total utilization (existing + projected)
          const pctColor = totalUsedPct > 95 ? '#ff3333' : totalUsedPct > 85 ? '#FB923C' : barColorHex;

          // Existing usage alone can be high even with no projection — color the hatched fill accordingly
          const existingOnlyPct = totalMib > 0 ? (usedMib / totalMib) * 100 : 0;
          const existingBarColor = existingOnlyPct > 95 ? '#ff3333' : existingOnlyPct > 85 ? '#FB923C' : barColorHex;

          const isSelected = selectedGpuIndices?.includes(alloc.gpuIndex) ?? false;

          // Tooltip text
          const tooltipText = `Running engines: ${(totalRunningMib / 1024).toFixed(1)} GB | External apps: ${(osOtherMib / 1024).toFixed(1)} GB`;

          return (
            <div
              key={alloc.gpuIndex}
              onClick={() => onDeviceSelect?.(alloc.gpuIndex)}
              className={`rounded-sm p-2 bg-depth-black/30 gpu-card gpu-card-enter ${
                isSelected
                  ? "gpu-selected"
                  : onDeviceSelect
                    ? "cursor-pointer hover:border-stealth-muted/50"
                    : ""
              }`}
            >
              {/* GPU header */}
              <div className="flex justify-between items-center mb-1.5">
                <span className="gpu-card-name text-[9px] font-mono truncate flex-1 mr-2 text-stealth-muted" title={alloc.name}>
                  {alloc.name}
                </span>
                <span style={{ color: pctColor }} className="text-[7px] font-mono flex-shrink-0">
                  {totalUsedPct.toFixed(0)}%
                </span>
              </div>

              {/* Unified VRAM bar — projected from left, existing from right */}
              <div
                style={{ backgroundColor: 'rgb(20,20,20)' }}
                className="relative h-3 rounded-sm overflow-hidden border border-stealth-border/30"
              >
                {/* Projected load — fills left → right in scenario color (capped at 100%) */}
                <div
                  style={{ width: `${Math.min(projectedPct, 100)}%` }}
                  className={`h-full absolute top-0 left-0 gpu-bar-fill ${gpuBarColor}`}
                />

                {/* External/OS — fills from far right edge, grey hatched (capped) */}
                {osOtherMib > 0 && (
                  <div
                    style={{
                      width: `${Math.min(osPct, 100)}%`,
                      backgroundColor: '#585858',
                      backgroundImage: HATCH_PATTERN,
                    }}
                    className="h-full absolute top-0 right-0 gpu-bar-fill"
                  />
                )}

                {/* Running engines — fills from right after external, colored by utilization (capped) */}
                {totalRunningMib > 0 && (
                  <div
                    style={{
                      width: `${Math.min(runningPct, 100)}%`,
                      right: `${osPct}%`,
                      backgroundColor: existingBarColor,
                      backgroundImage: HATCH_PATTERN,
                    }}
                    className="h-full absolute top-0 gpu-bar-fill"
                  />
                )}

                {/* Tooltip overlay — covers entire bar */}
                <div className="absolute inset-0 cursor-help" title={tooltipText} />
              </div>

              {/* Numbers below bar */}
              <div className="flex justify-between mt-1">
                <span style={{ color: barColorHex }} className="text-[8px] font-mono">
                  {alloc.projectedLoadGb.toFixed(1)} GB projected
                </span>
                <span className="text-[8px] font-mono text-stealth-muted/50">
                  /{alloc.vramManufacturedGb.toFixed(0)} GB
                </span>
              </div>

              </div>
          );
        })}
      </div>

      {/* System RAM bar — shown when ramVisible from template */}
      {ramVisible && (
        <div className="pt-2 border-t border-stealth-border/20 gpu-ram-enter">
          {/* RAM header + spill info */}
          <div className="flex items-center gap-2 mb-1.5">
            <span className="text-[9px] font-mono text-electric-blue">SYSTEM RAM</span>
            <span className="text-[8px] font-mono text-stealth-muted/40">|</span>
            {ramManufacturedGb > 0 ? (
              <span className="text-[8px] font-mono text-electric-blue">
                {ramTotalGb.toFixed(0)} GB spill / {ramManufacturedGb.toFixed(0)} GB ({((ramTotalGb / ramManufacturedGb) * 100).toFixed(0)}%)
              </span>
            ) : (
              <span className="text-[8px] font-mono text-stealth-muted/60">
                RAM offload active — {ramTotalGb.toFixed(1)} GB in system memory
              </span>
            )}
          </div>

          {/* RAM fill bar */}
          <div style={{ backgroundColor: 'rgb(20,20,20)' }} className="relative h-4 rounded-sm overflow-hidden border border-stealth-border/30">
            <div
              style={{ width: `${ramManufacturedGb > 0 ? Math.min((ramTotalGb / ramManufacturedGb) * 100, 100) : 0}%` }}
              className="h-full rounded-sm bg-electric-blue gpu-bar-fill"
            />
          </div>

          {/* Spill info below bar */}
          <div className="flex justify-start mt-1">
            <span className="text-[8px] font-mono text-electric-blue">
              {ramTotalGb.toFixed(0)} GB will spill to RAM — expect slower inference
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
