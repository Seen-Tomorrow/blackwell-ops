import type { RefObject } from "react";
import type {
  GpuInfo,
  ModelEntry,
  ModelMetadata,
  StackEntry,
  VramManifest,
} from "../lib/types";
import type { LaunchChromePolicy } from "../lib/launchChromePolicy";
import type { FusionShareLaunchConfig } from "../lib/fusionShareCapture";
import GpuAssignPanel from "./GpuAssignPanel";
import DisplayChromeHints from "./DisplayChromeHints";
import VramBadge from "./VramBadge";
import FitLaunchToggle from "./FitLaunchToggle";
import RunningEnginesPanel from "./RunningEnginesPanel";

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
  } = props;

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
            showFitOrDeviceChrome ? " industrial-display-frame--top-chrome" : ""
          }`}
          data-fusion-share-frame
        >
          {/*
            Top bezel chrome: ASSISTED/FULL AUTO + Device/Split (Assisted only).
            Seated fully in frame pad so thick chrome isn't wasted on one control.
          */}
          {(fitLaunchSupported || showGpuAssign) && (
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
            </div>
          )}
          {showChromeHints && (
            <DisplayChromeHints policyReason={launchChrome.reason} />
          )}
          <div
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
              isModelRunning={isModelRunning}
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
              fitLaunchAvailable={false}
              fullAutoMode={fullAutoMode}
              hideMoeBadge={hideMoeBadge}
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
            />
          </div>
        </div>
      </div>

      {/* Running Engines — fusion switcher; below VRAM bezel (outside display area flex) */}
      {showEjectBelowVram && (
        <div className="industrial-eject-panel relative flex-shrink-0 min-h-0">
          <RunningEnginesPanel
            stack={stack}
            models={models}
            selectedSlotIdx={selectedSlotIdx ?? null}
            onSelectEngine={onSelectEngine!}
            isHotSwapStale={isHotSwapStale}
            onHotSwap={onHotSwap}
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
}
