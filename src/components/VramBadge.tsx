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
import MemorySourcePanel, { manifestHasFitProbe } from "./MemorySourcePanel";
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
        <div className="vram-forecast-measuring flex flex-1 min-h-0 items-stretch justify-between gap-2 sm:gap-4 w-full">
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

          <div className="vram-forecast-measuring__center flex flex-col items-center justify-center gap-2.5 min-w-0 self-center">
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
  const assistedLaunchSummary =
    t.launchSummary || t.heroText || s.label;

  // SOURCE · KIND · RE-PROBE (inline). GPU/host/tooling detail is hover recap only.
  const forecastSourceRow = memorySource && !hideFitProbe ? (
    <div className="vram-fc__source-row vram-forecast-header__fit-row">
      <div className="vram-forecast-source min-w-0 flex-1">
        <MemorySourcePanel
          memorySource={memorySource}
          manifest={manifest}
          isValidating={isValidating}
          hasProbed={manifestHasFitProbe(manifest)}
          onValidate={onValidate}
          hideValidate={!onValidate}
          compact
          launchSummary={showDetailedForecast ? assistedLaunchSummary : undefined}
        />
      </div>
    </div>
  ) : memorySource ? (
    <div className="vram-fc__source-row vram-forecast-header__fit-row">
      <div className="vram-forecast-source min-w-0 flex-1">
        <MemorySourcePanel
          memorySource={memorySource}
          manifest={manifest}
          compact
          launchSummary={showDetailedForecast ? assistedLaunchSummary : undefined}
        />
      </div>
    </div>
  ) : null;

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

  /** Scenario identity chip — FULL AUTO top-right only. */
  const scenarioChip = (
    <span className="vram-fc__ident vram-forecast-scenario-badge">
      <span className={`vram-fc__scenario ${s.badgeBg}`}>
        <span className="vram-fc__scenario-lab">{s.label}</span>
      </span>
    </span>
  );

  const remainPct =
    manifest.fits && totalVramMib > 0
      ? Math.max(0, Math.round(100 - vramUsagePct))
      : null;

  const barBank = showDetailedForecast ? (
    <div className="vram-fc-bars vram-badge-bars vram-fc-bars--assisted relative">
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
        <div
          className="vram-fc-bar vram-fc-bar--fused vram-forecast-vram-bar"
          aria-label={`VRAM ${displayVramNeedGb.toFixed(1)} of ${totalVramGb.toFixed(1)} GB`}
        >
          <span className="vram-fc-bar__name-chip">
            <span className="vram-fc-bar__name-lab">VRAM</span>
            <span className="vram-fc-bar__name-total">
              total <span className="vram-fc-bar__name-total-val">{totalVramGb.toFixed(1)}</span>
            </span>
          </span>
          <span className="vram-fc-bar__cap-chip" title="Free pool capacity">
            <span className="vram-fc-bar__cap-val">{totalVramGb.toFixed(1)}</span>
            <span className="vram-fc-bar__cap-unit">GB</span>
          </span>
          <div className="vram-fc-bar__track">
            <div
              className={`vram-fc-bar__fill vram-fc-bar__fill--bevel ${s.gpuBarColor}`}
              style={{ width: `${vramUsagePct}%` }}
            />
          </div>
          <span
            className={`vram-fc-bar__need-chip${
              sourceKind ? ` vram-forecast-gb-accented vram-forecast-gb-accented--${sourceKind}` : ""
            }`}
            title="Projected need"
          >
            <span className="vram-fc-bar__need-prefix">need</span>
            <span className="vram-fc-bar__need">{displayVramNeedGb.toFixed(1)}</span>
            <span className="vram-fc-bar__unit">GB</span>
          </span>
        </div>
      </div>

      {t.showRamBar !== false && (
        <div className="vram-fc-bar-row vram-fc-bar-row--ram">
          <div
            className="vram-fc-bar vram-fc-bar--fused vram-forecast-ram-bar"
            aria-label={`RAM ${displayRamNeedGb.toFixed(1)} of ${manifest.ramManufacturedGb.toFixed(1)} GB`}
          >
            <span className="vram-fc-bar__name-chip vram-fc-bar__name-chip--ram">
              <span className="vram-fc-bar__name-lab">RAM</span>
              <span className="vram-fc-bar__name-total">
                total <span className="vram-fc-bar__name-total-val">{manifest.ramManufacturedGb.toFixed(1)}</span>
              </span>
            </span>
            <span className="vram-fc-bar__cap-chip vram-fc-bar__cap-chip--ram" title="Installed RAM">
              <span className="vram-fc-bar__cap-val">{manifest.ramManufacturedGb.toFixed(1)}</span>
              <span className="vram-fc-bar__cap-unit">GB</span>
            </span>
            <div className="vram-fc-bar__track">
              <div
                className={`vram-fc-bar__fill vram-fc-bar__fill--bevel ${
                  t.moeRamBar || offloadMode === "moe_optimal" ? "bg-orange-hatched" : "bg-blue-700"
                }`}
                style={{ width: `${ramUsagePct}%` }}
              />
            </div>
            <span className="vram-fc-bar__need-chip vram-fc-bar__need-chip--ram" title="Host need">
              <span className="vram-fc-bar__need-prefix">need</span>
              <span className="vram-fc-bar__need">{displayRamNeedGb.toFixed(1)}</span>
              <span className="vram-fc-bar__unit">GB</span>
            </span>
          </div>
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
          <p
            className={`vram-fc__launch-summary${manifest.fits ? " is-ok" : " is-fail"}`}
            title={assistedLaunchSummary}
          >
            {assistedLaunchSummary}
          </p>
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

      <div
        className={`vram-badge-body vram-fc__body relative min-h-0 overflow-hidden${
          showDetailedForecast ? " vram-fc__body--assisted" : ""
        }`}
      >
        {barBank}

        {manifest.gpuAllocations.length > 0 && (
          <div className={`vram-fc__topo${showDetailedForecast ? " vram-fc__topo--compact" : ""}`}>
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
