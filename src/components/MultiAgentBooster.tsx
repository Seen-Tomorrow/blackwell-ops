import { useEffect, useMemo, type ReactNode } from "react";
import type { SpecCapability } from "../lib/specDraft";
import { ConfigChipSegment } from "./EngineParamGroups";
import {
  BRAINS_OPTIONS,
  THINK_OPTIONS,
  buildAgentOptions,
  buildMemoryOptions,
  collectBoostSpecTypes,
  compareBoostRank,
  parallelForCodingMode,
  parseSpecTypeBoostMark,
  resolveFullAutoPlan,
  shouldOmitSpecTypeFromBoost,
  type BoostMarkParts,
  type BrainsId,
  type CodingModeId,
  type SpeedBoostId,
  type ThinkId,
  type ThinkOption,
} from "../lib/multiAgentBooster";
import CockpitCtxStrip from "./CockpitCtxStrip";
import CockpitSlider from "./CockpitSlider";
import CockpitNavSegment from "./CockpitNavSegment";
import CockpitFlagToolbar, { type CockpitFlagToggle } from "./CockpitFlagToolbar";
import FullAutoGoalRail from "./FullAutoGoalRail";
import {
  fullAutoGoalBatchLabel,
  fullAutoWorkloadLabel,
  type FullAutoFitState,
  type FullAutoGoal,
  type FullAutoWorkload,
} from "../lib/fullAutoGoals";
import { formatCtxChipLabel } from "../lib/sliderParamUtils";

export type DflashGetUiState = "idle" | "searching" | "downloading" | "error";

/** Contextual SPECULATIVE-DECODING knobs under Boost (n_max, n_min, …). */
export interface CockpitSpecDetailParam {
  key: string;
  label: string;
  values: (string | number)[];
  current: string | number | undefined;
  userAdded?: boolean;
  onChange: (v: string | number) => void;
}

