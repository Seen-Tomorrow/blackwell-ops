import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { SpecCapability } from "../lib/specDraft";
import type { CompanionCandidate, CompanionReport, CompanionRole, RepoCompanion } from "../lib/types";
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
import LoadoutRail, { companionSlots, type LoadoutFileSlot } from "./LoadoutRail";
import LoadoutPicker from "./LoadoutPicker";
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
  /** Open local-library draft re-picker (when pairing is wrong). */
  /** DFlash2 draft sampling mode shown under the Boost slider. */
  dflashSampling?: "greedy" | "probabilistic";
  onDflashSampling?: (sampling: "greedy" | "probabilistic") => void;
  /** Short name of the selected MTP head. Absent ⇒ no head chosen. */
  mtpDraftLabel?: string | null;
  /** Target carries baked-in nextn — MTP runs without any head file. */
  mtpBakedIn?: boolean;
  /** Open local-library MTP head picker. */
  /** Local draft heads for the active SPEC lane (built without opening the legacy modal). */
  specFileRows?: { id: string; title: string; meta?: string; score?: number }[];
  /** Applies a picked draft head path. */
  onPickSpecFile?: (path: string) => void;
  /** The model's own Hub repo id — the DRAFT lane lists it like the Hub screen. */
  modelHubId?: string;
  /** A draft head listed from a repo: download and pin it. */
  onPickRepoDraft?: (item: RepoCompanion) => void;
  /** Unpair the draft lane head from this model. */
  onClearDraft?: () => void;
  /** Absolute draft head paths, so the picker can mark the landed one. */
  dflashDraftPath?: string | null;
  mtpDraftPath?: string | null;
  /** Clears a stale Hub error when a picker opens. */
  onClearSpecError?: () => void;
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
  /** Model's trained context window — printed on the CTX scale, not a mark. */
  trainedCtx?: number | null;
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
  /** Batch/uBatch slider rendered in the grid cell BOOST used to occupy. */
  batchSlot?: React.ReactNode;
  /** Active main model path — LOADOUT resolves its companions. */
  modelPath?: string | null;
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
  dflashSampling = "greedy",
  onDflashSampling,
  mtpDraftLabel = null,
  mtpBakedIn = false,
  specFileRows = [],
  onPickSpecFile,
  modelHubId,
  onPickRepoDraft,
  onClearDraft,
  dflashDraftPath = null,
  mtpDraftPath = null,
  onClearSpecError,
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
  trainedCtx = null,
  onPruneCustom,
  flagToggles = [],
  showAgents = true,
  showMemory = true,
  showThink = true,
  showBoost = true,
  modelPath = null,
  batchSlot = null,
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

  // Companion report + picker live here, not in the rail: the picker covers the 2x2
  // grid, which is this component's territory.
  const [companionReport, setCompanionReport] = useState<CompanionReport | null>(null);
  const [companionBusy, setCompanionBusy] = useState(false);
  const [pickSlot, setPickSlot] = useState<{ role: CompanionRole | null; anchor: number } | null>(null);

  const reloadCompanions = useCallback(async () => {
    if (!modelPath) {
      setCompanionReport(null);
      return;
    }
    try {
      setCompanionReport(await invoke<CompanionReport>("resolve_companions", { modelPath }));
    } catch {
      setCompanionReport(null);
    }
  }, [modelPath]);

  useEffect(() => {
    void reloadCompanions();
  }, [reloadCompanions]);

  const setCompanion = useCallback(
    async (role: CompanionRole, path: string | null) => {
      if (!modelPath) return;
      setCompanionBusy(true);
      try {
        await invoke("set_companion_pin", { modelPath, role, path });
        await reloadCompanions();
      } finally {
        setCompanionBusy(false);
      }
    },
    [modelPath, reloadCompanions],
  );

  const clearCompanion = useCallback(
    async (role: CompanionRole) => {
      if (!modelPath) return;
      setCompanionBusy(true);
      try {
        await invoke("clear_companion_pin", { modelPath, role });
        await reloadCompanions();
      } finally {
        setCompanionBusy(false);
      }
    },
    [modelPath, reloadCompanions],
  );

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

  // Every lane that reads a draft file can be pointed at one: the DRAFT slot on the rail
  // opens the same picker as the companions, so no legacy modal handler is involved.
  const canPickSpecFile =
    displayBoost === "mtp" || displayBoost === "dflash" || displayBoost === "dspark";
  // The DRAFT slot: the file affordance for the current mode. It shows what that mode
  // will load and opens the same picker the companion slots use — the mode itself is
  // only ever changed by the SPEC slider.
  const draftHeadName = displayBoost === "mtp" ? mtpDraftLabel : dflashDraftLabel;
  const draftHeadPath = displayBoost === "mtp" ? mtpDraftPath : dflashDraftPath;
  const draftFileSlot: LoadoutFileSlot | null = canPickSpecFile
    ? {
        id: "draft",
        role: "DRAFT",
        // A short token, never the whole file name: the plate is 16px tall.
        value: (() => {
          if (!draftHeadName) return displayBoost === "mtp" && mtpBakedIn ? "built-in" : "—";
          const base = draftHeadName.split(/[\\/]/).pop() ?? draftHeadName;
          const quant = base.match(/(IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|BF16|F16|FP8|F8)/i);
          return quant?.[0].toUpperCase() ?? "FILE";
        })(),
        // The state slot carries the model name, so the stop reads quant + name together.
        state: (() => {
          if (!draftHeadName) {
            return displayBoost === "mtp" && mtpBakedIn ? "BAKED-IN" : "MISSING";
          }
          const base = (draftHeadName.split(/[\\/]/).pop() ?? draftHeadName).replace(
            /\.gguf$/i,
            "",
          );
          const stripped = base
            .replace(/(IQ\d[_A-Z0-9]*|Q\d[_A-Z0-9]*|BF16|F16|FP8|F8)/i, "")
            .replace(/[-_.]+/g, " ")
            .trim();
          return (stripped || base).slice(0, 20);
        })(),
        tone: "draft",
        active: true,
        count: 1,
        onOpen: (anchor) => {
          onClearSpecError?.();
          setPickSlot({ role: null, anchor });
        },
      }
    : null;

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

  // SPEC half of LOADOUT: the Boost slider, rendered inside the rail.
  // Availability is computed once and used by both the slider marks and the picker
  // table, so the two can never disagree about what is selectable.
  const boostRows = boostMarks.map((m) => {
    // DFlash keeps its library gate; MTP is a manual lane (see mtpSelectable).
    const needCap = m.id === "dflash" && !dflashAvailable;
    const available =
      m.id === "smart" ||
      m.id === "off" ||
      m.id === "dspark" ||
      m.id === "mtp" ||
      (m.id === "dflash" && dflashAvailable) ||
      m.id.startsWith("raw:");
    return { m, needCap, available };
  });

  const pickSpec = (id: string) => {
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
  };

  const boostCell = showBoost ? (
    <div className="loadout-spec-cell">
            <CockpitSlider
              label=""
              value={boostSliderValue}
              onChange={pickSpec}
              // No above-mark family label: the DRAFT slot in the file row says it once.
              cornerLabel
              options={boostRows.map(({ m, needCap, available }) => ({
                  id: m.id,
                  label: m.label,
                  blurb: m.blurb,
                  disabled: needCap,
                  badgeColor: m.badgeColor,
                  // Color track mark + under-label only (not above family word)
                  emphasize: Boolean(m.badgeColor) && available && !needCap,
                }))}
              subControl={
                speedBoost === "dflash" && onDflashSampling
                  ? {
                      optionId: "dflash",
                      content: (
                        <div
                          className="full-auto-cockpit__dflash-sampling"
                          title="DFlash2 only — probabilistic samples the draft and lets the target rejection-sample; DFlash1 ignores it."
                        >
                          {(["greedy", "probabilistic"] as const).map((mode) => (
                            <button
                              key={mode}
                              type="button"
                              className={`full-auto-cockpit__dflash-sampling-btn ${
                                dflashSampling === mode ? "value-chip-active" : "value-chip"
                              }`}
                              onClick={() => onDflashSampling(mode)}
                            >
                              {mode === "greedy" ? "GREEDY" : "PROBAB"}
                            </button>
                          ))}
                        </div>
                      ),
                    }
                  : undefined
              }
            />
          </div>
  ) : null;

  const stripTone: "mtp" | "dflash" | "neutral" =
    displayBoost === "mtp"
      ? "mtp"
      : externalDraftBoost
        ? "dflash"
        : "neutral";

  // The strip is SPEC-EXTRA only now: the draft-head status and Change draft moved out
  // (the draft lane is being reworked in the LOADOUT picker work), which is what keeps
  // this row to a single line instead of two lines plus a button.
  const showVioletStrip = showSpecExtra && specDetailParams.length > 0;



  const specExtraValueCount = specDetailParams.reduce(
    (count, param) => count + param.values.length,
    0,
  );
  const showSpecExtraTitle = specDetailParams.length <= 2 && specExtraValueCount <= 8;

  const specExtraInline =
    showSpecExtra && specDetailParams.length > 0 ? (
      <div className="full-auto-cockpit__spec-extra font-mono min-w-0 flex-1">
        {showSpecExtraTitle ? (
          <span className="full-auto-cockpit__spec-extra-title shrink-0">SPEC-EXTRA</span>
        ) : null}
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
      {specExtraInline}
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
        trainedCtx={trainedCtx}
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

        <div className="full-auto-cockpit__grid-stack">
        <div className="full-auto-cockpit__grid">
          {showMemory && memoryOptions.length > 0 && (
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Memory"
              cornerLabel
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
                // The real value lives above the name, tiny and faint: a right-hand badge
                // re-flowed the whole track every time the value changed length.
                aboveLabel: o.kvQuant,
                aboveRaw: true,
              }))}
            />
          </div>
          )}
          {showAgents && agentOptions.length > 0 && (
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Agents"
              cornerLabel
              value={codingMode}
              onChange={onCodingMode}
              options={agentOptions.map((o) => ({
                id: o.id,
                label: o.label,
                blurb: o.blurb,
                custom: o.custom,
                // Parallel count above the name, same as MEMORY's kv value: a right-hand
                // badge re-flowed the track when the number gained a digit.
                aboveLabel: `x${o.parallel}`,
                aboveRaw: true,
              }))}
            />
          </div>
          )}

          {batchSlot ? (
          <div className="full-auto-cockpit__grid-cell full-auto-cockpit__grid-cell--batch">
            {batchSlot}
          </div>
          ) : null}
          {showThink && (
          <div className="full-auto-cockpit__grid-cell">
            <CockpitSlider
              label="Think budget"
              cornerLabel
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

        {/* LOADOUT — SWAPS sockets. Spec selection still lives in the grid above; this
            row owns the independently attachable companions. */}
        <LoadoutRail
          specSlot={boostCell}
          slots={[
            ...(draftFileSlot ? [draftFileSlot] : []),
            ...companionSlots(
              companionReport,
              (role, anchor) => {
                onClearSpecError?.();
                setPickSlot({ role, anchor });
              },
              (role, candidate) => void setCompanion(role, candidate.path),
            ),
          ]}
          busy={companionBusy}
        />
        {/* File picker overlay. It covers the whole body — grid, rail and strips — so
            the lists get the cockpit's full height instead of the grid's 150px. */}
        {pickSlot && (companionReport || pickSlot.role === null) ? (
          <LoadoutPicker
            title={
              pickSlot.role === null
                ? "DRAFT"
                : pickSlot.role === "mmproj"
                  ? "MMPROJ"
                  : "ENGRAM"
            }
            role={pickSlot.role}
            slot={
              pickSlot.role === null || !companionReport
                ? null
                : pickSlot.role === "mmproj"
                  ? companionReport.mmproj
                  : companionReport.engram
            }
            localRows={
              pickSlot.role === null
                ? specFileRows.map((row) => {
                    // meta is a free-form "author · quant · size" line — pick the parts
                    // by shape so a missing author cannot shift the columns.
                    const parts = (row.meta ?? "")
                      .split("·")
                      .map((s) => s.trim())
                      .filter(Boolean);
                    return {
                      key: row.id,
                      quant:
                        parts.find((p) => /^(Q\d|IQ\d|BF16|F16|F8|FP8|MXFP|Q8)/i.test(p)) ??
                        "—",
                      size: parts.find((p) => /(GB|MB|KB)$/i.test(p)) ?? "—",
                      name: row.title,
                      // Which kind of head this is, from its own name. The lane accepts a
                      // family (DFlash + DSpark), so a DSPARK row inside the DFLASH lane is
                      // correct but confusing without the label.
                      tag: /dspark/i.test(row.title)
                        ? "DSPARK"
                        : /dflash/i.test(row.title)
                          ? "DFLASH"
                          : /mtp/i.test(row.title)
                            ? "MTP"
                            : undefined,
                      // The landed head is the one that will launch: mark it.
                      active: Boolean(draftHeadPath) && row.id === draftHeadPath,
                      onPick: () => {
                        onPickSpecFile?.(row.id);
                        setPickSlot(null);
                      },
                    };
                  })
                : undefined
            }
            modelHubId={modelHubId}
            pairedDraftPath={draftHeadPath}
            onClearDraft={onClearDraft}
            laneKind={
              displayBoost === "mtp" || displayBoost === "dflash" || displayBoost === "dspark"
                ? displayBoost
                : null
            }
            onPickDraftFile={(item) => {
              onPickRepoDraft?.(item);
              setPickSlot(null);
            }}
            modelPath={modelPath ?? ""}
            onAttach={(role, path) => void setCompanion(role, path)}
            onDetach={(role) => void setCompanion(role, null)}
            onClear={(role) => void clearCompanion(role)}
            onDownloaded={() => void reloadCompanions()}
            onClose={() => setPickSlot(null)}
          />
        ) : null}        </div>

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
