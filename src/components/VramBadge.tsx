import { motion, AnimatePresence } from "framer-motion";
import type { GpuInfo, VramManifest } from "../lib/types";
import GpuTopology from "./GpuTopology";

interface VramBadgeProps {
  manifest: VramManifest | null;
  gpus: GpuInfo[];
  selectedGpuIndices?: number[];
  onDeviceSelect?: (gpuIndex: number) => void;
  isValidating?: boolean;
  onValidate?: () => void;
}

/** Pure skeleton renderer — reads all text, visibility, and colors from scenario's uiTemplate.
 *  GOLDEN RULE: Never add conditional logic or hardcoded text here. */
export default function VramBadge({ manifest, gpus, selectedGpuIndices, onDeviceSelect, isValidating, onValidate }: VramBadgeProps) {
  if (!manifest) return null;

  const s = manifest.style;
  const t = s.uiTemplate;
  const isCertified = manifest.validatedVramMib != null;
  const displayTotalGb = isCertified ? (manifest.validatedVramMib / 1024) : manifest.vramTotalGb;
  const neededText = displayTotalGb.toFixed(1);

  // Total manufactured VRAM capacity across all GPUs
  const totalVramMib = gpus.reduce((sum, g) => {
    return sum + (g.memory_total_manufactured || g.memory_total);
  }, 0);
  const totalVramGb = (totalVramMib / 1024).toFixed(0);

  // Total available: manufactured VRAM + manufactured RAM
  const totalAvailableGb = parseFloat(totalVramGb) + manifest.ramManufacturedGb;

  // Usage percentage for main VRAM bar
  const vramUsagePct = totalVramMib > 0 ? Math.min((displayTotalGb * 1024 / totalVramMib) * 100, 100) : 0;

  // Headroom: total free VRAM minus projected need (in MiB, can be negative)
  const vramHeadroomMib = gpus.reduce((sum, g) => sum + g.memory_free, 0) - displayTotalGb * 1024;

  // RAM headroom: available RAM minus projected RAM usage
  const ramHeadroomMib = (manifest.ramAvailableGb - manifest.ramTotalGb) * 1024;

  // RAM info for bar fill — OS usage from manufactured capacity
  const ramUsagePct = manifest.ramManufacturedGb > 0 ? Math.min((manifest.ramTotalGb / manifest.ramManufacturedGb) * 100, 100) : 0;
  const ramMfgGb = manifest.ramManufacturedGb.toFixed(0);

  return (
    <div className="px-3 py-2.5 relative">
      {/* ── Header row: everything inline on one baseline ─── */}
      <div className="flex items-baseline gap-1 mb-2">
        <span className={`text-xl font-mono ${s.titleColor}`}>MEMORY FORECAST</span>
        <span className="text-[9px] font-mono text-stealth-muted">/</span>
        <span className="text-[10px] font-mono text-stealth-muted">You need //</span>

        {/* Forecast number — inline, with validate button floating above */}
        <div className="relative inline-block">
          {onValidate && (
            <button
              onClick={onValidate}
              disabled={isValidating}
              className={`absolute -top-5 left-1/2 -translate-x-1/2 px-2 py-0.5 text-[7px] font-mono tracking-widest rounded-sm border whitespace-nowrap transition-all z-10 ${
                isValidating
                  ? "border-yellow-400/40 text-yellow-400 cursor-wait animate-pulse"
                  : isCertified
                    ? "border-amber-400/50 text-amber-400 hover:bg-amber-400/10"
                    : "border-cyan-400/40 text-cyan-400 hover:bg-cyan-400/10"
              }`}
            >
              {isValidating ? "⟳ SCANNING" : isCertified ? "↻ REVALIDATE" : "⚡ VALIDATE"}
            </button>
          )}

          <span className={`text-xl font-mono transition-all ${
            isCertified
              ? "bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-500 bg-clip-text text-transparent drop-shadow-[0_0_8px_rgba(251,191,36,0.4)]"
              : s.titleColor
          }`}>
            {neededText} GB
          </span>

          {/* CERTIFIED badge — below number, absolute, slight overlap into bar area */}
          <AnimatePresence>
            {isCertified && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.25 }}
                className="absolute -bottom-3 left-1/2 -translate-x-1/2 flex items-center gap-1"
              >
                <svg width="15" height="15" viewBox="0 0 10 10" fill="none">
                  <circle cx="5" cy="5" r="4.5" stroke="#FBBF24" strokeWidth="1"/>
                  <path d="M3 5L4.5 6.5L7 3.5" stroke="#FBBF24" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                </svg>
                <span className="text-[9px] font-mono tracking-widest text-amber-400">CERTIFIED</span>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <span className="text-[9px] font-mono text-stealth-muted">// for this model, from //</span>
        <span className="text-xl font-mono text-stealth-muted/40">{totalAvailableGb.toFixed(1)} GB </span>
        
        <span className="text-[9px] font-mono text-stealth-muted">// available</span>
      </div>

      {/* ── Top-right: scenario badge only, absolute corner ─── */}
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 0.75, scale: 1 }}
        className="absolute top-2 right-3"
      >
        {/* Scenario badge */}
        <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm ${s.badgeBg}`}>
          <span className="text-[8px] font-mono text-stealth-muted opacity-60">{manifest.scenario}</span>
          <span className="text-[9px] font-mono">{manifest.fits ? "✓ FIT" : "✗ NO FIT"}</span>
        </div>
      </motion.div>

      {/* ── VRAM bar — always visible, 75% width ─── */}
      <div className="flex items-center gap-2 mt-6">
        <div style={{ backgroundColor: 'rgb(20,20,20)' }} className="relative h-4 w-[75%] rounded-sm overflow-hidden border border-stealth-border/30">
          <motion.div
            style={{ width: `${vramUsagePct}%` }}
            initial={{ width: 0 }}
            animate={{ width: `${vramUsagePct}%` }}
            transition={{ duration: 0.4, ease: "easeOut" }}
            className={`h-full rounded-sm ${s.gpuBarColor}`}
          />
        </div>
        <span className={`text-[10px] font-mono ${s.titleColor}`}>| {totalVramGb} GB</span>
        {vramHeadroomMib > 0 ? (
          <span className="text-[9px] font-mono text-nv-green">{(vramHeadroomMib / 1024).toFixed(1)} GB stays Free</span>
        ) : manifest.ramLayers > 0 ? null : (
          <span className="text-[9px] font-mono text-telemetry-red">{(Math.abs(vramHeadroomMib) / 1024).toFixed(1)} GB Over</span>
        )}
      </div>

      {/* GPU layer info — text from scenario */}
      <p className={`text-[9px] font-mono ${s.titleColor} mt-1`}>
        {t.gpuLayerText}
      </p>

      {/* ── RAM bar — controlled by showRamBar (default true) ─── */}
      {(t.showRamBar !== false) && (
        <>
          <div className="flex items-center gap-2 mt-3">
            <div style={{ backgroundColor: 'rgb(20,20,20)' }} className="relative h-4 w-[75%] rounded-sm overflow-hidden border border-stealth-border/30">
              <motion.div
                style={{ width: `${ramUsagePct}%` }}
                initial={{ width: 0 }}
                animate={{ width: `${ramUsagePct}%` }}
                transition={{ duration: 0.4, ease: "easeOut" }}
                className="h-full rounded-sm bg-electric-blue"
              />
            </div>
            <span className="text-[10px] font-mono text-electric-blue">| {ramMfgGb} GB</span>
            {ramHeadroomMib > 0 ? (
              <span className="text-[9px] font-mono text-nv-green">{(ramHeadroomMib / 1024).toFixed(1)} GB stays Free</span>
            ) : (
              <span className="text-[9px] font-mono text-telemetry-red">{(Math.abs(ramHeadroomMib) / 1024).toFixed(1)} GB Over</span>
            )}
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
            selectedGpuIndices={selectedGpuIndices}
            onDeviceSelect={onDeviceSelect}
          />
        </div>
      )}
    </div>
  );
}
