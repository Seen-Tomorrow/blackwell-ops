import { useCallback, useLayoutEffect, useMemo, useRef, useState, type RefObject } from "react";
import type {
  GpuInfo,
  ModelEntry,
  ModelMetadata,
  StackEntry,
  VramManifest,
} from "../lib/types";
import type { LaunchChromePolicy } from "../lib/launchChromePolicy";
import type { FusionShareLaunchConfig } from "../lib/fusionShareCapture";
import type { DisplayCardsPerRow, FusionDualOrient } from "../lib/storage";
import {
  loadDisplayGpuPerRow,
  loadEnginesPanelVisible,
  loadRunningEnginesPerRow,
  saveDisplayGpuPerRow,
  saveEnginesPanelVisible,
  saveRunningEnginesPerRow,
} from "../lib/storage";
import {
  computeDualStackPhosphorHeightForTray,
  computeFusionPhosphorHeightForTray,
} from "../lib/benchPanelLayout";
import { computeForecastPhosphorHeightPx } from "../lib/onboardingDisplay";
import { useFusionBenchTray } from "../hooks/useFusionBenchTray";
import { stopAllEngines } from "../lib/engineStack";
import GpuAssignPanel from "./GpuAssignPanel";
import DisplayChromeHints from "./DisplayChromeHints";
import DisplayBezelGridControls from "./DisplayBezelGridControls";
import VramBadge from "./VramBadge";
import FitLaunchToggle from "./FitLaunchToggle";
import RunningEnginesPanel from "./RunningEnginesPanel";
import { useHarnessConnectHost } from "./HarnessConnectHost";


import type { FusionPaneIdentity } from "./FusionDualStage";

/** GPU assignment / forecast data derived from the orchestrator's booter props. */
export interface EngineGpuBooterProps {
  gpuMask: string;
  vramTargetMib: number;
  modelLayerTotal: number;
  gpuLoadTargetsMib: Record<number, number>;
}

/** Provider + profile meta shown on the VRAM badge. */
export interface EngineGpuShareMeta {
  providerName?: string;
  providerBuildVersion?: string;
  profileLabel?: string;
  cudaVersion?: string;
}

/**
 * GPU assign + VRAM forecast display (the "phosphor" bezel) and the running
 * engines panel docked below it. Pure presentational structure — the
 * orchestrator owns all config/scenario state and passes slices + handlers down.
 *
 * Keeps the industrial display frame (glass / bezel) and the fusion switcher
 * in one place; `VramBadge` stays a dumb manifest renderer.
 */
