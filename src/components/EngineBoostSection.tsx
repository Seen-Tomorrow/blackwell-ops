import type { StackEntry } from "../lib/types";
import type {
  BrainsId,
  CodingModeId,
  SpeedBoostId,
  ThinkId,
} from "../lib/multiAgentBooster";
import type { SpecCapability } from "../lib/specDraft";
import MultiAgentBooster, {
  type CockpitSpecDetailParam,
  type DflashGetUiState,
  type MultiAgentBoosterProps,
} from "./MultiAgentBooster";
import type { CockpitFlagToggle } from "./CockpitFlagToolbar";
import type { CockpitCtxStripProps } from "./CockpitCtxStrip";

/**
 * Boost / Multi-agent cockpit wrapper. Renders the `MultiAgentBooster` leaf
 * inside the params scroll column. Pure presentational — the orchestrator owns
 * all cockpit state + `applyFullAutoCockpit` and passes slices + handlers down.
 */
export default function EngineBoostSection(props: EngineBoostSectionProps) {
  const {
    show,
    wrapperClass,
    codingMode,
    speedBoost,
    brains,
    think,
    applyCockpit,
    cockpitOpts,
    capabilities,
    dflashLibraryReady,
    dflashGettable,
    dflashDraftLabel,
    dflashGetState,
    dflashGetError,
    dflashGetOfferLabel,
    onGetDflashDraft,
    onChangeDflashDraft,
    kvQuantValues,
    parallelValues,
    showAgents,
    showMemory,
    showThink,
    showBoost,
    agentsFromTemplateOnly,
    port,
    modelId,
    stack,
    preferredSlotIdx,
    onHarnessOpenChange,
    onRelaunchSeat,
    onSelectEngine,
    layout,
    powerMode,
    rawSpecTypes,
    activeRawSpecType,
    onRawSpecType,
    specDetailParams,
    embedCtx,
    ctxStripProps,
    flagToggles,
    launchPresets,
    presetTwinBind,
    onPresetTwinBindConsumed,
  } = props;

  if (!show) return null;

  return (
    <div className={wrapperClass}>
      <MultiAgentBooster
        codingMode={codingMode}
        speedBoost={speedBoost}
        brains={brains}
        think={think}
        onCodingMode={(m) => {
          void applyCockpit(m, speedBoost, brains, think, cockpitOpts);
        }}
        onSpeedBoost={(s) => {
          void applyCockpit(codingMode, s, brains, think, cockpitOpts);
        }}
        onBrains={(b) => {
          void applyCockpit(codingMode, speedBoost, b, think, cockpitOpts);
        }}
        onThink={(t) => {
          void applyCockpit(codingMode, speedBoost, brains, t, cockpitOpts);
        }}
        flagToggles={flagToggles}
        launchPresets={launchPresets}
        presetTwinBind={presetTwinBind}
        onPresetTwinBindConsumed={onPresetTwinBindConsumed}
        capabilities={capabilities}
        dflashLibraryReady={dflashLibraryReady}
        dflashGettable={dflashGettable}
        dflashDraftLabel={dflashDraftLabel}
        dflashGetState={dflashGetState}
        dflashGetError={dflashGetError}
        dflashGetOfferLabel={dflashGetOfferLabel}
        onGetDflashDraft={onGetDflashDraft}
        onChangeDflashDraft={onChangeDflashDraft}
        kvQuantValues={kvQuantValues}
        parallelValues={parallelValues}
        showAgents={showAgents}
        showMemory={showMemory}
        showThink={showThink}
        showBoost={showBoost}
        agentsFromTemplateOnly={agentsFromTemplateOnly}
        port={port}
        modelId={modelId}
        stack={stack}
        preferredSlotIdx={preferredSlotIdx}
        onHarnessOpenChange={onHarnessOpenChange}
        onRelaunchSeat={onRelaunchSeat}
        onSelectEngine={onSelectEngine}
        layout={layout}
        powerMode={powerMode}
        rawSpecTypes={rawSpecTypes}
        activeRawSpecType={activeRawSpecType}
        onRawSpecType={(raw) => {
          // Raw factory types only — product Off/MTP/DFlash use onSpeedBoost alone.
          if (raw == null) return;
          void applyCockpit(codingMode, "off", brains, think, {
            powerUser: true,
            rawSpecType: raw,
          });
        }}
        specDetailParams={specDetailParams}
        embedCtx={embedCtx}
        {...(embedCtx ? ctxStripProps : {})}
      />
    </div>
  );
}

export interface EngineBoostSectionProps {
  /** `model && !modelIsDraftOnly && showCockpitSurface`. */
  show: boolean;
  /** Wrapper class (harness / full-auto / assisted variants). */
  wrapperClass: string;
  codingMode: CodingModeId;
  speedBoost: SpeedBoostId;
  brains: BrainsId;
  think: ThinkId;
  /** `applyFullAutoCockpit` — the orchestrator's cockpit planner. */
  applyCockpit: (
    mode: CodingModeId,
    speed: SpeedBoostId,
    brainsPick: BrainsId,
    thinkPick: ThinkId,
    opts?: {
      powerUser?: boolean;
      rawSpecType?: string | null;
      preferredDraftPath?: string | null;
    },
  ) => Promise<void>;
  cockpitOpts: { powerUser: boolean };
  capabilities: SpecCapability[];
  dflashLibraryReady: boolean;
  dflashGettable: boolean;
  dflashDraftLabel: string | null;
  dflashGetState: DflashGetUiState;
  dflashGetError: string | null;
  dflashGetOfferLabel: string | null;
  onGetDflashDraft: () => void;
  onChangeDflashDraft: () => void;
  kvQuantValues: (string | number)[];
  parallelValues: (string | number)[];
  showAgents: boolean;
  showMemory: boolean;
  showThink: boolean;
  showBoost: boolean;
  agentsFromTemplateOnly: boolean;
  port: number;
  modelId: string;
  stack: StackEntry[];
  preferredSlotIdx: number | null;
  onHarnessOpenChange: (open: boolean) => void;
  onRelaunchSeat: (opts: {
    slotIdx: number;
    port: number;
    alias: string;
    parallel?: number;
  }) => Promise<void>;
  onSelectEngine: (slotIdx: number) => void;
  layout: "hero" | "normal";
  powerMode: boolean;
  rawSpecTypes: string[];
  activeRawSpecType: string | null;
  onRawSpecType: (raw: string | null) => void;
  specDetailParams: CockpitSpecDetailParam[];
  embedCtx: boolean;
  ctxStripProps: Omit<CockpitCtxStripProps, "className">;
  flagToggles: CockpitFlagToggle[];
  launchPresets?: MultiAgentBoosterProps["launchPresets"];
  presetTwinBind?: MultiAgentBoosterProps["presetTwinBind"];
  onPresetTwinBindConsumed?: MultiAgentBoosterProps["onPresetTwinBindConsumed"];
}
