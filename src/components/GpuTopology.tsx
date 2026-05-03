/**
 * GPU Topology Component — Multi-GPU VRAM distribution display with system RAM bar
 */

import { motion } from "framer-motion";
import type { GpuDistribution, RamEstimate, VramStatus } from "../hooks/useVramCalculator";

interface GpuTopologyProps {
  distribution: GpuDistribution[];
  ramEstimate: RamEstimate | null;
  status: VramStatus;
  shouldShowRam?: boolean;
}

function getBarColor(percentage: number, status: VramStatus): string {
  if (status === 'critical') return "bg-white animate-pulse";
  if (percentage > 100) return "bg-telemetry-red";
  if (percentage > 90) return "bg-telemetry-red";
  if (percentage > 85) return "bg-yellow-400";
  if (percentage > 75) return "bg-telemetry-cyan";
  return "bg-nv-green";
}

function getBarColorRam(percentage: number): string {
  if (percentage > 90) return "bg-telemetry-red";
  if (percentage > 75) return "bg-yellow-400";
  return "bg-stealth-muted/60";
}

export default function GpuTopology({ distribution, ramEstimate, status, shouldShowRam = false }: GpuTopologyProps) {
  const showRam = shouldShowRam || (ramEstimate && ramEstimate.spillMib > 0);

  return (
    <div className="space-y-2">
      {/* GPU Grid — 2 per row */}
      <div className={`grid gap-2 ${distribution.length === 1 ? 'max-w-[48%]' : 'grid-cols-2'}`}>
        {distribution.map((gpu) => (
          <motion.div
            key={gpu.gpuIndex}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            className="border border-stealth-border/30 rounded-sm p-2 bg-depth-black/30"
          >
            {/* GPU header */}
            <div className="flex justify-between items-center mb-1.5">
              <span className="text-[9px] font-mono text-stealth-muted truncate flex-1 mr-2" title={gpu.name}>
                {gpu.name}
              </span>
            </div>

            {/* VRAM fill bar */}
            <div className="relative h-2 bg-depth-black/50 rounded-sm overflow-hidden border border-stealth-border/30">
              <motion.div
                style={{ width: `${Math.min(gpu.percentage, 100)}%` }}
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(gpu.percentage, 100)}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className={`h-full rounded-sm ${getBarColor(gpu.percentage, status)}`}
              />
              <span className="absolute right-0 top-0 text-[7px] font-mono translate-x-full ml-1" style={{ color: getBarColor(gpu.percentage, status).replace('bg-', 'text-') }}>
                {gpu.percentage.toFixed(0)}%
              </span>
            </div>

            {/* VRAM numbers */}
            <div className="flex justify-between mt-1">
              <span className="text-[8px] font-mono text-nv-green">
                {(gpu.projectedMib / 1024).toFixed(1)} GB
              </span>
              <span className="text-[8px] font-mono text-stealth-muted/50">
                /{(gpu.totalManufacturedMib / 1024).toFixed(0)} GB
              </span>
            </div>
          </motion.div>
        ))}
      </div>

      {/* System RAM bar — shown when model doesn't fit GPU(s) or Multi-GPU elevated */}
      {showRam && ramEstimate && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          className="pt-2 border-t border-stealth-border/20"
        >
          {/* RAM header + info */}
          <div className="flex justify-between items-center mb-1.5">
            <span className="text-[9px] font-mono text-stealth-muted truncate flex-1 mr-2">SYSTEM RAM</span>
            {ramEstimate.spillMib > 0 ? (
              <span className={`text-[8px] font-mono ${getBarColorRam(ramEstimate.percentage)}`}>
                {(ramEstimate.spillMib / 1024).toFixed(0)} GB spill / {(ramEstimate.totalManufacturedMib / 1024).toFixed(0)} GB ({ramEstimate.percentage.toFixed(0)}%)
              </span>
            ) : (
              <span className="text-[8px] font-mono text-stealth-muted/60">
                {(ramEstimate.availableMib / 1024).toFixed(0)} GB available for offload / {(ramEstimate.totalManufacturedMib / 1024).toFixed(0)} GB total
              </span>
            )}
          </div>

          {/* RAM fill bar — same style as GPU bars */}
          <div className="relative h-2 bg-depth-black/50 rounded-sm overflow-hidden border border-stealth-border/30">
            <motion.div
              style={{ width: `${Math.min(ramEstimate.spillMib > 0 ? ramEstimate.percentage : (ramEstimate.availableMib / ramEstimate.totalMib) * 100, 100)}%` }}
              initial={{ width: 0 }}
              animate={{ width: `${Math.min(ramEstimate.spillMib > 0 ? ramEstimate.percentage : (ramEstimate.availableMib / ramEstimate.totalMib) * 100, 100)}%` }}
              transition={{ duration: 0.4, ease: "easeOut" }}
              className={`h-full rounded-sm ${ramEstimate.spillMib > 0 ? getBarColorRam(ramEstimate.percentage) : 'bg-stealth-muted/30'}`}
            />
          </div>
        </motion.div>
      )}
    </div>
  );
}
