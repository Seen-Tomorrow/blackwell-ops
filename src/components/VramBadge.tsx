import type { GpuInfo, VramManifest, ModelMetadata } from "../lib/types";
import GpuTopology from "./GpuTopology";
import FusionPane from "./FusionPane";
import FusionDualStage, { type FusionPaneIdentity } from "./FusionDualStage";
import MoeBadge from "./MoeBadge";
import MemorySourcePanel, {
  MemorySourceNeedOverlay,
  MemorySourceReprobe,
  MemorySourceStatusMark,
  getMemorySourceView,
} from "./MemorySourcePanel";
import type { FusionShareLaunchConfig } from "../lib/fusionShareCapture";
import type { FusionDualOrient } from "../lib/storage";

interface VramBadgeProps {
  manifest: VramManifest | null;
  gpus: GpuInfo[];
  modelMeta?: ModelMetadata;
  selectedGpuIndices?: number[];
  onDeviceSelect?: (gpuIndex: number) => void;
  isValidating?: boolean;
  onValidate?: () => void;
  activeEngineAlias?: string;
  activeEnginePort?: number;
  selectedSlotIdx?: number | null;
  supportsFusion?: boolean;
  engineStatus?: string;
  gpuMask?: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
  offloadMode?: string;
  onMoeSuggestionClick?: () => void;
  hideMoeBadge?: boolean;
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
  gpuIdleBaselineMib?: Record<number, number>;
  gpuPerRow?: 2 | 3;
  dualActive?: boolean;
  dualOrient?: FusionDualOrient;
  secondaryPane?: FusionPaneIdentity | null;
}

/** Pre-manifest EVALUATING radar — no uiTemplate exists yet. */
const EVALUATING_COPY = {
  title: "EVALUATING",
  sub: "footprint · learned · fit probe",
  aria: "Evaluating VRAM footprint",
} as const;

/**
 * One forecast glass: ASSISTED measure cluster (SOURCE + bars + NEED + GPU bank).
 * Fusion overlay replaces the glass while an engine is LOADING/RUNNING.
 * Glass height is owned by EngineGpuForecast — do not write ancestor styles here.
 */
