import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { invoke } from "@tauri-apps/api/core";
import type { SpecCapability } from "../lib/specDraft";
import type { StackEntry } from "../lib/types";
import {
  ATOMCODE_DISCLAIMER,
  type AtomcodeLaunchRequest,
  type AtomcodeLaunchResult,
  type AtomcodeStatus,
} from "../lib/atomcode";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  BRAINS_OPTIONS,
  THINK_OPTIONS,
  buildAgentOptions,
  buildHarnessSnippets,
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
  /**
   * Live engine stack — used for AtomCode one-click (solo against RUNNING, or Brain+Workers).
   * When omitted, AtomCode uses port/modelId config values only.
   */
  stack?: StackEntry[];
  /** Preferred running slot (e.g. selected engine). */
  preferredSlotIdx?: number | null;
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
  stack = [],
  preferredSlotIdx = null,
}: MultiAgentBoosterProps) {
  const [harnessOpen, setHarnessOpen] = useState(false);
  /** Manual OpenAI snippets — collapsed by default; AtomCode is the primary surface. */
  const [manualOpen, setManualOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [atomStatus, setAtomStatus] = useState<AtomcodeStatus | null>(null);
  const [atomBusy, setAtomBusy] = useState<"idle" | "install" | "launch">("idle");
  const [atomError, setAtomError] = useState<string | null>(null);
  const [atomMsg, setAtomMsg] = useState<string | null>(null);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  /** Confirm modal before external launch. */
  const [confirmMode, setConfirmMode] = useState<"solo" | "brain_workers" | null>(null);
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

  /**
   * SPEC-EXTRA strip — Assisted Essentials + Full (not Full Auto hero).
   * When Boost is MTP/DFlash (or draft-* raw). Ngram/simple: no strip.
   */
  const showSpecExtra = useMemo(() => {
    if (hero || specDetailParams.length === 0) return false;
    if (displayBoost === "mtp" || displayBoost === "dflash") return true;
    if (!activeRawSpecType) return false;
    // ngram / simple: no SPEC-EXTRA; other draft-* may show knobs
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
    dflashLibraryReady &&
    displayBoost === "dflash";

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
      if (low === "draft-mtp" || low === "mtp" || low === "draft-dflash" || low === "dflash") {
        continue;
      }
      if (shouldOmitSpecTypeFromBoost(t)) continue;
      marks.push(parseSpecTypeBoostMark(t));
    }

    // Always surface MTP / DFlash product marks (capability-gated disable)
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

  const refreshAtomStatus = useCallback(async () => {
    try {
      const s = await invoke<AtomcodeStatus>("atomcode_status");
      setAtomStatus(s);
      return s;
    } catch (e) {
      setAtomError(String(e));
      return null;
    }
  }, []);

  useEffect(() => {
    if (!harnessOpen) return;
    void refreshAtomStatus();
  }, [harnessOpen, refreshAtomStatus]);

  useEffect(() => {
    if (!harnessOpen) {
      setManualOpen(false);
      setConfirmMode(null);
    }
  }, [harnessOpen]);

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
      .filter((s) => s.status === "RUNNING" && s.port > 0)
      .slice()
      .sort((a, b) => a.idx - b.idx);
  }, [stack]);

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
        displayId: `${alias} :${hit.port}`,
        contextWindow: hit.n_ctx && hit.n_ctx > 0 ? hit.n_ctx : undefined,
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
      displayId: "no Running engine",
      contextWindow: undefined as number | undefined,
      live: false as const,
    };
  }, [runningEngines, preferredSlotIdx, port]);

  /**
   * Twin attach: selected/first Running = BRAIN (default provider), other = WORKER (subagents).
   * Roles are ports in launch-config — aliases need not be the words BRAIN/WORKER.
   */
  const dualTargets = useMemo(() => {
    if (runningEngines.length < 2) return null;
    let brain = runningEngines[0];
    if (preferredSlotIdx != null && preferredSlotIdx >= 0) {
      const pref = runningEngines.find((s) => s.idx === preferredSlotIdx);
      if (pref) brain = pref;
    }
    const worker =
      runningEngines.find((s) => s.port !== brain.port) ?? runningEngines[1];
    if (worker.port === brain.port) return null;
    const brainAlias = (brain.alias || "").trim() || "ENGINE-BRAIN";
    const workerAlias = (worker.alias || "").trim() || "ENGINE-WORKER";
    return {
      brain: {
        port: brain.port,
        model: brainAlias,
        displayId: `BRAIN ${brainAlias} :${brain.port}`,
        contextWindow: brain.n_ctx && brain.n_ctx > 0 ? brain.n_ctx : undefined,
        label: brain.alias || brain.model_name,
      },
      worker: {
        port: worker.port,
        model: workerAlias,
        displayId: `WORKER ${workerAlias} :${worker.port}`,
        contextWindow: worker.n_ctx && worker.n_ctx > 0 ? worker.n_ctx : undefined,
        label: worker.alias || worker.model_name,
      },
    };
  }, [runningEngines, preferredSlotIdx]);

  /** Highlight running engines (rail + panel) while harness is open. */
  useEffect(() => {
    const root = document.documentElement;
    if (!harnessOpen) {
      delete root.dataset.atomcodeHarness;
      dispatchAppEvent(EVENTS.atomcodeHarnessHighlight, { open: false });
      return;
    }
    root.dataset.atomcodeHarness = "1";
    dispatchAppEvent(EVENTS.atomcodeHarnessHighlight, {
      open: true,
      soloPort: soloTarget.live ? soloTarget.port : null,
      brainPort: dualTargets?.brain.port ?? null,
      workerPort: dualTargets?.worker.port ?? null,
      selectedSlotIdx: preferredSlotIdx,
    });
    return () => {
      delete root.dataset.atomcodeHarness;
      dispatchAppEvent(EVENTS.atomcodeHarnessHighlight, { open: false });
    };
  }, [harnessOpen, soloTarget, dualTargets, preferredSlotIdx]);

  const pickProjectDir = useCallback(async (): Promise<string | null> => {
    const picked = await invoke<string | null>("open_folder_dialog", {
      title: "AtomCode project folder",
    });
    return picked;
  }, []);

  const ensureInstalled = useCallback(async (): Promise<AtomcodeStatus | null> => {
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
      setAtomMsg(`Downloading AtomCode ${s.pinnedVersion} (~30 MB)…`);
      try {
        s = await invoke<AtomcodeStatus>("atomcode_install", { version: null });
        setAtomStatus(s);
        setAtomMsg(`Installed ${s.version ?? s.pinnedVersion}`);
      } catch (e) {
        setAtomError(String(e));
        setAtomBusy("idle");
        return null;
      }
      setAtomBusy("idle");
    }
    return s;
  }, [atomStatus, refreshAtomStatus]);

  const executeAtomcodeLaunch = useCallback(
    async (mode: "solo" | "brain_workers") => {
      setAtomError(null);
      setAtomMsg(null);
      const s = await ensureInstalled();
      if (!s) return;

      if (mode === "solo" && soloTarget.port <= 0) {
        setAtomError("No port — launch an engine first, or set base port.");
        return;
      }
      if (mode === "solo" && !soloTarget.live) {
        setAtomError("Start an engine (Running) before opening AtomCode.");
        return;
      }
      if (mode === "brain_workers" && !dualTargets) {
        setAtomError("Twin needs two Running engines on different ports.");
        return;
      }

      let projectDir = s.lastProject;
      if (!projectDir) {
        projectDir = await pickProjectDir();
        if (!projectDir) {
          setAtomError("Pick a project folder to continue.");
          return;
        }
      }

      const concurrent = Math.max(1, parallelForCodingMode(plan.codingMode));
      const req: AtomcodeLaunchRequest =
        mode === "solo"
          ? {
              mode: "solo",
              primary: {
                port: soloTarget.port,
                model: soloTarget.model,
                contextWindow: soloTarget.contextWindow,
              },
              maxConcurrent: concurrent,
              projectDir,
            }
          : {
              mode: "brain_workers",
              primary: {
                port: dualTargets!.brain.port,
                model: dualTargets!.brain.model,
                contextWindow: dualTargets!.brain.contextWindow,
              },
              worker: {
                port: dualTargets!.worker.port,
                model: dualTargets!.worker.model,
                contextWindow: dualTargets!.worker.contextWindow,
              },
              maxConcurrent: concurrent,
              projectDir,
            };

      setAtomBusy("launch");
      try {
        const result = await invoke<AtomcodeLaunchResult>("atomcode_launch", {
          request: req,
        });
        setConfirmMode(null);
        setAtomMsg(
          `Opened AtomCode (${result.mode}) → :${req.primary.port}` +
            (req.worker ? ` + worker :${req.worker.port}` : ""),
        );
        void refreshAtomStatus();
      } catch (e) {
        setAtomError(String(e));
      } finally {
        setAtomBusy("idle");
      }
    },
    [
      ensureInstalled,
      soloTarget,
      dualTargets,
      pickProjectDir,
      plan.codingMode,
      refreshAtomStatus,
    ],
  );

  /** Validate + open confirm modal (or disclaimer first). */
  const requestAtomcode = useCallback(
    (mode: "solo" | "brain_workers") => {
      setAtomError(null);
      setAtomMsg(null);
      if (mode === "solo" && !soloTarget.live) {
        setAtomError("Start an engine (Running) before opening AtomCode.");
        return;
      }
      if (mode === "brain_workers" && !dualTargets) {
        setAtomError("Twin needs two Running engines on different ports.");
        return;
      }
      if (atomStatus && !atomStatus.disclaimerAccepted) {
        setShowDisclaimer(true);
        setConfirmMode(mode);
        return;
      }
      setConfirmMode(mode);
    },
    [soloTarget.live, dualTargets, atomStatus],
  );

  const acceptDisclaimerAndInstall = useCallback(async () => {
    setAtomError(null);
    try {
      await invoke("atomcode_accept_disclaimer");
      setShowDisclaimer(false);
      setAtomBusy("install");
      setAtomMsg("Downloading AtomCode…");
      const s = await invoke<AtomcodeStatus>("atomcode_install", { version: null });
      setAtomStatus(s);
      setAtomMsg(`Installed ${s.version ?? s.pinnedVersion}`);
      // Keep confirmMode if user was mid-launch; modal reopens ready to confirm.
    } catch (e) {
      setAtomError(String(e));
      setConfirmMode(null);
    } finally {
      setAtomBusy("idle");
    }
  }, []);

  const changeProjectDir = useCallback(async () => {
    const picked = await pickProjectDir();
    if (!picked) return;
    try {
      const s = await invoke<AtomcodeStatus>("atomcode_set_project", {
        projectDir: picked,
      });
      setAtomStatus(s);
      setAtomMsg(`Project: ${picked}`);
    } catch (e) {
      setAtomError(String(e));
    }
  }, [pickProjectDir]);

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

  // One assisted density for Essentials + Full (no padding jump on switch).
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

      <div className="full-auto-cockpit__body space-y-3">
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
        <div className="full-auto-cockpit__harness full-auto-cockpit__harness--atom space-y-2">
          <div className="full-auto-cockpit__snippet full-auto-cockpit__atom-panel overflow-hidden">
            <div className="full-auto-cockpit__snippet-bar flex items-center justify-between gap-2">
              <span className="font-mono tracking-wider uppercase">AtomCode</span>
              <span className="font-mono opacity-60" style={{ fontSize: 7 }}>
                {atomStatus?.installed
                  ? atomStatus.version ?? atomStatus.pinnedVersion
                  : `not installed · ${atomStatus?.pinnedVersion ?? "…"}`}
              </span>
            </div>
            <div className="full-auto-cockpit__snippet-body space-y-2">
              <p className="full-auto-cockpit__harness-hint font-mono leading-snug m-0">
                External agent · telemetry off. Click a running engine to choose single / BRAIN.
                Twin uses selected as <strong className="atomcode-role-badge atomcode-role-badge--brain">1 · BRAIN</strong>
                {" "}and the other as{" "}
                <strong className="atomcode-role-badge atomcode-role-badge--worker">2 · WORKER</strong>.
              </p>

              {/* Live routing summary — badges match engine chrome */}
              <div className="atomcode-route-row font-mono flex flex-wrap items-center gap-1.5">
                <span className="atomcode-route-label">Single</span>
                {soloTarget.live ? (
                  <span className="atomcode-role-badge atomcode-role-badge--solo atomcode-role-badge--selected">
                    {soloTarget.displayId}
                  </span>
                ) : (
                  <span className="atomcode-role-badge atomcode-role-badge--muted">no Running engine</span>
                )}
                <span className="atomcode-route-sep">·</span>
                <span className="atomcode-role-badge atomcode-role-badge--agents">
                  Agents ×{parallelForCodingMode(plan.codingMode)}
                </span>
              </div>
              <div className="atomcode-route-row font-mono flex flex-wrap items-center gap-1.5">
                <span className="atomcode-route-label">Twin</span>
                {dualTargets ? (
                  <>
                    <span className="atomcode-role-badge atomcode-role-badge--brain">
                      1 · {dualTargets.brain.model} :{dualTargets.brain.port}
                    </span>
                    <span className="atomcode-route-arrow" aria-hidden>
                      →
                    </span>
                    <span className="atomcode-role-badge atomcode-role-badge--worker">
                      2 · {dualTargets.worker.model} :{dualTargets.worker.port}
                    </span>
                  </>
                ) : (
                  <span className="atomcode-role-badge atomcode-role-badge--muted">need 2 Running engines</span>
                )}
              </div>

              {atomStatus?.lastProject && (
                <p
                  className="full-auto-cockpit__harness-hint font-mono leading-snug m-0 truncate"
                  title={atomStatus.lastProject}
                >
                  Project: {atomStatus.lastProject}
                </p>
              )}

              {showDisclaimer && (
                <div className="full-auto-cockpit__atom-disclaimer space-y-2">
                  <pre className="full-auto-cockpit__snippet-body font-mono whitespace-pre-wrap break-words m-0 max-h-40 overflow-y-auto eink-scrollbar">
                    {ATOMCODE_DISCLAIMER}
                  </pre>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      className="full-auto-cockpit__connect font-mono"
                      disabled={atomBusy !== "idle"}
                      onClick={() => void acceptDisclaimerAndInstall()}
                    >
                      Accept &amp; install
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

              {!showDisclaimer && (
                <div className="atomcode-launch-actions flex flex-col gap-1.5">
                  <button
                    type="button"
                    className="atomcode-launch-btn atomcode-launch-btn--solo font-mono tracking-wider uppercase"
                    disabled={atomBusy !== "idle" || !soloTarget.live}
                    title="Open AtomCode against the selected / first Running engine"
                    onClick={() => requestAtomcode("solo")}
                  >
                    {atomBusy === "install"
                      ? "Installing…"
                      : atomBusy === "launch" && confirmMode === "solo"
                        ? "Launching…"
                        : "Open AtomCode — single engine"}
                  </button>
                  <button
                    type="button"
                    className="atomcode-launch-btn atomcode-launch-btn--twin font-mono tracking-wider uppercase"
                    disabled={atomBusy !== "idle" || !dualTargets}
                    title={
                      dualTargets
                        ? `1 BRAIN ${dualTargets.brain.model}:${dualTargets.brain.port} · 2 WORKER ${dualTargets.worker.model}:${dualTargets.worker.port}`
                        : "Start two engines first (any aliases)"
                    }
                    onClick={() => requestAtomcode("brain_workers")}
                  >
                    {atomBusy === "launch" && confirmMode === "brain_workers"
                      ? "Launching…"
                      : "Open AtomCode — twin engine"}
                  </button>
                  <div className="flex flex-wrap gap-2 items-center">
                    <button
                      type="button"
                      className="full-auto-cockpit__copy font-mono"
                      disabled={atomBusy !== "idle"}
                      onClick={() => void changeProjectDir()}
                    >
                      Project…
                    </button>
                    {!atomStatus?.installed && (
                      <button
                        type="button"
                        className="full-auto-cockpit__copy font-mono"
                        disabled={atomBusy !== "idle"}
                        onClick={() => {
                          if (atomStatus && !atomStatus.disclaimerAccepted) {
                            setShowDisclaimer(true);
                          } else {
                            void ensureInstalled();
                          }
                        }}
                      >
                        Install tool
                      </button>
                    )}
                  </div>
                </div>
              )}

              {atomMsg && (
                <p className="full-auto-cockpit__harness-hint font-mono m-0 atomcode-msg-ok">
                  {atomMsg}
                </p>
              )}
              {atomError && (
                <p className="full-auto-cockpit__harness-hint font-mono m-0 atomcode-msg-err">
                  {atomError}
                </p>
              )}
            </div>
          </div>

          <button
            type="button"
            className="full-auto-cockpit__copy font-mono tracking-wider uppercase atomcode-manual-toggle"
            onClick={() => setManualOpen((v) => !v)}
          >
            {manualOpen ? "Hide manual connect" : "Manual connect…"}
          </button>

          {manualOpen && (
            <div className="atomcode-manual-block space-y-2">
              <p className="full-auto-cockpit__harness-hint font-mono leading-snug m-0">
                Copy endpoint snippets for other harnesses (≈{" "}
                {parallelForCodingMode(plan.codingMode)} parallel slots on single engine).
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
        </div>
      )}

      {/* Confirm launch modal */}
      {confirmMode && !showDisclaimer && typeof document !== "undefined" &&
        createPortal(
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
                  ? "Open AtomCode — single engine"
                  : "Open AtomCode — twin engine"}
              </h3>
              <p className="atomcode-confirm-lead">
                Spawns an external AtomCode window (not inside this app). Telemetry off. Project
                scoped to the folder below.
              </p>
              <dl className="atomcode-confirm-dl">
                {confirmMode === "solo" ? (
                  <>
                    <div>
                      <dt>Engine</dt>
                      <dd>
                        <span className="atomcode-role-badge atomcode-role-badge--solo">
                          {soloTarget.displayId}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>OpenAI model id</dt>
                      <dd>{soloTarget.model}</dd>
                    </div>
                  </>
                ) : dualTargets ? (
                  <>
                    <div>
                      <dt>1 · BRAIN (default)</dt>
                      <dd>
                        <span className="atomcode-role-badge atomcode-role-badge--brain">
                          {dualTargets.brain.model} :{dualTargets.brain.port}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>2 · WORKER (subagents)</dt>
                      <dd>
                        <span className="atomcode-role-badge atomcode-role-badge--worker">
                          {dualTargets.worker.model} :{dualTargets.worker.port}
                        </span>
                      </dd>
                    </div>
                  </>
                ) : null}
                <div>
                  <dt>Agents / subagents</dt>
                  <dd>×{parallelForCodingMode(plan.codingMode)}</dd>
                </div>
                <div>
                  <dt>Project</dt>
                  <dd className="atomcode-confirm-path" title={atomStatus?.lastProject ?? undefined}>
                    {atomStatus?.lastProject || "(pick on confirm if unset)"}
                  </dd>
                </div>
                <div>
                  <dt>Tool</dt>
                  <dd>
                    {atomStatus?.installed
                      ? `installed ${atomStatus.version ?? atomStatus.pinnedVersion}`
                      : `will download ~30 MB (${atomStatus?.pinnedVersion ?? "…"})`}
                  </dd>
                </div>
              </dl>
              <div className="atomcode-confirm-actions">
                <button
                  type="button"
                  className="atomcode-launch-btn atomcode-launch-btn--solo font-mono tracking-wider uppercase"
                  disabled={atomBusy !== "idle"}
                  onClick={() => void executeAtomcodeLaunch(confirmMode)}
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
        )}

      {/* Footer: violet draft + SPEC-EXTRA (Assisted) + Connect */}
      <div className="full-auto-cockpit__footer full-auto-cockpit__footer--actions">
        {violetStrip}
        <button
          type="button"
          onClick={() => setHarnessOpen((v) => !v)}
          className={`full-auto-cockpit__connect font-mono tracking-wider uppercase shrink-0${harnessOpen ? " full-auto-cockpit__connect--active" : ""}`}
          title="AtomCode external agent"
        >
          {harnessOpen ? "Hide AtomCode" : "AtomCode"}
        </button>
      </div>
    </div>
  );
}
