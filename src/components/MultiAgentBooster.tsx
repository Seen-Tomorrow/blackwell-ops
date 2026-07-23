import { useCallback, useEffect, useMemo, useState } from "react";
import type { SpecCapability } from "../lib/specDraft";
import {
  BRAINS_OPTIONS,
  THINK_OPTIONS,
  buildAgentOptions,
  buildHarnessSnippets,
  buildMemoryOptions,
  compareBoostRank,
  parallelForCodingMode,
  parseSpecTypeBoostMark,
  resolveFullAutoPlan,
  type BoostMarkParts,
  type BrainsId,
  type CodingModeId,
  type SpeedBoostId,
  type ThinkId,
} from "../lib/multiAgentBooster";
import CustomSliderParam from "./CustomSliderParam";
import CockpitSlider from "./CockpitSlider";

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
  port: number;
  modelId: string;
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
   * Extra raw spec_type values for Power boost (e.g. draft-eagle3, ngram).
   * MTP/DFlash still driven by capabilities; these fill the rest of the factory set.
   */
  rawSpecTypes?: string[];
  /** When set with powerMode, selecting a raw type (not mtp/dflash/off) calls this. */
  onRawSpecType?: (specType: string | null) => void;
  /** Active factory spec_type when power boost is a raw (non mtp/dflash) mode. */
  activeRawSpecType?: string | null;
  /**
   * Extra SPEC group params (not type / not draft path) — shown under Boost on demand.
   */
  specDetailParams?: CockpitSpecDetailParam[];
  className?: string;
  /** CTX rail (hero Full Auto only). */
  ctxValue?: number | string;
  ctxDefault?: number | string;
  ctxValues?: (string | number)[];
  ctxStep?: number;
  onCtxChange?: (v: number) => void;
  ctxPerSlot?: number;
  ctxSlotCount?: number;
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
  port,
  modelId,
  layout = "normal",
  powerMode = false,
  rawSpecTypes = [],
  onRawSpecType,
  activeRawSpecType = null,
  specDetailParams = [],
  className = "",
  ctxValue,
  ctxDefault,
  ctxValues,
  ctxStep = 1024,
  onCtxChange,
  ctxPerSlot,
  ctxSlotCount = 1,
}: MultiAgentBoosterProps) {
  const [harnessOpen, setHarnessOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const hero = layout === "hero";
  const compact = layout === "compact";
  /** CTX on top for all modes (unifies Full Auto + Assisted). */
  const showCtxRail = onCtxChange != null && (ctxValues?.length ?? 0) > 0;
  /** SPEC-EXTRA — Assisted Full only (hidden Full Auto + Essentials). */
  const showSpecExtra = powerMode;
  /**
   * Full Auto (hero): parent passes factory-only values.
   * Assisted: factory + user-added; unknown marks styled as custom.
   */
  const markCustomValues = !hero;

  const memoryOptions = useMemo(
    () => buildMemoryOptions(kvQuantValues, { markUnknownAsCustom: markCustomValues }),
    [kvQuantValues, markCustomValues],
  );
  const agentOptions = useMemo(
    () => buildAgentOptions(parallelValues, { markNonPresetAsCustom: markCustomValues }),
    [parallelValues, markCustomValues],
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

  // Keep parent Boost state on the resolved plan (fixes thumb stuck on MTP after model change).
  // Skip while a raw factory type is active — Joe Off→Smart rewrite would wipe ngram/draft-simple.
  useEffect(() => {
    if (activeRawSpecType) return;
    if (plan.speed !== speedBoost) {
      onSpeedBoost(plan.speed);
    }
  }, [plan.speed, speedBoost, onSpeedBoost, activeRawSpecType]);

  const capSet = useMemo(() => new Set(capabilities), [capabilities]);

  /** Effective boost for Joe UI (never a disabled mark). Power may show Off. */
  const displayBoost = powerMode
    ? plan.speed === "smart"
      ? "off"
      : plan.speed
    : plan.speed === "off"
      ? "smart"
      : plan.speed;

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
    dflashLibraryReady &&
    displayBoost === "dflash";

  const mtpAvailable = capSet.has("mtp");
  const dflashAvailable = dflashLibraryReady || dflashGettable || capSet.has("dflash");
  /** MTP forces Solo — multi-agent marks stay visible but locked. */
  const mtpLocksAgents = displayBoost === "mtp";

  /**
   * Boost marks: 2-word naming (family above track, mode under).
   * Order simple → complex; MTP then DFlash always last.
   */
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

    const skip = new Set(["draft-mtp", "draft-dflash", "mtp", "dflash", "off", "none", ""]);
    for (const t of rawSpecTypes) {
      const s = String(t).trim();
      if (!s || skip.has(s.toLowerCase())) continue;
      marks.push(parseSpecTypeBoostMark(s));
    }

    if (mtpAvailable || !powerMode) {
      const m = parseSpecTypeBoostMark("draft-mtp");
      m.blurb = mtpAvailable
        ? m.blurb
        : "MTP not available for this model";
      marks.push(m);
    }
    if (dflashAvailable || !powerMode) {
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

    // Dedupe by id, keep first (then re-sort)
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

  /**
   * Unified Boost thumb value — raw factory types (ngram / draft-simple / …) win over Smart/Off.
   * Fixes unselectable marks that only existed in powerMode path before.
   */
  const boostSliderValue = useMemo(() => {
    if (activeRawSpecType) {
      return parseSpecTypeBoostMark(activeRawSpecType).id;
    }
    if (displayBoost === "mtp" || displayBoost === "dflash") return displayBoost;
    if (powerMode) return displayBoost === "smart" ? "off" : displayBoost;
    // Joe: Off maps to Smart presentation only when no raw type is active
    return displayBoost === "off" ? "smart" : displayBoost;
  }, [powerMode, displayBoost, activeRawSpecType]);

  /** SPEC-EXTRA / draft strip accent: green MTP, violet DFlash, neutral otherwise. */
  const stripTone: "mtp" | "dflash" | "neutral" =
    boostSliderValue === "mtp"
      ? "mtp"
      : boostSliderValue === "dflash"
        ? "dflash"
        : "neutral";

  const snippets = useMemo(
    () =>
      buildHarnessSnippets({
        port,
        modelId,
        concurrentHint: plan.parallel,
      }),
    [port, modelId, plan.parallel],
  );

  const copy = useCallback(async (id: string, body: string) => {
    try {
      await navigator.clipboard.writeText(body);
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((c) => (c === id ? null : c)), 1600);
    } catch {
      /* ignore */
    }
  }, []);

  const showDraftStrip = showDflashGet || showDflashChange;
  /** Assisted: violet strip for draft and/or SPEC-EXTRA. Full Auto: draft only (no SPEC-EXTRA). */
  const showVioletStrip =
    showDraftStrip || (showSpecExtra && specDetailParams.length > 0);

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
        ) : (
          <>
            <div className="full-auto-cockpit__dflash-get-line">Paired draft</div>
            <div
              className="full-auto-cockpit__dflash-get-name"
              title={dflashDraftLabel ?? undefined}
            >
              {dflashDraftLabel || "—"}
            </div>
          </>
        )}
      </div>
      <div className="full-auto-cockpit__dflash-get-actions">
        {showDflashChange ? (
          <button
            type="button"
            className="full-auto-cockpit__dflash-get-btn full-auto-cockpit__dflash-get-btn--ghost"
            onClick={() => onChangeDflashDraft?.()}
            title="Pick a different DFlash draft from your library"
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
    </>
  ) : null;

  /** SPEC-EXTRA: one inline row of n_max / n_min / extras (Assisted only). */
  const specExtraInline =
    showSpecExtra && specDetailParams.length > 0 ? (
      <div className="full-auto-cockpit__spec-extra font-mono min-w-0 flex-1">
        <span className="full-auto-cockpit__spec-extra-title shrink-0">SPEC-EXTRA</span>
        <div className="full-auto-cockpit__spec-extra-row min-w-0">
          {specDetailParams.map((p, i) => (
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
              <div className="inline-flex flex-wrap gap-0.5">
                {p.values.map((val) => {
                  const selected = String(p.current) === String(val);
                  return (
                    <button
                      key={`${p.key}-${String(val)}`}
                      type="button"
                      onClick={() => p.onChange(val)}
                      className={`full-auto-cockpit__spec-chip font-mono${
                        selected ? " full-auto-cockpit__spec-chip--active" : ""
                      }`}
                    >
                      {String(val)}
                    </button>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    ) : null;

  const violetStrip = showVioletStrip ? (
    <div
      className={`full-auto-cockpit__dflash-get full-auto-cockpit__dflash-get--footer full-auto-cockpit__dflash-get--spec-extra full-auto-cockpit__dflash-get--tone-${stripTone} font-mono min-w-0 flex-1`}
      data-strip-tone={stripTone}
    >
      {draftStripInner}
      {draftStripInner && specExtraInline ? (
        <span className="full-auto-cockpit__spec-extra-sep full-auto-cockpit__spec-extra-sep--block" aria-hidden>
          |
        </span>
      ) : null}
      {specExtraInline}
    </div>
  ) : null;

  const densityClass = hero
    ? "full-auto-cockpit--hero"
    : compact
      ? "full-auto-cockpit--compact"
      : "full-auto-cockpit--normal";

  return (
    <div
      className={`full-auto-cockpit ${densityClass} ${className}`}
      data-booster-layout={layout}
      data-power-mode={powerMode ? "on" : "off"}
    >
      {/* Compact title only — status line removed; selected values live on slider marks */}
      <div className="full-auto-cockpit__header full-auto-cockpit__header--minimal">
        <span className="full-auto-cockpit__title font-mono tracking-[0.16em] uppercase shrink-0">
          {powerMode ? "Power cockpit" : "Launch cockpit"}
        </span>
        {plan.softNote ? (
          <span className="full-auto-cockpit__status-note font-mono min-w-0 truncate" title={plan.softNote}>
            {plan.softNote}
          </span>
        ) : null}
      </div>

      <div className={`full-auto-cockpit__body ${compact ? "space-y-2" : "space-y-3"}`}>
        {/* CTX on top for Full Auto + Assisted (unifies layout) */}
        {showCtxRail && (
          <div className="full-auto-cockpit__ctx-hero">
            <div className="full-auto-cockpit__ctx-slider min-w-0">
              <CustomSliderParam
                paramKey="ctx"
                currentValue={ctxValue}
                defaultValue={ctxDefault}
                onChange={onCtxChange!}
                step={ctxStep}
                values={ctxValues}
              />
            </div>
            <div className="full-auto-cockpit__ctx-values">
              <span className="full-auto-cockpit__ctx-value font-mono">
                {typeof ctxValue === "number"
                  ? `${Math.round(ctxValue / 1024)}K`
                  : String(ctxValue)}
              </span>
              {ctxPerSlot != null && ctxPerSlot > 0 && ctxSlotCount != null && ctxSlotCount > 1 && (
                <>
                  <span className="full-auto-cockpit__ctx-sep font-mono">|</span>
                  <span className="full-auto-cockpit__ctx-per-slot font-mono">
                    {Math.round(ctxPerSlot / 1024)}K / slot
                  </span>
                </>
              )}
            </div>
          </div>
        )}

        <div className="full-auto-cockpit__grid">
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

          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Boost"
              value={boostSliderValue}
              onChange={(id) => {
                if (id === "off") {
                  onRawSpecType?.(null);
                  onSpeedBoost("off");
                  return;
                }
                if (id === "smart") {
                  onRawSpecType?.(null);
                  onSpeedBoost("smart");
                  return;
                }
                if (id === "mtp" || id === "dflash") {
                  onRawSpecType?.(null);
                  onSpeedBoost(id);
                  return;
                }
                if (id.startsWith("raw:")) {
                  // Single apply path — parent sets spec_type + group (do not fire Smart first)
                  onRawSpecType?.(id.slice(4));
                  return;
                }
                onRawSpecType?.(null);
                onSpeedBoost(id as SpeedBoostId);
              }}
              options={boostMarks.map((m) => {
                const mtpMissing = m.id === "mtp" && !mtpAvailable;
                const dflashMissing = m.id === "dflash" && !dflashAvailable;
                const needCap = mtpMissing || dflashMissing;
                const available =
                  m.id === "smart" ||
                  m.id === "off" ||
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
        </div>

      </div>

      {harnessOpen && (
        <div className="full-auto-cockpit__harness space-y-2">
          <p className="full-auto-cockpit__harness-hint font-mono leading-snug">
            Point an OpenAI-compatible harness here. Multi-agent only helps if the harness runs
            concurrent agents (≈ {parallelForCodingMode(plan.codingMode)} slots ready).
          </p>
          {snippets.map((s) => (
            <div key={s.id} className="full-auto-cockpit__snippet overflow-hidden">
              <div className="full-auto-cockpit__snippet-bar flex items-center justify-between gap-2">
                <span className="font-mono tracking-wider uppercase">{s.title}</span>
                <button
                  type="button"
                  onClick={() => void copy(s.id, s.body)}
                  className="full-auto-cockpit__copy font-mono"
                >
                  {copiedId === s.id ? "Copied" : "Copy"}
                </button>
              </div>
              <pre className="full-auto-cockpit__snippet-body font-mono whitespace-pre-wrap break-all leading-relaxed max-h-32 overflow-y-auto eink-scrollbar">
                {s.body}
              </pre>
            </div>
          ))}
        </div>
      )}

      {/* Footer: violet draft + SPEC-EXTRA (Assisted) + Connect */}
      <div className="full-auto-cockpit__footer full-auto-cockpit__footer--actions">
        {violetStrip}
        <button
          type="button"
          onClick={() => setHarnessOpen((v) => !v)}
          className="full-auto-cockpit__connect font-mono tracking-wider uppercase shrink-0"
          title="Copy endpoint + harness setup"
        >
          {harnessOpen ? "Hide connect" : "Connect harness"}
        </button>
      </div>
    </div>
  );
}
