import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, VramManifest, ModelMetadata } from "../lib/types";
import GpuTopology from "./GpuTopology";
import FusionPane from "./FusionPane";
import FusionDualStage, { type FusionPaneIdentity } from "./FusionDualStage";
import MoeBadge from "./MoeBadge";
import NvramSnapshotOverlay from "./NvramSnapshotOverlay";
import { formatTensorSplit, type LayerPlan } from "../lib/vramLayerPlan";
import MemorySourcePanel, {
  MemorySourceNeedOverlay,
  MemorySourceReprobe,
  MemorySourceStatusMark,
  getMemorySourceView,
} from "./MemorySourcePanel";
import type { FusionShareLaunchConfig } from "../lib/fusionShareCapture";
import type { FusionDualOrient } from "../lib/storage";
import { deniedKnobRule, useEngineDenials } from "../hooks/useEngineDenials";
import { memoryLabelForKvQuant } from "../lib/multiAgentBooster";

interface VramBadgeProps {
  manifest: VramManifest | null;
  gpus: GpuInfo[];
  modelMeta?: ModelMetadata;
  selectedGpuIndices?: number[];
  onDeviceSelect?: (gpuIndex: number) => void;
  isValidating?: boolean;
  onValidate?: (mode?: "full" | "low_vram") => void;
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
  /** Automatic placement owns this launch: the app writes `-ts` and turns fit off. */
  placementActive?: boolean;
  /** Manual nudge: recompute the byte-balanced split and arm layer placement. */
  onSplitEq?: () => void;
  /** Bezel control: full-glass NVRAM snapshot log. */
  snapLogOpen?: boolean;
  onCloseSnapLog?: () => void;
  /** The one layer plan: printed here, painted by the bars, written by the launcher. */
  layerPlan?: LayerPlan | null;
  planKvSource?: "measured" | "profile" | "geometry" | "none";
  planSqueezed?: boolean;
  /** Model whose layer table the planner reads; absent hides the PLAN chip. */
  modelPath?: string;
  /** Planned context length and KV quantisation — the plan must follow these knobs. */
  ctxTokens?: number;
  kvQuant?: string;
  /** Split mode of the plan — compute buffers differ ~4x between none and layer. */
  splitMode?: string;
  /** Batch/ubatch of the plan — compute buffers scale with them (~10x 2048 → 8192). */
  batch?: number;
  ubatch?: number;
  /** External draft pack selected — no main forecast / FIT. */
  draftOnly?: boolean;
  /** Attachment role — renders the same fixed face as a draft, tinted per role. */
  attachmentKind?: AttachmentKind | null;
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

const DRAFT_FACE_COPY = {
  title: "SPECULATIVE DRAFT",
  kicker: "NOT A MAIN MODEL",
  body: "This pack is a draft head for DFlash / MTP / Eagle boost — it cannot launch alone and has no VRAM forecast.",
  hint: "Select a main model, enable Boost, then pair this draft.",
  aria: "Draft model — no VRAM forecast",
} as const;

/** Companion files: same fixed face as a draft, different role words and tint. */
const ATTACHMENT_FACE_COPY = {
  ple: {
    title: "ENGRAM TABLE",
    body: "Per-layer lookup table (Engram) shared by every quant of this family. The engine reads it lazily; it is never a model on its own.",
    hint: "Pair it to a main model in the engine config.",
    readout: "LOOKUP",
    aria: "Engram lookup table — no VRAM forecast",
  },
  mmproj: {
    title: "VISION PROJECTOR",
    body: "mmproj vision encoder — attached to a main model, never loaded on its own.",
    hint: "Set VISION auto/on on a main model to use it.",
    readout: "MMPROJ",
    aria: "Vision projector — no VRAM forecast",
  },
  adapter: {
    title: "LORA ADAPTER",
    body: "Adapter weights — applied over a main model at launch.",
    hint: "Choose a main model and attach the adapter.",
    readout: "LORA",
    aria: "LoRA adapter — no VRAM forecast",
  },
} as const;

type AttachmentKind = keyof typeof ATTACHMENT_FACE_COPY;

/**
 * One forecast glass: ASSISTED measure cluster (SOURCE + bars + NEED + GPU bank).
 * Fusion overlay replaces the glass while an engine is LOADING/RUNNING.
 * Glass height is owned by EngineGpuForecast — do not write ancestor styles here.
 */
export default function VramBadge({
  manifest, gpus, modelMeta, selectedGpuIndices, onDeviceSelect, isValidating, onValidate,
  activeEngineAlias, activeEnginePort, selectedSlotIdx, supportsFusion = true, engineStatus,
  gpuMask = "", vramTargetMib, modelLayerTotal, gpuLoadTargetsMib, offloadMode, onMoeSuggestionClick, hideMoeBadge = false,
  hideFitProbe = false, draftOnly = false, attachmentKind = null, className,
  placementActive = false, onSplitEq,
  snapLogOpen = false,
  onCloseSnapLog,
  layerPlan = null,
  planKvSource = "none",
  planSqueezed = false,
  modelPath,
  ctxTokens,
  kvQuant,
  splitMode,
  batch,
  ubatch,

  modelName, modelQuant, providerName, providerBuildVersion, profileLabel, cudaVersion, launchConfig, hwTopo,
  gpuIdleBaselineMib,
  gpuPerRow = 2,
  dualActive = false,
  dualOrient = "side",
  secondaryPane = null,
}: VramBadgeProps) {

  // The plan arrives from EngineConfigPanel: the same object feeds the manifest's per-card
  // split, so what the bars paint and what this glass prints cannot disagree.

  // Publish what this glass shows, so an agent can read it instead of asking for a
  // screenshot. DEV builds write config/automation/ui/vram-badge.json.
  useEffect(() => {
    const timer = setTimeout(() => {
      void invoke("record_ui_state", {
        name: "vram-badge",
        state: {
          modelPath: modelPath ?? null,
          modelName: modelName ?? null,
          ctx: ctxTokens ?? null,
          kvQuant: kvQuant ?? null,
          splitMode: splitMode ?? null,
          batch: batch ?? null,
          ubatch: ubatch ?? null,
          placementActive: placementActive === true,
          sourceKind: manifest.memorySource?.kind ?? null,
          sourceExact: manifest.memorySource?.exact ?? null,
          sourceDetail: manifest.memorySource?.detail ?? null,
          vramNeedGb: displayVramNeedGb,
          ramNeedGb: manifest.ramTotalGb ?? null,
          fits: manifest.fits ?? null,
          needTone: manifest.style.vramNeedTone ?? null,
          launchPaint: manifest.style.launchPaint ?? null,
          gpuLoadsGb: manifest.gpuAllocations?.map((alloc) => alloc.projectedLoadGb) ?? null,
          plan: layerPlan
            ? {
                totalMib: layerPlan.sumMib,
                budgetSumMib: layerPlan.budgetSumMib,
                gpuMib: layerPlan.totalMib,
                boundaries: layerPlan.boundaries,
                deviceLayers: layerPlan.deviceLayers,
                layers: layerPlan.layerCount,
                ts: layerPlan.ts,
                applyTs: layerPlan.applyTs,
                optimalBoundary: layerPlan.optimalBoundary,
                kvSource: planKvSource,
                squeezed: planSqueezed,
              }
            : null,
        },
      }).catch(() => {
        // Diagnostics only.
      });
    }, 400);
    return () => clearTimeout(timer);
  }, [
    modelPath, modelName, ctxTokens, kvQuant, splitMode, batch, ubatch, placementActive,
    manifest, layerPlan, planKvSource, planSqueezed,
  ]);

  const [placementBusy, setPlacementBusy] = useState(false);
  // Same denial table the engine config and the launch guard obey; the glass only reports it.
  const denials = useEngineDenials();
  // A mode change must be visible even when the numbers land in the same place: the topo runs
  // a short re-scan and the bars ease to their new widths.
  const [placementFlash, setPlacementFlash] = useState(false);
  const prevPlacementActive = useRef(placementActive);
  useEffect(() => {
    if (prevPlacementActive.current === placementActive) return;
    prevPlacementActive.current = placementActive;
    setPlacementFlash(true);
    const timer = setTimeout(() => setPlacementFlash(false), 700);
    return () => clearTimeout(timer);
  }, [placementActive]);
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
        {/* The fusion screen is its own tree (engine LOADING/RUNNING): the log has to be mounted
            here too, or the bezel button does nothing exactly when the metrics are on screen. */}
        <NvramSnapshotOverlay open={snapLogOpen} onClose={() => onCloseSnapLog?.()} />
      </div>
    );
  }

  const attachmentCopy = attachmentKind ? ATTACHMENT_FACE_COPY[attachmentKind] : null;
  const fixedFace = draftOnly
    ? DRAFT_FACE_COPY
    : attachmentCopy
      ? { ...attachmentCopy, kicker: "NOT A MAIN MODEL" }
      : null;

  if (fixedFace) {
    return (
      <div
        className={`vram-badge-forecast vram-fc ${draftOnly ? "vram-badge-forecast--draft" : "vram-badge-forecast--draft vram-badge-forecast--attachment"} relative flex flex-col min-h-0 overflow-hidden ${className || ""}`}
        data-forecast-draft={draftOnly ? "1" : undefined}
        data-attachment-role={attachmentKind ?? undefined}
        aria-label={fixedFace.aria}
      >
        <div className="vram-forecast-draft flex flex-1 min-h-0 items-stretch justify-between w-full">
          <div className="vram-forecast-draft__hatch" aria-hidden="true" />

          <div className="vram-forecast-draft__flank vram-forecast-draft__flank--left font-mono" aria-hidden>
            <span className="vram-forecast-draft__flank-label">ROLE</span>
            <span className="vram-forecast-draft__ladder">
              <i /><i /><i /><i /><i /><i />
            </span>
            <span className="vram-forecast-draft__flank-readout">
              {draftOnly ? "DRAFT" : attachmentCopy?.readout}
            </span>
          </div>

          <div className="vram-forecast-draft__center flex flex-col items-center justify-center gap-3 min-w-0 self-center">
            <div className="vram-forecast-draft__seal font-mono" aria-hidden>
              <span className="vram-forecast-draft__seal-ring" />
              <span className="vram-forecast-draft__seal-ring vram-forecast-draft__seal-ring--outer" />
              <span className="vram-forecast-draft__seal-core">{draftOnly ? "SPEC" : "FILE"}</span>
            </div>
            <div className="vram-forecast-draft__copy font-mono">
              <span className="vram-forecast-draft__kicker">{fixedFace.kicker}</span>
              <span className="vram-forecast-draft__title">{fixedFace.title}</span>
              <span className="vram-forecast-draft__body">{fixedFace.body}</span>
              <span className="vram-forecast-draft__hint">{fixedFace.hint}</span>
            </div>
            {(modelName || modelQuant) && (
              <div className="vram-forecast-draft__meta font-mono" title={modelName}>
                <span className="vram-forecast-draft__meta-name">{modelName || "draft pack"}</span>
                {modelQuant ? (
                  <span className="vram-forecast-draft__meta-quant">{modelQuant}</span>
                ) : null}
              </div>
            )}
          </div>

          <div className="vram-forecast-draft__flank vram-forecast-draft__flank--right font-mono" aria-hidden>
            <span className="vram-forecast-draft__flank-label">FIT</span>
            <span className="vram-forecast-draft__ladder">
              <i /><i /><i /><i /><i /><i />
            </span>
            <span className="vram-forecast-draft__flank-readout">SKIP</span>
          </div>
        </div>
      </div>
    );
  }

  // A denied knob value never reaches the engine, so there is nothing to measure: the
  // radar would spin on a launch the guard already refuses, and any learned manifest for
  // this model describes a different configuration. Say it here, where the operator is
  // looking — a toast is gone before they switch model.
  const deniedKnob = deniedKnobRule(
    denials,
    "kv_quant",
    kvQuant ?? "",
    modelMeta?.architecture ?? "",
  );
  if (deniedKnob) {
    const isKv = deniedKnob.knob === "kv_quant";
    const what = isKv ? memoryLabelForKvQuant(kvQuant) || "this MEMORY value" : `this ${deniedKnob.knob.replace(/_/g, " ")} setting`;
    const core = isKv ? "KV" : "CFG";
    return (
      <div
        className={`vram-badge-forecast vram-denial relative flex flex-col min-h-0 overflow-hidden items-center justify-center gap-3 ${className || ""}`}
        role="alert"
        data-forecast-denied={deniedKnob.id}
      >
        <div className="vram-denial__scope" aria-hidden>
          <span className="vram-forecast-measuring__ring" />
          <span className="vram-forecast-measuring__ring vram-forecast-measuring__ring--delay" />
          <span className="vram-forecast-measuring__beam" />
          <span className="vram-forecast-measuring__core font-mono">{core}</span>
        </div>
        <span className="vram-denial__title font-mono">CANNOT USE {what}</span>
        <span className="vram-denial__sub">
          {isKv
            ? "This engine build does not support it — move the MEMORY slider to a different value."
            : "This engine build does not support this combination — pick a different value."}
        </span>
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
            {onValidate ? (
              <button
                type="button"
                className="vram-fc-source__reprobe vram-fc-skeleton__probe"
                onClick={() => onValidate("full")}
                disabled={isValidating}
                title="Run FIT at this CTX — two CTXs are measured when no launch curve exists"
              >
                {isValidating ? "PROBING…" : "PROBE THIS CTX"}
              </button>
            ) : null}
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
      {/* Same surface in the fusion branch: during LOADING/RUNNING this is the only tree mounted. */}
      <NvramSnapshotOverlay open={snapLogOpen} onClose={() => onCloseSnapLog?.()} />
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

  // The adapter owns the whole number now: engine buffers plus the measured per-card
  // runtime (CUDA context, graph pools, allocator slack). The glass prints exactly what the
  // gate uses — there is no second accounting here.
  const displayVramNeedGb = Math.max(0, manifest.vramTotalGb);
  const displayRamNeedGb = isFitProbe
    ? (manifest.validatedHostMib != null && manifest.validatedHostMib > 0
        ? manifest.validatedHostMib / 1024
        : Math.max(0, manifest.ramTotalGb))
    : Math.max(0, manifest.ramTotalGb);
  const showRamBar = t.showRamBar !== false || !!isValidating;

  const totalVramMib = gpus.reduce((sum, g) => {
    return sum + (g.memory_total_manufactured || g.memory_total);
  }, 0);
  const totalVramGb = totalVramMib / 1024;

  const vramUsagePct = totalVramMib > 0
    ? Math.max(0, Math.min((displayVramNeedGb * 1024 / totalVramMib) * 100, 100))
    : 0;

  const ramManufacturedGb = manifest.ramManufacturedGb;
  const ramUsagePct = ramManufacturedGb > 0
    ? Math.max(0, Math.min((displayRamNeedGb / ramManufacturedGb) * 100, 100))
    : 0;

  // NEED tone from adapter (hard gate + soft high free-util); bar uses same visual paint.
  const vramNeedTone = s.vramNeedTone ?? "ok";
  const ramNeedTone = s.ramNeedTone ?? "ok";
  const vramBarInset = t.kvSpillRiskText?.trim() || null;
  const ramBarInset = t.offloadWarningText?.trim() || null;
  // History, not a projection: what the last recorded launch actually put in system RAM.
  // Shown only when the current projection is not already saying OFFLOADING — the measured
  // figure is the news exactly when the forecast has stopped spilling.
  const ramHistoryGb = manifest.lastLaunchSpillGb ?? 0;
  const ramHistoryAt = (() => {
    if (!manifest.lastLaunchSpillAt) return null;
    const d = new Date(manifest.lastLaunchSpillAt);
    if (!Number.isFinite(d.getTime())) return null;
    return d.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  })();
  const showRamHistory = ramHistoryGb > 0.05 && !ramBarInset;

  // Placement is a state, not a mode: the app owns every multi-card layer split, so the glass
  // only has to say which side is placing. "AUTO" means the launch carries these exact `-ts`
  // boundaries; "ENGINE" means there is no split to place (one card, or no layer table yet).
  const placementDetail = layerPlan
    ? placementActive
      ? `${layerPlan.deviceLayers.join("/")} L · -ts ${formatTensorSplit(layerPlan.applyTs)}`
      : `${layerPlan.deviceLayers.join("/")} L planned`
    : null;
  const placementTitle = layerPlan
    ? `${placementActive ? "Automatic" : "Proposed"}: -ts ${formatTensorSplit(layerPlan.applyTs)}` +
      ` · ${layerPlan.deviceLayers.join("/")} layers`
    : "No layer table for this model yet - the engine's own fit chooses placement";

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
            needsLowVramReprobe={!!s.needsLowVramReprobe}
            overFreeReprobe={s.launchPaint === "offload" || s.launchPaint === "nofit"}
          />
        ) : null}
        {/* Placement ownership is always on screen. There is no operator switch: an app-owned
            launch carries -ts + fit off, and one without a split lets the engine place. SPLIT EQ
            is the manual nudge for the case where the automatic pass had nothing to arm. */}
        <div
          className="vram-fc-placement"
          data-placement={placementActive ? "auto" : "engine"}
          data-busy={placementBusy ? "1" : undefined}
        >
          <span className="vram-fc-placement__label">VRAM PLACEMENT</span>
          <span className="vram-fc-placement__mode" title={placementTitle}>
            {placementActive ? "AUTO" : "ENGINE"}
            {placementDetail ? (
              <span className="vram-fc-placement__detail">{placementDetail}</span>
            ) : null}
          </span>
          {onSplitEq && layerPlan ? (
            <button
              type="button"
              className="vram-fc-placement__eq"
              title="Re-read free VRAM, balance the layer split by bytes and arm it for the next launch"
              disabled={placementBusy}
              onClick={() => {
                setPlacementBusy(true);
                onSplitEq();
                // The button is a trigger, not a mode: flash while the plan repaints.
                setTimeout(() => setPlacementBusy(false), 600);
              }}
            >
              SPLIT EQ
            </button>
          ) : null}
        </div>
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
                          vramNeedTone !== "ok"
                            ? ` vram-forecast-bar__inset-label--${vramNeedTone}`
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
                            : ramNeedTone === "hot"
                              ? "ram-fill--hot"
                              : ramNeedTone === "warn" || ramNeedTone === "caution"
                                ? "ram-fill--warn"
                                : "ram-fill--ok"
                        }`}
                        style={{ width: `${ramUsagePct}%` }}
                      />
                      {ramBarInset ? (
                        <span
                          className={`vram-forecast-bar__inset-label vram-forecast-bar__inset-label--ram${
                            ramNeedTone !== "ok"
                              ? ` vram-forecast-bar__inset-label--${ramNeedTone}`
                              : ""
                          }`}
                          title={ramBarInset}
                        >
                          {ramBarInset}
                        </span>
                      ) : null}
                      {showRamHistory ? (
                        <span
                          className="vram-fc-bar__history"
                          title={`Last recorded launch put ${ramHistoryGb.toFixed(1)} GB of weights in system RAM${
                            ramHistoryAt ? ` · ${ramHistoryAt}` : ""
                          }`}
                        >
                          {`last launch +${ramHistoryGb.toFixed(1)}G → RAM`}
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
            >
              {memorySource && sourceView?.showStatus ? (
                <MemorySourceStatusMark memorySource={memorySource} />
              ) : (
                <div className="vram-fc-need-frame__status-row vram-fc-need-frame__status-row--empty" aria-hidden />
              )}

              <span
                className="vram-fc-bar__need-chip vram-fc-need-frame__need vram-fc-need-frame__need--vram"
                data-need-tone={vramNeedTone}
                title={`Projected VRAM: ${displayVramNeedGb.toFixed(1)} GB — engine buffers plus the measured per-card runtime (CUDA context, graph pools)`}
              >
                <span className="vram-fc-bar__need-prefix">need</span>
                <span className={`vram-fc-bar__need vram-fc-bar__need--${vramNeedTone}`}>
                  {displayVramNeedGb.toFixed(1)}
                </span>
                <span className="vram-fc-bar__unit">GB</span>
                {/* The plan is a placement decision, not a second forecast: its total lives on
                    the placement switch and the bars, never next to NEED. */}
              </span>

              {showRamBar ? (
                <span
                  className="vram-fc-bar__need-chip vram-fc-bar__need-chip--ram vram-fc-need-frame__need vram-fc-need-frame__need--ram"
                  data-need-tone={ramNeedTone}
                  data-ram-split={
                    (manifest.ramWeightGb ?? 0) > 0.05 || (manifest.ramEngramGb ?? 0) > 0.05
                      ? "1"
                      : "buffer"
                  }
                  title={
                    (manifest.ramWeightGb ?? 0) > 0.05 || (manifest.ramEngramGb ?? 0) > 0.05
                      ? `Host ${displayRamNeedGb.toFixed(1)} GB = ${(manifest.ramBufferGb ?? 0).toFixed(1)} buffer${
                          (manifest.ramEngramGb ?? 0) > 0.05
                            ? ` + ${(manifest.ramEngramGb ?? 0).toFixed(1)} lookup table (host by design)`
                            : ""
                        }${
                          (manifest.ramWeightGb ?? 0) > 0.05
                            ? ` + ${(manifest.ramWeightGb ?? 0).toFixed(1)} weight`
                            : ""
                        }`
                      : `Host ${displayRamNeedGb.toFixed(1)} GB buffer (not layer offload)`
                  }
                >
                  <span className="vram-fc-bar__need-prefix">need</span>
                  <span className={`vram-fc-bar__need vram-fc-bar__need--${ramNeedTone}`}>
                    {displayRamNeedGb.toFixed(1)}
                  </span>
                  <span className="vram-fc-bar__unit">GB</span>
                  {(manifest.ramWeightGb ?? 0) > 0.05 || (manifest.ramEngramGb ?? 0) > 0.05 ? (
                    <span className="vram-fc-bar__need-split" aria-label="RAM need breakdown">
                      <span className="vram-fc-bar__need-split-line">
                        <span className="vram-fc-bar__need-split-val">
                          {(manifest.ramBufferGb ?? 0).toFixed(1)}GB
                        </span>
                        <span className="vram-fc-bar__need-split-lab">buffer</span>
                      </span>
                      {(manifest.ramEngramGb ?? 0) > 0.05 ? (
                        <span className="vram-fc-bar__need-split-line">
                          <span className="vram-fc-bar__need-split-val">
                            {(manifest.ramEngramGb ?? 0).toFixed(1)}GB
                          </span>
                          <span className="vram-fc-bar__need-split-lab"> lookup</span>
                        </span>
                      ) : null}
                      {(manifest.ramWeightGb ?? 0) > 0.05 ? (
                        <span className="vram-fc-bar__need-split-line">
                          <span className="vram-fc-bar__need-split-val">
                            {(manifest.ramWeightGb ?? 0).toFixed(1)}GB
                          </span>
                          <span className="vram-fc-bar__need-split-lab"> weights</span>
                        </span>
                      ) : null}
                    </span>
                  ) : (
                    <span className="vram-fc-bar__need-split vram-fc-bar__need-split--buf" aria-label="RAM buffer only">
                      <span className="vram-fc-bar__need-split-line">
                        <span className="vram-fc-bar__need-split-lab">buffer</span>
                      </span>
                    </span>
                  )}
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
          <div
            className="vram-fc__topo vram-fc__topo--compact"
            data-placement-flash={placementFlash ? "1" : undefined}
          >
            <GpuTopology
              gpuAllocations={manifest.gpuAllocations}
              gpuBarColor={s.gpuBarColor}
              needTone={vramNeedTone}
              gpuIdleBaselineMib={gpuIdleBaselineMib}
              selectedGpuIndices={selectedGpuIndices}
              onDeviceSelect={onDeviceSelect}
              perRow={gpuPerRow}
              fill
            />
          </div>
        )}
      </div>
      <NvramSnapshotOverlay open={snapLogOpen} onClose={() => onCloseSnapLog?.()} />
    </div>
  );
}
