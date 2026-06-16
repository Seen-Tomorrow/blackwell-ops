// Provider and parameter configuration.

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UserEditedTemplateParam, ProviderConfig, ProviderTemplate, ProviderDefaultParam, ModelPathEntry, PathDiskUsage } from "../lib/types";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import ValueBubbles from "./ValueBubbles";
import ProvidersConfig from "./ProvidersConfig";
import SecretsConfig from "./SecretsConfig";
import ParamCreatorModal from "./ParamCreatorModal";
import ParamCatalogSearch from "./ParamCatalogSearch";
import {
  cyclePowerUserState,
  isPowerUserActive,
  loadPowerUserState,
  catalogOverrideKey,
  effectiveParamDefault,
  groupOrderKey,
  normalizeUiGroup,
  paramUiGroup,
  readJsonStorage,
  resolveGroupOrder,
  removeStorage,
  writeJsonStorage,
  savePowerUserState,
  type PowerUserState,
} from "../lib/storage";
import {
  dispatchAppEvent,
  dispatchClearLocalStorage,
  dispatchPowerUserChanged,
  EVENTS,
  type NavigateConfigDetail,
} from "../lib/events";
import type { SetupGuideState } from "../hooks/useSetupGuide";
import type { RawCatalogEntry } from "../lib/catalog";
import { catalogEntryToParam } from "../lib/catalog";


type ConfigSubTab = "providers" | "params" | "paths" | "secrets";

interface ConfigPageProps {
  providers?: ProviderConfig[];
  setupGuide: SetupGuideState;
}

