import { useEffect, useLayoutEffect, useRef } from "react";
import type { GpuInfo, VramManifest, ModelMetadata } from "../lib/types";
import { computeFusionPhosphorHeightForTray } from "../lib/benchPanelLayout";
import { getFusionBenchTrayOpen, refreshFusionBenchTrayFromStorage } from "../lib/fusionBenchTrayStore";
import { FORECAST_PHOSPHOR_HEIGHT_PX } from "../lib/onboardingDisplay";
import { useFusionBenchTray } from "../hooks/useFusionBenchTray";
import GpuTopology from "./GpuTopology";
import FusionOverlay from "./FusionOverlay";
import MoeBadge from "./MoeBadge";
import FitLaunchToggle from "./FitLaunchToggle";
import MemorySourcePanel, { FitProbeButton, manifestHasFitProbe } from "./MemorySourcePanel";
import { useForecastContentHeight } from "../hooks/useForecastContentHeight";
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
  /** Hide MOE_OPTIMAL badge when not applicable. */
  hideMoeBadge?: boolean;
  /** Provider supports FIT launch path. */
  fitLaunchAvailable?: boolean;
  fullAutoMode?: boolean;
  onFitLaunchChange?: (fullAuto: boolean) => void;
  /** Hide FIT probe / memory source panel. */
  hideFitProbe?: boolean;
  className?: string;
  modelName?: string;
  modelQuant?: string;
  providerName?: string;
  providerBuildVersion?: string;
  profileLabel?: string;
  cudaVersion?: string;
  launchConfig?: FusionShareLaunchConfig;
  hwTopo?: string;
  /** Session idle NVML baseline per GPU index (MiB) — see useGpuIdleBaseline. */
  gpuIdleBaselineMib?: Record<number, number>;
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

  // Fills the phosphor when forecast is unmounted (no overlay-on-forecast veil).
  return (
    <div
      className="relative z-10 flex-1 min-h-0 w-full phosphor-screen phosphor-display-surface overflow-hidden flex flex-col rounded-xl border border-stealth-border p-[6px]"
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
  gpuMask = "", vramTargetMib, modelLayerTotal, gpuLoadTargetsMib, offloadMode, onMoeSuggestionClick, hideMoeBadge = false,
  fitLaunchAvailable = false, fullAutoMode = true, onFitLaunchChange, hideFitProbe = false, className,
  modelName, modelQuant, providerName, providerBuildVersion, profileLabel, cudaVersion, launchConfig, hwTopo,
  gpuIdleBaselineMib,
}: VramBadgeProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const { open: benchTrayOpen } = useFusionBenchTray();

  const fusionOverlayActive =
    selectedSlotIdx !== null &&
    selectedSlotIdx !== undefined &&
    activeEnginePort != null &&
    (engineStatus === "LOADING" || engineStatus === "RUNNING");

  const applyFusionDisplayHeight = () => {
    const display = rootRef.current?.closest(".vram-forecast-display");
    if (!(display instanceof HTMLElement)) return;

    if (!fusionOverlayActive) {
      delete display.dataset.fusionHeightManaged;
      display.removeAttribute("data-fusion-tray-stowed");
      display.removeAttribute("data-fusion-boot");
      display.style.height = "";
      display.style.minHeight = "";
      display.style.maxHeight = "";
      return;
    }

    // LOADING: pin phosphor to forecast baseline — do not hug compact FULL AUTO forecast body.
    if (engineStatus === "LOADING") {
      display.dataset.fusionHeightManaged = "";
      display.setAttribute("data-fusion-boot", "");
      display.removeAttribute("data-fusion-tray-stowed");
      display.style.height = `${FORECAST_PHOSPHOR_HEIGHT_PX}px`;
      display.style.minHeight = `${FORECAST_PHOSPHOR_HEIGHT_PX}px`;
      display.style.maxHeight = `${FORECAST_PHOSPHOR_HEIGHT_PX}px`;
      return;
    }

    display.removeAttribute("data-fusion-boot");

    refreshFusionBenchTrayFromStorage();
    const trayOpen = getFusionBenchTrayOpen();
    const heightPx = computeFusionPhosphorHeightForTray(trayOpen, {
      gpus,
      gpuMask,
      inlineActions: true,
    });

    display.dataset.fusionHeightManaged = "";
    if (!trayOpen) display.setAttribute("data-fusion-tray-stowed", "");
    else display.removeAttribute("data-fusion-tray-stowed");

    display.style.height = `${heightPx}px`;
    display.style.minHeight = `${heightPx}px`;
    display.style.maxHeight = `${heightPx}px`;
  };

  /* Before paint — avoid one frame of stowed height with an open tray after HMR */
  useLayoutEffect(() => {
    applyFusionDisplayHeight();
  }, [fusionOverlayActive, engineStatus, benchTrayOpen, gpus, gpuMask]);

  /* HMR: forecast ResizeObserver or effect teardown can clear height after layout */
  useEffect(() => {
    if (!fusionOverlayActive) return;
    let raf1 = 0;
    let raf2 = 0;
    raf1 = requestAnimationFrame(() => {
      applyFusionDisplayHeight();
      raf2 = requestAnimationFrame(applyFusionDisplayHeight);
    });
    return () => {
      cancelAnimationFrame(raf1);
      cancelAnimationFrame(raf2);
    };
  }, [fusionOverlayActive, engineStatus, benchTrayOpen, gpus, gpuMask]);

  // Mode toggle is UI state — layout follows prop, not manifest snapshot dedup.
  const showDetailedForecast = fitLaunchAvailable
    ? !fullAutoMode
    : (manifest?.style.uiTemplate.showDetailedForecast !== false);

  const forecastContentKey = manifest
    ? `${manifest.scenario}|${manifest.gpuAllocations.length}|${manifest.memorySource?.kind ?? ""}|${showDetailedForecast ? 1 : 0}|${fullAutoMode ? "auto" : "assist"}`
    : "";

  useForecastContentHeight(
    rootRef,
    !!manifest && !fusionOverlayActive,
    forecastContentKey,
  );

  const fitLaunchToggle = fitLaunchAvailable ? (
    <FitLaunchToggle
      available={fitLaunchAvailable}
      fullAuto={fullAutoMode}
      onChange={(fullAuto) => onFitLaunchChange?.(fullAuto)}
    />
  ) : null;

  const fitLaunchDock = fitLaunchToggle ? (
    <div className="vram-badge-fit-launch-dock" data-fit-launch-dock>
      {fitLaunchToggle}
    </div>
  ) : null;

  // Engine LOADING/RUNNING: fusion only — no forecast mount underneath (kills veil/collapse flash).
  if (fusionOverlayActive) {
    return (
      <div
        ref={rootRef}
        className={`vram-badge-forecast px-3 py-2 relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}
        data-fusion-only="1"
      >
        {fitLaunchDock}
        <VramBadgeFusionLayer
          active
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
      </div>
    );
  }

  if (!manifest) return null;

  const s = manifest.style;
  const t = s.uiTemplate;
  const memorySource = manifest.memorySource;
  const sourceAccent = memorySource
    ? MEMORY_SOURCE_ACCENT[memorySource.kind]
    : null;
  const isFitProbe = memorySource?.kind === "fit_probe";
  const displayVramNeedGb = isFitProbe
    ? manifest.validatedVramMib! / 1024
    : manifest.vramTotalGb;
  const displayRamNeedGb = isFitProbe
    ? (manifest.validatedHostMib != null && manifest.validatedHostMib > 0
        ? manifest.validatedHostMib / 1024
        : manifest.ramTotalGb)
    : manifest.ramTotalGb;
  const showRamNeed = displayRamNeedGb >= 0.05;
  const gbAccentClass = sourceAccent?.gbGradient || s.titleColor;
  const vramNeedClass = sourceAccent?.gbGradient && memorySource
    ? `${sourceAccent.gbGradient} vram-forecast-gb-accented vram-forecast-gb-accented--${memorySource.kind}`
    : gbAccentClass;

  // Total manufactured VRAM capacity across all GPUs
  const totalVramMib = gpus.reduce((sum, g) => {
    return sum + (g.memory_total_manufactured || g.memory_total);
  }, 0);
  const totalVramGb = totalVramMib / 1024;

  // Usage percentage for main VRAM bar — GPU need only, not host RAM
  const vramUsagePct = totalVramMib > 0
    ? Math.min((displayVramNeedGb * 1024 / totalVramMib) * 100, 100)
    : 0;

 // RAM headroom: available RAM minus projected RAM usage
  const ramHeadroomMib = (manifest.ramAvailableGb - manifest.ramTotalGb) * 1024;

  // RAM info for bar fill — OS usage from manufactured capacity
  const ramUsagePct = manifest.ramManufacturedGb > 0 ? Math.min((manifest.ramTotalGb / manifest.ramManufacturedGb) * 100, 100) : 0;
  const ramMfgGb = manifest.ramManufacturedGb.toFixed(0);

  const fitProbeButton = !hideFitProbe && onValidate ? (
    <FitProbeButton
      isValidating={isValidating}
      hasProbed={manifestHasFitProbe(manifest)}
      onClick={onValidate}
    />
  ) : null;

  const memorySourcePanel = memorySource ? (
    <MemorySourcePanel
      memorySource={memorySource}
      isValidating={isValidating}
      hasProbed={manifestHasFitProbe(manifest)}
      onValidate={onValidate}
      hideValidate
    />
  ) : null;

  // Fit probe + memory source stay in forecast body; ASSISTED/FULL AUTO is the top dock.
  const forecastFitRow = (memorySourcePanel || fitProbeButton) ? (
    <div className="vram-forecast-header__fit-row">
      {fitProbeButton && (
        <div className="vram-forecast-header__fit-controls">
          {fitProbeButton}
        </div>
      )}
      {memorySourcePanel && (
        <div className="vram-forecast-source min-w-0 flex-1">
          {memorySourcePanel}
        </div>
      )}
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      className={`vram-badge-forecast px-3 py-2 relative flex flex-col min-h-0 overflow-hidden ${className || ""}${
        fitLaunchAvailable ? " vram-badge-forecast--fit-dock" : ""
      }`}
    >
      {fitLaunchDock}

      {/* FORECAST header — detailed (ASSISTED) or compact (FULL AUTO) */}
      {showDetailedForecast ? (
        <div className="vram-forecast-header vram-forecast-header--assisted flex-shrink-0 mb-1 min-w-0">
          <div
            className="vram-forecast-header__top grid gap-x-1 min-w-0"
            style={{ gridTemplateColumns: "auto 1fr" }}
          >
            <span className={`text-xl font-mono ${s.titleColor} shrink-0`}>
              FORECAST: model
            </span>
            <div className="vram-forecast-needs min-w-0">
              <div className="flex flex-wrap items-baseline gap-x-1 gap-y-px min-w-0 vram-forecast-needs-row">
                <span className={`text-xl font-mono ${s.titleColor}`}>needs</span>
                <span className={`text-xl font-mono vram-forecast-gb-value ${vramNeedClass}`}>
                  {displayVramNeedGb.toFixed(1)}
                </span>
                <span className={`text-xl font-mono ${s.titleColor}`}>GB</span>
                <span className="text-[9px] font-mono text-stealth-muted">of</span>
                <span className="text-xl font-mono text-stealth-muted vram-forecast-gb-value">
                  {totalVramGb.toFixed(1)}
                </span>
                <span className="text-xl font-mono text-stealth-muted">GB</span>
                <span className="text-[9px] font-mono text-stealth-muted tracking-wide">VRAM</span>
                {showRamNeed ? (
                  <>
                    <span className="vram-forecast-needs-sep text-[9px] font-mono text-stealth-muted/50">//</span>
                    <span className="text-xl font-mono text-blue-400 vram-forecast-gb-value">
                      {displayRamNeedGb.toFixed(1)}
                    </span>
                    <span className="text-xl font-mono text-blue-400">GB</span>
                    <span className="text-[9px] font-mono text-stealth-muted">of</span>
                    <span className="text-xl font-mono text-stealth-muted vram-forecast-gb-value">
                      {manifest.ramManufacturedGb.toFixed(1)}
                    </span>
                    <span className="text-xl font-mono text-stealth-muted">GB</span>
                    <span className="text-[9px] font-mono text-blue-400/80 tracking-wide">RAM</span>
                  </>
                ) : null}
              </div>
            </div>
          </div>
          {forecastFitRow}
        </div>
      ) : (
        <div className="vram-forecast-hero flex-shrink-0 mb-1 min-w-0">
          <p className={`vram-forecast-hero__title font-mono tracking-[0.18em] uppercase ${s.titleColor}`}>
            {t.heroText ?? (manifest.fits ? "WILL LAUNCH" : "WON'T LAUNCH")}
          </p>
          {/* Full Auto: one plain remain% line (Assisted-style muted type) — no GB tables */}
          {fullAutoMode && manifest.fits && totalVramMib > 0 && (
            <p className="vram-forecast-hero__sub text-[9px] font-mono text-stealth-muted/80 leading-snug mt-1">
              {Math.max(0, Math.round(100 - vramUsagePct))}% total VRAM remains
            </p>
          )}
          {(t.heroSubtext || (showDetailedForecast && manifest.recommendation)) && (
            <p className="vram-forecast-hero__sub text-[9px] font-mono text-stealth-muted/80 leading-snug mt-1">
              {t.heroSubtext || manifest.recommendation}
            </p>
          )}
          {forecastFitRow}
        </div>
      )}

      <div className="absolute top-0 right-2 opacity-75 vram-forecast-scenario-badge">
        <div className={`inline-flex items-center px-2 py-0.5 rounded-sm ${s.badgeBg}`}>
          <span className="text-[8px] font-mono tracking-wide uppercase">{s.label}</span>
        </div>
      </div>

      <div className="vram-badge-body relative flex-shrink-0 overflow-x-hidden mt-1.5">
        {showDetailedForecast && (
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
        {/* GPU / VRAM bar row */}
        <div className="flex items-center gap-2">
          <div
            style={{ backgroundColor: "rgb(20,20,20)" }}
            className="vram-forecast-vram-bar relative h-4 w-[70%] rounded-sm overflow-hidden border border-stealth-border/30"
          >
            <div
              style={{ width: `${vramUsagePct}%` }}
              className={`h-full rounded-sm ${s.gpuBarColor}`}
            />
            {t.kvSpillRiskText && (
              <span
                className={`vram-forecast-bar__inset-label${
                  s.kvSpillCritical
                    ? " vram-forecast-bar__inset-label--kv-critical"
                    : " vram-forecast-bar__inset-label--kv"
                }`}
                title={`${t.kvSpillRiskText} — verify with test run`}
              >
                {t.kvSpillRiskText}
              </span>
            )}
          </div>
          <span className={`text-[12px] font-mono ${s.titleColor}`}>| {totalVramGb.toFixed(0)} GB</span>
        </div>

        {/* GPU layer info */}
        <p className={`system-console-mono vram-forecast-layer-text ${s.titleColor} mt-0.5`}>
          {t.gpuLayerText}
        </p>

        {/* RAM bar row */}
        {(t.showRamBar !== false) && (
          <>
            <div className="flex items-center gap-2 mt-1.5">
              <div
                style={{ backgroundColor: "rgb(20,20,20)" }}
                className="vram-forecast-ram-bar relative h-4 w-[70%] rounded-sm overflow-hidden border border-stealth-border/30"
              >
                <div
                  style={{ width: `${ramUsagePct}%` }}
                  className={`h-full rounded-sm ${
                    (t.moeRamBar || offloadMode === "moe_optimal") ? "bg-orange-hatched" : "bg-blue-700"
                  }`}
                />
                {t.offloadWarningText && (
                  <span
                    className="vram-forecast-bar__inset-label vram-forecast-bar__inset-label--ram"
                    title={t.offloadWarningText}
                  >
                    {t.offloadWarningText}
                  </span>
                )}
              </div>
              <span className="text-[12px] font-mono text-blue-700">| {ramMfgGb} GB</span>
            </div>

            {/* RAM layer info — text from scenario */}
            <p className="system-console-mono vram-forecast-layer-text text-blue-700 mt-0.5">
              {t.ramLayerText}
            </p>
          </>
        )}
        </div>
        )}

      {manifest.gpuAllocations.length > 0 && (
        <div className="mt-1.5 pb-0.5">
          <GpuTopology
            gpuAllocations={manifest.gpuAllocations}
            gpuBarColor={s.gpuBarColor}
            ramVisible={false}
            ramTotalGb={manifest.ramTotalGb}
            ramManufacturedGb={manifest.ramManufacturedGb}
            gpuIdleBaselineMib={gpuIdleBaselineMib}
            selectedGpuIndices={selectedGpuIndices}
            onDeviceSelect={onDeviceSelect}
          />
        </div>
      )}
      </div>
    </div>
  );
}
