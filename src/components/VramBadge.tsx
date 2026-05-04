import { motion } from "framer-motion";
import type { GpuInfo, VramManifest } from "../lib/types";
import GpuTopology from "./GpuTopology";

interface VramBadgeProps {
  manifest: VramManifest | null;
  gpus: GpuInfo[];
  onDeviceSelect?: (gpuIndex: number) => void;
}

const ACTION_TEXTS: Record<string, string> = {
  SOLO_CLEAN_FIT: "Model fits cleanly",
  SOLO_BUSY_FIT: "Model fits with existing workloads",
  SOLO_SPILL: "",
  MULTI_PERFECT: "Multi-GPU split — all layers on GPU",
  MULTI_PRESSURE: "Multi-GPU split — tight fit with existing workloads",
  TOTAL_SPILL: "",
  HW_LOCKED: "",
};

export default function VramBadge({ manifest, gpus, onDeviceSelect }: VramBadgeProps) {
  if (!manifest) return null;

  const s = manifest.style;
  const neededGb = manifest.vramTotalGb.toFixed(1);

  // Total manufactured VRAM capacity across all GPUs
  const totalVramMib = gpus.reduce((sum, g) => {
    return sum + (g.memory_total_manufactured || g.memory_total);
  }, 0);
  const availableStr = (totalVramMib / 1024).toFixed(0);

  // Usage percentage for main VRAM bar
  const usagePct = totalVramMib > 0 ? Math.min((manifest.vramTotalGb * 1024 / totalVramMib) * 100, 100) : 0;

  // Headroom: total free VRAM minus projected need (in MiB, can be negative)
  const headroomMib = gpus.reduce((sum, g) => sum + g.memory_free, 0) - manifest.vramTotalGb * 1024;

  // Action text from scenario
  let actionText = ACTION_TEXTS[manifest.scenario] || "";
  if (manifest.recommendation && !actionText) {
    actionText = manifest.recommendation;
  }

  return (
    <div className={`border rounded-sm px-3 py-2.5 ${s.titleColor} ${s.borderColor} ${s.bgTint}`}>
      {/* ── Unified layout: memory values + right panel, GPUs below ─── */}
      <div className="space-y-2">
        {/* Top row: memory values + right panel */}
        <div className="flex gap-4 items-center">
          {/* Left: Memory forecast */}
          <div className="flex-1 space-y-2 min-w-0">
            <span className={`text-[10px] font-mono ${s.titleColor}`}>
              {s.icon} MEMORY FORECAST
            </span>

            <div className="flex items-baseline gap-2 whitespace-nowrap">
              <span className={`text-xl font-mono ${s.titleColor}`}>{neededGb}</span>
              <span className="text-[10px] font-mono text-stealth-muted">GB /</span>
              <span className={`text-xl font-mono ${s.titleColor}`}>{availableStr} GB</span>
            </div>

            {/* Main VRAM usage bar */}
            <div className="relative h-3 bg-depth-black/50 rounded-sm overflow-hidden border border-stealth-border/30">
              <motion.div
                style={{ width: `${usagePct}%` }}
                initial={{ width: 0 }}
                animate={{ width: `${usagePct}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className={`h-full rounded-sm ${s.gpuBarColor}`}
              />
            </div>

            {actionText && (
              <p className={`text-[9px] font-mono ${s.titleColor}`}>→ {actionText}</p>
            )}

            {/* Layer breakdown when RAM offload is active */}
            {manifest.ramLayers > 0 && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[8px] font-mono text-nv-green">{manifest.gpuLayers} layers on GPU</span>
                <span className="text-[8px] font-mono text-stealth-muted">/</span>
                <span className={`text-[8px] font-mono ${s.ramVisible ? "text-yellow-400" : "text-telemetry-red"}`}>
                  {manifest.ramLayers} in RAM ({(manifest.ramTotalGb).toFixed(1)} GB)
                </span>
              </div>
            )}
          </div>

          {/* Right: Headroom panel */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex flex-col items-center border-l border-stealth-border/30 pl-4 min-w-[200px]"
          >
            <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm ${s.badgeBg}`}>
              <span className="text-[10px] font-mono">{manifest.fits ? "✓ FIT" : "✗ NO FIT"}</span>
            </div>

            <div className="space-y-1 mt-2">
              {headroomMib > 0 ? (
                <>
                  <p className="text-[11px] font-mono text-telemetry-green">
                    {(headroomMib / 1024).toFixed(1)} GB Headroom
                  </p>
                  <p className="text-[8px] font-mono text-stealth-muted opacity-60">Zero RAM Spill</p>
                </>
              ) : (
                <>
                  <p className="text-[11px] font-mono text-telemetry-red">
                    {(Math.abs(headroomMib) / 1024).toFixed(1)} GB Over
                  </p>
                  {manifest.ramLayers > 0 ? (
                    <p className="text-[8px] font-mono text-yellow-400 opacity-70">RAM Offload Active</p>
                  ) : (
                    <p className="text-[8px] font-mono text-telemetry-red opacity-70">Cannot Launch</p>
                  )}
                </>
              )}
            </div>
          </motion.div>
        </div>

        {/* GPU topology below */}
        {manifest.gpuAllocations.length > 0 && (
          <GpuTopology
            gpuAllocations={manifest.gpuAllocations}
            gpuBarColor={s.gpuBarColor}
            ramVisible={s.ramVisible}
            ramTotalGb={manifest.ramTotalGb}
            ramManufacturedGb={manifest.ramManufacturedGb}
            onDeviceSelect={onDeviceSelect}
          />
        )}
      </div>
    </div>
  );
}