export default function VramBadge({
  manifest, gpus, modelMeta, selectedGpuIndices, onDeviceSelect, isValidating, onValidate,
  activeEngineAlias, activeEnginePort, selectedSlotIdx, supportsFusion = true, engineStatus,
  gpuMask = "", vramTargetMib, modelLayerTotal, gpuLoadTargetsMib, offloadMode, onMoeSuggestionClick, hideMoeBadge = false,
  hideFitProbe = false, className,
  modelName, modelQuant, providerName, providerBuildVersion, profileLabel, cudaVersion, launchConfig, hwTopo,
  gpuIdleBaselineMib,
  gpuPerRow = 2,
  dualActive = false,
  dualOrient = "side",
  secondaryPane = null,
}: VramBadgeProps) {

  const fusionOverlayActive =
    selectedSlotIdx !== null &&
    selectedSlotIdx !== undefined &&
    activeEnginePort != null &&
    (engineStatus === "LOADING" || engineStatus === "RUNNING");

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
        className={`vram-badge-forecast relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}
        data-fusion-only="1"
        data-fusion-dual={dualActive ? dualOrient : undefined}
      >
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
        className={`vram-badge-forecast vram-fc vram-badge-forecast--skeleton relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}
        data-forecast-skeleton="1"
        aria-busy="true"
        aria-label={EVALUATING_COPY.aria}
      >
        <div className="vram-forecast-measuring flex flex-1 min-h-0 items-stretch justify-between w-full">
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
              <span className="vram-forecast-measuring__title">{EVALUATING_COPY.title}</span>
              <span className="vram-forecast-measuring__sub">{EVALUATING_COPY.sub}</span>
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
  const launchSummary = t.launchSummary || t.heroText || s.label;

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

  const totalVramMib = gpus.reduce((sum, g) => {
    return sum + (g.memory_total_manufactured || g.memory_total);
  }, 0);
  const totalVramGb = totalVramMib / 1024;

  const vramUsagePct = totalVramMib > 0
    ? Math.min((displayVramNeedGb * 1024 / totalVramMib) * 100, 100)
    : 0;

  const ramManufacturedGb = manifest.ramManufacturedGb;
  const ramUsagePct = ramManufacturedGb > 0
    ? Math.min((displayRamNeedGb / ramManufacturedGb) * 100, 100)
    : 0;

  // NEED tone from adapter (hard gate + soft high free-util); bar uses same visual paint.
  const vramNeedTone = s.vramNeedTone ?? "ok";
  const ramNeedTone = s.ramNeedTone ?? "ok";
  const vramBarInset = t.kvSpillRiskText?.trim() || null;
  const ramBarInset = t.offloadWarningText?.trim() || null;


  return (
    <div
      className={`vram-badge-forecast vram-fc relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}
      data-forecast-mode="assisted"
      data-fits={manifest.fits ? "1" : "0"}
      data-source-kind={sourceKind || undefined}
    >
      <div className="vram-fc__header vram-forecast-header vram-forecast-header--assisted flex-shrink-0 min-w-0">
        <p
          className={`vram-fc__launch-summary${manifest.fits ? " is-ok" : " is-fail"}`}
          title={launchSummary}
        >
          {launchSummary}
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

      <div className="vram-badge-body vram-fc__body vram-fc__body--assisted relative min-h-0 overflow-hidden">
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
            {memorySource ? (
              <div className="vram-fc-measure__source">
                <div className="vram-fc__source-row vram-forecast-header__fit-row">
                  <div className="vram-forecast-source min-w-0">
                    <MemorySourcePanel
                      memorySource={memorySource}
                      launchSummary={launchSummary}
                    />
                  </div>
                </div>
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
                    {vramBarInset ? (
                      <span
                        className={`vram-forecast-bar__inset-label vram-forecast-bar__inset-label--vram${
                          vramNeedTone === "hot"
                            ? " vram-forecast-bar__inset-label--hot"
                            : vramNeedTone === "warn"
                              ? " vram-forecast-bar__inset-label--warn"
                              : ""
                        }`}
                        title={vramBarInset}
                      >
                        {vramBarInset}
                      </span>
                    ) : null}
                  </div>
                </div>
              </div>

              {showRamBar && (
                <div className="vram-fc-bar-row vram-fc-bar-row--ram">
                  <div
                    className="vram-fc-bar vram-fc-bar--fused vram-fc-bar--track-only vram-forecast-ram-bar"
                    aria-label={`RAM ${displayRamNeedGb.toFixed(1)} of ${ramManufacturedGb.toFixed(1)} GB`}
                  >
                    <span className="vram-fc-bar__name-chip vram-fc-bar__name-chip--ram">
                      <span className="vram-fc-bar__name-lab">RAM</span>
                      <span className="vram-fc-bar__name-total">total</span>
                    </span>
                    <span className="vram-fc-bar__cap-chip vram-fc-bar__cap-chip--ram" title="Installed RAM">
                      <span className="vram-fc-bar__cap-val">{ramManufacturedGb.toFixed(1)}</span>
                      <span className="vram-fc-bar__cap-unit">GB</span>
                    </span>
                    <div className="vram-fc-bar__track">
                      <div
                        className={`vram-fc-bar__fill vram-fc-bar__fill--bevel ${
                          t.moeRamBar || offloadMode === "moe_optimal"
                            ? "bg-orange-hatched"
                            : ramNeedTone === "warn" || ramNeedTone === "hot"
                              ? "bg-orange-400/70"
                              : "bg-blue-700"
                        }`}
                        style={{ width: `${ramUsagePct}%` }}
                      />
                      {ramBarInset ? (
                        <span
                          className={`vram-forecast-bar__inset-label vram-forecast-bar__inset-label--ram${
                            ramNeedTone === "hot"
                              ? " vram-forecast-bar__inset-label--hot"
                              : " vram-forecast-bar__inset-label--warn"
                          }`}
                          title={ramBarInset}
                        >
                          {ramBarInset}
                        </span>
                      ) : null}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div
              className="vram-fc-need-frame"
              data-source-kind={sourceKind ?? undefined}
              data-exact={sourceView?.isExact ? "1" : sourceView ? "0" : undefined}
              data-has-status={sourceView?.showStatus ? "1" : "0"}
              data-has-ram={showRamBar ? "1" : "0"}
              data-has-probe={
                memorySource && sourceView?.canProbe && !hideFitProbe ? "1" : "0"
              }
              data-live={isValidating ? "1" : undefined}
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

              {memorySource ? (
                <MemorySourceNeedOverlay
                  memorySource={memorySource}
                  isValidating={isValidating}
                  onValidate={hideFitProbe ? undefined : onValidate}
                  hideValidate={hideFitProbe || !onValidate}
                />
              ) : null}
            </div>
          </div>
        </div>

        {manifest.gpuAllocations.length > 0 && (
          <div className="vram-fc__topo vram-fc__topo--compact">
            <GpuTopology
              gpuAllocations={manifest.gpuAllocations}
              gpuBarColor={s.gpuBarColor}
              needTone={vramNeedTone}
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
