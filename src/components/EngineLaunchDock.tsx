import type { ReactNode } from "react";
import type { ConfigViewMode, ModelEntry, StackEntry } from "../lib/types";
import type { LaunchDockPosition } from "../lib/storage";
import RunningEnginesPanel from "./RunningEnginesPanel";

const LAUNCH_DOCK_LABEL_CLASS =
  "config-launch-dock__label font-mono w-11 flex-shrink-0 uppercase tracking-wider truncate text-[9px] text-stealth-muted";

function paramChipClass(active: boolean): string {
  return `px-2 py-0.5 text-[9px] font-mono rounded-sm focus:outline-none ${
    active ? "value-chip-active" : "value-chip"
  }`;
}

/**
 * Shared launch dock — rendered at the BOTTOM bar or the RIGHT RAIL.
 * The orchestrator owns all launch/config state and passes slices down;
 * this component is pure presentational structure for the two dock layouts.
 *
 * Position-specific differences (wrapper, warning text, replace-confirm id,
 * running-engines panel, custom-flags placement) are handled here so the
 * duplicated alias/port/action markup lives in exactly ONE place.
 */
export default function EngineLaunchDock(props: EngineLaunchDockProps) {
  const {
    position,
    // dim (bottom only)
    harnessWizardOpen = false,
    showRightColumn = false,
    // flags pill (bottom only)
    launchDockCollapsed = false,
    onExpandCollapsedDock = () => {},
    // warnings
    specParallelWarn,
    mtpParallelSlotCount,
    fullAutoFixed,
    modelIsDraftOnly,
    // custom flags renderer
    renderCustomFlags,
    uiDensityCompact,
    configView,
    // alias
    aliasDisplayValue,
    aliasIsUserSet,
    aliasShowClr,
    autoAlias,
    onAliasChange,
    onAliasFocus,
    onAliasBlur,
    onAliasClear,
    // port
    portRow,
    // action
    isDev,
    onOpenNobsproofCmd,
    onOpenLlamaBenchCmd,
    launchDisabled,
    replaceLaunchConfirmOpen,
    onCancelReplaceLaunch,
    acknowledgeReplaceLaunch,
    onLaunchClick,
    launchAck,
    customFlagsReplaceActive,
    customFlagsLaunchActive,
    isCustomProvider,
    hasModel,
    selectedProfileIsBuilding,
    specNeedsExternalDraft,
    draftPathValid,
    // rail running engines
    enginesInRail,
    stack,
    models,
    selectedSlotIdx,
    onSelectEngine,
    secondarySlotIdx = null,
    onPinSecondary,
    isHotSwapStale,
    onHotSwap,
  } = props;

  const rail = position === "right";

  const renderWarnings = () => (
    <>
      {specParallelWarn && !fullAutoFixed && (
        <div
          className={`config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug${
            rail ? " shrink-0" : ""
          }`}
          role="status"
        >
          <span className="uppercase tracking-wide">⚠ MTP limited at launch</span>
          {" — "}
          <span className="config-mtp-launch-warn__detail">
            parallel ×{mtpParallelSlotCount} strips MTP speculative decoding. Use parallel = 1 for MTP, or switch to DFlash for multi-slot.
          </span>
        </div>
      )}
      {specParallelWarn && fullAutoFixed && (
        <div
          className={`config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug${
            rail ? " shrink-0" : ""
          }`}
          role="status"
        >
          <span className="config-mtp-launch-warn__detail">
            {rail
              ? "Multi-agent is on — use Speed Off/DFlash, or Agents Solo for MTP."
              : "Multi-agent is on — Speed boost will use Off or DFlash (MTP needs Solo). Tap Speed → Off, or Agents → Solo for MTP."}
          </span>
        </div>
      )}
      {modelIsDraftOnly && (
        <div
          className={`config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug${
            rail ? " shrink-0" : ""
          }`}
          role="status"
        >
          <span className="uppercase tracking-wide">{fullAutoFixed ? "Wrong model" : "Draft model"}</span>
          {" — "}
          <span className="config-mtp-launch-warn__detail">
            {fullAutoFixed
              ? "This file is a draft helper, not a main model. Pick a full chat model from the list."
              : "Cannot launch draft GGUF as main. Filter catalog to MAIN and pick the base model."}
          </span>
        </div>
      )}
    </>
  );

  const renderAliasPort = () => (
    <div className={`config-launch-dock__meta${rail ? " flex flex-col gap-2 shrink-0" : ""}`}>
      <div data-param-row className="config-launch-dock__alias flex items-center min-h-[22px] min-w-0">
        <span
          className={LAUNCH_DOCK_LABEL_CLASS}
          title={
            aliasIsUserSet
              ? "Alias — user set"
              : `Alias — autoset to ${autoAlias}`
          }
        >
          Alias
        </span>
        <div
          className={`config-launch-dock__alias-field flex-1 min-w-0${
            aliasShowClr ? " config-launch-dock__alias-field--has-clr" : ""
          }`}
        >
          <input
            type="text"
            value={aliasDisplayValue}
            onFocus={onAliasFocus}
            onBlur={onAliasBlur}
            onChange={(e) => onAliasChange(e.target.value)}
            title={
              aliasIsUserSet
                ? "User-set launch alias"
                : `Autoset to ${autoAlias} — updates as engines start/stop`
            }
            className={`w-full min-w-0 transition-colors ${
              aliasIsUserSet
                ? `${paramChipClass(true)} mono-user-input`
                : paramChipClass(false)
            }`}
          />
          {aliasShowClr ? (
            <button
              type="button"
              className="config-launch-dock__alias-clr"
              title={`Clear custom alias — revert to ${autoAlias}`}
              onMouseDown={(e) => e.preventDefault()}
              onClick={onAliasClear}
            >
              CLR
            </button>
          ) : null}
        </div>
      </div>
      {portRow && (
        <div className="config-launch-dock__port min-w-0">
          {portRow}
        </div>
      )}
    </div>
  );

  const renderAction = (replaceId: string) => (
    <div className={`config-launch-dock__action relative${rail ? " shrink-0" : ""}`}>
      {isDev && (
        <>
          <button
            type="button"
            onClick={onOpenLlamaBenchCmd}
            disabled={launchDisabled}
            className="config-nobsproof-btn absolute bottom-1 right-10 z-20 px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-wider rounded-sm border disabled:opacity-40 disabled:cursor-not-allowed"
            title="llama-bench — map launch knobs → industry bench in external CMD (DEV). Edit config/llama-bench/defaults.json for -p/-n sweeps."
          >
            BENCH
          </button>
          <button
            type="button"
            onClick={onOpenNobsproofCmd}
            disabled={launchDisabled}
            className="config-nobsproof-btn absolute bottom-1 right-1 z-20 px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-wider rounded-sm border disabled:opacity-40 disabled:cursor-not-allowed"
            title="NoBSproof — open exact launch CLI in a new CMD window (DEV)"
          >
            CMD
          </button>
        </>
      )}
      {replaceLaunchConfirmOpen && (
        <div
          className="config-replace-confirm absolute inset-0 z-10 flex flex-col justify-center gap-2 rounded-sm px-2 py-2"
          role="alertdialog"
          aria-labelledby={replaceId}
        >
          <p
            id={replaceId}
            className="text-[7px] font-mono leading-snug text-white/95"
          >
            <span className="uppercase tracking-wide font-semibold">Replace mode</span>
            {" — "}
            panel settings are ignored. Only your custom flags are sent to the engine.
          </p>
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={acknowledgeReplaceLaunch}
              className="config-replace-confirm__launch flex-1 px-2 py-1 text-[7px] font-mono uppercase tracking-wide rounded-sm"
            >
              Launch anyway
            </button>
            <button
              type="button"
              onClick={onCancelReplaceLaunch}
              className="config-replace-confirm__cancel px-2 py-1 text-[7px] font-mono uppercase tracking-wide rounded-sm"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      <button
        onClick={onLaunchClick}
        disabled={launchDisabled}
        title={
          launchDisabled
            ? !hasModel
              ? "Select a model first"
              : modelIsDraftOnly
                ? "Draft models cannot launch as mains"
                : selectedProfileIsBuilding
                  ? "Binary profile is building"
                  : specNeedsExternalDraft && !draftPathValid
                    ? "Select a draft model for speculative decoding"
                    : "Launch blocked"
            : customFlagsReplaceActive
              ? "REPLACE mode — panel config is bypassed; only custom flags are used"
              : customFlagsLaunchActive
                ? "APPEND mode — custom flags are added to panel config"
                : isCustomProvider
                  ? "Custom provider — VRAM forecast does not block launch"
                  : undefined
        }
        className={`w-full h-full min-h-[2.75rem] min-w-0 ignite-btn config-launch-btn px-2 py-1.5 text-[11px] font-mono tracking-[0.18em] rounded-sm disabled:opacity-40 disabled:cursor-not-allowed flex flex-col items-stretch justify-center gap-0.5 ${customFlagsLaunchActive ? "overflow-visible" : "overflow-hidden"} ${launchAck ? "launch-ack" : ""}${customFlagsLaunchActive ? " config-launch-btn--custom-active" : ""}`}
      >
        {customFlagsLaunchActive && (
          <span
            className={`config-launch-btn__custom-warn uppercase tracking-wide${
              customFlagsReplaceActive ? "" : " config-launch-btn__custom-warn--append"
            }`}
          >
            Custom engine config active
          </span>
        )}
        <span className="text-center">LAUNCH ENGINE</span>
        <span className="config-launch-btn__hint text-[7px] font-mono tracking-wider normal-case font-normal text-center">
          Ctrl+Enter
        </span>
      </button>
    </div>
  );

  // ── Rail variant (full-height right column) ─────────────────────────────
  if (rail) {
    return (
      <div className="launch-rail-launch flex flex-col flex-shrink-0 min-w-0">
        <div className="config-launch-dock flex flex-col flex-shrink-0 px-3 pt-2">
          <div className="config-launch-dock__content flex flex-col flex-shrink-0 min-w-0">
            {enginesInRail && onSelectEngine && models && (
              <RunningEnginesPanel
                stack={stack}
                models={models}
                selectedSlotIdx={selectedSlotIdx ?? null}
                onSelectEngine={onSelectEngine}
                secondarySlotIdx={secondarySlotIdx}
                onPinSecondary={onPinSecondary}
                variant="rail"
                isHotSwapStale={isHotSwapStale}
                onHotSwap={onHotSwap}
              />
            )}
            {renderWarnings()}
            <div className="config-launch-dock__grid config-launch-dock__grid--rail flex flex-col flex-shrink-0 gap-2">
              {configView === "full" && (
                <div className="config-launch-dock__rail-flags flex-shrink-0 overflow-y-auto eink-scrollbar">
                  {renderCustomFlags()}
                </div>
              )}
              {renderAliasPort()}
              {renderAction("replace-confirm-title-rail")}
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Bottom variant (full-width bottom bar) ──────────────────────────────
  return (
    <div
      className="config-launch-dock flex-shrink-0 px-4 flex flex-col"
      data-launch-dock-dim={
        harnessWizardOpen && !showRightColumn ? "true" : "false"
      }
    >
      <div className="config-launch-dock__content flex flex-col min-w-0">
        {launchDockCollapsed && customFlagsLaunchActive && configView === "full" && (
          <button
            type="button"
            onClick={onExpandCollapsedDock}
            className="config-launch-dock__flags-pill w-full text-left rounded-sm px-2 py-1 text-[7px] font-mono border border-amber-500/35 text-amber-300/85 bg-amber-500/10 hover:bg-amber-500/15 transition-colors"
            title="Expand dock to edit custom flags"
          >
            CUSTOM FLAGS {customFlagsReplaceActive ? "REPLACE" : "APPEND"} — click to expand
          </button>
        )}
        {renderWarnings()}
        <div className="config-launch-dock__grid">
          <div className="config-launch-dock__left">
            {renderAliasPort()}
            {!uiDensityCompact && !launchDockCollapsed && renderCustomFlags()}
          </div>
          {renderAction("replace-confirm-title")}
        </div>
      </div>
    </div>
  );
}

export interface EngineLaunchDockProps {
  position: LaunchDockPosition;
  /** Bottom dim: harness wizard open with the right rail closed. */
  harnessWizardOpen?: boolean;
  showRightColumn?: boolean;
  /** Bottom: collapsed flags pill. */
  launchDockCollapsed?: boolean;
  onExpandCollapsedDock?: () => void;
  /** Warnings. */
  specParallelWarn: boolean;
  mtpParallelSlotCount: number;
  fullAutoFixed: boolean;
  modelIsDraftOnly: boolean;
  /** Custom flags block renderer (orchestrator owns editor state + popover). */
  renderCustomFlags: () => ReactNode;
  uiDensityCompact: boolean;
  configView: ConfigViewMode;
  /** Alias. */
  aliasDisplayValue: string;
  aliasIsUserSet: boolean;
  aliasShowClr: boolean;
  autoAlias: string;
  onAliasChange: (value: string) => void;
  onAliasFocus: (e: React.FocusEvent<HTMLInputElement>) => void;
  onAliasBlur: () => void;
  onAliasClear: () => void;
  /** Port param row (rendered by the orchestrator's shared row renderer). */
  portRow: ReactNode | null;
  /** Launch action. */
  isDev: boolean;
  onOpenNobsproofCmd: () => void;
  onOpenLlamaBenchCmd: () => void;
  launchDisabled: boolean;
  replaceLaunchConfirmOpen: boolean;
  onCancelReplaceLaunch: () => void;
  acknowledgeReplaceLaunch: () => void;
  onLaunchClick: () => void;
  launchAck: boolean;
  customFlagsReplaceActive: boolean;
  customFlagsLaunchActive: boolean;
  isCustomProvider: boolean;
  hasModel: boolean;
  selectedProfileIsBuilding: boolean;
  specNeedsExternalDraft: boolean;
  draftPathValid: boolean;
  /** Rail: running engines panel. */
  enginesInRail: boolean;
  stack: StackEntry[];
  models?: ModelEntry[];
  selectedSlotIdx: number | null;
  onSelectEngine?: (slotIdx: number) => void;
  secondarySlotIdx?: number | null;
  onPinSecondary?: (slotIdx: number) => void;
  isHotSwapStale?: (entry: StackEntry) => boolean;
  onHotSwap?: (entry: StackEntry) => void;
}