export interface MultiAgentBoosterProps {
  codingMode: CodingModeId;
  speedBoost: SpeedBoostId;
  brains: BrainsId;
  think: ThinkId;
  /** Marks the template actually maps (defaults to every product budget). */
  thinkOptions?: ThinkOption[];
  onCodingMode: (mode: CodingModeId) => void;
  onSpeedBoost: (speed: SpeedBoostId) => void;
  /** Planner normalization — never a user edit, so it must not hand off to ASSISTED. */
  onAutoSpeedBoost?: (speed: SpeedBoostId) => void;
  onBrains: (brains: BrainsId) => void;
  onThink: (think: ThinkId) => void;
  capabilities: SpecCapability[];
  dflashLibraryReady: boolean;
  /** Family likely has HF DFlash packs — offer Get draft when library empty. */
  dflashGettable?: boolean;
  /** Short name of paired draft when library ready. */
  dflashDraftLabel?: string | null;
  dflashGetState?: DflashGetUiState;
  dflashGetError?: string | null;
  dflashGetOfferLabel?: string | null;
  onGetDflashDraft?: () => void;
  /** Open local-library draft re-picker (when pairing is wrong). */
  onChangeDflashDraft?: () => void;
  /** Short name of the selected MTP head. Absent ⇒ no head chosen. */
  mtpDraftLabel?: string | null;
  /** Target carries baked-in nextn — MTP runs without any head file. */
  mtpBakedIn?: boolean;
  /** Open local-library MTP head picker. */
  onChangeMtpDraft?: () => void;
  kvQuantValues: (string | number)[];
  /** Factory + user-added parallel values for Agents marks. */
  parallelValues?: (string | number)[];
  /**
   * hero = Full Auto (+ optional CTX)
   * normal = Assisted Essentials command surface
   * compact = Assisted Full denser command (no Smart)
   */
  layout?: "hero" | "normal" | "compact";
  /**
   * Power path: no Smart product mode / batch push in plan.
   * Boost marks: Off + MTP + DFlash (+ raw factory types when provided).
   */
  powerMode?: boolean;
  /**
   * All factory + user-added spec_type values (Boost builds 2-word marks from these).
   * Eagle omitted by collector; MTP/DFlash get product accents.
   */
  rawSpecTypes?: string[];
  /** Selecting a non-MTP/DFlash/off/smart type. */
  onRawSpecType?: (specType: string | null) => void;
  /** Active non-MTP/DFlash spec_type (drives Boost thumb). */
  activeRawSpecType?: string | null;
  /**
   * SPEC-EXTRA knobs (Assisted Full) — n_max/n_min etc. Simple ngram needs no strip.
   */
  specDetailParams?: CockpitSpecDetailParam[];
  className?: string;
  /** When false, CTX is rendered outside (standalone strip). Default true when props present. */
  embedCtx?: boolean;
  ctxValue?: number | string;
  ctxDefault?: number | string;
  ctxValues?: (string | number)[];
  ctxStep?: number;
  onCtxChange?: (v: number) => void;
  ctxPerSlot?: number;
  ctxSlotCount?: number;
  learnedMarks?: number[];
  forecastCurve?: Array<{ ctx: number; gb: number }>;
  forecastFreeGb?: number;
  onPruneCustom?: (ctxs: number[]) => void | Promise<number | void>;
  /**
   * Which product sliders to show. Default all on (Master).
   * Custom providers pass false for missing template keys (no Solo–Army / Think / Boost fill).
   */
  /**
   * Header mini-toolbar flags (VISION / FLASH-ATT / LOAD-mode).
   * Direct catalog writes — not Full Auto plan (consent-friendly).
   */
  flagToggles?: CockpitFlagToggle[];
  showAgents?: boolean;
  showMemory?: boolean;
  showThink?: boolean;
  showBoost?: boolean;
  /** When true, Agents marks come only from parallelValues (no hardcoded 1–32 presets). */
  agentsFromTemplateOnly?: boolean;
  /** SAMPLE / THROUGHPUT rails rendered inside the cockpit footer. */
  instrumentSlot?: ReactNode;
  /** Unified KV chip in the CTX strip footer. */
  kvUnified?: boolean;
  onToggleKvUnified?: () => void;
  /** FULL AUTO goal rail (hero layout only). */
  autoGoal?: FullAutoGoal | null;
  onAutoGoal?: (goal: FullAutoGoal) => void;
  /** FULL AUTO SPEC lane override — no ASSISTED handoff. */
  onAutoSpec?: (speed: SpeedBoostId) => void;
  autoWorkload?: FullAutoWorkload | null;
  onAutoWorkload?: (workload: FullAutoWorkload) => void;
  autoFitState?: FullAutoFitState;
  autoFixing?: boolean;
  onAutoFix?: () => void;
  onTakeControl?: () => void;

}

