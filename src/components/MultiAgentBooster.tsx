import { useEffect, useMemo } from "react";
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
} from "../lib/multiAgentBooster";
import CockpitCtxStrip from "./CockpitCtxStrip";
import CockpitSlider from "./CockpitSlider";
import CockpitFlagToolbar, { type CockpitFlagToggle } from "./CockpitFlagToolbar";

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
  onCodingMode: (mode: CodingModeId) => void;
  onSpeedBoost: (speed: SpeedBoostId) => void;
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

}

export default function MultiAgentBooster({
  codingMode,
  speedBoost,
  brains,
  think,
  onCodingMode,
  onSpeedBoost,
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
}: MultiAgentBoosterProps) {
  const hero = layout === "hero";
  const densityUnified = !hero;
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
        capabilities,
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
    if (plan.speed !== speedBoost) {
      onSpeedBoost(plan.speed);
    }
  }, [plan.speed, speedBoost, onSpeedBoost, activeRawSpecType]);

  const capSet = useMemo(() => new Set(capabilities), [capabilities]);

  const displayBoost = powerMode
    ? plan.speed === "smart"
      ? "off"
      : plan.speed
    : plan.speed === "off"
      ? "smart"
      : plan.speed;

  const externalDraftBoost =
    displayBoost === "dflash" || displayBoost === "dspark";

  const showSpecExtra = useMemo(() => {
    if (hero || specDetailParams.length === 0) return false;
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
  }, [hero, specDetailParams.length, displayBoost, activeRawSpecType]);

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

  const mtpAvailable = capSet.has("mtp");
  const dflashAvailable = dflashLibraryReady || dflashGettable || capSet.has("dflash");
  const mtpLocksAgents = displayBoost === "mtp";

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
        : "MTP not available for this model";
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

  const stripTone: "mtp" | "dflash" | "neutral" =
    displayBoost === "mtp"
      ? "mtp"
      : externalDraftBoost
        ? "dflash"
        : "neutral";

  const showDraftStrip = showDflashGet || showDflashChange;
  const showVioletStrip =
    showDraftStrip || (showSpecExtra && specDetailParams.length > 0);

  const draftActions = showDraftStrip ? (
    <div className="full-auto-cockpit__dflash-get-actions">
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
              {displayBoost === "dspark" ? "DSpark draft" : "Paired draft"}
            </div>
            <div
              className="full-auto-cockpit__dflash-get-name"
              title={dflashDraftLabel ?? undefined}
            >
              {dflashDraftLabel || "—"}
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
        <div className="full-auto-cockpit__spec-extra-row min-w-0">
          {specDetailParams.map((p, i) => {
            const rendered = p.values;
            const activeIdx = Math.max(
              0,
              rendered.findIndex((v) => String(v) === String(p.current)),
            );
            return (
              <div key={p.key} className="full-auto-cockpit__spec-extra-param inline-flex items-center gap-1 min-w-0">
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
      data-strip-tone={stripTone}
    >
      {draftStripInner && specExtraInline ? (
        <>
          {specExtraInline}
          <span className="full-auto-cockpit__spec-extra-sep full-auto-cockpit__spec-extra-sep--block" aria-hidden>
            |
          </span>
          {draftActions}
        </>
      ) : (
        <>
          {draftStripInner}
          {draftStripInner && specExtraInline ? (
            <span className="full-auto-cockpit__spec-extra-sep full-auto-cockpit__spec-extra-sep--block" aria-hidden>
              |
            </span>
          ) : null}
          {specExtraInline}
        </>
      )}
    </div>
  ) : null;

  const densityClass = hero
    ? "full-auto-cockpit--hero"
    : "full-auto-cockpit--normal";
  return (
    <div
      className={`full-auto-cockpit ${densityClass} ${className}`}
      data-booster-layout={layout}
      data-power-mode={powerMode ? "on" : "off"}
      data-density-unified={densityUnified ? "on" : "off"}
      data-ctx-dock={showCtxRail ? "in" : "above"}
    >
      {/* Title left · AGENTIC HARNESS (accent) · soft note · flags */}
      <div className="full-auto-cockpit__header full-auto-cockpit__header--minimal">
        <span className="full-auto-cockpit__title font-mono tracking-[0.16em] uppercase shrink-0">
          {powerMode ? "Power cockpit" : "Launch cockpit"}
        </span>
        {plan.softNote ? (
          <span className="full-auto-cockpit__status-note font-mono min-w-0 truncate" title={plan.softNote}>
            {plan.softNote}
          </span>
        ) : null}
        <div className="full-auto-cockpit__header-right flex items-center gap-1.5 min-w-0 ml-auto shrink-0">
          <CockpitFlagToolbar flags={flagToggles} />
        </div>
      </div>

      <div className="full-auto-cockpit__body space-y-3">
        {showCtxRail && onCtxChange != null && (
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
          />
        )}

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
              value={mtpLocksAgents ? "solo" : codingMode}
              onChange={onCodingMode}
              options={agentOptions.map((o) => {
                const locked = mtpLocksAgents && o.id !== "solo";
                return {
                  id: o.id,
                  label: o.label,
                  blurb: locked
                    ? "MTP needs Solo — multi-agent disabled"
                    : `${o.blurb} (x${o.parallel})`,
                  disabled: locked,
                  strike: locked,
                  custom: o.custom,
                };
              })}
              valueBadge={`x${mtpLocksAgents ? 1 : parallelForCodingMode(codingMode)}`}
              badgeWidth="3rem"
              heroBadge
              className={mtpLocksAgents ? "cockpit-slider-row--mtp-agents" : ""}
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
                const mtpMissing = m.id === "mtp" && !mtpAvailable;
                const dflashMissing = m.id === "dflash" && !dflashAvailable;
                const needCap = mtpMissing || dflashMissing;
                const available =
                  m.id === "smart" ||
                  m.id === "off" ||
                  m.id === "dspark" ||
                  (m.id === "mtp" && mtpAvailable) ||
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
              options={THINK_OPTIONS.map((o) => ({
                id: o.id,
                label: o.label,
                blurb: o.blurb,
              }))}
            />
          </div>
          )}
        </div>

      </div>

      {/* Footer: draft strip + SPEC-EXTRA only (AGENTIC lives in header). */}
      {violetStrip ? (
        <div className="full-auto-cockpit__footer full-auto-cockpit__footer--actions">
          {violetStrip}
        </div>
      ) : null}
    </div>
  );
}
