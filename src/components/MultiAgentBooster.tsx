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
  type AtomcodeWebuiResult,
} from "../lib/atomcode";
import {
  QWEN_CODE_DISCLAIMER,
  type QwenCodeStatus,
  type QwenLaunchRequest,
  type QwenLaunchResult,
} from "../lib/qwenCode";
import {
  dispatchAppEvent,
  EVENTS,
  type AtomcodeEngineClickDetail,
} from "../lib/events";
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
  onHarnessOpenChange,
  onRelaunchSeat,
  onSelectEngine,
}: MultiAgentBoosterProps) {
  const [harnessOpen, setHarnessOpen] = useState(false);
  /** Which external agent tool the harness targets. */
  const [harnessTool, setHarnessTool] = useState<"atomcode" | "qwen">("atomcode");
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
  const [atomStatus, setAtomStatus] = useState<AtomcodeStatus | null>(null);
  const [qwenStatus, setQwenStatus] = useState<QwenCodeStatus | null>(null);
  const [atomBusy, setAtomBusy] = useState<"idle" | "install" | "launch" | "webui">("idle");
  const [atomError, setAtomError] = useState<string | null>(null);
  const [atomMsg, setAtomMsg] = useState<string | null>(null);
  const [showDisclaimer, setShowDisclaimer] = useState(false);
  /** Confirm modal before external launch. */
  const [confirmMode, setConfirmMode] = useState<"solo" | "brain_workers" | null>(null);
  const [relaunchBusy, setRelaunchBusy] = useState(false);
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

  const refreshQwenStatus = useCallback(async () => {
    try {
      const s = await invoke<QwenCodeStatus>("qwen_code_status");
      setQwenStatus(s);
      return s;
    } catch (e) {
      setAtomError(String(e));
      return null;
    }
  }, []);

  const activeToolStatus = harnessTool === "qwen" ? qwenStatus : atomStatus;

  useEffect(() => {
    if (!harnessOpen) return;
    void refreshAtomStatus();
    void refreshQwenStatus();
  }, [harnessOpen, refreshAtomStatus, refreshQwenStatus]);

  useEffect(() => {
    if (!harnessOpen) {
      setConfirmMode(null);
      setShowDisclaimer(false);
    } else {
      // Seed from UI codingMode (not plan — MTP may force plan to Solo)
      setHarnessAgents(Math.max(1, parallelForCodingMode(codingMode)));
      // Drop prior open/install toast so reconnect does not show a stale "Opened AtomCode…"
      setAtomMsg(null);
      setAtomError(null);
    }
    onHarnessOpenChange?.(harnessOpen);
  }, [harnessOpen, onHarnessOpenChange]); // eslint-disable-line react-hooks/exhaustive-deps -- seed only on open

  // Ephemeral success toasts (install / open / relaunch) — auto-clear so they never stick
  useEffect(() => {
    if (!atomMsg) return;
    const t = window.setTimeout(() => setAtomMsg(null), 4000);
    return () => window.clearTimeout(t);
  }, [atomMsg]);

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

  const engineByPort = useCallback(
    (port: number | null) =>
      port != null ? runningEngines.find((e) => e.port === port) ?? null : null,
    [runningEngines],
  );

  /**
   * Twin: explicit BRAIN/WORKER ports from click-cycle on running engine cards.
   * Click same card: none → BRAIN → WORKER → clear. Works with 3+ engines.
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
  }, [runningEngines, twinBrainPort, twinWorkerPort, engineByPort]);

  // Drop roles for engines that stopped
  useEffect(() => {
    const ports = new Set(runningEngines.map((e) => e.port));
    setTwinRoles((r) => {
      const brain = r.brain != null && ports.has(r.brain) ? r.brain : null;
      const worker = r.worker != null && ports.has(r.worker) ? r.worker : null;
      if (brain === r.brain && worker === r.worker) return r;
      return { brain, worker };
    });
  }, [runningEngines]);

  // Soft seed twin when both roles empty
  useEffect(() => {
    if (!harnessOpen || wizardMode !== "twin") return;
    if (twinBrainPort != null || twinWorkerPort != null) return;
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
  ]);

  // Twin roles via running-engine clicks:
  // · Same card: BRAIN → WORKER → clear
  // · Free card: fill empty BRAIN, else empty WORKER, else take BRAIN seat
  useEffect(() => {
    if (!harnessOpen) return;
    const onClick = (e: Event) => {
      const d = (e as CustomEvent<AtomcodeEngineClickDetail>).detail;
      if (!d?.port || wizardMode !== "twin") return;
      const port = d.port;
      setTwinRoles(({ brain, worker }) => {
        const isBrain = brain === port;
        const isWorker = worker === port;
        if (isBrain) {
          // BRAIN → WORKER (other worker seat replaced)
          return { brain: null, worker: port };
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
  }, [harnessOpen, wizardMode]);

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
      setAtomMsg(`Downloading Qwen Code ${s.pinnedVersion} (~180 MB standalone)…`);
      try {
        s = await invoke<QwenCodeStatus>("qwen_code_install", { version: null });
        setQwenStatus(s);
        setAtomMsg(`Installed Qwen ${s.version ?? s.pinnedVersion}`);
      } catch (e) {
        setAtomError(String(e));
        setAtomBusy("idle");
        return null;
      }
      setAtomBusy("idle");
    }
    return s;
  }, [qwenStatus, refreshQwenStatus]);

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
        tool === "qwen" ? qwenStatus?.lastProject : atomStatus?.lastProject;

      if (tool === "atomcode") {
        const s = await ensureAtomInstalled();
        if (!s) return;
        projectDir = s.lastProject;
      } else {
        const s = await ensureQwenInstalled();
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
            }
          : {
              port: dualTargets!.brain.port,
              model: dualTargets!.brain.model,
              contextWindow: dualTargets!.brain.contextWindow,
            };
      const worker =
        mode === "solo"
          ? undefined
          : {
              port: dualTargets!.worker.port,
              model: dualTargets!.worker.model,
              contextWindow: dualTargets!.worker.contextWindow,
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
        } else {
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
        }
        setConfirmMode(null);

        const brainPort = primary.port;
        const brainSeat = runningEngines.find((e) => e.port === brainPort);
        if (brainSeat) {
          onSelectEngine?.(brainSeat.idx);
        }
        setHarnessOpen(false);
      } catch (e) {
        setAtomError(String(e));
      } finally {
        setAtomBusy("idle");
      }
    },
    [
      harnessTool,
      atomStatus?.lastProject,
      qwenStatus?.lastProject,
      ensureAtomInstalled,
      ensureQwenInstalled,
      soloTarget,
      dualTargets,
      pickProjectDir,
      harnessAgents,
      refreshAtomStatus,
      refreshQwenStatus,
      runningEngines,
      onSelectEngine,
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
      setAtomError(String(e));
    } finally {
      setAtomBusy("idle");
    }
  }, [atomStatus?.installed]);

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
      const st = harnessTool === "qwen" ? qwenStatus : atomStatus;
      if (st && !st.disclaimerAccepted) {
        setShowDisclaimer(true);
        setConfirmMode(mode);
        return;
      }
      setConfirmMode(mode);
    },
    [soloTarget.live, dualTargets, harnessTool, atomStatus, qwenStatus],
  );

  const acceptDisclaimerAndInstall = useCallback(async () => {
    setAtomError(null);
    try {
      if (harnessTool === "qwen") {
        await invoke("qwen_code_accept_disclaimer");
        setShowDisclaimer(false);
        setAtomBusy("install");
        setAtomMsg("Downloading Qwen Code standalone (~180 MB)…");
        const s = await invoke<QwenCodeStatus>("qwen_code_install", { version: null });
        setQwenStatus(s);
        setAtomMsg(`Installed Qwen ${s.version ?? s.pinnedVersion}`);
      } else {
        await invoke("atomcode_accept_disclaimer");
        setShowDisclaimer(false);
        setAtomBusy("install");
        setAtomMsg("Downloading AtomCode…");
        const s = await invoke<AtomcodeStatus>("atomcode_install", { version: null });
        setAtomStatus(s);
        setAtomMsg(`Installed ${s.version ?? s.pinnedVersion}`);
      }
    } catch (e) {
      setAtomError(String(e));
      setConfirmMode(null);
    } finally {
      setAtomBusy("idle");
    }
  }, [harnessTool]);

  const changeProjectDir = useCallback(async () => {
    const picked = await pickProjectDir();
    if (!picked) return;
    try {
      if (harnessTool === "qwen") {
        const s = await invoke<QwenCodeStatus>("qwen_code_set_project", {
          projectDir: picked,
        });
        setQwenStatus(s);
      } else {
        const s = await invoke<AtomcodeStatus>("atomcode_set_project", {
          projectDir: picked,
        });
        setAtomStatus(s);
      }
      setAtomMsg(`Project: ${picked}`);
    } catch (e) {
      setAtomError(String(e));
    }
  }, [pickProjectDir, harnessTool]);

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
    } catch (e) {
      setAtomError(String(e));
    } finally {
      setRelaunchBusy(false);
    }
  }, [onRelaunchSeat, relaunchTarget, agentsN]);

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
                  ? `Open ${harnessTool === "qwen" ? "Qwen Code" : "AtomCode"} — single engine`
                  : `Open ${harnessTool === "qwen" ? "Qwen Code" : "AtomCode"} — twin engine`}
              </h3>
              <p className="atomcode-confirm-lead">
                Opens an external {harnessTool === "qwen" ? "Qwen Code" : "AtomCode"} window.
                Isolated home · files only under the project folder.
                {harnessTool === "qwen" ? " Multimodal image paste enabled." : ""}
              </p>
              <dl className="atomcode-confirm-dl">
                {confirmMode === "solo" ? (
                  <>
                    <div>
                      <dt>BRAIN (solo)</dt>
                      <dd>
                        <span className="atomcode-role-badge atomcode-role-badge--brain">
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
                      <dt>1 · BRAIN</dt>
                      <dd>
                        <span className="atomcode-role-badge atomcode-role-badge--brain">
                          {dualTargets.brain.model} :{dualTargets.brain.port}
                        </span>
                      </dd>
                    </div>
                    <div>
                      <dt>2 · WORKER</dt>
                      <dd>
                        <span className="atomcode-role-badge atomcode-role-badge--worker">
                          {dualTargets.worker.model} :{dualTargets.worker.port}
                        </span>
                      </dd>
                    </div>
                  </>
                ) : null}
                {harnessTool === "atomcode" && (
                  <div>
                    <dt>Agents</dt>
                    <dd>×{agentsN}</dd>
                  </div>
                )}
                <div>
                  <dt>Project</dt>
                  <dd
                    className="atomcode-confirm-path"
                    title={activeToolStatus?.lastProject ?? undefined}
                  >
                    {activeToolStatus?.lastProject || "(pick on confirm if unset)"}
                  </dd>
                </div>
                <div>
                  <dt>Tool</dt>
                  <dd>
                    {activeToolStatus?.installed
                      ? `installed ${activeToolStatus.version ?? activeToolStatus.pinnedVersion}`
                      : harnessTool === "qwen"
                        ? `will download ~180 MB (${activeToolStatus?.pinnedVersion ?? "…"})`
                        : `will download ~30 MB (${activeToolStatus?.pinnedVersion ?? "…"})`}
                  </dd>
                </div>
              </dl>
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
    ? soloTarget.displayId
    : "Click a running engine above";
  const twinBrainLine = twinBrainPort != null
    ? `${engineByPort(twinBrainPort)?.alias ?? "?"} :${twinBrainPort}`
    : "Click half or engines → BRAIN";
  const twinWorkerLine = twinWorkerPort != null
    ? `${engineByPort(twinWorkerPort)?.alias ?? "?"} :${twinWorkerPort}`
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

  const twinBrainHalf = (
    <button
      type="button"
      className="atomcode-wizard__twin-half atomcode-wizard__twin-half--brain font-mono"
      disabled={runningEngines.length < 2}
      title="Select twin · click again to cycle BRAIN among running engines"
      onClick={() => {
        if (runningEngines.length < 2) return;
        if (wizardMode !== "twin") {
          setWizardMode("twin");
          return;
        }
        cycleTwinSeat("brain");
      }}
    >
      <span className="atomcode-wizard__mode-name">TWIN · BRAIN</span>
      <span className="atomcode-wizard__mode-desc">Orchestrator</span>
      <span className="atomcode-wizard__mode-engine font-mono">{twinBrainLine}</span>
    </button>
  );

  const twinWorkerHalf = (
    <button
      type="button"
      className="atomcode-wizard__twin-half atomcode-wizard__twin-half--worker font-mono"
      disabled={runningEngines.length < 2}
      title="Select twin · click again to cycle WORKER among running engines"
      onClick={() => {
        if (runningEngines.length < 2) return;
        if (wizardMode !== "twin") {
          setWizardMode("twin");
          return;
        }
        cycleTwinSeat("worker");
      }}
    >
      <span className="atomcode-wizard__mode-name">WORKER</span>
      <span className="atomcode-wizard__mode-desc">Subagents ×{agentsN}</span>
      <span className="atomcode-wizard__mode-engine font-mono">{twinWorkerLine}</span>
    </button>
  );

  /* ── Full takeover wizard (replaces power cockpit while open) ── */
  if (harnessOpen) {
    return (
      <div
        className={`full-auto-cockpit atomcode-wizard ${className}`}
        data-atomcode-wizard="1"
      >
        <div className="atomcode-wizard__header">
          <span className="atomcode-wizard__title font-mono tracking-[0.18em] uppercase">
            Harness connect
          </span>
          <span className="atomcode-wizard__subtitle font-mono">
            {harnessTool === "qwen" ? "Qwen Code" : "AtomCode"} ·{" "}
            {activeToolStatus?.installed
              ? activeToolStatus.version ?? activeToolStatus.pinnedVersion
              : "install on first open"}
          </span>
          <button
            type="button"
            className="atomcode-wizard__close font-mono tracking-wider uppercase"
            onClick={() => setHarnessOpen(false)}
          >
            Close
          </button>
        </div>

        {/* Tool picker — AtomCode (Rust PE) vs Qwen Code (Node standalone) */}
        <div className="atomcode-wizard__tool-row" role="group" aria-label="Harness tool">
          <button
            type="button"
            className={`atomcode-wizard__tool-chip font-mono${harnessTool === "atomcode" ? " atomcode-wizard__tool-chip--on" : ""}`}
            onClick={() => {
              setHarnessTool("atomcode");
              setShowDisclaimer(false);
              setAtomError(null);
            }}
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
          >
            Qwen Code
            <span className="atomcode-wizard__tool-meta">
              {qwenStatus?.installed
                ? qwenStatus.version ?? qwenStatus.pinnedVersion
                : "~180 MB · vision"}
            </span>
          </button>
        </div>

        {/* Compact full-width blurb — not a side column */}
        <p className="atomcode-wizard__blurb font-mono">
          External agent on your engines · isolated home · no cloud keys.{" "}
          <span className="atomcode-wizard__blurb-brain">BRAIN</span> plans ·{" "}
          <span className="atomcode-wizard__blurb-worker">WORKER</span> swarms. Twin: click engine
          cards or the halves below.
          {harnessTool === "qwen"
            ? " Qwen: native image paste / multimodal."
            : " AtomCode: fast Rust TUI + optional WebUI."}
        </p>

        {/* Full-width stacked mode buttons */}
        <div className="atomcode-wizard__mode-stack">
          <button
            type="button"
            className={`atomcode-wizard__mode-btn atomcode-wizard__mode-btn--solo font-mono${wizardMode === "solo" ? " atomcode-wizard__mode-btn--on" : ""}`}
            onClick={() => setWizardMode("solo")}
          >
            <div className="atomcode-wizard__mode-btn-inner">
              <span className="atomcode-wizard__mode-name">SOLO</span>
              <span className="atomcode-wizard__mode-desc">One engine · BRAIN does everything</span>
              <span className="atomcode-wizard__mode-engine font-mono">{soloEngineLine}</span>
              <span className="atomcode-wizard__mode-meta font-mono">Agents ×{agentsN}</span>
            </div>
          </button>

          <div
            className={`atomcode-wizard__mode-btn atomcode-wizard__mode-btn--twin font-mono${wizardMode === "twin" ? " atomcode-wizard__mode-btn--on" : ""}${runningEngines.length < 2 ? " atomcode-wizard__mode-btn--disabled" : ""}${twinWorkerOnLeft ? " atomcode-wizard__mode-btn--twin-flip" : ""}`}
            role="group"
            aria-label="Twin mode BRAIN and WORKER"
          >
            {twinWorkerOnLeft ? (
              <>
                {twinWorkerHalf}
                {twinBrainHalf}
              </>
            ) : (
              <>
                {twinBrainHalf}
                {twinWorkerHalf}
              </>
            )}
          </div>
          {runningEngines.length < 2 && (
            <p className="atomcode-wizard__agents-hint font-mono m-0">
              Twin needs 2+ running engines.
            </p>
          )}
        </div>

        <p className="atomcode-wizard__step-label font-mono">
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
        <p className="atomcode-wizard__agents-hint font-mono">
          Harness cap ×{agentsN}
          {workerEngineParallel > 0
            ? ` · engine parallel now ×${workerEngineParallel}`
            : ""}
          {needsEngineParallelBump
            ? " · extras will queue until engine is relaunched"
            : ""}
        </p>

        {needsEngineParallelBump && relaunchTarget && onRelaunchSeat && (
          <div className="atomcode-wizard__relaunch font-mono">
            <p className="atomcode-wizard__relaunch-msg m-0">
              {wizardMode === "twin" ? "WORKER" : "Engine"}{" "}
              <strong>{relaunchTarget.alias}</strong> is live at parallel ×
              {workerEngineParallel}, harness wants ×{agentsN}. Relaunch uses the{" "}
              <strong>current panel model + chip settings</strong> (not the old process’s GGUF),
              same port/alias, with <strong>--parallel {agentsN}</strong>. Or use{" "}
              <strong>HS</strong> on any running-engine card anytime.
            </p>
            <button
              type="button"
              className="atomcode-wizard__relaunch-btn font-mono"
              disabled={relaunchBusy || atomBusy !== "idle"}
              onClick={() => void doRelaunchSeat()}
            >
              {relaunchBusy
                ? "Relaunching…"
                : `Relaunch ${relaunchTarget.alias} :${relaunchTarget.port} · ×${agentsN}`}
            </button>
          </div>
        )}

        {/* Always offer same-port hot-swap when a seat is selected */}
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

        {showDisclaimer && (
          <div className="atomcode-wizard__disclaimer space-y-2">
            <pre className="atomcode-wizard__disclaimer-body font-mono">
              {harnessTool === "qwen" ? QWEN_CODE_DISCLAIMER : ATOMCODE_DISCLAIMER}
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

        {!showDisclaimer && (
          <div className="atomcode-wizard__launch-row">
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
                    ? `Open ${harnessTool === "qwen" ? "Qwen" : "AtomCode"} — single`
                    : `Open ${harnessTool === "qwen" ? "Qwen" : "AtomCode"} — twin`}
            </button>
            <div className="atomcode-wizard__project-side">
              <button
                type="button"
                className="atomcode-wizard__project-btn font-mono"
                disabled={atomBusy !== "idle"}
                onClick={() => void changeProjectDir()}
              >
                {activeToolStatus?.lastProject ? "Project…" : "Choose project"}
              </button>
              <p
                className="atomcode-wizard__project-path font-mono"
                title={activeToolStatus?.lastProject ?? undefined}
              >
                {activeToolStatus?.lastProject || "No folder yet"}
              </p>
            </div>
          </div>
        )}

        {/* AtomCode-only: browser UI */}
        {!showDisclaimer && harnessTool === "atomcode" && atomStatus?.installed && (
          <button
            type="button"
            className="full-auto-cockpit__copy font-mono atomcode-wizard__webui"
            disabled={atomBusy !== "idle"}
            title="Start AtomCode webui, capture token URL, open system browser (standalone — not TUI sync)"
            onClick={() => void openAtomcodeWebui()}
          >
            {atomBusy === "webui" ? "Starting WebUI…" : "Open AtomCode WebUI"}
          </button>
        )}

        {!showDisclaimer && activeToolStatus && !activeToolStatus.installed && (
          <button
            type="button"
            className="full-auto-cockpit__copy font-mono"
            disabled={atomBusy !== "idle"}
            onClick={() => {
              if (!activeToolStatus.disclaimerAccepted) {
                setShowDisclaimer(true);
              } else if (harnessTool === "qwen") {
                void ensureQwenInstalled();
              } else {
                void ensureAtomInstalled();
              }
            }}
          >
            {harnessTool === "qwen"
              ? "Install Qwen only (~180 MB)"
              : "Install AtomCode only (~30 MB)"}
          </button>
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
