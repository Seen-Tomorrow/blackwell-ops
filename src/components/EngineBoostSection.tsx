import type { ReactNode } from "react";
import type {
  BrainsId,
  CodingModeId,
  SpeedBoostId,
  ThinkId,
  ThinkOption,
} from "../lib/multiAgentBooster";
import type { SpecCapability } from "../lib/specDraft";
import type { FullAutoFitState, FullAutoGoal, FullAutoWorkload } from "../lib/fullAutoGoals";
import MultiAgentBooster, {
  type CockpitSpecDetailParam,
} from "./MultiAgentBooster";
import type { CockpitFlagToggle } from "./CockpitFlagToolbar";
import type { CockpitCtxStripProps } from "./CockpitCtxStrip";

/**
 * Boost / Multi-agent cockpit wrapper. Renders the `MultiAgentBooster` leaf
 * inside the params scroll column. Pure presentational — the orchestrator owns
 * all cockpit state + `applyFullAutoCockpit` and passes slices + handlers down.
 *
 * Harness connect lives in HarnessConnectHost (forecast column), not here.
 */
export default function EngineBoostSection(props: EngineBoostSectionProps) {
  const {
    show,
    wrapperClass,
    codingMode,
    speedBoost,
    brains,
    think,
    thinkOptions,
    applyCockpit,
    cockpitOpts,
    capabilities,
    dflashLibraryReady,
    dflashGettable,
    dflashDraftLabel,
    mtpDraftLabel,
    mtpBakedIn,
    specFileRows = [],
    onPickSpecFile,
    dflashDraftPath = null,
    mtpDraftPath = null,
    modelHubId,
    onPickRepoDraft,
    kvQuantValues,
    parallelValues,
    showAgents,
    showMemory,
    showThink,
    showBoost,
  modelPath,
  batchSlot,
    agentsFromTemplateOnly,
    layout,
    powerMode,
    rawSpecTypes,
    activeRawSpecType,
    specDetailParams,
    embedCtx,
    ctxStripProps,
    flagToggles,
    instrumentSlot,
    autoGoal,
    onAutoGoal,
    onAutoSpec,
    autoWorkload,
    onAutoWorkload,
    autoFitState,
    autoFixing,
    onAutoFix,
    onTakeControl,
  } = props;

  if (!show) return null;

  const manual = (apply: () => void) => {
    onTakeControl?.();
    apply();
  };

  return (
    <div className={wrapperClass}>
      <MultiAgentBooster
        codingMode={codingMode}
        speedBoost={speedBoost}
        brains={brains}
        think={think}
        thinkOptions={thinkOptions}
        onCodingMode={(m) => {
          manual(() => { void applyCockpit(m, speedBoost, brains, think, cockpitOpts); });
        }}
        onSpeedBoost={(s) => {
          manual(() => { void applyCockpit(codingMode, s, brains, think, cockpitOpts); });
        }}
        onAutoSpeedBoost={(s) => {
          void applyCockpit(codingMode, s, brains, think, cockpitOpts);
        }}
        onBrains={(b) => {
          manual(() => { void applyCockpit(codingMode, speedBoost, b, think, cockpitOpts); });
        }}
        onThink={(t) => {
          manual(() => { void applyCockpit(codingMode, speedBoost, brains, t, cockpitOpts); });
        }}
        flagToggles={flagToggles}
        capabilities={capabilities}
        dflashLibraryReady={dflashLibraryReady}
        dflashGettable={dflashGettable}
        dflashDraftLabel={dflashDraftLabel}
        mtpDraftLabel={mtpDraftLabel}
        mtpBakedIn={mtpBakedIn}
        specFileRows={specFileRows}
        onPickSpecFile={onPickSpecFile}
        dflashDraftPath={dflashDraftPath}
        mtpDraftPath={mtpDraftPath}
        modelHubId={modelHubId}
        onPickRepoDraft={onPickRepoDraft}
        kvQuantValues={kvQuantValues}
        parallelValues={parallelValues}
        showAgents={showAgents}
        showMemory={showMemory}
        showThink={showThink}
        showBoost={showBoost}
      modelPath={modelPath}
      batchSlot={batchSlot}
        agentsFromTemplateOnly={agentsFromTemplateOnly}
        layout={layout}
        powerMode={powerMode}
        rawSpecTypes={rawSpecTypes}
        activeRawSpecType={activeRawSpecType}
        onRawSpecType={(raw) => {
          // Raw factory types only — product Off/MTP/DFlash use onSpeedBoost alone.
          if (raw == null) return;
          manual(() => {
            void applyCockpit(codingMode, "off", brains, think, {
              powerUser: true,
              rawSpecType: raw,
            });
          });
        }}
        specDetailParams={specDetailParams}
        embedCtx={embedCtx}
        {...(embedCtx ? ctxStripProps : {})}
        instrumentSlot={instrumentSlot}
        autoGoal={autoGoal}
        onAutoGoal={onAutoGoal}
        onAutoSpec={onAutoSpec}
        autoWorkload={autoWorkload}
        onAutoWorkload={onAutoWorkload}
        autoFitState={autoFitState}
        autoFixing={autoFixing}
        onAutoFix={onAutoFix}
        onTakeControl={onTakeControl}
      />
    </div>
  );
}

