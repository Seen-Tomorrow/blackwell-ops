import { useEffect, useMemo, useRef, useState } from "react";
import type { GpuInfo, VramManifest, ModelMetadata } from "../lib/types";
import { computeBenchPanelHeight, computeFusionPhosphorHeight } from "../lib/benchPanelLayout";
import { getBenchPortState, subscribeBenchPortStore } from "../lib/benchPortStore";
import { FORECAST_PHOSPHOR_HEIGHT_PX } from "../lib/onboardingDisplay";
import GpuTopology from "./GpuTopology";
import FusionOverlay from "./FusionOverlay";
import MoeBadge from "./MoeBadge";
import MemorySourcePanel, { manifestHasFitProbe } from "./MemorySourcePanel";
import { useFusionSlot } from "../hooks/useFusionData";
import { MEMORY_SOURCE_ACCENT } from "../services/vram/memorySource";
import DisplayGlitchOverlay from "./DisplayGlitchOverlay";
import type { FusionShareLaunchConfig } from "../lib/fusionShareCapture";

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
  onMoeSuggestionClick?: () => void; // Toggle offload_mode regular ↔ moe_optimal
  /** Hide FIT validate button (Auto VRAM launch handles tuning). */
  hideValidate?: boolean;
  /** Hide MOE_OPTIMAL badge (not applicable in Auto VRAM mode). */
  hideMoeBadge?: boolean;
  className?: string;
  modelName?: string;
  modelQuant?: string;
  providerName?: string;
  providerBuildVersion?: string;
  profileLabel?: string;
  cudaVersion?: string;
  launchConfig?: FusionShareLaunchConfig;
  hwTopo?: string;
}

/** Isolated fusion subscriber — keeps forecast/topo off the 25–40 Hz fusion tick path. */
function VramBadgeFusionLayer({
  active,
  selectedSlotIdx,
  activeEngineAlias,
  activeEnginePort,
  supportsFusion,
  engineStatus,
  gpus,
  gpuMask,
  vramTargetMib,
  modelLayerTotal,
  gpuLoadTargetsMib,
  modelName,
  modelQuant,
  providerName,
  providerBuildVersion,
  profileLabel,
  cudaVersion,
  launchConfig,
  hwTopo,
}: {
  active: boolean;
  selectedSlotIdx?: number | null;
  activeEngineAlias?: string;
  activeEnginePort?: number;
  supportsFusion?: boolean;
  engineStatus?: string;
  gpus: GpuInfo[];
  gpuMask?: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
  modelName?: string;
  modelQuant?: string;
  providerName?: string;
  providerBuildVersion?: string;
  profileLabel?: string;
  cudaVersion?: string;
  launchConfig?: FusionShareLaunchConfig;
  hwTopo?: string;
}) {
  const fusion = useFusionSlot(active ? selectedSlotIdx : null);
  if (!active) return null;

  return (
    <div
      className="!absolute inset-0 z-50 phosphor-screen phosphor-display-surface overflow-hidden flex flex-col rounded-xl border border-stealth-border p-[6px]"
      style={{ animation: "fadeIn 0.2s ease" }}
    >
      <DisplayGlitchOverlay />
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
        modelName={modelName}
        modelQuant={modelQuant}
        providerName={providerName}
        providerBuildVersion={providerBuildVersion}
        profileLabel={profileLabel}
        cudaVersion={cudaVersion}
        launchConfig={launchConfig}
        hwTopo={hwTopo}
      />
    </div>
  );
}

/** Pure skeleton renderer — reads all text, visibility, and colors from scenario's uiTemplate.
 *  GOLDEN RULE: Never add conditional logic or hardcoded text here. */