export default function MultiAgentBooster({
  codingMode,
  speedBoost,
  brains,
  think,
  thinkOptions = THINK_OPTIONS,
  onCodingMode,
  onSpeedBoost,
  onAutoSpeedBoost,
  onBrains,
  onThink,
  capabilities,
  dflashLibraryReady,
  dflashGettable = false,
  dflashDraftLabel = null,
  dflashGetState = "idle",
  dflashGetError = null,
  dflashGetOfferLabel = null,
  onGetDflashDraft,
  onChangeDflashDraft,
  mtpDraftLabel = null,
  mtpBakedIn = false,
  onChangeMtpDraft,
  kvQuantValues,
  parallelValues,
  layout = "normal",
  powerMode = false,
  rawSpecTypes = [],
  onRawSpecType,
  activeRawSpecType = null,
  specDetailParams = [],
  className = "",
  embedCtx = true,
  ctxValue,
  ctxDefault,
  ctxValues,
  ctxStep = 1024,
  onCtxChange,
  ctxPerSlot,
  ctxSlotCount = 1,
  learnedMarks,
  forecastCurve,
  forecastFreeGb,
  onPruneCustom,
  flagToggles = [],
  showAgents = true,
  showMemory = true,
  showThink = true,
  showBoost = true,
  agentsFromTemplateOnly = false,
  instrumentSlot,
  kvUnified,
  onToggleKvUnified,
  autoGoal,
  onAutoGoal,
  onAutoSpec,
  autoWorkload,
  onAutoWorkload,
  autoFitState,
  autoFixing,
  onAutoFix,
  onTakeControl,
}: MultiAgentBoosterProps) {
  const hero = layout === "hero";
  const showCtxRail =
    embedCtx && onCtxChange != null && (ctxValues?.length ?? 0) > 0;
  const markCustomValues = !hero;

  const memoryOptions = useMemo(
    () => buildMemoryOptions(kvQuantValues, { markUnknownAsCustom: markCustomValues }),
    [kvQuantValues, markCustomValues],
  );
  const agentOptions = useMemo(
    () =>
      buildAgentOptions(parallelValues, {
        markNonPresetAsCustom: markCustomValues,
        onlyTemplateValues: agentsFromTemplateOnly,
      }),
    [parallelValues, markCustomValues, agentsFromTemplateOnly],
  );

  const plan = useMemo(
    () =>
      resolveFullAutoPlan({
        codingMode,
        speed: speedBoost,
        brains,
        think,
        // A manual MTP pick is not gated by detection (see mtpSelectable below).
        capabilities:
          speedBoost === "mtp" && !capabilities.includes("mtp")
            ? [...capabilities, "mtp" as const]
            : capabilities,
        dflashLibraryReady,
        dflashGettable,
        kvQuantValues,
        powerUser: powerMode,
      }),
    [
      codingMode,
      speedBoost,
      brains,
      think,
      capabilities,
      dflashLibraryReady,
      dflashGettable,
      kvQuantValues,
      powerMode,
    ],
  );

  useEffect(() => {
    if (activeRawSpecType) return;
    // Manual Boost picks stick. Only the soft Off/Smart mode is normalized by
    // the planner; an unready draft must ask for a draft, not revert the pick.
    if (speedBoost !== "off" && speedBoost !== "smart") return;
    const applyPlanSpeed = onAutoSpeedBoost ?? onSpeedBoost;
    if (plan.speed !== speedBoost) {
      applyPlanSpeed(plan.speed);
    }
  }, [plan.speed, speedBoost, onAutoSpeedBoost, onSpeedBoost, activeRawSpecType]);

  const capSet = useMemo(() => new Set(capabilities), [capabilities]);

  const displayBoost = powerMode
    ? speedBoost === "smart"
      ? "off"
      : speedBoost
    : speedBoost === "off"
      ? "smart"
      : speedBoost;

  const externalDraftBoost =
    displayBoost === "dflash" || displayBoost === "dspark";

  const showSpecExtra = useMemo(() => {
    if (specDetailParams.length === 0) return false;
    if (
      displayBoost === "mtp"
      || displayBoost === "dflash"
      || displayBoost === "dspark"
    ) {
      return true;
    }
    if (!activeRawSpecType) return false;
    const s = activeRawSpecType.toLowerCase();
    if (s.startsWith("ngram") || s.includes("simple")) return false;
    return s.startsWith("draft") || s.includes("draft");
  }, [specDetailParams.length, displayBoost, activeRawSpecType]);

  const showDflashGet =
    Boolean(onGetDflashDraft) &&
    displayBoost === "dflash" &&
    (plan.needsDflashDraft ||
      !dflashLibraryReady ||
      dflashGetState === "searching" ||
      dflashGetState === "downloading" ||
      dflashGetState === "error");

  const showDflashChange =
    Boolean(onChangeDflashDraft) &&
    (displayBoost === "dspark"
      || (displayBoost === "dflash" && dflashLibraryReady));

  /**
   * MTP head strip. Mirrors the DFlash shape: the row shows whether or not a head
   * is already chosen, so the picker is reachable on a first run and not only
   * after a head happens to be in config. Baked-in MTP is a property of the target
   * and has nothing to choose — the engine builds the draft context from the target
   * model itself — so that case reads `Baked-in` with no button.
   */
  const mtpHasHead = displayBoost === "mtp" && Boolean(mtpDraftLabel);
  const showMtp = displayBoost === "mtp";
  const showMtpChange = showMtp && Boolean(onChangeMtpDraft);
  const showMtpBakedIn = showMtp && !mtpHasHead && mtpBakedIn;

  const mtpAvailable = capSet.has("mtp");
  /**
   * MTP is a manual lane, like DSpark: a baked-in target or a user-picked
   * `mtp-*.gguf` head. Detection only decides the label — launch validates the
   * head, so a missing capability must not hide the choice.
   */
  const mtpSelectable = true;
  const dflashAvailable = dflashLibraryReady || dflashGettable || capSet.has("dflash");
  const heroSpecCapable = mtpSelectable || capSet.has("dflash");
  const heroSpecAllowed = autoGoal !== "agents";
  const heroSpecAvailable = heroSpecAllowed && heroSpecCapable;

  const boostMarks = useMemo((): BoostMarkParts[] => {
    const marks: BoostMarkParts[] = [];
    if (powerMode) {
      marks.push({
        id: "off",
        label: "Off",
        blurb: "Speculative decoding off — raw batch/ubatch in chips",
        rank: 0,
      });
    } else {
      marks.push({
        id: "smart",
        label: "Smart",
        blurb: "Push batch sizes for faster prefill when VRAM allows",
        rank: 0,
      });
    }

    const types = collectBoostSpecTypes(rawSpecTypes);
    for (const t of types) {
      const low = t.toLowerCase();
      if (
        low === "draft-mtp"
        || low === "mtp"
        || low === "draft-dflash"
        || low === "dflash"
        || low === "draft-dspark"
        || low === "dspark"
      ) {
        continue;
      }
      if (shouldOmitSpecTypeFromBoost(t)) continue;
      marks.push(parseSpecTypeBoostMark(t));
    }

    {
      const m = parseSpecTypeBoostMark("draft-mtp");
      m.blurb = mtpAvailable
        ? m.blurb
        : "MTP — baked-in target or pick an external mtp-*.gguf head";
      marks.push(m);
    }
    {
      const m = parseSpecTypeBoostMark("draft-dflash");
      m.blurb = dflashAvailable
        ? dflashLibraryReady
          ? dflashDraftLabel
            ? `Draft ready: ${dflashDraftLabel}`
            : "Draft ready in library"
          : dflashGettable
            ? "Draft downloadable — Get draft to confirm"
            : m.blurb
        : "DFlash not available for this model";
      marks.push(m);
    }
    {
      const m = parseSpecTypeBoostMark("draft-dspark");
      m.blurb = dflashLibraryReady
        ? dflashDraftLabel
          ? `Draft ready: ${dflashDraftLabel}`
          : "Draft path set — DeepSeek DSpark"
        : "Set draft GGUF via Change draft (dspark head)";
      marks.push(m);
    }

    const byId = new Map<string, BoostMarkParts>();
    for (const m of marks) {
      if (!byId.has(m.id)) byId.set(m.id, m);
    }
    return [...byId.values()].sort(compareBoostRank);
  }, [
    powerMode,
    rawSpecTypes,
    mtpAvailable,
    dflashAvailable,
    dflashLibraryReady,
    dflashGettable,
    dflashDraftLabel,
  ]);

  const boostSliderValue = useMemo(() => {
    if (activeRawSpecType) {
      return parseSpecTypeBoostMark(activeRawSpecType).id;
    }
    if (displayBoost === "mtp" || displayBoost === "dflash" || displayBoost === "dspark") {
      return displayBoost;
    }
    if (powerMode) return displayBoost === "smart" ? "off" : displayBoost;
    return displayBoost === "off" ? "smart" : displayBoost;
  }, [powerMode, displayBoost, activeRawSpecType]);

  const heroSpecOptions = (["off", "mtp", "dflash", "dspark"] as const).map((id) => {
    const mark = boostMarks.find((m) => m.id === id || (id === "off" && m.id === "smart"));
    const disabled = id === "dflash" && !dflashAvailable;
    return {
      id,
      label: id === "off" ? "OFF" : (mark?.label ?? id.toUpperCase()),
      title: mark?.blurb,
      disabled,
    };
  });
  const heroSpecValue = displayBoost === "smart" ? "off" : displayBoost;

  const heroSpecSwitch =
    hero && heroSpecAvailable && onAutoGoal && onAutoSpec && showBoost ? (
      <div
        className="flex items-center justify-end gap-2"
      >
        <span
          className="shrink-0 type-micro uppercase tracking-widest"
          style={{ color: "var(--theme-text-muted)" }}
        >
          SPEC
        </span>
        <CockpitNavSegment
          ariaLabel="AUTOPILOT SPEC"
          options={heroSpecOptions}
          selectedId={heroSpecValue}
          onSelect={(id) => onAutoSpec(id as SpeedBoostId)}
          size="sub"
          className="segment-switch--auto-goal"
        />
      </div>
    ) : null;

  const stripTone: "mtp" | "dflash" | "neutral" =
    displayBoost === "mtp"
      ? "mtp"
      : externalDraftBoost
        ? "dflash"
        : "neutral";

  const showDraftStrip =
    showDflashGet || showDflashChange || showMtp || showMtpBakedIn;
  const showVioletStrip =
    showDraftStrip || (showSpecExtra && specDetailParams.length > 0);

  const draftActions = showDraftStrip ? (
    <div className="full-auto-cockpit__dflash-get-actions">
      {showMtpChange ? (
        <button
          type="button"
          className="full-auto-cockpit__dflash-get-btn full-auto-cockpit__dflash-get-btn--ghost"
          onClick={() => onChangeMtpDraft?.()}
          title={
            showMtpBakedIn
              ? "Target already has a built-in MTP head. Pick an external MTP head only to override it."
              : "Pick a different MTP head GGUF from your library"
          }
        >
          {showMtpBakedIn ? "Override with external MTP" : "Change draft"}
        </button>
      ) : null}
      {showDflashChange ? (
        <button
          type="button"
          className="full-auto-cockpit__dflash-get-btn full-auto-cockpit__dflash-get-btn--ghost"
          onClick={() => onChangeDflashDraft?.()}
          title={
            displayBoost === "dspark"
              ? "Pick DSpark draft GGUF from your library"
              : "Pick a different DFlash draft from your library"
          }
        >
          Change draft
        </button>
      ) : null}
      {showDflashGet ? (
        <button
          type="button"
          className="full-auto-cockpit__dflash-get-btn"
          disabled={
            !onGetDflashDraft ||
            dflashGetState === "searching" ||
            dflashGetState === "downloading"
          }
          onClick={() => onGetDflashDraft?.()}
          title="Search Hugging Face for DFlash drafts — you confirm before download"
        >
          {dflashGetState === "searching"
            ? "Searching…"
            : dflashGetState === "downloading"
              ? "Downloading…"
              : dflashGetState === "error"
                ? "Retry Get draft"
                : "Get draft"}
        </button>
      ) : null}
    </div>
  ) : null;

  const draftStripInner = showDraftStrip ? (
    <>
      <div className="full-auto-cockpit__dflash-get-main min-w-0 flex-1">
        {showDflashGet ? (
          <>
            <div className="full-auto-cockpit__dflash-get-line">
              {dflashGetState === "searching"
                ? "Searching HF for matching drafts…"
                : dflashGetState === "downloading"
                  ? "Downloading draft…"
                  : dflashGetState === "error"
                    ? dflashGetError || "No DFlash draft found"
                    : "DFlash needs a draft model in your library"}
            </div>
            {dflashGetState === "downloading" && dflashGetOfferLabel ? (
              <div className="full-auto-cockpit__dflash-get-name" title={dflashGetOfferLabel}>
                {dflashGetOfferLabel}
              </div>
            ) : dflashGetState === "idle" || dflashGetState === "error" ? (
              <div className="full-auto-cockpit__dflash-get-sub">Confirm pack to download</div>
            ) : null}
          </>
        ) : showMtpBakedIn ? (
          <>
            <div className="full-auto-cockpit__dflash-get-line">MTP head</div>
            <div className="full-auto-cockpit__dflash-get-name">Baked-in</div>
          </>
        ) : displayBoost === "mtp" && !mtpDraftLabel ? (
          <>
            <div className="full-auto-cockpit__dflash-get-line">
              MTP needs a head in your library
            </div>
            <div className="full-auto-cockpit__dflash-get-sub">
              Pick mtp-*.gguf via Change draft
            </div>
          </>
        ) : displayBoost === "dspark" && !dflashLibraryReady && !dflashDraftLabel ? (
          <>
            <div className="full-auto-cockpit__dflash-get-line">
              DSpark needs a draft GGUF
            </div>
            <div className="full-auto-cockpit__dflash-get-sub">
              Pick dspark-*.gguf via Change draft
            </div>
          </>
        ) : (
          <>
            <div className="full-auto-cockpit__dflash-get-line">
              {displayBoost === "dspark"
                ? "DSpark draft"
                : displayBoost === "mtp"
                  ? "MTP head"
                  : "Paired draft"}
            </div>
            <div
              className="full-auto-cockpit__dflash-get-name"
              title={
                (displayBoost === "mtp" ? mtpDraftLabel : dflashDraftLabel) ?? undefined
              }
            >
              {(displayBoost === "mtp" ? mtpDraftLabel : dflashDraftLabel) || "—"}
            </div>
          </>
        )}
      </div>
      {draftActions}
    </>
  ) : null;

  const specExtraInline =
    showSpecExtra && specDetailParams.length > 0 ? (
      <div className="full-auto-cockpit__spec-extra font-mono min-w-0 flex-1">
        <span className="full-auto-cockpit__spec-extra-title shrink-0">SPEC-EXTRA</span>
        <div className="full-auto-cockpit__spec-extra-row min-w-0" style={{ flexWrap: "nowrap" }}>
          {specDetailParams.map((p, i) => {
            const rendered = p.values;
            const activeIdx = Math.max(
              0,
              rendered.findIndex((v) => String(v) === String(p.current)),
            );
            return (
              <div
                key={p.key}
                className="full-auto-cockpit__spec-extra-param inline-flex items-center gap-1 min-w-0"
                style={{ flex: "0 0 auto" }}
              >
                {i > 0 ? <span className="full-auto-cockpit__spec-extra-sep" aria-hidden>|</span> : null}
                <span
                  className={`full-auto-cockpit__spec-extra-key shrink-0${
                    p.userAdded ? " full-auto-cockpit__spec-extra-key--custom" : ""
                  }`}
                  title={p.key}
                >
                  {p.label}
                </span>
                <ConfigChipSegment activeIndex={activeIdx} ariaLabel={`${p.key} values`}>
                  {rendered.map((val) => {
                    const selected = String(p.current) === String(val);
                    return (
                      <button
                        key={`${p.key}-${String(val)}`}
                        type="button"
                        data-seg-i={rendered.indexOf(val)}
                        data-selected={selected ? "1" : undefined}
                        onClick={() => p.onChange(val)}
                        className={`config-value-segment__opt value-chip font-mono focus:outline-none ${
                          selected ? "value-chip-active" : ""
                        }`}
                      >
                        {String(val)}
                      </button>
                    );
                  })}
                </ConfigChipSegment>
              </div>
            );
          })}
        </div>
      </div>
    ) : null;

  const violetStrip = showVioletStrip ? (
    <div
      className={`full-auto-cockpit__dflash-get full-auto-cockpit__dflash-get--footer full-auto-cockpit__dflash-get--tone-${stripTone} font-mono min-w-0 flex-1 full-auto-cockpit__dflash-get--spec-extra`}
      style={{ maxWidth: "none", width: "100%", flexWrap: "nowrap", overflowX: "auto" }}
    >
      {draftStripInner && specExtraInline ? (
        <>
          {specExtraInline}
          <span className="full-auto-cockpit__spec-extra-sep full-auto-cockpit__spec-extra-sep--block" aria-hidden>
            |
          </span>
          {draftStripInner}
        </>
      ) : (
        <>
          {draftStripInner}
          {specExtraInline}
        </>
      )}
    </div>
  ) : null;

  const densityClass = hero
    ? "full-auto-cockpit--hero"
    : "full-auto-cockpit--normal";

  const ctxStrip =
    showCtxRail && onCtxChange != null ? (
      <CockpitCtxStrip
        ctxValue={ctxValue}
        ctxDefault={ctxDefault}
        ctxValues={ctxValues}
        ctxStep={ctxStep}
        onCtxChange={onCtxChange}
        ctxPerSlot={ctxPerSlot}
        ctxSlotCount={ctxSlotCount}
        learnedMarks={learnedMarks}
        forecastCurve={forecastCurve}
        forecastFreeGb={forecastFreeGb}
        onPruneCustom={onPruneCustom}
        standalone={false}
        kvUnified={kvUnified}
        onToggleKvUnified={onToggleKvUnified}
        hideKvControls={hero}
      />
    ) : null;

  const ctxNumeric = Number(ctxValue);
  const ctxLabel = Number.isFinite(ctxNumeric) ? formatCtxChipLabel(ctxNumeric) : null;
  const batchLabel = fullAutoGoalBatchLabel(autoGoal ?? null);
  const batchPhrase = batchLabel
    ? batchLabel === "BALANCE"
      ? "Balanced batch"
      : `${batchLabel.charAt(0)}${batchLabel.slice(1).toLowerCase()} batch`
    : null;
  const workloadLabel = fullAutoWorkloadLabel(autoWorkload ?? null);
  const fitLabel =
    autoFitState === "ready"
      ? "READY"
      : autoFitState === "tight"
        ? "TIGHT"
        : autoFitState === "estimating"
          ? "ESTIMATING"
          : null;
  const autoOutcome = [
    plan.outcome,
    workloadLabel,
    batchPhrase,
    ctxLabel ? `CTX ${ctxLabel}` : null,
    fitLabel,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <div
      className={`full-auto-cockpit ${densityClass} ${className}`}
      data-ctx-dock={showCtxRail ? "in" : "above"}
    >
      {/* Title left · AGENTIC HARNESS (accent) · soft note · flags */}
      <div className="full-auto-cockpit__header full-auto-cockpit__header--minimal">
        <span className="full-auto-cockpit__title font-mono tracking-[0.16em] uppercase shrink-0">
          {hero ? "Autopilot" : "Assisted cockpit"}
        </span>
        {hero ? (
          <span className="full-auto-cockpit__status-note font-mono min-w-0 truncate" title={autoOutcome}>
            {autoOutcome}
          </span>
        ) : plan.softNote ? (
          <span className="full-auto-cockpit__status-note font-mono min-w-0 truncate" title={plan.softNote}>
            {plan.softNote}
          </span>
        ) : null}
        <div className="full-auto-cockpit__header-right flex items-center gap-1.5 min-w-0 ml-auto shrink-0">
          <CockpitFlagToolbar
            flags={hero ? flagToggles.filter((f) => f.key !== "flash_attn") : flagToggles}
          />
        </div>
      </div>

      {hero && onAutoGoal ? (
        <div className="full-auto-cockpit__body space-y-3">
          {ctxStrip}
          <FullAutoGoalRail
            goal={autoGoal ?? null}
            workload={autoWorkload ?? null}
            hero
            fitState={autoFitState}
            fixing={autoFixing}
            onGoal={onAutoGoal}
            onWorkload={onAutoWorkload ?? (() => {})}
            onFix={onAutoFix}
            onTakeControl={onTakeControl}
            specSlot={heroSpecSwitch}
            specExtraSlot={heroSpecAvailable ? violetStrip : null}
          />
        </div>
      ) : null}

      {!(hero && onAutoGoal) ? (
        <>
          <div className="full-auto-cockpit__body space-y-3">
        {ctxStrip}

        <div className="full-auto-cockpit__grid">
          {showMemory && memoryOptions.length > 0 && (
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Memory"
              value={
                memoryOptions.some((o) => o.id === brains)
                  ? brains
                  : memoryOptions[0]?.id ?? brains
              }
              onChange={onBrains}
              options={memoryOptions.map((o) => ({
                id: o.id,
                label: o.label,
                blurb: o.blurb,
                custom: o.custom,
              }))}
              valueBadge={
                memoryOptions.find((o) => o.id === brains)?.kvQuant
                ?? BRAINS_OPTIONS.find((o) => o.id === brains)?.kvQuant
                ?? (typeof brains === "string" && brains.startsWith("kv:")
                  ? brains.slice(3)
                  : undefined)
              }
              badgeWidth="3rem"
              heroBadge
            />
          </div>
          )}
          {showAgents && agentOptions.length > 0 && (
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Agents"
              value={codingMode}
              onChange={onCodingMode}
              options={agentOptions.map((o) => ({
                id: o.id,
                label: o.label,
                blurb: `${o.blurb} (x${o.parallel})`,
                custom: o.custom,
              }))}
              valueBadge={`x${parallelForCodingMode(codingMode)}`}
              badgeWidth="3rem"
              heroBadge
            />
          </div>
          )}

          {showBoost && (
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Boost"
              value={boostSliderValue}
              onChange={(id) => {
                // One parent apply only — do NOT call onRawSpecType(null) before MTP/DFlash/Off.
                // That used to fire apply(off) then apply(mtp) and the off path often won the race
                // (MTP only worked after Off→MTP; raw types blocked Off).
                if (id === "off") {
                  onSpeedBoost("off");
                  return;
                }
                if (id === "smart") {
                  onSpeedBoost("smart");
                  return;
                }
                if (id === "mtp" || id === "dflash" || id === "dspark") {
                  onSpeedBoost(id);
                  return;
                }
                if (id.startsWith("raw:")) {
                  onRawSpecType?.(id.slice(4));
                  return;
                }
                onSpeedBoost(id as SpeedBoostId);
              }}
              options={boostMarks.map((m) => {
                // DFlash keeps its library gate; MTP is a manual lane (see mtpSelectable).
                const needCap = m.id === "dflash" && !dflashAvailable;
                const available =
                  m.id === "smart" ||
                  m.id === "off" ||
                  m.id === "dspark" ||
                  m.id === "mtp" ||
                  (m.id === "dflash" && dflashAvailable) ||
                  m.id.startsWith("raw:");
                return {
                  id: m.id,
                  label: m.label,
                  aboveLabel: m.aboveLabel,
                  blurb: m.blurb,
                  disabled: needCap,
                  badgeColor: m.badgeColor,
                  // Color track mark + under-label only (not above family word)
                  emphasize: Boolean(m.badgeColor) && available && !needCap,
                };
              })}
            />
          </div>
          )}
          {showThink && (
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Think"
              value={think}
              onChange={onThink}
              options={thinkOptions.map((o) => ({
                id: o.id,
                label: o.label,
                blurb: o.blurb,
              }))}
            />
          </div>
          )}
        </div>

        {/* SPEC-EXTRA / draft strip sits above the BATCH/UBATCH instrument row. */}
        {violetStrip ? (
          <div className="full-auto-cockpit__footer full-auto-cockpit__footer--actions">
            {violetStrip}
          </div>
        ) : null}

        {instrumentSlot ? (
          <div className="full-auto-cockpit__instruments">{instrumentSlot}</div>
        ) : null}

      </div>
        </>
      ) : null}
    </div>
  );
}
