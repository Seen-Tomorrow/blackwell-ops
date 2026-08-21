import { useEffect, useLayoutEffect, useRef } from "react";
import type { GpuInfo, VramManifest, ModelMetadata } from "../lib/types";
import { computeDualStackPhosphorHeightForTray, computeFusionPhosphorHeightForTray } from "../lib/benchPanelLayout";
import { getFusionBenchTrayOpen, refreshFusionBenchTrayFromStorage } from "../lib/fusionBenchTrayStore";
import { FORECAST_PHOSPHOR_HEIGHT_PX } from "../lib/onboardingDisplay";
import { useFusionBenchTray } from "../hooks/useFusionBenchTray";
import GpuTopology from "./GpuTopology";
import FusionPane from "./FusionPane";
import FusionDualStage, { type FusionPaneIdentity } from "./FusionDualStage";
import MoeBadge from "./MoeBadge";
import FitLaunchToggle from "./FitLaunchToggle";
import MemorySourcePanel, { FitProbeButton, manifestHasFitProbe } from "./MemorySourcePanel";
import { useForecastContentHeight } from "../hooks/useForecastContentHeight";
import type { FusionShareLaunchConfig } from "../lib/fusionShareCapture";
import type { FusionDualOrient } from "../lib/storage";


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
  /** Forecast GPU bars per row (bezel density). */
  gpuPerRow?: 2 | 3;
  /** Dual fusion active (two live panes). */
  dualActive?: boolean;
  dualOrient?: FusionDualOrient;
  /** Secondary pane identity when dualActive. */
  secondaryPane?: FusionPaneIdentity | null;
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
  gpuPerRow = 2,
  dualActive = false,
  dualOrient = "side",
  secondaryPane = null,
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
      display.dataset.fusionHeightManaged = "";
      display.removeAttribute("data-fusion-tray-stowed");
      display.removeAttribute("data-fusion-boot");
      display.style.height = `${FORECAST_PHOSPHOR_HEIGHT_PX}px`;
      display.style.minHeight = `${FORECAST_PHOSPHOR_HEIGHT_PX}px`;
      display.style.maxHeight = `${FORECAST_PHOSPHOR_HEIGHT_PX}px`;
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
    const heightOpts = {
      gpus,
      gpuMask,
      inlineActions: true as const,
    };
    // Stack dual = two full hero+tray panes; side shares single height budget.
    let heightPx =
      dualActive && dualOrient === "stack"
        ? computeDualStackPhosphorHeightForTray(trayOpen, heightOpts)
        : computeFusionPhosphorHeightForTray(trayOpen, heightOpts);

    display.dataset.fusionHeightManaged = "";
    if (dualActive) display.setAttribute("data-fusion-dual", dualOrient);
    else display.removeAttribute("data-fusion-dual");
    if (!trayOpen) display.setAttribute("data-fusion-tray-stowed", "");
    else display.removeAttribute("data-fusion-tray-stowed");

    display.style.height = `${heightPx}px`;
    display.style.minHeight = `${heightPx}px`;
    display.style.maxHeight = `${heightPx}px`;
  };

  /* Before paint — avoid one frame of stowed height with an open tray after HMR */
  useLayoutEffect(() => {
    applyFusionDisplayHeight();
  }, [fusionOverlayActive, engineStatus, benchTrayOpen, gpus, gpuMask, dualActive, dualOrient]);

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
  }, [fusionOverlayActive, engineStatus, benchTrayOpen, gpus, gpuMask, dualActive, dualOrient]);

  // Mode toggle is UI state — layout follows prop, not manifest snapshot dedup.
  const showDetailedForecast = fitLaunchAvailable
    ? !fullAutoMode
    : (manifest?.style.uiTemplate.showDetailedForecast !== false);

  // Structural layout only — ignore memory-source kind (SOURCE band is fixed 3 lines).
  // Kind changes formula→learned used to re-pin phosphor and nudge height by a row.
  const forecastContentKey = manifest
    ? `${manifest.gpuAllocations.length}|${showDetailedForecast ? 1 : 0}|${fullAutoMode ? "auto" : "assist"}|${gpus.length}`
    : "";

  useForecastContentHeight(
    rootRef,
    false,
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
  // No px/py inset: glass is full phosphor-screen-inner; content pads itself.
  if (fusionOverlayActive) {
    const primaryPane: FusionPaneIdentity = {
      slotIdx: selectedSlotIdx,
      alias: activeEngineAlias,
      enginePort: activeEnginePort,
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
    };
    return (
      <div
        ref={rootRef}
        className={`vram-badge-forecast relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}
        data-fusion-only="1"
        data-fusion-dual={dualActive ? dualOrient : undefined}
      >
        {fitLaunchDock}
        {dualActive && secondaryPane ? (
          <FusionDualStage
            orient={dualOrient}
            primary={primaryPane}
            secondary={secondaryPane}
          />
        ) : (
          <FusionPane {...primaryPane} active />
        )}
      </div>
    );
  }

  if (!manifest) {
    return (
      <div
        ref={rootRef}
        className={`vram-badge-forecast vram-fc vram-badge-forecast--skeleton px-3 py-2 relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}
        style={{ minHeight: FORECAST_PHOSPHOR_HEIGHT_PX }}
        data-forecast-skeleton="1"
        aria-busy="true"
        aria-label="Evaluating VRAM footprint"
      >
        {fitLaunchDock}
        <div className="vram-forecast-measuring flex flex-1 min-h-0 items-center justify-center gap-3 px-1">
          <div className="vram-forecast-measuring__flank vram-forecast-measuring__flank--left font-mono" aria-hidden>
            <span className="vram-forecast-measuring__flank-label">GPU</span>
            <span className="vram-forecast-measuring__ladder">
              <i /><i /><i /><i /><i /><i /><i /><i />
            </span>
            <span className="vram-forecast-measuring__flank-readout">SCAN</span>
            <span className="vram-forecast-measuring__flank-meter">
              <span className="vram-forecast-measuring__flank-meter-fill" />
            </span>
          </div>

          <div className="vram-forecast-measuring__center flex flex-col items-center justify-center gap-2 min-w-0">
            <div className="vram-forecast-measuring__scope" aria-hidden>
              <span className="vram-forecast-measuring__ring" />
              <span className="vram-forecast-measuring__ring vram-forecast-measuring__ring--delay" />
              <span className="vram-forecast-measuring__beam" />
              <span className="vram-forecast-measuring__core font-mono">VRAM</span>
            </div>
            <div className="vram-forecast-measuring__copy font-mono">
              <span className="vram-forecast-measuring__title">EVALUATING</span>
              <span className="vram-forecast-measuring__sub">footprint · learned · fit probe</span>
            </div>
            <div className="vram-forecast-measuring__bar" aria-hidden>
              <span className="vram-forecast-measuring__bar-fill" />
            </div>
          </div>

          <div className="vram-forecast-measuring__flank vram-forecast-measuring__flank--right font-mono" aria-hidden>
            <span className="vram-forecast-measuring__flank-label">CTX</span>
            <span className="vram-forecast-measuring__ladder">
              <i /><i /><i /><i /><i /><i /><i /><i />
            </span>
            <span className="vram-forecast-measuring__flank-readout">MAP</span>
            <span className="vram-forecast-measuring__flank-meter">
              <span className="vram-forecast-measuring__flank-meter-fill vram-forecast-measuring__flank-meter-fill--rev" />
            </span>
          </div>
        </div>
      </div>
    );
  }

  const s = manifest.style;
  const t = s.uiTemplate;
  const memorySource = manifest.memorySource;
  const sourceKind = memorySource?.kind;
  const isFitProbe = sourceKind === "fit_probe";
  const displayVramNeedGb = manifest.vramTotalGb;
  const displayRamNeedGb = isFitProbe
    ? (manifest.validatedHostMib != null && manifest.validatedHostMib > 0
        ? manifest.validatedHostMib / 1024
        : manifest.ramTotalGb)
    : manifest.ramTotalGb;
  const showRamNeed = displayRamNeedGb >= 0.05;

  // Total manufactured VRAM capacity across all GPUs
  const totalVramMib = gpus.reduce((sum, g) => {
    return sum + (g.memory_total_manufactured || g.memory_total);
  }, 0);
  const totalVramGb = totalVramMib / 1024;

  // Usage percentage for main VRAM bar — GPU need only, not host RAM
  const vramUsagePct = totalVramMib > 0
    ? Math.min((displayVramNeedGb * 1024 / totalVramMib) * 100, 100)
    : 0;

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
      manifest={manifest}
      isValidating={isValidating}
      hasProbed={manifestHasFitProbe(manifest)}
      onValidate={onValidate}
      hideValidate
      compact={!showDetailedForecast}
    />
  ) : null;

  // FULL AUTO: one-line SOURCE. ASSISTED: full breakdown stack.
  const forecastSourceRow = (memorySourcePanel || fitProbeButton) ? (
    <div className="vram-fc__source-row vram-forecast-header__fit-row">
      {fitProbeButton && (
        <div className="vram-fc__probe-slot vram-forecast-header__fit-controls">
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

  /** Scenario identity chip — FULL AUTO top-right. */
  const scenarioChip = (
    <span className="vram-fc__ident vram-forecast-scenario-badge">
      <span className={`vram-fc__scenario ${s.badgeBg}`}>
        <span className="vram-fc__scenario-lab">{s.label}</span>
      </span>
    </span>
  );

  /** ASSISTED: scenario replaces the FORECAST wordmark. */
  const forecastScenarioTitle = (
    <span
      className={`vram-fc__title vram-fc__title--scenario vram-forecast-scenario-badge ${s.badgeBg}`}
      title={s.label}
    >
      <span className="vram-fc__scenario-lab">{s.label}</span>
    </span>
  );


  const remainPct =
    manifest.fits && totalVramMib > 0
      ? Math.max(0, Math.round(100 - vramUsagePct))
      : null;

  const needInstruments = (
    <div className="vram-fc__need-row vram-forecast-needs" data-source-kind={sourceKind || "pending"}>
      <div className="vram-fc-need" aria-label="VRAM need">
        <span className="vram-fc-need__lab">VRAM</span>
        <span
          className={`vram-fc-need__val vram-forecast-gb-value${
            sourceKind
              ? ` vram-forecast-gb-accented vram-forecast-gb-accented--${sourceKind}`
              : ""
          }`}
        >
          {displayVramNeedGb.toFixed(1)}
        </span>
        <span className="vram-fc-need__unit">GB</span>
        <span className="vram-fc-need__of">of</span>
        <span className="vram-fc-need__cap vram-forecast-gb-value">{totalVramGb.toFixed(1)}</span>
        <span className="vram-fc-need__unit vram-fc-need__unit--muted">GB</span>
      </div>
      {showRamNeed ? (
        <>
          <span className="vram-fc-need__sep vram-forecast-needs-sep" aria-hidden>
            //
          </span>
          <div className="vram-fc-need vram-fc-need--ram" aria-label="RAM need">
            <span className="vram-fc-need__lab">RAM</span>
            <span className="vram-fc-need__val vram-forecast-gb-value">
              {displayRamNeedGb.toFixed(1)}
            </span>
            <span className="vram-fc-need__unit vram-fc-need__unit--ram">GB</span>
            <span className="vram-fc-need__of">of</span>
            <span className="vram-fc-need__cap vram-forecast-gb-value">
              {manifest.ramManufacturedGb.toFixed(1)}
            </span>
            <span className="vram-fc-need__unit vram-fc-need__unit--muted">GB</span>
          </div>
        </>
      ) : null}
    </div>
  );

  const barBank = showDetailedForecast ? (
    <div className="vram-fc-bars vram-badge-bars vram-fc-bars--split relative">
      {!hideMoeBadge && modelMeta != null && modelMeta.n_expert > 0 && (
        <div className="absolute right-0 -top-5 flex items-center z-10">
          <MoeBadge
            offloadMode={offloadMode}
            shouldHighlight={manifest.moeSuggestion?.shouldHighlight}
            onMoeSuggestionClick={onMoeSuggestionClick}
            suggestionText={manifest.moeSuggestion?.suggestionText}
          />
        </div>
      )}

      <div className="vram-fc-bar-row vram-fc-bar-row--vram">
        <span className="vram-fc-bar__lab">VRAM</span>
        <div className="vram-fc-bar vram-forecast-vram-bar" aria-label="VRAM fill">
          <div className="vram-fc-bar__track">
            <div
              className={`vram-fc-bar__fill ${s.gpuBarColor}`}
              style={{ width: `${vramUsagePct}%` }}
            />
          </div>
        </div>
        <span className={`vram-fc-bar__cap ${s.titleColor}`}>
          {totalVramGb.toFixed(0)} GB
        </span>
      </div>

      {t.showRamBar !== false && (
        <div className="vram-fc-bar-row vram-fc-bar-row--ram">
          <span className="vram-fc-bar__lab vram-fc-bar__lab--ram">RAM</span>
          <div className="vram-fc-bar vram-forecast-ram-bar" aria-label="RAM fill">
            <div className="vram-fc-bar__track">
              <div
                className={`vram-fc-bar__fill ${
                  t.moeRamBar || offloadMode === "moe_optimal" ? "bg-orange-hatched" : "bg-blue-700"
                }`}
                style={{ width: `${ramUsagePct}%` }}
              />
            </div>
          </div>
          <span className="vram-fc-bar__cap vram-fc-bar__cap--ram">{ramMfgGb} GB</span>
        </div>
      )}
    </div>
  ) : null;

  const heroText =
    t.heroText ?? (manifest.fits ? "Your model will launch ALRIGHT" : "WON'T LAUNCH");

  return (
    <div
      ref={rootRef}
      className={`vram-badge-forecast vram-fc relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}
      data-forecast-mode={showDetailedForecast ? "assisted" : "auto"}
      data-fits={manifest.fits ? "1" : "0"}
      data-source-kind={sourceKind || undefined}
    >
      {fitLaunchDock}

      {showDetailedForecast ? (
        <div className="vram-fc__header vram-forecast-header vram-forecast-header--assisted flex-shrink-0 min-w-0">
          <div className="vram-fc__title-row">
            {forecastScenarioTitle}
            <span
              className={`vram-fc__verdict${manifest.fits ? " is-ok" : " is-fail"}`}
              title={manifest.fits ? "Projected fit" : "Projected no-fit"}
            >
              {manifest.fits ? "FITS" : "WON'T"}
            </span>
          </div>
          {needInstruments}
          {forecastSourceRow}
        </div>
      ) : (
        <div className="vram-fc__header vram-fc-auto vram-forecast-hero flex-shrink-0 min-w-0">
          <div className="vram-fc-auto__top">
            <p className={`vram-fc-auto__headline ${s.titleColor}`}>{heroText}</p>
            {scenarioChip}
          </div>

          {remainPct != null ? (
            <p className="vram-fc-auto__remain" aria-label={`${remainPct} percent total VRAM remains`}>
              <span className="vram-fc-auto__pct">{remainPct}%</span>
              <span className="vram-fc-auto__pct-lab">total VRAM remains</span>
            </p>
          ) : (
            <p
              className={`vram-fc-auto__remain vram-fc-auto__remain--fail${
                t.heroSubtext || manifest.recommendation ? "" : " vram-forecast-hero__sub--placeholder"
              }`}
            >
              <span className="vram-fc-auto__fail-lab">
                {t.heroSubtext || manifest.recommendation || "\u00a0"}
              </span>
            </p>
          )}

          {forecastSourceRow}
        </div>
      )}

      <div className="vram-badge-body vram-fc__body relative min-h-0 overflow-hidden">
        {barBank}

        {manifest.gpuAllocations.length > 0 && (
          <div className="vram-fc__topo">
            <GpuTopology
              gpuAllocations={manifest.gpuAllocations}
              gpuBarColor={s.gpuBarColor}
              ramVisible={false}
              ramTotalGb={manifest.ramTotalGb}
              ramManufacturedGb={manifest.ramManufacturedGb}
              gpuIdleBaselineMib={gpuIdleBaselineMib}
              selectedGpuIndices={selectedGpuIndices}
              onDeviceSelect={onDeviceSelect}
              perRow={gpuPerRow}
              fill
            />
          </div>
        )}
      </div>
    </div>
  );
}
