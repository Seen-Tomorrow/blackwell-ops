import type { GpuInfo, VramManifest, ModelMetadata } from "../lib/types";
import GpuTopology from "./GpuTopology";
import FusionOverlay from "./FusionOverlay";
import MoeBadge from "./MoeBadge";
import { useFusionData } from "../hooks/useFusionData";

interface VramBadgeProps {
  manifest: VramManifest | null;
  gpus: GpuInfo[];
  modelMeta?: ModelMetadata; // Model metadata to check if MoE
  selectedGpuIndices?: number[];
  onDeviceSelect?: (gpuIndex: number) => void;
  isValidating?: boolean;
  onValidate?: () => void;
  isModelRunning?: boolean;
  activeEngineAlias?: string;
  activeEnginePort?: number;
  selectedSlotIdx?: number | null; // Slot index for Fusion overlay (unique, no collision)
  supportsFusion?: boolean;
  engineStatus?: string;
  gpuMask?: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
  offloadMode?: string; // Current Offload_Mode config value (e.g., "moe_optimal")
  onMoeSuggestionClick?: () => void; // Callback to auto-switch to MOE_OPTIMAL
  className?: string;
}

/** Pure skeleton renderer — reads all text, visibility, and colors from scenario's uiTemplate.
 *  GOLDEN RULE: Never add conditional logic or hardcoded text here. */
