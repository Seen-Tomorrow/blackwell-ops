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
  cycleHwMonitorPlacement,
  loadCtxCockpitDock,
  loadEnginesInRail,
  loadHwMonitorDock,
  loadHwMonitorOpen,
  loadLaunchDockPosition,
  loadLaunchDockPositionExplicit,
  loadUiDensity,
  type CtxCockpitDock,
  type HwMonitorDock,
  type LaunchDockPosition,
  normalizeUiGroup,
  saveCtxCockpitDock,
  saveEnginesInRail,
  saveHwMonitorDock,
  saveHwMonitorOpen,
  saveLaunchDockCollapsed,
  saveLaunchDockPosition,
  paramUiGroup,
  readJsonStorage,
  readStorage,
  removeStorage,
  writeJsonStorage,
  writeStorage,
} from "../lib/storage";
import {
  filterParamValuesForConfigView,
  isEssentialParam,
} from "../lib/launchProfile";
import EngineToolbar from "./EngineToolbar";
import ParamPlaceDialog from "./ParamPlaceDialog";
import EngineBoostSection from "./EngineBoostSection";
import EngineProviderProfileBar from "./EngineProviderProfileBar";
import CockpitCtxStrip from "./CockpitCtxStrip";
import {
  FULL_AUTO_COLLAPSE_GROUPS,
} from "../lib/multiAgentBooster";
import {
  getFusionBenchTrayOpen,
  setFusionBenchTray,
} from "../lib/fusionBenchTrayStore";
import type { DflashDraftOffer } from "../lib/dflashGetDraft";
import DraftPickModal from "./DraftPickModal";
import {
  isGroupFullyHidden,
  PANEL_CHROME_PARAM_KEYS,
} from "../lib/paramDisplayZone";
import {
  COCKPIT_OWNED_PARAM_KEYS,
  isCockpitOwnedParam,
  isPlacementChromeParam,
  SYSTEM_CATALOG_PARAM_KEYS,
  SYSTEM_UI_GROUP,
} from "../lib/systemParams";
import {
  isCustomTemplateType,
  providerHasParamKey,
  shouldSoftLaunchOnForecast,
} from "../lib/customProvider";
import { useLaunchMode } from "../hooks/useLaunchMode";
import { useCockpit } from "../hooks/useCockpit";
import { useDflashDraft } from "../hooks/useDflashDraft";
import { useLaunchPresets } from "../hooks/useLaunchPresets";
import LaunchPresetsMenu from "./LaunchPresetsMenu";
import LaunchPresetsModal from "./LaunchPresetsModal";
import LaunchPresetConfirmModal from "./LaunchPresetConfirmModal";
import {
  type ComboPreset,
  type LaunchSeat,
  normalizeModelPath,
  orderSeatsForLaunch,
  resolveComboApply,
  resolveSeatLaunchPort,
} from "../lib/launchPresets";
import { getLaunchPolicy, resolveLaunchPolicyId } from "../lib/launchPolicy";
import ParamCatalogSearch from "./ParamCatalogSearch";
import {
  catalogEntryToParam,
  isCatalogEntryAlreadyActive,
  type RawCatalogEntry,
} from "../lib/catalog";
import type { GroupDisplayZone } from "../lib/storage";
import ConfigBelowGroups from "./ConfigBelowGroups";
import type { ConfigColumnCount } from "../lib/configColumnLayout";
import { useGroupLayoutControls } from "../hooks/useGroupLayoutControls";
import { useLaunchDockRailResize } from "../hooks/useCatalogSplitResize";
import { useFusionDisplayMode } from "../hooks/useFusionDisplayMode";
import LaunchRailTelemetry from "./LaunchRailTelemetry";

import { dispatchAppEvent, EVENTS } from "../lib/events";
import { tomMtpBlocked, TOM_MTP_SKIP_MESSAGE } from "../lib/tomMtp";
import {
  type DraftRole,
  type ScoredDraft,
  type SpecCapability,
  HIGH_DRAFT_PAIR_SCORE,
  defaultSpecTypeForMain,
  draftRoleForSpecType,
  findScoredDraftCandidates,
  isExternalDraftOnly,
  isLaunchableMain,
  isValidGgufDraftPath,
  isSpecTypeValidForMain,
  loadDraftPairing,
  loadModelSpecOverride,
  pickBestDraftPair,
  resolveExternalDraftPath,
  resolveDraftPathLabel,
  saveDraftPairing,
  specTypeAllowsParallel,
  isSpecDecodingGroupActive,
} from "../lib/specDraft";
import {
  type SpecBoostMethod,
  SPEC_PROFILE_MTP,
  SPEC_PROFILE_DFLASH,
  DFLASH_DRAFT_MODEL,
  stripObsoleteSpecParams,
  activeBoostMethodFromParams,
  cliSpecTypeForMethod,
} from "../lib/specProfiles";
import { migrateCatalogParams } from "../lib/systemParams";
import { DEFAULT_BINARY_PROFILE, ENV_META, ENV_ORDER, normalizeBinaryProfile, type Env } from "../lib/foundry_constants";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import EngineGpuForecast from "./EngineGpuForecast";
import {
  renderParamRow,
  renderParamGroup,
  deriveParamGroups,
  resolveCtxSlotCount,
  resolveParallelSlots,
  SPEC_DECODING_GROUP,
  type ParamGroupMeta,
  type ParamGroupsCtx,
} from "./EngineParamGroups";
import WelcomeAnimation from "./onboarding/WelcomeAnimation";
import SetupGuideDisplay from "./onboarding/SetupGuideDisplay";
import RunningEnginesPanel from "./RunningEnginesPanel";
import EngineLaunchDock from "./EngineLaunchDock";
import { formatTokenLabel } from "../lib/sliderParamUtils";
import { useScenarioEvaluator } from "../hooks/useScenarioEvaluator";
import type { SetupGuideState } from "../hooks/useSetupGuide";
import { useConfigResolver } from "../hooks/useConfigResolver";
import { useDisplayTexture } from "../context/DisplayTextureContext";

import { useFoundry } from "../hooks/useBuildDock";
import { isDevBuild } from "../lib/build";
import { buildLaunchFullConfig } from "../lib/buildLaunchFullConfig";
import { resolveLaunchChromePolicy } from "../lib/launchChromePolicy";
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

