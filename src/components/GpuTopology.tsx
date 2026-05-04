import { motion } from "framer-motion";
import type { GpuAllocation } from "../lib/types";

interface GpuTopologyProps {
  gpuAllocations: GpuAllocation[];
  gpuBarColor: string;
  ramVisible: boolean;
  ramTotalGb: number;
  ramManufacturedGb: number;
  onDeviceSelect?: (gpuIndex: number) => void;
}

const HATCH_PATTERN = `repeating-linear-gradient(45deg, transparent, transparent 2px, rgba(0,0,0,0.35) 2px, rgba(0,0,0,0.35) 4px)`;

export default function GpuTopology({ gpuAllocations, gpuBarColor, ramVisible, ramTotalGb, ramManufacturedGb, onDeviceSelect }: GpuTopologyProps) {
  return (
    <div className="space-y-2">
      {/* GPU Grid — 2 per row */}
      <div className={`grid gap-2 ${gpuAllocations.length === 1 ? 'max-w-[48%]' : 'grid-cols-2'}`}>
        {gpuAllocations.map((alloc) => {
          const totalMib = alloc.vramManufacturedGb * 1024;
          const usedMib = (alloc.vramManufacturedGb - alloc.vramAvailableGb) * 1024;
          const projectedPct = totalMib > 0 ? (alloc.projectedLoadGb * 1024 / totalMib) * 100 : 0;

          // Running engines segments from manifest
          const totalRunningMib = alloc.runningEngines.reduce((sum, e) => sum + e.vramUsedMib, 0);
          const osOtherMib = Math.max(0, usedMib - totalRunningMib);

          // Percentages for the actual usage bar
          const runningPct = totalMib > 0 ? (totalRunningMib / totalMib) * 100 : 0;
          const osPct = totalMib > 0 ? (osOtherMib / totalMib) * 100 : 0;

          // Color hex for inline styles — derive from tailwind class name
          const barColorHex = gpuBarColor.includes('green') ? '#76B900' :
                              gpuBarColor.includes('yellow') ? '#FBBF24' :
                              gpuBarColor.includes('red-5') ? '#EF4444' :
                              gpuBarColor.includes('red-6') || gpuBarColor.includes('red-7') ? '#B91C1C' :
                              gpuBarColor.includes('orange') ? '#FB923C' :
                              gpuBarColor.includes('cyan') ? '#22D3EE' :
                              gpuBarColor.includes('gray') ? '#4B5563' :
                              '#76B900';

          return (
            <motion.div
              key={alloc.gpuIndex}
              initial={{ opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              onClick={() => onDeviceSelect?.(alloc.gpuIndex)}
              className={`border rounded-sm p-2 bg-depth-black/30 ${
                onDeviceSelect ? "cursor-pointer hover:border-stealth-muted/50 transition-colors" : ""
              } border-stealth-border/30`}
            >
              {/* GPU header */}
              <div className="flex justify-between items-center mb-1.5">
                <span className="text-[9px] font-mono text-stealth-muted truncate flex-1 mr-2" title={alloc.name}>
                  {alloc.name}
                </span>
                <span style={{ color: barColorHex }} className="text-[7px] font-mono flex-shrink-0">
                  {projectedPct.toFixed(0)}%
                </span>
              </div>

              {/* Projected VRAM fill bar — thick, solid */}
              <div className="relative h-4 bg-depth-black/50 rounded-sm overflow-hidden border border-stealth-border/30">
                <motion.div
                  style={{ width: `${Math.min(projectedPct, 100)}%` }}
                  initial={{ width: 0 }}
                  animate={{ width: `${Math.min(projectedPct, 100)}%` }}
                  transition={{ duration: 0.4, ease: "easeOut" }}
                  className={`h-full rounded-sm ${gpuBarColor}`}
                />
              </div>

              {/* Projected VRAM numbers */}
              <div className="flex justify-between mt-1">
                <span style={{ color: barColorHex }} className="text-[8px] font-mono">
                  {alloc.projectedLoadGb.toFixed(1)} GB projected
                </span>
                <span className="text-[8px] font-mono text-stealth-muted/50">
                  /{alloc.vramManufacturedGb.toFixed(0)} GB
                </span>
              </div>

              {/* Actual usage bar — thin, hatched segments (always rendered) */}
              <div className="relative mt-1.5 h-2 bg-depth-black/50 rounded-sm overflow-hidden border border-stealth-border/30">
                {/* Running engines segment (hatched) */}
                {totalRunningMib > 0 && (
                  <motion.div
                    style={{
                      width: `${runningPct}%`,
                      backgroundColor: barColorHex,
                      backgroundImage: HATCH_PATTERN,
                    }}
                    initial={{ width: 0 }}
                    animate={{ width: `${runningPct}%` }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className="h-full rounded-l-sm absolute top-0 left-0 cursor-help"
                    title={alloc.runningEngines.map(e => `${e.slotAlias} | ${e.modelShort}: ${(e.vramUsedMib / 1024).toFixed(1)} GB`).join('\n')}
                  />
                )}

                {/* OS other segment (grey hatched) */}
                {osOtherMib > 0 && (
                  <motion.div
                    style={{
                      width: `${osPct}%`,
                      left: `${runningPct}%`,
                      backgroundColor: '#4a4a5a',
                      backgroundImage: HATCH_PATTERN,
                    }}
                    initial={{ width: 0 }}
                    animate={{ width: `${osPct}%` }}
                    transition={{ duration: 0.4, ease: "easeOut" }}
                    className="h-full absolute top-0"
                  />
                )}

                {/* Total used label */}
                <span className="absolute right-0 top-0 text-[6px] font-mono translate-x-full ml-1 text-stealth-muted">
                  {(usedMib / 1024).toFixed(1)} GB used
                </span>
              </div>

              {/* Actual usage breakdown */}
              <div className="flex justify-between mt-1">
                <span style={{ color: barColorHex }} className="text-[7px] font-mono">
                  {(totalRunningMib / 1024).toFixed(1)} GB app
                </span>
                <span className="text-[7px] font-mono text-stealth-muted">
                  {(osOtherMib / 1024).toFixed(1)} GB other
                </span>
              </div>
            </motion.div>
          );
        })}
      </div>

      {/* System RAM bar — shown when ramVisible from template */}
      {ramVisible && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="pt-2 border-t border-stealth-border/20"
        >
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

          {/* RAM fill bar — thick, electric-blue */}
          <div className="relative h-4 bg-depth-black/50 rounded-sm overflow-hidden border border-stealth-border/30">
            <motion.div
              style={{ width: `${ramManufacturedGb > 0 ? Math.min((ramTotalGb / ramManufacturedGb) * 100, 100) : 0}%` }}
              initial={{ width: 0 }}
              animate={{ width: `${ramManufacturedGb > 0 ? Math.min((ramTotalGb / ramManufacturedGb) * 100, 100) : 0}%` }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className="h-full rounded-sm bg-electric-blue"
            />
          </div>

          {/* Spill info below bar */}
          <div className="flex justify-start mt-1">
            <span className="text-[8px] font-mono text-electric-blue">
              {ramTotalGb.toFixed(0)} GB will spill to RAM — expect slower inference
            </span>
          </div>
        </motion.div>
      )}
    </div>
  );
}