export default function VramBadge({
  manifest, gpus, modelMeta, selectedGpuIndices, onDeviceSelect, isValidating, onValidate,
  isModelRunning, activeEngineAlias, activeEnginePort, selectedSlotIdx, supportsFusion = true, engineStatus,
  gpuMask = "", vramTargetMib, modelLayerTotal, gpuLoadTargetsMib, offloadMode, onMoeSuggestionClick, hideValidate = false, hideMoeBadge = false, className,
  modelName, modelQuant, providerName, providerBuildVersion, profileLabel, cudaVersion, launchConfig, hwTopo,
}: VramBadgeProps) {
  const [benchLayoutTick, setBenchLayoutTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeBenchPortStore(() => setBenchLayoutTick((t) => t + 1)), []);

  const fusionOverlayActive =
    selectedSlotIdx !== null &&
    selectedSlotIdx !== undefined &&
    activeEnginePort != null &&
    (engineStatus === "LOADING" || engineStatus === "RUNNING");

  const fusionPhosphorHeight = useMemo(() => {
    if (!fusionOverlayActive || activeEnginePort == null) return FORECAST_PHOSPHOR_HEIGHT_PX;
    const ps = getBenchPortState(activeEnginePort);
    const benchPanelHeight = computeBenchPanelHeight({
      showResults: ps.showResults,
      tgRunning: ps.tgRunning,
      ppRunning: ps.ppRunning,
      sessionMode: ps.sessionMode,
      tgResult: ps.tgResult,
      ppResult: ps.ppResult,
      gpus,
      gpuMask,
      inlineActions: true,
    });
    return computeFusionPhosphorHeight(benchPanelHeight);
  }, [fusionOverlayActive, activeEnginePort, benchLayoutTick, gpus, gpuMask]);

  useEffect(() => {
    const display = rootRef.current?.closest(".vram-forecast-display");
    if (!(display instanceof HTMLElement)) return;

    if (fusionPhosphorHeight > FORECAST_PHOSPHOR_HEIGHT_PX) {
      display.style.height = `${fusionPhosphorHeight}px`;
      display.style.minHeight = `${fusionPhosphorHeight}px`;
      display.style.maxHeight = `${fusionPhosphorHeight}px`;
    } else {
      display.style.height = "";
      display.style.minHeight = "";
      display.style.maxHeight = "";
    }

    return () => {
      display.style.height = "";
      display.style.minHeight = "";
      display.style.maxHeight = "";
    };
  }, [fusionPhosphorHeight]);

  if (!manifest) return null;

  const s = manifest.style;
  const t = s.uiTemplate;
  const memorySource = manifest.memorySource;
  const sourceAccent = memorySource
    ? MEMORY_SOURCE_ACCENT[memorySource.kind]
    : null;
  const isFitProbe = manifest.validatedVramMib != null && !manifest.learnedFromPreviousRun;
  const totalNeedGb = manifest.vramTotalGb + manifest.ramTotalGb;
  const displayTotalGb = isFitProbe
    ? (manifest.validatedVramMib! / 1024) + (manifest.validatedHostMib ? manifest.validatedHostMib / 1024 : manifest.ramTotalGb)
    : totalNeedGb;
  const neededText = displayTotalGb.toFixed(1);
  const gbAccentClass = sourceAccent?.gbGradient || s.titleColor;

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
    <div
      ref={rootRef}
      className={`vram-badge-forecast px-3 py-2.5 relative flex flex-col h-full min-h-0 overflow-hidden ${className || ''}`}
    >
      <VramBadgeFusionLayer
        active={fusionOverlayActive}
        selectedSlotIdx={selectedSlotIdx}
        activeEngineAlias={activeEngineAlias}
        activeEnginePort={activeEnginePort}
        supportsFusion={supportsFusion}
        engineStatus={engineStatus}
        gpus={gpus}
        gpuMask={gpuMask}
        vramTargetMib={vramTargetMib}
        modelLayerTotal={modelLayerTotal}
        gpuLoadTargetsMib={gpuLoadTargetsMib}
        modelName={modelName}
        modelQuant={modelQuant}
        providerName={providerName}
        providerBuildVersion={providerBuildVersion}
        profileLabel={profileLabel}
        cudaVersion={cudaVersion}
        launchConfig={launchConfig}
        hwTopo={hwTopo}
      />

      {/* FORECAST + SOURCE — pinned header, never scrolls */}
      <div
        className="vram-forecast-header flex-shrink-0 grid gap-x-1 gap-y-0.5 mb-1 min-w-0 pr-16"
        style={{ gridTemplateColumns: "auto 1fr" }}
      >
        <span className={`text-xl font-mono ${s.titleColor} col-start-1 row-start-1 shrink-0`}>
          FORECAST: model
        </span>
        <div className="col-start-2 row-start-1 flex items-baseline gap-1 min-w-0 vram-forecast-needs-row">
          <span className={`text-xl font-mono ${s.titleColor}`}>needs</span>
          <span
            className={`text-xl font-mono vram-forecast-gb-value ${gbAccentClass} ${
              sourceAccent?.gbGradient ? "vram-forecast-gb-accented" : ""
            }`}
          >
            {neededText}
          </span>
          <span className={`text-xl font-mono ${s.titleColor}`}>GB</span>
          <span className="text-[9px] font-mono text-stealth-muted">of</span>
          <span className="text-xl font-mono text-stealth-muted vram-forecast-gb-value">
            {totalAvailableGb.toFixed(1)}
          </span>
          <span className="text-xl font-mono text-stealth-muted">GB</span>
          <span className="text-[9px] font-mono text-stealth-muted">TOTAL MEMORY</span>
        </div>
        {memorySource && (
          <div className="vram-forecast-source col-start-2 row-start-2 min-w-0">
            <MemorySourcePanel
              memorySource={memorySource}
              isValidating={isValidating}
              hasProbed={manifestHasFitProbe(manifest)}
              onValidate={onValidate}
              hideValidate={hideValidate}
            />
          </div>
        )}
      </div>

      {/* ── Top-right: scenario badge only, absolute corner ─── */}
      <div className="absolute top-0 right-2 opacity-75 vram-forecast-scenario-badge">
        {/* Scenario badge */}
        <div className={`inline-flex flex-col items-end gap-0.5 px-2 py-0.5 rounded-sm ${s.badgeBg}`}>
          <span className="text-[7px] font-mono text-stealth-muted">{manifest.scenario}</span>
          <span className="text-[9px] font-mono">{manifest.fits ? "✓ FIT" : "✗ NO FIT"}</span>
        </div>
      </div>

      {/* Bars, warnings, topology — scroll inside phosphor when tall (e.g. MULTI_SPILL) */}
      <div className="vram-badge-body relative flex-1 min-h-0 overflow-y-auto overflow-x-hidden eink-scrollbar mt-2">
        {/* Bars block — MOE badge anchors to right, vertically centered over VRAM + RAM */}
        <div className="vram-badge-bars relative">
        {!hideMoeBadge && modelMeta?.n_expert > 0 && (
          <div className="absolute right-0 top-0 bottom-0 flex items-center z-10">
            <MoeBadge
              offloadMode={offloadMode}
              shouldHighlight={manifest.moeSuggestion?.shouldHighlight}
              onMoeSuggestionClick={onMoeSuggestionClick}
              suggestionText={manifest.moeSuggestion?.suggestionText}
            />
          </div>
        )}
        {/* VRAM bar row */}
        <div className="flex items-center gap-2">
          <div style={{ backgroundColor: 'rgb(20,20,20)' }} className="relative h-4 w-[70%] rounded-sm overflow-hidden border border-stealth-border/30">
            <div
              style={{ width: `${vramUsagePct}%` }}
              className={`h-full rounded-sm ${s.gpuBarColor}`}
            />
          </div>
          <span className={`text-[12px] font-mono ${s.titleColor}`}>| {totalVramGb.toFixed(0)} GB</span>
        </div>

        {/* GPU layer info — text from scenario */}
        <p className={`text-[9px] font-mono ${s.titleColor} mt-1`}>
          {t.gpuLayerText}
        </p>

        {/* RAM bar row */}
        {(t.showRamBar !== false) && (
          <>
            <div className="flex items-center gap-2 mt-2">
              <div style={{ backgroundColor: 'rgb(20,20,20)' }} className="relative h-4 w-[70%] rounded-sm overflow-hidden border border-stealth-border/30">
                <div
                  style={{ width: `${ramUsagePct}%` }}
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
        <div className="mt-2 pb-0.5">
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
    </div>
  );
}