function isSpecDecodingActive(params: UserEditedTemplateParam[]): boolean {
  return isSpecDecodingGroupActive(params);
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

  const [showEngineCatalogSearch, setShowEngineCatalogSearch] = useState(false);
  /** After catalog add — place the new key into a group (default USER-ADDED-FROM-CATALOG). */
  const [catalogPlaceKey, setCatalogPlaceKey] = useState<string | null>(null);
  const [catalogPlaceGroup, setCatalogPlaceGroup] = useState("USER-ADDED-FROM-CATALOG");
  const [presetsManageOpen, setPresetsManageOpen] = useState(false);
  const [presetConfirm, setPresetConfirm] = useState<{
    combo: ComboPreset;
    loadIntoPanel: boolean;
  } | null>(null);
  const [presetTwinBind, setPresetTwinBind] = useState<{
    brainPort: number;
    workerPort: number;
    agentsN?: number;
    /** Freeze BRAIN/WORKER tags until both RUNNING or user unlocks. */
    rolesLocked?: boolean;
  } | null>(null);
  const launchPresetsApi = useLaunchPresets();
  /** Request apply → compact summary modal (not immediate launch). */
  const requestApplyCombo = useCallback(
    (combo: ComboPreset, opts: { loadIntoPanel: boolean }) => {
      setPresetConfirm({ combo, loadIntoPanel: opts.loadIntoPanel });
    },
    [],
  );
  const [layoutModeActive, setLayoutModeActive] = useState(
    () => readStorage(KEYS.configLayoutMode) === "1",
  );
  const [uiDensityCompact, setUiDensityCompact] = useState(
    () => loadUiDensity() === "compact",
  );
  const [launchDockPosition, setLaunchDockPosition] = useState<LaunchDockPosition>(loadLaunchDockPosition);
  const [launchDockPositionExplicit, setLaunchDockPositionExplicit] = useState(loadLaunchDockPositionExplicit);
  // Collapse removed from chrome (lost custom flags for little height). Always expanded.
  const [launchDockCollapsed, setLaunchDockCollapsed] = useState(false);
  const [hwMonitorOpen, setHwMonitorOpen] = useState(loadHwMonitorOpen);
  const [hwMonitorDock, setHwMonitorDock] = useState<HwMonitorDock>(loadHwMonitorDock);
  const fusionDisplay = useFusionDisplayMode(selectedSlotIdx, stack);

  const applyHwPlacement = useCallback((open: boolean, dock: HwMonitorDock) => {
    setHwMonitorOpen(open);
    saveHwMonitorOpen(open);
    dispatchAppEvent(EVENTS.hwMonitorOpenChanged, { open });
    if (dock !== hwMonitorDock) {
      setHwMonitorDock(dock);
      saveHwMonitorDock(dock);
    }
  }, [hwMonitorDock]);

  const cycleHwMonitor = useCallback(() => {
    const next = cycleHwMonitorPlacement(hwMonitorOpen, hwMonitorDock);
    applyHwPlacement(next.open, next.dock);
  }, [hwMonitorOpen, hwMonitorDock, applyHwPlacement]);

  // Focus HUD: stacked fusion + HW below. Dual is user's choice.
  useEffect(() => {
    if (!fusionDisplay.monitorFocus) return;
    if (!hwMonitorOpen || hwMonitorDock !== "below") {
      applyHwPlacement(true, "below");
    }
  }, [fusionDisplay.monitorFocus, hwMonitorOpen, hwMonitorDock, applyHwPlacement]);

  const [enginesInRail, setEnginesInRail] = useState(loadEnginesInRail);
  /** AtomCode harness wizard open — full cockpit takeover; skip param dim. */
  const [atomcodeHarnessOpen, setAtomcodeHarnessOpen] = useState(false);
  /** CTX strip: docked in cockpit vs above-config zone (near VRAM / pin-above groups). */
  const [ctxCockpitDock, setCtxCockpitDock] = useState<CtxCockpitDock>(() => loadCtxCockpitDock());
  const showLaunchRail = launchDockPosition === "right";
  const hwInRail = hwMonitorOpen && hwMonitorDock === "rail";
  const hwBelowDisplay = hwMonitorOpen && hwMonitorDock === "below";
  const showRightColumn = hwInRail || showLaunchRail;
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
    // Fresh install: tuck Performance / Feature-flags / Advanced (Power Full default).
    return new Set([...FULL_AUTO_COLLAPSE_GROUPS]);
  });
  const [paramFilter, setParamFilter] = useState("");

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
    setLaunchDockCollapsed(false);
    saveLaunchDockCollapsed(false);
  }, []);

  /** Single toggle like CTX — bottom ↔ right rail. */
  const toggleLaunchDockPosition = useCallback(() => {
    setLaunchDockPositionUser(launchDockPosition === "bottom" ? "right" : "bottom");
  }, [launchDockPosition, setLaunchDockPositionUser]);

  // Default dock is bottom. Explicit user toggle marks explicit (no height auto-flip).

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
  const isCustomProvider = isCustomTemplateType(currentProvider?.template_type);
  const spawnProfile = currentProvider?.spawnProfile;
  const {
    fitLaunchSupported,
    fullAutoMode,
    fullAutoFixed,
    powerCockpitMode,
    configView,
    setConfigViewMode,
    setFullAuto,
    essentialFactoryKeys,
    specSimpleMode,
  } = useLaunchMode({
    providerId: effectiveBackendType,
    spawnProfile,
  });
  // Custom / empty profile: always allow tensor/row if present in template values.
  const tensorSplitSupported =
    isCustomProvider || spawnProfile?.tensor_split !== false;

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
      values: gpus.map((g) => `GPU-${g.index}`),
      order: -1,
      hidden: false,
      defaultValue: "GPU-0",
      ui_group: "MULTI-GPU",
      note: "Select which GPU to use for inference.",
    };
  }, [gpus.length, userEditedParams]);

  const allParamsResolved = useMemo(() => {
    const cleaned = stripObsoleteSpecParams(userEditedParams);
    // Repair mtp_*/dflash_* if an older migrate pinned them into SYSTEM.
    const { params: migrated } = migrateCatalogParams(cleaned);
    const defs = deviceParam ? [deviceParam, ...migrated] : [...migrated];
    const gpuValues = gpus.map((g) => `GPU-${g.index}`);
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
  // Per-mode profiles: Full Auto / Assisted Essentials / Assisted Full never share one bag.
  const { config, updateParam, updateParams, clearSpecConfig } = useConfigResolver({
    model,
    userEditedParams: allParamsResolved,
    backendType: effectiveBackendType,
    fullAutoMode,
    configView,
  });

  /**
   * Visual-only dim of engine params after launch / when focusing a running slot.
   * Does NOT block launch (same model + same config can still spawn another instance).
   * Clears when the user edits config or cycles the catalog model.
   */
  const [paramsLiveDimmed, setParamsLiveDimmed] = useState(false);
  const liveDimConfigSnapRef = useRef<string | null>(null);
  /**
   * Launch / engine focus may update model.path in the same turn — skip that one undim.
   * Cleared by the path effect when consumed, or on a macrotask if path did not change.
   */
  const skipNextModelPathUndimRef = useRef(false);
  const configRef = useRef(config);
  configRef.current = config;

  const applyParamsLiveDim = useCallback(() => {
    if (atomcodeHarnessOpen) return;
    skipNextModelPathUndimRef.current = true;
    liveDimConfigSnapRef.current = JSON.stringify(configRef.current);
    setParamsLiveDimmed(true);
    window.setTimeout(() => {
      // Path effect did not run (same model) — drop the one-shot skip
      skipNextModelPathUndimRef.current = false;
    }, 0);
  }, [atomcodeHarnessOpen]);

  // Harness wizard needs full brightness — clear live dim while open
  useEffect(() => {
    if (!atomcodeHarnessOpen) return;
    setParamsLiveDimmed(false);
    liveDimConfigSnapRef.current = null;
    skipNextModelPathUndimRef.current = false;
  }, [atomcodeHarnessOpen]);

  /**
   * When the harness wizard opens and the launch dock is docked at the BOTTOM,
   * the wizard's big "Open {tool}" CTA stacks visually right next to the
   * "LAUNCH ENGINE" button below — same column, same accent color, both
   * primary actions. Confusing.
   *
   * Behavior:
   * - Right rail is OPEN (HW monitor / launch rail visible):
   *     Auto-move the dock to the right rail so the two CTAs are visually
   *     separated. Restore on close.
   * - Right rail is CLOSED:
   *     Don't move the dock (would force the user to discover the right rail
   *     for no good reason). Instead dim the dock via `data-launch-dock-dim`
   *     so the user sees one clear CTA — the harness's "Open {tool}" — and
   *     the launch dock fades behind it. Un-dim on close.
   */
  const preHarnessDockPositionRef = useRef<LaunchDockPosition | null>(null);
  /** Bench tray open/stowed before harness — restore on close (tray tallies VRAM badge height). */
  const preHarnessBenchTrayRef = useRef<"open" | "stowed" | null>(null);

  // Direct mutators that don't touch the explicit flag (so opening/closing
  // the harness doesn't mark the user's choice as "explicit"). The "public"
  // setLaunchDockPositionUser() always sets explicit=true which is wrong for
  // auto-managed moves.
  const setLaunchDockPositionAuto = useCallback((position: LaunchDockPosition) => {
    setLaunchDockPosition(position);
    saveLaunchDockPosition(position, launchDockPositionExplicit);
    if (position === "right") {
      setLaunchDockCollapsed(false);
      saveLaunchDockCollapsed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (atomcodeHarnessOpen) {
      // Only auto-move when the right rail is open — otherwise the dock
      // already has its own column below the wizard and dimming is the
      // less-invasive fix.
      if (
        launchDockPosition === "bottom" &&
        showRightColumn &&
        preHarnessDockPositionRef.current == null
      ) {
        preHarnessDockPositionRef.current = launchDockPosition;
        setLaunchDockPositionAuto("right");
      }
      // Stow fusion BENCHMARK tray while harness is open — open tray expands the
      // phosphor/VRAM badge tall enough to collide with Harness Connect (even 4K).
      if (preHarnessBenchTrayRef.current == null) {
        preHarnessBenchTrayRef.current = getFusionBenchTrayOpen() ? "open" : "stowed";
        setFusionBenchTray("stowed");
      }
    } else {
      if (preHarnessDockPositionRef.current != null) {
        const restore = preHarnessDockPositionRef.current;
        preHarnessDockPositionRef.current = null;
        setLaunchDockPositionAuto(restore);
      }
      if (preHarnessBenchTrayRef.current != null) {
        const restoreTray = preHarnessBenchTrayRef.current;
        preHarnessBenchTrayRef.current = null;
        setFusionBenchTray(restoreTray);
      }
    }
    // Re-fire when showRightColumn flips mid-session (e.g. user opens HW
    // monitor while harness is already open). The ref guard prevents a loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [atomcodeHarnessOpen, showRightColumn]);

  // Catalog model cycle → clear live dim (not the path change that follows engine focus/launch)
  useEffect(() => {
    if (skipNextModelPathUndimRef.current) {
      skipNextModelPathUndimRef.current = false;
      return;
    }
    setParamsLiveDimmed(false);
    liveDimConfigSnapRef.current = null;
  }, [model?.path]);

  // User changed config (any field) vs snapshot at last dim → clear live dim
  const configFingerprint = useMemo(() => JSON.stringify(config), [config]);
  useEffect(() => {
    if (!paramsLiveDimmed || liveDimConfigSnapRef.current == null) return;
    if (configFingerprint !== liveDimConfigSnapRef.current) {
      setParamsLiveDimmed(false);
      liveDimConfigSnapRef.current = null;
    }
  }, [configFingerprint, paramsLiveDimmed]);

  // Successful launch → dim (visual only)
  useEffect(() => {
    const onLaunch = () => applyParamsLiveDim();
    window.addEventListener(EVENTS.engineLaunched, onLaunch);
    return () => window.removeEventListener(EVENTS.engineLaunched, onLaunch);
  }, [applyParamsLiveDim]);

  // Selecting a running/loading slot → dim
  useEffect(() => {
    if (selectedSlotIdx == null || selectedSlotIdx < 0) return;
    const entry = stack.find((s) => s.idx === selectedSlotIdx);
    if (entry && (entry.status === "RUNNING" || entry.status === "LOADING")) {
      applyParamsLiveDim();
    }
    // Only react to slot selection, not status churn (LOADING→RUNNING would re-snap)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- stack used only for status at select time
  }, [selectedSlotIdx, applyParamsLiveDim]);

  const handleSelectEngine = useCallback(
    (slotIdx: number) => {
      if (fusionDisplay.dualActive) {
        // Dual panes follow eject/stack order; ownership stays on selection.
        // Click another live seat to pin dual B (primary unchanged).
        if (slotIdx === selectedSlotIdx) return;
        if (slotIdx === fusionDisplay.secondarySlotIdx) return;
        fusionDisplay.pinSecondaryOrCycle(slotIdx);
        return;
      }
      applyParamsLiveDim();
      onSelectEngine?.(slotIdx);
    },
    [
      fusionDisplay.dualActive,
      fusionDisplay.secondarySlotIdx,
      fusionDisplay.pinSecondaryOrCycle,
      selectedSlotIdx,
      onSelectEngine,
      applyParamsLiveDim,
    ],
  );

  const runningSlotsForPlan = useMemo(
    () => committedSlotsFromStack(stack),
    [stack],
  );

  const gpuIdleBaselineMib = useGpuIdleBaseline(gpus, stack);

  // Display value — manufactured capacity, no deductions (what users see)
  const displayVramMib = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);

  const splitModeActive = isSplitModeActive(config.split);

  const hasSplitParam = providerHasParamKey(allParamsResolved, "split");
  const softLaunchForecast = shouldSoftLaunchOnForecast(currentProvider);

  useEffect(() => {
    if (!fullAutoMode) return;
    if (String(config["offload_mode"] ?? "regular").toLowerCase() === "moe_optimal") {
      updateParam("offload_mode", "regular");
    }
  }, [fullAutoMode, config["offload_mode"], updateParam]);

  // Custom: on provider switch, reset topology to solo (starter pack defaults often leave split=layer → ALL GPUs).
  // User can change split/device after; we only reset when the provider id changes.
  const customTopoInitForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!isCustomProvider) {
      customTopoInitForRef.current = null;
      return;
    }
    if (customTopoInitForRef.current === effectiveBackendType) return;
    customTopoInitForRef.current = effectiveBackendType;
    updateParam("device", "GPU-0");
    updateParam("split", "none");
  }, [isCustomProvider, effectiveBackendType, updateParam]);

  useEffect(() => {
    if (gpus.length === 0) return;
    const allowed = new Set(gpus.map((g) => `GPU-${g.index}`));
    const cur = String(config.device ?? "GPU-0");
    if (!allowed.has(cur)) {
      updateParam("device", `GPU-${gpus[0].index}`);
    }
    if (gpus.length === 1 && isSplitModeActive(config.split)) {
      updateParam("split", "none");
    }
  }, [gpus, config.device, config.split, updateParam]);

  const showChromeHints = useMemo(
    () => !fullAutoMode && !stack.some((s) => s.status === "LOADING"),
    [fullAutoMode, stack],
  );

  const cockpit = useCockpit({
    model,
    models,
    allParamsResolved,
    config,
    updateParam,
    clearSpecConfig,
    effectiveBackendType,
    fullAutoMode,
    powerCockpitMode,
    configView,
    isCustomProvider,
    specDecodingGroupVisible,
    setResolvedProviders,
  });
  const {
    codingMode,
    speedBoost,
    brains,
    think,
    specFlash,
    applyFullAutoCockpit,
    cockpitOpts,
    specCapabilities,
    specBoostMethod,
    cockpitValueView,
    cockpitKvValuesBound,
    cockpitParallelValues,
    showCockpitSurface,
    cockpitShowAgents,
    cockpitShowMemory,
    cockpitShowThink,
    cockpitShowBoost,
    cockpitFlagToggles,
    cockpitSpecDetailParams,
    factoryRawSpecTypes,
    activeRawSpecType,
    dflashLibraryReady,
    dflashGettable,
    dflashDraftLabel,
  } = cockpit;

  const dflash = useDflashDraft({
    model,
    models,
    config,
    updateParam,
    dflashLibraryReady,
    speedBoost,
    codingMode,
    brains,
    think,
    powerCockpitMode,
    applyFullAutoCockpit,
  });
  const {
    dflashGetState,
    dflashGetError,
    dflashGetOfferLabel,
    dflashCandidates,
    dflashPickOpen,
    dflashPickMode,
    dflashResolving,
    dflashResolveError,
    dflashLocalPickItems,
    dflashPickInitialSelectedId,
    dflashMainDescribe,
    handleGetDflashDraft,
    handleChangeDflashDraft,
    handleCancelDflashPick,
    handleConfirmDflashPick,
    handleConfirmDflashManual,
    handleConfirmLibraryDraft,
    loadDflashHfCandidates,
  } = dflash;

  // VRAM forecast must see Boost method as CLI spec_type (template row is only set at launch).
  const scenarioConfig = useMemo(() => {
    const boostSpec =
      speedBoost === "mtp"
        ? "draft-mtp"
        : speedBoost === "dflash"
          ? "draft-dflash"
          : speedBoost === "dspark"
            ? "draft-dspark"
            : "";
    return {
      ...config,
      backend_type: effectiveBackendType,
      ...(boostSpec
        ? { spec_type: boostSpec, __boost_spec_type: boostSpec }
        : {}),
      ...(fullAutoMode ? { split: "none", offload_mode: "regular" } : {}),
    };
  }, [config, effectiveBackendType, fullAutoMode, speedBoost]);

  const vramCalc = useScenarioEvaluator({
    model,
    config: scenarioConfig,
    gpus,
    stack,
    systemInfo,
    autoVramLaunch: fitLaunchSupported,
    fullAutoMode,
    fitStyle: spawnProfile?.fit_style ?? "",
    catalogModels: models,
  });

  const launchChrome = useMemo(() => {
    // Custom: never multi-GPU lock / device ALL / hide split none — user owns chrome.
    if (isCustomProvider && !fullAutoMode) {
      const forecastNo =
        vramCalc.manifest != null && !vramCalc.manifest.fits;
      return {
        mode: "assisted" as const,
        chromeDisabled: false,
        deviceLocked: false,
        splitLocked: !hasSplitParam,
        hideSplitNone: false,
        reason: forecastNo
          ? "Forecast incomplete or tight — launch still allowed for custom providers"
          : undefined,
      };
    }
    return resolveLaunchChromePolicy({
      fullAutoMode,
      gpus,
      config,
      manifest: vramCalc.manifest,
      runningSlots: runningSlotsForPlan,
    });
  }, [
    isCustomProvider,
    hasSplitParam,
    fullAutoMode,
    gpus,
    config,
    vramCalc.manifest,
    runningSlotsForPlan,
  ]);



  const specParallelWarn = useMemo(
    () =>
      specParallelConflict(
        speedBoost === "mtp"
          ? "draft-mtp"
          : speedBoost === "dflash"
            ? "draft-dflash"
            : speedBoost === "dspark"
              ? "draft-dspark"
              : undefined,
        allParamsResolved,
        config,
      ),
    [speedBoost, allParamsResolved, config],
  );
  const mtpParallelSlotCount = useMemo(
    () => resolveParallelSlots(config, allParamsResolved),
    [config, allParamsResolved],
  );
  const hasSpecCapability = specCapabilities.length > 0;
  const specActive = useMemo(
    () => hasSpecCapability && specDecodingGroupVisible,
    [hasSpecCapability, specDecodingGroupVisible],
  );

  const existingGroupNames = useMemo(() => {
    const names = new Set<string>();
    for (const p of allParamsResolved) {
      names.add(paramUiGroup(p.ui_group));
    }
    names.add("USER-ADDED-FROM-CATALOG");
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [allParamsResolved]);

  const handleEngineCatalogAdd = useCallback(
    async (entry: RawCatalogEntry) => {
      if (!currentProvider) return;
      const currentUserParams = currentProvider.userEditedTemplateParams || [];
      const identity = allParamsResolved.map((d) => ({ key: d.key, flag: d.flag, ui_group: d.ui_group }));
      if (
        isCatalogEntryAlreadyActive(entry, identity)
        || isPlacementChromeParam({ key: entry.key })
        || SYSTEM_CATALOG_PARAM_KEYS.has(entry.key)
        || COCKPIT_OWNED_PARAM_KEYS.has(entry.key)
      ) {
        setShowEngineCatalogSearch(false);
        return;
      }
      const maxOrder = Math.max(...currentUserParams.map((d) => d.order), ...allParamsResolved.map((d) => d.order), -1);
      const newParam = catalogEntryToParam(entry, currentUserParams, maxOrder);
      const newUserParam: UserEditedTemplateParam = {
        ...newParam,
        order: maxOrder + 1,
        essential: configView === "essentials" ? true : undefined,
      };
      const catalogGroup = "USER-ADDED-FROM-CATALOG";
      let groupOrder = currentProvider.groupOrder ? [...currentProvider.groupOrder] : undefined;
      if (groupOrder && !groupOrder.some((g) => normalizeUiGroup(g) === catalogGroup)) {
        groupOrder = [...groupOrder, catalogGroup];
      }
      const updatedProvider: ProviderConfig = {
        ...currentProvider,
        userEditedTemplateParams: [...currentUserParams, newUserParam],
        ...(groupOrder ? { groupOrder } : {}),
      };
      try {
        await invoke("save_provider", { provider: updatedProvider });
        setResolvedProviders((prev) =>
          prev ? prev.map((p) => (p.id === effectiveBackendType ? updatedProvider : p)) : prev,
        );
        setUserEditedParams(updatedProvider.userEditedTemplateParams || []);
        dispatchAppEvent(EVENTS.reloadProviders);
        dispatchAppEvent(EVENTS.paramConfigChanged);
        setShowEngineCatalogSearch(false);
        setCatalogPlaceKey(entry.key);
        setCatalogPlaceGroup(catalogGroup);
      } catch (err) {
        console.error("[engine catalog] save_provider failed:", err);
      }
    },
    [currentProvider, allParamsResolved, configView, effectiveBackendType],
  );

  const handleCatalogPlaceConfirm = useCallback(async () => {
    if (!currentProvider || !catalogPlaceKey) {
      setCatalogPlaceKey(null);
      return;
    }
    const group = normalizeUiGroup(catalogPlaceGroup || "USER-ADDED-FROM-CATALOG");
    const currentUserParams = currentProvider.userEditedTemplateParams || [];
    const updatedUserParams = currentUserParams.map((d) =>
      d.key === catalogPlaceKey ? { ...d, ui_group: group } : d,
    );
    let groupOrder = currentProvider.groupOrder ? [...currentProvider.groupOrder] : undefined;
    if (groupOrder && !groupOrder.some((g) => normalizeUiGroup(g) === group)) {
      groupOrder = [...groupOrder, group];
    }
    const updatedProvider: ProviderConfig = {
      ...currentProvider,
      userEditedTemplateParams: updatedUserParams,
      ...(groupOrder ? { groupOrder } : {}),
    };
    try {
      await invoke("save_provider", { provider: updatedProvider });
      setResolvedProviders((prev) =>
        prev ? prev.map((p) => (p.id === effectiveBackendType ? updatedProvider : p)) : prev,
      );
      setUserEditedParams(updatedUserParams);
      dispatchAppEvent(EVENTS.reloadProviders);
      dispatchAppEvent(EVENTS.paramConfigChanged);
    } catch (err) {
      console.error("[engine catalog] place group failed:", err);
    }
    setCatalogPlaceKey(null);
  }, [currentProvider, catalogPlaceKey, catalogPlaceGroup, effectiveBackendType]);
  const modelIsDraftOnly = model ? isExternalDraftOnly(model) : false;

  const activeSpecType = cliSpecTypeForMethod(specBoostMethod) ?? undefined;
  const specNeedsExternalDraft =
    specBoostMethod === "dflash" || specBoostMethod === "dspark";
  const currentDraftPath =
    config[DFLASH_DRAFT_MODEL] != null ? String(config[DFLASH_DRAFT_MODEL]) : "";
  const draftPathValid = !specNeedsExternalDraft || isValidGgufDraftPath(currentDraftPath);
  const specLaunchActive = specBoostMethod !== "off" && hasSpecCapability;

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

  useEffect(() => {
    migrateGlobalSpecOutOfCatalogOverrides(effectiveBackendType);
  }, [effectiveBackendType]);

  // HIGH auto-pair into dflash_draft_model when Boost is DFlash and path is auto/empty.
  useEffect(() => {
    if (
      (specBoostMethod !== "dflash" && specBoostMethod !== "dspark")
      || !model
      || !models?.length
    ) {
      return;
    }
    const cur = currentDraftPath.trim().toLowerCase();
    if (cur && cur !== "auto" && cur !== "on" && cur !== "off") return;
    const best = pickBestDraftPair(model, models, "external_dflash", HIGH_DRAFT_PAIR_SCORE);
    if (!best) return;
    updateParam(DFLASH_DRAFT_MODEL, best.path);
    saveDraftPairing(
      model.path,
      specBoostMethod === "dspark" ? "draft-dspark" : "draft-dflash",
      best.path,
    );
  }, [specBoostMethod, model, models, currentDraftPath, updateParam]);

  const customFlagsReplaceActive = testFlagsEnabled && testFlagsMode === "replace";
  const customFlagsLaunchActive = testFlagsEnabled;
  // REPLACE mode OR live-dim after launch / focus running engine (visual only — launch stays free).
  // Never dim while AtomCode harness wizard is open (user is picking engines).
  const paramsBypassedClass =
    !atomcodeHarnessOpen && (customFlagsReplaceActive || paramsLiveDimmed)
      ? " config-panel-params--bypassed"
      : "";

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


  const isPanelChromeParam = useCallback((def: UserEditedTemplateParam) => {
    return Boolean(def.dock) || PANEL_CHROME_PARAM_KEYS.has(def.key);
  }, []);

  // Grouped params — panel chrome + cockpit-owned keys rendered elsewhere
  const groupedParams = useMemo(() => {
    const groups: Record<string, UserEditedTemplateParam[]> = {};
    for (const def of allParamsForDisplay) {
      if (def.hidden || isPanelChromeParam(def)) continue;
      // Cockpit / SYSTEM chrome — never free chip rows (ctx, parallel, …)
      if (isCockpitOwnedParam(def.key) || isPlacementChromeParam(def)) continue;
      const groupId = paramUiGroup(def.ui_group);
      // SYSTEM group is placement-only chrome; never show as a chip tile
      if (groupId === SYSTEM_UI_GROUP) continue;
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
      // SPECULATIVE-DECODING lives under cockpit Boost / Spec details — not chip columns.
      if (groupId === SPEC_DECODING_GROUP) return false;
      if (groupId === SYSTEM_UI_GROUP) return false;
      if ((groupedParams[groupId]?.length ?? 0) > 0) return true;
      return layoutModeActive && isGroupFullyHidden(groupId, allGroupedParams);
    },
    [groupedParams, layoutModeActive, allGroupedParams],
  );

  const ctxStripProps = useMemo(() => {
    const slots = resolveCtxSlotCount(config, allParamsResolved);
    const n = typeof config.ctx === "number" ? config.ctx : parseInt(String(config.ctx), 10);
    const perSlot =
      slots > 1 && Number.isFinite(n) && n > 0 ? Math.floor(n / slots) : undefined;
    const ctxDef = allParamsResolved.find((p) => p.key === "ctx");
    const rawCtxValues = (() => {
      if (!ctxDef) return undefined;
      const seen = new Set((ctxDef.values || []).map(String));
      return [
        ...(ctxDef.values || []),
        ...(ctxDef.userAddedValues || []).filter((v) => !seen.has(String(v))),
      ];
    })();
    const ctxValues = ctxDef && rawCtxValues
      ? filterParamValuesForConfigView(ctxDef, rawCtxValues, cockpitValueView)
      : rawCtxValues;
    return {
      ctxValue: config.ctx as number | string | undefined,
      ctxDefault: ctxDef?.defaultValue,
      ctxValues,
      ctxStep: ctxDef?.step ?? 1024,
      onCtxChange: (v: number) => updateParam("ctx", v),
      ctxSlotCount: slots,
      ctxPerSlot: perSlot,
      learnedMarks: vramCalc.learnedCurveCtxs,
      forecastCurve: vramCalc.manifest?.forecastCurve,
      forecastFreeGb: vramCalc.manifest?.forecastFreeGb,
      onPruneCustom: vramCalc.pruneLearnedCtxs,
    };
  }, [
    config,
    allParamsResolved,
    updateParam,
    cockpitValueView,
    vramCalc.learnedCurveCtxs,
    vramCalc.manifest?.forecastCurve,
    vramCalc.manifest?.forecastFreeGb,
    vramCalc.pruneLearnedCtxs,
  ]);

  const ctxDockedInCockpit = ctxCockpitDock === "cockpit";
  const showCtxAboveConfig =
    model
    && !modelIsDraftOnly
    && providerHasParamKey(allParamsResolved, "ctx")
    && (ctxStripProps.ctxValues?.length ?? 0) > 0
    && !ctxDockedInCockpit;

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

  /** Local panel filter — matches group id/label or any param key/label in the group. */
  const filteredBelowGroupsByColumn = useMemo(() => {
    const q = paramFilter.trim().toLowerCase();
    if (!q) return belowGroupsByColumn;
    return belowGroupsByColumn.map((col) =>
      col.filter((groupId) => {
        if (groupId.toLowerCase().includes(q)) return true;
        const params = groupedParams[groupId] || [];
        return params.some(
          (p) =>
            p.key.toLowerCase().includes(q)
            || (p.label || "").toLowerCase().includes(q),
        );
      }),
    );
  }, [belowGroupsByColumn, paramFilter, groupedParams]);

  const filteredBelowHasAny = useMemo(
    () => filteredBelowGroupsByColumn.some((c) => c.length > 0),
    [filteredBelowGroupsByColumn],
  );



  const paramGroupsCtx = useMemo<ParamGroupsCtx>(() => ({
    config,
    fullAutoFixed,
    configView,
    specCapabilities,
    specSimpleMode,
    providerDefaultKeys,
    updateParam,
    allParamsResolved,
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
    groupedParams,
    paramFilter,
    collapsedGroups,
    toggleGroup,
  }), [config, fullAutoFixed, configView, specCapabilities, specSimpleMode, providerDefaultKeys, updateParam, allParamsResolved, layoutModeActive, groupDisplayZone, groupColumn, columnCount, aboveGroupKeys, belowGroupKeys, allGroupedParams, isGroupHidden, draggingGroup, handleGroupDragStart, shiftGroupColumn, toggleGroupDisplayZone, toggleGroupHidden, deleteEmptyGroup, groupedParams, paramFilter, collapsedGroups, toggleGroup]);

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

    // Smart = factory batch (policy.batch); no max-batch push until a real algo exists.
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
      specMethod: specBoostMethod,
      allParamsResolved,
      gpus,
      runningSlotsForPlan,
      vramManifest: vramCalc.manifest,
      testFlagsEnabled,
      testFlags,
      testFlagsMode,
      smartBatchPush: false,
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
    specBoostMethod,
    allParamsResolved,
    gpus,
    runningSlotsForPlan,
    vramCalc.manifest,
    testFlagsEnabled,
    testFlags,
    testFlagsMode,
  ]);

  /** HS button hint: panel model / CTX / parallel differ from the live seat. */
  const isHotSwapStale = useCallback(
    (entry: StackEntry) => {
      if (entry.status !== "RUNNING") return false;
      const norm = (p: string) => p.replace(/\\/g, "/").toLowerCase();
      if (model?.path && entry.model_path) {
        if (norm(model.path) !== norm(entry.model_path)) return true;
      }
      const panelParallel = Math.max(1, Number(config.parallel) || 1);
      const liveParallel = Math.max(1, Number(entry.parallel) || 1);
      if (panelParallel !== liveParallel) return true;
      const panelCtx = Number(config.ctx);
      if (Number.isFinite(panelCtx) && panelCtx > 0 && entry.n_ctx > 0) {
        if (panelCtx !== entry.n_ctx) return true;
      }
      return false;
    },
    [model?.path, config.parallel, config.ctx],
  );

  /** Same-port relaunch: panel model + current chip config + parallel override. */
  const hotSwapEngineSeat = useCallback(
    async (opts: { slotIdx: number; port: number; alias: string; parallel?: number }) => {
      const parallel =
        opts.parallel != null
          ? Math.max(1, opts.parallel)
          : Math.max(1, Number(config.parallel) || 1);
      await invoke("stop_engine_slot", { slotIdx: opts.slotIdx });
      await new Promise((r) => setTimeout(r, 450));
      updateParam("parallel", parallel);
      const base = buildCurrentLaunchConfig();
      if (!base) throw new Error("No model selected in panel — pick a model first.");
      const extra: Record<string, unknown> = { ...(base.extra_params || {}), parallel };
      const launched = await invoke<{ idx: number; port: number; alias: string }>("launch_engine", {
        config: {
          ...base,
          alias: opts.alias,
          port: opts.port,
          extra_params: extra,
        },
      });
      // Re-focus the replaced seat (slot index may change after stop+launch)
      const focusIdx =
        typeof launched?.idx === "number"
          ? launched.idx
          : opts.slotIdx;
      handleSelectEngine(focusIdx);
      if (launched?.port) {
        dispatchAppEvent(EVENTS.launchSuccess, {
          alias: launched.alias ?? opts.alias,
          port: launched.port,
        });
      }
    },
    [config.parallel, buildCurrentLaunchConfig, updateParam, handleSelectEngine],
  );

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

  const handleYoloLaunch = useCallback(() => {
    if (!isDevBuild()) return;
    if (!model) return;
    pulseLaunchAck();
    const fullConfig = buildCurrentLaunchConfig();
    if (!fullConfig) return;
    fullConfig.extra_params = {
      ...fullConfig.extra_params,
      __yolo_full_gpu: "1",
      __ngl: "999",
    };
    void onLaunch(fullConfig).then((result) => {
      if (result?.port) {
        dispatchAppEvent(EVENTS.launchSuccess, {
          alias: result.alias ?? fullConfig.alias,
          port: result.port,
        });
      }
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      dispatchAppEvent(EVENTS.launchError, { message: `YOLO: ${msg}` });
    });
  }, [model, pulseLaunchAck, buildCurrentLaunchConfig, onLaunch]);
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

  const handleOpenLlamaBenchCmd = useCallback(() => {
    const fullConfig = buildCurrentLaunchConfig();
    if (!fullConfig) return;
    void invoke<string>("open_llama_bench_cmd", {
      config: fullConfig,
      providerId: effectiveBackendType,
    }).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      dispatchAppEvent(EVENTS.launchError, { message: `llama-bench CMD: ${msg}` });
    });
  }, [buildCurrentLaunchConfig, effectiveBackendType]);
  const findModelForSeat = useCallback(
    (seat: LaunchSeat): ModelEntry | null => {
      const want = normalizeModelPath(seat.modelPath);
      const list = models ?? [];
      return list.find((m) => normalizeModelPath(m.path) === want) ?? null;
    },
    [models],
  );

  /**
   * Provisional VRAM reservation so the next seat's Full Auto topology
   * sees this engine before NVML/stack catch up (esp. multi-seat presets).
   */
  const syntheticSlotForLaunch = useCallback(
    (
      alias: string,
      m: ModelEntry,
      extra: Record<string, unknown> | undefined,
    ): import("../services/vram/scenarios/scenarios_factory").RunningSlotInfo => {
      const weightMib =
        m.metadata?.file_size_bytes != null
          ? m.metadata.file_size_bytes / (1024 * 1024)
          : 8192;
      // Weights + modest activation headroom — placement only, not a real FIT total.
      const est = Math.max(weightMib * 1.12, weightMib + 2048);
      const split = String(extra?.split ?? "none").trim().toLowerCase();
      const multi = split.length > 0 && split !== "none";
      if (multi && gpus.length > 1) {
        const n = gpus.length;
        return {
          alias,
          modelShort: (m.name || alias).slice(0, 30),
          vramMib: est,
          // computeGpuAvailableList matches numeric CUDA indices in the mask
          gpuMask: gpus.map((g) => String(g.index)).join(","),
          gpuBreakdownMib: gpus.map(() => est / n),
        };
      }
      const deviceStr = String(extra?.device ?? "GPU-0");
      const nvIdx = parseInt(deviceStr.replace(/^GPU-/i, "").split("/")[0] || "0", 10) || 0;
      return {
        alias,
        modelShort: (m.name || alias).slice(0, 30),
        vramMib: est,
        gpuMask: String(nvIdx),
        gpuBreakdownMib: gpus.map((g) => (g.index === nvIdx ? est : 0)),
      };
    },
    [gpus],
  );

  const launchSeat = useCallback(
    async (
      seat: LaunchSeat,
      runningSlots: import("../services/vram/scenarios/scenarios_factory").RunningSlotInfo[],
    ): Promise<{
      port: number;
      alias: string;
      idx: number;
      slotInfo: import("../services/vram/scenarios/scenarios_factory").RunningSlotInfo;
    } | null> => {
      const m = findModelForSeat(seat);
      if (!m) {
        dispatchAppEvent(EVENTS.launchError, {
          message: `Preset seat: model not in library — ${seat.modelName || seat.modelPath}`,
        });
        return null;
      }
      const policy = getLaunchPolicy(seat.policyId);
      const aliasBase =
        seat.role === "brain"
          ? "BRAIN"
          : seat.role === "worker"
            ? "WORKER"
            : (seat.label || m.name || "ENGINE").slice(0, 24);
      const finalAlias = resolveUniqueAlias(aliasBase, stack);
      const port = resolveSeatLaunchPort(seat);

      // Per-seat topology: never reuse the panel's FIT manifest (wrong model).
      // Null manifest → weight-based auto-split + freest-GPU pick vs runningSlots.
      const fullConfig = buildLaunchFullConfig({
        model: m,
        finalAlias,
        config: { ...seat.paramOverrides },
        effectiveBackendType: seat.providerId,
        selectedBinaryProfile:
          (seat.binaryProfile as typeof selectedBinaryProfile) || selectedBinaryProfile,
        fitLaunchSupported: policy.fitImplied || fitLaunchSupported,
        fullAutoMode: seat.policyId === "full_auto",
        configView: seat.policyId === "assisted_full" ? "full" : "essentials",
        essentialFactoryKeys,
        allParamsResolved,
        gpus,
        runningSlotsForPlan: runningSlots,
        vramManifest: null,
        testFlagsEnabled: false,
        testFlags: "",
        testFlagsMode: "add",
        smartBatchPush: false,
      });
      fullConfig.port = port;

      // Same path as App.handleLaunchEngine — returns StackEntry (idx, model_path, …)
      const launched = await invoke<{
        idx: number;
        port: number;
        alias: string;
        model_path?: string;
      }>("launch_engine", {
        config: fullConfig,
      });
      const alias = launched?.alias ?? finalAlias;
      const idx = typeof launched?.idx === "number" ? launched.idx : -1;
      // Catalog selection listens on engineLaunched (not launchSuccess).
      if (idx >= 0) {
        dispatchAppEvent(EVENTS.engineLaunched, {
          slotIdx: idx,
          modelPath: launched?.model_path || m.path,
        });
      }
      const slotInfo = syntheticSlotForLaunch(alias, m, fullConfig.extra_params);
      return {
        port: launched?.port ?? port,
        alias,
        idx,
        slotInfo,
      };
    },
    [
      findModelForSeat,
      stack,
      selectedBinaryProfile,
      fitLaunchSupported,
      essentialFactoryKeys,
      allParamsResolved,
      gpus,
      syntheticSlotForLaunch,
    ],
  );

  const applyComboPreset = useCallback(
    async (combo: ComboPreset, opts: { loadIntoPanel: boolean }) => {
      const available = (models ?? []).map((m) => m.path);
      const plan = resolveComboApply({
        combo,
        stack,
        availableModelPaths: available,
      });
      if (plan.errors.length) {
        dispatchAppEvent(EVENTS.launchError, {
          message: `Preset “${combo.name}”: ${plan.errors.join("; ")}`,
        });
        if (plan.launch.length === 0 && plan.bind.length === 0) return;
      }

      const bindByRole = new Map(plan.bind.map((b) => [b.role, b]));

      // Multi-seat: always sequential so Full Auto topology sees prior seats'
      // provisional VRAM (parallel dual launch both pick freest GPU → Windows RAM thrash).
      let runningAcc = [...runningSlotsForPlan];
      // Seed provisional slots for already-bound engines that lack vram_mib on stack.
      for (const b of plan.bind) {
        if (runningAcc.some((s) => s.alias === b.alias)) continue;
        const entry = stack.find((s) => s.idx === b.slotIdx);
        if (entry) {
          runningAcc.push({
            alias: entry.alias,
            modelShort: (entry.model_name || "").slice(0, 30),
            vramMib: entry.vram_mib || 0,
            gpuMask: entry.gpu || "0",
            gpuBreakdownMib: entry.gpu_breakdown_mib,
          });
        }
      }

      const ordered = orderSeatsForLaunch(
        plan.launch,
        plan.launchOrder === "sequence_brain_first",
      );

      let selectedFirst = false;
      for (let i = 0; i < ordered.length; i++) {
        const seat = ordered[i]!;
        try {
          const r = await launchSeat(seat, runningAcc);
          if (r && r.port > 0) {
            bindByRole.set(seat.role, {
              seatId: seat.id,
              role: seat.role,
              port: r.port,
              slotIdx: r.idx,
              alias: r.alias,
              modelPath: seat.modelPath,
            });
            runningAcc = [...runningAcc, r.slotInfo];
            // First seat: select for Fusion BOOT / VRAM (engineLaunched already fired).
            if (!selectedFirst && r.idx >= 0) {
              handleSelectEngine(r.idx);
              selectedFirst = true;
            }
            dispatchAppEvent(EVENTS.launchSuccess, {
              alias: r.alias,
              port: r.port,
            });
            if (i < ordered.length - 1) {
              await new Promise((res) => setTimeout(res, 400));
            }
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          dispatchAppEvent(EVENTS.launchError, {
            message: `Preset ${seat.role}: ${msg}`,
          });
        }
      }

      if (opts.loadIntoPanel && combo.seats[0]) {
        const seat = combo.seats[0];
        if (findModelForSeat(seat)) {
          updateParams(seat.paramOverrides as Record<string, unknown>);
        }
      }

      // Twin: open harness only after seats exist; lock roles so boot-time clicks
      // cannot scramble BRAIN/WORKER (re-apply preset still re-binds if needed).
      if (combo.kind === "twin") {
        const brain = bindByRole.get("brain");
        const worker = bindByRole.get("worker");
        if (brain && worker && brain.port !== worker.port) {
          setPresetTwinBind({
            brainPort: brain.port,
            workerPort: worker.port,
            agentsN: plan.agentsN,
            rolesLocked: true,
          });
        } else if (!brain || !worker) {
          dispatchAppEvent(EVENTS.launchError, {
            message: `Twin preset “${combo.name}”: need both BRAIN and WORKER running`,
          });
        }
      } else if (combo.kind === "solo" && combo.harness) {
        // Solo harness preset: open wizard in solo mode on the selected seat (optional)
        // — leave closed unless we later add solo preset open; twin is the conflict case.
      }
    },
    [
      models,
      stack,
      launchSeat,
      findModelForSeat,
      updateParams,
      runningSlotsForPlan,
      handleSelectEngine,
    ],
  );

  const handleSaveSoloPreset = useCallback(() => {
    if (!model) return;
    const name = window.prompt("Preset name (solo)", model.name || "Solo");
    if (!name?.trim()) return;
    launchPresetsApi.saveSoloFromPanel({
      name: name.trim(),
      model,
      providerId: effectiveBackendType,
      binaryProfile: selectedBinaryProfile,
      policyId: resolveLaunchPolicyId({ fullAutoMode, configView }),
      config,
    });
  }, [
    model,
    launchPresetsApi,
    effectiveBackendType,
    selectedBinaryProfile,
    fullAutoMode,
    configView,
    config,
  ]);

  const handleSaveTwinPreset = useCallback(() => {
    const running = stack.filter((s) => s.status === "RUNNING" && s.port > 0 && s.model_path);
    if (running.length < 2) {
      dispatchAppEvent(EVENTS.launchError, {
        message: "Save twin: need at least two Running engines",
      });
      return;
    }
    // Prefer preferred slot as BRAIN, else first two by idx
    let brain = running[0]!;
    let worker = running[1]!;
    if (selectedSlotIdx != null) {
      const pref = running.find((s) => s.idx === selectedSlotIdx);
      if (pref) {
        brain = pref;
        worker = running.find((s) => s.idx !== pref.idx) ?? worker;
      }
    }
    const name = window.prompt(
      "Preset name (twin)",
      `${brain.model_name || "BRAIN"} + ${worker.model_name || "WORKER"}`,
    );
    if (!name?.trim()) return;
    // Default product: parallel cold launch. Optional sequence BRAIN first.
    const sequenceBrainFirst = window.confirm(
      "Cold launch order for this twin preset:\n\nOK = Sequence BRAIN first\nCancel = Parallel (recommended default)",
    );
    launchPresetsApi.saveTwinFromStack({
      name: name.trim(),
      brain,
      worker,
      sequenceBrainFirst,
      panelConfig: config,
      panelModelPath: model?.path,
    });
  }, [stack, selectedSlotIdx, launchPresetsApi, config, model?.path]);

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

  // Custom providers: never hard-block on VRAM forecast / HW_LOCKED (soft warn only).
  // Soft message can show while fits=false; button must stay clickable.
  const launchDisabled =
    !model
    || modelIsDraftOnly
    || (specNeedsExternalDraft && !draftPathValid)
    || selectedProfileIsBuilding
    || (
      !isCustomProvider
      && !softLaunchForecast
      && (
        vramCalc.manifest?.scenario === "HW_LOCKED"
        || (vramCalc.manifest != null && !vramCalc.manifest.fits)
      )
    );

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
              {setupGuide.showWelcome ? (
                <WelcomeAnimation onComplete={setupGuide.completeWelcome} />
              ) : (
                <SetupGuideDisplay
                  phase={setupGuide.phase}
                  pathsDone={setupGuide.pathsDone}
                  runtimeReady={setupGuide.runtimeReady}
                  toolchainChecked={setupGuide.toolchainChecked}
                  modelsDeferred={setupGuide.modelsDeferred}
                  metaDone={setupGuide.metaDone}
                  metaScanFailed={setupGuide.metaScanFailed}
                  modelsCount={setupGuide.modelsCount}
                  scannedCount={setupGuide.scannedCount}
                  catalogLoaded={setupGuide.catalogLoaded}
                  onDeferModels={setupGuide.deferModels}
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
      data-hw-monitor-dock={hwMonitorDock}
      data-engines-in-rail={enginesInRail ? "true" : "false"}
    >
      <div
        ref={launchDockMainRef}
        className={`config-panel-body flex flex-1 min-h-0 min-w-0${
          showRightColumn ? " config-panel-body--split" : " config-panel-body--stacked"
        }`}
        data-monitor-focus={fusionDisplay.monitorFocus ? "1" : undefined}
      >
        <div className="config-panel-center-stack flex flex-col flex-1 min-h-0 min-w-0">
          <div ref={launchRailTopChromeMeasureRef} className="config-panel-top-chrome flex-shrink-0">
        <EngineProviderProfileBar
          providers={resolvedProviders}
          selectedProvider={selectedProvider}
          onSelectProvider={(id) => {
            setSelectedProvider(id);
            writeStorage(KEYS.lastProvider, id);
            dispatchAppEvent(EVENTS.providerChanged, { providerId: id });
          }}
          builtProfiles={builtProfiles}
          selectedBinaryProfile={selectedBinaryProfile}
          onSelectProfile={setSelectedBinaryProfile}
          isProfileBuilding={isProfileBuilding}
        />

      {/*
        Above-config zone (near VRAM): pin-above chip groups + optional CTX strip.
        Full Auto hides chip groups; CTX can still dock here when not embedded in cockpit.
      */}
      {(showCtxAboveConfig || (aboveGroupKeys.length > 0 && !fullAutoFixed)) && (
        <div
          className={`config-params-above-shell relative${paramsBypassedClass}${
            showCtxAboveConfig ? " config-params-above-shell--with-ctx" : ""
          }`}
        >
          {showCtxAboveConfig && (
            <div className="config-params-above-ctx px-3 pb-1.5 min-w-0">
              <CockpitCtxStrip {...ctxStripProps} className="w-full" />
            </div>
          )}
          {aboveGroupKeys.length > 0 && !fullAutoFixed && (
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
                return renderParamGroup(paramGroupsCtx, group, "above", { groupIdx });
              }}
            />
          )}
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
      <EngineGpuForecast
        displayMeasureRef={hwMonitorOpen || showLaunchRail ? launchRailDisplayMeasureRef : undefined}
        onboardingArea={onboardingDisplay.area}
        onboardingFrame={onboardingDisplay.frame}
        displayTexture={displayTexture}
        fitLaunchSupported={fitLaunchSupported}
        fullAutoMode={fullAutoMode}
        onFitLaunchChange={(nextFullAuto) => {
          setFullAuto(nextFullAuto);
          if (nextFullAuto) {
            updateParam("split", "none");
            if (String(config["offload_mode"] ?? "regular").toLowerCase() === "moe_optimal") {
              updateParam("offload_mode", "regular");
            }
          }
        }}
        showFitOrDeviceChrome={!modelIsDraftOnly && (fitLaunchSupported || Boolean(model && gpus.length > 0))}
        showGpuAssign={Boolean(model && !modelIsDraftOnly && gpus.length > 0 && !fullAutoMode)}
        gpus={gpus}
        deviceValue={config.device}
        splitValue={config.split}
        splitValues={splitParamDef?.values?.length ? splitParamDef.values : ["none", "layer", "row", "tensor"]}
        launchChrome={launchChrome}
        hideTensorSplit={!tensorSplitSupported && !isCustomProvider}
        onDeviceChange={(v) => {
          if (launchChrome.chromeDisabled || launchChrome.deviceLocked) return;
          updateParam("device", v);
          if (isSplitModeActive(config.split)) updateParam("split", "none");
        }}
        onSplitChange={(v) => {
          if (launchChrome.chromeDisabled || launchChrome.splitLocked) return;
          updateParam("split", v);
        }}
        onDeviceSelect={(gpuIndex) => {
          if (launchChrome.chromeDisabled || launchChrome.deviceLocked) return;
          updateParam("device", `GPU-${gpuIndex}`);
          if (isSplitModeActive(config.split)) {
            updateParam("split", "none");
          }
        }}
        showChromeHints={showChromeHints}
        manifest={vramCalc.manifest}
        selectedGpuIndices={selectedGpuIndices}
        isValidating={vramCalc.isValidating}
        onValidate={vramCalc.validate}
        onYoloLaunch={isDevBuild() ? handleYoloLaunch : undefined}
        isModelRunning={isModelRunning}
        activeEngineAlias={activeEngineAlias}
        activeEnginePort={activeEnginePort}
        selectedSlotIdx={selectedSlotIdx}
        supportsFusion={supportsFusion}
        engineStatus={selectedSlotIdx != null && selectedSlotIdx >= 0 ? stack.find((s) => s.idx === selectedSlotIdx)?.status : undefined}
        booterProps={booterProps}
        offloadMode={config["offload_mode"]}
        onMoeSuggestionClick={() => {
          updateParam("offload_mode", config["offload_mode"] === "moe_optimal" ? "regular" : "moe_optimal");
        }}
        hideMoeBadge
        draftOnly={modelIsDraftOnly}
        modelMeta={model?.metadata}
        modelName={model?.name}
        modelQuant={model?.quant}
        shareProfileMeta={shareProfileMeta}
        shareLaunchConfig={shareLaunchConfig}
        shareHwTopo={shareHwTopo}
        gpuIdleBaselineMib={gpuIdleBaselineMib}
        showEjectBelowVram={showEjectBelowVram}
        stack={stack}
        models={models}
        onSelectEngine={handleSelectEngine}
        isHotSwapStale={isHotSwapStale}
        onHotSwap={(entry) => {
          void hotSwapEngineSeat({
            slotIdx: entry.idx,
            port: entry.port,
            alias: entry.alias,
          }).catch((e) => {
            dispatchAppEvent(EVENTS.launchError, {
              message: `Hot-swap failed: ${String(e)}`,
            });
          });
        }}
        dualActive={fusionDisplay.dualActive}
        dualArmed={fusionDisplay.dualArmed}
        canDual={fusionDisplay.canDual}
        dualOrient={fusionDisplay.orient}
        onToggleDual={fusionDisplay.toggleDual}
        onToggleOrient={fusionDisplay.toggleOrient}
        secondarySlotIdx={fusionDisplay.secondarySlotIdx}
        onPinSecondary={fusionDisplay.pinSecondaryOrCycle}
        monitorFocus={fusionDisplay.monitorFocus}
        onToggleMonitor={() => {
          const next = !fusionDisplay.monitorFocus;
          fusionDisplay.setMonitorFocus(next);
        }}
      />

      {/*
        Toolbar host: carries the monitor-hidden class so MONITOR drops the
        layout panel. HW-below stays a SIBLING (visible in MONITOR) and the
        params column below keeps the main-column class.
      */}
      <div className="config-panel-center flex flex-col flex-shrink-0 min-h-0 min-w-0">
      <EngineToolbar
        fullAutoFixed={fullAutoFixed}
        configView={configView}
        onConfigViewChange={(view) => {
          setConfigViewMode(view);
          if (view === "essentials") {
            setTestFlagsEnabled(false);
            setCustomFlagsEditorOpen(false);
          }
        }}
        ctxCockpitDock={ctxCockpitDock}
        onToggleCtxDock={() => {
          const next = ctxCockpitDock === "cockpit" ? "above" : "cockpit";
          setCtxCockpitDock(next);
          saveCtxCockpitDock(next);
        }}
        launchDockPosition={launchDockPosition}
        launchDockPositionExplicit={launchDockPositionExplicit}
        onToggleLaunchDockPosition={toggleLaunchDockPosition}
        hwMonitorOpen={hwMonitorOpen}
        hwMonitorDock={hwMonitorDock}
        onCycleHwMonitor={cycleHwMonitor}
        showLaunchRail={showLaunchRail}
        enginesInRail={enginesInRail}
        onToggleEnginesInRail={toggleEnginesInRail}
        hasParams={allParamsForDisplay.length > 0}
        columnCount={columnCount}
        onSetColumnCount={setBelowColumnCount}
        layoutModeActive={layoutModeActive}
        onToggleLayoutMode={toggleLayoutMode}
        presetsSlot={
          <LaunchPresetsMenu
            combos={launchPresetsApi.combos}
            canSaveSolo={Boolean(model)}
            canSaveTwin={
              stack.filter((s) => s.status === "RUNNING" && s.port > 0).length >= 2
            }
            onApply={requestApplyCombo}
            onSaveSolo={handleSaveSoloPreset}
            onSaveTwin={handleSaveTwinPreset}
            onManage={() => setPresetsManageOpen(true)}
          />
        }
      />
      </div>

      {hwBelowDisplay && (
        <div className="config-hw-below-display min-h-0 flex-shrink-0">
          <LaunchRailTelemetry layout="below" />
        </div>
      )}

      <div
        className={
          launchDockPosition === "right"
            ? "config-rail-main-column flex flex-col flex-1 min-h-0 min-w-0"
            : `config-panel-center flex flex-col min-h-0 ${launchDockPosition === "bottom" ? "flex-1" : ""}`
        }
      >

      {/*
        Unified scroll column: cockpit + (Assisted) chip groups + open harness.
        Full Auto = hero cockpit only. Assisted Essentials = command cockpit + essentials.
        Assisted Full = compact power cockpit (no Smart) + full chips.
      */}
      <div
        className={`config-params-scroll px-4 py-3 relative flex-1 overflow-y-auto eink-scrollbar eink-panel min-h-0${
          atomcodeHarnessOpen ? " config-params-scroll--atomcode-wizard" : ""
        }`}
      >
        {model && !modelIsDraftOnly && !showCockpitSurface && isCustomProvider && (
          <div className="mb-3 pb-3 border-b section-divider px-1">
            <p className="text-[9px] font-mono config-muted leading-relaxed">
              Cockpit controls bind to Master param keys (ctx, parallel, kv_quant, reasoning…).
              Add them via CONFIG catalog or <span className="text-white/70">Starter pack</span>.
            </p>
          </div>
        )}
        <EngineBoostSection
          show={Boolean(model && !modelIsDraftOnly && showCockpitSurface)}
          wrapperClass={
            atomcodeHarnessOpen
              ? "mb-0 min-h-0 flex-1"
              : fullAutoFixed
                ? "mb-3"
                : "mb-3 pb-3 border-b section-divider"
          }
          codingMode={codingMode}
          speedBoost={speedBoost}
          brains={brains}
          think={think}
          applyCockpit={applyFullAutoCockpit}
          cockpitOpts={cockpitOpts}
          capabilities={specCapabilities}
          dflashLibraryReady={dflashLibraryReady}
          dflashGettable={dflashGettable}
          dflashDraftLabel={dflashDraftLabel}
          dflashGetState={dflashGetState}
          dflashGetError={dflashGetError}
          dflashGetOfferLabel={dflashGetOfferLabel}
          onGetDflashDraft={() => { void handleGetDflashDraft(); }}
          onChangeDflashDraft={handleChangeDflashDraft}
          kvQuantValues={cockpitKvValuesBound}
          parallelValues={cockpitParallelValues}
          showAgents={cockpitShowAgents}
          showMemory={cockpitShowMemory}
          showThink={cockpitShowThink}
          showBoost={cockpitShowBoost}
          flagToggles={cockpitFlagToggles}
          launchPresets={{
            combos: launchPresetsApi.combos,
            onApply: requestApplyCombo,
            onSaveTwin: handleSaveTwinPreset,
            onManage: () => setPresetsManageOpen(true),
            canSaveTwin:
              stack.filter((s) => s.status === "RUNNING" && s.port > 0).length >= 2,
          }}
          presetTwinBind={presetTwinBind}
          onPresetTwinBindConsumed={() => setPresetTwinBind(null)}
          agentsFromTemplateOnly={isCustomProvider}
          port={
            (selectedSlotIdx != null &&
              stack.find((s) => s.idx === selectedSlotIdx && s.status === "RUNNING")?.port) ||
            Number(config.base_port) ||
            9090
          }
          modelId={
            (selectedSlotIdx != null &&
              stack.find((s) => s.idx === selectedSlotIdx)?.model_name) ||
            aliasDisplayValue ||
            autoAlias ||
            model?.name ||
            "local-model"
          }
          stack={stack}
          preferredSlotIdx={selectedSlotIdx ?? null}
          onHarnessOpenChange={setAtomcodeHarnessOpen}
          onRelaunchSeat={async ({ slotIdx, port, alias, parallel }) => {
            await hotSwapEngineSeat({ slotIdx, port, alias, parallel });
          }}
          onSelectEngine={handleSelectEngine}
          layout={fullAutoFixed ? "hero" : "normal"}
          powerMode={powerCockpitMode}
          rawSpecTypes={factoryRawSpecTypes}
          activeRawSpecType={activeRawSpecType}
          onRawSpecType={(raw) => {
            // Raw factory types only — product Off/MTP/DFlash use onSpeedBoost alone.
            if (raw == null) return;
            void applyFullAutoCockpit(codingMode, "off", brains, think, {
              powerUser: true,
              rawSpecType: raw,
            });
          }}
          specDetailParams={cockpitSpecDetailParams}
          embedCtx={ctxDockedInCockpit}
          ctxStripProps={ctxStripProps}
        />
        {model && (
          <DraftPickModal
            open={dflashPickOpen}
            mode={dflashPickMode}
            mainLabel={dflashMainDescribe ?? undefined}
            localItems={dflashLocalPickItems}
            initialSelectedId={dflashPickInitialSelectedId}
            hfOffers={dflashCandidates}
            remoteLoading={dflashGetState === "searching"}
            resolving={dflashResolving}
            resolveError={dflashResolveError}
            onCancel={handleCancelDflashPick}
            onConfirmHf={(offer) => { void handleConfirmDflashPick(offer); }}
            onConfirmManual={(id) => { void handleConfirmDflashManual(id); }}
            onConfirmLibrary={handleConfirmLibraryDraft}
            onRequestRemote={() => { void loadDflashHfCandidates(); }}
          />
        )}

        {!fullAutoFixed && !atomcodeHarnessOpen && (
          <div className="config-detailed-panel mb-1.5 border border-stealth-border/30 rounded-sm">
            <div className="config-detailed-panel__row flex items-center gap-1.5">
              <span className="config-detailed-panel__label text-[8px] font-mono tracking-widest uppercase text-stealth-muted/70 flex-shrink-0">
                DETAILED CONFIG
              </span>
              <span className="config-panel-toolbar__sep mx-1 h-3 w-px flex-shrink-0" />
              <button
                type="button"
                onClick={() => setShowEngineCatalogSearch(true)}
                className="config-panel-toolbar-chip px-1.5 py-0.5 text-[8px] font-mono rounded-sm flex-shrink-0"
                title="Add any parameter from the live catalog"
              >
                + PARAM CATALOG
              </button>
              {allParamsForDisplay.length > 0 && (
                <input
                  type="search"
                  value={paramFilter}
                  onChange={(e) => setParamFilter(e.target.value)}
                  placeholder="Filter…"
                  className="config-panel-param-filter w-[7.5rem] max-w-[40%] bg-[color-mix(in_srgb,var(--theme-panel-accent,#040b01)_88%,transparent)] border border-stealth-border/30 rounded-sm px-1.5 py-0.5 text-[8px] font-mono text-nv-green/90 placeholder:text-stealth-muted/35 focus:outline-none focus:border-nv-green/40 shadow-sm flex-shrink-0"
                  title="Filter chip groups by name or key (local — not model search)"
                />
              )}
            </div>
          </div>
        )}

        {/* Engine chips hidden while harness wizard owns the panel */}
        {!fullAutoFixed && !atomcodeHarnessOpen && (
          <div className={paramsBypassedClass}>
            {allParamsForDisplay.length === 0 ? (
              <div className="text-stealth-muted text-[10px] font-mono opacity-50">NO PARAMS DEFINED</div>
            ) : belowGroupKeys.length === 0 ? null : !filteredBelowHasAny ? (
              <div className="text-stealth-muted text-[10px] font-mono opacity-50">
                NO PARAMS MATCH “{paramFilter.trim()}”
              </div>
            ) : (
              <ConfigBelowGroups
                columnCount={columnCount}
                columnWidths={columnWidths}
                belowGroupsByColumn={filteredBelowGroupsByColumn}
                onGutterDragStart={handleGutterDragStart}
                draggingGutterIndex={draggingGutterIndex}
                layoutModeActive={layoutModeActive}
                renderGroup={(groupId) => {
                  const group = belowGroupMetaById.get(groupId);
                  if (!group) return null;
                  return renderParamGroup(paramGroupsCtx, group, "below", undefined);
                }}
              />
            )}

            {uiDensityCompact && configView === "full" && launchDockPosition === "bottom" && !launchDockCollapsed ? (
              <div className="config-launch-dock__flags-scroll">{renderCustomFlagsBlock()}</div>
            ) : null}
          </div>
        )}
      </div>

      {launchDockPosition === "bottom" && (
        <EngineLaunchDock
          position="bottom"
          atomcodeHarnessOpen={atomcodeHarnessOpen}
          showRightColumn={showRightColumn}
          launchDockCollapsed={launchDockCollapsed}
          onExpandCollapsedDock={() => {
            setLaunchDockCollapsed(false);
            saveLaunchDockCollapsed(false);
          }}
          specParallelWarn={specParallelWarn}
          mtpParallelSlotCount={mtpParallelSlotCount}
          fullAutoFixed={fullAutoFixed}
          modelIsDraftOnly={modelIsDraftOnly}
          renderCustomFlags={renderCustomFlagsBlock}
          uiDensityCompact={uiDensityCompact}
          configView={configView}
          aliasDisplayValue={aliasDisplayValue}
          aliasIsUserSet={aliasIsUserSet}
          aliasShowClr={aliasShowClr}
          autoAlias={autoAlias}
          onAliasChange={(v) => setAliasInput(v)}
          onAliasFocus={handleAliasFocus}
          onAliasBlur={handleAliasBlur}
          onAliasClear={handleAliasClear}
          portRow={basePortParamDef ? renderParamRow(paramGroupsCtx, basePortParamDef, false, 0) : null}
          isDev={isDevBuild()}
          onOpenNobsproofCmd={handleOpenNobsproofCmd}
          onOpenLlamaBenchCmd={handleOpenLlamaBenchCmd}
          launchDisabled={launchDisabled}
          replaceLaunchConfirmOpen={replaceLaunchConfirmOpen}
          onCancelReplaceLaunch={() => setReplaceLaunchConfirmOpen(false)}
          acknowledgeReplaceLaunch={acknowledgeReplaceLaunch}
          onLaunchClick={handleAddToStack}
          launchAck={launchAck}
          customFlagsReplaceActive={customFlagsReplaceActive}
          customFlagsLaunchActive={customFlagsLaunchActive}
          isCustomProvider={isCustomProvider}
          hasModel={Boolean(model)}
          selectedProfileIsBuilding={selectedProfileIsBuilding}
          specNeedsExternalDraft={specNeedsExternalDraft}
          draftPathValid={draftPathValid}
          enginesInRail={enginesInRail}
          stack={stack}
          models={models}
          selectedSlotIdx={selectedSlotIdx ?? null}
          onSelectEngine={handleSelectEngine}
          secondarySlotIdx={fusionDisplay.secondarySlotIdx}
          onPinSecondary={fusionDisplay.pinSecondaryOrCycle}
          isHotSwapStale={isHotSwapStale}
          onHotSwap={(entry) => {
            void hotSwapEngineSeat({
              slotIdx: entry.idx,
              port: entry.port,
              alias: entry.alias,
            }).catch((e) => {
              dispatchAppEvent(EVENTS.launchError, {
                message: `Hot-swap failed: ${String(e)}`,
              });
            });
          }}
        />
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
            {hwInRail && (
              <div className="launch-rail-telemetry flex-1 min-h-0 overflow-hidden">
                <LaunchRailTelemetry layout="rail" />
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
              <EngineLaunchDock
                position="right"
                specParallelWarn={specParallelWarn}
                mtpParallelSlotCount={mtpParallelSlotCount}
                fullAutoFixed={fullAutoFixed}
                modelIsDraftOnly={modelIsDraftOnly}
                renderCustomFlags={renderCustomFlagsBlock}
                uiDensityCompact={uiDensityCompact}
                configView={configView}
                aliasDisplayValue={aliasDisplayValue}
                aliasIsUserSet={aliasIsUserSet}
                aliasShowClr={aliasShowClr}
                autoAlias={autoAlias}
                onAliasChange={(v) => setAliasInput(v)}
                onAliasFocus={handleAliasFocus}
                onAliasBlur={handleAliasBlur}
                onAliasClear={handleAliasClear}
                portRow={basePortParamDef ? renderParamRow(paramGroupsCtx, basePortParamDef, false, 0) : null}
                isDev={isDevBuild()}
                onOpenNobsproofCmd={handleOpenNobsproofCmd}
                onOpenLlamaBenchCmd={handleOpenLlamaBenchCmd}
                launchDisabled={launchDisabled}
                replaceLaunchConfirmOpen={replaceLaunchConfirmOpen}
                onCancelReplaceLaunch={() => setReplaceLaunchConfirmOpen(false)}
                acknowledgeReplaceLaunch={acknowledgeReplaceLaunch}
                onLaunchClick={handleAddToStack}
                launchAck={launchAck}
                customFlagsReplaceActive={customFlagsReplaceActive}
                customFlagsLaunchActive={customFlagsLaunchActive}
                isCustomProvider={isCustomProvider}
                hasModel={Boolean(model)}
                selectedProfileIsBuilding={selectedProfileIsBuilding}
                specNeedsExternalDraft={specNeedsExternalDraft}
                draftPathValid={draftPathValid}
                enginesInRail={enginesInRail}
                stack={stack}
                models={models}
                selectedSlotIdx={selectedSlotIdx ?? null}
                onSelectEngine={handleSelectEngine}
                secondarySlotIdx={fusionDisplay.secondarySlotIdx}
                onPinSecondary={fusionDisplay.pinSecondaryOrCycle}
                isHotSwapStale={isHotSwapStale}
                onHotSwap={(entry) => {
                  void hotSwapEngineSeat({
                    slotIdx: entry.idx,
                    port: entry.port,
                    alias: entry.alias,
                  }).catch((e) => {
                    dispatchAppEvent(EVENTS.launchError, {
                      message: `Hot-swap failed: ${String(e)}`,
                    });
                  });
                }}
              />
            )}
            </div>
          </div>
        </>
      )}
      </div>

      {showEngineCatalogSearch && (
        <ParamCatalogSearch
          providerId={effectiveBackendType}
          existingKeys={allParamsResolved.map((d) => d.key)}
          existingParams={allParamsResolved.map((d) => ({
            key: d.key,
            flag: d.flag,
            ui_group: d.ui_group,
          }))}
          blockedKeys={[
            ...SYSTEM_CATALOG_PARAM_KEYS,
            ...COCKPIT_OWNED_PARAM_KEYS,
            ...allParamsResolved.filter((d) => isPlacementChromeParam(d)).map((d) => d.key),
          ]}
          onAdd={(entry) => { void handleEngineCatalogAdd(entry); }}
          onClose={() => setShowEngineCatalogSearch(false)}
        />
      )}

      <ParamPlaceDialog
        open={catalogPlaceKey != null}
        paramKey={catalogPlaceKey}
        group={catalogPlaceGroup}
        groupNames={existingGroupNames}
        onGroupChange={setCatalogPlaceGroup}
        onClose={() => setCatalogPlaceKey(null)}
        onConfirm={() => { void handleCatalogPlaceConfirm(); }}
      />

      <LaunchPresetsModal
        open={presetsManageOpen}
        combos={launchPresetsApi.combos}
        models={models ?? []}
        onClose={() => setPresetsManageOpen(false)}
        onSave={(c) => {
          launchPresetsApi.upsert(c);
        }}
        onDelete={(id) => launchPresetsApi.remove(id)}
        onDuplicate={(c) => launchPresetsApi.duplicate(c)}
        onApply={(c, o) => {
          setPresetsManageOpen(false);
          requestApplyCombo(c, o);
        }}
      />

      <LaunchPresetConfirmModal
        open={presetConfirm != null}
        combo={presetConfirm?.combo ?? null}
        loadIntoPanel={presetConfirm?.loadIntoPanel ?? false}
        models={models ?? []}
        onLoadIntoPanelChange={(v) =>
          setPresetConfirm((prev) => (prev ? { ...prev, loadIntoPanel: v } : prev))
        }
        onCancel={() => setPresetConfirm(null)}
        onConfirm={() => {
          const pending = presetConfirm;
          setPresetConfirm(null);
          if (pending) void applyComboPreset(pending.combo, { loadIntoPanel: pending.loadIntoPanel });
        }}
      />
    </div>
  );
}