export default function VramBadge({
  manifest, gpus, modelMeta, selectedGpuIndices, onDeviceSelect, isValidating, onValidate,
  isModelRunning, activeEngineAlias, activeEnginePort, selectedSlotIdx, supportsFusion = true, engineStatus,
  gpuMask = "", vramTargetMib, modelLayerTotal, gpuLoadTargetsMib, offloadMode, onMoeSuggestionClick, className
}: VramBadgeProps) {
  const { getEngine } = useFusionData();
  const fusion = selectedSlotIdx !== null && selectedSlotIdx !== undefined ? getEngine(selectedSlotIdx) : null;

  if (!manifest) return null;

  const s = manifest.style;
  const t = s.uiTemplate;
  const isCertified = manifest.validatedVramMib != null;
  // Total memory need: VRAM portion + RAM portion (expert FFN offload, layer spill, etc.)
  const totalNeedGb = manifest.vramTotalGb + manifest.ramTotalGb;
  const displayTotalGb = isCertified ? (manifest.validatedVramMib / 1024) : totalNeedGb;
  const neededText = displayTotalGb.toFixed(1);

  // Total manufactured VRAM capacity across all GPUs
  const totalVramMib = gpus.reduce((sum, g) => {
    return sum + (g.memory_total_manufactured || g.memory_total);
  }, 0);
  const totalVramGb = totalVramMib / 1024;

  // Total available: manufactured VRAM + manufactured RAM
  const totalAvailableGb = totalVramGb + manifest.ramManufacturedGb;

  // Usage percentage for main VRAM bar
  const vramUsagePct = totalVramMib > 0 ? Math.min((displayTotalGb * 1024 / totalVramMib) * 100, 100) : 0;

 // RAM headroom: available RAM minus projected RAM usage
  const ramHeadroomMib = (manifest.ramAvailableGb - manifest.ramTotalGb) * 1024;

  // RAM info for bar fill — OS usage from manufactured capacity
  const ramUsagePct = manifest.ramManufacturedGb > 0 ? Math.min((manifest.ramTotalGb / manifest.ramManufacturedGb) * 100, 100) : 0;
  const ramMfgGb = manifest.ramManufacturedGb.toFixed(0);

  return (
    <div className={`px-3 py-2.5 relative ${className || ''}`}>
      {/* Overlay when a specific engine is selected (mini card click) — covers entire forecast container */}
      {selectedSlotIdx !== null && selectedSlotIdx !== undefined && activeEnginePort && (
        <div
          className="!absolute inset-0 z-50 phosphor-screen phosphor-display-surface overflow-hidden flex flex-col rounded-xl border border-stealth-border p-[6px]"
          style={{ animation: 'fadeIn 0.2s ease' }}
        >
          <FusionOverlay
            alias={activeEngineAlias}
            enginePort={activeEnginePort}
            fusion={fusion}
            supportsFusion={supportsFusion}
            engineStatus={engineStatus}
            slotIdx={selectedSlotIdx ?? -1}
            gpus={gpus}
            gpuMask={gpuMask}
            vramTargetMib={vramTargetMib}
            modelLayerTotal={modelLayerTotal}
            gpuLoadTargetsMib={gpuLoadTargetsMib}
          />
        </div>
      )}

      {/* ── Header row ─── */}
      <div className="flex items-baseline gap-1 mb-2">
        <span className={`text-xl font-mono ${s.titleColor}`}>FORECAST: model</span>

        {/* Bordered block — button floats above, expands when certified */}
        <div className={`relative inline-flex flex-col rounded-sm border px-2 py-1 transition-all ${
          isCertified
            ? "border-amber-400/50"
            : "border-stealth-muted/30"
        }`}>
          {/* Button — floating below the box */}
          {onValidate && (
            <div className="absolute -bottom-5 left-1/2 -translate-x-1/2">
              <button
                onClick={onValidate}
                disabled={isValidating}
                className={`px-2 py-0.5 text-[7px] font-mono tracking-widest rounded-sm border whitespace-nowrap transition-all ${
                  isValidating
                    ? "border-yellow-400/40 text-yellow-400 cursor-wait animate-pulse"
                    : isCertified
                      ? "border-amber-400/50 text-amber-400 hover:bg-amber-400/10"
                      : "border-stealth-muted text-stealth-muted hover:text-white hover:border-stealth-muted"
                }`}
              >
                {isValidating ? "⟳ SCANNING" : isCertified ? "↻ MEASURED" : "⚡ ESTIMATED"}
              </button>
            </div>
          )}

          {/* Main line: needs // X GB // [CERTIFIED] — same height before and after validation */}
          <div className="flex items-baseline gap-1">
            <span className={`text-xl font-mono ${s.titleColor}`}>needs</span>
            <span className="text-[9px] font-mono text-stealth-muted">//</span>
            <span className={`text-xl font-mono transition-all ${
              isCertified
                ? "bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-500 bg-clip-text text-transparent drop-shadow-[0_0_8px_rgba(251,191,36,0.4)]"
               : `${s.titleColor}`
             }`}>
               {neededText} GB
            </span>
            <span className="text-[9px] font-mono text-stealth-muted">//</span>

            {/* CERTIFIED badge — inline after // */}
              {isCertified && (
                <div
                  style={{ animation: 'fadeIn 0.25s ease' }}
                  className="flex items-center gap-1"
                >
                  <svg width="15" height="15" viewBox="0 0 10 10" fill="none">
                    <circle cx="5" cy="5" r="4.5" stroke="#FBBF24" strokeWidth="1"/>
                    <path d="M3 5L4.5 6.5L7 3.5" stroke="#FBBF24" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                  <span className="text-[9px] font-mono tracking-widest text-amber-400">CERTIFIED</span>
                </div>
              )}
          </div>
        </div>

        <span className="text-[9px] font-mono text-stealth-muted">of</span>
        <span className="text-xl font-mono text-stealth-muted">{totalAvailableGb.toFixed(1)} GB</span>
        <span className="text-[9px] font-mono text-stealth-muted">TOTAL MEMORY</span>
        
        {/* MOE Suggestion Badge — always visible for MoE models, positioned next to capacity numbers */}
      </div>

      {/* ── Top-right: scenario badge only, absolute corner ─── */}
      <div
        style={{ animation: 'fadeIn 0.3s ease', opacity: 0.75 }}
        className="absolute top-0 right-2"
      >
        {/* Scenario badge */}
        <div className={`inline-flex flex-col items-end gap-0.5 px-2 py-0.5 rounded-sm ${s.badgeBg}`}>
          <span className="text-[7px] font-mono text-stealth-muted">{manifest.scenario}</span>
          <span className="text-[9px] font-mono">{manifest.fits ? "✓ FIT" : "✗ NO FIT"}</span>
        </div>
      </div>

      {/* ── VRAM + RAM bars with MOE badge ─── */}
      <div className="relative mt-6">
        {/* Bars take 75% width, leaving empty space on right for MOE badge */}
        {/* VRAM bar row */}
        <div className="flex items-center gap-2">
          <div style={{ backgroundColor: 'rgb(20,20,20)' }} className="relative h-4 w-[70%] rounded-sm overflow-hidden border border-stealth-border/30">
            <div
              style={{ width: `${vramUsagePct}%`, transition: 'width 0.4s ease-out' }}
              className={`h-full rounded-sm ${s.gpuBarColor}`}
            />
          </div>
          <span className={`text-[12px] font-mono ${s.titleColor}`}>| {totalVramGb.toFixed(0)} GB</span>
        </div>

        {/* GPU layer info — text from scenario */}
        <p className={`text-[9px] font-mono ${s.titleColor} mt-1`}>
          {t.gpuLayerText}
        </p>

   {/* MOE Badge - absolutely positioned in empty 25% space on right, aligned to full bars height */}
        {modelMeta?.n_expert > 0 && (
          <div className="absolute right-0 top-[-10px] h-full flex items-center z-10">
            <MoeBadge 
              offloadMode={offloadMode}
              shouldHighlight={manifest.moeSuggestion?.shouldHighlight}
              onMoeSuggestionClick={onMoeSuggestionClick}
              suggestionText={manifest.moeSuggestion?.suggestionText}
            />
          </div>
        )}

        {/* RAM bar row */}
        {(t.showRamBar !== false) && (
          <>
            <div className="flex items-center gap-2 mt-3">
              <div style={{ backgroundColor: 'rgb(20,20,20)' }} className="relative h-4 w-[70%] rounded-sm overflow-hidden border border-stealth-border/30">
                <div
                  style={{ width: `${ramUsagePct}%`, transition: 'width 0.4s ease-out' }}
                  className={`h-full rounded-sm ${
                    offloadMode === "moe_optimal" ? "bg-orange-hatched" : "bg-blue-700"
                  }`}
                />
              </div>
              <span className="text-[12px] font-mono text-blue-700">| {ramMfgGb} GB</span>
            </div>

            {/* RAM layer info — text from scenario */}
            <p className="text-[9px] font-mono text-blue-700 mt-1">
              {t.ramLayerText}
            </p>
          </>
        )}

     
      </div>

      {/* Offload warning — controlled by scenario's offloadWarningText */}
      {t.offloadWarningText && (
         <p className="text-[8px] font-mono text-blue-700 mt-1">
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
