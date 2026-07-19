// Model-specific parameter configuration and launch control.

import { useState, useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { createPortal } from "react-dom";
import type { ConfigViewMode, ModelEntry, EngineConfig, GpuInfo, UserEditedTemplateParam, ProviderConfig, ProviderTemplate, StackEntry, SystemInfo } from "../lib/types";
import { DEFAULT_PROVIDER_ID, isProfileBuilt, profileEnvLookup } from "../lib/types";
import {
  KEYS,
  binaryProfileKey,
  engineAliasKey,
  migrateGlobalSpecOutOfCatalogOverrides,
  normalizeModelPathKey,
  loadAutoVramEnabled,
  loadConfigView,
  loadEnginesInRail,
  loadHwMonitorOpen,
  loadLaunchDockCollapsed,
  loadLaunchDockPosition,
  loadLaunchDockPositionExplicit,
  loadUiDensity,
  type LaunchDockPosition,
  normalizeUiGroup,
  saveEnginesInRail,
  saveHwMonitorOpen,
  saveLaunchDockCollapsed,
  saveLaunchDockPosition,
  paramUiGroup,
  readJsonStorage,
  readStorage,
  removeStorage,
  saveAutoVramEnabled,
  saveConfigView,
  writeJsonStorage,
  writeStorage,
} from "../lib/storage";
import {
  isEssentialParam,
  providerSupportsFitLaunch,
  resolveEssentialParamKeys,
  resolveManualLaunchKeys,
} from "../lib/launchProfile";
import ConfigViewToggle from "./ConfigViewToggle";
import MultiAgentBooster from "./MultiAgentBooster";
import {
  brainsFromKvQuant,
  codingModeFromParallel,
  pickHighNumeric,
  resolveFullAutoPlan,
  type BrainsId,
  type CodingModeId,
  type SpeedBoostId,
  type ThinkId,
} from "../lib/multiAgentBooster";
import {
  isGroupFullyHidden,
  PANEL_CHROME_PARAM_KEYS,
} from "../lib/paramDisplayZone";
import type { GroupDisplayZone } from "../lib/storage";
import ConfigBelowGroups from "./ConfigBelowGroups";
import GpuAssignPanel from "./GpuAssignPanel";
import DisplayChromeHints from "./DisplayChromeHints";
import GroupHeaderControls from "./GroupHeaderControls";
import type { ConfigColumnCount } from "../lib/configColumnLayout";
import { effectiveGroupColumn } from "../lib/configColumnLayout";
import { isEmptyGroupDeletable } from "../lib/groupLayoutUtils";
import { useGroupLayoutControls } from "../hooks/useGroupLayoutControls";
import { useLaunchDockRailResize } from "../hooks/useCatalogSplitResize";
import LaunchRailTelemetry from "./LaunchRailTelemetry";

import { dispatchAppEvent, EVENTS } from "../lib/events";
import { tomMtpBlocked, TOM_MTP_SKIP_MESSAGE } from "../lib/tomMtp";
import {
  type DraftRole,
  type ScoredDraft,
  type SpecCapability,
  defaultSpecTypeForMain,
  draftRoleForSpecType,
  findScoredDraftCandidates,
  isDraftPairingValid,
  isExternalDraftOnly,
  isLaunchableMain,
  isValidGgufDraftPath,
  essentialsSpecChipLabel,
  essentialsSpecPreset,
  clearModelSpecOverride,
  isSpecTypeValidForMain,
  loadDraftPairing,
  loadModelSpecOverride,
  pickBestDraftPair,
  resolveSpecLaunchActive,
  saveModelSpecOverride,
  resolveDraftPathLabel,
  saveDraftPairing,
  specCapabilitiesForMain,
  specTypeAllowsParallel,
  specTypeNeedsExternalDraft,
} from "../lib/specDraft";
import { DEFAULT_BINARY_PROFILE, ENV_META, ENV_ORDER, normalizeBinaryProfile, type Env, isDriverSufficientForProfile, getMinDriverMajorForCuda } from "../lib/foundry_constants";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import VramBadge from "./VramBadge";
import WelcomeAnimation from "./onboarding/WelcomeAnimation";
import SetupGuideDisplay from "./onboarding/SetupGuideDisplay";
import RunningEnginesPanel from "./RunningEnginesPanel";
import SliderParam from "./SliderParam";
import { formatCtxChipLabel, formatTokenLabel } from "../lib/sliderParamUtils";
import { useScenarioEvaluator } from "../hooks/useScenarioEvaluator";
import type { SetupGuideState } from "../hooks/useSetupGuide";
import { useConfigResolver } from "../hooks/useConfigResolver";
import { useDisplayTexture } from "../context/DisplayTextureContext";

import DisplayGlitchOverlay from "./DisplayGlitchOverlay";
import { useFoundry } from "../hooks/useBuildDock";
import { isDevBuild } from "../lib/build";
import { buildLaunchFullConfig } from "../lib/buildLaunchFullConfig";
import { resolveLaunchChromePolicy } from "../lib/launchChromePolicy";
import { paramValuesMatch } from "../lib/paramConfigResolve";
import { committedSlotsFromStack } from "../services/vram/scenarios/scenarios_factory";
import { useGpuIdleBaseline } from "../hooks/useGpuIdleBaseline";
import { formatShareHwTopo, type FusionShareLaunchConfig } from "../lib/fusionShareCapture";



type EnvProfile = Env;

function onboardingDisplayClasses(setupGuide: SetupGuideState): {
  area: string;
  frame: string;
} {
  const areaBase = "industrial-display-area flex flex-col min-h-0";
  const frameBase = "industrial-display-frame relative";
  if (!setupGuide.active) {
    return {
      area: `${areaBase} flex-shrink-0`,
      frame: `${frameBase} flex-shrink-0`,
    };
  }
  if (setupGuide.showWelcome) {
    return {
      area: `${areaBase} industrial-display-area--welcome`,
      frame: `${frameBase} industrial-display-frame--welcome`,
    };
  }
  return {
    area: `${areaBase} flex-shrink-0`,
    frame: `${frameBase} flex-shrink-0 industrial-display-frame--setup`,
  };
}

const PARAM_LABEL_CLASS =
  "font-mono w-24 flex-shrink-0 uppercase tracking-wider truncate text-[9px] text-stealth-muted";

const LAUNCH_DOCK_LABEL_CLASS =
  "config-launch-dock__label font-mono w-11 flex-shrink-0 uppercase tracking-wider truncate text-[9px] text-stealth-muted";

/** Section headers (MEMORY MANAGEMENT, speculative decoding) — narrow column, wraps short. */
const SECTION_LABEL_CLASS =
  "config-section-label font-mono flex-shrink-0 uppercase tracking-wider text-[9px] text-stealth-muted leading-tight";

function paramChipClass(active: boolean): string {
  return `px-2 py-0.5 text-[9px] font-mono rounded-sm focus:outline-none ${
    active ? "value-chip-active" : "value-chip"
  }`;
}

function specModeBadgeClass(specType: string): string {
  const mode = specType.trim().toLowerCase().replace("draft-", "");
  if (mode === "dflash") return "config-spec-mode-badge config-spec-mode-badge--dflash";
  if (mode === "mtp") return "config-spec-mode-badge config-spec-mode-badge--mtp";
  if (mode === "eagle3") return "config-spec-mode-badge config-spec-mode-badge--eagle3";
  return "config-spec-mode-badge config-spec-mode-badge--default";
}

function isSplitModeActive(split: unknown): boolean {
  const mode = String(split ?? "none").trim();
  return mode.length > 0 && mode.toUpperCase() !== "NONE";
}

function pickBestBinaryProfile(provider: ProviderConfig | undefined): EnvProfile {
  if (!provider) return DEFAULT_BINARY_PROFILE;
  const available = ENV_ORDER.filter((p) => isProfileBuilt(provider, p));
  if (available.length === 0) return DEFAULT_BINARY_PROFILE;
  if (available.includes(DEFAULT_BINARY_PROFILE)) return DEFAULT_BINARY_PROFILE;
  return available[0];
}

const PROFILE_COLORS: Record<string, string> = {
  cyan:     "#00e5ff",
  amber:    "#FFB800",
  "nv-green": "#76B900",
};

// Group metadata derived dynamically from template — no hardcoded group names.
interface ParamGroupMeta { id: string; label: string; alwaysOpen: boolean }
function deriveParamGroups(groupKeys: string[]): ParamGroupMeta[] {
  return groupKeys.map(id => ({
    id,
    label: id.toUpperCase(),
    alwaysOpen: id === 'Core' || id === 'Performance', // Core/Performance always open by convention
  }));
}

const SPEC_DECODING_GROUP = "SPECULATIVE-DECODING";

const BASE_PORT_CHIP_TOOLTIP = "Set your starting port, we will increment from here";

function isSpecDecodingActive(params: UserEditedTemplateParam[]): boolean {
  return params
    .filter((p) => paramUiGroup(p.ui_group) === SPEC_DECODING_GROUP)
    .some((p) => !p.hidden);
}

function configFlagEnabled(config: Record<string, unknown>, key: string): boolean {
  const v = config[key];
  if (v === true || v === 1 || v === "1") return true;
  if (v === false || v === 0 || v === "0") return false;
  return String(v ?? "").trim().toLowerCase() === "true";
}

function resolveParallelSlots(
  config: Record<string, unknown>,
  params: UserEditedTemplateParam[],
): number {
  const raw = config.parallel;
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const parallelDef = params.find((p) => p.key === "parallel");
  const fallback = parallelDef?.defaultValue ?? parallelDef?.values?.[0] ?? 1;
  const n = Number(fallback);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** CTX ÷ slots — unified KV uses one pool; otherwise parallel slot count. */
function resolveCtxSlotCount(
  config: Record<string, unknown>,
  params: UserEditedTemplateParam[],
): number {
  if (configFlagEnabled(config, "unified_kv")) return 1;
  return resolveParallelSlots(config, params);
}

function specParallelConflict(
  specType: string | undefined,
  params: UserEditedTemplateParam[],
  config: Record<string, unknown>,
): boolean {
  if (!specType || !isSpecDecodingActive(params)) return false;
  if (specTypeAllowsParallel(specType)) return false;
  return resolveParallelSlots(config, params) > 1;
}

const SPEC_TYPE_BY_CAPABILITY: Record<SpecCapability, string> = {
  dflash: "draft-dflash",
  mtp: "draft-mtp",
  eagle3: "draft-eagle3",
};

function filterSpecTypeValues(
  values: (string | number)[],
  caps: SpecCapability[],
  essentialsSimpleMode?: boolean,
): (string | number)[] {
  const allowed = new Set<string>();
  for (const cap of caps) {
    if (essentialsSimpleMode && cap !== "mtp" && cap !== "dflash") continue;
    allowed.add(SPEC_TYPE_BY_CAPABILITY[cap]);
  }
  return values.filter((v) => {
    const s = String(v).toLowerCase();
    if (essentialsSimpleMode) return allowed.has(s);
    if (s.startsWith("ngram") || s === "draft-simple") return true;
    return allowed.has(s);
  });
}

function applyEssentialsSpecPreset(
  specType: string,
  updateParam: (key: string, value: string | number) => void,
): void {
  const preset = essentialsSpecPreset(specType);
  if (!preset) return;
  updateParam("spec_draft_n_max", preset.spec_draft_n_max);
  updateParam("spec_draft_n_min", preset.spec_draft_n_min);
}

function collectActiveAliases(stack: StackEntry[]): Set<string> {
  const used = new Set<string>();
  for (const s of stack) {
    if (s.status === "RUNNING" || s.status === "LOADING") {
      if (s.alias) used.add(s.alias);
    }
  }
  return used;
}

function nextEngineAlias(stack: StackEntry[]): string {
  const used = collectActiveAliases(stack);
  for (let i = 1; i <= 64; i++) {
    const candidate = `ENGINE_${i}`;
    if (!used.has(candidate)) return candidate;
  }
  return "ENGINE_1";
}

function resolveUniqueAlias(requested: string, stack: StackEntry[]): string {
  const used = collectActiveAliases(stack);
  if (!used.has(requested)) return requested;
  let suffix = 2;
  while (used.has(`${requested}_${suffix}`)) suffix++;
  return `${requested}_${suffix}`;
}

function isAutoEngineAlias(name: string): boolean {
  return /^ENGINE_\d+$/i.test(name.trim());
}

/** Commit alias field: empty or auto ENGINE_N → default naming; anything else → user custom. */
function resolveAliasCommit(
  trimmed: string,
  wasUserSet: boolean,
  autoAlias: string,
): { userSet: boolean; committed: string } {
  if (!trimmed) {
    return { userSet: false, committed: "" };
  }
  if (!wasUserSet && (trimmed === autoAlias || isAutoEngineAlias(trimmed))) {
    return { userSet: false, committed: "" };
  }
  return { userSet: true, committed: trimmed };
}

interface EngineConfigPanelProps {
  model: ModelEntry | null;
  gpus: GpuInfo[];
  providers?: ProviderConfig[];
  committedVramMib: number;
  systemInfo?: SystemInfo | null;
  stack: StackEntry[];
  onLaunch: (config: EngineConfig) => Promise<any>;
  isModelRunning?: boolean;
  activeEngineAlias?: string;
  activeEnginePort?: number;
  selectedSlotIdx?: number | null; // Slot index for Fusion overlay
  supportsFusion?: boolean;
  models?: ModelEntry[]; // Full model list for running engines panel
  onSelectEngine?: (slotIdx: number) => void; // Callback to select a running engine
  setupGuide: SetupGuideState;
}

export default function EngineConfigPanel(props: EngineConfigPanelProps) {
  const {
    model,
    gpus,
    providers: externalProviders,
    committedVramMib,
    systemInfo,
    stack,
    onLaunch,
    isModelRunning,
    activeEngineAlias,
    activeEnginePort,
    selectedSlotIdx,
    supportsFusion = true,
    models,
    onSelectEngine,
    setupGuide,
  } = props;
  const { buildProgress } = useFoundry();
  // Catalog keeps a copy of providers from App — refresh directly so profile chips match Config after Foundry builds.
  const [resolvedProviders, setResolvedProviders] = useState<ProviderConfig[]>(externalProviders ?? []);

  useEffect(() => {
    const refreshProviders = () => {
      invoke<ProviderConfig[]>("list_providers")
        .then((data) => { if (data.length > 0) setResolvedProviders(data); })
        .catch(() => {});
    };
    refreshProviders();
    window.addEventListener(EVENTS.reloadProviders, refreshProviders);
    let unlisten: (() => void) | null = null;
    listen<{ phase: string }>("foundry-progress", (e) => {
      if (e.payload.phase === "Complete") refreshProviders();
    }).then((u) => { unlisten = u; });
    return () => {
      window.removeEventListener(EVENTS.reloadProviders, refreshProviders);
      unlisten?.();
    };
  }, []);

  // ── State ───────────────────────────────────────────────────────────────

  const [userEditedParams, setUserEditedParams] = useState<UserEditedTemplateParam[]>([]);
  const [selectedProvider, setSelectedProvider] = useState<string | null>(() => {
    return readStorage(KEYS.lastProvider);
  });
  const [testFlags, setTestFlags] = useState(() => {
    return readStorage(KEYS.testFlags) || "";
  });
  const [testFlagsEnabled, setTestFlagsEnabled] = useState(() => {
    return readStorage(KEYS.testFlagsOn) === "1";
  });

  // Test flags mode: "add" (append to config) or "replace" (bypass all params)
  const [testFlagsMode, setTestFlagsMode] = useState<"add" | "replace">(() => {
    return readStorage(KEYS.testFlagsMode) === "replace" ? "replace" : "add";
  });
  const [customFlagsEditorOpen, setCustomFlagsEditorOpen] = useState(false);
  const [customFlagsDraft, setCustomFlagsDraft] = useState("");
  const [customFlagsPopoverPos, setCustomFlagsPopoverPos] = useState({
    top: 0,
    left: 0,
    right: 0,
    width: 0,
    placement: "above" as "above" | "below" | "rail-left",
    maxHeight: 140,
  });
  const customFlagsAnchorRef = useRef<HTMLDivElement>(null);
  const customFlagsPopoverRef = useRef<HTMLDivElement>(null);
  const [replaceLaunchConfirmOpen, setReplaceLaunchConfirmOpen] = useState(false);

  const [aliasInput, setAliasInput] = useState<string>("");
  const [aliasIsUserSet, setAliasIsUserSet] = useState(false);
  const [aliasFocused, setAliasFocused] = useState(false);
  const aliasInitializedRef = useRef<{ modelPath: string; done: boolean }>({ modelPath: "", done: false });
  const lastLaunchAtRef = useRef(0);
  const autoSplitPromotedRef = useRef(false);
  const [launchAck, setLaunchAck] = useState(false);
  const launchAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedBinaryProfile, setSelectedBinaryProfile] = useState<EnvProfile>(DEFAULT_BINARY_PROFILE);

  // NVIDIA driver version for profile compatibility indicators (fetched once)
  const [driverVersion, setDriverVersion] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const v = await invoke<string | null>("get_nvidia_driver_version");
        if (mounted) setDriverVersion(v ?? null);
      } catch {
        if (mounted) setDriverVersion(null);
      }
    })();
    return () => { mounted = false; };
  }, []);

  const [specFlash, setSpecFlash] = useState(false);
  const [fitLaunchEnabled, setFitLaunchEnabled] = useState(true);
  const [configView, setConfigView] = useState<ConfigViewMode>("essentials");
  const [codingMode, setCodingMode] = useState<CodingModeId>("solo");
  const [speedBoost, setSpeedBoost] = useState<SpeedBoostId>("off");
  const [brains, setBrains] = useState<BrainsId>("solid");
  const [think, setThink] = useState<ThinkId>("on");
  const boosterSeededRef = useRef(false);
  const [layoutModeActive, setLayoutModeActive] = useState(
    () => readStorage(KEYS.configLayoutMode) === "1",
  );
  const [uiDensityCompact, setUiDensityCompact] = useState(
    () => loadUiDensity() === "compact",
  );
  const [launchDockPosition, setLaunchDockPosition] = useState<LaunchDockPosition>(loadLaunchDockPosition);
  const [launchDockPositionExplicit, setLaunchDockPositionExplicit] = useState(loadLaunchDockPositionExplicit);
  const [launchDockCollapsed, setLaunchDockCollapsed] = useState(loadLaunchDockCollapsed);
  const [hwMonitorOpen, setHwMonitorOpen] = useState(loadHwMonitorOpen);
  const [enginesInRail, setEnginesInRail] = useState(loadEnginesInRail);
  const showLaunchRail = launchDockPosition === "right";
  const showRightColumn = hwMonitorOpen || showLaunchRail;
  const showEnginesBelowVram = !(enginesInRail && showLaunchRail);
  const hasRunningEnginesForEject = useMemo(
    () => stack.some((s) => s.status === "RUNNING" || s.status === "LOADING"),
    [stack],
  );
  const showEjectBelowVram =
    showEnginesBelowVram && hasRunningEnginesForEject && onSelectEngine != null && models != null;
  const {
    containerRef: launchDockMainRef,
    railWidth: launchRailWidth,
    isDragging: launchRailDragging,
    startDrag: startLaunchRailDrag,
    resetWidth: resetLaunchRailWidth,
  } = useLaunchDockRailResize(showRightColumn);
  const launchRailTopChromeMeasureRef = useRef<HTMLDivElement>(null);
  const launchRailDisplayMeasureRef = useRef<HTMLDivElement>(null);
  const [launchRailUpperPadHeight, setLaunchRailUpperPadHeight] = useState(0);
  const [launchRailDisplayHeight, setLaunchRailDisplayHeight] = useState(0);

  const toggleHwMonitor = useCallback(() => {
    const next = !hwMonitorOpen;
    setHwMonitorOpen(next);
    saveHwMonitorOpen(next);
    dispatchAppEvent(EVENTS.hwMonitorOpenChanged, { open: next });
  }, [hwMonitorOpen]);

  const toggleEnginesInRail = useCallback(() => {
    const next = !enginesInRail;
    setEnginesInRail(next);
    saveEnginesInRail(next);
  }, [enginesInRail]);

  const { texture: displayTexture } = useDisplayTexture();

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const saved = readStorage(KEYS.collapsedGroups);
      if (saved) return new Set(JSON.parse(saved));
    } catch {}
    // Fresh install: only tuck away ADVANCED; FEATURE-FLAGS stays expanded (no LS entry yet).
    return new Set(["ADVANCED"]);
  });

  const toggleLayoutMode = useCallback(() => {
    setLayoutModeActive((prev) => {
      const next = !prev;
      writeStorage(KEYS.configLayoutMode, next ? "1" : "0");
      return next;
    });
  }, []);

  const setLaunchDockPositionUser = useCallback((position: LaunchDockPosition) => {
    setLaunchDockPosition(position);
    setLaunchDockPositionExplicit(true);
    saveLaunchDockPosition(position, true);
    if (position === "right") {
      setLaunchDockCollapsed(false);
      saveLaunchDockCollapsed(false);
    }
  }, []);

  const toggleLaunchDockCollapsed = useCallback(() => {
    setLaunchDockCollapsed((prev) => {
      const next = !prev;
      saveLaunchDockCollapsed(next);
      return next;
    });
  }, []);

  // Default dock is bottom (right rail closed). Only an explicit user choice
  // (BOTTOM / RIGHT chips) changes placement — no viewport-height auto-flip.

  const toggleGroup = useCallback((groupId: string) => {
    setCollapsedGroups(prev => {
      const next = new Set(prev);
      if (next.has(groupId)) next.delete(groupId); else next.add(groupId);
      writeJsonStorage(KEYS.collapsedGroups, [...next]);
      return next;
    });
  }, []);

  // Persist test flags
  useEffect(() => {
    writeStorage(KEYS.testFlags, testFlags);
  }, [testFlags]);
  useEffect(() => {
    writeStorage(KEYS.testFlagsOn, testFlagsEnabled ? "1" : "0");
  }, [testFlagsEnabled]);

  // Persist test flags mode
  useEffect(() => {
    writeStorage(KEYS.testFlagsMode, testFlagsMode);
  }, [testFlagsMode]);

  useEffect(() => {
    const shell = document.querySelector(".app-shell");
    if (!shell) return;
    const sync = () => setUiDensityCompact(shell.getAttribute("data-ui-density") === "compact");
    sync();
    const observer = new MutationObserver(sync);
    observer.observe(shell, { attributes: true, attributeFilter: ["data-ui-density"] });
    return () => observer.disconnect();
  }, []);

  // Auto-populate alias when model changes — per-model persistence
  useEffect(() => {
    if (!model) return;
    const key = engineAliasKey(model.path);
    const initKey = aliasInitializedRef.current.modelPath;

    // Only initialize once per model path to avoid overwriting user input on HMR
    if (initKey !== model.path) {
      try {
        const saved = readStorage(key);
        if (saved) {
          setAliasInput(saved);
          setAliasIsUserSet(true);
        } else {
          setAliasIsUserSet(false);
        }
      } catch {
        setAliasIsUserSet(false);
      }
      aliasInitializedRef.current = { modelPath: model.path, done: true };
    }
  }, [model?.path]);

  const autoAlias = useMemo(() => nextEngineAlias(stack), [stack]);

  const aliasDisplayValue = aliasFocused
    ? aliasInput
    : aliasIsUserSet
      ? aliasInput
      : autoAlias;

  const aliasShowClr = useMemo(() => {
    if (aliasIsUserSet) return true;
    if (!aliasFocused) return false;
    return resolveAliasCommit(aliasInput.trim(), false, autoAlias).userSet;
  }, [aliasIsUserSet, aliasFocused, aliasInput, autoAlias]);

  const clearPersistedAlias = useCallback((modelPath: string) => {
    try {
      removeStorage(engineAliasKey(modelPath));
    } catch {}
  }, []);

  const persistAliasForModel = useCallback((modelPath: string, aliasValue: string) => {
    try {
      const trimmed = aliasValue.trim();
      if (trimmed) {
        writeStorage(engineAliasKey(modelPath), trimmed);
      } else {
        removeStorage(engineAliasKey(modelPath));
      }
    } catch {}
  }, []);

  const commitAliasField = useCallback(() => {
    const { userSet, committed } = resolveAliasCommit(aliasInput.trim(), aliasIsUserSet, autoAlias);
    if (!userSet) {
      setAliasIsUserSet(false);
      if (model) clearPersistedAlias(model.path);
    } else {
      setAliasIsUserSet(true);
      setAliasInput(committed);
    }
    return { userSet, committed };
  }, [aliasInput, aliasIsUserSet, autoAlias, model, clearPersistedAlias]);

  const handleAliasFocus = useCallback((e: React.FocusEvent<HTMLInputElement>) => {
    setAliasFocused(true);
    if (!aliasIsUserSet) {
      setAliasInput(autoAlias);
    }
    requestAnimationFrame(() => e.currentTarget.select());
  }, [aliasIsUserSet, autoAlias]);

  const handleAliasBlur = useCallback(() => {
    setAliasFocused(false);
    commitAliasField();
  }, [commitAliasField]);

  const handleAliasClear = useCallback(() => {
    setAliasIsUserSet(false);
    setAliasFocused(false);
    setAliasInput("");
    if (model) clearPersistedAlias(model.path);
  }, [model, clearPersistedAlias]);

  // Auto-select default provider when providers load (runs once on mount)
  const providerInitDone = useRef(false);
  useEffect(() => {
    if (providerInitDone.current || !resolvedProviders?.length) return;
    providerInitDone.current = true;

    const enabled = resolvedProviders.filter(p => p.enabled);
    if (enabled.length === 0) return;

    // Prefer saved localStorage choice, validate it exists, else default to ggml-master or first available
    let target: string | null = null;
    target = readStorage(KEYS.lastProvider);

    if (!target || !enabled.some(p => p.id === target)) {
      const def = enabled.find(p => p.id === DEFAULT_PROVIDER_ID);
      target = def?.id || enabled[0].id;
    }

    setSelectedProvider(target);
  }, [resolvedProviders]);

  // ── Derived state ───────────────────────────────────────────────────────────
  const effectiveBackendType = useMemo(() => {
    if (!model) return selectedProvider || DEFAULT_PROVIDER_ID;
    return selectedProvider || (model.backend_type || DEFAULT_PROVIDER_ID);
  }, [model, selectedProvider]);

  const currentProvider = useMemo(
    () => resolvedProviders?.find((p) => p.id === effectiveBackendType),
    [resolvedProviders, effectiveBackendType],
  );
  const launchProfile = currentProvider?.launchProfile;
  const fitLaunchSupported = providerSupportsFitLaunch(launchProfile);
  const fullAutoMode = fitLaunchSupported && fitLaunchEnabled;
  /** FULL-AUTO + Essentials — MTP/DFLASH only, presets, auto-enable when capable. */
  const specSimpleMode = fullAutoMode && configView === "essentials";
  const tensorSplitSupported = launchProfile?.tensorSplit !== false;
  const essentialFactoryKeys = useMemo(
    () => resolveEssentialParamKeys(launchProfile),
    [launchProfile],
  );
  useEffect(() => {
    if (!fitLaunchSupported) {
      setFitLaunchEnabled(false);
      return;
    }
    setFitLaunchEnabled(loadAutoVramEnabled(effectiveBackendType, launchProfile?.autoVram ?? true));
  }, [effectiveBackendType, fitLaunchSupported, launchProfile?.autoVram]);

  useEffect(() => {
    setConfigView(loadConfigView(effectiveBackendType, "essentials"));
  }, [effectiveBackendType]);

  const isProfileBuilding = useCallback((profile: EnvProfile): boolean => {
    if (!buildProgress) return false;
    const step = buildProgress.step;
    if (step === "complete" || step === "error") return false;
    return buildProgress.providerId === effectiveBackendType
      && buildProgress.environment.toLowerCase() === profile;
  }, [buildProgress, effectiveBackendType]);

  const selectedProfileIsBuilding = isProfileBuilding(selectedBinaryProfile);

  // Per-provider binary profile — re-resolve when provider or available builds change
  useEffect(() => {
    if (!effectiveBackendType) return;
    const provider = resolvedProviders?.find((p) => p.id === effectiveBackendType);
    const built: EnvProfile[] = ENV_ORDER.filter((env) => isProfileBuilt(provider, env));
    try {
      const saved = normalizeBinaryProfile(readStorage(binaryProfileKey(effectiveBackendType)));
      if (built.includes(saved)) {
        setSelectedBinaryProfile(saved);
        return;
      }
    } catch { /* ignore */ }
    setSelectedBinaryProfile(pickBestBinaryProfile(provider));
  }, [effectiveBackendType, resolvedProviders]);

  useEffect(() => {
    if (!effectiveBackendType) return;
    writeStorage(binaryProfileKey(effectiveBackendType), selectedBinaryProfile);
  }, [selectedBinaryProfile, effectiveBackendType]);

  // Dynamic Device param — generated from GPU topology, docked to runtime block
  const deviceParam: UserEditedTemplateParam | null = useMemo(() => {
    if (gpus.length === 0) return null;
    const alreadyExists = userEditedParams.some(d => d.key === "device");
    if (alreadyExists) return null;
    return {
      key: "device",
      label: "DEVICE",
      flag: null,
      ptype: "arg_select" as const,
      values: gpus.map((_, i) => `GPU-${i}`),
      order: -1,
      hidden: false,
      defaultValue: "GPU-0",
      ui_group: "MULTI-GPU",
      note: "Select which GPU to use for inference.",
    };
  }, [gpus.length, userEditedParams]);

  const allParamsResolved = useMemo(() => {
    const defs = deviceParam ? [deviceParam, ...userEditedParams] : [...userEditedParams];
    const gpuValues = gpus.map((_, i) => `GPU-${i}`);
    return defs
      .map((d) => {
        if (d.key === "mmap") {
          return { ...d, dock: undefined, ui_group: "FEATURE-FLAGS" };
        }
        if (d.key !== "device" || gpus.length === 0) return d;
        const defaultStr = String(d.defaultValue);
        return {
          ...d,
          values: gpuValues,
          defaultValue: gpuValues.includes(defaultStr) ? d.defaultValue : "GPU-0",
        };
      })
      .sort((a, b) => a.order - b.order);
  }, [userEditedParams, deviceParam, gpus]);

  const specDecodingGroupVisible = useMemo(
    () => isSpecDecodingActive(allParamsResolved),
    [allParamsResolved],
  );

  /** Full Auto = one fixed cockpit (no Essentials/Full switch). */
  const fullAutoFixed = fullAutoMode;

  const allParamsForDisplay = useMemo(() => {
    if (fullAutoFixed) return [];
    if (configView === "full") return allParamsResolved;
    return allParamsResolved.filter((d) => isEssentialParam(d, essentialFactoryKeys));
  }, [allParamsResolved, configView, essentialFactoryKeys, fullAutoFixed]);

  const splitParamDef = useMemo(
    () => allParamsResolved.find((d) => d.key === "split"),
    [allParamsResolved],
  );

  const basePortParamDef = useMemo(
    () => allParamsResolved.find((d) => d.key === "base_port"),
    [allParamsResolved],
  );

  // ── Hooks ────────────────────────────────────────────────────────────────
  const { config, updateParam } = useConfigResolver({
    model,
    userEditedParams: allParamsResolved,
    backendType: effectiveBackendType,
  });

  const runningSlotsForPlan = useMemo(
    () => committedSlotsFromStack(stack),
    [stack],
  );

  const gpuIdleBaselineMib = useGpuIdleBaseline(gpus, stack);

  const scenarioConfig = useMemo(
    () => ({
      ...config,
      backend_type: effectiveBackendType,
      ...(fullAutoMode ? { split: "none", offload_mode: "regular" } : {}),
    }),
    [config, effectiveBackendType, fullAutoMode],
  );

  // Display value — manufactured capacity, no deductions (what users see)
  const displayVramMib = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);

 const vramCalc = useScenarioEvaluator({
    model,
    config: scenarioConfig,
    gpus,
    stack,
    systemInfo,
    autoVramLaunch: fitLaunchSupported,
    fullAutoMode,
    fitStyle: launchProfile?.fitStyle ?? "",
  });

  const splitModeActive = isSplitModeActive(config.split);

  const launchChrome = useMemo(
    () => resolveLaunchChromePolicy({
      fullAutoMode,
      gpus,
      config,
      manifest: vramCalc.manifest,
      weightGb: (model?.metadata?.file_size_bytes ?? 0) / (1024 ** 3),
      runningSlots: runningSlotsForPlan,
    }),
    [fullAutoMode, gpus, config, vramCalc.manifest, model?.metadata?.file_size_bytes, runningSlotsForPlan],
  );

  useEffect(() => {
    if (!fullAutoMode) return;
    if (String(config["offload_mode"] ?? "regular").toLowerCase() === "moe_optimal") {
      updateParam("offload_mode", "regular");
    }
  }, [fullAutoMode, config["offload_mode"], updateParam]);

  useEffect(() => {
    if (fullAutoMode) return;
    const split = String(config.split ?? "none").trim().toLowerCase();
    if (launchChrome.hideSplitNone) {
      if (split === "none" || split === "") {
        autoSplitPromotedRef.current = true;
        updateParam("split", "layer");
      }
      return;
    }
    if (autoSplitPromotedRef.current && split === "layer") {
      autoSplitPromotedRef.current = false;
      updateParam("split", "none");
    }
  }, [fullAutoMode, launchChrome.hideSplitNone, config.split, updateParam]);

  const showChromeHints = useMemo(
    () => !fullAutoMode && !stack.some((s) => s.status === "LOADING"),
    [fullAutoMode, stack],
  );

  const activeSpecType = config.spec_type != null ? String(config.spec_type) : undefined;

  const specParallelWarn = useMemo(
    () => specParallelConflict(activeSpecType, allParamsResolved, config),
    [activeSpecType, allParamsResolved, config],
  );
  const mtpParallelSlotCount = useMemo(
    () => resolveParallelSlots(config, allParamsResolved),
    [config, allParamsResolved],
  );

  const specCapabilities = useMemo(
    () => (model && models?.length ? specCapabilitiesForMain(model, models, effectiveBackendType) : []),
    [model, models, effectiveBackendType],
  );
  const hasSpecCapability = specCapabilities.length > 0;
  const specActive = useMemo(
    () => hasSpecCapability && specDecodingGroupVisible,
    [hasSpecCapability, specDecodingGroupVisible],
  );

  // Seed cockpit once from live config.
  useEffect(() => {
    if (boosterSeededRef.current) return;
    if (!allParamsResolved.length) return;
    const par = resolveParallelSlots(config, allParamsResolved);
    setCodingMode(codingModeFromParallel(par));
    setBrains(brainsFromKvQuant(config.kv_quant != null ? String(config.kv_quant) : undefined));
    const st = config.spec_type != null ? String(config.spec_type).toLowerCase() : "";
    if (specDecodingGroupVisible && st.includes("mtp")) setSpeedBoost("mtp");
    else if (specDecodingGroupVisible && st.includes("dflash")) setSpeedBoost("dflash");
    else setSpeedBoost("off");
    const r = config.reasoning;
    if (r === "off" || r === 0 || r === "0") setThink("off");
    else if (r === 4000 || r === "4000") setThink("budget");
    else setThink("on");
    boosterSeededRef.current = true;
  }, [allParamsResolved, config, specDecodingGroupVisible]);

  useEffect(() => {
    boosterSeededRef.current = false;
  }, [effectiveBackendType, model?.path]);

  // Do NOT write collapsedGroups LS from Full Auto — Assisted collapse state is user-owned.

  const kvQuantValues = useMemo(() => {
    const def = allParamsResolved.find((p) => p.key === "kv_quant");
    return def?.values ?? ["q4_0", "q8_0", "f16"];
  }, [allParamsResolved]);

  /** Any family-matched DFlash draft in library (independent of current mode). */
  const dflashLibraryReady = useMemo(() => {
    if (!model || !models?.length) return false;
    return findScoredDraftCandidates(model, models, "external_dflash").length > 0;
  }, [model, models]);

  const applyFullAutoCockpit = useCallback(
    async (
      mode: CodingModeId,
      speed: SpeedBoostId,
      brainsPick: BrainsId,
      thinkPick: ThinkId,
    ) => {
      setCodingMode(mode);
      setSpeedBoost(speed);
      setBrains(brainsPick);
      setThink(thinkPick);

      const plan = resolveFullAutoPlan({
        codingMode: mode,
        speed,
        brains: brainsPick,
        think: thinkPick,
        capabilities: specCapabilities,
        dflashLibraryReady,
        kvQuantValues,
      });

      if (plan.forcedSoloForMtp) setCodingMode("solo");
      if (plan.speed !== speed) setSpeedBoost(plan.speed);

      updateParam("parallel", plan.parallel);
      if (plan.parallel > 1 && allParamsResolved.some((p) => p.key === "cont_batching")) {
        updateParam("cont_batching", "on");
      }
      updateParam("kv_quant", plan.kvQuant);
      if (plan.vision && allParamsResolved.some((p) => p.key === "vision")) {
        updateParam("vision", plan.vision);
      }
      if (plan.reasoning != null && allParamsResolved.some((p) => p.key === "reasoning")) {
        updateParam("reasoning", plan.reasoning);
      }
      if (
        plan.reasoningPreserve
        && allParamsResolved.some((p) => p.key === "reasoning_preserve")
      ) {
        updateParam("reasoning_preserve", plan.reasoningPreserve);
      }

      if (plan.pushBatch) {
        const batchDef = allParamsResolved.find((p) => p.key === "batch");
        const ubatchDef = allParamsResolved.find((p) => p.key === "ubatch");
        const batchPick = batchDef?.values ? pickHighNumeric(batchDef.values) : null;
        const ubatchPick = ubatchDef?.values
          ? pickHighNumeric(ubatchDef.values, batchPick ?? undefined)
          : null;
        if (batchPick != null) updateParam("batch", batchPick);
        if (ubatchPick != null) updateParam("ubatch", ubatchPick);
      }

      const wantSpec = plan.enableSpec;
      const currentlyOn = specDecodingGroupVisible;
      if (wantSpec !== currentlyOn && (hasSpecCapability || !wantSpec)) {
        try {
          await invoke<boolean>("toggle_group_hidden", {
            providerId: effectiveBackendType,
            groupId: SPEC_DECODING_GROUP,
          });
          setSpecFlash(true);
          window.setTimeout(() => setSpecFlash(false), 400);
          try {
            const data = await invoke<ProviderConfig[]>("list_providers");
            if (data.length > 0) setResolvedProviders(data);
          } catch { /* event */ }
          dispatchAppEvent(EVENTS.reloadProviders);
          dispatchAppEvent(EVENTS.paramConfigChanged);
        } catch (err) {
          console.error("[fullAuto] toggle_group_hidden failed:", err);
        }
      }

      if (wantSpec && plan.specType) {
        updateParam("spec_type", plan.specType);
        const preset = essentialsSpecPreset(plan.specType);
        if (preset) {
          updateParam("spec_draft_n_max", preset.spec_draft_n_max);
          updateParam("spec_draft_n_min", preset.spec_draft_n_min);
        }
        if (model && models?.length) {
          const role = draftRoleForSpecType(plan.specType);
          if (role) {
            const draftPair = pickBestDraftPair(model, models, role);
            if (draftPair) {
              updateParam("spec_draft_model", draftPair.path);
              saveDraftPairing(model.path, plan.specType, draftPair.path);
            }
          }
        }
      }
    },
    [
      allParamsResolved,
      dflashLibraryReady,
      effectiveBackendType,
      hasSpecCapability,
      kvQuantValues,
      model,
      models,
      specCapabilities,
      specDecodingGroupVisible,
      updateParam,
    ],
  );

  /** Assisted mode: agents-only strip (no full cockpit). */
  const applyCodingAgents = useCallback(
    (mode: CodingModeId) => {
      void applyFullAutoCockpit(mode, speedBoost, brains, think);
    },
    [applyFullAutoCockpit, speedBoost, brains, think],
  );
  const specLaunchActive = useMemo(() => {
    if (!model || !models?.length) return false;
    return resolveSpecLaunchActive({
      groupActive: specDecodingGroupVisible,
      hasCapability: hasSpecCapability,
      specType: activeSpecType,
      model,
      models,
      providerId: effectiveBackendType,
    });
  }, [
    model,
    models,
    specDecodingGroupVisible,
    hasSpecCapability,
    activeSpecType,
    effectiveBackendType,
  ]);
  const modelIsDraftOnly = model ? isExternalDraftOnly(model) : false;

  const activeDraftRole: DraftRole | null = useMemo(() => {
    if (!activeSpecType) return null;
    return draftRoleForSpecType(activeSpecType);
  }, [activeSpecType]);

  const scoredDraftCandidates = useMemo((): ScoredDraft[] => {
    if (!model || !models?.length || !activeDraftRole) return [];
    return findScoredDraftCandidates(model, models, activeDraftRole);
  }, [model, models, activeDraftRole]);

  const [showAllDrafts, setShowAllDrafts] = useState(false);

  useEffect(() => {
    setShowAllDrafts(false);
  }, [model?.path, activeDraftRole]);

  const specNeedsExternalDraft = Boolean(
    activeSpecType && specTypeNeedsExternalDraft(activeSpecType) && specLaunchActive,
  );

  const currentDraftPath = config.spec_draft_model != null ? String(config.spec_draft_model) : "";
  const draftPathValid =
    !specNeedsExternalDraft
    || isValidGgufDraftPath(currentDraftPath);

  // Legacy template stored auto/on — resolve to picker selection.
  useEffect(() => {
    if (!specNeedsExternalDraft || !model) return;
    const cur = currentDraftPath.trim().toLowerCase();
    if (cur !== "auto" && cur !== "on") return;
    const best = scoredDraftCandidates[0]?.model;
    if (!best) return;
    updateParam("spec_draft_model", best.path);
    if (activeSpecType) {
      saveDraftPairing(model.path, activeSpecType, best.path);
    }
  }, [
    specNeedsExternalDraft,
    model,
    currentDraftPath,
    scoredDraftCandidates,
    activeSpecType,
    updateParam,
  ]);

  const specAutoConfiguredRef = useRef<string | null>(null);
  const specSimpleBootRef = useRef<string | null>(null);
  const specGroupAutoHideRef = useRef<string | null>(null);

  useEffect(() => {
    migrateGlobalSpecOutOfCatalogOverrides(effectiveBackendType);
  }, [effectiveBackendType]);

  useEffect(() => {
    if (!model) return;
    if (specLaunchActive) return;
    if (!loadModelSpecOverride(model.path)) return;
    clearModelSpecOverride(model.path);
    dispatchAppEvent(EVENTS.paramConfigChanged);
  }, [model?.path, specLaunchActive]);

  useEffect(() => {
    if (!model || hasSpecCapability || !specDecodingGroupVisible) return;
    const pathKey = normalizeModelPathKey(model.path);
    if (specGroupAutoHideRef.current === pathKey) return;
    specGroupAutoHideRef.current = pathKey;

    invoke<boolean>("toggle_group_hidden", { providerId: effectiveBackendType, groupId: SPEC_DECODING_GROUP })
      .then(async () => {
        setSpecFlash(true);
        setTimeout(() => setSpecFlash(false), 400);
        try {
          const data = await invoke<ProviderConfig[]>("list_providers");
          if (data.length > 0) setResolvedProviders(data);
        } catch { /* reloadProviders event is fallback */ }
        dispatchAppEvent(EVENTS.reloadProviders);
        dispatchAppEvent(EVENTS.paramConfigChanged);
      })
      .catch((err) => console.error("[specGroupAutoHide] toggle_group_hidden failed:", err));
  }, [model, hasSpecCapability, specDecodingGroupVisible, effectiveBackendType]);

  useEffect(() => {
    if (!model || !models?.length || modelIsDraftOnly) return;
    if (!specDecodingGroupVisible || !hasSpecCapability) return;

    const currentType = config.spec_type != null ? String(config.spec_type).trim() : "";
    if (!currentType || currentType.toLowerCase() === "none") return;
    if (isSpecTypeValidForMain(currentType, model, models, effectiveBackendType)) return;

    const replacement = defaultSpecTypeForMain(model, models, effectiveBackendType);
    if (!replacement) return;

    updateParam("spec_type", replacement);
    const preset = specSimpleMode ? essentialsSpecPreset(replacement) : null;
    if (preset) {
      updateParam("spec_draft_n_max", preset.spec_draft_n_max);
      updateParam("spec_draft_n_min", preset.spec_draft_n_min);
    }
    const role = draftRoleForSpecType(replacement);
    if (role) {
      const draft = pickBestDraftPair(model, models, role);
      if (draft) updateParam("spec_draft_model", draft.path);
    }
  }, [
    model,
    models,
    modelIsDraftOnly,
    specDecodingGroupVisible,
    hasSpecCapability,
    config.spec_type,
    effectiveBackendType,
    specSimpleMode,
    updateParam,
  ]);

  useEffect(() => {
    if (!specSimpleMode || !model || !hasSpecCapability || specActive) return;
    if (loadModelSpecOverride(model.path)?.spec_type) return;

    const pathKey = normalizeModelPathKey(model.path);
    if (specSimpleBootRef.current === pathKey) return;
    specSimpleBootRef.current = pathKey;

    invoke<boolean>("toggle_group_hidden", { providerId: effectiveBackendType, groupId: SPEC_DECODING_GROUP })
      .then(async () => {
        setSpecFlash(true);
        setTimeout(() => setSpecFlash(false), 400);
        try {
          const data = await invoke<ProviderConfig[]>("list_providers");
          if (data.length > 0) setResolvedProviders(data);
        } catch { /* reloadProviders event is fallback */ }
        dispatchAppEvent(EVENTS.reloadProviders);
        dispatchAppEvent(EVENTS.paramConfigChanged);
      })
      .catch((err) => console.error("[specSimpleBoot] toggle_group_hidden failed:", err));
  }, [specSimpleMode, model, hasSpecCapability, specActive, effectiveBackendType]);

  useEffect(() => {
    if (!specSimpleMode || !specActive || !activeSpecType) return;
    const preset = essentialsSpecPreset(activeSpecType);
    if (!preset) return;
    const max = Number(config.spec_draft_n_max);
    const min = Number(config.spec_draft_n_min);
    if (max !== preset.spec_draft_n_max) updateParam("spec_draft_n_max", preset.spec_draft_n_max);
    if (min !== preset.spec_draft_n_min) updateParam("spec_draft_n_min", preset.spec_draft_n_min);
  }, [
    specSimpleMode,
    specActive,
    activeSpecType,
    config.spec_draft_n_max,
    config.spec_draft_n_min,
    updateParam,
  ]);

  useEffect(() => {
    if (!model || !models?.length || modelIsDraftOnly) return;
    const pathKey = normalizeModelPathKey(model.path);
    if (specAutoConfiguredRef.current === pathKey) return;

    const savedOverride = loadModelSpecOverride(model.path);
    if (
      savedOverride?.spec_type
      && isSpecTypeValidForMain(String(savedOverride.spec_type), model, models, effectiveBackendType)
    ) {
      specAutoConfiguredRef.current = pathKey;
      return;
    }

    const applyPrefill = (specType: string, draftPath?: string) => {
      const patch: Record<string, string | number> = { spec_type: specType };
      if (draftPath) patch.spec_draft_model = draftPath;
      const preset = specSimpleMode ? essentialsSpecPreset(specType) : null;
      if (preset) {
        patch.spec_draft_n_max = preset.spec_draft_n_max;
        patch.spec_draft_n_min = preset.spec_draft_n_min;
      } else if (specType === "draft-dflash") {
        patch.spec_draft_n_max = 4;
      }
      saveModelSpecOverride(model.path, patch);
      if (draftPath) saveDraftPairing(model.path, specType, draftPath);
      dispatchAppEvent(EVENTS.paramConfigChanged);
    };

    const saved = loadDraftPairing(model.path);
    if (saved && isDraftPairingValid(saved, model, models)) {
      applyPrefill(saved.specType, saved.draftPath);
      specAutoConfiguredRef.current = pathKey;
      return;
    }

    const defaultType = defaultSpecTypeForMain(model, models, effectiveBackendType);
    if (defaultType === "draft-dflash") {
      const draft = pickBestDraftPair(model, models, "external_dflash");
      if (draft) applyPrefill("draft-dflash", draft.path);
    } else if (defaultType === "draft-mtp") {
      applyPrefill("draft-mtp");
    }

    specAutoConfiguredRef.current = pathKey;
  }, [model, models, effectiveBackendType, modelIsDraftOnly, specSimpleMode]);

  const customFlagsReplaceActive = testFlagsEnabled && testFlagsMode === "replace";
  const customFlagsLaunchActive = testFlagsEnabled;
  const paramsBypassedClass = customFlagsReplaceActive ? " config-panel-params--bypassed" : "";

  useEffect(() => {
    if (!customFlagsReplaceActive) {
      setReplaceLaunchConfirmOpen(false);
    }
  }, [customFlagsReplaceActive]);

  const closeCustomFlagsEditor = useCallback((save: boolean) => {
    if (save) {
      setTestFlags(customFlagsDraft);
    }
    setCustomFlagsEditorOpen(false);
  }, [customFlagsDraft]);

  const openCustomFlagsEditor = useCallback(() => {
    if (customFlagsEditorOpen) return;
    setCustomFlagsDraft(testFlags);
    setCustomFlagsEditorOpen(true);
  }, [testFlags, customFlagsEditorOpen]);

  const updateCustomFlagsPopoverPos = useCallback(() => {
    const anchor = customFlagsAnchorRef.current;
    if (!anchor) return;
    const rect = anchor.getBoundingClientRect();
    const inRailFlags = anchor.closest(".config-launch-dock__rail-flags") != null;
    const dockRight =
      anchor.closest("[data-config-panel]")?.getAttribute("data-launch-dock-position") === "right";

    if (inRailFlags || dockRight) {
      const panel = anchor.closest("[data-config-panel]");
      const workspace = panel?.querySelector(".config-rail-workspace");
      const leftCol = workspace?.querySelector(".config-rail-left");
      const rail = anchor.closest(".config-launch-rail");
      const leftRect = leftCol?.getBoundingClientRect();
      const railRect = rail?.getBoundingClientRect();
      const inset = 10;
      const spanLeft = (leftRect?.left ?? rect.left) + inset;
      const spanRight = (railRect?.left ?? rect.left) - inset;

      setCustomFlagsPopoverPos({
        top: rect.top,
        left: spanLeft,
        right: Math.max(inset, window.innerWidth - spanRight),
        width: Math.max(280, spanRight - spanLeft),
        placement: "rail-left",
        maxHeight: 88,
      });
      return;
    }

    setCustomFlagsPopoverPos({
      top: rect.top,
      left: rect.left,
      right: 0,
      width: rect.width,
      placement: "above",
      maxHeight: 140,
    });
  }, []);

  useLayoutEffect(() => {
    if (!customFlagsEditorOpen) return;
    updateCustomFlagsPopoverPos();
    const raf = requestAnimationFrame(updateCustomFlagsPopoverPos);
    return () => cancelAnimationFrame(raf);
  }, [customFlagsEditorOpen, updateCustomFlagsPopoverPos, launchDockPosition]);

  useEffect(() => {
    if (!customFlagsEditorOpen) return;
    const onResize = () => updateCustomFlagsPopoverPos();
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onResize, true);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onResize, true);
    };
  }, [customFlagsEditorOpen, updateCustomFlagsPopoverPos]);

  useEffect(() => {
    if (!customFlagsEditorOpen) return;
    const onPointerDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (customFlagsAnchorRef.current?.contains(target)) return;
      if (customFlagsPopoverRef.current?.contains(target)) return;
      closeCustomFlagsEditor(true);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeCustomFlagsEditor(true);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [customFlagsEditorOpen, closeCustomFlagsEditor]);

  const renderCustomFlagsBlock = useCallback(() => {
    if (configView !== "full") return null;
    const blockClass = customFlagsReplaceActive
      ? "custom-flags-replace"
      : testFlagsEnabled
        ? "custom-flags-active"
        : "";
    const popoverPlacementBelow = customFlagsPopoverPos.placement === "below";
    const popoverRailLeft = customFlagsPopoverPos.placement === "rail-left";
    const popover = customFlagsEditorOpen
      ? createPortal(
          <div
            ref={customFlagsPopoverRef}
            className={`custom-flags-popover border rounded-sm${
              popoverPlacementBelow ? " custom-flags-popover--below" : ""
            }${popoverRailLeft ? " custom-flags-popover--rail-left" : ""}${
              customFlagsReplaceActive
                ? " custom-flags-popover--replace"
                : " custom-flags-popover--append"
            }`}
            style={
              popoverRailLeft
                ? {
                    top: customFlagsPopoverPos.top,
                    left: customFlagsPopoverPos.left,
                    right: customFlagsPopoverPos.right,
                    width: "auto",
                  }
                : {
                    top: customFlagsPopoverPos.top,
                    left: customFlagsPopoverPos.left,
                    width: customFlagsPopoverPos.width,
                  }
            }
            role="dialog"
            aria-label="Edit custom flags"
          >
            <textarea
              rows={popoverPlacementBelow ? 10 : 3}
              value={customFlagsDraft}
              onChange={(e) => setCustomFlagsDraft(e.target.value)}
              autoFocus
              placeholder="-m model.gguf --split-mode layer -c 32768 ..."
              className="custom-flags-popover__input w-full border font-mono px-2 py-1.5 leading-snug focus:outline-none rounded-sm"
              style={{ maxHeight: customFlagsPopoverPos.maxHeight }}
            />
            <p className="custom-flags-popover__hint font-mono uppercase tracking-wide mt-1 opacity-70">
              Click outside to save
            </p>
          </div>,
          document.body,
        )
      : null;

    return (
      <>
        <div ref={customFlagsAnchorRef} className="custom-flags-anchor relative">
          <div className={`custom-flags-block border rounded-sm overflow-hidden ${blockClass}`}>
            <div className="custom-flags-body px-2 py-1 flex items-center gap-1.5 min-h-0">
              <span className="text-[8px] font-mono uppercase tracking-wider shrink-0 custom-flags-label">
                CUSTOM FLAGS
              </span>
              {testFlagsEnabled && (
                <input
                  type="text"
                  readOnly
                  value={testFlags}
                  onClick={openCustomFlagsEditor}
                  onFocus={openCustomFlagsEditor}
                  placeholder="-sm layer -smf32 1 ..."
                  title="Click to open editor"
                  className="custom-flags-input flex-1 min-w-0 border text-[8px] font-mono px-2 py-0 leading-none focus:outline-none rounded-sm border-amber-600/30 focus:border-amber-600/50 placeholder:text-stealth-muted/40 cursor-text"
                />
              )}
              <div className="flex items-center gap-1 shrink-0 ml-auto">
                {testFlagsEnabled && (
                  <button
                    type="button"
                    onClick={() => setTestFlagsMode((m) => (m === "add" ? "replace" : "add"))}
                    className={`px-1.5 py-0 text-[7px] font-mono border rounded-sm transition-all duration-150 cursor-pointer ${
                      testFlagsMode === "add" ? "mode-btn-add" : "mode-btn-replace"
                    }`}
                  >
                    {testFlagsMode === "add" ? "+ APPEND to config" : "= REPLACE config"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setCustomFlagsEditorOpen(false);
                    setTestFlagsEnabled((v) => !v);
                  }}
                  className={`px-1.5 py-0 text-[7px] font-mono border rounded-sm transition-all duration-150 cursor-pointer ${
                    testFlagsEnabled ? "mode-btn-add" : "mode-btn-off"
                  }`}
                >
                  {testFlagsEnabled ? "ON" : "OFF"}
                </button>
              </div>
            </div>
          </div>
        </div>
        {popover}
      </>
    );
  }, [
    configView,
    testFlags,
    testFlagsEnabled,
    testFlagsMode,
    customFlagsReplaceActive,
    customFlagsEditorOpen,
    customFlagsDraft,
    customFlagsPopoverPos,
    openCustomFlagsEditor,
    launchDockPosition,
  ]);

  const shareLaunchConfig = useMemo((): FusionShareLaunchConfig => ({
    ctx: config.ctx,
    batch: config.batch,
    ubatch: config.ubatch,
    flashAttn: config.flash_attn != null ? String(config.flash_attn) : undefined,
    splitMode: config.split != null ? String(config.split) : undefined,
    kvQuant: config.kv_quant != null ? String(config.kv_quant) : undefined,
    specType: config.spec_type != null ? String(config.spec_type) : undefined,
    specDraftNMax: config.spec_draft_n_max != null ? config.spec_draft_n_max : undefined,
    specDraftNMin: config.spec_draft_n_min != null ? config.spec_draft_n_min : undefined,
  }), [
    config.ctx,
    config.batch,
    config.ubatch,
    config.flash_attn,
    config.split,
    config.kv_quant,
    config.spec_type,
    config.spec_draft_n_max,
    config.spec_draft_n_min,
  ]);

  const shareProfileMeta = useMemo(() => {
    const meta = ENV_META[selectedBinaryProfile];
    const provider = resolvedProviders?.find((p) => p.id === effectiveBackendType);
    const runningEntry =
      selectedSlotIdx != null && selectedSlotIdx >= 0
        ? stack.find((s) => s.idx === selectedSlotIdx)
        : undefined;
    const buildInfo =
      runningEntry?.build_info ??
      (provider ? profileEnvLookup(provider.buildInfoPerEnv, selectedBinaryProfile) : undefined);
    return {
      providerName: provider?.display_name || provider?.id,
      providerBuildVersion: buildInfo?.version ? `v${buildInfo.version}` : undefined,
      profileLabel: meta.label,
      cudaVersion: meta.cuda,
    };
  }, [selectedBinaryProfile, resolvedProviders, effectiveBackendType, selectedSlotIdx, stack]);

  const selectedGpuIndices = useMemo(() => {
    if (splitModeActive && gpus.length > 0) {
      return gpus.map((g) => g.index);
    }
    if (!vramCalc.manifest) return [];
    return vramCalc.manifest.gpuAllocations
      .filter((a) => a.projectedLoadGb > 0.1)
      .map((a) => a.gpuIndex);
  }, [vramCalc.manifest, splitModeActive, gpus]);

  const booterProps = useMemo(() => {
    const gpuLoadTargetsMib: Record<number, number> = {};
    for (const alloc of vramCalc.manifest?.gpuAllocations ?? []) {
      if (alloc.projectedLoadGb > 0.05) {
        gpuLoadTargetsMib[alloc.gpuIndex] = alloc.projectedLoadGb * 1024;
      }
    }
    if (selectedSlotIdx == null || selectedSlotIdx < 0) {
      return {
        gpuMask: "",
        vramTargetMib: committedVramMib,
        modelLayerTotal: model?.metadata?.n_layer ?? 0,
        gpuLoadTargetsMib,
      };
    }
    const entry = stack.find((s) => s.idx === selectedSlotIdx);
    const maskFromConfig = config.device?.replace(/^GPU-/i, "").replace(/\s+/g, ",");
    return {
      gpuMask: entry?.gpu || maskFromConfig || "",
      vramTargetMib: entry?.vram_mib ?? committedVramMib,
      modelLayerTotal: model?.metadata?.n_layer ?? vramCalc.manifest?.gpuLayers ?? 0,
      gpuLoadTargetsMib,
    };
  }, [
    selectedSlotIdx,
    stack,
    committedVramMib,
    model,
    config.device,
    vramCalc.manifest?.gpuLayers,
    vramCalc.manifest?.gpuAllocations,
  ]);

  const shareHwTopo = useMemo(
    () => formatShareHwTopo(gpus, booterProps.gpuMask),
    [gpus, booterProps.gpuMask],
  );

  // ── Provider default param keys (for yellow accent on user-added params) ──
  const [providerDefaultKeys, setProviderDefaultKeys] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (!effectiveBackendType) return;
    invoke<ProviderTemplate>("get_template", { providerId: effectiveBackendType })
      .then(template => setProviderDefaultKeys(new Set((template.params || []).map(p => p.key))))
      .catch(() => setProviderDefaultKeys(new Set()));
  }, [effectiveBackendType]);

  // Extracted param row renderer for reuse
  const paramRowKey = (def: UserEditedTemplateParam, idx?: number) =>
    `${def.key || "param"}-${def.order}-${idx ?? 0}`;

  const renderParamRow = useCallback((def: UserEditedTemplateParam, isLocked?: boolean, rowIdx?: number) => {
    // Merge values + userAddedValues (user-added params from ConfigPage admin edit)
    const seenVals = new Set((def.values || []).map(v => String(v)));
    const allValues = [...(def.values || []), ...(def.userAddedValues || []).filter(v => !seenVals.has(String(v)))];
    let baseValues = allValues.filter(v => !(def.hiddenValues || []).some(hv => String(hv) === String(v)));
    if (def.key === "spec_type" && specCapabilities.length > 0) {
      baseValues = filterSpecTypeValues(baseValues, specCapabilities, specSimpleMode);
    }
    const currentValue = config[def.key];

    // Yellow accent: user-added params (not in provider default params, not system-injected via dock)
    const isUserAdded = providerDefaultKeys.size > 0 && !providerDefaultKeys.has(def.key) && !def.dock;

    // ── Slider ptype — render range input instead of value chips ───────────
    if (def.ptype === 'slider') {
      const ctxNumeric =
        def.key === "ctx"
          ? (typeof currentValue === "number" ? currentValue : parseInt(String(currentValue), 10))
          : 0;
      const ctxSlotCount = def.key === "ctx" ? resolveCtxSlotCount(config, allParamsResolved) : 1;
      const ctxPerSlot =
        def.key === "ctx" && ctxSlotCount > 1 && Number.isFinite(ctxNumeric) && ctxNumeric > 0
          ? Math.floor(ctxNumeric / ctxSlotCount)
          : 0;
      return (
        <div
          key={paramRowKey(def, rowIdx)}
          data-param-row
          className={`ctx-slider-param-row flex items-start min-h-[22px] ${isLocked ? "opacity-50" : ""}`}
        >
          {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 bg-yellow-400/40 mr-1.5 mt-0.5" />}
          {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5 mt-0.5" />}
          <span
            className={`ctx-slider-param-label ${PARAM_LABEL_CLASS} mt-0.5 ${def.key === "ctx" && ctxPerSlot > 0 ? "!w-auto max-w-[40%]" : ""} ${isUserAdded ? "text-yellow-400/80" : ""}`}
            title={def.key === "ctx" && ctxPerSlot > 0
              ? `${formatCtxChipLabel(ctxNumeric)} (${ctxNumeric}) ÷ ${ctxSlotCount} slots = ${formatCtxChipLabel(ctxPerSlot)} per slot`
              : def.label}
          >
            {def.label}
          </span>
          <div className="ctx-slider-field flex-1 min-w-0 min-h-[18px] flex items-center">
            <SliderParam
              paramKey={def.key}
              currentValue={currentValue}
              defaultValue={def.defaultValue}
              onChange={(v) => updateParam(def.key, v)}
              step={def.step ?? 1024}
              values={baseValues}
              perSlotReserve={ctxSlotCount > 1}
              perSlotTokens={ctxPerSlot > 0 ? ctxPerSlot : undefined}
              perSlotTitle={
                ctxPerSlot > 0
                  ? `Per slot: ${formatCtxChipLabel(ctxNumeric)} (${ctxNumeric}) ÷ ${ctxSlotCount}`
                  : undefined
              }
            />
          </div>
        </div>
      );
    }

    return (
      <div key={paramRowKey(def, rowIdx)} data-param-row className={`flex items-start min-h-[22px] ${isLocked ? 'opacity-50' : ''}`}>
        {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 bg-yellow-400/40 mr-1.5 mt-0.5" />}
        {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5 mt-0.5" />}
        <span
          className={`${PARAM_LABEL_CLASS} mt-0.5 ${isUserAdded ? 'text-yellow-400/80' : ''}`}
          title={def.label}
        >
          {specSimpleMode && def.key === "spec_type" ? "MODE" : def.label}
        </span>

        <div className="config-chip-row flex gap-1.5 flex-wrap flex-1 min-w-0 items-center min-h-[18px]">
          {baseValues.filter((v: any) => !(v?._hidden)).map((val, valIdx) => (
            <button
              key={`${paramRowKey(def, rowIdx)}-val-${valIdx}-${String(val)}`}
              tabIndex={isLocked ? -1 : 0}
              title={def.key === "base_port" ? BASE_PORT_CHIP_TOOLTIP : undefined}
              onClick={() => {
                if (isLocked) return;
                updateParam(def.key, val);
                if (specSimpleMode && def.key === "spec_type") {
                  applyEssentialsSpecPreset(String(val), updateParam);
                }
              }}
              className={paramChipClass(paramValuesMatch(currentValue, val))}
            >
              {specSimpleMode && def.key === "spec_type"
                ? essentialsSpecChipLabel(String(val))
                : String(val)}
            </button>
          ))}
        </div>
      </div>
    );
  }, [config, gpus.length, providerDefaultKeys, updateParam, allParamsResolved, specCapabilities, specSimpleMode]);

  const isPanelChromeParam = useCallback((def: UserEditedTemplateParam) => {
    return Boolean(def.dock) || PANEL_CHROME_PARAM_KEYS.has(def.key);
  }, []);

  // Grouped params — panel chrome (device, split, port, offload) rendered elsewhere
  const groupedParams = useMemo(() => {
    const groups: Record<string, UserEditedTemplateParam[]> = {};
    for (const def of allParamsForDisplay) {
      if (def.hidden || isPanelChromeParam(def)) continue;
      const groupId = paramUiGroup(def.ui_group);
      if (!groups[groupId]) groups[groupId] = [];
      groups[groupId].push(def);
    }
    return groups;
  }, [allParamsForDisplay, isPanelChromeParam]);

  // All params by group — includes hidden ones (spec-decoding ON/OFF toggle reads from here)
  const allGroupedParams = useMemo(() => {
    const groups: Record<string, UserEditedTemplateParam[]> = {};
    const source = allParamsResolved;
    for (const def of source) {
      if (isPanelChromeParam(def)) continue;
      const groupId = paramUiGroup(def.ui_group);
      if (!groups[groupId]) groups[groupId] = [];
      groups[groupId].push(def);
    }
    for (const def of allParamsResolved) {
      if (isPanelChromeParam(def) || paramUiGroup(def.ui_group) !== SPEC_DECODING_GROUP) continue;
      if (!groups[SPEC_DECODING_GROUP]) groups[SPEC_DECODING_GROUP] = [];
      if (!groups[SPEC_DECODING_GROUP].some((p) => p.key === def.key)) {
        groups[SPEC_DECODING_GROUP].push(def);
      }
    }
    return groups;
  }, [allParamsResolved, isPanelChromeParam]);

  const isGroupVisible = useCallback(
    (groupId: string) => {
      if ((groupedParams[groupId]?.length ?? 0) > 0) return true;
      if (
        groupId === SPEC_DECODING_GROUP &&
        hasSpecCapability &&
        allParamsResolved.some((d) => paramUiGroup(d.ui_group) === SPEC_DECODING_GROUP)
      ) {
        return true;
      }
      return layoutModeActive && isGroupFullyHidden(groupId, allGroupedParams);
    },
    [groupedParams, hasSpecCapability, allParamsResolved, layoutModeActive, allGroupedParams],
  );

  const {
    aboveGroupKeys,
    belowGroupKeys,
    belowGroupsByColumn,
    aboveGroupsByColumn,
    aboveColumnWidths,
    groupDisplayZone,
    columnCount,
    columnWidths,
    groupColumn,
    draggingGroup,
    draggingGutterIndex,
    draggingAboveGutterIndex,
    handleGroupDragStart,
    handleGutterDragStart,
    handleAboveGutterDragStart,
    shiftGroupColumn,
    setBelowColumnCount,
    toggleGroupDisplayZone,
    toggleGroupHidden,
    deleteEmptyGroup,
    isGroupHidden,
  } = useGroupLayoutControls({
    providerId: effectiveBackendType,
    currentProvider,
    layoutParams: allParamsResolved,
    groupedParams,
    allGroupedParams,
    layoutModeActive,
    isGroupVisible,
  });

  useLayoutEffect(() => {
    if (!showRightColumn) return;
    const applyTop = () => {
      setLaunchRailUpperPadHeight(launchRailTopChromeMeasureRef.current?.offsetHeight ?? 0);
    };
    applyTop();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(applyTop);
    const topEl = launchRailTopChromeMeasureRef.current;
    if (topEl) observer.observe(topEl);
    return () => observer.disconnect();
  }, [showRightColumn, resolvedProviders, aboveGroupKeys.length]);

  useLayoutEffect(() => {
    if (!showLaunchRail || hwMonitorOpen) return;
    const apply = () => {
      setLaunchRailDisplayHeight(launchRailDisplayMeasureRef.current?.offsetHeight ?? 0);
    };
    apply();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(apply);
    const displayEl = launchRailDisplayMeasureRef.current;
    if (displayEl) observer.observe(displayEl);
    return () => observer.disconnect();
  }, [showLaunchRail, hwMonitorOpen, model, gpus.length]);

  const builtProfiles = useMemo(() => {
    const currentProvider = resolvedProviders?.find((p) => p.id === effectiveBackendType);
    return ENV_ORDER.filter((env) => isProfileBuilt(currentProvider, env));
  }, [resolvedProviders, effectiveBackendType]);

  const belowGroupMetaById = useMemo(() => {
    const map = new Map<string, ParamGroupMeta>();
    for (const g of deriveParamGroups(belowGroupKeys)) map.set(g.id, g);
    return map;
  }, [belowGroupKeys]);

  const renderGroupLayoutControls = useCallback(
    (groupId: string, zone: GroupDisplayZone, opts?: { hideZoneToggle?: boolean; hideHideToggle?: boolean }) => {
      if (!layoutModeActive) return null;
      const displayZone = groupDisplayZone[normalizeUiGroup(groupId)] === "above" ? "above" : "below";
      const zoneKeys = zone === "above" ? aboveGroupKeys : belowGroupKeys;
      const zoneColumnCount = zone === "above" ? 2 : columnCount;
      const colIdx = effectiveGroupColumn(
        groupId,
        zoneKeys,
        groupColumn,
        zoneColumnCount,
        zone,
      );
      const emptyDeletable = isEmptyGroupDeletable(groupId, allGroupedParams);
      return (
        <GroupHeaderControls
          zone={zone}
          displayZone={displayZone}
          isHidden={isGroupHidden(groupId)}
          isDragging={draggingGroup === groupId}
          hideZoneToggle={opts?.hideZoneToggle}
          hideHideToggle={opts?.hideHideToggle || emptyDeletable}
          showDelete={emptyDeletable}
          columnIdx={colIdx}
          columnCount={zoneColumnCount}
          onMoveColumnLeft={() => shiftGroupColumn(groupId, -1, zone)}
          onMoveColumnRight={() => shiftGroupColumn(groupId, 1, zone)}
          onDragStart={(e) => handleGroupDragStart(e, zone, groupId)}
          onToggleZone={() => { void toggleGroupDisplayZone(groupId); }}
          onToggleHide={() => { void toggleGroupHidden(groupId); }}
          onDelete={() => { void deleteEmptyGroup(groupId); }}
        />
      );
    },
    [
      layoutModeActive,
      groupDisplayZone,
      groupColumn,
      columnCount,
      aboveGroupKeys,
      belowGroupKeys,
      allGroupedParams,
      isGroupHidden,
      draggingGroup,
      handleGroupDragStart,
      shiftGroupColumn,
      toggleGroupDisplayZone,
      toggleGroupHidden,
      deleteEmptyGroup,
    ],
  );

  const renderParamGroup = useCallback((
    group: ParamGroupMeta,
    zone: GroupDisplayZone,
    placement?: { groupIdx?: number },
  ) => {
    const groupParams = groupedParams[group.id];
    const isSpecGroup = group.id === SPEC_DECODING_GROUP;
    const groupHidden = !isSpecGroup && isGroupHidden(group.id);
    const hideLeadHeader =
      zone === "above"
      && placement?.groupIdx === 0
      && !layoutModeActive
      && !isSpecGroup;

    if (isSpecGroup) {
      const specAllParams = allGroupedParams[group.id] || [];
      if (specAllParams.length === 0) return null;
      // Full Auto cockpit owns draft/spec — classic block only for Assisted.
      if (fullAutoFixed) return null;

      let specVisibleParams = specAllParams.filter((d) => !d.hidden);
      specVisibleParams = specVisibleParams.filter((d) => d.key !== "spec_draft_model");
      if (specSimpleMode) {
        specVisibleParams = specVisibleParams.filter(
          (d) => d.key !== "spec_draft_n_max" && d.key !== "spec_draft_n_min",
        );
      }
      const allHidden = specAllParams.every((d) => d.hidden);
      const specGroupActive = hasSpecCapability && !allHidden;

      return (
        <div key={group.id}>
          <div
            data-param-row
            className={`nuclear-btn-container config-spec-decoding config-section-row flex items-center gap-1 ${specFlash ? "flash" : ""} ${draggingGroup === group.id ? "config-group-header--dragging" : ""}`}
          >
            <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />
            <span className={SECTION_LABEL_CLASS}>SPECULATIVE DECODING</span>
            <div className="flex flex-1 min-w-0 items-center">
              <label className={`toggle-switch ${!hasSpecCapability ? "opacity-40 pointer-events-none" : ""}`}>
                <input
                  type="checkbox"
                  className="toggle-input"
                  checked={specGroupActive}
                  disabled={!hasSpecCapability}
                  onChange={() => {
                    invoke<boolean>("toggle_group_hidden", { providerId: effectiveBackendType, groupId: group.id })
                      .then(async () => {
                        setSpecFlash(true);
                        setTimeout(() => setSpecFlash(false), 400);
                        try {
                          const data = await invoke<ProviderConfig[]>("list_providers");
                          if (data.length > 0) setResolvedProviders(data);
                        } catch { /* reloadProviders event is fallback */ }
                        dispatchAppEvent(EVENTS.reloadProviders);
                        dispatchAppEvent(EVENTS.paramConfigChanged);
                      })
                      .catch((err) => console.error("[toggle_group_hidden] failed:", err));
                  }}
                />
                <span className="toggle-track">
                  <span className="toggle-rust" />
                  <span className="toggle-glow" />
                  <span className="toggle-thumb">
                    <span className="thumb-inner" />
                    <span className="thumb-shine" />
                  </span>
                  <span className="toggle-icons">
                    <svg className="icon-off" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="5" />
                      <path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42" />
                    </svg>
                    <svg className="icon-on" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313-12.454z" />
                    </svg>
                  </span>
                </span>
                <span className="toggle-label">
                  <span className="label-off">OFF</span>
                  <span className="label-on">ON</span>
                </span>
              </label>
              {specGroupActive && activeSpecType && (
                <span className={specModeBadgeClass(activeSpecType)}>
                  {String(activeSpecType).replace("draft-", "").toUpperCase()}
                </span>
              )}
            </div>
            {renderGroupLayoutControls(group.id, zone, { hideHideToggle: true })}
          </div>

          {hasSpecCapability && specGroupActive && specVisibleParams.length > 0 && (
            <div className="config-spec-params space-y-2.5 mt-2">
              {specVisibleParams.map((def, i) => (
                  <div key={paramRowKey(def, i)} className="spec-param-unlock" style={{ opacity: 0 }}>
                    {renderParamRow(def, false, i)}
                  </div>
              ))}
              {specNeedsExternalDraft && (
                <div data-param-row className="flex flex-col gap-1.5 min-h-[22px]">
                  <div className="flex items-start min-h-[22px]">
                    <div className="w-0.5 h-4 flex-shrink-0 mr-1.5 mt-0.5" />
                    <span className={`${PARAM_LABEL_CLASS} mt-0.5`} title="External draft GGUF paired with this main model">
                      {specSimpleMode ? "DRAFT" : "DRAFT MODEL"}
                    </span>
                    <div className="config-chip-row flex gap-1.5 flex-wrap flex-1 min-w-0 items-center min-h-[18px]">
                      {scoredDraftCandidates.length === 0 ? (
                        <span className="text-[8px] font-mono text-telemetry-red/80 uppercase">
                          {specSimpleMode
                            ? "Add a matching draft model to your library"
                            : "No family-matched draft in library"}
                        </span>
                      ) : (
                        <>
                          {(showAllDrafts ? scoredDraftCandidates : scoredDraftCandidates.slice(0, 2)).map(
                            ({ model: draft, score }, idx) => {
                              const selected = currentDraftPath === draft.path;
                              const recommended = idx === 0;
                              return (
                                <button
                                  key={draft.path}
                                  type="button"
                                  onClick={() => {
                                    updateParam("spec_draft_model", draft.path);
                                    if (model && activeSpecType) {
                                      saveDraftPairing(model.path, activeSpecType, draft.path);
                                    }
                                  }}
                                  className={paramChipClass(selected)}
                                  title={`${draft.path} (match ${score})`}
                                >
                                  {recommended ? "★ " : ""}
                                  {resolveDraftPathLabel(draft.path)}
                                </button>
                              );
                            },
                          )}
                          {scoredDraftCandidates.length > 2 && (
                            <button
                              type="button"
                              onClick={() => setShowAllDrafts((v) => !v)}
                              className="value-chip text-[7px] font-mono uppercase px-1.5 py-0.5 rounded-sm"
                            >
                              {showAllDrafts
                                ? "LESS"
                                : `+${scoredDraftCandidates.length - 2} MORE`}
                            </button>
                          )}
                        </>
                      )}
                    </div>
                  </div>
                  {scoredDraftCandidates.length > 0 && (
                    <div className="text-[7px] font-mono text-stealth-muted/45 uppercase ml-6 tracking-wide">
                      Draft model paired by model family + name
                    </div>
                  )}
                  {specNeedsExternalDraft && !draftPathValid && (
                    <div className="text-[7px] font-mono text-telemetry-red/75 uppercase ml-6 tracking-wide">
                      Select a .gguf draft file before launch
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {!hasSpecCapability && (
            <div className="text-[8px] font-mono text-stealth-muted/30 tracking-wider uppercase mt-1 ml-2">
              {modelIsDraftOnly
                ? "Draft model — select a main model to launch with speculative decoding"
                : "No speculative decoding available for this model"}
            </div>
          )}

          {hasSpecCapability && !specGroupActive && specAllParams.length > 0 && (
            <div className="text-[8px] font-mono text-stealth-muted/30 tracking-wider uppercase mt-1 ml-2">
              {specSimpleMode
                ? "Turn on for faster generation (MTP or DFlash)"
                : `${specAllParams.length} parameter${specAllParams.length > 1 ? "s" : ""} locked — activate to configure${
                    specCapabilities.includes("dflash") && specCapabilities.includes("mtp")
                      ? " (MTP baked-in · DFlash ready)"
                      : specCapabilities.includes("dflash")
                        ? " (DFlash ready)"
                        : specCapabilities.includes("mtp")
                          ? " (MTP)"
                          : ""
                  }`}
            </div>
          )}
        </div>
      );
    }

    const allInGroup = allGroupedParams[group.id] || [];
    if (!groupParams || groupParams.length === 0) {
      if (layoutModeActive && isEmptyGroupDeletable(group.id, allGroupedParams)) {
        return (
          <div key={group.id} className="config-param-group--empty opacity-70">
            <div
              className={`config-group-header flex items-center gap-1.5 text-[8px] font-mono tracking-widest uppercase mb-2 pb-1 border-b border-dashed border-stealth-border/35 text-stealth-muted/55 ${draggingGroup === group.id ? "config-group-header--dragging" : ""}`}
            >
              <span className="flex-1 min-w-0 truncate">{group.label}</span>
              <span className="opacity-50 flex-shrink-0">(empty)</span>
              {renderGroupLayoutControls(group.id, zone)}
            </div>
          </div>
        );
      }
      if (!layoutModeActive || !groupHidden || allInGroup.length === 0) return null;
      return (
        <div key={group.id} className="config-param-group--hidden opacity-50">
          <div
            className={`config-group-header flex items-center gap-1.5 text-[8px] font-mono tracking-widest uppercase mb-2 pb-1 border-b border-stealth-border/30 text-stealth-muted/50 ${draggingGroup === group.id ? "config-group-header--dragging" : ""}`}
          >
            <span>{group.label}</span>
            <span className="opacity-40">(hidden)</span>
            {renderGroupLayoutControls(group.id, zone)}
          </div>
        </div>
      );
    }

    const isCollapsed = collapsedGroups.has(group.id);
    const showContent = hideLeadHeader || !isCollapsed;
    const headerClass = `config-group-header flex items-center gap-1.5 text-[8px] font-mono tracking-widest uppercase mb-2 pb-1 border-b border-stealth-border/30 w-full ${draggingGroup === group.id ? "config-group-header--dragging" : ""}`;

    return (
      <div key={group.id} className={groupHidden ? "config-param-group--hidden opacity-50" : undefined}>
        {!hideLeadHeader && (group.alwaysOpen ? (
          <div className={headerClass}>
            <span className="flex-1 min-w-0 truncate">{group.label}</span>
            {renderGroupLayoutControls(group.id, zone)}
          </div>
        ) : (
          <div className={headerClass}>
            <button
              type="button"
              onClick={() => toggleGroup(group.id)}
              className="flex items-center gap-1.5 flex-1 min-w-0 hover:text-white hover:opacity-100 transition-colors text-left"
            >
              <span className="text-[7px]">{isCollapsed ? "▶" : "▼"}</span>
              <span className="truncate">{group.label}</span>
              <span className="opacity-40 flex-shrink-0">({groupParams.length})</span>
            </button>
            {renderGroupLayoutControls(group.id, zone)}
          </div>
        ))}

        {showContent && (
          <div className="space-y-2.5">
            {groupParams.map((def, i) => renderParamRow(def, false, i))}
          </div>
        )}
      </div>
    );
  }, [
    groupedParams,
    allGroupedParams,
    model,
    specFlash,
    effectiveBackendType,
    collapsedGroups,
    toggleGroup,
    renderParamRow,
    mtpParallelSlotCount,
    hasSpecCapability,
    specCapabilities,
    modelIsDraftOnly,
    fullAutoMode,
    fullAutoFixed,
    activeSpecType,
    scoredDraftCandidates,
    showAllDrafts,
    setShowAllDrafts,
    specNeedsExternalDraft,
    config.spec_draft_model,
    updateParam,
    model,
    specSimpleMode,
    layoutModeActive,
    isGroupHidden,
    draggingGroup,
    renderGroupLayoutControls,
  ]);

  // ── Load param definitions when model/provider changes ───────────────────
  useEffect(() => {
    if (!model) {
      setUserEditedParams([]);
      return;
    }

    const backendType = effectiveBackendType;

    const prov = resolvedProviders?.find(p => p.id === backendType);
    if (prov && prov.userEditedTemplateParams) {
      setUserEditedParams(prov.userEditedTemplateParams || []);
    } else {
      invoke<ProviderTemplate>("get_template", { providerId: backendType })
        .then((template: ProviderTemplate) => {
          const tDefs: UserEditedTemplateParam[] = (template.params || []).map((p, i) => ({
            key: p.key,
            label: p.label,
            values: p.values as (string | number)[],
            order: i,
            hidden: p.hidden_default ?? false,
            defaultValue: p.default,
            flag: p.flag ?? undefined,
            ptype: p.ptype,
            step: p.step,
            ui_group: p.ui_group,
            note: p.note,
            pattern: p.pattern,
            sub_params: p.sub_params,
            dock: p.dock || undefined,
          }));
           setUserEditedParams(tDefs);
         })
         .catch(() => {});
    }

  }, [model, effectiveBackendType, resolvedProviders]);

  // ── Name helpers ───────────────────────────────────────────────────────────
  // ── Launch handler ───────────────────────────────────────────────────────
  const pulseLaunchAck = useCallback(() => {
    setLaunchAck(true);
    if (launchAckTimerRef.current) clearTimeout(launchAckTimerRef.current);
    launchAckTimerRef.current = setTimeout(() => {
      setLaunchAck(false);
      launchAckTimerRef.current = null;
    }, 140);
  }, []);

  useEffect(() => () => {
    if (launchAckTimerRef.current) clearTimeout(launchAckTimerRef.current);
  }, []);

  const buildCurrentLaunchConfig = useCallback((): EngineConfig | null => {
    if (!model) return null;

    const launchDraft = aliasFocused ? aliasInput : (aliasIsUserSet ? aliasInput : autoAlias);
    const { userSet: launchUserSet, committed: launchAlias } = resolveAliasCommit(
      launchDraft.trim(),
      aliasIsUserSet,
      autoAlias,
    );
    const finalAlias = resolveUniqueAlias(
      launchUserSet ? launchAlias : nextEngineAlias(stack),
      stack,
    );

    return buildLaunchFullConfig({
      model,
      finalAlias,
      config,
      effectiveBackendType,
      selectedBinaryProfile,
      fitLaunchSupported,
      fullAutoMode,
      configView,
      essentialFactoryKeys,
      specActive: specLaunchActive,
      allParamsResolved,
      gpus,
      runningSlotsForPlan,
      vramManifest: vramCalc.manifest,
      testFlagsEnabled,
      testFlags,
      testFlagsMode,
    });
  }, [
    model,
    aliasFocused,
    aliasInput,
    aliasIsUserSet,
    autoAlias,
    stack,
    config,
    effectiveBackendType,
    selectedBinaryProfile,
    fitLaunchSupported,
    fullAutoMode,
    configView,
    essentialFactoryKeys,
    specLaunchActive,
    allParamsResolved,
    gpus,
    runningSlotsForPlan,
    vramCalc.manifest,
    testFlagsEnabled,
    testFlags,
    testFlagsMode,
  ]);

  const performLaunch = useCallback(() => {
    if (!model) return;
    pulseLaunchAck();

    const launchDraft = aliasFocused ? aliasInput : (aliasIsUserSet ? aliasInput : autoAlias);
    const { userSet: launchUserSet, committed: launchAlias } = resolveAliasCommit(
      launchDraft.trim(),
      aliasIsUserSet,
      autoAlias,
    );
    const persistAliasAtLaunch = launchUserSet;
    const aliasToPersist = launchAlias;

    const fullConfig = buildCurrentLaunchConfig();
    if (!fullConfig) return;

    void onLaunch(fullConfig)
      .then((result) => {
        const resolvedAlias = result?.alias ?? fullConfig.alias;
        if (result?.port) {
          dispatchAppEvent(EVENTS.launchSuccess, { alias: resolvedAlias, port: result.port });
        }
        if (persistAliasAtLaunch) {
          persistAliasForModel(model.path, aliasToPersist);
          setAliasIsUserSet(true);
          setAliasInput(aliasToPersist);
        }
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        dispatchAppEvent(EVENTS.launchError, { message: msg });
      });
  }, [
    model,
    pulseLaunchAck,
    aliasInput,
    aliasIsUserSet,
    aliasFocused,
    autoAlias,
    buildCurrentLaunchConfig,
    onLaunch,
  ]);

  const handleOpenNobsproofCmd = useCallback(() => {
    const fullConfig = buildCurrentLaunchConfig();
    if (!fullConfig) return;
    void invoke<string>("open_nobsproof_cmd", {
      config: fullConfig,
      providerId: effectiveBackendType,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      dispatchAppEvent(EVENTS.launchError, { message: `NoBSproof CMD: ${msg}` });
    });
  }, [buildCurrentLaunchConfig, effectiveBackendType]);

  const acknowledgeReplaceLaunch = useCallback(() => {
    try {
      sessionStorage.setItem(KEYS.customFlagsReplaceAck, "1");
    } catch { /* ignore quota / private mode */ }
    setReplaceLaunchConfirmOpen(false);
    performLaunch();
  }, [performLaunch]);

  const handleAddToStack = useCallback(() => {
    if (!model) return;
    if (selectedProfileIsBuilding) return;
    if (!isLaunchableMain(model)) {
      dispatchAppEvent(EVENTS.launchError, {
        message: "Draft models cannot be launched as mains — select a main model and assign this file as the draft.",
      });
      return;
    }
    if (specNeedsExternalDraft && !draftPathValid) {
      dispatchAppEvent(EVENTS.launchError, {
        message: "Select a draft model (.gguf) for speculative decoding before launch.",
      });
      return;
    }
    if (tomMtpBlocked(effectiveBackendType, model)) {
      dispatchAppEvent(EVENTS.launchError, { message: TOM_MTP_SKIP_MESSAGE });
      return;
    }
    const now = Date.now();
    if (now - lastLaunchAtRef.current < 60) return;
    lastLaunchAtRef.current = now;

    if (customFlagsReplaceActive) {
      let acked = false;
      try {
        acked = sessionStorage.getItem(KEYS.customFlagsReplaceAck) === "1";
      } catch { /* ignore */ }
      if (!acked) {
        setReplaceLaunchConfirmOpen(true);
        return;
      }
    }

    performLaunch();
  }, [
    model,
    selectedProfileIsBuilding,
    effectiveBackendType,
    customFlagsReplaceActive,
    specNeedsExternalDraft,
    draftPathValid,
    performLaunch,
  ]);

  const launchDisabled =
    !model
    || modelIsDraftOnly
    || (specNeedsExternalDraft && !draftPathValid)
    || selectedProfileIsBuilding
    || vramCalc.manifest?.scenario === "HW_LOCKED"
    || (vramCalc.manifest != null && !vramCalc.manifest.fits);

  // Keyboard launch — Ctrl+Enter triggers ignite (must track handleAddToStack for fresh manifest)
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (!e.ctrlKey || (e.key !== "Enter" && e.code !== "NumpadEnter")) return;
      if (launchDisabled) return;
      e.preventDefault();
      e.stopPropagation();
      handleAddToStack();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [launchDisabled, handleAddToStack]);

  // Legacy path when MODELS_KEYBOARD_NAV_ENABLED is turned back on
  useEffect(() => {
    const handler = () => {
      handleAddToStack();
    };
    window.addEventListener(EVENTS.launchEngine, handler);
    return () => window.removeEventListener(EVENTS.launchEngine, handler);
  }, [handleAddToStack]);

  const onboardingDisplay = onboardingDisplayClasses(setupGuide);

  // Onboarding owns the phosphor panel — hide provider/profile/config chrome until dismiss.
  if (setupGuide.active) {
    return (
      <div
        className="flex flex-col h-full min-h-0 overflow-hidden"
        data-config-panel
        data-onboarding-active
      >
        <div
          className={onboardingDisplay.area}
          data-display-texture={displayTexture}
        >
          <div className={onboardingDisplay.frame}>
            <div className="phosphor-screen-inner phosphor-display-surface">
              <DisplayGlitchOverlay />
              {setupGuide.showWelcome ? (
                <WelcomeAnimation onComplete={setupGuide.completeWelcome} />
              ) : (
                <SetupGuideDisplay
                  phase={setupGuide.phase}
                  pathsDone={setupGuide.pathsDone}
                  toolchainSkipped={setupGuide.toolchainSkipped}
                  runtimeReady={setupGuide.runtimeReady}
                  toolchainChecked={setupGuide.toolchainChecked}
                  toolchainBusy={setupGuide.toolchainBusy}
                  modelsDeferred={setupGuide.modelsDeferred}
                  metaDone={setupGuide.metaDone}
                  metaScanFailed={setupGuide.metaScanFailed}
                  modelsCount={setupGuide.modelsCount}
                  scannedCount={setupGuide.scannedCount}
                  catalogLoaded={setupGuide.catalogLoaded}
                  onDeferModels={setupGuide.deferModels}
                  onSkipToolchain={setupGuide.skipToolchain}
                  onSkipMetaScan={setupGuide.skipMetaScan}
                  onDismiss={setupGuide.dismiss}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!model) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-stealth-muted font-mono">
        <div className="text-center config-empty-enter">
          <div className="text-3xl mb-3 text-stealth-muted/40">⬡</div>
          <p className="text-xs tracking-widest uppercase">SELECT A MODEL</p>
          <p className="text-[9px] mt-1 opacity-50">Choose from the catalog to configure</p>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full min-h-0 overflow-hidden"
      data-config-panel
      data-layout-mode={layoutModeActive ? "on" : "off"}
      data-launch-dock-position={launchDockPosition}
      data-launch-dock-collapsed={launchDockCollapsed && launchDockPosition === "bottom" ? "true" : "false"}
      data-hw-monitor-open={hwMonitorOpen ? "true" : "false"}
      data-engines-in-rail={enginesInRail ? "true" : "false"}
    >
      <div
        ref={launchDockMainRef}
        className={`config-panel-body flex flex-1 min-h-0 min-w-0${
          showRightColumn ? " config-panel-body--split" : " config-panel-body--stacked"
        }`}
      >
        <div className="config-panel-center-stack flex flex-col flex-1 min-h-0 min-w-0">
          <div ref={launchRailTopChromeMeasureRef} className="config-panel-top-chrome flex-shrink-0">
      {resolvedProviders && resolvedProviders.length > 0 && (
        <div className="px-4 py-2 border-b section-divider relative flex-shrink-0 config-provider-profile-bar">
          <div className="config-provider-profile-bar__half config-provider-profile-bar__half--providers">
            <span className="config-provider-profile-bar__label">PROVIDER</span>
            <div className="flex gap-1 flex-wrap flex-1 min-w-0">
              {resolvedProviders.filter((p) => p.enabled).map((p) => (
                <button
                  key={p.id}
                  onClick={() => {
                    setSelectedProvider(p.id);
                    writeStorage(KEYS.lastProvider, p.id);
                    dispatchAppEvent(EVENTS.providerChanged, { providerId: p.id });
                  }}
                  className={`flex-shrink-0 px-2 py-0.5 text-[9px] font-mono rounded-sm ${
                    selectedProvider === p.id ? "provider-pill-active" : "provider-pill"
                  }`}
                >
                  {p.display_name || p.id}
                  <span className="ml-1 opacity-40 text-[7px]">
                    ({(p.userEditedTemplateParams || []).length})
                  </span>
                </button>
              ))}
            </div>
          </div>
          <div className="config-provider-profile-bar__half config-provider-profile-bar__half--profile">
            <span className="config-provider-profile-bar__label">PROFILE</span>
            
            <div className="flex gap-1 flex-wrap flex-1 min-w-0">
              {ENV_ORDER.map((profile) => {
                const meta = ENV_META[profile];
                const hasBuild = builtProfiles.includes(profile);
                const building = isProfileBuilding(profile);
                const isSelected = selectedBinaryProfile === profile;
                const driverOk = isDriverSufficientForProfile(driverVersion, meta.cuda);
                const driverStatus = driverVersion
                  ? (driverOk ? "driver OK" : `driver too old (need ${meta.cuda} compat)`)
                  : "driver unknown";

                const driverClass = !hasBuild || building
                  ? ""
                  : driverOk
                    ? "ring-1 ring-nv-green/50"
                    : "ring-1 ring-red-400/60 text-red-300/90";

                return (
                  <button
                    key={profile}
                    onClick={() => setSelectedBinaryProfile(profile)}
                    disabled={!hasBuild || building}
                    className={`flex-shrink-0 px-2 py-0.5 text-[9px] font-mono rounded-sm ${
                      isSelected ? "provider-pill-active" : "provider-pill"
                    } ${driverClass} ${
                      building
                        ? "opacity-40 cursor-not-allowed animate-pulse"
                        : !hasBuild
                          ? "opacity-25 cursor-not-allowed"
                          : ""
                    }`}
                    title={`${meta.label} — CUDA ${meta.cuda} (min driver ~${getMinDriverMajorForCuda(meta.cuda)}+)\n${meta.vs}\n${driverStatus}${
                      building ? "\n(build in progress)" : hasBuild ? "" : "\n(not yet built or mirrored)"
                    }`}
                  >
                    {meta.label}
                    {hasBuild && !building && (
                      <span className={`ml-1 text-[7px] ${driverOk ? "text-nv-green/70" : "text-red-400/80"}`}>
                        {driverOk ? "●" : "!"}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      )}

      {/* Full Auto: fixed cockpit — hide above chip groups. */}
      {aboveGroupKeys.length > 0 && !fullAutoFixed && (
        <div className={`config-params-above-shell relative${paramsBypassedClass}`}>
          <ConfigBelowGroups
            zone="above"
            columnCount={2}
            columnWidths={[...aboveColumnWidths]}
            belowGroupsByColumn={aboveGroupsByColumn}
            onGutterDragStart={handleAboveGutterDragStart}
            draggingGutterIndex={draggingAboveGutterIndex}
            layoutModeActive={layoutModeActive}
            renderGroup={(groupId, _columnIdx, groupIdx) => {
              const group = deriveParamGroups(aboveGroupKeys).find((g) => g.id === groupId);
              if (!group) return null;
              return renderParamGroup(group, "above", { groupIdx });
            }}
          />
        </div>
      )}
          </div>

      <div className="config-rail-workspace flex-1 min-h-0">
      <div
        className={
          showRightColumn || launchDockPosition === "bottom"
            ? "config-rail-left flex flex-col flex-1 min-h-0 min-w-0"
            : "contents"
        }
      >
      <div
        ref={hwMonitorOpen || showLaunchRail ? launchRailDisplayMeasureRef : undefined}
        className="config-display-stack flex flex-col flex-shrink-0 min-w-0"
      >
      <div
        className={onboardingDisplay.area}
        data-display-texture={displayTexture}
      >
        {/* Full Auto locks device/split — hide dead DEVICE chrome. */}
        {model && gpus.length > 0 && !fullAutoMode && (
          <GpuAssignPanel
            gpus={gpus}
            deviceValue={config.device}
            splitValue={config.split}
            splitValues={splitParamDef?.values ?? ["none"]}
            chromeDisabled={launchChrome.chromeDisabled}
            deviceLocked={launchChrome.deviceLocked}
            splitLocked={launchChrome.splitLocked}
            hideSplitNone={launchChrome.hideSplitNone}
            hideTensorSplit={!tensorSplitSupported}
            onDeviceChange={(v) => {
              if (launchChrome.chromeDisabled || launchChrome.deviceLocked) return;
              updateParam("device", v);
              if (isSplitModeActive(config.split)) updateParam("split", "none");
            }}
            onSplitChange={(v) => {
              if (launchChrome.chromeDisabled || launchChrome.splitLocked) return;
              autoSplitPromotedRef.current = false;
              updateParam("split", v);
            }}
          />
        )}
          <div className={onboardingDisplay.frame} data-fusion-share-frame>
              {showChromeHints && (
                <DisplayChromeHints
                  policyReason={launchChrome.reason}
                  tensorSplitWarn={launchChrome.tensorSplitWarn}
                />
              )}
              <div
                key="forecast-phosphor"
                className="phosphor-screen-inner phosphor-display-surface vram-forecast-display"
              >
                <DisplayGlitchOverlay />
                <VramBadge
                    manifest={vramCalc.manifest}
                    gpus={gpus}
                    selectedGpuIndices={selectedGpuIndices.length > 0 ? selectedGpuIndices : undefined}
                    onDeviceSelect={(gpuIndex) => {
                      if (launchChrome.chromeDisabled || launchChrome.deviceLocked) return;
                      updateParam("device", `GPU-${gpuIndex}`);
                      if (isSplitModeActive(config.split)) {
                        updateParam("split", "none");
                      }
                    }}
                    isValidating={vramCalc.isValidating}
                    onValidate={vramCalc.validate}
                    isModelRunning={isModelRunning}
                    activeEngineAlias={activeEngineAlias}
                    activeEnginePort={activeEnginePort}
                    selectedSlotIdx={selectedSlotIdx}
                    supportsFusion={supportsFusion}
                    engineStatus={
                      selectedSlotIdx != null && selectedSlotIdx >= 0
                        ? stack.find((s) => s.idx === selectedSlotIdx)?.status
                        : undefined
                    }
                    gpuMask={booterProps.gpuMask}
                    vramTargetMib={booterProps.vramTargetMib}
                    modelLayerTotal={booterProps.modelLayerTotal}
                    gpuLoadTargetsMib={booterProps.gpuLoadTargetsMib}
                    offloadMode={config["offload_mode"]}
                    onMoeSuggestionClick={() => {
                      updateParam(
                        "offload_mode",
                        config["offload_mode"] === "moe_optimal" ? "regular" : "moe_optimal",
                      );
                    }}
                    fitLaunchAvailable={fitLaunchSupported}
                    fullAutoMode={fullAutoMode}
                    onFitLaunchChange={(nextFullAuto) => {
                      setFitLaunchEnabled(nextFullAuto);
                      saveAutoVramEnabled(effectiveBackendType, nextFullAuto);
                      if (nextFullAuto) {
                        autoSplitPromotedRef.current = false;
                        updateParam("split", "none");
                        if (String(config["offload_mode"] ?? "regular").toLowerCase() === "moe_optimal") {
                          updateParam("offload_mode", "regular");
                        }
                      } else {
                        setConfigView("full");
                        saveConfigView(effectiveBackendType, "full");
                      }
                    }}
                    hideMoeBadge={fullAutoMode || !((model?.metadata?.n_expert ?? 0) > 0)}
                    modelMeta={model?.metadata}
                    modelName={model?.name}
                    modelQuant={model?.quant}
                    providerName={shareProfileMeta.providerName}
                    providerBuildVersion={shareProfileMeta.providerBuildVersion}
                    profileLabel={shareProfileMeta.profileLabel}
                    cudaVersion={shareProfileMeta.cudaVersion}
                    launchConfig={shareLaunchConfig}
                    hwTopo={shareHwTopo}
                    gpuIdleBaselineMib={gpuIdleBaselineMib}
                  />
              </div>
          </div>
      </div>

      {/* Running Engines — fusion switcher; below VRAM bezel (outside display area flex) */}
      {showEjectBelowVram && (
        <div className="industrial-eject-panel relative flex-shrink-0 min-h-0">
          <RunningEnginesPanel
            stack={stack}
            models={models}
            selectedSlotIdx={selectedSlotIdx ?? null}
            onSelectEngine={onSelectEngine}
          />
        </div>
      )}
      </div>

      <div
        className={
          launchDockPosition === "right"
            ? "config-rail-main-column flex flex-col flex-1 min-h-0 min-w-0"
            : `config-panel-center flex flex-col min-h-0 ${launchDockPosition === "bottom" ? "flex-1" : ""}`
        }
      >
      <div
        className="config-panel-toolbar px-4 py-0.5 flex items-center gap-3 flex-shrink-0 border-b section-divider"
      >
        {/* Full Auto = one layout (no Essentials/Full). Assisted keeps the switch. */}
        {!fullAutoFixed && (
          <div className="config-panel-toolbar__config flex items-center gap-1.5 flex-shrink-0">
            <span className="config-panel-toolbar__label">CONFIG</span>
            <ConfigViewToggle
              view={configView}
              onChange={(view) => {
                setConfigView(view);
                saveConfigView(effectiveBackendType, view);
                if (view === "essentials") {
                  setTestFlagsEnabled(false);
                  setCustomFlagsEditorOpen(false);
                }
              }}
            />
          </div>
        )}
        {fullAutoFixed && (
          <div className="config-panel-toolbar__config flex items-center gap-1.5 flex-shrink-0">
            <span className="config-panel-toolbar__label text-nv-green/70">FULL AUTO</span>
          </div>
        )}
        <div className="config-panel-toolbar__chrome flex items-center gap-1.5 min-w-0 ml-auto flex-shrink-0">
          <div className="config-launch-dock-controls flex items-center gap-1.5 min-w-0">
            <span className="config-panel-toolbar__label">LAUNCH DOCK</span>
            <div className="flex items-center gap-0.5">
              <button
                type="button"
                onClick={() => setLaunchDockPositionUser("bottom")}
                className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
                  launchDockPosition === "bottom" ? "config-panel-toolbar-chip--active" : ""
                }`}
                title="Launch dock along the bottom"
              >
                BOTOM
              </button>
              {launchDockPosition === "bottom" && (
                <button
                  type="button"
                  onClick={toggleLaunchDockCollapsed}
                  className="config-panel-toolbar-chip px-1 py-0.5 text-[8px] font-mono rounded-sm"
                  title={launchDockCollapsed ? "Expand launch dock (show custom flags)" : "Collapse launch dock — alias, port, launch only"}
                >
                  {launchDockCollapsed ? "▼" : "▲"}
                </button>
              )}
              <button
                type="button"
                onClick={() => setLaunchDockPositionUser("right")}
                className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
                  launchDockPosition === "right" ? "config-panel-toolbar-chip--active" : ""
                }`}
                title="Launch rail — full-height column on the right (auto on short viewports until you pick)"
              >
                RIGHT RAIL
              </button>
            </div>
            {!launchDockPositionExplicit && (
              <span className="text-[7px] font-mono text-stealth-muted/40 hidden md:inline shrink-0">
                auto
              </span>
            )}
            <button
              type="button"
              onClick={toggleHwMonitor}
              className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
                hwMonitorOpen ? "config-panel-toolbar-chip--active" : ""
              }`}
              title={
                hwMonitorOpen
                  ? "HW monitor on — live CPU/GPU stats (CPU polling active)"
                  : "HW monitor off — open for live CPU/GPU column (works with BOT or RAIL dock)"
              }
            >
              HW MONITOR
            </button>
            {showLaunchRail && (
              <button
                type="button"
                onClick={toggleEnginesInRail}
                className={`config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
                  enginesInRail ? "config-panel-toolbar-chip--active" : ""
                }`}
                title={
                  enginesInRail
                    ? "Engine switcher in launch rail — click to restore below VRAM display"
                    : "Engine switcher below VRAM display — click to move into launch rail"
                }
              >
                ENGINES{enginesInRail ? "↑RAIL" : "↓DSP"}
              </button>
            )}
          </div>
          {allParamsForDisplay.length > 0 && (
            <>
              <span className="config-panel-toolbar__sep" aria-hidden />
              <div className="config-column-count flex items-center gap-0.5 flex-shrink-0">
                {([1, 2, 3] as ConfigColumnCount[]).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => setBelowColumnCount(n)}
                    className={`config-panel-toolbar-chip config-column-count__btn px-1.5 py-0.5 text-[8px] font-mono rounded-sm ${
                      columnCount === n ? "config-panel-toolbar-chip--active" : ""
                    }`}
                    title={`${n} column${n > 1 ? "s" : ""} below display`}
                  >
                    {n}C
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={toggleLayoutMode}
                className={`config-panel-toolbar-chip config-layout-mode-btn px-2 py-0.5 text-[8px] font-mono rounded-sm ${
                  layoutModeActive ? "config-panel-toolbar-chip--active config-layout-mode-btn--on" : ""
                }`}
                title={
                  layoutModeActive
                    ? "Layout mode on — drag, pin, and hide groups"
                    : "Edit group layout — reorder, pin above/below, hide"
                }
              >
                LAYOUT{layoutModeActive ? " ON" : ""}
              </button>
            </>
          )}
        </div>
      </div>

      {/* Full Auto: single 3-row cockpit. Assisted: boost strip + classic chip groups. */}
      {fullAutoFixed ? (
        <div className="px-4 py-3 flex-1 min-h-0 overflow-y-auto eink-scrollbar">
          {model && !modelIsDraftOnly && (
            <MultiAgentBooster
              codingMode={codingMode}
              speedBoost={speedBoost}
              brains={brains}
              think={think}
              onCodingMode={(m) => { void applyFullAutoCockpit(m, speedBoost, brains, think); }}
              onSpeedBoost={(s) => { void applyFullAutoCockpit(codingMode, s, brains, think); }}
              onBrains={(b) => { void applyFullAutoCockpit(codingMode, speedBoost, b, think); }}
              onThink={(t) => { void applyFullAutoCockpit(codingMode, speedBoost, brains, t); }}
              capabilities={specCapabilities}
              dflashLibraryReady={dflashLibraryReady}
              kvQuantValues={kvQuantValues}
              port={Number(config.base_port) || 9090}
              modelId={aliasDisplayValue || autoAlias || model.name || "local-model"}
              layout="hero"
              ctxValue={config.ctx}
              ctxDefault={allParamsResolved.find((p) => p.key === "ctx")?.defaultValue}
              ctxValues={allParamsResolved.find((p) => p.key === "ctx")?.values}
              ctxStep={allParamsResolved.find((p) => p.key === "ctx")?.step ?? 1024}
              onCtxChange={(v) => updateParam("ctx", v)}
              ctxSlotCount={resolveCtxSlotCount(config, allParamsResolved)}
              ctxPerSlot={(() => {
                const slots = resolveCtxSlotCount(config, allParamsResolved);
                const n = typeof config.ctx === "number" ? config.ctx : parseInt(String(config.ctx), 10);
                if (slots > 1 && Number.isFinite(n) && n > 0) return Math.floor(n / slots);
                return undefined;
              })()}
            />
          )}
        </div>
      ) : (
        <>
          {model && !modelIsDraftOnly && (
            <div className="px-4 pt-1.5 pb-0.5 flex-shrink-0 border-b section-divider">
              <MultiAgentBooster
                codingMode={codingMode}
                speedBoost={speedBoost}
                brains={brains}
                think={think}
                onCodingMode={applyCodingAgents}
                onSpeedBoost={(s) => { void applyFullAutoCockpit(codingMode, s, brains, think); }}
                onBrains={(b) => { void applyFullAutoCockpit(codingMode, speedBoost, b, think); }}
                onThink={(t) => { void applyFullAutoCockpit(codingMode, speedBoost, brains, t); }}
                capabilities={specCapabilities}
                dflashLibraryReady={dflashLibraryReady}
                kvQuantValues={kvQuantValues}
                port={Number(config.base_port) || 9090}
                modelId={aliasDisplayValue || autoAlias || model.name || "local-model"}
                layout={configView === "full" ? "dense" : "normal"}
              />
            </div>
          )}

          <div className={`config-params-scroll px-4 py-3 relative flex-1 overflow-y-auto eink-scrollbar eink-panel min-h-0${paramsBypassedClass}`}>
            {allParamsForDisplay.length === 0 ? (
              <div className="text-stealth-muted text-[10px] font-mono opacity-50">NO PARAMS DEFINED</div>
            ) : belowGroupKeys.length === 0 ? null : (
              <ConfigBelowGroups
                columnCount={columnCount}
                columnWidths={columnWidths}
                belowGroupsByColumn={belowGroupsByColumn}
                onGutterDragStart={handleGutterDragStart}
                draggingGutterIndex={draggingGutterIndex}
                layoutModeActive={layoutModeActive}
                renderGroup={(groupId) => {
                  const group = belowGroupMetaById.get(groupId);
                  if (!group) return null;
                  return renderParamGroup(group, "below", undefined);
                }}
              />
            )}

            {uiDensityCompact && configView === "full" && launchDockPosition === "bottom" && !launchDockCollapsed ? (
              <div className="config-launch-dock__flags-scroll">{renderCustomFlagsBlock()}</div>
            ) : null}
          </div>
        </>
      )}

      {launchDockPosition === "bottom" && (
        <div className="config-launch-dock flex-shrink-0 px-4 flex flex-col">
          <div className="config-launch-dock__content flex flex-col min-w-0">
          {launchDockCollapsed && customFlagsLaunchActive && configView === "full" && (
            <button
              type="button"
              onClick={() => {
                setLaunchDockCollapsed(false);
                saveLaunchDockCollapsed(false);
              }}
              className="config-launch-dock__flags-pill w-full text-left rounded-sm px-2 py-1 text-[7px] font-mono border border-amber-500/35 text-amber-300/85 bg-amber-500/10 hover:bg-amber-500/15 transition-colors"
              title="Expand dock to edit custom flags"
            >
              CUSTOM FLAGS {customFlagsReplaceActive ? "REPLACE" : "APPEND"} — click to expand
            </button>
          )}
          {specParallelWarn && !fullAutoFixed && (
            <div
              className="config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug"
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
              className="config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug"
              role="status"
            >
              <span className="config-mtp-launch-warn__detail">
                Multi-agent is on — Speed boost will use Off or DFlash (MTP needs Solo). Tap Speed → Off, or Agents → Solo for MTP.
              </span>
            </div>
          )}
          {modelIsDraftOnly && (
            <div
              className="config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug"
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
          <div className="config-launch-dock__grid">
            <div className="config-launch-dock__left">
              <div className="config-launch-dock__meta">
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
                      onFocus={handleAliasFocus}
                      onBlur={handleAliasBlur}
                      onChange={(e) => setAliasInput(e.target.value)}
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
                        onClick={handleAliasClear}
                      >
                        CLR
                      </button>
                    ) : null}
                  </div>
                </div>
                {basePortParamDef && (
                  <div className="config-launch-dock__port min-w-0">
                    {renderParamRow(basePortParamDef, false, 0)}
                  </div>
                )}
              </div>
              {!uiDensityCompact && !launchDockCollapsed && renderCustomFlagsBlock()}
            </div>
            <div className="config-launch-dock__action relative">
              {isDevBuild() && (
                <button
                  type="button"
                  onClick={handleOpenNobsproofCmd}
                  disabled={launchDisabled}
                  className="config-nobsproof-btn absolute bottom-1 right-1 z-20 px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-wider rounded-sm border disabled:opacity-40 disabled:cursor-not-allowed"
                  title="NoBSproof — open exact launch CLI in a new CMD window (DEV)"
                >
                  CMD
                </button>
              )}
              {replaceLaunchConfirmOpen && (
                <div
                  className="config-replace-confirm absolute inset-0 z-10 flex flex-col justify-center gap-2 rounded-sm px-2 py-2"
                  role="alertdialog"
                  aria-labelledby="replace-confirm-title"
                >
                  <p
                    id="replace-confirm-title"
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
                      onClick={() => setReplaceLaunchConfirmOpen(false)}
                      className="config-replace-confirm__cancel px-2 py-1 text-[7px] font-mono uppercase tracking-wide rounded-sm"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
              <button
                onClick={handleAddToStack}
                disabled={launchDisabled}
                title={
                  customFlagsReplaceActive
                    ? "REPLACE mode — panel config is bypassed; only custom flags are used"
                    : customFlagsLaunchActive
                      ? "APPEND mode — custom flags are added to panel config"
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
          </div>
          </div>
        </div>
      )}
      </div>
      </div>
      </div>
        </div>

      {showRightColumn && (
        <>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={launchRailWidth}
            aria-label="Resize side column"
            className={`launch-rail-split-handle catalog-split-handle${launchRailDragging ? " is-dragging" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              startLaunchRailDrag();
            }}
            onDoubleClick={resetLaunchRailWidth}
            title="Drag to resize side column · double-click to reset"
          />
          <div
            className={`config-launch-rail flex flex-col flex-shrink-0 min-h-0 min-w-0 self-stretch${
              hwMonitorOpen && !showLaunchRail ? " config-launch-rail--hw-only" : ""
            }`}
            style={{ width: launchRailWidth }}
          >
            {launchRailUpperPadHeight > 0 && !hwMonitorOpen ? (
              <div
                className="launch-rail-upper-pad flex-shrink-0"
                style={{ height: launchRailUpperPadHeight }}
                aria-hidden
              />
            ) : null}
            <div className="launch-rail-body flex flex-col flex-1 min-h-0 min-w-0">
            {hwMonitorOpen && (
              <div className="launch-rail-telemetry flex-1 min-h-0 overflow-hidden">
                <LaunchRailTelemetry />
              </div>
            )}
            {showLaunchRail && !hwMonitorOpen && launchRailDisplayHeight > 0 ? (
              <div
                className="launch-rail-align-pad flex-shrink-0"
                style={{ height: launchRailDisplayHeight }}
                aria-hidden
              />
            ) : null}
            {showLaunchRail && (
            <div className="launch-rail-launch flex flex-col flex-shrink-0 min-w-0">
            <div className="config-launch-dock flex flex-col flex-shrink-0 px-3 pt-2">
              <div className="config-launch-dock__content flex flex-col flex-shrink-0 min-w-0">
                {enginesInRail && onSelectEngine && models && (
                  <RunningEnginesPanel
                    stack={stack}
                    models={models}
                    selectedSlotIdx={selectedSlotIdx ?? null}
                    onSelectEngine={onSelectEngine}
                    variant="rail"
                  />
                )}
                {specParallelWarn && !fullAutoFixed && (
                  <div
                    className="config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug shrink-0"
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
                    className="config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug shrink-0"
                    role="status"
                  >
                    <span className="config-mtp-launch-warn__detail">
                      Multi-agent is on — use Speed Off/DFlash, or Agents Solo for MTP.
                    </span>
                  </div>
                )}
                {modelIsDraftOnly && (
                  <div
                    className="config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug shrink-0"
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
                <div className="config-launch-dock__grid config-launch-dock__grid--rail flex flex-col flex-shrink-0 gap-2">
                  {configView === "full" && (
                    <div className="config-launch-dock__rail-flags flex-shrink-0 overflow-y-auto eink-scrollbar">
                      {renderCustomFlagsBlock()}
                    </div>
                  )}
                  <div className="config-launch-dock__meta flex flex-col gap-2 shrink-0">
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
                          onFocus={handleAliasFocus}
                          onBlur={handleAliasBlur}
                          onChange={(e) => setAliasInput(e.target.value)}
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
                            onClick={handleAliasClear}
                          >
                            CLR
                          </button>
                        ) : null}
                      </div>
                    </div>
                    {basePortParamDef && (
                      <div className="config-launch-dock__port min-w-0">
                        {renderParamRow(basePortParamDef, false, 0)}
                      </div>
                    )}
                  </div>
                  <div className="config-launch-dock__action relative shrink-0">
                    {isDevBuild() && (
                      <button
                        type="button"
                        onClick={handleOpenNobsproofCmd}
                        disabled={launchDisabled}
                        className="config-nobsproof-btn absolute bottom-1 right-1 z-20 px-1.5 py-0.5 text-[7px] font-mono uppercase tracking-wider rounded-sm border disabled:opacity-40 disabled:cursor-not-allowed"
                        title="NoBSproof — open exact launch CLI in a new CMD window (DEV)"
                      >
                        CMD
                      </button>
                    )}
                    {replaceLaunchConfirmOpen && (
                      <div
                        className="config-replace-confirm absolute inset-0 z-10 flex flex-col justify-center gap-2 rounded-sm px-2 py-2"
                        role="alertdialog"
                        aria-labelledby="replace-confirm-title-rail"
                      >
                        <p
                          id="replace-confirm-title-rail"
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
                            onClick={() => setReplaceLaunchConfirmOpen(false)}
                            className="config-replace-confirm__cancel px-2 py-1 text-[7px] font-mono uppercase tracking-wide rounded-sm"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                    <button
                      onClick={handleAddToStack}
                      disabled={launchDisabled}
                      title={
                        customFlagsReplaceActive
                          ? "REPLACE mode — panel config is bypassed; only custom flags are used"
                          : customFlagsLaunchActive
                            ? "APPEND mode — custom flags are added to panel config"
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
                </div>
              </div>
            </div>
            </div>
            )}
            </div>
          </div>
        </>
      )}
      </div>
    </div>
  );
}