import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { SpecCapability } from "../lib/specDraft";
import type { StackEntry } from "../lib/types";
import {
  ATOMCODE_DISCLAIMER,
  type AtomcodeLaunchRequest,
  type AtomcodeLaunchResult,
  type AtomcodeStatus,
  type AtomcodeWebuiResult,
} from "../lib/atomcode";
import {
  QWEN_CODE_DISCLAIMER,
  type QwenCodeStatus,
  type QwenLaunchRequest,
  type QwenLaunchResult,
} from "../lib/qwenCode";
import {
  PI_CODE_DISCLAIMER,
  type PiCodeStatus,
  type PiLaunchRequest,
  type PiLaunchResult,
} from "../lib/piCode";
import {
  dispatchAppEvent,
  EVENTS,
  type AtomcodeEngineClickDetail,
} from "../lib/events";
import { KEYS, readStorage, writeStorage } from "../lib/storage";
import { isDevBuild } from "../lib/build";
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

/**
 * High-level install phases. The Rust install is opaque to JS (we don't see
 * bytes/percent without an explicit event), but we can split it into these
 * 4 buckets the user actually feels: download → verify → extract → finalize.
 * The phase strip + indeterminate bar under the wizard proves the app is
 * alive during the 30-90s Qwen install (180 MB).
 */
export type InstallPhase = "download" | "verify" | "extract" | "finalize";

const INSTALL_PHASES: ReadonlyArray<{
  id: InstallPhase;
  label: string;
  /** Approximate weight — used only for visual pacing of the indeterminate bar. */
  weight: number;
}> = [
  { id: "download", label: "Downloading", weight: 70 },
  { id: "verify", label: "Verifying", weight: 10 },
  { id: "extract", label: "Extracting", weight: 15 },
  { id: "finalize", label: "Finalizing", weight: 5 },
] as const;

const INSTALL_PHASE_LABEL: Record<InstallPhase, string> = {
  download: "Downloading tool…",
  verify: "Verifying checksum…",
  extract: "Extracting archive…",
  finalize: "Finalizing install…",
};

/**
 * Harness product surface: **pi is primary** (isolated install, BRAIN/WORKER
 * routing, pi-subagents fan-out; also the only candidate with native
 * llama-server / router-style management later).
 *
 * AtomCode + Qwen Code stay fully wired in code (install/launch/Tauri cmds)
 * but their tool chips are hidden until we re-expose them. Flip this to
 * `true` to show the three-way picker again — no delete required.
 */
const SHOW_LEGACY_HARNESS_TOOLS = false;