export interface EngineBoostSectionProps {
  /** `model && !modelIsDraftOnly && showCockpitSurface`. */
  show: boolean;
  /** Wrapper class (full-auto / assisted variants). */
  wrapperClass: string;
  codingMode: CodingModeId;
  speedBoost: SpeedBoostId;
  brains: BrainsId;
  think: ThinkId;
  /** Marks the template actually maps (2k/4k/8k only when offered). */
  thinkOptions: ThinkOption[];
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
  mtpDraftLabel: string | null;
  mtpBakedIn: boolean;
  /** Local draft heads for the active SPEC lane, available without opening the modal. */
  specFileRows?: { id: string; title: string; meta?: string; score?: number }[];
  /** Applies a picked draft head path. */
  onPickSpecFile?: (path: string) => void;
  /** Resolver state for the HF-id field. */
  /** Absolute draft head paths, so the picker can mark the landed one. */
  dflashDraftPath?: string | null;
  mtpDraftPath?: string | null;
  /** Hub repo id of the selected model (DRAFT lane lists it like the Hub). */
  modelHubId?: string;
  onPickRepoDraft?: (item: import("../lib/types").RepoCompanion) => void;
  kvQuantValues: (string | number)[];
  parallelValues: (string | number)[];
  showAgents: boolean;
  showMemory: boolean;
  showThink: boolean;
  showBoost: boolean;
  /** Active main model path — LOADOUT companions. */
  modelPath?: string | null;
  batchSlot?: React.ReactNode;
  agentsFromTemplateOnly: boolean;
  layout: "hero" | "normal";
  powerMode: boolean;
  rawSpecTypes: string[];
  activeRawSpecType: string | null;
  onRawSpecType: (raw: string | null) => void;
  specDetailParams: CockpitSpecDetailParam[];
  embedCtx: boolean;
  ctxStripProps: Omit<CockpitCtxStripProps, "className">;
  flagToggles: CockpitFlagToggle[];
  instrumentSlot?: ReactNode;
  autoGoal?: FullAutoGoal | null;
  onAutoGoal?: (goal: FullAutoGoal) => void;
  onAutoSpec?: (speed: SpeedBoostId) => void;
  autoWorkload?: FullAutoWorkload | null;
  onAutoWorkload?: (workload: FullAutoWorkload) => void;
  autoFitState?: FullAutoFitState;
  autoFixing?: boolean;
  onAutoFix?: () => void;
  onTakeControl?: () => void;
}
