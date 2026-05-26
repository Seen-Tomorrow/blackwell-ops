// Provider and parameter configuration.

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UserEditedTemplateParam, ProviderConfig, ProviderTemplate, GenesisTemplateParam, ModelPathEntry, PathDiskUsage } from "../lib/types";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import ValueBubbles from "./ValueBubbles";
import ProvidersConfig from "./ProvidersConfig";
import FoundryPage from "./FoundryPage";
import ParamCreatorModal from "./ParamCreatorModal";
import ParamCatalogSearch from "./ParamCatalogSearch";
import { KEYS, overridesKey, groupOrderKey, normalizeUiGroup } from "../lib/storage";
import type { RawCatalogEntry } from "../lib/catalog";
import { catalogEntryToParam } from "../lib/catalog";

// ── Types for template update diff (from Rust check_template_update IPC) ─────────
interface DiffParam {
  key: string;
  label: string;
  defaultValue: string | number;
  values: (string | number)[];
}

interface TemplateDiffResult {
  new_params: DiffParam[];
  orphaned_params: DiffParam[];
}

type ConfigSubTab = "providers" | "params" | "paths" | "foundry";

interface ConfigPageProps {
  providers?: ProviderConfig[];
}

/** Parse a value as int, float, or string. */
function parseValue(v: string): string | number {
  const t = v.trim();
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

export default function ConfigPage({ providers: externalProviders }: ConfigPageProps) {
  const [subTab, setSubTab] = useState<ConfigSubTab>("providers");
  const [selectedProviderId, setSelectedProviderId] = useState<string>(DEFAULT_PROVIDER_ID);
  const [allProviders, setAllProviders] = useState<ProviderConfig[]>(externalProviders || []);
  // Admin lock state — read from global (managed by Layout.tsx header)
  const [adminLockState, setAdminLockState] = useState<string>(() => {
    try { return localStorage.getItem(KEYS.adminLock) || "locked"; } catch { return "locked"; }
  });

  // Listen for admin lock changes from the global header toggle
  useEffect(() => {
    const handler = () => {
      try { setAdminLockState(localStorage.getItem(KEYS.adminLock) || "locked"); } catch {}
    };
    window.addEventListener("admin-lock-changed", handler);
    return () => window.removeEventListener("admin-lock-changed", handler);
  }, []);

  const isAdminLocked = adminLockState === "locked";

  // ── Toggle admin lock (same cycle as POWER USER button) ───────────────
  const handleEditorToggle = useCallback(() => {
    setAdminLockState(prev => {
      const next = prev === "locked" ? "unlocked" : prev === "unlocked" ? "permanently" : "locked";
      try { localStorage.setItem(KEYS.adminLock, next); } catch {}
      window.dispatchEvent(new Event("admin-lock-changed"));
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

  // Template update modal state
  const [templateDiff, setTemplateDiff] = useState<TemplateDiffResult | null>(null);
  const [selectedNewParams, setSelectedNewParams] = useState<Set<string>>(new Set());
  const [selectedOrphanedParams, setSelectedOrphanedParams] = useState<Set<string>>(new Set());
  const [showUpdateModal, setShowUpdateModal] = useState(false);

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
      const stored = localStorage.getItem(overridesKey(selectedProviderId));
      if (stored) setUserOverrides(JSON.parse(stored));
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
      const stored = localStorage.getItem(groupOrderKey(selectedProviderId));
      if (stored) {
        setCustomGroupOrder(JSON.parse(stored).map((g: string) => normalizeUiGroup(g)));
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
    // Persist to localStorage (A)
    try { localStorage.setItem(groupOrderKey(selectedProviderId), JSON.stringify(newOrder.map(normalizeUiGroup))); } catch {}
    setCustomGroupOrder(newOrder);
    // Persist to user_providers_config.json via save_provider (B)
    if (currentProvider) {
      const updated = { ...currentProvider, groupOrder: newOrder };
      try { await invoke("save_provider", { provider: updated }); } catch {}
    }
  }, [selectedProviderId, currentProvider]);

  const buildUserSavedParams = useCallback((provider: ProviderConfig | undefined): UserEditedTemplateParam[] => {
    if (!provider || !provider.userEditedTemplateParams) return [];
    return [...provider.userEditedTemplateParams].sort((a, b) => a.order - b.order);
  }, []);
  const userSavedParams = useMemo(() => buildUserSavedParams(currentProvider), [currentProvider, buildUserSavedParams]);

  // ── Load raw template (for sub_params / ptype at runtime — no reset needed) ───
  const [genesisTemplateParams, setGenesisTemplateParams] = useState<GenesisTemplateParam[]>([]);
  useEffect(() => {
    if (!selectedProviderId) return;
    invoke<ProviderTemplate>("get_template", { providerId: selectedProviderId })
      .then(template => setGenesisTemplateParams(template.params || []))
      .catch(() => {});
  }, [selectedProviderId]);

  // ── Merge base defs with runtime template data (sub_params, ptype) ───────────
  const userSavedParamsWithGenesisDefaults = useMemo(() => {
    if (!userSavedParams.length || !genesisTemplateParams.length) return userSavedParams;
    const templateMap = new Map(genesisTemplateParams.map(p => [p.key, p]));
    return userSavedParams.map(def => {
      const tpl = templateMap.get(def.key);
      if (!tpl) return def;
      // Merge sub_params: disk state (user edits) takes precedence, template fills in new values
      const diskSp = (def as any).sub_params || {};
      const tplSp = (tpl as any).sub_params || {};
      const mergedSubParams = { ...tplSp, ...diskSp };
      return {
        ...def,
        sub_params: Object.keys(mergedSubParams).length > 0 ? mergedSubParams : undefined,
        ptype: tpl.ptype || def.ptype,
      };
    });
  }, [userSavedParams, genesisTemplateParams]);

  // ── Hidden count for status bar ───────────────────────────────────
  const hiddenCount = useMemo(() => userSavedParamsWithGenesisDefaults.filter(d => d.hidden).length, [userSavedParamsWithGenesisDefaults]);

  // ── Existing groups from user-saved + genesis params ───────────────
  const existingGroups = useMemo(() => {
    const seen = new Set<string>(["Feature Flags", "USER-ADDED-FROM-CATALOG"]);
    for (const def of userSavedParamsWithGenesisDefaults) {
      if (def.ui_group) seen.add(def.ui_group);
    }
    for (const gp of genesisTemplateParams) {
      if (gp.ui_group) seen.add(gp.ui_group);
    }
    return Array.from(seen);
  }, [userSavedParamsWithGenesisDefaults, genesisTemplateParams]);
  // Fingerprint guard: only dispatch when params content actually changed, not on reference rotation.
  // Breaks the telemetry poll -> re-render -> dispatch -> refetch providers amplification loop.
  const lastDispatchRef = useRef<string>("");
  useEffect(() => {
    if (userSavedParamsWithGenesisDefaults.length === 0) return;
    const fingerprint = `${userSavedParamsWithGenesisDefaults.length}-${hiddenCount}`;
    if (fingerprint === lastDispatchRef.current) return;
    lastDispatchRef.current = fingerprint;
    window.dispatchEvent(new CustomEvent("param-config-changed", { detail: { totalParams: userSavedParamsWithGenesisDefaults.length, hiddenCount } }));
  }, [userSavedParamsWithGenesisDefaults, hiddenCount]);

  // ── Persist provider to Rust ───────────────────────────────────────
  const persistProviderToConfig = useCallback(async (provider: ProviderConfig) => {
    try {
      await invoke("save_provider", { provider });
    } catch (err) { console.error("[CONFIG] save_provider FAILED:", err); }
  }, []);

  // ── User override (selecting a value for this model + provider) ───
  const setOverride = useCallback((defKey: string, value: string | number) => {
    try { localStorage.setItem(overridesKey(selectedProviderId), JSON.stringify({ [defKey]: value })); } catch {}
    window.dispatchEvent(new CustomEvent("param-config-changed"));
  }, [selectedProviderId]);

  // ── Reset to factory defaults (RESET TO DEFAULTS) ─────────────────
  const confirmReset = useCallback(async () => {
    if (!currentProvider || adminLockState === "locked") return;
    setShowResetConfirm(false);

    try {
      // Get fresh factory defaults resolved through the provider's template_type
      const template = await invoke<ProviderTemplate>("get_template_for_provider", { providerId: selectedProviderId });
      const resetFromGenesisParams: UserEditedTemplateParam[] = (template.params || []).map((p, i) => ({
        key: p.key,
        label: p.label,
        values: p.values as (string | number)[],
        order: i,
        hidden: (p as any).hidden_default ?? false,
        flag: p.flag ?? undefined,
        ptype: p.ptype,
        ui_group: p.ui_group,
        note: p.note,
        pattern: p.pattern,
        sub_params: (p as any).sub_params,
        dock: (p as any).dock || undefined,
        defaultValue: (p as any).default as string | number,
        factoryDefault: (p as any).default as string | number,
      }));

      const updatedProvider = { ...currentProvider, userEditedTemplateParams: resetFromGenesisParams };
      await invoke("save_provider", { provider: updatedProvider });

      // Refresh from backend
      const allProviders = await invoke<ProviderConfig[]>("list_providers");
      setAllProviders(allProviders);
    } catch (err) { console.error("[CONFIG] Reset failed:", err); }

    // Clear localStorage overrides for this provider
    setUserOverrides({});
    try { localStorage.removeItem(overridesKey(selectedProviderId)); } catch {}

    window.dispatchEvent(new CustomEvent("param-config-changed"));
    showSaved("RESET TO DEFAULTS");
  }, [currentProvider, isAdminLocked, selectedProviderId]);

  // ── Check template update (TEMPLATE UPDATE) ─────────────────
  const handleCheckUpdate = useCallback(async () => {
    if (adminLockState === "locked") return;

    try {
      const diff: { new_params: DiffParam[]; orphaned_params: DiffParam[] } =
        await invoke("check_template_update", { providerId: selectedProviderId });

      setTemplateDiff(diff);
      // Pre-select all new params for add, all orphaned for keep
      setSelectedNewParams(new Set(diff.new_params.map(p => p.key)));
      setSelectedOrphanedParams(new Set(diff.orphaned_params.map(p => p.key)));
      setShowUpdateModal(true);
    } catch (err) {
      console.error("[CONFIG] check_template_update failed:", err);
    }
  }, [selectedProviderId]);

  // ── Validate user_providers_config.json schema ───────────────────────
  const handleValidate = useCallback(async () => {
    try {
      const errors: string[] = await invoke("validate_user_providers_meta");
      if (errors.length === 0) {
        alert(`user_providers_config.json is valid — no schema issues found.`);
      } else {
        alert(`user_providers_config.json has ${errors.length} issue(s):\n${errors.join("\n")}`);
      }
    } catch (err) {
      console.error("[CONFIG] validate_user_providers_meta failed:", err);
    }
  }, []);

  // ── Apply template update with user-selected params ───────────────
  const handleApplyTemplateUpdate = useCallback(async () => {
    if (!templateDiff || !currentProvider) return;

    try {
      // Build the param_def to add (only selected new ones)
      const template = await invoke<ProviderTemplate>("get_template", { providerId: selectedProviderId });
      const templateNewParamsToAdd: UserEditedTemplateParam[] = [];
      for (const p of template.params) {
        if (selectedNewParams.has(p.key)) {
          templateNewParamsToAdd.push({
            key: p.key,
            label: p.label,
            values: p.values as (string | number)[],
            order: currentProvider.userEditedTemplateParams.length + templateNewParamsToAdd.length,
        hidden: (p as any).hidden_default ?? false,
            flag: p.flag ?? undefined,
            ptype: p.ptype,
            ui_group: p.ui_group,
            note: p.note,
            pattern: p.pattern,
            sub_params: (p as any).sub_params,
            defaultValue: (p as any).default as string | number,
            factoryDefault: (p as any).default as string | number,
          });
        }
      }

      const orphanedToRemove = templateDiff.orphaned_params
        .filter(p => !selectedOrphanedParams.has(p.key))
        .map(p => p.key);

      if (templateNewParamsToAdd.length > 0 || orphanedToRemove.length > 0) {
        await invoke("apply_template_update", {
          providerId: selectedProviderId,
          addParams: templateNewParamsToAdd,
          removeKeys: orphanedToRemove,
        });

        // Refresh from backend
        const allProviders = await invoke<ProviderConfig[]>("list_providers");
        setAllProviders(allProviders);
      }
    } catch (err) { console.error("[CONFIG] apply_template_update failed:", err); }

    setShowUpdateModal(false);
    setTemplateDiff(null);
    setSelectedNewParams(new Set());
    setSelectedOrphanedParams(new Set());
    showSaved("TEMPLATE UPDATED");
  }, [templateDiff, currentProvider, selectedProviderId, selectedNewParams, selectedOrphanedParams]);

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
    window.dispatchEvent(new CustomEvent("param-config-changed"));
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
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    setShowCatalogSearch(false);
    showSaved("ADDED");
  }, [currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // Legacy: simple add (kept for backward compat)
  const addParamDefinition = useCallback(async (key: string, values: (string | number)[]) => {
    if (!currentProvider || !values.length) return;

    const currentUserParams = buildUserSavedParams(currentProvider);
    const maxOrder = Math.max(...currentUserParams.map(d => d.order), -1);
    const newUserParam: UserEditedTemplateParam = { key, label: key, values, order: maxOrder + 1 };
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: [...currentUserParams, newUserParam] };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: remove param definition ───────────────────────────────
  const removeParamDefinition = useCallback(async (key: string) => {
    if (!currentProvider || adminLockState === "locked") return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.filter(d => d.key !== key);
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    setUserOverrides(prev => {
      const n = { ...prev };
      delete n[key];
      try { localStorage.setItem(overridesKey(selectedProviderId), JSON.stringify(n)); } catch {}
      return n;
    });
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: toggle hidden row (catalog visibility) ───────────────
  const toggleRowHidden = useCallback(async (key: string) => {
    if (!currentProvider || adminLockState === "locked") return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map(d => d.key === key ? { ...d, hidden: !d.hidden } : d);
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: toggle hidden value (hide from catalog only) ─────────
  const toggleHiddenValue = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || adminLockState === "locked") return;
    
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
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: change default value for a param ─────────────────────
  const changeDefaultValue = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || adminLockState === "locked") return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map(d => d.key === key ? { ...d, defaultValue: value } : d);
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    showSaved("DEFAULT CHANGED");
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: drag reorder ─────────────────────────────────────────
  const swapItems = useCallback(async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || !currentProvider || adminLockState === "locked") return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const d = [...currentUserParams];
    const [m] = d.splice(fromIdx, 1);
    d.splice(toIdx, 0, m);
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: d.map((x, i) => ({ ...x, order: i })) };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: add value to param (writes to BOTH values and userAddedValues) ───
  const addValueToParam = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || adminLockState === "locked") return;

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
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: remove value from param ───────────────────────────────
  const removeValueFromParam = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || adminLockState === "locked") return;

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
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: open sub-params editor for a value ───────────────────
  const openSubParamsEditor = useCallback((paramKey: string, valueName: string) => {
    if (!currentProvider || adminLockState === "locked") return;
    setEditingValue({ paramKey, valueName });
    const def = userSavedParamsWithGenesisDefaults.find(d => d.key === paramKey);
    const existingArgs = (def as any)?.sub_params?.[valueName]?.join(" ") ?? "";
    setSubArgsText(prev => ({ ...prev, [paramKey + "::" + valueName]: existingArgs }));
  }, [userSavedParamsWithGenesisDefaults, currentProvider, isAdminLocked]);

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
      const existingSubParams = (d as any).sub_params || {};
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
      const sp = (d as any).sub_params || {};
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
    if (!currentProvider || adminLockState === "locked") return;
    const currentUserParams = buildUserSavedParams(currentProvider);
    let updatedUserParams = currentUserParams.map(d => {
      if (d.key !== paramKey) return d;
      const existingSubParams = (d as any).sub_params || {};
      const {[valueName]: _, ...rest} = existingSubParams;
      return { ...d, sub_params: Object.keys(rest).length > 0 ? rest : undefined };
    });
    // Also remove from values array and userAddedValues
    updatedUserParams = updatedUserParams.map(d => {
      if (d.key !== paramKey) return d;
      const sp = (d as any).sub_params || {};
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
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: restore param to genesis template (full reset) ─────────
  const handleRestoreParam = useCallback(async (key: string) => {
    if (!currentProvider || adminLockState === "locked") return;
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
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: remove user-added param entirely ──────────────────────
  const handleRemoveParam = useCallback(async (key: string) => {
    if (!currentProvider || adminLockState === "locked") return;
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
  }, [currentProvider, isAdminLocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: open param metadata editor ───────────────────────────
  const openParamMetaEditor = useCallback((def: UserEditedTemplateParam) => {
    setEditingParamKey(def.key);
    setParamMetaForm({
      ptype: (def as any).ptype || "arg_select",
      flag: (def as any).flag ?? "",
      pattern: (def as any).pattern ?? "",
      uiGroup: def.ui_group || "Feature Flags",
      values: (() => { const merged = [...(def.values || [])]; const ua = def.userAddedValues || []; for (const v of ua) { if (!merged.some(x => String(x) === String(v))) merged.push(v); } return merged; })(),
      defaultValue: def.defaultValue ?? "",
      subParams: Object.fromEntries(
        Object.entries((def as any).sub_params || {}).map(([k, v]) => [k, (v as string[]).join(" ")])
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
      // Determine new ui_group — persist change if different from current
      const newUiGroup = paramMetaForm.uiGroup || "Feature Flags";
      return {
        ...d,
        ptype: paramMetaForm.ptype !== "arg_select" && paramMetaForm.ptype !== "logic_only" ? undefined : (paramMetaForm.ptype === d.ptype ? d.ptype : paramMetaForm.ptype),
        flag: paramMetaForm.flag || null,
        pattern: paramMetaForm.ptype === "path_scanner" ? paramMetaForm.pattern : undefined,
        ui_group: newUiGroup !== d.ui_group ? newUiGroup : d.ui_group || undefined,
        values: vals,
        defaultValue: paramMetaForm.defaultValue !== "" ? paramMetaForm.defaultValue : undefined,
        sub_params: Object.keys(subParams).length > 0 ? subParams : undefined,
        userAddedValues: mergedUserAdded.length > 0 ? mergedUserAdded : undefined,
      };
    });

    // Ensure the new group exists in groupOrder if it's a new group
    const newGroup = paramMetaForm.uiGroup ? normalizeUiGroup(paramMetaForm.uiGroup) : undefined;
    let updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
    if (newGroup && currentProvider.groupOrder && !currentProvider.groupOrder.some(g => normalizeUiGroup(g) === newGroup)) {
      updatedProvider.groupOrder = [...currentProvider.groupOrder, newGroup];
    }

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    setEditingParamKey(null);
    setParamMetaForm(null);
    showSaved("SAVED");
  }, [paramMetaForm, editingParamKey, currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Drag state for reorder ───────────────────────────────────────
  const dragKeyRef = useRef<string | null>(null);
  const hasMovedRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const handleDragStart = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    startPosRef.current = { x: e.clientX, y: e.clientY };
    hasMovedRef.current = false;
    dragKeyRef.current = userSavedParamsWithGenesisDefaults[idx]?.key ?? null;
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
      const fromIdx = userSavedParamsWithGenesisDefaults.findIndex(d => d.key === sourceKey);
      if (fromIdx < 0 || targetIdx === fromIdx) { setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false; return; }
      swapItems(fromIdx, targetIdx);
      setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false;
    };
    window.addEventListener("mouseup", h, { once: true });
    return () => window.removeEventListener("mouseup", h);
  }, [dragging, userSavedParamsWithGenesisDefaults, swapItems]);

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

      // Derive current groups for comparison
      const seen = new Set<string>();
      const derivedOrder: string[] = [];
      for (const def of userSavedParamsWithGenesisDefaults) {
        const g = def.ui_group || "Feature Flags";
        if (!seen.has(g)) { seen.add(g); derivedOrder.push(g); }
      }
      const currentOrder = (customGroupOrder && customGroupOrder.length > 0)
        ? [...customGroupOrder.filter(g => seen.has(g)), ...derivedOrder.filter(g => !customGroupOrder!.includes(g))]
        : derivedOrder;

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
  }, [draggingGroup, userSavedParamsWithGenesisDefaults, customGroupOrder, saveGroupOrder]);

  const enabledProviders = useMemo(() => allProviders.filter(p => p.enabled), [allProviders]);

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="px-4 py-2 border-b border-stealth-border flex items-center gap-1">
        <button onClick={() => setSubTab("providers")} className={`px-3 py-1 text-[10px] font-mono tracking-wider transition-colors ${subTab === "providers" ? "text-nv-green border-b border-nv-green/60" : "text-stealth-muted hover:text-white"}`}>PROVIDERS</button>
        <button onClick={() => setSubTab("params")} className={`px-3 py-1 text-[10px] font-mono tracking-wider transition-colors ${subTab === "params" ? "text-nv-green border-b border-nv-green/60" : "text-stealth-muted hover:text-white"}`}>PARAMETERS</button>
        <button onClick={() => setSubTab("paths")} className={`px-3 py-1 text-[10px] font-mono tracking-wider transition-colors ${subTab === "paths" ? "text-nv-green border-b border-nv-green/60" : "text-stealth-muted hover:text-white"}`}>PATHS</button>
        <button onClick={() => setSubTab("foundry")} className={`px-3 py-1 text-[10px] font-mono tracking-wider transition-colors ${subTab === "foundry" ? "text-nv-green border-b border-nv-green/60" : "text-stealth-muted hover:text-white"}`}>FOUNDRY</button>
      </div>

      {subTab === "providers" ? (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          <ProvidersConfig providers={allProviders} onProvidersChange={setAllProviders} onNavigateToFoundry={() => setSubTab("foundry")} />
        </div>
      ) : subTab === "paths" ? (
        <ModelPathsPanel />
      ) : subTab === "foundry" ? (
        <FoundryPage providers={allProviders} onProvidersChange={setAllProviders} />
      ) : (
        <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Toolbar */}
          <div className="px-4 py-3 border-b border-stealth-border flex items-center justify-between flex-wrap gap-2 relative">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-xs font-mono text-nv-green tracking-wider">PARAMETER CONFIGURATION</h2>
                <span className="text-[10px] text-stealth-border/60">|</span>
                <button onClick={handleEditorToggle}
                  className={`text-[9px] font-mono transition-colors hover:text-yellow-400 ${
                    adminLockState === "permanently"
                      ? "text-yellow-400"
                      : adminLockState === "unlocked" ? "text-yellow-400" : "text-stealth-muted"
                  }`}
                  title="Click to toggle editor lock state">
                  {adminLockState === "permanently" ? "\u{1F511} EDITOR — PERMANENTLY UNLOCKED"
                    : adminLockState === "unlocked" ? "\u{1F513} EDITOR — UNLOCKED"
                    : "\u{1F512} EDITOR — LOCKED"}
                </button>
              </div>
              <div className="h-4"></div>

              {enabledProviders.length > 1 && (
                <div className="flex items-center gap-2 mt-2">
                  <span className="text-[9px] font-mono text-stealth-muted uppercase tracking-wider">Provider:</span>
                  {enabledProviders.map(p => (
                    <button key={p.id} onClick={() => setSelectedProviderId(p.id)}
                      className={`px-2 py-0.5 text-[9px] font-mono border transition-all ${selectedProviderId === p.id ? "bg-nv-green/30 text-nv-green border-nv-green/60" : "text-stealth-muted border-stealth-border hover:text-white"}`}>
                      {p.display_name}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Right side: action buttons (UNLOCKED) and legend (LOCKED) — both always rendered, opacity toggled */}
            <div className="ml-auto flex gap-2 items-center">
              {/* Action buttons — visible when unlocked */}
              <div className={`flex gap-2 transition-opacity ${adminLockState !== "locked" ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                <button onClick={() => setShowResetConfirm(true)}
                  className="px-2 py-1 text-[9px] font-mono border border-yellow-400/40 text-yellow-400 hover:bg-yellow-500/20 transition-colors">
                  RESET TO DEFAULTS
                </button>
                <button onClick={handleCheckUpdate}
                  className="px-2 py-1 text-[9px] font-mono border border-telemetry-cyan/40 text-telemetry-cyan hover:bg-telemetry-cyan/20 transition-colors">
                  TEMPLATE UPDATE
                </button>
                <button onClick={handleValidate}
                  className="px-2 py-1 text-[9px] font-mono border border-orange-400/40 text-orange-400 hover:bg-orange-500/20 transition-colors">
                  VALIDATE
                </button>
              </div>
              {/* Legend — visible when locked */}
              <div className={`border border-stealth-border/50 rounded-sm p-2 transition-opacity ${adminLockState === "locked" ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                <div className="grid grid-cols-[36px_1fr] gap-1 items-center" style={{ gridTemplateColumns: "36px 1fr" }}>
                  <span className="inline-flex items-center justify-center px-2 py-0.5 text-[11px] font-mono rounded-sm bg-nv-green/30 border-double border-2 border-nv-green/70 text-nv-green">val</span>
                  <span className="text-[8px] font-mono text-stealth-muted">Factory default value</span>
                  <span className="inline-flex items-center justify-center px-2 py-0.5 text-[11px] font-mono rounded-sm bg-nv-green/30 border-double border-2 border-yellow-400/80 text-yellow-300">val</span>
                  <span className="text-[8px] font-mono text-stealth-muted">USER's new default</span>
                  <span className="inline-flex items-center justify-center px-2 py-0.5 text-[11px] font-mono rounded-sm bg-nv-green/10 border border-nv-green/30 text-yellow-300">val</span>
                  <span className="text-[8px] font-mono text-stealth-muted">USER's added values</span>
                </div>
              </div>
            </div>
          </div>

          {/* Reset confirm + saved flash */}
          <div className="relative">
            {showResetConfirm && (
              <div className="absolute inset-0 bg-black/60 z-50" onClick={() => setShowResetConfirm(false)}>
                <div className="bg-[#1a1a2e] border border-yellow-400/40 rounded-lg p-6 max-w-sm absolute top-[85px] right-4" onClick={e => e.stopPropagation()}>
                  <h3 className="text-xs font-mono text-yellow-400 mb-3">CONFIRM RESET</h3>
                  <p className="text-[10px] font-mono text-stealth-muted mb-4">
                    This will reset all parameters to template defaults, remove added params and values, restore hidden items. Cannot be undone.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button onClick={() => setShowResetConfirm(false)}
                      className="px-3 py-1 text-[9px] font-mono border border-stealth-border/40 text-stealth-muted hover:text-white transition-colors">CANCEL</button>
                    <button onClick={confirmReset}
                      className="px-3 py-1 text-[9px] font-mono border border-yellow-400/60 bg-yellow-400/20 text-yellow-400 hover:bg-yellow-500/30 transition-colors">YES, RESET</button>
                  </div>
                </div>
              </div>
            )}

            {/* Saved flash */}
            {savedFlash && (
              <div className="absolute top-0 right-0 px-3 py-1 bg-nv-green/30 border border-nv-green/60 text-nv-green text-[9px] font-mono rounded-sm animate-pulse">{savedFlash}</div>
            )}
          </div>

          {/* Param rows */}
          <div className="flex-1 overflow-y-auto p-4 min-h-0">
            {userSavedParamsWithGenesisDefaults.length === 0 ? (
              <div className="flex items-center justify-center h-full text-stealth-muted text-xs font-mono">LOADING PARAMETERS...</div>
            ) : (
              (() => {
                // Derive group order: custom (user-set) > template insertion order
                const seen = new Set<string>();
                const derivedOrder: string[] = [];
                for (const def of userSavedParamsWithGenesisDefaults) {
                  const g = def.ui_group || "Feature Flags";
                  if (!seen.has(g)) {
                    seen.add(g);
                    derivedOrder.push(g);
                  }
                }
                // Use custom order if set, otherwise use template insertion order
                const groupOrder: string[] = (customGroupOrder && customGroupOrder.length > 0)
                  ? [...customGroupOrder.filter(g => seen.has(g)), ...derivedOrder.filter(g => !customGroupOrder!.includes(g))]
                  : derivedOrder;

                const groups: Record<string, UserEditedTemplateParam[]> = {};
                for (const def of userSavedParamsWithGenesisDefaults) {
                  const g = def.ui_group || "Feature Flags";
                  if (!groups[g]) groups[g] = [];
                  groups[g].push(def);
                }

                return (
                  <div className="space-y-3">
                   {/* Add new param — admin only */}
                      {adminLockState !== "locked" && (
                        <div className="flex gap-2 mb-3">
                           <button
                             onClick={() => setShowCatalogSearch(true)}
                             className="flex-1 py-3 text-xl font-mono bg-nv-green/15 border border-nv-green/40 text-nv-green hover:bg-nv-green/25 transition-colors rounded tracking-wider"
                           >
                            + ADD NEW FROM CATALOG
                           </button>
                          <button
                            onClick={() => setShowCreatorModal(true)}
                            className="px-3 py-2 text-[9px] font-mono border border-dashed border-yellow-400/30 text-yellow-400/60 hover:bg-yellow-400/5 hover:border-yellow-400/60 transition-colors rounded"
                          >
                            + MANUAL
                          </button>
                        </div>
                      )}
                    {groupOrder.filter(g => groups[g]).map((groupName, groupIdx) => {
                      const groupParams = groups[groupName];
                      if (!groupParams || groupParams.length === 0) return null;
                      return (
                        <div key={groupName} data-group-idx={groupIdx}>
                          {/* Group header with drag handle */}
                          <div className={`flex items-center gap-1 text-[8px] font-mono tracking-widest uppercase mb-1.5 pb-1 border-b border-stealth-border/30 ${draggingGroup === groupName ? "text-yellow-400" : "text-stealth-muted/60"}`}>
                            {adminLockState !== "locked" && (
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
{groupParams.map((def) => {
                               const globalIdx = userSavedParamsWithGenesisDefaults.findIndex(d => d.key === def.key);
                               const defKey = def.key;

                               // Effective value: user override > current default
                               const factoryDefault = (def as any).factoryDefault;
                               const effectiveDefault = def.defaultValue !== undefined ? String(def.defaultValue) : undefined;
                               const currentOverride = userOverrides[defKey];
                               const currentValue = currentOverride !== undefined ? String(currentOverride) : (effectiveDefault ?? "");

                               // Yellow accent: not in genesis template
                               const isUserAdded = genesisTemplateParams.length > 0 && !genesisTemplateParams.some(gp => gp.key === def.key);

                                 return (
                                    <React.Fragment key={`row-${globalIdx}`}>
                                    <div data-row-idx={globalIdx}
                                     className={`flex items-center gap-2 p-2 rounded transition-all duration-150 ${
                                       (dragging && def.key === dragKeyRef.current)
                                         ? "border-yellow-400/60 bg-yellow-400/10 opacity-70"
                                         : def.hidden
                                           ? "opacity-30 grayscale"
                                           : `border ${isUserAdded ? 'border-yellow-400/30' : 'border-stealth-border'} hover:border-stealth-muted ${isUserAdded ? 'bg-yellow-400/3' : ''}`
                                     }`}>

                                   {/* Drag handle — admin only */}
                                   {adminLockState !== "locked" && (
                                     <button onMouseDown={(e) => handleDragStart(e, globalIdx)}
                                       className="text-[8px] text-stealth-muted select-none px-1 cursor-grab active:cursor-grabbing hover:text-nv-green transition-colors"
                                       title="Click and drag to reorder">&#x2630;</button>
                                   )}

                                   {/* Hidden toggle — admin only */}
                                   {adminLockState !== "locked" && (
                                     <button onClick={() => toggleRowHidden(def.key)}
                                       className={`text-[10px] select-none transition-colors ${def.hidden ? "text-yellow-400/35" : "text-nv-green/25 hover:text-nv-green"}`}
                                       title={def.hidden ? "Show parameter in catalog" : "Hide from catalog"}>
                                       {def.hidden ? "\u2713" : "\u25EF"}
                                     </button>
                                   )}

                                   {/* Edit param metadata + Restore to genesis — admin only */}
{adminLockState !== "locked" && (
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
                                     isAdmin={adminLockState !== "locked"}
                                     currentValue={currentValue}
                                     onOverrideChange={(val) => setOverride(defKey, val)}
                                     addValue={adminLockState !== "locked" ? (v: string | number) => addValueToParam(def.key, v) : undefined}
                                     removeValue={adminLockState !== "locked" ? (v: string | number) => removeValueFromParam(def.key, v) : undefined}
                                     toggleHiddenValue={adminLockState !== "locked" ? (_k: string, v: string | number) => toggleHiddenValue(def.key, v) : undefined}
                                     hiddenValues={(def as any).hiddenValues || []}
                                     availableValues={def.values || []}
                                     userAddedValues={(def as any).userAddedValues || []}
                                     defaultValue={effectiveDefault}
                                     factoryDefault={factoryDefault !== undefined ? String(factoryDefault) : undefined}
                                     onChangeDefault={adminLockState !== "locked"
                                       ? (v: string | number) => changeDefaultValue(def.key, v)
                                       : undefined}
                                     onEditValue={adminLockState !== "locked" ? (val: string | number) => openSubParamsEditor(def.key, String(val)) : undefined}
                                     ptype={(def as any).ptype}
                                     subParams={(def as any).sub_params || undefined}
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
          <div className="flex-shrink-0 px-4 py-3 border-t border-stealth-border flex items-center justify-between">
            <span className="text-[9px] font-mono text-stealth-muted">{userSavedParamsWithGenesisDefaults.length} parameter{userSavedParamsWithGenesisDefaults.length !== 1 ? "s" : ""}{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}</span>
            {currentProvider && (<span className="text-[9px] font-mono text-telemetry-cyan">{currentProvider.display_name}</span>)}
          </div>
        </div>
      )}

      {/* Template Update Modal */}
      {showUpdateModal && templateDiff && (
        <TemplateUpdateModal
          diff={templateDiff}
          selectedNewParams={selectedNewParams}
          selectedOrphanedParams={selectedOrphanedParams}
          providerId={selectedProviderId}
          onToggleNew={(key) => setSelectedNewParams(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })}
          onToggleOrphaned={(key) => setSelectedOrphanedParams(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })}
          onCancel={() => { setShowUpdateModal(false); setTemplateDiff(null); setSelectedNewParams(new Set()); setSelectedOrphanedParams(new Set()); }}
          onApply={handleApplyTemplateUpdate}
        />
      )}

      {/* Param Catalog Search Modal */}
      {showCatalogSearch && (
        <ParamCatalogSearch
          providerId={selectedProviderId}
          existingKeys={userSavedParams.map(d => d.key)}
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
            <option value="logic_only">logic_only</option>
            <option value="switch_onoff">switch_onoff</option>
            <option value="switch_inverted">switch_inverted</option>
             <option value="mapper">mapper</option>
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

// ── Sub-components ─────────────────────────────────────────────────

function TemplateUpdateModal({
  diff,
  selectedNewParams,
  selectedOrphanedParams,
  onToggleNew,
  onToggleOrphaned,
  onCancel,
  onApply,
  providerId,
}: {
  diff: { new_params: DiffParam[]; orphaned_params: DiffParam[] };
  selectedNewParams: Set<string>;
  selectedOrphanedParams: Set<string>;
  onToggleNew: (key: string) => void;
  onToggleOrphaned: (key: string) => void;
  onCancel: () => void;
  onApply: () => void;
  providerId: string;
}) {
  return (
    <div className="fixed inset-0 bg-black/70 z-50 flex items-center justify-center" onClick={onCancel}>
      <div className="bg-[#1a1a2e] border border-telemetry-cyan/40 rounded-lg p-6 max-w-2xl w-full mx-4 max-h-[80vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h2 className="text-xs font-mono text-telemetry-cyan mb-1">TEMPLATE UPDATE</h2>
        <p className="text-[9px] font-mono text-stealth-muted mb-4">
          Genesis template has changed. Select new params to add or orphaned params to keep.
        </p>

        {diff.new_params.length > 0 && (
          <>
            <h3 className="text-[10px] font-mono text-nv-green mb-2">NEW IN TEMPLATE — CHECK TO ADD</h3>
            {diff.new_params.map(p => (
              <div key={p.key} className="flex items-center gap-2 py-1">
                <input type="checkbox"
                  checked={selectedNewParams.has(p.key)}
                  onChange={() => onToggleNew(p.key)}
                  className="accent-telemetry-cyan"
                />
                <span className="text-[10px] font-mono text-white">{p.label}</span>
                <span className="text-[9px] font-mono text-stealth-muted">({String(p.defaultValue)})</span>
              </div>
            ))}
          </>
        )}

        {diff.orphaned_params.length > 0 && (
          <>
            <h3 className="text-[10px] font-mono mt-4 mb-2 text-yellow-400">
              ORPHANED PARAMS — UNCHECK TO REMOVE
            </h3>
            {diff.orphaned_params.map(p => (
              <div key={p.key} className="flex items-center gap-2 py-1">
                <input type="checkbox"
                  checked={selectedOrphanedParams.has(p.key)}
                  onChange={() => onToggleOrphaned(p.key)}
                  className="accent-yellow-400"
                />
                <span className={`text-[10px] font-mono ${selectedOrphanedParams.has(p.key) ? "text-white" : "line-through text-stealth-muted"}`}>
                  {p.label}
                </span>
              </div>
            ))}
          </>
        )}

        {diff.new_params.length === 0 && diff.orphaned_params.length === 0 && (
          <p className="text-[10px] font-mono text-nv-green">No changes detected — template is up to date.</p>
        )}

        <div className="flex gap-2 justify-end mt-6">
          <button onClick={onCancel}
            className="px-4 py-1 text-[9px] font-mono border border-stealth-border/40 text-stealth-muted hover:text-white transition-colors">CANCEL</button>
          <button onClick={onApply}
            className="px-4 py-1 text-[9px] font-mono border border-telemetry-cyan/60 bg-telemetry-cyan/20 text-telemetry-cyan hover:bg-telemetry-cyan/30 transition-colors">APPLY UPDATE</button>
        </div>
      </div>
    </div>
  );
}

// ── Model Paths Panel ────────────────────────────────────────────────

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

  const loadPaths = useCallback(async () => {
    try {
      const [p, d] = await Promise.all([
        invoke<ModelPathEntry[]>("list_model_paths"),
        invoke<PathDiskUsage[]>("get_disk_usage"),
      ]);
      setPaths(p);
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
      const selected: string | null = await invoke("open_folder_dialog", { title: "Select Model Folder" });
      if (selected) {
        await invoke("add_model_path", { path: selected, label: null });
        loadPaths();
      }
    } catch (e) {
      console.error("Failed to add model path:", e);
    }
  }, [loadPaths]);

  const handleRemovePath = useCallback(async (path: string) => {
    try {
      await invoke("remove_model_path", { path });
      loadPaths();
    } catch (e) {
      console.error("Failed to remove model path:", e);
    }
  }, [loadPaths]);

  const handleSetDefault = useCallback(async (path: string) => {
    try {
      await invoke("set_default_model_path", { path });
      loadPaths();
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
        <button onClick={handleAddPath}
          className="px-3 py-1 text-[9px] font-mono border border-nv-green/60 text-nv-green hover:bg-nv-green/15 transition-colors">
          + ADD FOLDER
        </button>
      </div>

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
                  <div className="text-[9px] font-mono text-stealth-muted truncate">{entry.path}</div>
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
                      title="Set as default download target"
                      className="px-2 py-0.5 text-[8px] font-mono border border-yellow-400/30 text-yellow-400/70 hover:bg-yellow-400/10 transition-colors">
                      SET DEFAULT
                    </button>
                  )}
                  <button onClick={() => handleRemovePath(entry.path)}
                    title="Remove this path"
                    className="px-2 py-0.5 text-[8px] font-mono border border-red-400/30 text-red-400/70 hover:bg-red-400/10 transition-colors">
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
        DOWNLOADS GO TO DEFAULT PATH · CATALOG MERGES ALL PATHS
      </div>
    </div>
  );
}