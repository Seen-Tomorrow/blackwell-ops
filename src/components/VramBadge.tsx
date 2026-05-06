import { motion } from "framer-motion";
import type { GpuInfo, VramManifest } from "../lib/types";
import GpuTopology from "./GpuTopology";

interface VramBadgeProps {
  manifest: VramManifest | null;
  gpus: GpuInfo[];
  selectedGpuIdx?: number;
  onDeviceSelect?: (gpuIndex: number) => void;
}

/** Pure skeleton renderer — reads all text, visibility, and colors from scenario's uiTemplate.
 *  GOLDEN RULE: Never add conditional logic or hardcoded text here. If a scenario needs different
 *  presentation, edit its uiTemplate in src/services/vram/scenarios/. */
export default function VramBadge({ manifest, gpus, selectedGpuIdx, onDeviceSelect }: VramBadgeProps) {
  if (!manifest) return null;

  const s = manifest.style;
  const t = s.uiTemplate;
  const neededGb = manifest.vramTotalGb.toFixed(1);

  // Total manufactured VRAM capacity across all GPUs
  const totalVramMib = gpus.reduce((sum, g) => {
    return sum + (g.memory_total_manufactured || g.memory_total);
  }, 0);
  const totalVramGb = (totalVramMib / 1024).toFixed(0);

  // Usage percentage for main VRAM bar
  const vramUsagePct = totalVramMib > 0 ? Math.min((manifest.vramTotalGb * 1024 / totalVramMib) * 100, 100) : 0;

  // Headroom: total free VRAM minus projected need (in MiB, can be negative)
  const headroomMib = gpus.reduce((sum, g) => sum + g.memory_free, 0) - manifest.vramTotalGb * 1024;

  // RAM info for bar fill — OS usage from manufactured capacity
  const ramUsagePct = manifest.ramManufacturedGb > 0 ? Math.min((manifest.ramTotalGb / manifest.ramManufacturedGb) * 100, 100) : 0;
  const ramMfgGb = manifest.ramManufacturedGb.toFixed(0);

  return (
    <div className="px-3 py-2.5 relative">
      {/* ── Header row: label + model size ─── */}
      <div className="flex items-baseline gap-1 mb-2 pr-48">
        <span className={`text-xl font-mono ${s.titleColor}`}>MEMORY FORECAST</span>
        <span className="text-[9px] font-mono text-stealth-muted">/</span>
        <span className="text-[10px] font-mono text-stealth-muted">You need //</span>
        <span className={`text-xl font-mono ${s.titleColor}`}>{neededGb} GB</span>
        <span className="text-[9px] font-mono text-stealth-muted">// for this model</span>
      </div>

      {/* ── Headroom panel — absolute top-right ─── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        className="absolute top-0 right-3 flex flex-col items-end"
      >
        <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm ${s.badgeBg}`}>
          <span className="text-[9px] font-mono text-stealth-muted opacity-60">{manifest.scenario}</span>
          <span className="text-[10px] font-mono">{manifest.fits ? "✓ FIT" : "✗ NO FIT"}</span>
        </div>

        <div className="space-y-0.5 mt-2">
          {headroomMib > 0 ? (
            <>
              <p className="text-[11px] font-mono text-nv-green">
                {(headroomMib / 1024).toFixed(1)} GB stays Free
              </p>
              {t.offloadWarningText && (
                <p className="text-[8px] font-mono text-yellow-400 opacity-70">RAM Offload Active</p>
              )}
            </>
          ) : (
            <>
              <p className="text-[11px] font-mono text-telemetry-red">
                {(Math.abs(headroomMib) / 1024).toFixed(1)} GB Over
              </p>
              {t.offloadWarningText ? (
                <p className="text-[8px] font-mono text-yellow-400 opacity-70">RAM Offload Active</p>
              ) : (
                <p className="text-[8px] font-mono text-telemetry-red opacity-70">Cannot Launch</p>
              )}
            </>
          )}
        </div>
      </motion.div>

      {/* ── VRAM bar — always visible, 75% width ─── */}
      <div className="flex items-center gap-2 mt-3">
        <div className="relative h-4 w-[75%] bg-depth-black/50 rounded-sm overflow-hidden border border-stealth-border/30">
          <motion.div
            style={{ width: `${vramUsagePct}%` }}
            initial={{ width: 0 }}
            animate={{ width: `${vramUsagePct}%` }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className={`h-full rounded-sm ${s.gpuBarColor}`}
          />
        </div>
        <span className={`text-[10px] font-mono ${s.titleColor}`}>| {totalVramGb} GB</span>
      </div>

      {/* GPU layer info — text from scenario */}
      <p className={`text-[9px] font-mono ${s.titleColor} mt-1`}>
        {t.gpuLayerText}
      </p>

      {/* ── RAM bar — controlled by showRamBar (default true) ─── */}
      {(t.showRamBar !== false) && (
        <>
          <div className="flex items-center gap-2 mt-3">
            <div className="relative h-4 w-[75%] bg-depth-black/50 rounded-sm overflow-hidden border border-stealth-border/30">
              <motion.div
                style={{ width: `${ramUsagePct}%` }}
                initial={{ width: 0 }}
                animate={{ width: `${ramUsagePct}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className="h-full rounded-sm bg-electric-blue"
              />
            </div>
            <span className="text-[10px] font-mono text-electric-blue">| {ramMfgGb} GB</span>
          </div>

          {/* RAM layer info — text from scenario */}
          <p className="text-[9px] font-mono text-electric-blue mt-1">
            {t.ramLayerText}
          </p>
        </>
      )}

      {/* Offload warning — controlled by scenario's offloadWarningText */}
      {t.offloadWarningText && (
        <p className="text-[8px] font-mono text-electric-blue mt-1">
          {t.offloadWarningText}
        </p>
      )}

      {/* KV spill risk — controlled by scenario's kvSpillRiskText */}
      {t.kvSpillRiskText && (
        <p className="text-[8px] font-mono text-telemetry-red mt-1">{t.kvSpillRiskText}</p>
      )}

      {/* ── GPU topology below — always rendered ─── */}
      {manifest.gpuAllocations.length > 0 && (
        <div className="mt-3">
          <GpuTopology
            gpuAllocations={manifest.gpuAllocations}
            gpuBarColor={s.gpuBarColor}
            ramVisible={false}
            ramTotalGb={manifest.ramTotalGb}
            ramManufacturedGb={manifest.ramManufacturedGb}
            selectedGpuIdx={selectedGpuIdx}
            onDeviceSelect={onDeviceSelect}
          />
        </div>
      )}
    </div>
  );
}