type HarnessToolId = "atomcode" | "qwen" | "pi";

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
  /**
   * Live engine stack — used for AtomCode one-click (solo against RUNNING, or Brain+Workers).
   * When omitted, AtomCode uses port/modelId config values only.
   */
  stack?: StackEntry[];
  /** Preferred running slot (e.g. selected engine). */
  preferredSlotIdx?: number | null;
  /** Parent hides chip groups / undims panel while wizard is open. */
  onHarnessOpenChange?: (open: boolean) => void;
  /**
   * Same-port relaunch: stop seat, launch panel model/config with preferred port + parallel.
   * Simplest mid-session model/parallel swap without a second stack.
   */
  onRelaunchSeat?: (args: {
    slotIdx: number;
    port: number;
    alias: string;
    parallel: number;
  }) => Promise<void>;
  /** Select a running engine card (e.g. BRAIN after AtomCode opens). */
  onSelectEngine?: (slotIdx: number) => void;
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
  /** Launch combo presets — compact Load/Save in harness footer. */
  launchPresets?: {
    combos: import("../lib/launchPresets").ComboPreset[];
    onApply: (
      combo: import("../lib/launchPresets").ComboPreset,
      opts: { loadIntoPanel: boolean },
    ) => void;
    onSaveTwin: () => void;
    onManage: () => void;
    canSaveTwin?: boolean;
  };
  /**
   * After parent applies a twin combo — set BRAIN/WORKER ports and twin mode.
   * Parent clears by setting null after consume.
   * rolesLocked: ignore engine-card role cycling until both seats RUNNING.
   */
  presetTwinBind?: {
    brainPort: number;
    workerPort: number;
    agentsN?: number;
    rolesLocked?: boolean;
  } | null;
  onPresetTwinBindConsumed?: () => void;
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
  embedCtx = true,
  ctxValue,
  ctxDefault,
  ctxValues,
  ctxStep = 1024,
  onCtxChange,
  ctxPerSlot,
  ctxSlotCount = 1,
  learnedMarks,
  stack = [],
  preferredSlotIdx = null,
  onHarnessOpenChange,
  onRelaunchSeat,
  onSelectEngine,
  flagToggles = [],
  showAgents = true,
  showMemory = true,
  showThink = true,
  showBoost = true,
  agentsFromTemplateOnly = false,
  launchPresets,
  presetTwinBind = null,
  onPresetTwinBindConsumed,
}: MultiAgentBoosterProps) {
  const [harnessOpen, setHarnessOpen] = useState(false);
  /** Which external agent tool the harness targets. */
  const [harnessTool, setHarnessTool] = useState<HarnessToolId>("pi");
  // Legacy tools hidden → keep selection pinned to pi (no dead code paths in UI).
  useEffect(() => {
    if (!SHOW_LEGACY_HARNESS_TOOLS && harnessTool !== "pi") {
      setHarnessTool("pi");
    }
  }, [harnessTool]);
  /** Wizard: SOLO vs TWIN (even if more than 2 engines run). */
  const [wizardMode, setWizardMode] = useState<"solo" | "twin">("solo");
  /** Twin: explicit ports from click cycle (none → BRAIN → WORKER → clear). */
  const [twinRoles, setTwinRoles] = useState<{
    brain: number | null;
    worker: number | null;
  }>({ brain: null, worker: null });
  const twinBrainPort = twinRoles.brain;
  const twinWorkerPort = twinRoles.worker;

  /**
   * Harness concurrency is independent of cockpit MTP “force Solo”.
   * Seed once when opening; chips update this only (launch uses this value).
   */
  const [harnessAgents, setHarnessAgents] = useState(1);
  /** Launch pi elevated (gsudo UAC) — system ops inside the agent. */
  const [piElevated, setPiElevated] = useState(
    () => readStorage(KEYS.piCodeElevated) === "1",
  );
  /** Preset-applied twin: freeze role clicks until both engines RUNNING. */
  const [presetRolesLocked, setPresetRolesLocked] = useState(false);

  // Parent applied a twin combo — bind roles + optional agents N
  useEffect(() => {
    if (!presetTwinBind) return;
    setWizardMode("twin");
    setTwinRoles({
      brain: presetTwinBind.brainPort,
      worker: presetTwinBind.workerPort,
    });
    if (presetTwinBind.agentsN != null && presetTwinBind.agentsN > 0) {
      setHarnessAgents(Math.max(1, presetTwinBind.agentsN));
    }
    setPresetRolesLocked(Boolean(presetTwinBind.rolesLocked));
    setHarnessOpen(true);
    onPresetTwinBindConsumed?.();
  }, [presetTwinBind, onPresetTwinBindConsumed]);

  const [atomStatus, setAtomStatus] = useState<AtomcodeStatus | null>(null);
  const [qwenStatus, setQwenStatus] = useState<QwenCodeStatus | null>(null);
  const [piStatus, setPiStatus] = useState<PiCodeStatus | null>(null);
  /** True while the DEV-only "update pi to latest" command is in flight. */
  const [piUpdating, setPiUpdating] = useState(false);
  const [atomBusy, setAtomBusy] = useState<"idle" | "install" | "launch" | "webui">("idle");
  const [atomError, setAtomError] = useState<string | null>(null);
  const [atomMsg, setAtomMsg] = useState<string | null>(null);
  /**
   * Install progress: which step the Rust side is in. Drives the phase strip +
   * indeterminate bar so the user knows the app isn't stuck. `null` = no install
   * in flight (or install finished — fall back to the success toast).
   */
  const [installPhase, setInstallPhase] = useState<InstallPhase | null>(null);
  /** Bumped at ~6Hz to drive the indeterminate bar animation. */
  const [installTick, setInstallTick] = useState(0);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  /** Confirm modal before external launch. */
  const [confirmMode, setConfirmMode] = useState<"solo" | "brain_workers" | null>(null);
  const [relaunchBusy, setRelaunchBusy] = useState(false);

  /**
   * Hot-swap pending pin — single source of truth for twin-role survival across stop→launch.
   * While set: drop-stale keeps the relaunched seat even if its port is briefly missing.
   * Rematch only after the port has vacated once (avoids clearing pending before stop runs).
   * Port-first rematch, then non-empty alias. Timeout / wizard close / failure clear pending.
   */
  type PendingRelaunch = {
    port: number;
    /** Trimmed; empty → port-only rematch (never match blank aliases). */
    alias: string;
    /** Twin seat to re-pin; null in solo (no twin role update). */
    seat: "worker" | "brain" | null;
    /** True once `port` was absent from runningEngines after arming. */
    vacated: boolean;
  };
  const PENDING_RELAUNCH_MS = 12_000;
  const pendingRelaunchRef = useRef<PendingRelaunch | null>(null);
  const pendingRelaunchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Bumps when pending is armed/cleared so the prune effect re-runs without a stack change. */
  const [roleSyncTick, setRoleSyncTick] = useState(0);

  const clearPendingRelaunch = useCallback(() => {
    pendingRelaunchRef.current = null;
    if (pendingRelaunchTimerRef.current != null) {
      clearTimeout(pendingRelaunchTimerRef.current);
      pendingRelaunchTimerRef.current = null;
    }
  }, []);

  const armPendingRelaunch = useCallback((next: Omit<PendingRelaunch, "vacated">) => {
    if (pendingRelaunchTimerRef.current != null) {
      clearTimeout(pendingRelaunchTimerRef.current);
    }
    pendingRelaunchRef.current = { ...next, vacated: false };
    pendingRelaunchTimerRef.current = setTimeout(() => {
      pendingRelaunchTimerRef.current = null;
      if (pendingRelaunchRef.current) {
        pendingRelaunchRef.current = null;
        setRoleSyncTick((n) => n + 1);
      }
    }, PENDING_RELAUNCH_MS);
    setRoleSyncTick((n) => n + 1);
  }, []);

  useEffect(
    () => () => {
      if (pendingRelaunchTimerRef.current != null) {
        clearTimeout(pendingRelaunchTimerRef.current);
      }
    },
    [],
  );

  const hero = layout === "hero";
  /** Single assisted density — Essentials/Full no longer reflow padding. */
  const densityUnified = !hero;
  /** CTX docked inside cockpit (standalone strip when embedCtx false). */
  const showCtxRail =
    embedCtx && onCtxChange != null && (ctxValues?.length ?? 0) > 0;
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

  /** External-draft product boosts (share draft strip + dflash_draft_model path). */
  const externalDraftBoost =
    displayBoost === "dflash" || displayBoost === "dspark";

  /**
   * SPEC-EXTRA strip — Assisted Essentials + Full (not Full Auto hero).
   * When Boost is MTP/DFlash/DSpark (or draft-* raw). Ngram/simple: no strip.
   */
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
    // ngram / simple: no SPEC-EXTRA; other draft-* may show knobs
    const s = activeRawSpecType.toLowerCase();
    if (s.startsWith("ngram") || s.includes("simple")) return false;
    return s.startsWith("draft") || s.includes("draft");
  }, [hero, specDetailParams.length, displayBoost, activeRawSpecType]);

  // HF Get-draft is DFlash-only (remote packs). DSpark is local GGUF path.
  const showDflashGet =
    Boolean(onGetDflashDraft) &&
    displayBoost === "dflash" &&
    (plan.needsDflashDraft ||
      !dflashLibraryReady ||
      dflashGetState === "searching" ||
      dflashGetState === "downloading" ||
      dflashGetState === "error");

  // Change draft: DFlash when paired; DSpark always (user must pick dspark head GGUF).
  const showDflashChange =
    Boolean(onChangeDflashDraft) &&
    (displayBoost === "dspark"
      || (displayBoost === "dflash" && dflashLibraryReady));

  const mtpAvailable = capSet.has("mtp");
  const dflashAvailable = dflashLibraryReady || dflashGettable || capSet.has("dflash");
  /** MTP forces Solo — multi-agent marks stay visible but locked. */
  const mtpLocksAgents = displayBoost === "mtp";

  /**
   * Boost marks from full factory+user list (2-word split).
   * Off/Smart bookend; MTP/DFlash last with product colors.
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

    // rawSpecTypes already = factory + user-added, eagle omitted by collectBoostSpecTypes
    const types = collectBoostSpecTypes(rawSpecTypes);
    for (const t of types) {
      const low = t.toLowerCase();
      // MTP / DFlash handled below with availability + accents
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

    // Always surface MTP / DFlash / DSpark product marks (capability-gated where needed)
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

  /**
   * Unified Boost thumb value — raw factory types (ngram / draft-simple / …) win over Smart/Off.
   * Fixes unselectable marks that only existed in powerMode path before.
   */
  const boostSliderValue = useMemo(() => {
    if (activeRawSpecType) {
      return parseSpecTypeBoostMark(activeRawSpecType).id;
    }
    if (displayBoost === "mtp" || displayBoost === "dflash" || displayBoost === "dspark") {
      return displayBoost;
    }
    if (powerMode) return displayBoost === "smart" ? "off" : displayBoost;
    // Joe: Off maps to Smart presentation only when no raw type is active
    return displayBoost === "off" ? "smart" : displayBoost;
  }, [powerMode, displayBoost, activeRawSpecType]);

  /** SPEC-EXTRA strip tone from Boost product mode (not raw-type slider id). */
  const stripTone: "mtp" | "dflash" | "neutral" =
    displayBoost === "mtp"
      ? "mtp"
      : externalDraftBoost
        ? "dflash"
        : "neutral";

  /**
   * Reduce a Tauri-side error into a one-liner the user can act on. Rust panics
   * can dump multi-line messages; we only want the first sentence and a hint.
   */
  const normalizeError = useCallback((e: unknown): string => {
    const raw = e instanceof Error ? e.message : String(e);
    const firstLine = raw.split(/\r?\n/).find((l) => l.trim().length > 0) ?? raw;
    return firstLine.length > 200 ? `${firstLine.slice(0, 197)}…` : firstLine;
  }, []);

  const refreshAtomStatus = useCallback(async () => {
    try {
      const s = await invoke<AtomcodeStatus>("atomcode_status");
      setAtomStatus(s);
      return s;
    } catch (e) {
      setAtomError(normalizeError(e));
      return null;
    }
  }, [normalizeError]);

  const refreshQwenStatus = useCallback(async () => {
    try {
      const s = await invoke<QwenCodeStatus>("qwen_code_status");
      setQwenStatus(s);
      return s;
    } catch (e) {
      setAtomError(normalizeError(e));
      return null;
    }
  }, [normalizeError]);

  const refreshPiStatus = useCallback(async () => {
    try {
      const s = await invoke<PiCodeStatus>("pi_code_status");
      setPiStatus(s);
      return s;
    } catch (e) {
      setAtomError(normalizeError(e));
      return null;
    }
  }, [normalizeError]);

  const activeToolStatus =
    harnessTool === "qwen" ? qwenStatus : harnessTool === "pi" ? piStatus : atomStatus;

  useEffect(() => {
    if (!harnessOpen) return;
    void refreshAtomStatus();
    void refreshQwenStatus();
    void refreshPiStatus();
  }, [harnessOpen, refreshAtomStatus, refreshQwenStatus, refreshPiStatus]);

  useEffect(() => {
    if (!harnessOpen) {
      setConfirmMode(null);
      setShowDisclaimer(false);
      // Closing mid-relaunch must not leave busy UI or frozen twin roles.
      setRelaunchBusy(false);
      clearPendingRelaunch();
    } else {
      // Seed from UI codingMode (not plan — MTP may force plan to Solo)
      setHarnessAgents(Math.max(1, parallelForCodingMode(codingMode)));
      // Drop prior open/install toast so reconnect does not show a stale "Opened AtomCode…"
      setAtomMsg(null);
      setAtomError(null);
      setRelaunchBusy(false);
      clearPendingRelaunch();
      // Don't reset installPhase here — a user closing the wizard mid-install shouldn't
      // cancel the Rust install, only the UI. The phase strip stays visible until the
      // install completes (which sets installPhase back to null in its own finally).
    }
    onHarnessOpenChange?.(harnessOpen);
  }, [harnessOpen, onHarnessOpenChange, clearPendingRelaunch]); // eslint-disable-line react-hooks/exhaustive-deps -- seed only on open

  // Ephemeral success toasts (install / open / relaunch) — auto-clear so they never stick
  useEffect(() => {
    if (!atomMsg) return;
    const t = window.setTimeout(() => setAtomMsg(null), 4000);
    return () => window.clearTimeout(t);
  }, [atomMsg]);

  /**
   * Indeterminate progress bar — increments ~6Hz while an install is in flight.
   * Cheap (one setState) and gives the eye motion during a 30-90s blocking invoke.
   * Cleared on unmount via the cleanup callback.
   */
  useEffect(() => {
    if (installPhase == null) return;
    const id = window.setInterval(() => setInstallTick((t) => (t + 1) % 1000), 160);
    return () => window.clearInterval(id);
  }, [installPhase]);

  useEffect(() => {
    if (!confirmMode) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && atomBusy === "idle") setConfirmMode(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirmMode, atomBusy]);

  const runningEngines = useMemo(() => {
    return stack
      .filter((s) => (s.status === "RUNNING" || s.status === "LOADING") && s.port > 0)
      .slice()
      .sort((a, b) => a.idx - b.idx);
  }, [stack]);

  // Unlock role cycling once both tagged engines are RUNNING.
  useEffect(() => {
    if (!presetRolesLocked || !harnessOpen) return;
    const brain =
      twinBrainPort != null
        ? runningEngines.find((e) => e.port === twinBrainPort)
        : null;
    const worker =
      twinWorkerPort != null
        ? runningEngines.find((e) => e.port === twinWorkerPort)
        : null;
    if (!brain || !worker) return;
    if (brain.status === "RUNNING" && worker.status === "RUNNING") {
      setPresetRolesLocked(false);
    }
  }, [
    presetRolesLocked,
    harnessOpen,
    twinBrainPort,
    twinWorkerPort,
    runningEngines,
  ]);

  /**
   * OpenAI `model` id = engine launch alias only (what llama-server reports).
   * Weights stay in our UI; no need to push model filenames into the harness.
   */
  const soloTarget = useMemo(() => {
    const fromHit = (hit: StackEntry) => {
      const alias = (hit.alias || "").trim() || "local-model";
      return {
        port: hit.port,
        model: alias,
        // Actual model weights name (e.g. "Qwen2.5-0.5B-Instruct") — surfaced
        // alongside the alias on the harness button so the user sees both.
        modelName: hit.model_name || alias,
        displayId: `${alias} :${hit.port}`,
        contextWindow: hit.n_ctx && hit.n_ctx > 0 ? hit.n_ctx : undefined,
        parallel: Math.max(1, Number(hit.parallel) || 1),
        /** mmproj loaded on this seat at launch — harness vision capability. */
        vision: Boolean(hit.vision),
        live: true as const,
      };
    };
    if (preferredSlotIdx != null && preferredSlotIdx >= 0) {
      const hit = runningEngines.find((s) => s.idx === preferredSlotIdx);
      if (hit) return fromHit(hit);
    }
    if (runningEngines.length > 0) return fromHit(runningEngines[0]);
    return {
      port: Number(port) || 0,
      model: "local-model",
      modelName: "local-model",
      displayId: "no Running engine",
      contextWindow: undefined as number | undefined,
      parallel: 1,
      vision: false,
      live: false as const,
    };
  }, [runningEngines, preferredSlotIdx, port]);

  const engineByPort = useCallback(
    (port: number | null) =>
      port != null ? runningEngines.find((e) => e.port === port) ?? null : null,
    [runningEngines],
  );

  /**
   * Twin: explicit BRAIN/WORKER ports from engine-card clicks (and half-button cycle).
   * Same-card cycle: NONE → BRAIN → untag BRAIN (worker kept) · WORKER → clear.
   * Free card: fill empty BRAIN, else empty WORKER, else claim BRAIN. Works with 3+ engines.
   */
  const dualTargets = useMemo(() => {
    if (runningEngines.length < 2) return null;
    const brain = engineByPort(twinBrainPort);
    const worker = engineByPort(twinWorkerPort);
    if (!brain || !worker || brain.port === worker.port) return null;
    const brainAlias = (brain.alias || "").trim() || "ENGINE-BRAIN";
    const workerAlias = (worker.alias || "").trim() || "ENGINE-WORKER";
    return {
      brain: {
        port: brain.port,
        model: brainAlias,
        displayId: `BRAIN ${brainAlias} :${brain.port}`,
        contextWindow: brain.n_ctx && brain.n_ctx > 0 ? brain.n_ctx : undefined,
        parallel: Math.max(1, Number(brain.parallel) || 1),
        vision: Boolean(brain.vision),
        label: brain.alias || brain.model_name,
      },
      worker: {
        port: worker.port,
        model: workerAlias,
        displayId: `WORKER ${workerAlias} :${worker.port}`,
        contextWindow: worker.n_ctx && worker.n_ctx > 0 ? worker.n_ctx : undefined,
        parallel: Math.max(1, Number(worker.parallel) || 1),
        vision: Boolean(worker.vision),
        label: worker.alias || worker.model_name,
      },
    };
  }, [runningEngines, twinBrainPort, twinWorkerPort, engineByPort]);

  /**
   * Prune twin roles for dead ports, or preserve/rematch during pending relaunch.
   * Rematch only after the relaunched port has vacated once; then port-first,
   * non-empty alias second.
   */
  useEffect(() => {
    const pending = pendingRelaunchRef.current;
    const ports = new Set(runningEngines.map((e) => e.port));

    let rematch: { seat: "worker" | "brain"; port: number } | null = null;
    let activePending = pending;

    if (pending) {
      if (!pending.vacated) {
        if (!ports.has(pending.port)) {
          pending.vacated = true;
        }
      }
      if (pending.vacated) {
        const byPort = runningEngines.find((e) => e.port === pending.port) ?? null;
        let found = byPort;
        if (!found) {
          const aliasKey = pending.alias.trim();
          if (aliasKey) {
            found =
              runningEngines.find((e) => (e.alias || "").trim() === aliasKey) ?? null;
          }
        }
        if (found) {
          if (pending.seat === "worker" || pending.seat === "brain") {
            rematch = { seat: pending.seat, port: found.port };
          }
          clearPendingRelaunch();
          activePending = null;
        }
      }
    }

    setTwinRoles((r) => {
      let brain = r.brain;
      let worker = r.worker;

      if (rematch?.seat === "worker") {
        worker = rematch.port;
        if (brain === rematch.port) brain = null;
      } else if (rematch?.seat === "brain") {
        brain = rematch.port;
        if (worker === rematch.port) worker = null;
      }

      const preservePort = activePending?.port ?? null;
      const preserveSeat = activePending?.seat ?? null;

      if (brain != null && !ports.has(brain)) {
        if (!(preserveSeat === "brain" && brain === preservePort)) brain = null;
      }
      if (worker != null && !ports.has(worker)) {
        if (!(preserveSeat === "worker" && worker === preservePort)) worker = null;
      }

      if (brain === r.brain && worker === r.worker) return r;
      return { brain, worker };
    });
  }, [runningEngines, roleSyncTick, clearPendingRelaunch]);

  // Soft seed twin when both roles empty
  useEffect(() => {
    if (!harnessOpen || wizardMode !== "twin") return;
    if (twinBrainPort != null || twinWorkerPort != null) return;
    if (pendingRelaunchRef.current) return;
    if (runningEngines.length < 2) return;
    let brain = runningEngines[0];
    if (preferredSlotIdx != null && preferredSlotIdx >= 0) {
      const pref = runningEngines.find((s) => s.idx === preferredSlotIdx);
      if (pref) brain = pref;
    }
    const worker = runningEngines.find((s) => s.port !== brain.port);
    if (!worker) return;
    setTwinRoles({ brain: brain.port, worker: worker.port });
  }, [
    harnessOpen,
    wizardMode,
    twinBrainPort,
    twinWorkerPort,
    runningEngines,
    preferredSlotIdx,
    roleSyncTick,
  ]);

  // Twin roles via running-engine clicks:
  // · Same card BRAIN:    click → untag BRAIN (keep WORKER untouched)
  // · Same card WORKER:   click → clear (NONE)
  // · Same card NONE:     click → becomes BRAIN
  // · Free card:          fill empty BRAIN, else empty WORKER, else claim BRAIN seat
  // · Preset-locked: ignore until both seats RUNNING (boot-safe)
  useEffect(() => {
    if (!harnessOpen) return;
    const onClick = (e: Event) => {
      const d = (e as CustomEvent<AtomcodeEngineClickDetail>).detail;
      if (!d?.port || wizardMode !== "twin") return;
      if (presetRolesLocked) return;
      const port = d.port;
      setTwinRoles(({ brain, worker }) => {
        const isBrain = brain === port;
        const isWorker = worker === port;
        if (isBrain) {
          // BRAIN → just untag (keep WORKER untouched). This avoids
          // accidentally clobbering a real worker seat when the user
          // meant to clear BRAIN alone.
          return { brain: null, worker };
        }
        if (isWorker) {
          // WORKER → clear
          return { brain, worker: null };
        }
        // Unassigned
        if (brain == null) {
          return { brain: port, worker: worker === port ? null : worker };
        }
        if (worker == null) {
          return { brain, worker: port };
        }
        // Both seats full → claim BRAIN
        return { brain: port, worker: worker === port ? null : worker };
      });
    };
    window.addEventListener(EVENTS.atomcodeEngineClick, onClick);
    return () => window.removeEventListener(EVENTS.atomcodeEngineClick, onClick);
  }, [harnessOpen, wizardMode, presetRolesLocked]);

  /** Highlight running engines while harness open. */
  useEffect(() => {
    const root = document.documentElement;
    if (!harnessOpen) {
      delete root.dataset.atomcodeHarness;
      dispatchAppEvent(EVENTS.atomcodeHarnessHighlight, { open: false });
      return;
    }
    root.dataset.atomcodeHarness = "1";
    if (wizardMode === "twin") {
      dispatchAppEvent(EVENTS.atomcodeHarnessHighlight, {
        open: true,
        soloPort: null,
        brainPort: twinBrainPort,
        workerPort: twinWorkerPort,
        selectedSlotIdx: preferredSlotIdx,
      });
    } else {
      dispatchAppEvent(EVENTS.atomcodeHarnessHighlight, {
        open: true,
        soloPort: soloTarget.live ? soloTarget.port : null,
        brainPort: null,
        workerPort: null,
        selectedSlotIdx: preferredSlotIdx,
      });
    }
    return () => {
      delete root.dataset.atomcodeHarness;
      dispatchAppEvent(EVENTS.atomcodeHarnessHighlight, { open: false });
    };
  }, [
    harnessOpen,
    wizardMode,
    soloTarget,
    twinBrainPort,
    twinWorkerPort,
    preferredSlotIdx,
  ]);

  const pickProjectDir = useCallback(async (): Promise<string | null> => {
    const picked = await invoke<string | null>("open_folder_dialog", {
      title: "Harness project folder",
    });
    return picked;
  }, []);



  const ensureAtomInstalled = useCallback(async (): Promise<AtomcodeStatus | null> => {
    setAtomError(null);
    setAtomMsg(null);
    let s = atomStatus ?? (await refreshAtomStatus());
    if (!s) return null;
    if (!s.disclaimerAccepted) {
      setShowDisclaimer(true);
      return null;
    }
    if (!s.installed) {
      setAtomBusy("install");
      setInstallPhase("download");
      setAtomMsg(`Downloading AtomCode ${s.pinnedVersion} (~30 MB)…`);
      try {
        // The Rust install is one blocking call; we mark verify/extract/finalize
        // visually to give the user a sense of progress without lying about % done.
        setInstallPhase("verify");
        s = await invoke<AtomcodeStatus>("atomcode_install", { version: null });
        setInstallPhase("finalize");
        setAtomStatus(s);
        setAtomMsg(`Installed ${s.version ?? s.pinnedVersion}`);
      } catch (e) {
        setAtomError(normalizeError(e));
        // Keep atomBusy cleared so the user can retry from the wizard footer's "Install" button.
        setAtomBusy("idle");
        setInstallPhase(null);
        return null;
      }
      setAtomBusy("idle");
      setInstallPhase(null);
    }
    return s;
  }, [atomStatus, refreshAtomStatus, normalizeError]);

  const ensureQwenInstalled = useCallback(async (): Promise<QwenCodeStatus | null> => {
    setAtomError(null);
    setAtomMsg(null);
    let s = qwenStatus ?? (await refreshQwenStatus());
    if (!s) return null;
    if (!s.disclaimerAccepted) {
      setShowDisclaimer(true);
      return null;
    }
    if (!s.installed) {
      setAtomBusy("install");
      setInstallPhase("download");
      setAtomMsg(`Downloading Qwen Code ${s.pinnedVersion} (~180 MB standalone)…`);
      try {
        setInstallPhase("verify");
        s = await invoke<QwenCodeStatus>("qwen_code_install", { version: null });
        setInstallPhase("finalize");
        setQwenStatus(s);
        setAtomMsg(`Installed Qwen ${s.version ?? s.pinnedVersion}`);
      } catch (e) {
        setAtomError(normalizeError(e));
        setAtomBusy("idle");
        setInstallPhase(null);
        return null;
      }
      setAtomBusy("idle");
      setInstallPhase(null);
    }
    return s;
  }, [qwenStatus, refreshQwenStatus, normalizeError]);

  const ensurePiInstalled = useCallback(async (): Promise<PiCodeStatus | null> => {
    setAtomError(null);
    setAtomMsg(null);
    let s = piStatus ?? (await refreshPiStatus());
    if (!s) return null;
    if (!s.disclaimerAccepted) {
      setShowDisclaimer(true);
      return null;
    }
    if (!s.installed) {
      setAtomBusy("install");
      setInstallPhase("download");
      setAtomMsg(`Downloading pi ${s.pinnedVersion} (~46 MB standalone)…`);
      try {
        setInstallPhase("verify");
        s = await invoke<PiCodeStatus>("pi_code_install", { version: null });
        setInstallPhase("finalize");
        setPiStatus(s);
        setAtomMsg(`Installed pi ${s.version ?? s.pinnedVersion}`);
      } catch (e) {
        setAtomError(normalizeError(e));
        setAtomBusy("idle");
        setInstallPhase(null);
        return null;
      }
      setAtomBusy("idle");
      setInstallPhase(null);
    }
    return s;
  }, [piStatus, refreshPiStatus, normalizeError]);

  /**
   * DEV-only 1-click update: fetch the latest pi release, reinstall the binary,
   * and refresh the bundled pi-subagents extension. Rust refuses to run outside
   * a debug build; the button is hidden for non-dev builds via isDevBuild().
   */
  const updatePiToLatest = useCallback(async () => {
    if (piUpdating) return;
    setAtomError(null);
    setAtomMsg(null);
    setPiUpdating(true);
    setInstallPhase("download");
    try {
      setInstallPhase("verify");
      const s = await invoke<PiCodeStatus>("pi_code_update_latest");
      setInstallPhase("finalize");
      setPiStatus(s);
      setAtomMsg(
        `pi updated to ${s.version ?? s.pinnedVersion} + pi-subagents refreshed`,
      );
    } catch (e) {
      setAtomError(normalizeError(e));
    } finally {
      setPiUpdating(false);
      setInstallPhase(null);
    }
  }, [piUpdating, normalizeError]);

  const executeHarnessLaunch = useCallback(
    async (mode: "solo" | "brain_workers") => {
      setAtomError(null);
      setAtomMsg(null);

      if (mode === "solo" && soloTarget.port <= 0) {
        setAtomError("No port — launch an engine first, or set base port.");
        return;
      }
      if (mode === "solo" && !soloTarget.live) {
        setAtomError("Start an engine (Running) before opening the harness.");
        return;
      }
      if (mode === "brain_workers" && !dualTargets) {
        setAtomError("Twin needs two Running engines on different ports.");
        return;
      }

      const tool = harnessTool;
      let projectDir: string | null | undefined =
        tool === "qwen"
          ? qwenStatus?.lastProject
          : tool === "pi"
            ? piStatus?.lastProject
            : atomStatus?.lastProject;

      if (tool === "atomcode") {
        const s = await ensureAtomInstalled();
        if (!s) return;
        projectDir = s.lastProject;
      } else if (tool === "qwen") {
        const s = await ensureQwenInstalled();
        if (!s) return;
        projectDir = s.lastProject;
      } else {
        const s = await ensurePiInstalled();
        if (!s) return;
        projectDir = s.lastProject;
      }

      if (!projectDir) {
        projectDir = await pickProjectDir();
        if (!projectDir) {
          setAtomError("Pick a project folder to continue.");
          return;
        }
      }

      const primary =
        mode === "solo"
          ? {
              port: soloTarget.port,
              model: soloTarget.model,
              contextWindow: soloTarget.contextWindow,
              parallel: soloTarget.parallel,
              vision: soloTarget.vision,
            }
          : {
              port: dualTargets!.brain.port,
              model: dualTargets!.brain.model,
              contextWindow: dualTargets!.brain.contextWindow,
              parallel: dualTargets!.brain.parallel,
              vision: dualTargets!.brain.vision,
            };
      const worker =
        mode === "solo"
          ? undefined
          : {
              port: dualTargets!.worker.port,
              model: dualTargets!.worker.model,
              contextWindow: dualTargets!.worker.contextWindow,
              parallel: dualTargets!.worker.parallel,
              vision: dualTargets!.worker.vision,
            };

      setAtomBusy("launch");
      try {
        if (tool === "atomcode") {
          const concurrent = Math.max(1, harnessAgents);
          const req: AtomcodeLaunchRequest = {
            mode,
            primary,
            worker,
            maxConcurrent: concurrent,
            projectDir,
          };
          const result = await invoke<AtomcodeLaunchResult>("atomcode_launch", {
            request: req,
          });
          setAtomMsg(
            `Opened AtomCode (${result.mode}) → :${primary.port}` +
              (worker ? ` + worker :${worker.port}` : ""),
          );
          void refreshAtomStatus();
        } else if (tool === "qwen") {
          const req: QwenLaunchRequest = {
            mode,
            primary,
            worker,
            projectDir,
          };
          const result = await invoke<QwenLaunchResult>("qwen_code_launch", {
            request: req,
          });
          setAtomMsg(
            `Opened Qwen Code (${result.mode}) → :${primary.port}` +
              (worker ? ` + worker :${worker.port}` : ""),
          );
          void refreshQwenStatus();
        } else {
          const req: PiLaunchRequest = {
            mode,
            primary,
            worker,
            projectDir,
            elevated: piElevated,
          };
          const result = await invoke<PiLaunchResult>("pi_code_launch", {
            request: req,
          });
          const elev =
            result.elevated || piElevated ? " · elevated" : "";
          setAtomMsg(
            `Opened pi (${result.mode}${elev}) → :${primary.port}` +
              (worker ? ` + worker :${worker.port}` : ""),
          );
          void refreshPiStatus();
        }
        setConfirmMode(null);

        const brainPort = primary.port;
        const brainSeat = runningEngines.find((e) => e.port === brainPort);
        if (brainSeat) {
          onSelectEngine?.(brainSeat.idx);
        }
        setHarnessOpen(false);
      } catch (e) {
        setAtomError(normalizeError(e));
        // Drop the confirm modal so the user can react to the error (retry install, change
        // project, etc.) without manually closing the dialog first.
        setConfirmMode(null);
      } finally {
        setAtomBusy("idle");
      }
    },
    [
      harnessTool,
      atomStatus?.lastProject,
      qwenStatus?.lastProject,
      piStatus?.lastProject,
      ensureAtomInstalled,
      ensureQwenInstalled,
      ensurePiInstalled,
      soloTarget,
      dualTargets,
      pickProjectDir,
      harnessAgents,
      refreshAtomStatus,
      refreshQwenStatus,
      refreshPiStatus,
      runningEngines,
      onSelectEngine,
      normalizeError,
      piElevated,
    ],
  );

  /** Start AtomCode browser webui (token URL from process stderr). */
  const openAtomcodeWebui = useCallback(async () => {
    setAtomError(null);
    setAtomMsg(null);
    if (!atomStatus?.installed) {
      setAtomError("Install AtomCode first (or open TUI once).");
      return;
    }
    setAtomBusy("webui");
    try {
      const result = await invoke<AtomcodeWebuiResult>("atomcode_open_webui", {
        port: null,
      });
      setAtomMsg(`WebUI opened → ${result.url}`);
    } catch (e) {
      setAtomError(normalizeError(e));
    } finally {
      setAtomBusy("idle");
    }
  }, [atomStatus?.installed, normalizeError]);

  /** Validate + open confirm modal (or disclaimer first). */
  const requestHarnessOpen = useCallback(
    (mode: "solo" | "brain_workers") => {
      setAtomError(null);
      setAtomMsg(null);
      if (mode === "solo" && !soloTarget.live) {
        setAtomError("Start an engine (Running) before opening the harness.");
        return;
      }
      if (mode === "brain_workers" && !dualTargets) {
        setAtomError("Twin needs two Running engines on different ports.");
        return;
      }
      const st =
        harnessTool === "qwen"
          ? qwenStatus
          : harnessTool === "pi"
            ? piStatus
            : atomStatus;
      if (st && !st.disclaimerAccepted) {
        setShowDisclaimer(true);
        setConfirmMode(mode);
        return;
      }
      setConfirmMode(mode);
    },
    [soloTarget.live, dualTargets, harnessTool, atomStatus, qwenStatus, piStatus],
  );

  const acceptDisclaimerAndInstall = useCallback(async () => {
    setAtomError(null);
    try {
      if (harnessTool === "qwen") {
        await invoke("qwen_code_accept_disclaimer");
        setShowDisclaimer(false);
        setAtomBusy("install");
        setInstallPhase("download");
        setAtomMsg("Downloading Qwen Code standalone (~180 MB)…");
        setInstallPhase("verify");
        const s = await invoke<QwenCodeStatus>("qwen_code_install", { version: null });
        setInstallPhase("finalize");
        setQwenStatus(s);
        setAtomMsg(`Installed Qwen ${s.version ?? s.pinnedVersion}`);
        void refreshQwenStatus();
      } else if (harnessTool === "pi") {
        await invoke("pi_code_accept_disclaimer");
        setShowDisclaimer(false);
        setAtomBusy("install");
        setInstallPhase("download");
        setAtomMsg("Downloading pi standalone (~46 MB)…");
        setInstallPhase("verify");
        const s = await invoke<PiCodeStatus>("pi_code_install", { version: null });
        setInstallPhase("finalize");
        setPiStatus(s);
        setAtomMsg(`Installed pi ${s.version ?? s.pinnedVersion}`);
        void refreshPiStatus();
      } else {
        await invoke("atomcode_accept_disclaimer");
        setShowDisclaimer(false);
        setAtomBusy("install");
        setInstallPhase("download");
        setAtomMsg("Downloading AtomCode…");
        setInstallPhase("verify");
        const s = await invoke<AtomcodeStatus>("atomcode_install", { version: null });
        setInstallPhase("finalize");
        setAtomStatus(s);
        setAtomMsg(`Installed ${s.version ?? s.pinnedVersion}`);
        void refreshAtomStatus();
      }
    } catch (e) {
      setAtomError(normalizeError(e));
      // On install failure, drop the confirm modal but leave showDisclaimer false — the
      // wizard footer's "Install {tool} only" button becomes the retry path.
      setConfirmMode(null);
    } finally {
      setAtomBusy("idle");
      setInstallPhase(null);
    }
  }, [harnessTool, normalizeError, refreshAtomStatus, refreshQwenStatus, refreshPiStatus]);

  const changeProjectDir = useCallback(async () => {
    const picked = await pickProjectDir();
    if (!picked) return;
    try {
      if (harnessTool === "qwen") {
        const s = await invoke<QwenCodeStatus>("qwen_code_set_project", {
          projectDir: picked,
        });
        setQwenStatus(s);
      } else if (harnessTool === "pi") {
        const s = await invoke<PiCodeStatus>("pi_code_set_project", {
          projectDir: picked,
        });
        setPiStatus(s);
      } else {
        const s = await invoke<AtomcodeStatus>("atomcode_set_project", {
          projectDir: picked,
        });
        setAtomStatus(s);
      }
      setAtomMsg(`Project: ${picked}`);
    } catch (e) {
      setAtomError(normalizeError(e));
    }
  }, [pickProjectDir, harnessTool, normalizeError]);

  const showDraftStrip = showDflashGet || showDflashChange;
  /** Assisted: violet strip for draft and/or SPEC-EXTRA. Full Auto: draft only (no SPEC-EXTRA). */
  const showVioletStrip =
    showDraftStrip || (showSpecExtra && specDetailParams.length > 0);

  /** Draft actions only (buttons) — used inline in the 1-row DFlash/DSPARK strip.
   *  Descriptive text ("DFlash needs a draft model…" / "Confirm pack to download")
   *  is dropped to keep the strip a single row like MTP; the action is last in line. */
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

  /** SPEC-EXTRA: one inline row of n_max / n_min / extras (Assisted only).
   *  Block gets MTP green / DFlash violet via strip tone; chips use theme value-chip. */
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

  // One assisted density for Essentials + Full (no padding jump on switch).
  const densityClass = hero
    ? "full-auto-cockpit--hero"
    : "full-auto-cockpit--normal";

  const agentsN = Math.max(1, harnessAgents);
  const twinReady = Boolean(dualTargets);
  const soloReady = soloTarget.live;
  const canLaunch =
    atomBusy === "idle" &&
    !showDisclaimer &&
    (wizardMode === "solo" ? soloReady : twinReady);

  /** Live engine parallel for the worker (or solo) seat — for restart advice. */
  const workerEngineParallel = useMemo(() => {
    if (wizardMode === "twin" && twinWorkerPort != null) {
      const e = engineByPort(twinWorkerPort);
      return Math.max(1, Number(e?.parallel) || 1);
    }
    if (soloTarget.live) {
      const e = runningEngines.find((x) => x.port === soloTarget.port);
      return Math.max(1, Number(e?.parallel) || 1);
    }
    return 1;
  }, [wizardMode, twinWorkerPort, soloTarget, runningEngines, engineByPort]);

  const needsEngineParallelBump =
    agentsN > 1 && workerEngineParallel < agentsN;

  const relaunchTarget = useMemo(() => {
    if (wizardMode === "twin" && twinWorkerPort != null) {
      const e = engineByPort(twinWorkerPort);
      if (e) return e;
    }
    if (soloTarget.live) {
      return runningEngines.find((x) => x.port === soloTarget.port) ?? null;
    }
    return null;
  }, [wizardMode, twinWorkerPort, soloTarget, runningEngines, engineByPort]);

  const doRelaunchSeat = useCallback(async () => {
    if (!onRelaunchSeat || !relaunchTarget) return;
    setRelaunchBusy(true);
    setAtomError(null);
    setAtomMsg(null);
    // Pin the seat until the engine vacates and returns (or timeout / fail).
    // Twin: rematch WORKER (or BRAIN if that seat was the target). Solo: seat null.
    const seat: "worker" | "brain" | null =
      wizardMode === "twin"
        ? twinWorkerPort != null && relaunchTarget.port === twinWorkerPort
          ? "worker"
          : twinBrainPort != null && relaunchTarget.port === twinBrainPort
            ? "brain"
            : "worker"
        : null;
    armPendingRelaunch({
      port: relaunchTarget.port,
      alias: (relaunchTarget.alias || "").trim(),
      seat,
    });
    try {
      await onRelaunchSeat({
        slotIdx: relaunchTarget.idx,
        port: relaunchTarget.port,
        alias: relaunchTarget.alias,
        parallel: agentsN,
      });
      setAtomMsg(
        `Relaunching ${relaunchTarget.alias} on :${relaunchTarget.port} with parallel ×${agentsN} (panel model/config)…`,
      );
      // Keep pending until prune effect rematches (port may lag invoke resolve).
    } catch (e) {
      setAtomError(normalizeError(e));
      clearPendingRelaunch();
      setRoleSyncTick((n) => n + 1);
    } finally {
      setRelaunchBusy(false);
    }
  }, [
    onRelaunchSeat,
    relaunchTarget,
    agentsN,
    normalizeError,
    wizardMode,
    twinWorkerPort,
    twinBrainPort,
    armPendingRelaunch,
    clearPendingRelaunch,
  ]);

  const confirmPortal =
    confirmMode && !showDisclaimer && typeof document !== "undefined"
      ? createPortal(
          <div
            className="atomcode-confirm-overlay"
            role="dialog"
            aria-modal="true"
            aria-labelledby="atomcode-confirm-title"
            onClick={(e) => {
              if (e.target === e.currentTarget && atomBusy === "idle") setConfirmMode(null);
            }}
          >
            <div className="atomcode-confirm-modal font-mono">
              <h3 id="atomcode-confirm-title" className="atomcode-confirm-title">
                {confirmMode === "solo"
                  ? `Open ${
                      harnessTool === "qwen" ? "Qwen Code" : harnessTool === "pi" ? "pi" : "AtomCode"
                    } — SOLO`
                  : `Open ${
                      harnessTool === "qwen" ? "Qwen Code" : harnessTool === "pi" ? "pi" : "AtomCode"
                    } — TWIN`}
              </h3>
              {harnessTool === "pi" && piElevated && (
                <p className="atomcode-confirm-elevated font-mono text-[9px] text-yellow-400/90 m-0 mb-2">
                  Elevated (gsudo) — UAC prompt, then admin pi console
                </p>
              )}
              <p className="atomcode-confirm-summary" aria-live="polite">
                {confirmMode === "solo" ? (
                  <>
                    <span className="atomcode-confirm-summary__mode">BRAIN SOLO</span>
                    <span className="atomcode-confirm-summary__engine">{soloTarget.displayId}</span>
                    {harnessTool !== "qwen" && (
                      <span className="atomcode-confirm-summary__agents">AGENTS ×{agentsN}</span>
                    )}
                  </>
                ) : dualTargets ? (
                  <>
                    <span className="atomcode-confirm-summary__mode">BRAIN TWIN</span>
                    <span className="atomcode-confirm-summary__engine">
                      {dualTargets.brain.model} : {dualTargets.brain.port}
                    </span>
                    <span className="atomcode-confirm-summary__sep">·</span>
                    <span className="atomcode-confirm-summary__engine atomcode-confirm-summary__engine--worker">
                      WORKER {dualTargets.worker.model} : {dualTargets.worker.port}
                    </span>
                    {harnessTool !== "qwen" && (
                      <span className="atomcode-confirm-summary__agents">AGENTS ×{agentsN}</span>
                    )}
                  </>
                ) : (
                  <span className="atomcode-confirm-summary__mode">TWIN — pick engines</span>
                )}
              </p>
              <p
                className="atomcode-confirm-path"
                title={activeToolStatus?.lastProject ?? undefined}
              >
                <span className="atomcode-confirm-path__label">Project</span>
                {activeToolStatus?.lastProject || "(pick on confirm if unset)"}
              </p>
              <div className="atomcode-confirm-actions">
                <button
                  type="button"
                  className="atomcode-launch-btn atomcode-launch-btn--solo font-mono tracking-wider uppercase"
                  disabled={atomBusy !== "idle"}
                  onClick={() => void executeHarnessLaunch(confirmMode)}
                >
                  {atomBusy === "install"
                    ? "Installing…"
                    : atomBusy === "launch"
                      ? "Launching…"
                      : "Confirm & open"}
                </button>
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono"
                  disabled={atomBusy !== "idle"}
                  onClick={() => setConfirmMode(null)}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono"
                  disabled={atomBusy !== "idle"}
                  onClick={() => void changeProjectDir()}
                >
                  Change project…
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )
      : null;

  const soloEngineLine = soloReady
    ? `${soloTarget.model} :${soloTarget.port} · ${soloTarget.modelName}`
    : "Click a running engine above";
  const twinBrainLine = twinBrainPort != null
    ? (() => {
        const e = engineByPort(twinBrainPort);
        if (!e) return `? :${twinBrainPort}`;
        return `${e.alias} :${e.port} · ${e.model_name}`;
      })()
    : "Click half or engines → BRAIN";
  const twinWorkerLine = twinWorkerPort != null
    ? (() => {
        const e = engineByPort(twinWorkerPort);
        if (!e) return `? :${twinWorkerPort}`;
        return `${e.alias} :${e.port} · ${e.model_name}`;
      })()
    : "Click half or engines → WORKER";

  /**
   * Left/right halves follow running-engines order (left → right).
   * If WORKER sits left of BRAIN in the stack, halves swap so gold/green track the cards.
   */
  const twinWorkerOnLeft = useMemo(() => {
    if (twinBrainPort == null || twinWorkerPort == null) return false;
    const bi = runningEngines.findIndex((e) => e.port === twinBrainPort);
    const wi = runningEngines.findIndex((e) => e.port === twinWorkerPort);
    if (bi < 0 || wi < 0) return false;
    return wi < bi;
  }, [runningEngines, twinBrainPort, twinWorkerPort]);

  /** Cycle a twin seat through running ports (exclude the other seat). */
  const cycleTwinSeat = useCallback(
    (seat: "brain" | "worker") => {
      setWizardMode("twin");
      setTwinRoles((r) => {
        const exclude = seat === "brain" ? r.worker : r.brain;
        const ports = runningEngines
          .map((e) => e.port)
          .filter((p) => p !== exclude);
        if (ports.length === 0) return r;
        const cur = seat === "brain" ? r.brain : r.worker;
        const next =
          cur == null
            ? ports[0]
            : ports[(Math.max(0, ports.indexOf(cur)) + 1) % ports.length];
        return seat === "brain"
          ? { brain: next, worker: r.worker === next ? null : r.worker }
          : { brain: r.brain === next ? null : r.brain, worker: next };
      });
    },
    [runningEngines],
  );

  /* ── Full takeover wizard (replaces power cockpit while open) ── */
  if (harnessOpen) {
    const toolName =
      harnessTool === "qwen" ? "Qwen Code" : harnessTool === "pi" ? "pi" : "AtomCode";
    const toolShort =
      harnessTool === "qwen" ? "Qwen" : harnessTool === "pi" ? "pi" : "AtomCode";
    const twinDisabled = runningEngines.length < 2;
    return (
      <div
        className={`full-auto-cockpit atomcode-wizard ${className}`}
        data-atomcode-wizard="1"
      >
        <div className="atomcode-wizard__header">
          <span className="atomcode-wizard__title font-mono tracking-[0.18em] uppercase">
            Harness connect
          </span>
          {/* One-line "what is this" subtitle. Now lives in the header right
              under the title — keeps the wizard body focused on actionable
              choices (mode / project / concurrency / launch). */}
          <p className="atomcode-wizard__blurb font-mono">
            {SHOW_LEGACY_HARNESS_TOOLS
              ? "External coding agent on your engines · isolated home · no cloud keys. "
              : "pi on your engines · isolated home · BRAIN/WORKER routing · no cloud keys. "}
            <span className="atomcode-wizard__blurb-brain">BRAIN</span> plans ·{" "}
            <span className="atomcode-wizard__blurb-worker">WORKER</span> swarms.
          </p>
          {/* Tool chips: pi is the only exposed harness. AtomCode/Qwen remain
              in the tree behind SHOW_LEGACY_HARNESS_TOOLS (code not deleted). */}
          <div className="atomcode-wizard__header-tools" role="group" aria-label="Harness tool">
            {SHOW_LEGACY_HARNESS_TOOLS && (
              <>
                <button
                  type="button"
                  className={`atomcode-wizard__tool-chip font-mono${harnessTool === "atomcode" ? " atomcode-wizard__tool-chip--on" : ""}`}
                  onClick={() => {
                    setHarnessTool("atomcode");
                    setShowDisclaimer(false);
                    setAtomError(null);
                  }}
                  aria-pressed={harnessTool === "atomcode"}
                  title={
                    atomStatus?.installed
                      ? `AtomCode ${atomStatus.version ?? atomStatus.pinnedVersion} installed`
                      : "AtomCode — installs on first open (~30 MB)"
                  }
                >
                  AtomCode
                  <span className="atomcode-wizard__tool-meta">
                    {atomStatus?.installed
                      ? atomStatus.version ?? atomStatus.pinnedVersion
                      : "~30 MB"}
                  </span>
                </button>
                <button
                  type="button"
                  className={`atomcode-wizard__tool-chip font-mono${harnessTool === "qwen" ? " atomcode-wizard__tool-chip--on" : ""}`}
                  onClick={() => {
                    setHarnessTool("qwen");
                    setShowDisclaimer(false);
                    setAtomError(null);
                  }}
                  aria-pressed={harnessTool === "qwen"}
                  title={
                    qwenStatus?.installed
                      ? `Qwen Code ${qwenStatus.version ?? qwenStatus.pinnedVersion} installed`
                      : "Qwen Code — installs on first open (~180 MB · vision)"
                  }
                >
                  Qwen Code
                  <span className="atomcode-wizard__tool-meta">
                    {qwenStatus?.installed
                      ? qwenStatus.version ?? qwenStatus.pinnedVersion
                      : "~180 MB · vision"}
                  </span>
                </button>
              </>
            )}
            <button
              type="button"
              className={`atomcode-wizard__tool-chip font-mono${harnessTool === "pi" ? " atomcode-wizard__tool-chip--on" : ""}`}
              onClick={() => {
                setHarnessTool("pi");
                setShowDisclaimer(false);
                setAtomError(null);
              }}
              aria-pressed={harnessTool === "pi"}
              title={
                piStatus?.installed
                  ? `pi ${piStatus.version ?? piStatus.pinnedVersion} installed`
                  : "pi — installs on first open (~46 MB standalone)"
              }
            >
              pi
              <span className="atomcode-wizard__tool-meta">
                {piStatus?.installed
                  ? piStatus.version ?? piStatus.pinnedVersion
                  : "~46 MB standalone"}
              </span>
            </button>
            {isDevBuild() && harnessTool === "pi" && (
              <button
                type="button"
                className="atomcode-wizard__update font-mono"
                onClick={updatePiToLatest}
                disabled={piUpdating || atomBusy === "install"}
                title="DEV: fetch the latest pi release + refresh the bundled pi-subagents extension"
              >
                {piUpdating ? "UPDATING…" : "UPDATE"}
              </button>
            )}
          </div>

          <button
            type="button"
            className="atomcode-wizard__close font-mono tracking-wider uppercase"
            onClick={() => setHarnessOpen(false)}
            title="Close harness — unlocks engine config"
          >
            CLOSE
          </button>
        </div>

        {/* Install progress strip — visible only while a Rust install is in flight.
            Phase steps give the user a journey to follow; the indeterminate bar
            moves so the eye sees activity. Suppresses the rest of the wizard
            (mode/project/concurrency) being interactable during a blocking invoke. */}
        {installPhase != null && (
          <div
            className="atomcode-wizard__install font-mono"
            role="status"
            aria-live="polite"
          >
            <div className="atomcode-wizard__install-label">
              {INSTALL_PHASE_LABEL[installPhase]}
            </div>
            <div className="atomcode-wizard__install-phases">
              {INSTALL_PHASES.map((p) => {
                const reached =
                  INSTALL_PHASES.findIndex((x) => x.id === installPhase) >=
                  INSTALL_PHASES.findIndex((x) => x.id === p.id);
                return (
                  <span
                    key={p.id}
                    className={`atomcode-wizard__install-step${reached ? " atomcode-wizard__install-step--reached" : ""}${p.id === installPhase ? " atomcode-wizard__install-step--active" : ""}`}
                    title={p.label}
                  >
                    {p.label}
                  </span>
                );
              })}
            </div>
            <div className="atomcode-wizard__install-bar" aria-hidden>
              <div
                className="atomcode-wizard__install-bar-fill"
                style={{ animationDelay: `${(installTick % 8) * 120}ms` }}
              />
            </div>
          </div>
        )}

        {/* Mode switch — directly above the unified mode button. Uses the same
            .segment-switch styling as the engine config Essentials/FULL toggle. */}
        <div className="atomcode-wizard__mode-switch-row">
          <span className="atomcode-wizard__mode-switch-label">Mode</span>
          <div
            className="segment-switch segment-switch--harness"
            data-segment-switch
            data-active={wizardMode === "solo" ? "left" : "right"}
            role="group"
            aria-label="Harness mode"
          >
            <span className="segment-switch__thumb" aria-hidden />
            <button
              type="button"
              className={`segment-switch__option${wizardMode === "solo" ? " segment-switch__option--active" : ""}`}
              aria-pressed={wizardMode === "solo"}
              onClick={() => setWizardMode("solo")}
            >
              SOLO
            </button>
            <button
              type="button"
              className={`segment-switch__option${wizardMode === "twin" ? " segment-switch__option--active" : ""}`}
              aria-pressed={wizardMode === "twin"}
              onClick={() => {
                if (twinDisabled) return;
                setWizardMode("twin");
              }}
              disabled={twinDisabled}
              title={
                twinDisabled
                  ? "Twin needs 2+ running engines"
                  : undefined
              }
            >
              TWIN
            </button>
          </div>
        </div>

        {/* Unified mode button — single visual element, renders either a
            SOLO label or the BRAIN/WORKER split depending on `wizardMode`. */}
        {twinDisabled && wizardMode === "twin" ? null : (
          <button
            type="button"
            className={`atomcode-wizard__mode-shell font-mono${wizardMode === "solo" ? " atomcode-wizard__mode-shell--solo" : " atomcode-wizard__mode-shell--twin"}`}
            aria-label={wizardMode === "solo" ? "Solo mode details" : "Twin mode seat details"}
          >
            {/* SOLO face — full-width single label */}
            <div className="atomcode-wizard__mode-solo">
              <div className="atomcode-wizard__mode-half-top">
                <span className="atomcode-wizard__mode-half-tag">SOLO</span>
                <div className="atomcode-wizard__mode-half-info">
                  <span className="atomcode-wizard__mode-half-title">BRAIN</span>
                  <span className="atomcode-wizard__mode-half-desc">
                    One engine — reads the repo, plans, and acts without delegation.
                  </span>
                </div>
              </div>
              <div
                className="atomcode-wizard__mode-half-engine font-mono"
                title={soloEngineLine}
              >
                {soloEngineLine}
              </div>
            </div>

            {/* TWIN face — equal-split BRAIN / WORKER halves */}
            <div
              className={`atomcode-wizard__mode-twin${twinWorkerOnLeft ? " atomcode-wizard__mode-twin--flip" : ""}`}
            >
              {twinWorkerOnLeft ? (
                <>
                  <div className="atomcode-wizard__mode-twin-half atomcode-wizard__mode-twin-half--worker">
                    <div className="atomcode-wizard__mode-half-top">
                      <span className="atomcode-wizard__mode-half-tag atomcode-wizard__mode-half-tag--worker">
                        WORKER
                      </span>
                      <div className="atomcode-wizard__mode-half-info">
                        <span className="atomcode-wizard__mode-half-title">SUB AGENTS ×{agentsN}</span>
                        <span className="atomcode-wizard__mode-half-desc">
                          Run delegated subtasks in parallel — file edits, tests, repo research.
                        </span>
                      </div>
                    </div>
                    <div
                      className="atomcode-wizard__mode-half-engine font-mono"
                      title={twinWorkerLine}
                    >
                      {twinWorkerLine}
                    </div>
                  </div>
                  <div className="atomcode-wizard__mode-twin-half atomcode-wizard__mode-twin-half--brain">
                    <div className="atomcode-wizard__mode-half-top">
                      <span className="atomcode-wizard__mode-half-tag">BRAIN</span>
                      <div className="atomcode-wizard__mode-half-info">
                        <span className="atomcode-wizard__mode-half-title">ORCHESTRATOR</span>
                        <span className="atomcode-wizard__mode-half-desc">
                          Reads the repo, plans, and delegates subtasks to the worker.
                        </span>
                      </div>
                    </div>
                    <div
                      className="atomcode-wizard__mode-half-engine font-mono"
                      title={twinBrainLine}
                    >
                      {twinBrainLine}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div className="atomcode-wizard__mode-twin-half atomcode-wizard__mode-twin-half--brain">
                    <div className="atomcode-wizard__mode-half-top">
                      <span className="atomcode-wizard__mode-half-tag">BRAIN</span>
                      <div className="atomcode-wizard__mode-half-info">
                        <span className="atomcode-wizard__mode-half-title">ORCHESTRATOR</span>
                        <span className="atomcode-wizard__mode-half-desc">
                          Reads the repo, plans, and delegates subtasks to the worker.
                        </span>
                      </div>
                    </div>
                    <div
                      className="atomcode-wizard__mode-half-engine font-mono"
                      title={twinBrainLine}
                    >
                      {twinBrainLine}
                    </div>
                  </div>
                  <div className="atomcode-wizard__mode-twin-half atomcode-wizard__mode-twin-half--worker">
                    <div className="atomcode-wizard__mode-half-top">
                      <span className="atomcode-wizard__mode-half-tag atomcode-wizard__mode-half-tag--worker">
                        WORKER
                      </span>
                      <div className="atomcode-wizard__mode-half-info">
                        <span className="atomcode-wizard__mode-half-title">SUB AGENTS ×{agentsN}</span>
                        <span className="atomcode-wizard__mode-half-desc">
                          Run delegated subtasks in parallel — file edits, tests, repo research.
                        </span>
                      </div>
                    </div>
                    <div
                      className="atomcode-wizard__mode-half-engine font-mono"
                      title={twinWorkerLine}
                    >
                      {twinWorkerLine}
                    </div>
                  </div>
                </>
              )}
            </div>
          </button>
        )}
        {twinDisabled && wizardMode === "twin" && (
          <p className="atomcode-wizard__agents-hint font-mono m-0">
            Twin needs 2+ running engines. Start another engine to unlock TWIN.
          </p>
        )}

        {/* Project directory + path — below the half-card */}
        <div className="atomcode-wizard__header-project">
          <button
            type="button"
            className="atomcode-wizard__project-btn font-mono"
            disabled={atomBusy !== "idle"}
            onClick={() => void changeProjectDir()}
          >
            POINT THE AGENT — SELECT YOUR PROJECT DIRECTORY
          </button>
          <p
            className="atomcode-wizard__project-path font-mono"
            title={activeToolStatus?.lastProject ?? undefined}
          >
            {activeToolStatus?.lastProject || "No folder yet — pick one to continue"}
          </p>
        </div>

        {showDisclaimer && (
          <div className="atomcode-wizard__disclaimer space-y-2">
            <pre className="atomcode-wizard__disclaimer-body font-mono">
              {harnessTool === "qwen"
                ? QWEN_CODE_DISCLAIMER
                : harnessTool === "pi"
                  ? PI_CODE_DISCLAIMER
                  : ATOMCODE_DISCLAIMER}
            </pre>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                className="atomcode-wizard__project-btn font-mono"
                disabled={atomBusy !== "idle"}
                onClick={() => void acceptDisclaimerAndInstall()}
              >
                Accept &amp; install tool
              </button>
              <button
                type="button"
                className="full-auto-cockpit__copy font-mono"
                onClick={() => {
                  setShowDisclaimer(false);
                  setConfirmMode(null);
                }}
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Bottom row — LEFT: concurrency chips + relaunch advice if any.
            RIGHT: Open CTA + quiet secondary actions (WebUI / pre-install). */}
        {!showDisclaimer && (
          <div className="atomcode-wizard__footer">
            {presetRolesLocked && wizardMode === "twin" && (
              <p className="atomcode-wizard__roles-locked font-mono text-[8px] text-yellow-400/85 m-0 mb-1.5 w-full">
                BRAIN/WORKER locked from preset until both engines finish loading — clicks ignored
                {" · "}
                <button
                  type="button"
                  className="underline text-yellow-400/90 bg-transparent border-0 p-0 cursor-pointer font-mono text-[8px]"
                  onClick={() => setPresetRolesLocked(false)}
                >
                  Unlock now
                </button>
              </p>
            )}
            {launchPresets && (
              <div className="atomcode-wizard__presets flex flex-wrap items-center gap-1.5 mb-2 w-full">
                <span className="text-[8px] uppercase tracking-wider text-stealth-muted/70">Combo</span>
                <select
                  className="bg-stealth-input border border-stealth-border/50 px-1.5 py-0.5 text-[9px] font-mono max-w-[180px]"
                  defaultValue=""
                  onChange={(e) => {
                    const id = e.target.value;
                    e.target.value = "";
                    const c = launchPresets.combos.find((x) => x.id === id);
                    if (c) launchPresets.onApply(c, { loadIntoPanel: false });
                  }}
                  aria-label="Load launch combo"
                >
                  <option value="" disabled>
                    Load combo…
                  </option>
                  {launchPresets.combos.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.kind === "twin" ? "Twin" : "Solo"} · {c.name}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono text-[8px]"
                  disabled={launchPresets.canSaveTwin === false}
                  title="Save BRAIN+WORKER from tagged engines"
                  onClick={() => launchPresets.onSaveTwin()}
                >
                  Save combo
                </button>
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono text-[8px]"
                  onClick={() => launchPresets.onManage()}
                >
                  Manage…
                </button>
              </div>
            )}
            {harnessTool === "pi" && (
              <label
                className="atomcode-wizard__elevated flex items-center gap-1.5 mb-1.5 w-full cursor-pointer select-none"
                title="Run pi console elevated via bundled gsudo (UAC). Use for system ops (services, hosts, privileged shell)."
              >
                <input
                  type="checkbox"
                  className="accent-nv-green"
                  checked={piElevated}
                  onChange={(e) => {
                    const on = e.target.checked;
                    setPiElevated(on);
                    writeStorage(KEYS.piCodeElevated, on ? "1" : "0");
                  }}
                />
                <span className="text-[8px] font-mono uppercase tracking-wide text-stealth-muted">
                  Elevated (gsudo)
                </span>
              </label>
            )}
            {/* LEFT — concurrency chips */}
            <div className="atomcode-wizard__footer-agents">
              <p className="atomcode-wizard__step-label font-mono m-0">
                {wizardMode === "twin" ? "Worker concurrency" : "Agent concurrency"}
              </p>
              <div className="atomcode-wizard__agents" role="group" aria-label="Concurrent agents">
                {agentOptions.map((o) => {
                  const active = o.parallel === agentsN;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      className={`atomcode-wizard__agent-chip font-mono${active ? " atomcode-wizard__agent-chip--on" : ""}`}
                      title={o.blurb}
                      onClick={() => {
                        setHarnessAgents(o.parallel);
                        // Best-effort sync cockpit parallel (may no-op under MTP force Solo)
                        onCodingMode(o.id);
                      }}
                    >
                      <span className="atomcode-wizard__agent-n">×{o.parallel}</span>
                      <span className="atomcode-wizard__agent-label">{o.label}</span>
                    </button>
                  );
                })}
              </div>
              {/* The verbose "Harness cap ×N · engine parallel now ×N · extras
                  will queue…" hint was removed — the relaunch message below
                  already conveys the only case where any of that matters. */}

              {needsEngineParallelBump && relaunchTarget && onRelaunchSeat && (
                <div className="atomcode-wizard__relaunch font-mono">
                  <p className="atomcode-wizard__relaunch-msg m-0">
                    {wizardMode === "twin"
                      ? "RESTART the WORKER model to match AGENTS concurrency"
                      : "RESTART the BRAIN model to match AGENTS concurrency"}
                  </p>
                  <button
                    type="button"
                    className="atomcode-wizard__relaunch-btn font-mono"
                    disabled={relaunchBusy || atomBusy !== "idle"}
                    onClick={() => void doRelaunchSeat()}
                  >
                    {relaunchBusy
                      ? "Restarting…"
                      : `RESTART ${relaunchTarget.alias} :${relaunchTarget.port} · ×${agentsN}`}
                  </button>
                </div>
              )}

              {!needsEngineParallelBump && relaunchTarget && onRelaunchSeat && (
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono atomcode-wizard__hotswap"
                  disabled={relaunchBusy || atomBusy !== "idle"}
                  title="Stop this seat and launch the catalog/panel model on the same port (keep alias)"
                  onClick={() => void doRelaunchSeat()}
                >
                  {relaunchBusy
                    ? "Relaunching…"
                    : `Hot-swap ${relaunchTarget.alias} :${relaunchTarget.port} ← panel model · ×${agentsN}`}
                </button>
              )}
            </div>

            {/* RIGHT — Open CTA + secondary */}
            <div className="atomcode-wizard__footer-cta">
              <button
                type="button"
                className={`atomcode-wizard__go font-mono tracking-wider uppercase${
                  wizardMode === "twin"
                    ? ` atomcode-wizard__go--twin${twinWorkerOnLeft ? " atomcode-wizard__go--twin-flip" : ""}`
                    : " atomcode-wizard__go--solo"
                }`}
                disabled={!canLaunch}
                onClick={() =>
                  requestHarnessOpen(wizardMode === "solo" ? "solo" : "brain_workers")
                }
              >
                {atomBusy === "install"
                  ? "Installing…"
                  : atomBusy === "launch"
                    ? "Launching…"
                    : wizardMode === "solo"
                      ? `Open ${toolShort} on this engine`
                      : `Open ${toolShort} on BRAIN + WORKER`}
              </button>

              {harnessTool === "atomcode" && atomStatus?.installed && (
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono atomcode-wizard__webui"
                  disabled={atomBusy !== "idle"}
                  title="Start AtomCode webui, capture token URL, open system browser (standalone — not TUI sync)"
                  onClick={() => void openAtomcodeWebui()}
                >
                  {atomBusy === "webui" ? "Starting WebUI…" : "Or open AtomCode WebUI"}
                </button>
              )}

              {activeToolStatus && !activeToolStatus.installed && (
                <button
                  type="button"
                  className="full-auto-cockpit__copy font-mono"
                  disabled={atomBusy !== "idle"}
                  onClick={() => {
                    if (!activeToolStatus.disclaimerAccepted) {
                      setShowDisclaimer(true);
                    } else if (harnessTool === "qwen") {
                      void ensureQwenInstalled();
                    } else if (harnessTool === "pi") {
                      void ensurePiInstalled();
                    } else {
                      void ensureAtomInstalled();
                    }
                  }}
                >
                  {harnessTool === "qwen"
                    ? "Pre-install Qwen Code (~180 MB)"
                    : harnessTool === "pi"
                      ? "Pre-install pi (~46 MB)"
                      : "Pre-install AtomCode (~30 MB)"}
                </button>
              )}
            </div>
          </div>
        )}

        {atomMsg && <p className="atomcode-msg-ok font-mono m-0">{atomMsg}</p>}
        {atomError && <p className="atomcode-msg-err font-mono m-0">{atomError}</p>}

        {confirmPortal}
      </div>
    );
  }

  return (
    <div
      className={`full-auto-cockpit ${densityClass} ${className}`}
      data-booster-layout={layout}
      data-power-mode={powerMode ? "on" : "off"}
      data-density-unified={densityUnified ? "on" : "off"}
      data-ctx-dock={showCtxRail ? "in" : "above"}
    >
      {/* Title left · soft note · flags · AGENTIC (compact — not a full footer CTA) */}
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
          {!harnessOpen && (
            <button
              type="button"
              onClick={() => setHarnessOpen(true)}
              className="full-auto-cockpit__connect full-auto-cockpit__connect--header font-mono tracking-wider uppercase shrink-0"
              title="Connect an external coding agent (AtomCode / Qwen / pi)"
            >
              AGENTIC
            </button>
          )}
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
