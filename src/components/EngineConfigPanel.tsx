// Model-specific parameter configuration and launch control.

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ModelEntry, EngineConfig, GpuInfo, UserEditedTemplateParam, ProviderConfig, ProviderTemplate, StackEntry, SystemInfo } from "../lib/types";
import { DEFAULT_PROVIDER_ID, isProfileBuilt, profileEnvLookup } from "../lib/types";
import {
  KEYS,
  binaryProfileKey,
  engineAliasKey,
  loadAutoVramEnabled,
  readJsonStorage,
  readStorage,
  removeStorage,
  saveAutoVramEnabled,
  writeJsonStorage,
  writeStorage,
} from "../lib/storage";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import { ENV_META, ENV_ORDER, type Env } from "../lib/foundry_constants";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import VramBadge from "./VramBadge";
import WelcomeAnimation from "./onboarding/WelcomeAnimation";
import SetupGuideDisplay from "./onboarding/SetupGuideDisplay";
import RunningEnginesPanel from "./RunningEnginesPanel";
import SliderParam from "./SliderParam";
import { useScenarioEvaluator } from "../hooks/useScenarioEvaluator";
import type { SetupGuideState } from "../hooks/useSetupGuide";
import { useConfigResolver } from "../hooks/useConfigResolver";
import { useDisplayTexture } from "../hooks/useDisplayTexture";
import DisplayGlitchOverlay from "./DisplayGlitchOverlay";
import { useFoundry } from "../hooks/useBuildDock";
import { buildAutoVramLaunchParams } from "../lib/autoVramLaunch";
import { committedSlotsFromStack } from "../services/vram/scenarios/scenarios_factory";



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

/** Section headers (MEMORY MANAGEMENT, speculative decoding) — wider than param chips. */
const SECTION_LABEL_CLASS =
  "config-section-label font-mono flex-shrink-0 uppercase tracking-wider whitespace-nowrap text-[9px] text-stealth-muted";

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
  if (!provider) return "frontier";
  const profiles: EnvProfile[] = [...ENV_ORDER];
  const available = profiles.filter((p) => isProfileBuilt(provider, p));
  if (available.length === 0) return "frontier";
  let best = available[0];
  let bestDate = profileEnvLookup(provider.buildInfoPerEnv, best)?.buildDate ?? "";
  for (const p of available.slice(1)) {
    const d = profileEnvLookup(provider.buildInfoPerEnv, p)?.buildDate ?? "";
    if (d > bestDate) {
      best = p;
      bestDate = d;
    }
  }
  return best;
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
const SPEC_DECODING_LAUNCH_KEYS = ["spec_type", "spec_draft_n_max"] as const;