/** Parse a value as int, float, or string. */
function parseValue(v: string): string | number {
  const t = v.trim();
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

export default function ConfigPage({ providers: externalProviders, setupGuide }: ConfigPageProps) {
  const [subTab, setSubTab] = useState<ConfigSubTab>("providers");
  const [selectedProviderId, setSelectedProviderId] = useState<string>(DEFAULT_PROVIDER_ID);
  const [allProviders, setAllProviders] = useState<ProviderConfig[]>(externalProviders || []);
  // Power-user tri-state — synced with Layout.tsx header toggle
  const [powerUserState, setPowerUserState] = useState<PowerUserState>(loadPowerUserState);
  const isPowerUser = isPowerUserActive(powerUserState);

  useEffect(() => {
    const handler = () => setPowerUserState(loadPowerUserState());
    window.addEventListener(EVENTS.powerUserChanged, handler);
    return () => window.removeEventListener(EVENTS.powerUserChanged, handler);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<NavigateConfigDetail>).detail;
      if (detail?.subTab) setSubTab(detail.subTab);
    };
    window.addEventListener(EVENTS.navigateConfig, handler);
    return () => window.removeEventListener(EVENTS.navigateConfig, handler);
  }, []);

  useEffect(() => {
    if (setupGuide.active && setupGuide.phase === "paths") {
      setSubTab("paths");
    }
  }, [setupGuide.active, setupGuide.phase]);

  const handleEditorToggle = useCallback(() => {
    setPowerUserState(prev => {
      const next = cyclePowerUserState(prev);
      savePowerUserState(next);
      dispatchPowerUserChanged();
      return next;
    });
  }, []);

  // ── Sync with parent's provider updates ───────────────────────────
  useEffect(() => {
    if (externalProviders && externalProviders.length > 0) {
      setAllProviders(externalProviders);
    }
  }, [externalProviders]);

  // ── Refresh providers from Rust after any save ─────────────────────
  useEffect(() => {
    invoke<ProviderConfig[]>("list_providers")
      .then(data => setAllProviders(data))
      .catch(() => {});
  }, [selectedProviderId]);

  // ── UI state ───────────────────────────────────────────────────────
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const showSaved = (msg: string) => { setSavedFlash(msg); setTimeout(() => setSavedFlash(null), 1200); };

  // Reset confirm dialog
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showClearStorageConfirm, setShowClearStorageConfirm] = useState(false);

  // ── Param creator modal state ───────────────────────────────
  const [showCreatorModal, setShowCreatorModal] = useState(false);

  // ── Param catalog search state ───────────────────────────────
  const [showCatalogSearch, setShowCatalogSearch] = useState(false);

  // ── Inline sub-params editor state ───────────────────────────────
  type SubEditorTarget = { paramKey: string; valueName: string } | null;
  const [editingValue, setEditingValue] = useState<SubEditorTarget>(null);
  const [subArgsText, setSubArgsText] = useState<Record<string, string>>({});

  // ── Full param metadata editor state ─────────────────────────────
  type ParamMetaForm = {
    ptype: string; flag: string; pattern: string; uiGroup: string;
    values: (string | number)[]; defaultValue: string | number;
    subParams: Record<string, string>;
  };
  const [editingParamKey, setEditingParamKey] = useState<string | null>(null);
  const [paramMetaForm, setParamMetaForm] = useState<ParamMetaForm | null>(null);

  // ── User overrides (localStorage per provider) ─────────────────────
  const [userOverrides, setUserOverrides] = useState<Record<string, string | number>>({});

  useEffect(() => {
    try {
      const stored = readJsonStorage<Record<string, string | number>>(catalogOverrideKey(selectedProviderId));
      if (stored) setUserOverrides(stored);
      else setUserOverrides({});
    } catch { setUserOverrides({}); }
  }, [selectedProviderId]);

  // ── Current provider & param definitions ───────────────────────────
  const currentProvider = useMemo(() => allProviders.find(p => p.id === selectedProviderId), [allProviders, selectedProviderId]);

  // ── Custom group order (localStorage A + user_providers_config.json B) ───────
  const [customGroupOrder, setCustomGroupOrder] = useState<string[] | null>(null);

  useEffect(() => {
    // Load from localStorage first (A), fall back to provider config (B)
    try {
      const stored = readJsonStorage<string[]>(groupOrderKey(selectedProviderId));
      if (stored) {
        setCustomGroupOrder(stored.map((g: string) => normalizeUiGroup(g)));
      } else if (currentProvider?.groupOrder && currentProvider.groupOrder.length > 0) {
        setCustomGroupOrder(currentProvider.groupOrder.map(normalizeUiGroup));
      } else {
        setCustomGroupOrder(null); // Use template insertion order
      }
    } catch {
      setCustomGroupOrder(null);
    }
  }, [selectedProviderId, currentProvider]);

  const saveGroupOrder = useCallback(async (newOrder: string[]) => {
    const normalized = newOrder.map(normalizeUiGroup);
    // Persist to localStorage (A)
    writeJsonStorage(groupOrderKey(selectedProviderId), normalized);
    setCustomGroupOrder(normalized);
    // Persist to user_providers_config.json via save_provider (B)
    if (currentProvider) {
      const updated = { ...currentProvider, groupOrder: normalized };
      try { await invoke("save_provider", { provider: updated }); dispatchAppEvent(EVENTS.reloadProviders); } catch {}
    }
  }, [selectedProviderId, currentProvider]);

  const buildUserSavedParams = useCallback((provider: ProviderConfig | undefined): UserEditedTemplateParam[] => {
    if (!provider || !provider.userEditedTemplateParams) return [];
    return [...provider.userEditedTemplateParams]
      .sort((a, b) => a.order - b.order)
      .map((p) => ({
        ...p,
        ui_group: p.ui_group ? paramUiGroup(p.ui_group) : p.ui_group,
        defaultValue: effectiveParamDefault(p.defaultValue as string | number | null | undefined),
        factoryDefault: effectiveParamDefault(p.factoryDefault as string | number | null | undefined),
      }));
  }, []);
  const userSavedParams = useMemo(() => buildUserSavedParams(currentProvider), [currentProvider, buildUserSavedParams]);

  // ── Load raw template (for sub_params / ptype at runtime — no reset needed) ───
  const [providerDefaultParams, setProviderDefaultParams] = useState<ProviderDefaultParam[]>([]);
  useEffect(() => {
    if (!selectedProviderId) return;
    invoke<ProviderTemplate>("get_template", { providerId: selectedProviderId })
      .then(template => setProviderDefaultParams(template.params || []))
      .catch(() => {});
  }, [selectedProviderId]);

  // ── Merge base defs with runtime template data (sub_params, ptype) ───────────
  const userSavedParamsWithDefaults = useMemo(() => {
    if (!userSavedParams.length || !providerDefaultParams.length) return userSavedParams;
    const templateMap = new Map(providerDefaultParams.map(p => [p.key, p]));
    return userSavedParams.map(def => {
      const tpl = templateMap.get(def.key);
      if (!tpl) return def;
      // Merge sub_params: disk state (user edits) takes precedence, template fills in new values
      const diskSp = def.sub_params || {};
      const tplSp = tpl.sub_params || {};
      const mergedSubParams = { ...tplSp, ...diskSp };
      return {
        ...def,
        sub_params: Object.keys(mergedSubParams).length > 0 ? mergedSubParams : undefined,
        ptype: tpl.ptype || def.ptype,
      };
    });
  }, [userSavedParams, providerDefaultParams]);

  // ── Hidden count for status bar ───────────────────────────────────
  const hiddenCount = useMemo(() => userSavedParamsWithDefaults.filter(d => d.hidden).length, [userSavedParamsWithDefaults]);

  // ── Existing groups from user-saved + provider default params ───────────────
  const existingGroups = useMemo(() => {
    const seen = new Set<string>([paramUiGroup("Feature Flags"), "USER-ADDED-FROM-CATALOG"]);
    for (const def of userSavedParamsWithDefaults) {
      seen.add(paramUiGroup(def.ui_group));
    }
    for (const gp of providerDefaultParams) {
      seen.add(paramUiGroup(gp.ui_group));
    }
    return Array.from(seen);
  }, [userSavedParamsWithDefaults, providerDefaultParams]);
  // Fingerprint guard: only dispatch when params content actually changed, not on reference rotation.
  // Breaks the telemetry poll -> re-render -> dispatch -> refetch providers amplification loop.
  const lastDispatchRef = useRef<string>("");
  useEffect(() => {
    if (userSavedParamsWithDefaults.length === 0) return;
    const fingerprint = `${userSavedParamsWithDefaults.length}-${hiddenCount}`;
    if (fingerprint === lastDispatchRef.current) return;
    lastDispatchRef.current = fingerprint;
    dispatchAppEvent(EVENTS.paramConfigChanged, { totalParams: userSavedParamsWithDefaults.length, hiddenCount });
  }, [userSavedParamsWithDefaults, hiddenCount]);

  // ── Persist provider to Rust ───────────────────────────────────────
  const persistProviderToConfig = useCallback(async (provider: ProviderConfig) => {
    try {
      await invoke("save_provider", { provider });
      dispatchAppEvent(EVENTS.reloadProviders);
    } catch (err) { console.error("[CONFIG] save_provider FAILED:", err); }
  }, []);

  // ── User override (selecting a value for this model + provider) ───
  const setOverride = useCallback((defKey: string, value: string | number) => {
    try {
      const existing = readJsonStorage<Record<string, string | number>>(catalogOverrideKey(selectedProviderId)) ?? {};
      writeJsonStorage(catalogOverrideKey(selectedProviderId), { ...existing, [defKey]: value });
    } catch {}
    setUserOverrides(prev => ({ ...prev, [defKey]: value }));
    dispatchAppEvent(EVENTS.paramConfigChanged);
  }, [selectedProviderId]);

  const clearOverride = useCallback((defKey: string) => {
    const existing = readJsonStorage<Record<string, string | number>>(catalogOverrideKey(selectedProviderId));
    if (existing) {
      const { [defKey]: _, ...rest } = existing;
      writeJsonStorage(catalogOverrideKey(selectedProviderId), rest);
    }
    setUserOverrides(prev => { const n = { ...prev }; delete n[defKey]; return n; });
    dispatchAppEvent(EVENTS.paramConfigChanged);
  }, [selectedProviderId]);

  // ── Reset to factory defaults (RESET TO DEFAULTS) — instant, deletes user config file ───
  const confirmReset = useCallback(async () => {
    if (!currentProvider || !isPowerUser) return;
    setShowResetConfirm(false);

    try {
      await invoke("reset_provider_user_config", { providerId: selectedProviderId });
      dispatchAppEvent(EVENTS.reloadProviders);
    } catch (err) { console.error("[CONFIG] Reset failed:", err); }

    setUserOverrides({});
    try {
      removeStorage(catalogOverrideKey(selectedProviderId));
      removeStorage(groupOrderKey(selectedProviderId));
    } catch {}
    setCustomGroupOrder(null);
    dispatchAppEvent(EVENTS.paramConfigChanged);
    showSaved("RESET TO DEFAULTS");
  }, [currentProvider, isPowerUser, selectedProviderId]);

  useEffect(() => {
    const unhideAllHiddenParams = async () => {
      if (!currentProvider || !isPowerUser) return;
      const currentUserParams = buildUserSavedParams(currentProvider);
      if (!currentUserParams.some((d) => d.hidden)) return;
      const updatedUserParams = currentUserParams.map((d) =>
        d.hidden ? { ...d, hidden: false } : d,
      );
      const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
      setAllProviders((prev) =>
        prev.map((p) => (p.id !== selectedProviderId ? p : updatedProvider)),
      );
      await persistProviderToConfig(updatedProvider);
      dispatchAppEvent(EVENTS.paramConfigChanged);
      showSaved("UNHIDDEN");
    };
    window.addEventListener(EVENTS.showAllHiddenParams, unhideAllHiddenParams);
    return () => window.removeEventListener(EVENTS.showAllHiddenParams, unhideAllHiddenParams);
  }, [
    currentProvider,
    isPowerUser,
    buildUserSavedParams,
    persistProviderToConfig,
    selectedProviderId,
  ]);

  // ── Admin: add new param definition (from modal) ────────────────────────
  const handleCreatorSubmit = useCallback(async (def: Omit<UserEditedTemplateParam, "order">) => {
    if (!currentProvider || !def.values.length) return;

    const currentUserParams = buildUserSavedParams(currentProvider);
    const maxOrder = Math.max(...currentUserParams.map(d => d.order), -1);
    const newUserParam: UserEditedTemplateParam = { ...def, order: maxOrder + 1 };
    const updatedUserParams = [...currentUserParams, newUserParam];

    // Handle custom group — append to provider.groupOrder if not already there
    let updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
    const newGroup = def.ui_group ? normalizeUiGroup(def.ui_group) : undefined;
    if (newGroup && currentProvider.groupOrder && !currentProvider.groupOrder.some(g => normalizeUiGroup(g) === newGroup)) {
      updatedProvider.groupOrder = [...currentProvider.groupOrder, newGroup];
    }

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    dispatchAppEvent(EVENTS.paramConfigChanged);
    await persistProviderToConfig(updatedProvider);
    setShowCreatorModal(false);
    showSaved("SAVED");
  }, [currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: add param from catalog search ────────────────────────
  const handleCatalogAdd = useCallback(async (entry: RawCatalogEntry) => {
    if (!currentProvider) return;

    const currentUserParams = buildUserSavedParams(currentProvider);
    // Skip if already exists
    if (currentUserParams.some(d => d.key === entry.key)) {
      setShowCatalogSearch(false);
      showSaved("ALREADY ACTIVE");
      return;
    }

    const maxOrder = Math.max(...currentUserParams.map(d => d.order), -1);
    const newParam = catalogEntryToParam(entry, currentUserParams, maxOrder);
    const newUserParam: UserEditedTemplateParam = { ...newParam, order: maxOrder + 1 };
    const updatedUserParams = [...currentUserParams, newUserParam];

    // Ensure "USER-ADDED-FROM-CATALOG" group exists in groupOrder
    let updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
    const catalogGroup = "USER-ADDED-FROM-CATALOG";
    if (currentProvider.groupOrder && !currentProvider.groupOrder.some(g => normalizeUiGroup(g) === catalogGroup)) {
      updatedProvider.groupOrder = [...currentProvider.groupOrder, catalogGroup];
    }

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    dispatchAppEvent(EVENTS.paramConfigChanged);
    await persistProviderToConfig(updatedProvider);
    setShowCatalogSearch(false);
    showSaved("ADDED");
  }, [currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: toggle hidden row (catalog visibility) ───────────────
  const toggleRowHidden = useCallback(async (key: string) => {
    if (!currentProvider || !isPowerUser) return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map(d => d.key === key ? { ...d, hidden: !d.hidden } : d);
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    dispatchAppEvent(EVENTS.paramConfigChanged);
    showSaved("SAVED");
  }, [currentProvider, isPowerUser, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: toggle hidden value (hide from catalog only) ─────────
  const toggleHiddenValue = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || !isPowerUser) return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map(d => {
      if (d.key !== key) return d;
      const hv = d.hiddenValues || [];
      const idx = hv.findIndex(v => String(v) === String(value));
      let newHv: (string | number)[];
      if (idx >= 0) { newHv = [...hv]; newHv.splice(idx, 1); }
      else { newHv = [...hv, value]; }
      return { ...d, hiddenValues: newHv.length > 0 ? newHv : undefined };
    });
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    dispatchAppEvent(EVENTS.paramConfigChanged);
    showSaved("SAVED");
  }, [currentProvider, isPowerUser, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: change default value for a param ─────────────────────
  const changeDefaultValue = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || !isPowerUser) return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map(d => d.key === key ? { ...d, defaultValue: value } : d);
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    dispatchAppEvent(EVENTS.paramConfigChanged);
    showSaved("DEFAULT CHANGED");
  }, [currentProvider, isPowerUser, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: drag reorder ─────────────────────────────────────────
  const swapItems = useCallback(async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || !currentProvider || !isPowerUser) return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const d = [...currentUserParams];
    const [m] = d.splice(fromIdx, 1);
    d.splice(toIdx, 0, m);
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: d.map((x, i) => ({ ...x, order: i })) };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    dispatchAppEvent(EVENTS.paramConfigChanged);
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isPowerUser, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: add value to param (writes to BOTH values and userAddedValues) ───
  const addValueToParam = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || !isPowerUser) return;

    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map(d => {
      if (d.key !== key) return d;
      const vals = [...(d.values || [])];
      const userAdded = [...(d.userAddedValues || [])];
      if (!vals.some(v => String(v) === String(value))) {
        vals.push(value);
      }
      if (!userAdded.some(v => String(v) === String(value))) {
        userAdded.push(value);
      }
      return { ...d, values: vals, userAddedValues: userAdded.length > 0 ? userAdded : undefined };
    });
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    dispatchAppEvent(EVENTS.paramConfigChanged);
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isPowerUser, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: remove value from param ───────────────────────────────
  const removeValueFromParam = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || !isPowerUser) return;

    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map(d => {
      if (d.key !== key) return d;
      const vals = (d.values || []).filter(v => String(v) !== String(value));
      const userAdded = (d.userAddedValues || []).filter(v => String(v) !== String(value));
      let newDefault = d.defaultValue;
      if (String(d.defaultValue) === String(value)) {
        newDefault = vals.length > 0 ? vals[0] : undefined;
      }
      return { ...d, values: vals, userAddedValues: userAdded.length > 0 ? userAdded : undefined, defaultValue: newDefault };
    });
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    dispatchAppEvent(EVENTS.paramConfigChanged);
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isPowerUser, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: open sub-params editor for a value ───────────────────
  const openSubParamsEditor = useCallback((paramKey: string, valueName: string) => {
    if (!currentProvider || !isPowerUser) return;
    setEditingValue({ paramKey, valueName });
    const def = userSavedParamsWithDefaults.find(d => d.key === paramKey);
    const existingArgs = def?.sub_params?.[valueName]?.join(" ") ?? "";
    setSubArgsText(prev => ({ ...prev, [paramKey + "::" + valueName]: existingArgs }));
  }, [userSavedParamsWithDefaults, currentProvider, isPowerUser]);

  // ── Admin: save sub-params edit for a value ─────────────────────
  const saveSubParamsEdit = useCallback(async () => {
    if (!editingValue || !currentProvider) return;
    const { paramKey, valueName } = editingValue;
    const rawText = subArgsText[paramKey + "::" + valueName] ?? "";
    
    // Parse space-separated args
    const args: string[] = rawText.trim().split(/\s+/).filter(Boolean);
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    let updatedUserParams = currentUserParams.map(d => {
      if (d.key !== paramKey) return d;
      const existingSubParams = d.sub_params || {};
      if (args.length > 0) {
        return { ...d, sub_params: { ...existingSubParams, [valueName]: args } };
      } else {
        // Remove the key from sub_params
        const {[valueName]: _, ...rest} = existingSubParams;
        return { ...d, sub_params: Object.keys(rest).length > 0 ? rest : undefined };
      }
    });
    
    // If value not in values array yet, add it
    updatedUserParams = updatedUserParams.map(d => {
      if (d.key !== paramKey) return d;
      const vals = [...(d.values || [])];
      if (!vals.includes(valueName)) { vals.push(valueName); }
      const ua = [...(d.userAddedValues || [])];
      if (!ua.some(v => String(v) === String(valueName))) { ua.push(valueName); }
      return { ...d, values: vals, userAddedValues: ua.length > 0 ? ua : undefined };
    });
    
    // If args empty and sub_params is now gone for this value, remove from values too
    updatedUserParams = updatedUserParams.map(d => {
      if (d.key !== paramKey) return d;
      const sp = d.sub_params || {};
      if (!sp[valueName]) {
        return { ...d, values: (d.values || []).filter(v => String(v) !== valueName) };
      }
      return d;
    });

    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [editingValue, subArgsText, currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: delete a value's sub-params entry and remove from values ─
  const deleteSubParamsEntry = useCallback(async (paramKey: string, valueName: string) => {
    if (!currentProvider || !isPowerUser) return;
    const currentUserParams = buildUserSavedParams(currentProvider);
    let updatedUserParams = currentUserParams.map(d => {
      if (d.key !== paramKey) return d;
      const existingSubParams = d.sub_params || {};
      const {[valueName]: _, ...rest} = existingSubParams;
      return { ...d, sub_params: Object.keys(rest).length > 0 ? rest : undefined };
    });
    // Also remove from values array and userAddedValues
    updatedUserParams = updatedUserParams.map(d => {
      if (d.key !== paramKey) return d;
      const sp = d.sub_params || {};
      if (!sp[valueName]) {
        return {
          ...d,
          values: (d.values || []).filter(v => String(v) !== valueName),
          userAddedValues: ((d.userAddedValues || []) as (string | number)[]).filter(v => String(v) !== valueName).length > 0
            ? (d.userAddedValues || []).filter(v => String(v) !== valueName)
            : undefined,
        };
      }
      return d;
    });
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isPowerUser, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: restore param to provider default (full reset) ─────────
  const handleRestoreParam = useCallback(async (key: string) => {
    if (!currentProvider || !isPowerUser) return;
    try {
      const freshFromTemplateParam: UserEditedTemplateParam = await invoke("reset_param_to_template", {
        providerId: selectedProviderId, paramKey: key
      });
      const currentUserParams = buildUserSavedParams(currentProvider);
      const updatedUserParams = currentUserParams.map(d => d.key === key ? { ...d, ...freshFromTemplateParam } : d);
      const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
      setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
      await persistProviderToConfig(updatedProvider);
      showSaved("RESTORED");
    } catch (err) {
      console.error("[CONFIG] reset_param_to_template failed:", err);
    }
  }, [currentProvider, isPowerUser, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: remove user-added param entirely ──────────────────────
  const handleRemoveParam = useCallback(async (key: string) => {
    if (!currentProvider || !isPowerUser) return;
    try {
      const currentUserParams = buildUserSavedParams(currentProvider);
      const updatedUserParams = currentUserParams.filter(d => d.key !== key);
      const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
      setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
      await persistProviderToConfig(updatedProvider);
      showSaved("REMOVED");
    } catch (err) {
      console.error("[CONFIG] remove param failed:", err);
    }
  }, [currentProvider, isPowerUser, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: open param metadata editor ───────────────────────────
  const openParamMetaEditor = useCallback((def: UserEditedTemplateParam) => {
    setEditingParamKey(def.key);
    setParamMetaForm({
      ptype: def.ptype || "arg_select",
      flag: def.flag ?? "",
      pattern: def.pattern ?? "",
      uiGroup: paramUiGroup(def.ui_group),
      values: (() => { const merged = [...(def.values || [])]; const ua = def.userAddedValues || []; for (const v of ua) { if (!merged.some(x => String(x) === String(v))) merged.push(v); } return merged; })(),
      defaultValue: effectiveParamDefault(def.defaultValue) ?? "",
      subParams: Object.fromEntries(
        Object.entries(def.sub_params || {}).map(([k, v]) => [k, (v as string[]).join(" ")])
      ),
    });
  }, []);

  // ── Admin: save param metadata edit ─────────────────────────────
  const saveParamMetaEdit = useCallback(async () => {
    if (!paramMetaForm || !editingParamKey || !currentProvider) return;
    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map(d => {
      if (d.key !== editingParamKey) return d;
      const subParams: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(paramMetaForm.subParams)) {
        const args = v.trim().split(/\s+/).filter(Boolean);
        if (args.length > 0) subParams[k] = args;
      }
      // Use form.values as source of truth — it contains merged template + user-added values
      let vals = [...paramMetaForm.values];
      // Add any sub_params keys not yet in the value list
      for (const k of Object.keys(paramMetaForm.subParams)) {
        const n = Number.isFinite(Number(k)) ? Number(k) : k;
        if (!vals.some(x => String(x) === String(n))) vals.push(n as string | number);
      }
      // Determine userAddedValues: anything in form.values that wasn't in original d.values
      const origTemplateSet = new Set((d.values || []).map(v => String(v)));
      const newUserAdded = paramMetaForm.values.filter(v => !origTemplateSet.has(String(v)));
      // Also keep previously tracked user-added values still present
      const existingUserAdded = (d.userAddedValues || []).filter(v => vals.some(x => String(x) === String(v)));
      const mergedUserAdded = [...new Set([...existingUserAdded, ...newUserAdded].map(v => String(v)))].map(s => {
        // Preserve original type: try number first
        return Number.isFinite(Number(s)) ? Number(s) : s;
      });
      const newUiGroup = paramUiGroup(paramMetaForm.uiGroup);
      const nextPtype = (paramMetaForm.ptype === d.ptype ? d.ptype : paramMetaForm.ptype) as UserEditedTemplateParam["ptype"];
      const nextDefault = paramMetaForm.defaultValue !== "" && paramMetaForm.defaultValue != null
        ? paramMetaForm.defaultValue
        : undefined;
      return {
        ...d,
        ptype: nextPtype,
        flag: paramMetaForm.flag || null,
        pattern: paramMetaForm.ptype === "path_scanner" ? paramMetaForm.pattern : undefined,
        ui_group: newUiGroup,
        values: vals,
        defaultValue: nextDefault,
        sub_params: Object.keys(subParams).length > 0 ? subParams : undefined,
        userAddedValues: mergedUserAdded.length > 0 ? mergedUserAdded : undefined,
      };
    });

    // Append target group to custom order (preserve existing order — never promote to first)
    const newUiGroup = paramUiGroup(paramMetaForm.uiGroup);
    let updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
    const baseOrder = resolveGroupOrder(updatedUserParams, customGroupOrder);
    if (!baseOrder.includes(newUiGroup)) {
      const newOrder = [...baseOrder, newUiGroup];
      writeJsonStorage(groupOrderKey(selectedProviderId), newOrder);
      setCustomGroupOrder(newOrder);
      updatedProvider = { ...updatedProvider, groupOrder: newOrder };
    }

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    setEditingParamKey(null);
    setParamMetaForm(null);
    showSaved("SAVED");
  }, [paramMetaForm, editingParamKey, currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId, customGroupOrder]);

  // ── Drag state for reorder ───────────────────────────────────────
  const dragKeyRef = useRef<string | null>(null);
  const hasMovedRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const handleDragStart = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    startPosRef.current = { x: e.clientX, y: e.clientY };
    hasMovedRef.current = false;
    dragKeyRef.current = userSavedParamsWithDefaults[idx]?.key ?? null;
    setDragging(true);
  };

  useEffect(() => {
    if (!dragging) return;
    const handleMove = (e: MouseEvent) => {
      const dx = Math.abs(e.clientX - startPosRef.current.x), dy = Math.abs(e.clientY - startPosRef.current.y);
      if (!hasMovedRef.current && (dx > 3 || dy > 3)) hasMovedRef.current = true;
    };
    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
  }, [dragging]);

  useEffect(() => {
    if (!dragging) return;
    const h = (e: MouseEvent) => {
      if (!hasMovedRef.current) { setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false; return; }
      let rowEl: Element | null = document.elementFromPoint(e.clientX, e.clientY);
      while (rowEl && !rowEl.hasAttribute("data-row-idx")) rowEl = rowEl.parentElement;
      if (!rowEl || !dragKeyRef.current) { setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false; return; }
      const targetIdx = parseInt(rowEl.getAttribute("data-row-idx") || "-1", 10);
      if (targetIdx < 0) { setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false; return; }
      const sourceKey = dragKeyRef.current;
      const fromIdx = userSavedParamsWithDefaults.findIndex(d => d.key === sourceKey);
      if (fromIdx < 0 || targetIdx === fromIdx) { setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false; return; }
      swapItems(fromIdx, targetIdx);
      setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false;
    };
    window.addEventListener("mouseup", h, { once: true });
    return () => window.removeEventListener("mouseup", h);
  }, [dragging, userSavedParamsWithDefaults, swapItems]);

  // ── Group drag state for reorder ───────────────────────────────
  const groupDragRef = useRef<string | null>(null);
  const groupHasMovedRef = useRef(false);
  const groupStartPosRef = useRef({ x: 0, y: 0 });
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);

  const handleGroupDragStart = (e: React.MouseEvent, groupName: string) => {
    e.stopPropagation();
    groupStartPosRef.current = { x: e.clientX, y: e.clientY };
    groupHasMovedRef.current = false;
    groupDragRef.current = groupName;
    setDraggingGroup(groupName);
  };

  useEffect(() => {
    if (!draggingGroup) return;
    const handleMove = (e: MouseEvent) => {
      const dx = Math.abs(e.clientX - groupStartPosRef.current.x), dy = Math.abs(e.clientY - groupStartPosRef.current.y);
      if (!groupHasMovedRef.current && (dx > 3 || dy > 3)) groupHasMovedRef.current = true;
    };
    window.addEventListener("mousemove", handleMove);
    return () => window.removeEventListener("mousemove", handleMove);
  }, [draggingGroup]);

  useEffect(() => {
    if (!draggingGroup) return;
    const h = (e: MouseEvent) => {
      if (!groupHasMovedRef.current) { setDraggingGroup(null); groupDragRef.current = null; groupHasMovedRef.current = false; return; }
      let rowEl: Element | null = document.elementFromPoint(e.clientX, e.clientY);
      while (rowEl && !rowEl.hasAttribute("data-group-idx")) rowEl = rowEl.parentElement;
      if (!rowEl || !groupDragRef.current) { setDraggingGroup(null); groupDragRef.current = null; groupHasMovedRef.current = false; return; }
      const targetIdx = parseInt(rowEl.getAttribute("data-group-idx") || "-1", 10);
      if (targetIdx < 0) { setDraggingGroup(null); groupDragRef.current = null; groupHasMovedRef.current = false; return; }

      const currentOrder = resolveGroupOrder(userSavedParamsWithDefaults, customGroupOrder);

      const sourceName = groupDragRef.current;
      const fromIdx = currentOrder.indexOf(sourceName);
      if (fromIdx < 0 || targetIdx === fromIdx) { setDraggingGroup(null); groupDragRef.current = null; groupHasMovedRef.current = false; return; }

      // Reorder groups and persist
      const newOrder = [...currentOrder];
      const [moved] = newOrder.splice(fromIdx, 1);
      newOrder.splice(targetIdx, 0, moved);
      saveGroupOrder(newOrder);
      setDraggingGroup(null); groupDragRef.current = null; groupHasMovedRef.current = false;
    };
    window.addEventListener("mouseup", h, { once: true });
    return () => window.removeEventListener("mouseup", h);
  }, [draggingGroup, userSavedParamsWithDefaults, customGroupOrder, saveGroupOrder]);

  const enabledProviders = useMemo(() => allProviders.filter(p => p.enabled), [allProviders]);

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col overflow-hidden" data-config-page>
      {/* Tab bar */}
      <div className="px-4 py-2 config-section-bar flex items-center gap-1">
        <button onClick={() => setSubTab("providers")} className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "providers" ? "app-nav-tab-active" : ""}`}>PROVIDERS</button>
        <button onClick={() => setSubTab("params")} className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "params" ? "app-nav-tab-active" : ""}`}>PARAMETERS</button>
        <button onClick={() => setSubTab("paths")} data-onboarding="paths-tab" className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "paths" ? "app-nav-tab-active" : ""}`}>PATHS</button>
        <button onClick={() => setSubTab("secrets")} className={`app-nav-tab px-3 py-1 text-[10px] font-mono tracking-wider rounded-sm ${subTab === "secrets" ? "app-nav-tab-active" : ""}`}>SECRETS</button>
       </div>

       {subTab === "providers" ? (
         <div className="flex-1 flex flex-col overflow-hidden min-h-0">
           <ProvidersConfig providers={allProviders} onProvidersChange={setAllProviders} />
         </div>
       ) : subTab === "paths" ? (
         <ModelPathsPanel />
       ) : subTab === "secrets" ? (
         <SecretsConfig />
       ) : (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Toolbar */}
          <div className="px-4 py-2.5 config-section-bar flex items-center justify-between flex-wrap gap-2 relative">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xs font-mono theme-accent-text tracking-widest">PARAMETER CONFIGURATION</h2>
                <button onClick={handleEditorToggle}
                  className={`value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm transition-colors ${
                    isPowerUser ? "value-chip-active" : ""
                  }`}
                  title="Click to toggle editor lock state">
                  {powerUserState === "permanently" ? "\u{1F511} EDITOR — PERMANENTLY UNLOCKED"
                    : powerUserState === "unlocked" ? "\u{1F513} EDITOR — UNLOCKED"
                    : "\u{1F512} EDITOR — LOCKED"}
                </button>
              </div>
              <div className="h-4"></div>

              {enabledProviders.length > 1 && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-[9px] font-mono config-muted uppercase tracking-wider">Provider:</span>
                  {enabledProviders.map(p => (
                    <button key={p.id} onClick={() => setSelectedProviderId(p.id)}
                      className={`px-2 py-0.5 text-[9px] font-mono rounded-sm transition-all ${selectedProviderId === p.id ? "provider-pill-active border" : "provider-pill border"}`}>
                      {p.display_name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Right side: action buttons (UNLOCKED) and legend (LOCKED) — both always rendered, opacity toggled */}
            <div className="ml-auto flex gap-2 items-center">
              {/* Action buttons — visible when unlocked */}
              <div className={`flex gap-2 transition-opacity ${isPowerUser ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                <button
                  type="button"
                  onClick={() => setShowClearStorageConfirm(true)}
                  className="value-chip text-[9px] font-mono px-2 py-1 rounded-sm"
                  title="Clear all BlackOps localStorage (theme, bench chips, catalog overrides, splits) and reload"
                >
                  CLEAR STORAGE
                </button>
                <button onClick={() => setShowResetConfirm(true)}
                  className="value-chip text-[9px] font-mono px-2 py-1 rounded-sm">
                  RESET TO DEFAULTS
                </button>
              </div>
              {/* Legend — visible when locked */}
              <div className={`config-form-panel rounded-sm p-2 transition-opacity ${!isPowerUser ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                <div className="grid grid-cols-[36px_1fr] gap-1 items-center" style={{ gridTemplateColumns: "36px 1fr" }}>
                  <span className="value-chip-active inline-flex items-center justify-center px-2 py-0.5 text-[11px] font-mono rounded-sm">val</span>
                  <span className="text-[8px] font-mono config-muted">Factory default value</span>
                  <span className="value-chip inline-flex items-center justify-center px-2 py-0.5 text-[11px] font-mono rounded-sm border-2 border-dashed">val</span>
                  <span className="text-[8px] font-mono config-muted">USER's new default</span>
                  <span className="value-chip inline-flex items-center justify-center px-2 py-0.5 text-[11px] font-mono rounded-sm opacity-80">val</span>
                  <span className="text-[8px] font-mono config-muted">USER's added values</span>
                </div>
              </div>
            </div>
          </div>

          {/* Reset confirm + saved flash */}
          <div className="relative">
            {showClearStorageConfirm && (
              <div className="absolute inset-0 bg-black/60 z-50" onClick={() => setShowClearStorageConfirm(false)}>
                <div className="config-form-panel rounded-sm p-6 max-w-sm absolute top-[85px] right-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                  <h3 className="text-xs font-mono theme-accent-text mb-3">CLEAR LOCAL STORAGE</h3>
                  <p className="text-[10px] font-mono config-muted mb-4">
                    Removes all BlackOps UI preferences from this machine — theme, zoom, bench chips, catalog overrides, split widths, log search, and per-provider keys. Provider configs on disk are untouched. The app will reload.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => setShowClearStorageConfirm(false)}
                      className="value-chip text-[9px] font-mono px-3 py-1 rounded-sm"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      onClick={() => dispatchClearLocalStorage(true)}
                      className="value-chip-active text-[9px] font-mono px-3 py-1 rounded-sm"
                    >
                      YES, CLEAR
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showResetConfirm && (
              <div className="absolute inset-0 bg-black/60 z-50" onClick={() => setShowResetConfirm(false)}>
                <div className="config-form-panel rounded-sm p-6 max-w-sm absolute top-[85px] right-4 shadow-2xl" onClick={e => e.stopPropagation()}>
                  <h3 className="text-xs font-mono theme-accent-text mb-3">CONFIRM RESET</h3>
                  <p className="text-[10px] font-mono config-muted mb-4">
                    This will reset all parameters to template defaults, remove added params and values, restore hidden items. Cannot be undone.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowResetConfirm(false)}
                      className="value-chip text-[9px] font-mono px-3 py-1 rounded-sm">CANCEL</button>
                    <button onClick={confirmReset}
                      className="value-chip-active text-[9px] font-mono px-3 py-1 rounded-sm">YES, RESET</button>
                  </div>
                </div>
              </div>
            )}

            {/* Saved flash */}
            {savedFlash && (
              <div className="absolute top-0 right-0 px-3 py-1 value-chip-active text-[9px] font-mono rounded-sm animate-pulse">{savedFlash}</div>
            )}
          </div>

          {/* Template update banner — shows when factory template version changed */}
          {currentProvider?.needsTemplateAttention && (
            <div className="mx-4 mt-3 px-3 py-2 foundry-profile-row rounded-sm flex items-start justify-between gap-3">
              <span className="text-[9px] font-mono config-muted leading-tight">
                ⚠ Factory template updated — new options were merged automatically. Save any change to dismiss, or RESET TO DEFAULTS if engines fail to launch.
              </span>
              {isPowerUser && (
                <button onClick={() => setShowResetConfirm(true)}
                  className="shrink-0 value-chip-active text-[8px] font-mono px-2 py-0.5 rounded-sm">RESET NOW</button>
              )}
            </div>
          )}

          {/* Param rows */}
          <div className="flex-1 overflow-y-auto eink-scrollbar p-4 min-h-0">
            {userSavedParamsWithDefaults.length === 0 ? (
              <div className="flex items-center justify-center h-full text-stealth-muted text-xs font-mono">LOADING PARAMETERS...</div>
            ) : (
              (() => {
                const groupOrder = resolveGroupOrder(userSavedParamsWithDefaults, customGroupOrder);

                const groups: Record<string, UserEditedTemplateParam[]> = {};
                for (const def of userSavedParamsWithDefaults) {
                  const g = paramUiGroup(def.ui_group);
                  if (!groups[g]) groups[g] = [];
                  groups[g].push(def);
                }

                return (
                  <div className="space-y-3">
                   {/* Add from catalog — all users; manual entry — power user only */}
                      <div className="flex gap-2 mb-3">
                        <button
                          onClick={() => setShowCatalogSearch(true)}
                          className="flex-1 py-3 text-xl font-mono bg-nv-green/15 border border-nv-green/40 text-nv-green hover:bg-nv-green/25 transition-colors rounded tracking-wider"
                        >
                          + ADD NEW FROM CATALOG
                        </button>
                        {isPowerUser && (
                          <button
                            onClick={() => setShowCreatorModal(true)}
                            className="px-3 py-2 text-[9px] font-mono border border-dashed border-yellow-400/30 text-yellow-400/60 hover:bg-yellow-400/5 hover:border-yellow-400/60 transition-colors rounded"
                          >
                            + MANUAL
                          </button>
                        )}
                      </div>
                    {groupOrder.filter(g => groups[g]).map((groupName, groupIdx) => {
                      const groupParams = groups[groupName];
                      if (!groupParams || groupParams.length === 0) return null;
                      return (
                        <div key={groupName} data-group-idx={groupIdx}>
                          {/* Group header with drag handle */}
                          <div className={`flex items-center gap-1 text-[8px] font-mono tracking-widest uppercase mb-1.5 pb-1 border-b border-stealth-border/30 ${draggingGroup === groupName ? "text-yellow-400" : "text-stealth-muted/60"}`}>
                            {isPowerUser && (
                              <button onMouseDown={(e) => handleGroupDragStart(e, groupName)}
                                className="select-none px-1 cursor-grab active:cursor-grabbing hover:text-nv-green transition-colors"
                                title="Click and drag to reorder group">
                                &#x2630;
                              </button>
                            )}
                            <span>{groupName}</span>
                            <span className="opacity-40">({groupParams.length})</span>
                          </div>
                          <div className="space-y-1.5">
{groupParams.map((def, localIdx) => {
                               const globalIdx = userSavedParamsWithDefaults.findIndex(
                                 (d) => d.key === def.key && d.order === def.order,
                               );
                               const rowKey = `${def.key || "param"}-${def.order}-${localIdx}`;
                               const defKey = def.key;

                               // Effective value: user override > current default
                               const factoryDefault = effectiveParamDefault(def.factoryDefault);
                               const effectiveDefault = effectiveParamDefault(def.defaultValue);
                               const currentOverride = userOverrides[defKey];
                               const currentValue = currentOverride !== undefined
                                 ? String(currentOverride)
                                 : (effectiveDefault !== undefined ? String(effectiveDefault) : "");

                               // Yellow accent: not in provider default params
                               const isUserAdded = providerDefaultParams.length > 0 && !providerDefaultParams.some(gp => gp.key === def.key);

                                 return (
                                    <React.Fragment key={rowKey}>
                                    <div data-row-idx={globalIdx}
                                     className={`flex items-center gap-2 p-2 rounded transition-all duration-150 ${
                                       (dragging && def.key === dragKeyRef.current)
                                         ? "border-yellow-400/60 bg-yellow-400/10 opacity-70"
                                         : def.hidden
                                           ? "opacity-30 grayscale"
                                           : `border ${isUserAdded ? 'border-yellow-400/30' : 'border-stealth-border'} hover:border-stealth-muted ${isUserAdded ? 'bg-yellow-400/3' : ''}`
                                     }`}>

                                   {/* Drag handle — admin only */}
                                   {isPowerUser && (
                                     <button onMouseDown={(e) => handleDragStart(e, globalIdx)}
                                       className="text-[8px] text-stealth-muted select-none px-1 cursor-grab active:cursor-grabbing hover:text-nv-green transition-colors"
                                       title="Click and drag to reorder">&#x2630;</button>
                                   )}

                                   {/* Hidden toggle — admin only */}
                                   {isPowerUser && (
                                     <button onClick={() => toggleRowHidden(def.key)}
                                       className={`text-[10px] select-none transition-colors ${def.hidden ? "text-yellow-400/35" : "text-nv-green/25 hover:text-nv-green"}`}
                                       title={def.hidden ? "Show parameter in catalog" : "Hide from catalog"}>
                                       {def.hidden ? "\u2713" : "\u25EF"}
                                     </button>
                                   )}

                                   {/* Edit param metadata + Restore to provider default — admin only */}
{isPowerUser && (
                                      <div className="flex items-center gap-1 mr-2">
                                        <button onClick={() => openParamMetaEditor(def)}
                                          className="leading-none text-[15px] font-mono text-nv-green/40 hover:text-yellow-400 transition-colors"
                                          title="Edit param metadata">E</button>
                                        {!isUserAdded && (
                                          <button onClick={() => handleRestoreParam(def.key)}
                                            className="leading-none text-[15px] font-mono text-blue-500/50 hover:text-blue-400 transition-colors"
                                            title="Restore this parameter row to DEFAULT">R</button>
                                        )}
                                        {isUserAdded && (
                                          <button onClick={() => handleRemoveParam(def.key)}
                                            className="leading-none text-[15px] font-mono text-red-500/50 hover:text-red-400 transition-colors"
                                            title="Remove this parameter entirely">D</button>
                                        )}
                                      </div>
                                    )}

<span className="w-32 flex flex-col gap-0.5 px-1 py-0.5 truncate" title={def.key}>
                                       <span className={`text-[12px] font-mono leading-tight ${isUserAdded ? 'text-yellow-300' : ''}`}>
                                         {def.label}
                                         
                                       </span>
                                       <span className="text-[8px] font-mono leading-tight text-stealth-muted">{def.key}</span>
                                     </span>

                                   {/* Value bubbles */}
                                   <ValueBubbles
                                     paramKey={def.key}
                                     isPowerUser={isPowerUser}
                                     currentValue={currentValue}
                                      onOverrideChange={(val) => setOverride(defKey, val)}
                                      onClearOverride={() => clearOverride(def.key)}
                                     addValue={isPowerUser ? (v: string | number) => addValueToParam(def.key, v) : undefined}
                                     removeValue={isPowerUser ? (v: string | number) => removeValueFromParam(def.key, v) : undefined}
                                     toggleHiddenValue={isPowerUser ? (_k: string, v: string | number) => toggleHiddenValue(def.key, v) : undefined}
hiddenValues={def.hiddenValues || []}
                                      availableValues={def.values || []}
                                      userAddedValues={def.userAddedValues || []}
                                      defaultValue={effectiveDefault !== undefined ? String(effectiveDefault) : undefined}
                                      factoryDefault={factoryDefault !== undefined ? String(factoryDefault) : undefined}
                                      onChangeDefault={isPowerUser
                                        ? (v: string | number) => changeDefaultValue(def.key, v)
                                        : undefined}
                                      onEditValue={isPowerUser ? (val: string | number) => openSubParamsEditor(def.key, String(val)) : undefined}
                                      ptype={def.ptype}
                                      subParams={def.sub_params || undefined}
                                   />
                                 </div>

                                  {/* Inline editors below the row being edited */}
{editingParamKey === def.key && (
                                     <ParamMetaEditor
                                       editingKey={editingParamKey}
                                       form={paramMetaForm!}
                                       onFieldChange={(field, val) => setParamMetaForm(prev => prev ? ({ ...prev, [field]: val }) : null)}
                                       onSave={saveParamMetaEdit}
                                       onCancel={() => { setEditingParamKey(null); setParamMetaForm(null); }}
                                       existingGroups={existingGroups}
                                     />
                                   )}

                                  {editingValue && editingValue.paramKey === def.key && (
                                    <SubParamsEditor
                                      editingValue={editingValue}
                                      subArgsText={subArgsText}
                                      onTextChange={(k, v) => setSubArgsText(prev => ({ ...prev, [k]: v }))}
                                      onSave={saveSubParamsEdit}
                                      onDelete={deleteSubParamsEntry}
                                      onCancel={() => setEditingValue(null)}
                                    />
                                   )}
                                  </React.Fragment>
                                  );
                             })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              })()
             )}
            </div>

          {/* Status bar footer */}
          <div className="flex-shrink-0 px-4 py-2.5 config-section-bar flex items-center justify-between">
            <span className="text-[9px] font-mono config-muted">{userSavedParamsWithDefaults.length} parameter{userSavedParamsWithDefaults.length !== 1 ? "s" : ""}{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}</span>
            {currentProvider && (<span className="text-[9px] font-mono theme-accent-text">{currentProvider.display_name}</span>)}
          </div>
        </div>
      )}

      {/* Param Catalog Search Modal */}
      {showCatalogSearch && (
        <ParamCatalogSearch
          providerId={selectedProviderId}
          existingKeys={userSavedParams.map(d => d.key)}
          isPowerUser={isPowerUser}
          onAdd={handleCatalogAdd}
          onClose={() => setShowCatalogSearch(false)}
        />
      )}

      {/* Param Creator Modal */}
      {showCreatorModal && (
        <ParamCreatorModal
          existingKeys={userSavedParams.map(d => d.key)}
          existingGroups={existingGroups}
          onClose={() => setShowCreatorModal(false)}
          onSubmit={handleCreatorSubmit}
        />
      )}
    </div>
  );
}

// ── Inline sub-params editor component ─────────────────────────────────
function SubParamsEditor({
  editingValue,
  subArgsText,
  onTextChange,
  onSave,
  onDelete,
  onCancel,
}: {
  editingValue: { paramKey: string; valueName: string };
  subArgsText: Record<string, string>;
  onTextChange: (key: string, val: string) => void;
  onSave: () => void;
  onDelete: (paramKey: string, valueName: string) => void;
  onCancel: () => void;
}) {
  const key = editingValue.paramKey + "::" + editingValue.valueName;
  return (
    <div className="flex items-start gap-2 p-2 mt-1 border border-yellow-400/30 bg-yellow-400/5 rounded">
      <span className="text-[10px] font-mono text-nv-green min-w-fit">{editingValue.valueName}</span>
      <input
        type="text"
        value={subArgsText[key] || ""}
        onChange={(e) => onTextChange(key, e.target.value)}
        placeholder="-flag1 value1 -flag2 value2 ..."
        className="flex-1 bg-transparent border-b border-yellow-400/30 text-[10px] font-mono text-white focus:outline-none px-1"
      />
      <button onClick={onSave}
        className="px-2 py-0.5 text-[9px] font-mono text-nv-green hover:text-white transition-colors">SAVE</button>
      <button onClick={() => onDelete(editingValue.paramKey, editingValue.valueName)}
        className="px-1 py-0.5 text-[9px] font-mono text-red-400/60 hover:text-red-400 transition-colors" title="Remove this sub-param entry">×</button>
      <button onClick={onCancel}
        className="text-[10px] font-mono text-stealth-muted hover:text-white transition-colors leading-none">✕</button>
    </div>
  );
}

// ── Full param metadata editor component ─────────────────────────────────
function ParamMetaEditor({
  editingKey,
  form,
  onFieldChange,
  onSave,
  onCancel,
  existingGroups,
}: {
  editingKey: string;
  form: { ptype: string; flag: string; pattern: string; uiGroup: string; values: (string | number)[]; defaultValue: string | number; subParams: Record<string, string> };
  onFieldChange: (field: string, val: any) => void;
  onSave: () => void;
  onCancel: () => void;
  existingGroups: string[];
}) {
  const [newValInput, setNewValInput] = useState("");
  const [selSubKey, setSelSubKey] = useState<string>("");

  const addValueToForm = () => {
    const t = newValInput.trim();
    if (!t) return;
    let p: string | number;
    if (/^-?\d+$/.test(t)) p = parseInt(t, 10);
    else if (/^-?\d+\.\d+$/.test(t)) p = parseFloat(t);
    else p = t;
    const vals = form.values.includes(p) ? form.values : [...form.values, p];
    onFieldChange("values", vals);
    setNewValInput("");
  };

  return (
    <div className="mt-2 border border-yellow-400/40 bg-[#1a1a2e] rounded p-3">
      <div className="flex items-center justify-between mb-3">
        <span className="text-[10px] font-mono text-yellow-400">{editingKey} — PARAM METADATA</span>
        <button onClick={onCancel} className="text-stealth-muted hover:text-white transition-colors leading-none">✕</button>
      </div>

      {/* ptype + flag row */}
      <div className="flex gap-3 mb-2">
        <div className="flex flex-col gap-0.5">
          <span className="text-[8px] font-mono text-stealth-muted">ptype</span>
          <select value={form.ptype}
            onChange={(e) => onFieldChange("ptype", e.target.value)}
            className="bg-[#1a1a2e] border border-stealth-border/50 text-[10px] font-mono text-white px-1 py-0.5 focus:outline-none rounded">
            <option value="arg_select">arg_select</option>
            <option value="arg_select_double">arg_select_double</option>
            <option value="slider">slider</option>
            <option value="logic_only">logic_only</option>
            <option value="switch_onoff">switch_onoff</option>
            <option value="switch_inverted">switch_inverted</option>
             <option value="path_scanner">path_scanner</option>
           </select>
        </div>

        {form.ptype !== "logic_only" && (
          <div className="flex flex-col gap-0.5">
            <span className="text-[8px] font-mono text-stealth-muted">flag</span>
            <input type="text" value={form.flag}
              onChange={(e) => onFieldChange("flag", e.target.value)}
              placeholder="-my-flag"
              className="w-32 bg-transparent border-b border-stealth-border/50 text-[10px] font-mono text-white focus:outline-none px-1 py-0.5" />
          </div>
       )}
       </div>

        {/* ui_group row */}
        <div className="flex gap-3 mb-2 mt-2 pt-2 border-t border-stealth-border/30">
          <div className="flex flex-col gap-0.5">
            <span className="text-[8px] font-mono text-stealth-muted">group</span>
            <select value={form.uiGroup}
              onChange={(e) => onFieldChange("uiGroup", e.target.value)}
              className="w-48 bg-[#1a1a2e] border border-stealth-border/50 text-[10px] font-mono text-white px-1 py-0.5 focus:outline-none focus:border-nv-green/40 rounded">
              {existingGroups.map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </div>

          {form.ptype === "path_scanner" && (
            <div className="flex flex-col gap-0.5">
              <span className="text-[8px] font-mono text-stealth-muted">pattern</span>
              <input type="text" value={form.pattern}
                onChange={(e) => onFieldChange("pattern", e.target.value)}
                placeholder="*mmproj*"
                className="w-24 bg-transparent border-b border-stealth-border/50 text-[10px] font-mono text-white focus:outline-none px-1 py-0.5" />
            </div>
          )}
        </div>

      {/* values list + default */}
      <div className="mb-2">
        <span className="text-[8px] font-mono text-stealth-muted mr-2">values:</span>
        {form.values.map((v, i) => (
          <span key={i} className={`inline-flex items-center gap-0.5 px-1 py-0.5 border text-[9px] font-mono rounded-sm mr-1 mb-1 ${String(v) === String(form.defaultValue) ? "border-nv-green/70 bg-nv-green/20 text-nv-green" : "border-stealth-border/40 text-white"}`}>
            {String(v)}
            <button onClick={() => {
              const newVals = form.values.filter((_, idx) => idx !== i);
              // Also remove from subParams if exists
              const spCopy = { ...form.subParams };
              delete spCopy[String(v)];
              onFieldChange("subParams", spCopy);
              onFieldChange("values", newVals);
            }} className="text-red-400/50 hover:text-red-400 leading-none">×</button>
            <button onClick={() => onFieldChange("defaultValue", v)}
              title="Set as default" className={`leading-none ${String(v) === String(form.defaultValue) ? "text-nv-green" : "text-stealth-muted/50 hover:text-nv-green"}`}>*</button>
          </span>
        ))}
        <input type="text" value={newValInput}
          onChange={(e) => setNewValInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addValueToForm(); } }}
          placeholder="+add"
          className="w-16 bg-transparent border-b border-stealth-border/50 text-[9px] font-mono text-white focus:outline-none px-1" />
        <button onClick={addValueToForm}
          disabled={!newValInput.trim()}
          className="text-[8px] font-mono text-nv-green/60 hover:text-nv-green transition-colors ml-1">+VAL</button>
      </div>

      {/* sub_params section — only for logic_only or when values have actual sub-params */}
      {(() => {
        const hasSubParams = Object.keys(form.subParams).some(k => form.subParams[k]?.trim());
        const showSection = form.ptype === "logic_only" || hasSubParams;
        if (!showSection) return null;
        return (
          <div className="border-t border-stealth-border/30 pt-2">
            <span className="text-[8px] font-mono text-stealth-muted mr-2">sub-params:</span>
            {form.values.map(v => {
              const k = String(v);
              return (
                <div key={k} className="flex items-center gap-1 mb-1">
                  <button onClick={() => setSelSubKey(k)}
                    className={`text-[9px] font-mono px-1 py-0.5 border rounded-sm ${selSubKey === k ? "border-yellow-400/60 text-yellow-400" : "border-stealth-border/40 text-white"}`}>
                    {k}
                  </button>
                  <input type="text"
                    value={form.subParams[k] || ""}
                    onChange={(e) => {
                      const sp = {...form.subParams};
                      if (e.target.value.trim()) sp[k] = e.target.value;
                      else delete sp[k];
                      onFieldChange("subParams", sp);
                    }}
                    placeholder="(no args)"
                    className="flex-1 bg-transparent border-b border-stealth-border/30 text-[9px] font-mono text-white focus:outline-none px-1" />
                </div>
              );
            })}
          </div>
        );
      })()}

      <button onClick={onSave}
        className="mt-3 px-3 py-1 text-[9px] font-mono border border-nv-green/60 bg-nv-green/20 text-nv-green hover:bg-nv-green/30 transition-colors">APPLY</button>
    </div>
  );
}

// ── Model Paths Panel ────────────────────────────────────────────────

function displayModelPath(path: string): string {
  if (path.startsWith("\\\\?\\UNC\\")) {
    return `\\\\${path.slice("\\\\?\\UNC\\".length)}`;
  }
  if (path.startsWith("\\\\?\\")) {
    return path.slice("\\\\?\\".length);
  }
  return path;
}

function normalizeModelPathKey(path: string): string {
  return displayModelPath(path).replace(/[/\\]+$/, "").toLowerCase();
}

function dedupeModelPaths(paths: ModelPathEntry[]): ModelPathEntry[] {
  const out: ModelPathEntry[] = [];
  for (const entry of paths) {
    const key = normalizeModelPathKey(entry.path);
    const idx = out.findIndex((e) => normalizeModelPathKey(e.path) === key);
    if (idx >= 0) {
      if (entry.isDefault) {
        out[idx] = { ...out[idx], isDefault: true };
      }
      continue;
    }
    out.push(entry);
  }
  return out;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 1 ? 1 : 0)} ${units[i]}`;
}

function ModelPathsPanel() {
  const [paths, setPaths] = useState<ModelPathEntry[]>([]);
  const [diskUsage, setDiskUsage] = useState<PathDiskUsage[]>([]);
  const [loading, setLoading] = useState(true);
  const [pathError, setPathError] = useState<string | null>(null);

  const loadPaths = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        invoke<ModelPathEntry[]>("list_model_paths"),
        invoke<PathDiskUsage[]>("get_disk_usage"),
      ]);
      setPaths(dedupeModelPaths(p));
      setDiskUsage(d);
    } catch (e) {
      console.error("Failed to load model paths:", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadPaths(); }, [loadPaths]);

  const handleAddPath = useCallback(async () => {
    try {
      setPathError(null);
      const selected: string | null = await invoke("open_folder_dialog", { title: "Select Model Folder" });
      if (selected) {
        await invoke("add_model_path", { path: selected, label: null });
        loadPaths();
        dispatchAppEvent(EVENTS.modelPathsChanged);
      }
    } catch (e) {
      console.error("Failed to add model path:", e);
      setPathError(typeof e === "string" ? e : "Failed to add model path");
    }
  }, [loadPaths]);

  const handleRemovePath = useCallback(async (path: string) => {
    if (paths.length <= 1) {
      setPathError("Add another folder before removing the last model path.");
      return;
    }
    try {
      setPathError(null);
      await invoke("remove_model_path", { path });
      loadPaths();
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      const msg = typeof e === "string" ? e : "Failed to remove model path";
      console.error("Failed to remove model path:", msg);
      setPathError(msg);
    }
  }, [loadPaths, paths.length]);

  const handleSetDefault = useCallback(async (path: string) => {
    try {
      await invoke("set_default_model_path", { path });
      loadPaths();
      dispatchAppEvent(EVENTS.modelPathsChanged);
    } catch (e) {
      console.error("Failed to set default model path:", e);
    }
  }, [loadPaths]);

  const getUsage = useCallback((path: string): PathDiskUsage | undefined => {
    return diskUsage.find(d => d.path === path);
  }, [diskUsage]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <span className="text-[10px] font-mono text-stealth-muted animate-pulse">LOADING PATHS...</span>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col overflow-hidden min-h-0">
      {/* Header */}
      <div className="px-4 py-3 border-b border-stealth-border flex items-center justify-between">
        <h2 className="text-xs font-mono text-nv-green tracking-wider">MODEL PATHS</h2>
        <button
          onClick={handleAddPath}
          data-onboarding="add-folder"
          className="px-3 py-1 text-[9px] font-mono border border-nv-green/60 text-nv-green hover:bg-nv-green/15 transition-colors"
        >
          + ADD FOLDER
        </button>
      </div>

      {pathError && (
        <div className="px-4 py-2 border-b border-telemetry-red/30 bg-telemetry-red/5 text-[9px] font-mono text-telemetry-red">
          {pathError}
        </div>
      )}

      {/* Path list */}
      <div className="flex-1 overflow-y-auto p-4 space-y-2">
        {paths.length === 0 && (
          <div className="text-center py-8 text-[10px] font-mono text-stealth-muted">
            NO PATHS CONFIGURED — ADD A FOLDER TO GET STARTED
          </div>
        )}

        {paths.map((entry) => {
          const usage = getUsage(entry.path);
          return (
            <div key={entry.path}
              className={`border rounded-sm p-3 transition-colors ${entry.isDefault ? "border-nv-green/40 bg-nv-green/5" : "border-stealth-border bg-stealth-surface/50"}`}>
              <div className="flex items-start justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    {entry.isDefault && (
                      <span className="text-[8px] font-mono text-nv-green bg-nv-green/15 px-1.5 py-0.5 rounded-sm">DEFAULT</span>
                    )}
                    <span className="text-[10px] font-mono text-white truncate">{entry.label || entry.path}</span>
                  </div>
                  <div className="text-[9px] font-mono text-stealth-muted truncate">{displayModelPath(entry.path)}</div>
                  {usage && (
                    <div className="flex items-center gap-3 mt-1.5">
                      <span className="text-[8px] font-mono text-stealth-muted/70">
                        {usage.fileCount} models · {formatBytes(usage.totalGgufBytes)}
                      </span>
                    </div>
                  )}
                </div>

                <div className="flex items-center gap-1.5 shrink-0">
                  {!entry.isDefault && (
                    <button onClick={() => handleSetDefault(entry.path)}
                      title="Set as default for download"
                      className="px-2 py-0.5 text-[8px] font-mono border border-yellow-400/30 text-yellow-400/70 hover:bg-yellow-400/10 transition-colors">
                      SET AS DEFAULT FOR DOWNLOAD
                    </button>
                  )}
                  <button
                    onClick={() => handleRemovePath(entry.path)}
                    disabled={paths.length <= 1}
                    title={
                      paths.length <= 1
                        ? "Add another folder before removing the last model path"
                        : "Remove this path"
                    }
                    className={`px-2 py-0.5 text-[8px] font-mono border border-red-400/30 text-red-400/70 transition-colors ${
                      paths.length <= 1
                        ? "opacity-30 cursor-not-allowed"
                        : "hover:bg-red-400/10"
                    }`}
                  >
                    REMOVE
                  </button>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer hint */}
      <div className="px-4 py-2 border-t border-stealth-border text-[8px] font-mono text-stealth-muted/50">
        {paths.length === 0
          ? "ADD AT LEAST ONE FOLDER — CATALOG STAYS EMPTY UNTIL A PATH IS SET"
          : paths.length === 1
            ? `DOWNLOADS GO TO ${paths.find(p => p.isDefault)?.label || "DEFAULT PATH"} · ADD ANOTHER FOLDER TO ENABLE REMOVE`
            : `DOWNLOADS GO TO ${paths.find(p => p.isDefault)?.label || "DEFAULT PATH"} · CATALOG MERGES ALL PATHS`}
      </div>
    </div>
  );
}