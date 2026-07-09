// Model-specific parameter configuration and launch control.

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ConfigViewMode, ModelEntry, EngineConfig, GpuInfo, UserEditedTemplateParam, ProviderConfig, ProviderTemplate, StackEntry, SystemInfo } from "../lib/types";
import { DEFAULT_PROVIDER_ID, isProfileBuilt, profileEnvLookup } from "../lib/types";
import {
  KEYS,
  binaryProfileKey,
  engineAliasKey,
  loadAutoVramEnabled,
  loadConfigView,
  loadUiDensity,
  normalizeUiGroup,
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
import { dispatchAppEvent, EVENTS } from "../lib/events";
import { tomMtpBlocked, TOM_MTP_SKIP_MESSAGE } from "../lib/tomMtp";
import { DEFAULT_BINARY_PROFILE, ENV_META, ENV_ORDER, normalizeBinaryProfile, type Env, isDriverSufficientForProfile, getMinDriverMajorForCuda } from "../lib/foundry_constants";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import VramBadge from "./VramBadge";
import WelcomeAnimation from "./onboarding/WelcomeAnimation";
import SetupGuideDisplay from "./onboarding/SetupGuideDisplay";
import RunningEnginesPanel from "./RunningEnginesPanel";
import SliderParam from "./SliderParam";
import { formatTokenLabel } from "../lib/sliderParamUtils";
import { useScenarioEvaluator } from "../hooks/useScenarioEvaluator";
import type { SetupGuideState } from "../hooks/useSetupGuide";
import { useConfigResolver } from "../hooks/useConfigResolver";
import { useDisplayTexture } from "../context/DisplayTextureContext";

import DisplayGlitchOverlay from "./DisplayGlitchOverlay";
import { useFoundry } from "../hooks/useBuildDock";
import { buildAutoVramLaunchParams } from "../lib/autoVramLaunch";
import { resolveLaunchChromePolicy } from "../lib/launchChromePolicy";
import { buildLaunchExtraParams, paramValuesMatch } from "../lib/paramConfigResolve";
import { committedSlotsFromStack } from "../services/vram/scenarios/scenarios_factory";
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

function mtpParallelConflict(
  model: { metadata?: { nextn_predict_layers?: number } } | null | undefined,
  params: UserEditedTemplateParam[],
  config: Record<string, unknown>,
): boolean {
  if ((model?.metadata?.nextn_predict_layers ?? 0) <= 0) return false;
  if (!isSpecDecodingActive(params)) return false;
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
  const { model, gpus, providers: externalProviders, committedVramMib, systemInfo, stack, onLaunch, isModelRunning, activeEngineAlias, activeEnginePort, selectedSlotIdx, supportsFusion = true, models, onSelectEngine, setupGuide } = props;
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

  // Test flags mode: "add" (prepend to config) or "replace" (bypass all params)
  const [testFlagsMode, setTestFlagsMode] = useState<"add" | "replace">(() => {
    return readStorage(KEYS.testFlagsMode) === "add" ? "add" : "replace";
  });

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
  const [layoutModeActive, setLayoutModeActive] = useState(
    () => readStorage(KEYS.configLayoutMode) === "1",
  );
  const [uiDensityCompact, setUiDensityCompact] = useState(
    () => loadUiDensity() === "compact",
  );

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

  const specActive = useMemo(
    () => isSpecDecodingActive(allParamsResolved),
    [allParamsResolved],
  );

  const allParamsForDisplay = useMemo(() => {
    if (configView === "full") return allParamsResolved;
    return allParamsResolved.filter((d) => isEssentialParam(d, essentialFactoryKeys));
  }, [allParamsResolved, configView, essentialFactoryKeys]);

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

  const mtpParallelWarn = useMemo(
    () => mtpParallelConflict(model, allParamsResolved, config),
    [model, allParamsResolved, config],
  );
  const mtpParallelSlotCount = useMemo(
    () => resolveParallelSlots(config, allParamsResolved),
    [config, allParamsResolved],
  );

  const customFlagsBlock = useMemo(() => {
    if (configView !== "full") return null;
    return (
      <div className={`custom-flags-block border rounded-sm overflow-hidden ${testFlagsEnabled ? "custom-flags-active" : ""}`}>
        <div className="custom-flags-body px-2 py-1 flex items-center gap-1.5 min-h-0">
          <span className="text-[8px] font-mono uppercase tracking-wider shrink-0 custom-flags-label">
            CUSTOM FLAGS
          </span>
          {testFlagsEnabled && (
            <input
              type="text"
              value={testFlags}
              onChange={(e) => setTestFlags(e.target.value)}
              placeholder="-sm layer -smf32 1 ..."
              className="custom-flags-input flex-1 min-w-0 border text-[8px] font-mono px-2 py-0 leading-none focus:outline-none rounded-sm border-amber-600/30 focus:border-amber-600/50 placeholder:text-stealth-muted/40"
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
              onClick={() => setTestFlagsEnabled((v) => !v)}
              className={`px-1.5 py-0 text-[7px] font-mono border rounded-sm transition-all duration-150 cursor-pointer ${
                testFlagsEnabled ? "mode-btn-add" : "mode-btn-off"
              }`}
            >
              {testFlagsEnabled ? "ON" : "OFF"}
            </button>
          </div>
        </div>
      </div>
    );
  }, [configView, testFlags, testFlagsEnabled, testFlagsMode]);

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
    const baseValues = allValues.filter(v => !(def.hiddenValues || []).some(hv => String(hv) === String(v)));
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
        <div key={paramRowKey(def, rowIdx)} data-param-row className={`flex items-center min-h-[28px] ${isLocked ? "opacity-50" : ""}`}>
          {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 bg-yellow-400/40 mr-1.5" />}
          {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />}
          <span
            className={`font-mono flex-shrink-0 uppercase tracking-wider text-[9px] flex items-center gap-1.5 min-w-0 leading-none ${def.key === "ctx" && ctxPerSlot > 0 ? "w-auto max-w-[40%]" : "w-24 truncate"} ${isUserAdded ? "text-yellow-400/80" : "text-stealth-muted"}`}
            title={def.key === "ctx" && ctxPerSlot > 0
              ? `${formatTokenLabel(ctxNumeric)} ÷ ${ctxSlotCount} slots = ${formatTokenLabel(ctxPerSlot)} per slot`
              : def.label}
          >
            <span className="truncate">{def.label}</span>
          </span>
          <div className="ctx-slider-field flex-1 min-w-0">
            <SliderParam
              paramKey={def.key}
              currentValue={currentValue}
              defaultValue={def.defaultValue}
              onChange={(v) => updateParam(def.key, v)}
              step={def.step ?? 1024}
              values={baseValues}
              perSlotReserve={ctxSlotCount > 1}
              perSlotLabel={
                ctxPerSlot > 0 ? formatTokenLabel(ctxPerSlot) : undefined
              }
              perSlotTitle={
                ctxPerSlot > 0
                  ? `Per slot: ${formatTokenLabel(ctxNumeric)} ÷ ${ctxSlotCount}`
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
          {def.label}
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
              }}
              className={paramChipClass(paramValuesMatch(currentValue, val))}
            >
              {String(val)}
            </button>
          ))}
        </div>
      </div>
    );
  }, [config, gpus.length, providerDefaultKeys, updateParam, allParamsResolved]);

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

  const isMtpModel = (model?.metadata?.nextn_predict_layers ?? 0) > 0;

  const isGroupVisible = useCallback(
    (groupId: string) => {
      if ((groupedParams[groupId]?.length ?? 0) > 0) return true;
      if (
        groupId === SPEC_DECODING_GROUP &&
        isMtpModel &&
        allParamsResolved.some((d) => paramUiGroup(d.ui_group) === SPEC_DECODING_GROUP)
      ) {
        return true;
      }
      return layoutModeActive && isGroupFullyHidden(groupId, allGroupedParams);
    },
    [groupedParams, isMtpModel, allParamsResolved, layoutModeActive, allGroupedParams],
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
      const specVisibleParams = specAllParams.filter((d) => !d.hidden);
      const allHidden = specAllParams.every((d) => d.hidden);
      const specActive = isMtpModel ? !allHidden : false;

      return (
        <div key={group.id}>
          <div
            data-param-row
            className={`nuclear-btn-container config-spec-decoding config-section-row flex items-center gap-1 ${specFlash ? "flash" : ""} ${draggingGroup === group.id ? "config-group-header--dragging" : ""}`}
          >
            <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />
            <span className={SECTION_LABEL_CLASS}>SPECULATIVE DECODING</span>
            <div className="flex flex-1 min-w-0 items-center">
              <label className={`toggle-switch ${!isMtpModel ? "opacity-40 pointer-events-none" : ""}`}>
                <input
                  type="checkbox"
                  className="toggle-input"
                  checked={specActive}
                  disabled={!isMtpModel}
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
            </div>
            {renderGroupLayoutControls(group.id, zone, { hideHideToggle: true })}
          </div>

          {isMtpModel && specActive && (
            <div className="rounded-sm px-3 py-2 text-[8px] font-mono tracking-wide uppercase flex items-center gap-1 text-nv-green">
              Speculative mode active
            </div>
          )}

          {isMtpModel && specActive && specVisibleParams.length > 0 && (
            <div className="config-spec-params space-y-2.5 mt-2">
              {specVisibleParams.map((def, i) => (
                <div key={paramRowKey(def, i)} className="spec-param-unlock" style={{ opacity: 0 }}>
                  {renderParamRow(def, false, i)}
                </div>
              ))}
            </div>
          )}

          {!isMtpModel && (
            <div className="text-[8px] font-mono text-stealth-muted/30 tracking-wider uppercase mt-1 ml-2">
              Requires an MTP model for speculative decoding
            </div>
          )}

          {isMtpModel && !specActive && specAllParams.length > 0 && (
            <div className="text-[8px] font-mono text-stealth-muted/30 tracking-wider uppercase mt-1 ml-2">
              {specAllParams.length} parameter{specAllParams.length > 1 ? "s" : ""} locked — activate to configure
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
    isMtpModel,
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

  const handleAddToStack = useCallback(() => {
    if (!model) return;
    if (selectedProfileIsBuilding) return;
    if (tomMtpBlocked(effectiveBackendType, model)) {
      dispatchAppEvent(EVENTS.launchError, { message: TOM_MTP_SKIP_MESSAGE });
      return;
    }
    const now = Date.now();
    if (now - lastLaunchAtRef.current < 60) return;
    lastLaunchAtRef.current = now;
    pulseLaunchAck();

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
    const persistAliasAtLaunch = launchUserSet;
    const aliasToPersist = launchAlias;

    const launchKeys = resolveManualLaunchKeys({
      configView,
      essentialFactoryKeys,
      specActive,
      allParams: allParamsResolved,
    });

    const extraParams: Record<string, unknown> = fitLaunchSupported && model.metadata
      ? buildAutoVramLaunchParams({
          config,
          launchKeys,
          paramDefs: allParamsResolved,
          gpus,
          runningSlots: runningSlotsForPlan,
          manifest: vramCalc.manifest,
          weightGb: model.metadata.file_size_bytes / (1024 ** 3),
          fullAutoMode,
          memoryMode: fullAutoMode ? "full_auto" : "assisted",
        })
      : buildLaunchExtraParams({
          config,
          keys: launchKeys,
          paramDefs: allParamsResolved,
        });

    const fullConfig: EngineConfig = {
      alias: finalAlias,
      model_path: model.path,
      port: 0, // Backend computes the actual port from base_port + collision avoidance
      backend_type: effectiveBackendType,
      binary_profile: selectedBinaryProfile,
      extra_params: extraParams,
    };

    // Inject test flags into extra_params if enabled
    if (testFlagsEnabled && testFlags.trim()) {
      const testArgs = testFlags.trim().split(/\s+/).filter(Boolean);
      fullConfig.extra_params = testFlagsMode === "replace"
        ? { __test_args: testArgs } // REPLACE: bypass all params, use only raw flags
        : { ...fullConfig.extra_params, __test_args_add: testArgs }; // ADD: merge with user config, append test flags
    }

    void onLaunch(fullConfig)
      .then((result) => {
        const resolvedAlias = result?.alias ?? finalAlias;
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
    selectedProfileIsBuilding,
    pulseLaunchAck,
    aliasInput,
    aliasIsUserSet,
    aliasFocused,
    autoAlias,
    stack,
    fitLaunchSupported,
    fullAutoMode,
    configView,
    essentialFactoryKeys,
    allParamsResolved,
    config,
    gpus,
    runningSlotsForPlan,
    vramCalc.manifest,
    effectiveBackendType,
    selectedBinaryProfile,
    testFlagsEnabled,
    testFlags,
    testFlagsMode,
    onLaunch,
  ]);

  const launchDisabled =
    !model
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

  // ── Empty state (setup guide still uses the VRAM display) ─────────────────
  if (!model && !setupGuide.active) {
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

  const onboardingDisplay = onboardingDisplayClasses(setupGuide);

  if (!model && setupGuide.active) {
    return (
      <div
        className="flex flex-col h-full min-h-0 overflow-hidden"
        data-config-panel
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
                  toolchainDone={setupGuide.toolchainDone}
                  runtimeReady={setupGuide.runtimeReady}
                  modelsDeferred={setupGuide.modelsDeferred}
                  metaDone={setupGuide.metaDone}
                  metaScanFailed={setupGuide.metaScanFailed}
                  modelsCount={setupGuide.modelsCount}
                  scannedCount={setupGuide.scannedCount}
                  onDeferModels={setupGuide.deferModels}
                  onSkipToolchain={setupGuide.skipToolchain}
                  onDismiss={setupGuide.dismiss}
                />
              )}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex flex-col h-full min-h-0 overflow-hidden"
      data-config-panel
      data-layout-mode={layoutModeActive ? "on" : "off"}
    >
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
            {driverVersion && (
              <span className="text-[7px] font-mono text-stealth-muted/60 ml-1" title="Driver version from nvidia-smi. Affects which CUDA profile(s) will work.">
                drv {driverVersion.split(".")[0]}
              </span>
            )}
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

      {aboveGroupKeys.length > 0 && (
        <div className="config-params-above relative">
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

      <div
        className={onboardingDisplay.area}
        data-display-texture={displayTexture}
      >
        {model && !setupGuide.active && gpus.length > 0 && (
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
                key={setupGuide.active ? "setup-phosphor" : "forecast-phosphor"}
                className="phosphor-screen-inner phosphor-display-surface vram-forecast-display"
              >
                <DisplayGlitchOverlay />
                {setupGuide.active ? (
                  setupGuide.showWelcome ? (
                    <WelcomeAnimation onComplete={setupGuide.completeWelcome} />
                  ) : (
                    <SetupGuideDisplay
                      phase={setupGuide.phase}
                      pathsDone={setupGuide.pathsDone}
                      toolchainDone={setupGuide.toolchainDone}
                      runtimeReady={setupGuide.runtimeReady}
                      modelsDeferred={setupGuide.modelsDeferred}
                      metaDone={setupGuide.metaDone}
                      metaScanFailed={setupGuide.metaScanFailed}
                      modelsCount={setupGuide.modelsCount}
                      scannedCount={setupGuide.scannedCount}
                      onDeferModels={setupGuide.deferModels}
                      onSkipToolchain={setupGuide.skipToolchain}
                      onDismiss={setupGuide.dismiss}
                    />
                  )
                ) : (
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
                  />
                )}
              </div>
          </div>

          {/* Running Engines — eject panel below display */}
          {onSelectEngine && models && (
            <div className="industrial-eject-panel relative flex-shrink min-h-0">
              <RunningEnginesPanel
                stack={stack}
                models={models}
                selectedSlotIdx={selectedSlotIdx ?? null}
                onSelectEngine={onSelectEngine}
              />
            </div>
          )}
      </div>

      {/* Parameters scroll + launch dock (button always visible at panel bottom) */}
      <div className="flex flex-col flex-1 min-h-0">
      {allParamsForDisplay.length > 0 && (
        <div className="config-params-below-toolbar px-4 py-1.5 flex items-center justify-end gap-2 flex-shrink-0 border-b section-divider">
          <ConfigViewToggle
            view={configView}
            onChange={(view) => {
              setConfigView(view);
              saveConfigView(effectiveBackendType, view);
            }}
          />
          <div className="config-column-count flex items-center gap-0.5">
            {([1, 2, 3] as ConfigColumnCount[]).map((n) => (
              <button
                key={n}
                type="button"
                onClick={() => setBelowColumnCount(n)}
                className={`config-column-count__btn px-1.5 py-0.5 text-[8px] font-mono rounded-sm border transition-colors ${
                  columnCount === n
                    ? "border-nv-green/45 text-nv-green/90 bg-nv-green/10"
                    : "border-stealth-border/40 text-stealth-muted/45 hover:text-stealth-muted"
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
            className={`config-layout-mode-btn px-2 py-0.5 text-[8px] font-mono rounded-sm border transition-colors ${
              layoutModeActive
                ? "config-layout-mode-btn--on border-nv-green/50 text-nv-green bg-nv-green/10"
                : "border-stealth-border/40 text-stealth-muted/50 hover:text-stealth-muted"
            }`}
            title={
              layoutModeActive
                ? "Layout mode on — drag, pin, and hide groups"
                : "Edit group layout — reorder, pin above/below, hide"
            }
          >
            LAYOUT{layoutModeActive ? " ON" : ""}
          </button>
        </div>
      )}
      <div className="config-params-scroll px-4 py-3 relative flex-1 overflow-y-auto eink-scrollbar eink-panel min-h-0">
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

        {uiDensityCompact && customFlagsBlock ? (
          <div className="config-launch-dock__flags-scroll">{customFlagsBlock}</div>
        ) : null}

      </div>

        <div className="config-launch-dock flex-shrink-0 px-4 flex flex-col">
          <div className="config-launch-dock__content flex flex-col min-w-0">
          {mtpParallelWarn && (
            <div
              className="config-mtp-launch-warn rounded-sm px-2.5 py-1.5 text-[7px] font-mono leading-snug"
              role="status"
            >
              <span className="uppercase tracking-wide">⚠ MTP disabled at launch</span>
              {" — "}
              <span className="config-mtp-launch-warn__detail">
                parallel ×{mtpParallelSlotCount} strips speculative decoding (slow path). Set parallel = 1 for MTP, or turn MTP off for multi-slot.
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
              {!uiDensityCompact && customFlagsBlock}
            </div>
            <div className="config-launch-dock__action">
              <button
                onClick={handleAddToStack}
                disabled={launchDisabled}
                className={`w-full h-full min-h-[2.75rem] min-w-0 ignite-btn config-launch-btn px-2 py-1.5 text-[11px] font-mono tracking-[0.18em] rounded-sm disabled:opacity-40 disabled:cursor-not-allowed flex flex-col items-center justify-center gap-0.5 ${launchAck ? "launch-ack" : ""}`}
              >
                <span>LAUNCH ENGINE</span>
                <span className="config-launch-btn__hint text-[7px] font-mono tracking-wider normal-case font-normal">
                  Ctrl+Enter
                </span>
              </button>
            </div>
          </div>
          </div>
        </div>
      </div>
    </div>
  );
}