export default function EngineGpuForecast(props: EngineGpuForecastProps) {
  const {
    displayMeasureRef,
    onboardingArea,
    onboardingFrame,
    displayTexture,
    fitLaunchSupported,
    fullAutoMode,
    onFitLaunchChange,
    showFitOrDeviceChrome,
    showGpuAssign,
    gpus,
    deviceValue,
    splitValue,
    splitValues,
    launchChrome,
    hideTensorSplit,
    onDeviceChange,
    onSplitChange,
    onDeviceSelect,
    showChromeHints,
    manifest,
    selectedGpuIndices,
    isValidating,
    onValidate,
    onYoloLaunch,
    isModelRunning,
    activeEngineAlias,
    activeEnginePort,
    selectedSlotIdx,
    supportsFusion,
    engineStatus,
    booterProps,
    offloadMode,
    onMoeSuggestionClick,
    hideMoeBadge,
    draftOnly = false,
    modelMeta,
    modelName,
    modelQuant,
    shareProfileMeta,
    shareLaunchConfig,
    shareHwTopo,
    gpuIdleBaselineMib,
    showEjectBelowVram,
    stack,
    models,
    onSelectEngine,
    isHotSwapStale,
    onHotSwap,
    onRelaunchSeat: onRelaunchSeatProp,

    dualActive = false,
    dualArmed = false,
    canDual = false,
    dualOrient = "side",
    onToggleDual,
    onToggleOrient,
    secondarySlotIdx = null,
    onPinSecondary,
    monitorFocus = false,
    onToggleMonitor,
  } = props;

  const [gpuPerRow, setGpuPerRow] = useState<DisplayCardsPerRow>(loadDisplayGpuPerRow);
  const [enginesPerRow, setEnginesPerRow] = useState<DisplayCardsPerRow>(
    loadRunningEnginesPerRow,
  );
  const [enginesPanelVisible, setEnginesPanelVisible] = useState(loadEnginesPanelVisible);

  const onToggleEnginesPanel = useCallback(() => {
    setEnginesPanelVisible((prev) => {
      const next = !prev;
      saveEnginesPanelVisible(next);
      return next;
    });
  }, []);
  const onRelaunchSeat = useCallback(
    async (opts: {
      slotIdx: number;
      port: number;
      alias: string;
      parallel: number;
    }) => {
      if (onRelaunchSeatProp) {
        await onRelaunchSeatProp(opts);
        return;
      }
      if (!onHotSwap) return;
      const entry = stack.find((s) => s.idx === opts.slotIdx);
      if (entry) onHotSwap({ ...entry, parallel: opts.parallel });
    },
    [onRelaunchSeatProp, onHotSwap, stack],
  );


  const harness = useHarnessConnectHost({
    stack,
    onRelaunchSeat,
    onSelectEngine,
  });



  /** Live (RUNNING/LOADING) seats — monitor-mode model switcher (eject + bezel CYCLE). */
  const liveEngineSlots = useMemo(
    () => stack.filter((s) => s.status === "RUNNING" || s.status === "LOADING"),
    [stack],
  );

  const onCycleLiveEngine = useCallback(() => {
    if (liveEngineSlots.length < 2) return;
    const pos = liveEngineSlots.findIndex((s) => s.idx === selectedSlotIdx);
    const next = liveEngineSlots[(pos + 1) % liveEngineSlots.length];
    onSelectEngine?.(next.idx);
  }, [liveEngineSlots, selectedSlotIdx, onSelectEngine]);

  const onStopAllEngines = useCallback(async () => {
    try {
      await stopAllEngines();
    } catch (err) {
      console.error("Stop all failed:", err);
    }
  }, []);

  const showStopAll = liveEngineSlots.length > 1;
  const showTopChrome = showFitOrDeviceChrome || showStopAll;

  const onGpuPerRow = useCallback((n: DisplayCardsPerRow) => {
    setGpuPerRow(n);
    saveDisplayGpuPerRow(n);
  }, []);

  const onEnginesPerRow = useCallback((n: DisplayCardsPerRow) => {
    setEnginesPerRow(n);
    saveRunningEnginesPerRow(n);
  }, []);

  const secondaryPane = useMemo((): FusionPaneIdentity | null => {
    if (!dualActive || secondarySlotIdx == null) return null;
    const entry = stack.find((s) => s.idx === secondarySlotIdx);
    if (!entry) return null;
    const model = models?.find((m) => m.path === entry.model_path);
    return {
      slotIdx: entry.idx,
      alias: entry.alias,
      enginePort: entry.port,
      supportsFusion: entry.supportsFusion !== false,
      engineStatus: entry.status,
      gpus,
      gpuMask: entry.gpu || "",
      vramTargetMib: entry.vram_mib,
      modelLayerTotal: model?.metadata?.n_layer ?? 0,
      gpuLoadTargetsMib: {},
      modelName: model?.name || entry.model_name,
      modelQuant: model?.quant,
      providerName: entry.provider_name || shareProfileMeta.providerName,
      providerBuildVersion: shareProfileMeta.providerBuildVersion,
      profileLabel: shareProfileMeta.profileLabel,
      cudaVersion: shareProfileMeta.cudaVersion,
      hwTopo: shareHwTopo,
    };
  }, [
    dualActive,
    secondarySlotIdx,
    stack,
    models,
    gpus,
    shareProfileMeta,
    shareHwTopo,
  ]);

  const displayRef = useRef<HTMLDivElement>(null);
  const { open: benchTrayOpen } = useFusionBenchTray();
  const forecastHeightPx = computeForecastPhosphorHeightPx(gpus.length, gpuPerRow);
  const fusionOverlayActive =
    selectedSlotIdx != null &&
    activeEnginePort != null &&
    (engineStatus === "LOADING" || engineStatus === "RUNNING");

  useLayoutEffect(() => {
    const display = displayRef.current;
    if (!display) return;

    const pin = (heightPx: number) => {
      display.dataset.fusionHeightManaged = "";
      display.style.height = `${heightPx}px`;
      display.style.minHeight = `${heightPx}px`;
      display.style.maxHeight = `${heightPx}px`;
    };

    if (!fusionOverlayActive) {
      display.removeAttribute("data-fusion-tray-stowed");
      display.removeAttribute("data-fusion-boot");
      display.removeAttribute("data-fusion-dual");
      pin(forecastHeightPx);
      return;
    }

    if (engineStatus === "LOADING") {
      display.setAttribute("data-fusion-boot", "");
      display.removeAttribute("data-fusion-tray-stowed");
      display.removeAttribute("data-fusion-dual");
      pin(forecastHeightPx);
      return;
    }

    display.removeAttribute("data-fusion-boot");
    const heightOpts = {
      gpus,
      gpuMask: booterProps.gpuMask,
      inlineActions: true as const,
    };
    // Dual stack: both panes own a bench tray (shared open/stow). Side = one pane height.
    const heightPx =
      dualActive && dualOrient === "stack"
        ? computeDualStackPhosphorHeightForTray(benchTrayOpen, heightOpts)
        : computeFusionPhosphorHeightForTray(benchTrayOpen, heightOpts);

    if (dualActive) display.setAttribute("data-fusion-dual", dualOrient);
    else display.removeAttribute("data-fusion-dual");
    if (!benchTrayOpen) display.setAttribute("data-fusion-tray-stowed", "");
    else display.removeAttribute("data-fusion-tray-stowed");
    pin(heightPx);
  }, [
    fusionOverlayActive,
    engineStatus,
    benchTrayOpen,
    gpus,
    booterProps.gpuMask,
    dualActive,
    dualOrient,
    forecastHeightPx,
  ]);

  return (
    <div
      ref={displayMeasureRef}
      className="config-display-stack flex flex-col flex-shrink-0 min-w-0"
    >
      <div
        className={onboardingArea}
        data-display-texture={displayTexture}
      >
        <div
          className={`${onboardingFrame}${
            showTopChrome ? " industrial-display-frame--top-chrome" : ""
          } industrial-display-frame--bottom-chrome`}
          data-fusion-share-frame
        >
          {/*
            Top bezel chrome: ASSISTED/FULL AUTO + Device/Split (Assisted only)
            + STOP ALL (top-right) when 2+ live engines.
          */}
          {(fitLaunchSupported || showGpuAssign || showStopAll) && (
            <div className="industrial-display-frame__top-chrome" data-frame-top-chrome>
              {fitLaunchSupported && (
                <div className="vram-badge-fit-launch-dock" data-fit-launch-dock>
                  <FitLaunchToggle
                    available={fitLaunchSupported}
                    fullAuto={fullAutoMode}
                    onChange={onFitLaunchChange}
                  />
                </div>
              )}
              {showGpuAssign && (
                <GpuAssignPanel
                  bezel
                  gpus={gpus}
                  deviceValue={deviceValue}
                  splitValue={splitValue}
                  splitValues={splitValues}
                  chromeDisabled={launchChrome.chromeDisabled}
                  deviceLocked={launchChrome.deviceLocked}
                  splitLocked={launchChrome.splitLocked}
                  hideSplitNone={false}
                  hideTensorSplit={hideTensorSplit}
                  onDeviceChange={onDeviceChange}
                  onSplitChange={onSplitChange}
                  manifest={manifest}
                />
              )}
              {showStopAll ? (
                <button
                  type="button"
                  onClick={() => void onStopAllEngines()}
                  title="Stop all running engines"
                  className="display-bezel-stop-all font-mono uppercase tracking-wider ml-auto shrink-0"
                >
                  STOP ALL
                </button>
              ) : null}
            </div>
          )}
          {showChromeHints && (
            <DisplayChromeHints policyReason={launchChrome.reason} />
          )}
          <div
            ref={displayRef}
            key="forecast-phosphor"
            className="phosphor-screen-inner phosphor-display-surface vram-forecast-display"
          >
            <VramBadge
              manifest={manifest}
              gpus={gpus}
              selectedGpuIndices={
                selectedGpuIndices.length > 0 ? selectedGpuIndices : undefined
              }
              onDeviceSelect={onDeviceSelect}
              isValidating={isValidating}
              onValidate={onValidate}
              onYoloLaunch={onYoloLaunch}
              activeEngineAlias={activeEngineAlias}
              activeEnginePort={activeEnginePort}
              selectedSlotIdx={selectedSlotIdx}
              supportsFusion={supportsFusion}
              engineStatus={engineStatus}
              gpuMask={booterProps.gpuMask}
              vramTargetMib={booterProps.vramTargetMib}
              modelLayerTotal={booterProps.modelLayerTotal}
              gpuLoadTargetsMib={booterProps.gpuLoadTargetsMib}
              offloadMode={offloadMode}
              onMoeSuggestionClick={onMoeSuggestionClick}
              hideMoeBadge={hideMoeBadge}
              draftOnly={draftOnly}
              modelMeta={modelMeta}
              modelName={modelName}
              modelQuant={modelQuant}
              providerName={shareProfileMeta.providerName}
              providerBuildVersion={shareProfileMeta.providerBuildVersion}
              profileLabel={shareProfileMeta.profileLabel}
              cudaVersion={shareProfileMeta.cudaVersion}
              launchConfig={shareLaunchConfig}
              hwTopo={shareHwTopo}
              gpuIdleBaselineMib={gpuIdleBaselineMib}
              gpuPerRow={gpuPerRow}
              dualActive={dualActive}
              dualOrient={dualOrient}
              secondaryPane={secondaryPane}
            />
            {/* Overlay veil — does not change VramBadge face law */}
            {harness.veilNode}
          </div>

          <DisplayBezelGridControls
            gpuPerRow={gpuPerRow}
            enginesPerRow={enginesPerRow}
            onGpuPerRow={onGpuPerRow}
            onEnginesPerRow={onEnginesPerRow}
            showGpuDensity={
              !(
                selectedSlotIdx != null &&
                activeEnginePort != null &&
                (engineStatus === "LOADING" || engineStatus === "RUNNING")
              )
            }
            showEnginesControl={showEjectBelowVram}
            enginesPanelVisible={enginesPanelVisible}
            onToggleEnginesPanel={onToggleEnginesPanel}
            dualArmed={dualArmed}
            dualActive={dualActive}
            canDual={canDual}
            onToggleDual={onToggleDual}
            dualOrient={dualOrient}
            onToggleOrient={onToggleOrient}
            monitorFocus={monitorFocus}
            onToggleMonitor={onToggleMonitor}
            liveEngineCount={liveEngineSlots.length}
            onCycleEngine={onCycleLiveEngine}
            showHarnessConnect={harness.showConnectChip}
            harnessConnectActive={harness.veilOpen}
            harnessConnectReady={harness.connectReady}
            onHarnessConnect={harness.openVeil}
          />

        </div>
      </div>


      {/* Running Engines — fusion switcher; below VRAM bezel (outside display area flex) */}
      {showEjectBelowVram && enginesPanelVisible && (
        <div className="industrial-eject-panel relative flex-shrink-0 min-h-0">
          <RunningEnginesPanel
            stack={stack}
            models={models}
            selectedSlotIdx={selectedSlotIdx ?? null}
            onSelectEngine={onSelectEngine!}
            secondarySlotIdx={dualArmed || dualActive ? secondarySlotIdx : null}
            onPinSecondary={onPinSecondary}
            isHotSwapStale={isHotSwapStale}
            onHotSwap={onHotSwap}
            perRow={enginesPerRow}
          />
        </div>
      )}

    </div>
  );
}

