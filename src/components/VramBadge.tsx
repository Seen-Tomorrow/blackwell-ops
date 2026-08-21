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
import MemorySourcePanel, {
  MemorySourceLiveFloat,
  MemorySourceReprobe,
  MemorySourceStatusMark,
  getMemorySourceView,
} from "./MemorySourcePanel";
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

  // SOURCE identity only (lab + kind). Status lives in NEED frame; live controls float top-right.
  const forecastSourceRow = memorySource ? (
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

  const sourceView = memorySource
    ? getMemorySourceView(memorySource, {
        onValidate: hideFitProbe ? undefined : onValidate,
        hideValidate: hideFitProbe || !onValidate,
      })
    : null;

  const displayVramNeedGb = manifest.vramTotalGb;
  const displayRamNeedGb = isFitProbe
    ? (manifest.validatedHostMib != null && manifest.validatedHostMib > 0
        ? manifest.validatedHostMib / 1024
        : manifest.ramTotalGb)
    : manifest.ramTotalGb;
  const showRamBar = t.showRamBar !== false;

  // Total manufactured VRAM capacity across all GPUs
  const totalVramMib = gpus.reduce((sum, g) => {
    return sum + (g.memory_total_manufactured || g.memory_total);
  }, 0);
  const totalVramGb = totalVramMib / 1024;

  // Usage percentage for main VRAM bar — forecast need vs manufactured pool
  const vramUsagePct = totalVramMib > 0
    ? Math.min((displayVramNeedGb * 1024 / totalVramMib) * 100, 100)
    : 0;

  // RAM info for bar fill — OS usage from manufactured capacity
  const ramUsagePct = manifest.ramManufacturedGb > 0 ? Math.min((manifest.ramTotalGb / manifest.ramManufacturedGb) * 100, 100) : 0;

  /*
   * NEED hero pressure — same formula as GpuTopology card %:
   *   (projectedLoad + alreadyUsed) / manufactured
   * Worst GPU drives the tone (ok ≤85, warn ≤95, hot >95).
   * Do NOT use need/total alone — ignores resident used and stays neutral.
   */
  const pressureTone = (pct: number): "ok" | "warn" | "hot" =>
    pct > 95 ? "hot" : pct > 85 ? "warn" : "ok";

  const vramNeedTone = (() => {
    const allocs = manifest.gpuAllocations ?? [];
    if (allocs.length > 0) {
      let worst = 0;
      for (const a of allocs) {
        const totalMib = a.vramManufacturedGb * 1024;
        if (!(totalMib > 0)) continue;
        const usedMib = Math.max(0, (a.vramManufacturedGb - a.vramAvailableGb) * 1024);
        const pct = Math.min(((a.projectedLoadGb * 1024 + usedMib) / totalMib) * 100, 100);
        if (pct > worst) worst = pct;
      }
      return pressureTone(worst);
    }
    return pressureTone(vramUsagePct);
  })();
  const ramNeedTone = pressureTone(ramUsagePct);

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
    <div className="vram-fc-measure relative">
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

      <div className="vram-fc-measure__main">
        {/* SOURCE identity + live meter — light grey strip; frame spans up beside it */}
        {forecastSourceRow || memorySource ? (
          <div className="vram-fc-measure__source">
            {forecastSourceRow}
            {memorySource && !hideFitProbe ? (
              <MemorySourceLiveFloat
                memorySource={memorySource}
                isValidating={isValidating}
                onValidate={onValidate}
                hideValidate={!onValidate}
              />
            ) : null}
          </div>
        ) : (
          <div className="vram-fc-measure__source vram-fc-measure__source--empty" aria-hidden />
        )}

        <div className="vram-fc-measure__rails vram-fc-bars vram-badge-bars vram-fc-bars--assisted">
          <div className="vram-fc-bar-row vram-fc-bar-row--vram">
            <div
              className="vram-fc-bar vram-fc-bar--fused vram-fc-bar--track-only vram-forecast-vram-bar"
              aria-label={`VRAM ${displayVramNeedGb.toFixed(1)} of ${totalVramGb.toFixed(1)} GB`}
            >
              <span className="vram-fc-bar__name-chip">
                <span className="vram-fc-bar__name-lab">VRAM</span>
                <span className="vram-fc-bar__name-total">total</span>
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
            </div>
          </div>

          {showRamBar && (
            <div className="vram-fc-bar-row vram-fc-bar-row--ram">
              <div
                className="vram-fc-bar vram-fc-bar--fused vram-fc-bar--track-only vram-forecast-ram-bar"
                aria-label={`RAM ${displayRamNeedGb.toFixed(1)} of ${manifest.ramManufacturedGb.toFixed(1)} GB`}
              >
                <span className="vram-fc-bar__name-chip vram-fc-bar__name-chip--ram">
                  <span className="vram-fc-bar__name-lab">RAM</span>
                  <span className="vram-fc-bar__name-total">total</span>
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
              </div>
            </div>
          )}
        </div>

        {/* Status above; VRAM/RAM needs aligned to bars */}
        <div
          className="vram-fc-need-frame"
          data-source-kind={sourceKind ?? undefined}
          data-exact={sourceView?.isExact ? "1" : sourceView ? "0" : undefined}
          data-has-status={sourceView?.showStatus ? "1" : "0"}
          data-has-ram={showRamBar ? "1" : "0"}
          data-has-probe={
            memorySource && sourceView?.canProbe && !hideFitProbe ? "1" : "0"
          }
        >
          {memorySource && sourceView?.showStatus ? (
            <MemorySourceStatusMark memorySource={memorySource} />
          ) : (
            <div className="vram-fc-need-frame__status-row vram-fc-need-frame__status-row--empty" aria-hidden />
          )}

          <span
            className="vram-fc-bar__need-chip vram-fc-need-frame__need vram-fc-need-frame__need--vram"
            data-need-tone={vramNeedTone}
            title="Projected VRAM need"
          >
            <span className="vram-fc-bar__need-prefix">need</span>
            <span className={`vram-fc-bar__need vram-fc-bar__need--${vramNeedTone}`}>
              {displayVramNeedGb.toFixed(1)}
            </span>
            <span className="vram-fc-bar__unit">GB</span>
          </span>

          {showRamBar ? (
            <span
              className="vram-fc-bar__need-chip vram-fc-bar__need-chip--ram vram-fc-need-frame__need vram-fc-need-frame__need--ram"
              data-need-tone={ramNeedTone}
              title="Host RAM need"
            >
              <span className="vram-fc-bar__need-prefix">need</span>
              <span className={`vram-fc-bar__need vram-fc-bar__need--${ramNeedTone}`}>
                {displayRamNeedGb.toFixed(1)}
              </span>
              <span className="vram-fc-bar__unit">GB</span>
            </span>
          ) : null}
        </div>
      </div>
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
          {memorySource && !hideFitProbe ? (
            <MemorySourceReprobe
              memorySource={memorySource}
              isValidating={isValidating}
              onValidate={onValidate}
              hideValidate={!onValidate}
            />
          ) : null}
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