function isSpecDecodingActive(params: UserEditedTemplateParam[]): boolean {
  return params
    .filter((p) => p.ui_group === SPEC_DECODING_GROUP)
    .some((p) => !p.hidden);
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

interface EngineConfigPanelProps {
  model: ModelEntry | null;
  gpus: GpuInfo[];
  providers?: ProviderConfig[];
  committedVramMib: number;
  isPowerUser: boolean;
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
  const { model, gpus, providers: externalProviders, committedVramMib, isPowerUser, systemInfo, stack, onLaunch, isModelRunning, activeEngineAlias, activeEnginePort, selectedSlotIdx, supportsFusion = true, models, onSelectEngine, setupGuide } = props;
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
  const aliasInitializedRef = useRef<{ modelPath: string; done: boolean }>({ modelPath: "", done: false });
  const aliasUserEditedRef = useRef(false);
  const lastLaunchAtRef = useRef(0);
  const [launchAck, setLaunchAck] = useState(false);
  const launchAckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [selectedBinaryProfile, setSelectedBinaryProfile] = useState<EnvProfile>("frontier");


  const [specFlash, setSpecFlash] = useState(false);
  const [autoVramEnabled, setAutoVramEnabled] = useState(true);

  const { texture: displayTexture, label: displayTextureLabel, cycle: cycleDisplayTexture } = useDisplayTexture();

  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => {
    try {
      const saved = readStorage(KEYS.collapsedGroups);
      if (saved) return new Set(JSON.parse(saved));
    } catch {}
    return new Set(["ADVANCED", "FEATURE-FLAGS"]);
  });

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
          aliasUserEditedRef.current = true;
          setAliasIsUserSet(true);
        } else {
          const autoName = nextEngineAlias(stack);
          setAliasInput(autoName);
          aliasUserEditedRef.current = false;
          setAliasIsUserSet(false);
          aliasInitializedRef.current = { modelPath: model.path, done: true };
        }
      } catch {
        aliasUserEditedRef.current = false;
        setAliasIsUserSet(false);
        aliasInitializedRef.current = { modelPath: model.path, done: true };
      }
    }
  }, [model?.path, stack]);

  // Save alias to localStorage only when user has actively edited it (not on every keystroke)
  const saveAliasForModel = useCallback((modelPath: string, aliasValue: string) => {
    try {
      if (aliasValue.trim()) {
        writeStorage(engineAliasKey(modelPath), aliasValue.trim());
      } else {
        removeStorage(engineAliasKey(modelPath));
      }
    } catch {}
  }, []);

  // Clear persisted alias when user clears the input field
  useEffect(() => {
    if (!model || !aliasInitializedRef.current.done) return;
    try {
      if (aliasUserEditedRef.current && !aliasInput.trim()) {
        removeStorage(engineAliasKey(model.path));
        setAliasIsUserSet(false);
      }
    } catch {}
  }, [aliasInput, model?.path]);

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
  const providerSupportsAutoVram = Boolean(
    launchProfile?.autoVram || launchProfile?.fitStyle,
  );
  const simpleModeActive = providerSupportsAutoVram && autoVramEnabled;
  const visibleParamKeys = useMemo(() => {
    if (!simpleModeActive) return null;
    return new Set(launchProfile?.simpleParamKeys ?? ["device", "ctx"]);
  }, [simpleModeActive, launchProfile?.simpleParamKeys]);

  useEffect(() => {
    if (!providerSupportsAutoVram) {
      setAutoVramEnabled(false);
      return;
    }
    setAutoVramEnabled(loadAutoVramEnabled(effectiveBackendType, launchProfile?.autoVram ?? true));
  }, [effectiveBackendType, providerSupportsAutoVram, launchProfile?.autoVram]);

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
      const saved = readStorage(binaryProfileKey(effectiveBackendType)) as EnvProfile | null;
      if (saved && built.includes(saved)) {
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
      dock: "runtime",
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

  const allParamsForLaunch = useMemo(() => {
    if (!visibleParamKeys) return allParamsResolved;
    return allParamsResolved.filter((d) => visibleParamKeys.has(d.key));
  }, [allParamsResolved, visibleParamKeys]);

  // Docked params: extracted from merged defs by dock key
  const dockedParams = useMemo(() => {
    const docks: Record<string, UserEditedTemplateParam[]> = {};
    for (const def of allParamsForLaunch) {
      if (!def.dock || def.hidden) continue;
      if (!docks[def.dock]) docks[def.dock] = [];
      docks[def.dock].push(def);
    }
    return docks;
  }, [allParamsForLaunch]);

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

  const simpleParamKeys = launchProfile?.simpleParamKeys ?? ["device", "ctx"];

  const scenarioConfig = useMemo(() => {
    if (!simpleModeActive) {
      return { ...config, backend_type: effectiveBackendType };
    }
    const params: Record<string, unknown> = {};
    for (const key of simpleParamKeys) {
      if (config[key] !== undefined) params[key] = config[key];
    }
    return { ...params, backend_type: effectiveBackendType };
  }, [simpleModeActive, config, effectiveBackendType, simpleParamKeys]);

  // Display value — manufactured capacity, no deductions (what users see)
  const displayVramMib = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);

 const vramCalc = useScenarioEvaluator({
    model,
    config: scenarioConfig,
    gpus,
    stack,
    systemInfo,
    autoVramLaunch: simpleModeActive,
    fitStyle: launchProfile?.fitStyle ?? "",
  });

  const splitModeActive = isSplitModeActive(config.split);

  // Manual split → all GPUs; solo → manifest projection; badge click still forces split=none
  const selectedGpuIndices = useMemo(() => {
    if (!simpleModeActive && splitModeActive && gpus.length > 0) {
      return gpus.map((g) => g.index);
    }
    if (!vramCalc.manifest) return [];
    return vramCalc.manifest.gpuAllocations
      .filter((a) => a.projectedLoadGb > 0.1)
      .map((a) => a.gpuIndex);
  }, [vramCalc.manifest, simpleModeActive, splitModeActive, gpus]);

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

    // DEVICE — fixed-height row; split active shows ALL (N) without changing layout below
    if (def.key === "device") {
      const splitLocksDevice = isSplitModeActive(config.split) && gpus.length > 0;
      return (
        <div
          key={paramRowKey(def, rowIdx)}
          data-param-row
          data-device-row
          className={`flex items-center min-h-[22px] ${isLocked ? "opacity-50" : ""}`}
        >
          {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 bg-yellow-400/40 mr-1.5" />}
          {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />}
          <span className={`${PARAM_LABEL_CLASS} ${isUserAdded ? "text-yellow-400/80" : ""}`} title={def.label}>
            {def.label}
          </span>
          <div className="flex gap-1 flex-nowrap flex-1 min-w-0 items-center min-h-[18px]">
            {splitLocksDevice ? (
              <span
                className={`${paramChipClass(true)} opacity-90 cursor-default`}
                title="Split mode uses all detected GPUs. Set SPLIT to none to pick a single GPU."
              >
                ALL ({gpus.length})
              </span>
            ) : (
              baseValues.map((val, valIdx) => (
                <button
                  key={`${paramRowKey(def, rowIdx)}-val-${valIdx}-${String(val)}`}
                  tabIndex={isLocked ? -1 : 0}
                  onClick={() => {
                    if (isLocked) return;
                    updateParam(def.key, val);
                  }}
                  className={paramChipClass(
                    currentValue === val ||
                    (typeof currentValue === "string" && typeof val === "string" &&
                      currentValue.toLowerCase() === String(val).toLowerCase())
                  )}
                >
                  {String(val)}
                </button>
              ))
            )}
          </div>
        </div>
      );
    }

    // ── Slider ptype — render range input instead of value chips ───────────
    if (def.ptype === 'slider') {
      return (
        <div key={paramRowKey(def, rowIdx)} data-param-row className={`flex items-center min-h-[22px] ${isLocked ? 'opacity-50' : ''}`}>
          {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 bg-yellow-400/40 mr-1.5" />}
          {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />}
          <span
            className={`font-mono w-24 flex-shrink-0 uppercase tracking-wider truncate text-[9px] ${isUserAdded ? 'text-yellow-400/80' : 'text-stealth-muted'}`}
            title={def.label}
          >
            {def.label}
          </span>
          <SliderParam
            paramKey={def.key}
            currentValue={currentValue}
            onChange={(v) => updateParam(def.key, v)}
            step={def.step ?? 1024}
            values={baseValues}
          />
        </div>
      );
    }

    return (
      <div key={paramRowKey(def, rowIdx)} data-param-row className={`flex items-center min-h-[22px] ${isLocked ? 'opacity-50' : ''}`}>
        {isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 bg-yellow-400/40 mr-1.5" />}
        {!isUserAdded && <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />}
        <span
          className={`${PARAM_LABEL_CLASS} ${isUserAdded ? 'text-yellow-400/80' : ''}`}
          title={def.label}
        >
          {def.label}
        </span>

        <div className="flex gap-1 flex-nowrap flex-1 min-w-0 items-center min-h-[18px]">
          {baseValues.filter((v: any) => !(v?._hidden)).map((val, valIdx) => (
            <button
              key={`${paramRowKey(def, rowIdx)}-val-${valIdx}-${String(val)}`}
              tabIndex={isLocked ? -1 : 0}
              onClick={() => {
                if (isLocked) return;
                updateParam(def.key, val);
              }}
              className={paramChipClass(
                currentValue === val ||
                (typeof currentValue === 'string' && typeof val === 'string' &&
                  currentValue.toLowerCase() === String(val).toLowerCase())
              )}
            >
              {String(val)}
            </button>
          ))}
        </div>
      </div>
    );
  }, [config, gpus.length, providerDefaultKeys, updateParam]);

  // Grouped params — skip docked (rendered separately)
  const groupedParams = useMemo(() => {
    const groups: Record<string, UserEditedTemplateParam[]> = {};
    for (const def of allParamsForLaunch) {
      if (def.hidden || def.dock) continue;
      const groupId = def.ui_group || 'Feature Flags';
      if (!groups[groupId]) groups[groupId] = [];
      groups[groupId].push(def);
    }
    return groups;
  }, [allParamsForLaunch]);

  // All params by group — includes hidden ones (spec-decoding switch reads from here)
  const allGroupedParams = useMemo(() => {
    const groups: Record<string, UserEditedTemplateParam[]> = {};
    const source = simpleModeActive ? allParamsResolved : allParamsForLaunch;
    for (const def of source) {
      if (def.dock) continue;
      const groupId = def.ui_group || "Feature Flags";
      if (!groups[groupId]) groups[groupId] = [];
      groups[groupId].push(def);
    }
    if (simpleModeActive) {
      for (const def of allParamsResolved) {
        if (def.dock || def.ui_group !== SPEC_DECODING_GROUP) continue;
        if (!groups[SPEC_DECODING_GROUP]) groups[SPEC_DECODING_GROUP] = [];
        if (!groups[SPEC_DECODING_GROUP].some((p) => p.key === def.key)) {
          groups[SPEC_DECODING_GROUP].push(def);
        }
      }
    }
    return groups;
  }, [allParamsForLaunch, allParamsResolved, simpleModeActive]);

  // Ordered group keys: custom provider order > template insertion order (include hidden-only groups)
  const orderedGroupKeys = useMemo(() => {
    const allGroups = [...new Set([...Object.keys(groupedParams), ...Object.keys(allGroupedParams)])];
    const currentProv = resolvedProviders?.find(p => p.id === effectiveBackendType);
    if (currentProv?.groupOrder && currentProv.groupOrder.length > 0) {
      return [...currentProv.groupOrder.filter(g => allGroups.includes(g)), ...allGroups.filter(g => !currentProv.groupOrder!.includes(g))];
    }
    return allGroups;
  }, [groupedParams, allGroupedParams, resolvedProviders, effectiveBackendType]);

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
    const now = Date.now();
    if (now - lastLaunchAtRef.current < 60) return;
    lastLaunchAtRef.current = now;
    pulseLaunchAck();

    // Resolve final alias: user input if non-empty, otherwise auto-generate
    let finalAlias = aliasInput.trim();
    if (!finalAlias) {
      finalAlias = nextEngineAlias(stack);
    }
    finalAlias = resolveUniqueAlias(finalAlias, stack);

    const autoVramLaunchKeys = simpleModeActive && isSpecDecodingActive(allParamsResolved)
      ? [...new Set([...simpleParamKeys, ...SPEC_DECODING_LAUNCH_KEYS])]
      : simpleParamKeys;

    const extraParams: Record<string, unknown> = simpleModeActive && model.metadata
      ? buildAutoVramLaunchParams({
          config,
          simpleKeys: autoVramLaunchKeys,
          gpus,
          runningSlots: runningSlotsForPlan,
          manifest: vramCalc.manifest,
          weightGb: model.metadata.file_size_bytes / (1024 ** 3),
        })
      : { ...config };
    if (!simpleModeActive && vramCalc.manifest?.gpuLayers != null && vramCalc.manifest.ramLayers > 0) {
      extraParams.__ngl = String(vramCalc.manifest.gpuLayers);
    }

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
        const wasUserEdited = aliasUserEditedRef.current;
        if (wasUserEdited) {
          saveAliasForModel(model.path, aliasInput.trim());
        } else if (resolvedAlias !== aliasInput) {
          setAliasInput(resolvedAlias);
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
    stack,
    simpleModeActive,
    simpleParamKeys,
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

  // Keyboard launch — Ctrl+Enter triggers ignite (must track handleAddToStack for fresh manifest)
  useEffect(() => {
    const handler = (e: Event) => {
      if (!(e instanceof CustomEvent)) return;
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
      <div className="flex flex-col h-full min-h-0 overflow-hidden" data-config-panel>
        <div
          className={onboardingDisplay.area}
          data-display-texture={displayTexture}
        >
          <div className={onboardingDisplay.frame}>
            <button
              type="button"
              onClick={cycleDisplayTexture}
              className="display-texture-toggle absolute top-[3px] left-1/2 -translate-x-1/2 z-[60]"
              title={`Display texture: ${displayTextureLabel}. Click to cycle CLEAN / GLITCH / PHOSPHOR DARK / PHOSPHOR LIGHT.`}
            >
              {displayTextureLabel}
            </button>
            <div className="phosphor-screen-inner phosphor-display-surface">
              <DisplayGlitchOverlay />
              {setupGuide.showWelcome ? (
                <WelcomeAnimation onComplete={setupGuide.completeWelcome} />
              ) : (
                <SetupGuideDisplay
                  phase={setupGuide.phase}
                  modelsCount={setupGuide.modelsCount}
                  scannedCount={setupGuide.scannedCount}
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
    <div className="flex flex-col h-full min-h-0 overflow-hidden" data-config-panel>
      {resolvedProviders && resolvedProviders.length > 0 && (
        <div className="px-4 py-2 border-b section-divider relative flex-shrink-0">
          <div className="flex gap-1 flex-wrap">
            {resolvedProviders.filter(p => p.enabled).map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setSelectedProvider(p.id);
                  writeStorage(KEYS.lastProvider, p.id);
                }}
                className={`flex-shrink-0 px-2 py-0.5 text-[9px] font-mono rounded-sm ${
                  selectedProvider === p.id
                    ? "provider-pill-active"
                    : "provider-pill"
                }`}
              >
                {p.display_name || p.id}
                <span className="ml-1 opacity-40 text-[7px]">({(p.userEditedTemplateParams || []).length})</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Mandatory Config Block (2-column) ─────────────── */}
      {dockedParams["runtime"] && dockedParams["runtime"].length > 0 && (() => {
        const runtimeDocked = dockedParams["runtime"];
        const leftParams = runtimeDocked.filter(d => d.ui_group !== "RUNTIME-CONFIG");
        const rightParams = runtimeDocked.filter(d => d.ui_group === "RUNTIME-CONFIG");
        const currentProvider = resolvedProviders?.find(p => p.id === effectiveBackendType);
        const availableProfiles: EnvProfile[] = [...ENV_ORDER];
        const builtProfiles = ENV_ORDER.filter((env) => isProfileBuilt(currentProvider, env));

        return (
          <div className="mono-panel relative flex-shrink-0">
            {/* Section header — outside the green bg, on dark */}
            <div className="relative z-[2] px-4 pt-3 pb-1 mono-panel-header">

            </div>
            <div className="mono-panel-body relative z-[2] px-4 py-3 pr-6">
              <div className="flex gap-4">
                {/* Left: Multi-GPU params */}
                {leftParams.length > 0 && (
                  <div className="space-y-2.5 flex-1 min-w-0">
                    <label className="text-[8px] font-mono tracking-widest uppercase block mb-2 mono-label">
                      MULTI-GPU
                    </label>
                    {leftParams.map((def, i) => renderParamRow(def, false, i))}
                  </div>
                )}

                {/* Subtle vertical separator */}
                <div className="w-px flex-shrink-0 bg-white/[0.03]" />

               {/* Right: Runtime Config */}
                <div className="flex-1 min-w-0 space-y-2.5">
                  <label className="text-[8px] font-mono tracking-widest uppercase block mb-2 mono-label">
                    RUNTIME-CONFIG
                  </label>

                  {rightParams.map((def, i) => renderParamRow(def, false, i))}

                  <div data-param-row className="flex items-center">
                    <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />
                    <span className={PARAM_LABEL_CLASS}>
                      Alias{aliasIsUserSet ? <span className="mono-user-set"> - user set</span> : ''}
                    </span>
                    <input
                      type="text"
                      value={aliasInput}
                      onChange={(e) => {
                        const val = e.target.value;
                        if (val.trim()) {
                          aliasUserEditedRef.current = true;
                          setAliasIsUserSet(true);
                        } else {
                          aliasUserEditedRef.current = false;
                          setAliasIsUserSet(false);
                        }
                        setAliasInput(val);
                      }}
                      className={`flex-1 min-w-0 transition-colors ${
                        aliasUserEditedRef.current
                          ? `${paramChipClass(true)} mono-user-input`
                          : paramChipClass(false)
                      }`}
                      placeholder="auto..."
                    />
                  </div>

                  <div data-param-row className="runtime-profile-row flex items-center">
                    <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />
                    <span className={`${PARAM_LABEL_CLASS} runtime-profile-label`}>RUNTIME PROFILE</span>
                    <div className="flex gap-1 flex-nowrap flex-1 min-w-0 items-center min-h-[18px]">
                      {availableProfiles.map(profile => {
                        const meta = ENV_META[profile];
                        const hasBuild = builtProfiles.includes(profile);
                        const building = isProfileBuilding(profile);
                        const isSelected = selectedBinaryProfile === profile;
                        return (
                          <button
                            key={profile}
                            onClick={() => setSelectedBinaryProfile(profile)}
                            disabled={!hasBuild || building}
                            className={`flex-shrink-0 ${paramChipClass(isSelected)} ${
                              building
                                ? "opacity-40 cursor-not-allowed animate-pulse"
                                : !hasBuild
                                  ? "opacity-25 cursor-not-allowed"
                                  : ""
                            }`}
                            title={`${meta.label} — CUDA ${meta.cuda}, ${meta.vs}${
                              building ? " (build in progress)" : hasBuild ? "" : " (not yet built)"
                            }`}
                          >
                            {meta.label}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

    {/* VRAM display fixed; running engines eject panel scrolls independently */}
      <div
        className={onboardingDisplay.area}
        data-display-texture={displayTexture}
      >
          <div className={onboardingDisplay.frame}>
              <button
                type="button"
                onClick={cycleDisplayTexture}
                className="display-texture-toggle absolute top-[3px] left-1/2 -translate-x-1/2 z-[60]"
                title={`Display texture: ${displayTextureLabel}. Click to cycle CLEAN / GLITCH / PHOSPHOR DARK / PHOSPHOR LIGHT.`}
              >
                {displayTextureLabel}
              </button>
              <div className="phosphor-screen-inner phosphor-display-surface vram-forecast-display">
                <DisplayGlitchOverlay />
                {setupGuide.active ? (
                  setupGuide.showWelcome ? (
                    <WelcomeAnimation onComplete={setupGuide.completeWelcome} />
                  ) : (
                    <SetupGuideDisplay
                      phase={setupGuide.phase}
                      modelsCount={setupGuide.modelsCount}
                      scannedCount={setupGuide.scannedCount}
                      onDismiss={setupGuide.dismiss}
                    />
                  )
                ) : (
                  <VramBadge
                    manifest={vramCalc.manifest}
                    gpus={gpus}
                    selectedGpuIndices={selectedGpuIndices.length > 0 ? selectedGpuIndices : undefined}
                    onDeviceSelect={(gpuIndex) => {
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
                    hideValidate={simpleModeActive}
                    hideMoeBadge={simpleModeActive}
                    modelMeta={model?.metadata}
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
      <div className="config-params-scroll px-4 py-3 relative flex-1 overflow-y-auto eink-scrollbar eink-panel min-h-0">

        {providerSupportsAutoVram && (
          <div data-param-row className="flex items-center mb-3 pb-2 border-b border-white/[0.04]">
            <div className="w-0.5 h-4 flex-shrink-0 mr-1.5 bg-nv-green/40" />
            <span className={`${SECTION_LABEL_CLASS} text-nv-green/90`}>MEMORY MANAGEMENT</span>
            <label className="toggle-switch ml-2">
              <input
                type="checkbox"
                className="toggle-input"
                checked={autoVramEnabled}
                onChange={() => {
                  const next = !autoVramEnabled;
                  setAutoVramEnabled(next);
                  saveAutoVramEnabled(effectiveBackendType, next);
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
                <span className="label-off">USER</span>
                <span className="label-on">AUTO</span>
              </span>
            </label>
            <span className="text-[8px] font-mono text-stealth-muted/60 ml-2 tracking-wide uppercase">
              {simpleModeActive
                ? "Engine tunes VRAM and RAM offload at launch"
                : "full autonomy"}
            </span>
          </div>
        )}

        {allParamsForLaunch.length === 0 ? (
          <div className="text-stealth-muted text-[10px] font-mono opacity-50">NO PARAMS DEFINED</div>
        ) : (() => {
          const allGroups = deriveParamGroups(orderedGroupKeys);
          const mid = Math.ceil(allGroups.length / 2);
          const leftCol = allGroups.slice(0, mid);
          const rightCol = allGroups.slice(mid);

          const renderGroup = (group: ReturnType<typeof deriveParamGroups>[number]) => {
            const groupParams = groupedParams[group.id];
            const isSpecGroup = group.id === SPEC_DECODING_GROUP;

            if (isSpecGroup) {
              const specAllParams = allGroupedParams[group.id] || [];
               if (specAllParams.length === 0) return null;
               const isMtpModel = (model?.metadata?.nextn_predict_layers ?? 0) > 0;
               // Force OFF visually for non-MTP models — params may be unhidden from previous MTP session
               const allHidden = specAllParams.every(d => d.hidden);
               const specActive = isMtpModel ? !allHidden : false;

              return (
                <div key={group.id}>
                  <div
                    data-param-row
                    className={`nuclear-btn-container config-spec-decoding flex items-center ${specFlash ? 'flash' : ''}`}
                  >
                    <div className="w-0.5 h-4 flex-shrink-0 mr-1.5" />
                    <span className={SECTION_LABEL_CLASS}>SPECULATIVE DECODING</span>
                    <div className="flex flex-1 min-w-0 items-center">
                    <label className={`toggle-switch ${!isMtpModel ? 'opacity-40 pointer-events-none' : ''}`}>
                      <input
                        type="checkbox"
                        className="toggle-input"
                        checked={specActive}
                        disabled={!isMtpModel}
                        onChange={() => {
                          invoke<boolean>("toggle_group_hidden", { providerId: effectiveBackendType, groupId: group.id })
                            .then(() => {
                              setSpecFlash(true);
                              setTimeout(() => setSpecFlash(false), 400);
                              dispatchAppEvent(EVENTS.reloadProviders);
                              dispatchAppEvent(EVENTS.paramConfigChanged);
                            })
                            .catch(err => console.error("[toggle_group_hidden] failed:", err));
                        }}
                      />
                      <span className="toggle-track">
                        <span className="toggle-rust"></span>
                        <span className="toggle-glow"></span>
                        <span className="toggle-thumb">
                          <span className="thumb-inner"></span>
                          <span className="thumb-shine"></span>
                        </span>
                        <span className="toggle-icons">
                          <svg
                            className="icon-off"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <circle cx="12" cy="12" r="5"></circle>
                            <path
                              d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"
                            ></path>
                          </svg>
                          <svg className="icon-on" viewBox="0 0 24 24" fill="currentColor">
                            <path
                              d="M12 3c.132 0 .263 0 .393 0a7.5 7.5 0 0 0 7.92 12.446a9 9 0 1 1 -8.313-12.454z"
                            ></path>
                          </svg>
                        </span>
                      </span>
                      <span className="toggle-label">
                        <span className="label-off">OFF</span>
                        <span className="label-on">ON</span>
                      </span>
                    </label>
                    </div>
                  </div>

                  {isMtpModel && specActive && (
                    <div className="rounded-sm px-3 py-2 text-[8px] font-mono tracking-wide uppercase flex items-center gap-1 text-nv-green">
                      Speculative mode active
                    </div>
                  )}

                  {isMtpModel && specActive && (
                    <div className="config-spec-params space-y-2.5 mt-2">
                      {specAllParams.map((def, i) => (
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
                       {specAllParams.length} parameter{specAllParams.length > 1 ? 's' : ''} 🔒locked — activate to configure
                    </div>
                  )}
                </div>
              );
            }

            if (!groupParams || groupParams.length === 0) return null;

            const isCollapsed = collapsedGroups.has(group.id);

            return (
              <div key={group.id}>
                {group.alwaysOpen ? (
                  <div className="text-[8px] font-mono text-[#4ade80] opacity-45 tracking-widest uppercase mb-2 pb-1 border-b border-stealth-border/30">
                    {group.label}
                  </div>
                ) : (
                  <button
                     onClick={() => toggleGroup(group.id)}
                     className="flex items-center gap-1.5 text-[8px] font-mono tracking-widest uppercase mb-2 pb-1 border-b border-stealth-border/30 w-full text-[#4ade80] opacity-45 hover:text-white hover:opacity-100 transition-colors"
                   >
                    <span className="text-[7px]">{isCollapsed ? '▶' : '▼'}</span>
                    {group.label}
                    <span className="opacity-40">({groupParams.length})</span>
                  </button>
                )}

                {!isCollapsed && (
                  <div className="space-y-2.5">
                    {groupParams.map((def, i) => renderParamRow(def, false, i))}
                  </div>
                )}
              </div>
            );
          };

          return (
            <div className="flex gap-4">
              <div className="flex-1 min-w-0 space-y-3">
                {leftCol.map(renderGroup)}
              </div>
              <div className="w-px flex-shrink-0 bg-white/[0.03]" />
              <div className="w-[40%] min-w-[200px] flex-shrink-0 space-y-3">
                {rightCol.map(renderGroup)}
              </div>
            </div>
          );
        })()}

        {isPowerUser && (
          <div className={`relative mt-1.5 border rounded-sm overflow-hidden custom-flags-block ${testFlagsEnabled ? "custom-flags-active" : ""}`}>
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
                    onClick={() => setTestFlagsMode(m => m === "add" ? "replace" : "add")}
                    className={`px-1.5 py-0 text-[7px] font-mono border rounded-sm transition-all duration-150 cursor-pointer ${
                      testFlagsMode === "add" ? "mode-btn-add" : "mode-btn-replace"
                    }`}
                  >
                    {testFlagsMode === "add" ? "+ ADD" : "= REP"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setTestFlagsEnabled(v => !v)}
                  className={`px-1.5 py-0 text-[7px] font-mono border rounded-sm transition-all duration-150 cursor-pointer ${
                    testFlagsEnabled ? "mode-btn-add" : "mode-btn-off"
                  }`}
                >
                  {testFlagsEnabled ? "ON" : "OFF"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

        <div className="config-launch-dock flex-shrink-0 px-4 flex items-center gap-3">
          <button
            onClick={handleAddToStack}
            disabled={!model || vramCalc.manifest?.scenario === 'HW_LOCKED' || selectedProfileIsBuilding}
            className={`flex-1 min-w-0 ignite-btn px-4 py-2 text-[12px] font-mono tracking-[0.22em] rounded-sm disabled:opacity-40 disabled:cursor-not-allowed config-launch-btn ${launchAck ? "launch-ack" : ""}`}
          >
            LAUNCH ENGINE
          </button>
          <span className="shrink-0 text-[8px] font-mono text-stealth-muted/40 whitespace-nowrap config-launch-hint">
            Ctrl+Enter
          </span>
        </div>
      </div>
    </div>
  );
}