export interface EngineGpuForecastProps {
  /** Ref measured by the orchestrator to align the launch rail display height. */
  displayMeasureRef?: RefObject<HTMLDivElement | null>;
  /** Onboarding classes (area / frame) from `onboardingDisplayClasses`. */
  onboardingArea: string;
  onboardingFrame: string;
  displayTexture: string;
  fitLaunchSupported: boolean;
  fullAutoMode: boolean;
  onFitLaunchChange: (next: boolean) => void;
  /** `fitLaunchSupported || (model && gpus.length > 0)` — add top-chrome pad. */
  showFitOrDeviceChrome: boolean;
  /** `model && gpus.length > 0 && !fullAutoMode` — render GpuAssignPanel. */
  showGpuAssign: boolean;
  gpus: GpuInfo[];
  deviceValue?: unknown;
  splitValue?: unknown;
  splitValues: (string | number)[];
  launchChrome: LaunchChromePolicy;
  /** `!tensorSplitSupported && !isCustomProvider` — hide tensor split option. */
  hideTensorSplit: boolean;
  onDeviceChange: (v: string) => void;
  onSplitChange: (v: string | number) => void;
  onDeviceSelect: (gpuIndex: number) => void;
  showChromeHints: boolean;
  manifest: VramManifest | null;
  /** Highlighted GPU indices from the forecast — pass empty to hide. */
  selectedGpuIndices: number[];
  isValidating: boolean;
  onValidate: () => void;
  onYoloLaunch?: () => void;
  isModelRunning?: boolean;
  activeEngineAlias?: string;
  activeEnginePort?: number;
  selectedSlotIdx?: number | null;
  supportsFusion: boolean;
  engineStatus?: string;
  booterProps: EngineGpuBooterProps;
  offloadMode?: string;
  onMoeSuggestionClick: () => void;
  hideMoeBadge: boolean;
  /** External draft pack — full-face draft explanation, no FIT. */
  draftOnly?: boolean;
  modelMeta?: ModelMetadata;
  modelName?: string;
  modelQuant?: string;
  shareProfileMeta: EngineGpuShareMeta;
  shareLaunchConfig: FusionShareLaunchConfig;
  shareHwTopo: string;
  gpuIdleBaselineMib: Record<number, number>;
  /** Below-VRAM running engines panel. */
  showEjectBelowVram: boolean;
  stack: StackEntry[];
  models?: ModelEntry[];
  onSelectEngine?: (slotIdx: number) => void;
  isHotSwapStale?: (entry: StackEntry) => boolean;
  onHotSwap?: (entry: StackEntry) => void;
  /** Parallel-aware seat relaunch for harness agents mismatch. */
  onRelaunchSeat?: (opts: {
    slotIdx: number;
    port: number;
    alias: string;
    parallel: number;
  }) => Promise<void>;

  dualActive?: boolean;
  dualArmed?: boolean;
  canDual?: boolean;
  dualOrient?: FusionDualOrient;
  onToggleDual?: () => void;
  onToggleOrient?: () => void;
  secondarySlotIdx?: number | null;
  onPinSecondary?: (slotIdx: number) => void;
  monitorFocus?: boolean;
  onToggleMonitor?: () => void;
}
