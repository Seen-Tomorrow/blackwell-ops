// Provider parameter configuration — the PARAMETERS sub-tab editor.
// Split out of ConfigPage (tab shell) for maintainability.

import React, { useState, useCallback, useEffect, useMemo, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { UserEditedTemplateParam, ProviderConfig, ProviderTemplate, ProviderDefaultParam, LayoutDefaults, ExportFactoryTemplateResult } from "../lib/types";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import {
  buildParamsForFactoryExport,
  computeEssentialParamKeysForExport,
  isEssentialParam,
  resolveEssentialParamKeys,
} from "../lib/launchProfile";
import ValueBubbles from "./ValueBubbles";
import ParamCatalogSearch from "./ParamCatalogSearch";
import ConfigParamLegend from "./ConfigParamLegend";
import SubParamsEditor, { type SubParamsEditorTarget } from "./SubParamsEditor";
import ParamMetaEditor, { type ParamMetaForm } from "./ParamMetaEditor";
import {
  loadPowerUserState,
  saveConfigDevPreviewAsUser,
  catalogOverrideKey,
  effectiveParamDefault,
  groupOrderKey,
  loadGroupDisplayZone,
  loadGroupColumn,
  loadAboveColumnWidths,
  loadConfigColumnCount,
  loadConfigColumnWidths,
  saveGroupColumn,
  saveGroupDisplayZone,
  type GroupDisplayZone,
  normalizeUiGroup,
  paramUiGroup,
  readJsonStorage,
  resolveGroupOrder,
  removeStorage,
  writeJsonStorage,
  type PowerUserState,
} from "../lib/storage";
import {
  readActiveProfileFlat,
  removeConfigEditorDefault,
  writeConfigEditorDefault,
} from "../lib/launchProfiles";
import { isCockpitOwnedParam } from "../lib/systemParams";
import {
  dispatchAppEvent,
  EVENTS,
} from "../lib/events";
import type { RawCatalogEntry } from "../lib/catalog";
import { catalogEntryToParam, isCatalogEntryAlreadyActive } from "../lib/catalog";
import { isDevBuild } from "../lib/build";
import { formatCliArgString, parseCliArgString, repairBrokenQuotedSubParams } from "../lib/cliArgString";
import { sortParamValues } from "../lib/paramValueSort";
import {
  isEmptyGroupDeletable,
  isGroupRenamable,
  migrateCatalogGroupOrder,
  pruneStaleGroupOrder,
  renameGroupInLayout,
  resolveGroupOrderForAdmin,
  resolveGroupOrderForExport,
  stripGroupFromLayout,
} from "../lib/groupLayoutUtils";
import {
  isCustomTemplateType,
  masterParamsToUserEssentials,
  repairCustomEssentialsGroups,
} from "../lib/customProvider";
import {
  groupEditCaps,
  isCatalogVisibleParam,
  isPlacementChromeParam,
  isProtectedGroup,
  migrateCatalogParams,
  normalizeProtectedGroups,
  paramEditCaps,
  pinProtectedGroupsLast,
  PROTECTED_GROUP_TOOLTIP,
  resolveProtectedGroups,
  SYSTEM_CATALOG_PARAM_TOOLTIP,
  SYSTEM_UI_GROUP,
  type ConfigActor,
} from "../lib/systemParams";


interface ParamConfigPanelProps {
  providers?: ProviderConfig[];
  selectedProviderId: string;
  setSelectedProviderId: (id: string) => void;
  onProvidersChange: React.Dispatch<React.SetStateAction<ProviderConfig[]>>;
  editorUnlocked: boolean;
  configActor: ConfigActor;
  factoryExportEnabled: boolean;
  devPreviewAsUser: boolean;
  setDevPreviewAsUser: (v: boolean) => void;
  powerUserState: PowerUserState;
  setPowerUserState: React.Dispatch<React.SetStateAction<PowerUserState>>;
  onEditorToggle: () => void;
}

export default function ParamConfigPanel({
  providers,
  selectedProviderId,
  setSelectedProviderId,
  onProvidersChange,
  editorUnlocked,
  configActor,
  factoryExportEnabled,
  devPreviewAsUser,
  setDevPreviewAsUser,
  powerUserState,
  setPowerUserState,
  onEditorToggle,
}: ParamConfigPanelProps) {
  const isDevActor = configActor === "dev";

  useEffect(() => {
    const handler = () => setPowerUserState(loadPowerUserState());
    window.addEventListener(EVENTS.powerUserChanged, handler);
    return () => window.removeEventListener(EVENTS.powerUserChanged, handler);
  }, [setPowerUserState]);

  // ── Refresh providers from Rust after provider switch ──────────────
  useEffect(() => {
    invoke<ProviderConfig[]>("list_providers")
      .then(data => { if (data && data.length > 0) onProvidersChange(data); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProviderId]);

  // ── UI state ───────────────────────────────────────────────────────
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const showSaved = (msg: string) => { setSavedFlash(msg); setTimeout(() => setSavedFlash(null), 1200); };

  // Reset confirm dialog
  const [showResetConfirm, setShowResetConfirm] = useState(false);
  const [showExportConfirm, setShowExportConfirm] = useState(false);

  // ── Param catalog search state ───────────────────────────────
  const [showCatalogSearch, setShowCatalogSearch] = useState(false);

  // ── Inline sub-params editor state ───────────────────────────────
  type SubEditorTarget = SubParamsEditorTarget | null;
  const [editingValue, setEditingValue] = useState<SubEditorTarget>(null);
  const [subArgsText, setSubArgsText] = useState<Record<string, string>>({});

  // ── Full param metadata editor state ─────────────────────────────
  const [editingParamKey, setEditingParamKey] = useState<string | null>(null);
  const [paramMetaForm, setParamMetaForm] = useState<ParamMetaForm | null>(null);

  // ── User overrides (per-mode launch profiles; editor shows active bag) ─
  const [userOverrides, setUserOverrides] = useState<Record<string, string | number>>({});

  const reloadUserOverrides = useCallback(() => {
    try {
      const flat = readActiveProfileFlat(selectedProviderId);
      const asNums: Record<string, string | number> = {};
      for (const [k, v] of Object.entries(flat)) {
        if (typeof v === "string" || typeof v === "number") asNums[k] = v;
      }
      setUserOverrides(asNums);
    } catch {
      setUserOverrides({});
    }
  }, [selectedProviderId]);

  useEffect(() => {
    reloadUserOverrides();
  }, [reloadUserOverrides]);

  // Launch panel chip/cockpit writes also hit profiles — keep CONFIG chips in sync.
  useEffect(() => {
    const onChanged = () => reloadUserOverrides();
    window.addEventListener(EVENTS.paramConfigChanged, onChanged);
    return () => window.removeEventListener(EVENTS.paramConfigChanged, onChanged);
  }, [reloadUserOverrides]);

  // ── Current provider & param definitions ───────────────────────────
  const currentProvider = useMemo(() => providers.find(p => p.id === selectedProviderId), [providers, selectedProviderId]);

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

  const [customGroupDisplayZone, setCustomGroupDisplayZone] = useState<Record<string, GroupDisplayZone>>({});

  /** Session-only collapse for reordering — not persisted; separate from engine config groups. */
  const [collapsedConfigGroups, setCollapsedConfigGroups] = useState<Set<string>>(() => new Set());

  const [renamingGroup, setRenamingGroup] = useState<string | null>(null);
  const [renameGroupDraft, setRenameGroupDraft] = useState("");

  const toggleConfigGroupCollapsed = useCallback((groupName: string) => {
    setCollapsedConfigGroups((prev) => {
      const next = new Set(prev);
      if (next.has(groupName)) next.delete(groupName);
      else next.add(groupName);
      return next;
    });
  }, []);

  useEffect(() => {
    setCustomGroupDisplayZone(loadGroupDisplayZone(selectedProviderId, currentProvider?.groupDisplayZone));
  }, [selectedProviderId, currentProvider]);

  const toggleGroupDisplayZone = useCallback(
    async (groupName: string) => {
      const normalized = normalizeUiGroup(groupName);
      const next = { ...customGroupDisplayZone };
      if (next[normalized] === "above") delete next[normalized];
      else next[normalized] = "above";
      saveGroupDisplayZone(selectedProviderId, next);
      setCustomGroupDisplayZone(next);
      if (currentProvider) {
        const updated = { ...currentProvider, groupDisplayZone: next };
        try {
          await invoke("save_provider", { provider: updated });
          dispatchAppEvent(EVENTS.reloadProviders);
        } catch {
          /* ignore */
        }
      }
      dispatchAppEvent(EVENTS.paramConfigChanged);
    },
    [customGroupDisplayZone, currentProvider, selectedProviderId],
  );

  const saveGroupOrder = useCallback(async (newOrder: string[]) => {
    // Prefer live protectedGroups from provider; pin after reorder.
    const prot = resolveProtectedGroups(
      currentProvider?.protectedGroups,
      newOrder,
    );
    const normalized = pinProtectedGroupsLast(
      newOrder.map(normalizeUiGroup),
      prot,
    );
    // Persist to localStorage (A)
    writeJsonStorage(groupOrderKey(selectedProviderId), normalized);
    setCustomGroupOrder(normalized);
    // Persist to user_providers_config.json via save_provider (B) — keep protectedGroups intact
    if (currentProvider) {
      const updated = {
        ...currentProvider,
        groupOrder: normalized,
        protectedGroups: prot,
      };
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

  const catalogVisibleParams = useMemo(
    () => userSavedParamsWithDefaults.filter(isCatalogVisibleParam),
    [userSavedParamsWithDefaults],
  );

  /** Effective protected group ids (factory flag + seed fallback). */
  const protectedGroups = useMemo(() => {
    const present = new Set<string>();
    for (const d of catalogVisibleParams) present.add(paramUiGroup(d.ui_group));
    for (const g of currentProvider?.groupOrder ?? []) present.add(normalizeUiGroup(g));
    for (const g of customGroupOrder ?? []) present.add(normalizeUiGroup(g));
    return resolveProtectedGroups(currentProvider?.protectedGroups, present);
  }, [catalogVisibleParams, currentProvider?.protectedGroups, currentProvider?.groupOrder, customGroupOrder]);

  /** Auto-collapse SYSTEM PARAMS (protected) groups when opening a provider — free groups stay open. */
  const autoCollapsedProviderRef = useRef<string | null>(null);
  useEffect(() => {
    if (!selectedProviderId) return;
    if (protectedGroups.length === 0) return;
    if (autoCollapsedProviderRef.current === selectedProviderId) return;
    autoCollapsedProviderRef.current = selectedProviderId;
    setCollapsedConfigGroups(new Set(protectedGroups));
  }, [selectedProviderId, protectedGroups]);

  const visibleParamGroups = useMemo(() => {
    if (catalogVisibleParams.length === 0) return [] as string[];

    const rawOrder = editorUnlocked
      ? resolveGroupOrderForAdmin(catalogVisibleParams, customGroupOrder)
      : resolveGroupOrder(catalogVisibleParams, customGroupOrder);
    const groupOrder = pinProtectedGroupsLast(rawOrder, protectedGroups);

    const groups: Record<string, UserEditedTemplateParam[]> = {};
    for (const def of catalogVisibleParams) {
      const g = paramUiGroup(def.ui_group);
      if (!groups[g]) groups[g] = [];
      groups[g].push(def);
    }

    return groupOrder.filter((groupName) => {
      const groupParams = groups[groupName] ?? [];
      const isEmpty = groupParams.length === 0;
      if (isEmpty && !editorUnlocked) return false;
      if (isEmpty && !isEmptyGroupDeletable(groupName, groups, protectedGroups)) return false;
      return true;
    });
  }, [catalogVisibleParams, customGroupOrder, editorUnlocked, protectedGroups]);

  const allParamGroupsCollapsed = useMemo(
    () => visibleParamGroups.length > 0 && visibleParamGroups.every((g) => collapsedConfigGroups.has(g)),
    [visibleParamGroups, collapsedConfigGroups],
  );

  const toggleAllParamGroupsCollapsed = useCallback(() => {
    setCollapsedConfigGroups((prev) => {
      const allCollapsed = visibleParamGroups.length > 0 && visibleParamGroups.every((g) => prev.has(g));
      return allCollapsed ? new Set() : new Set(visibleParamGroups);
    });
  }, [visibleParamGroups]);

  // ── Hidden count for status bar ───────────────────────────────────
  const hiddenCount = useMemo(
    () => catalogVisibleParams.filter((d) => d.hidden).length,
    [catalogVisibleParams],
  );

  // ── Existing groups from user-saved + provider default params ───────────────
  const existingGroups = useMemo(() => {
    const seen = new Set<string>([
      paramUiGroup("Feature Flags"),
      SYSTEM_UI_GROUP,
      "USER-ADDED-FROM-CATALOG",
    ]);
    for (const def of userSavedParamsWithDefaults) {
      seen.add(paramUiGroup(def.ui_group));
    }
    for (const gp of providerDefaultParams) {
      seen.add(paramUiGroup(gp.ui_group));
    }
    return Array.from(seen);
  }, [userSavedParamsWithDefaults, providerDefaultParams]);

  const toggleGroupProtected = useCallback(
    async (groupName: string) => {
      if (!isDevActor || !currentProvider) return;
      const norm = normalizeUiGroup(groupName);
      const set = new Set(protectedGroups);
      if (set.has(norm)) set.delete(norm);
      else set.add(norm);
      const nextProt = normalizeProtectedGroups([...set]);
      // Single atomic save — do not call saveGroupOrder after (it used stale protectedGroups and overwrote the flag).
      const base =
        customGroupOrder ??
        resolveGroupOrderForAdmin(catalogVisibleParams, customGroupOrder);
      const nextOrder = pinProtectedGroupsLast(base, nextProt);
      writeJsonStorage(groupOrderKey(selectedProviderId), nextOrder);
      setCustomGroupOrder(nextOrder);
      const updated: ProviderConfig = {
        ...currentProvider,
        protectedGroups: nextProt,
        groupOrder: nextOrder,
      };
      onProvidersChange((prev) =>
        prev.map((p) => (p.id !== selectedProviderId ? p : updated)),
      );
      try {
        await invoke("save_provider", { provider: updated });
        dispatchAppEvent(EVENTS.reloadProviders);
      } catch (err) {
        console.error("[CONFIG] toggle protected failed:", err);
      }
      dispatchAppEvent(EVENTS.paramConfigChanged);
      showSaved(set.has(norm) ? "PROTECTED" : "UNPROTECTED");
    },
    [
      isDevActor,
      currentProvider,
      protectedGroups,
      customGroupOrder,
      catalogVisibleParams,
      selectedProviderId,
    ],
  );

  const renameGroup = useCallback(
    async (oldName: string, rawNewName: string) => {
      if (!editorUnlocked || !currentProvider) return;
      const gCaps = groupEditCaps(configActor, {
        protectedGroup: isProtectedGroup(oldName, protectedGroups),
      });
      const newName = normalizeUiGroup(rawNewName.trim());
      const oldNorm = normalizeUiGroup(oldName);
      if (!newName || !gCaps.rename || !isGroupRenamable(oldName, protectedGroups)) {
        showSaved("CANNOT RENAME");
        return;
      }
      const baseOrder =
        customGroupOrder ??
        resolveGroupOrderForAdmin(catalogVisibleParams, customGroupOrder);
      const groupColumn = loadGroupColumn(selectedProviderId, currentProvider.groupColumn);
      const renamed = renameGroupInLayout(
        oldName,
        newName,
        baseOrder,
        customGroupDisplayZone,
        groupColumn,
      );
      const existingGroupNames = new Set(
        catalogVisibleParams.map((d) => paramUiGroup(d.ui_group)),
      );
      if (
        (existingGroupNames.has(newName) && oldNorm !== newName) ||
        !renamed
      ) {
        showSaved("NAME IN USE");
        return;
      }

      const currentUserParams = buildUserSavedParams(currentProvider);
      const updatedUserParams = currentUserParams.map((d) =>
        paramUiGroup(d.ui_group) === oldNorm ? { ...d, ui_group: newName } : d,
      );
      await saveGroupOrder(renamed.groupOrder);
      saveGroupDisplayZone(selectedProviderId, renamed.groupDisplayZone);
      setCustomGroupDisplayZone(renamed.groupDisplayZone);
      saveGroupColumn(selectedProviderId, renamed.groupColumn);

      const updatedProvider: ProviderConfig = {
        ...currentProvider,
        userEditedTemplateParams: updatedUserParams,
        groupOrder: renamed.groupOrder,
        groupDisplayZone: renamed.groupDisplayZone,
        groupColumn: renamed.groupColumn,
      };
      onProvidersChange((prev) =>
        prev.map((p) => (p.id !== selectedProviderId ? p : updatedProvider)),
      );
      try {
        await invoke("save_provider", { provider: updatedProvider });
        dispatchAppEvent(EVENTS.reloadProviders);
      } catch {
        /* ignore */
      }
      dispatchAppEvent(EVENTS.paramConfigChanged);
      setRenamingGroup(null);
      setRenameGroupDraft("");
      showSaved("GROUP RENAMED");
    },
    [
      editorUnlocked,
      currentProvider,
      customGroupOrder,
      catalogVisibleParams,
      customGroupDisplayZone,
      selectedProviderId,
      buildUserSavedParams,
      saveGroupOrder,
      configActor,
      protectedGroups,
    ],
  );

  // Retired RUNTIME-CONFIG (and similar) — prune from saved order when no params use that group.
  useEffect(() => {
    if (!customGroupOrder?.length || catalogVisibleParams.length === 0) return;
    const pruned = pruneStaleGroupOrder(customGroupOrder, catalogVisibleParams);
    if (pruned.length === customGroupOrder.length) return;
    void saveGroupOrder(pruned);
  }, [customGroupOrder, catalogVisibleParams, saveGroupOrder]);

  const deleteEmptyGroup = useCallback(
    async (groupName: string) => {
      if (!editorUnlocked || !currentProvider) return;
      const groups: Record<string, UserEditedTemplateParam[]> = {};
      for (const def of catalogVisibleParams) {
        const g = paramUiGroup(def.ui_group);
        if (!groups[g]) groups[g] = [];
        groups[g].push(def);
      }
      if (!isEmptyGroupDeletable(groupName, groups, protectedGroups)) return;

      const baseOrder = customGroupOrder ?? currentProvider.groupOrder ?? [];
      const groupColumn = loadGroupColumn(selectedProviderId, currentProvider.groupColumn);
      const stripped = stripGroupFromLayout(
        groupName,
        baseOrder,
        customGroupDisplayZone,
        groupColumn,
      );
      await saveGroupOrder(stripped.groupOrder);
      saveGroupDisplayZone(selectedProviderId, stripped.groupDisplayZone);
      setCustomGroupDisplayZone(stripped.groupDisplayZone);
      saveGroupColumn(selectedProviderId, stripped.groupColumn);
      const updated = {
        ...currentProvider,
        groupOrder: stripped.groupOrder,
        groupDisplayZone: stripped.groupDisplayZone,
        groupColumn: stripped.groupColumn,
      };
      onProvidersChange((prev) => prev.map((p) => (p.id !== selectedProviderId ? p : updated)));
      try {
        await invoke("save_provider", { provider: updated });
        dispatchAppEvent(EVENTS.reloadProviders);
      } catch {
        /* ignore */
      }
      dispatchAppEvent(EVENTS.paramConfigChanged);
      showSaved("GROUP REMOVED");
    },
    [
      editorUnlocked,
      currentProvider,
      catalogVisibleParams,
      customGroupOrder,
      customGroupDisplayZone,
      selectedProviderId,
      saveGroupOrder,
      protectedGroups,
    ],
  );

  // Fingerprint guard: only dispatch when params content actually changed, not on reference rotation.
  // Breaks the telemetry poll -> re-render -> dispatch -> refetch providers amplification loop.
  const lastDispatchRef = useRef<string>("");
  useEffect(() => {
    if (catalogVisibleParams.length === 0) return;
    const fingerprint = `${catalogVisibleParams.length}-${hiddenCount}`;
    if (fingerprint === lastDispatchRef.current) return;
    lastDispatchRef.current = fingerprint;
    dispatchAppEvent(EVENTS.paramConfigChanged, { totalParams: catalogVisibleParams.length, hiddenCount });
  }, [catalogVisibleParams, hiddenCount]);

  // ── Persist provider to Rust ───────────────────────────────────────
  const persistProviderToConfig = useCallback(async (provider: ProviderConfig) => {
    try {
      await invoke("save_provider", { provider });
      dispatchAppEvent(EVENTS.reloadProviders);
    } catch (err) { console.error("[CONFIG] save_provider FAILED:", err); }
  }, []);

  // Drop device from catalog; pin chrome params to SYSTEM; migrate MULTI-GPU → SYSTEM;
  // seed protectedGroups from factory defaults when missing.
  useEffect(() => {
    if (!currentProvider) return;
    const currentUserParams = buildUserSavedParams(currentProvider);
    const { params: migratedParams, changed: paramsChanged } = migrateCatalogParams(currentUserParams);
    let paramsAfter = migratedParams;
    let customRepairChanged = false;
    if (isCustomTemplateType(currentProvider.template_type)) {
      const repaired = repairCustomEssentialsGroups(paramsAfter);
      paramsAfter = repaired.params;
      customRepairChanged = repaired.changed;
    }
    const baseOrder = customGroupOrder ?? currentProvider.groupOrder ?? [];
    const { order: migratedOrder, changed: orderChanged } = migrateCatalogGroupOrder(baseOrder);
    const present = new Set(paramsAfter.map((p) => paramUiGroup(p.ui_group)));
    for (const g of migratedOrder) present.add(normalizeUiGroup(g));
    const resolvedProt = resolveProtectedGroups(currentProvider.protectedGroups, present);
    const hadProt = (currentProvider.protectedGroups?.length ?? 0) > 0;
    const protChanged =
      !hadProt &&
      resolvedProt.length > 0 &&
      JSON.stringify(normalizeProtectedGroups(currentProvider.protectedGroups)) !==
        JSON.stringify(resolvedProt);
    if (!paramsChanged && !orderChanged && !protChanged && !customRepairChanged) return;

    let updatedProvider: ProviderConfig = {
      ...currentProvider,
      userEditedTemplateParams: paramsAfter,
    };
    if (orderChanged) {
      updatedProvider = {
        ...updatedProvider,
        groupOrder: pinProtectedGroupsLast(migratedOrder, resolvedProt),
      };
      writeJsonStorage(groupOrderKey(selectedProviderId), updatedProvider.groupOrder!);
      setCustomGroupOrder(updatedProvider.groupOrder!);
    }
    if (protChanged) {
      updatedProvider = { ...updatedProvider, protectedGroups: resolvedProt };
    }
    onProvidersChange((prev) =>
      prev.map((p) => (p.id !== selectedProviderId ? p : updatedProvider)),
    );
    void persistProviderToConfig(updatedProvider);
  }, [
    currentProvider,
    selectedProviderId,
    customGroupOrder,
    buildUserSavedParams,
    persistProviderToConfig,
  ]);

  // ── User override (selecting a value for this model + provider) ───
  const setOverride = useCallback((defKey: string, value: string | number) => {
    try {
      writeConfigEditorDefault(selectedProviderId, defKey, value, {
        isCockpitOwned: isCockpitOwnedParam(defKey),
      });
    } catch { /* ignore */ }
    setUserOverrides((prev) => ({ ...prev, [defKey]: value }));
    dispatchAppEvent(EVENTS.paramConfigChanged);
  }, [selectedProviderId]);

  const clearOverride = useCallback((defKey: string) => {
    try {
      removeConfigEditorDefault(selectedProviderId, defKey);
    } catch { /* ignore */ }
    setUserOverrides((prev) => {
      const n = { ...prev };
      delete n[defKey];
      return n;
    });
    dispatchAppEvent(EVENTS.paramConfigChanged);
  }, [selectedProviderId]);

  // ── Reset to factory defaults (RESET TO FACTORY DEFAULTS) — instant, deletes user config file ───
  const confirmReset = useCallback(async () => {
    if (!currentProvider || !editorUnlocked) return;
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
  }, [currentProvider, editorUnlocked, selectedProviderId]);

  const handleExportFactoryTemplate = useCallback(async () => {
    if (!currentProvider || !factoryExportEnabled) return;
    if (!currentProvider.factory_provided) {
      showSaved("EXPORT — factory providers only");
      return;
    }
    const columnCount = loadConfigColumnCount(
      selectedProviderId,
      currentProvider.configColumnCount,
    );
    const layoutDefaults: LayoutDefaults = {
      configColumnCount: columnCount,
      configColumnWidths: loadConfigColumnWidths(
        selectedProviderId,
        columnCount,
        currentProvider.configColumnWidths,
      ),
      groupDisplayZone: loadGroupDisplayZone(
        selectedProviderId,
        currentProvider.groupDisplayZone,
      ),
      groupColumn: loadGroupColumn(selectedProviderId, currentProvider.groupColumn),
      aboveColumnWidths: loadAboveColumnWidths(
        selectedProviderId,
        currentProvider.aboveColumnWidths,
      ),
    };
    const storedGroupOrder = readJsonStorage<string[]>(groupOrderKey(selectedProviderId));
    const exportGroupOrderBase =
      storedGroupOrder?.map(normalizeUiGroup) ??
      currentProvider.groupOrder?.map(normalizeUiGroup) ??
      customGroupOrder;
    const exportParams = buildParamsForFactoryExport(
      userSavedParamsWithDefaults,
      providerDefaultParams,
      currentProvider.excludedParamKeys,
    );
    const groupOrder = resolveGroupOrderForExport(
      exportParams,
      exportGroupOrderBase,
      protectedGroups,
    );
    const essentialFactoryKeys = resolveEssentialParamKeys(currentProvider.spawnProfile);
    const essentialParamKeys = computeEssentialParamKeysForExport(
      exportParams,
      essentialFactoryKeys,
    );
    try {
      const result = await invoke<ExportFactoryTemplateResult>("export_provider_factory_template", {
        input: {
          providerId: selectedProviderId,
          userEditedTemplateParams: exportParams,
          groupOrder,
          protectedGroups,
          layoutDefaults,
          essentialParamKeys,
        },
      });
      dispatchAppEvent(EVENTS.reloadProviders);
      showSaved(`FACTORY v${result.templateVersion} exported`);
    } catch (err) {
      console.error("[CONFIG] Factory export failed:", err);
      showSaved("EXPORT FAILED");
    }
  }, [
    currentProvider,
    factoryExportEnabled,
    selectedProviderId,
    userSavedParamsWithDefaults,
    providerDefaultParams,
    customGroupOrder,
    protectedGroups,
  ]);

  useEffect(() => {
    const unhideAllHiddenParams = async () => {
      if (!currentProvider || !editorUnlocked) return;
      const currentUserParams = buildUserSavedParams(currentProvider);
      if (!currentUserParams.some((d) => d.hidden)) return;
      const updatedUserParams = currentUserParams.map((d) =>
        d.hidden ? { ...d, hidden: false, userHidden: false } : d,
      );
      const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
      onProvidersChange((prev) =>
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
    editorUnlocked,
    buildUserSavedParams,
    persistProviderToConfig,
    selectedProviderId,
  ]);

  // ── Add param from catalog search ───────────────────────────────
  const handleCatalogAdd = useCallback(async (entry: RawCatalogEntry) => {
    if (!currentProvider) return;

    const currentUserParams = buildUserSavedParams(currentProvider);
    // Skip if already exists (key, flag, or reordered alias like kv_unified ↔ unified_kv)
    if (
      isCatalogEntryAlreadyActive(entry, currentUserParams)
      || isPlacementChromeParam({ key: entry.key })
    ) {
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

    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    dispatchAppEvent(EVENTS.paramConfigChanged);
    await persistProviderToConfig(updatedProvider);
    setShowCatalogSearch(false);
    showSaved("ADDED");
  }, [currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: toggle hidden row (catalog visibility) ───────────────
  const toggleRowHidden = useCallback(async (key: string) => {
    if (!currentProvider || !editorUnlocked) return;
    const currentUserParams = buildUserSavedParams(currentProvider);
    const def = currentUserParams.find((d) => d.key === key);
    if (!def) return;
    const caps = paramEditCaps(configActor, {
      protectedGroup: isProtectedGroup(def.ui_group, protectedGroups),
      placementChrome: isPlacementChromeParam(def),
      userAddedParam: false,
    });
    if (!caps.hideParam) return;

    const updatedUserParams = currentUserParams.map((d) => {
      if (d.key !== key) return d;
      const hidden = !d.hidden;
      return { ...d, hidden, userHidden: hidden };
    });
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    dispatchAppEvent(EVENTS.paramConfigChanged);
    showSaved("SAVED");
  }, [currentProvider, editorUnlocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId, configActor, protectedGroups]);

  const essentialFactoryKeys = useMemo(
    () => resolveEssentialParamKeys(currentProvider?.spawnProfile),
    [currentProvider?.spawnProfile],
  );

  const toggleParamEssential = useCallback(async (key: string) => {
    if (!currentProvider || !editorUnlocked) return;
    const def = buildUserSavedParams(currentProvider).find((d) => d.key === key);
    if (!def) return;
    const caps = paramEditCaps(configActor, {
      protectedGroup: isProtectedGroup(def.ui_group, protectedGroups),
      placementChrome: isPlacementChromeParam(def),
      userAddedParam: false,
    });
    if (!caps.structure) return;

    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map((d) => {
      if (d.key !== key) return d;
      const currently = isEssentialParam(d, essentialFactoryKeys);
      return { ...d, essential: !currently };
    });
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    onProvidersChange((prev) => prev.map((p) => (p.id !== selectedProviderId ? p : updatedProvider)));
    await persistProviderToConfig(updatedProvider);
    dispatchAppEvent(EVENTS.paramConfigChanged);
    showSaved("SAVED");
  }, [
    currentProvider,
    editorUnlocked,
    essentialFactoryKeys,
    buildUserSavedParams,
    persistProviderToConfig,
    selectedProviderId,
    configActor,
    protectedGroups,
  ]);

  // ── Admin: toggle hidden value (hide from catalog only) ─────────
  const toggleHiddenValue = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || !editorUnlocked) return;
    
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

    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    dispatchAppEvent(EVENTS.paramConfigChanged);
    showSaved("SAVED");
  }, [currentProvider, editorUnlocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  /** Hide/show a value in engine Essentials only (Full config still shows it). */
  const toggleEssentialsHiddenValue = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || !editorUnlocked) return;

    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map((d) => {
      if (d.key !== key) return d;
      const ev = d.essentialsHiddenValues || [];
      const idx = ev.findIndex((v) => String(v) === String(value));
      let next: (string | number)[];
      if (idx >= 0) {
        next = [...ev];
        next.splice(idx, 1);
      } else {
        next = [...ev, value];
      }
      return { ...d, essentialsHiddenValues: next.length > 0 ? next : undefined };
    });
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    onProvidersChange((prev) => prev.map((p) => (p.id !== selectedProviderId ? p : updatedProvider)));
    await persistProviderToConfig(updatedProvider);
    dispatchAppEvent(EVENTS.paramConfigChanged);
    showSaved("SAVED");
  }, [currentProvider, editorUnlocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: change default value for a param ─────────────────────
  const changeDefaultValue = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || !editorUnlocked) return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const updatedUserParams = currentUserParams.map(d => d.key === key ? { ...d, defaultValue: value } : d);
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    dispatchAppEvent(EVENTS.paramConfigChanged);
    showSaved("DEFAULT CHANGED");
  }, [currentProvider, editorUnlocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: drag reorder ─────────────────────────────────────────
  const swapItems = useCallback(async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || !currentProvider || !editorUnlocked) return;
    
    const currentUserParams = buildUserSavedParams(currentProvider);
    const d = [...currentUserParams];
    const [m] = d.splice(fromIdx, 1);
    d.splice(toIdx, 0, m);
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: d.map((x, i) => ({ ...x, order: i })) };

    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    dispatchAppEvent(EVENTS.paramConfigChanged);
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, editorUnlocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  /** P3: seed Master-aligned essentials as regular user rows (not protected). */
  const handleAddEssentialsPack = useCallback(async () => {
    if (!currentProvider || !editorUnlocked) return;
    try {
      const master = await invoke<ProviderTemplate>("get_template", {
        providerId: DEFAULT_PROVIDER_ID,
      });
      const currentUserParams = buildUserSavedParams(currentProvider);
      const existing = new Set(currentUserParams.map((p) => p.key));
      const maxOrder = Math.max(...currentUserParams.map((p) => p.order), -1);
      const pack = masterParamsToUserEssentials(
        (master.params || []) as Parameters<typeof masterParamsToUserEssentials>[0],
        existing,
        maxOrder + 1,
      );
      if (pack.length === 0) {
        showSaved("PACK ALREADY PRESENT");
        return;
      }
      // Clear excluded keys for pack so merge doesn't keep them out
      const excluded = (currentProvider.excludedParamKeys || []).filter(
        (k) => !pack.some((p) => p.key === k),
      );
      const updated: ProviderConfig = {
        ...currentProvider,
        userEditedTemplateParams: [...currentUserParams, ...pack],
        excludedParamKeys: excluded.length > 0 ? excluded : undefined,
      };
      onProvidersChange((prev) =>
        prev.map((p) => (p.id !== selectedProviderId ? p : updated)),
      );
      await persistProviderToConfig(updated);
      dispatchAppEvent(EVENTS.paramConfigChanged);
      showSaved(`ADDED ${pack.length} STARTER`);
    } catch (err) {
      console.error("[CONFIG] essentials pack failed:", err);
      showSaved("PACK FAILED");
    }
  }, [
    currentProvider,
    editorUnlocked,
    buildUserSavedParams,
    persistProviderToConfig,
    selectedProviderId,
  ]);

  // ── Admin: add value to param (writes to BOTH values and userAddedValues) ───
  const addValueToParam = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || !editorUnlocked) return;

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
      return {
        ...d,
        values: sortParamValues(vals),
        userAddedValues: userAdded.length > 0 ? userAdded : undefined,
      };
    });
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    dispatchAppEvent(EVENTS.paramConfigChanged);
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, editorUnlocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: remove value from param ───────────────────────────────
  const removeValueFromParam = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || !editorUnlocked) return;

    const currentUserParams = buildUserSavedParams(currentProvider);
    const def = currentUserParams.find((d) => d.key === key);
    if (!def) return;
    const isUserVal = (def.userAddedValues || []).some((v) => String(v) === String(value));
    const caps = paramEditCaps(configActor, {
      protectedGroup: isProtectedGroup(def.ui_group, protectedGroups),
      placementChrome: isPlacementChromeParam(def),
      userAddedParam: false,
    });
    if (isUserVal ? !caps.deleteUserValue : !caps.deleteFactoryValue) return;

    const updatedUserParams = currentUserParams.map(d => {
      if (d.key !== key) return d;
      const vals = sortParamValues((d.values || []).filter(v => String(v) !== String(value)));
      const userAdded = (d.userAddedValues || []).filter(v => String(v) !== String(value));
      const hiddenVals = (d.hiddenValues || []).filter(v => String(v) !== String(value));
      let newDefault = d.defaultValue;
      if (String(d.defaultValue) === String(value)) {
        newDefault = vals.length > 0 ? vals[0] : undefined;
      }
      return {
        ...d,
        values: vals,
        userAddedValues: userAdded.length > 0 ? userAdded : undefined,
        hiddenValues: hiddenVals.length > 0 ? hiddenVals : undefined,
        defaultValue: newDefault,
      };
    });
    const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };

    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    dispatchAppEvent(EVENTS.paramConfigChanged);
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, editorUnlocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId, configActor, protectedGroups]);

  // ── Admin: open sub-params editor for a value ───────────────────
  const openSubParamsEditor = useCallback((paramKey: string, valueName: string) => {
    if (!currentProvider || !editorUnlocked) return;
    setEditingValue({ paramKey, valueName });
    const def = userSavedParamsWithDefaults.find(d => d.key === paramKey);
    const existingArgs = def?.sub_params?.[valueName]
      ? formatCliArgString(repairBrokenQuotedSubParams(def.sub_params[valueName]))
      : "";
    setSubArgsText(prev => ({ ...prev, [paramKey + "::" + valueName]: existingArgs }));
  }, [userSavedParamsWithDefaults, currentProvider, editorUnlocked]);

  // ── Admin: save sub-params edit for a value ─────────────────────
  const saveSubParamsEdit = useCallback(async () => {
    if (!editingValue || !currentProvider) return;
    const { paramKey, valueName } = editingValue;
    const rawText = subArgsText[paramKey + "::" + valueName] ?? "";
    
    const args = repairBrokenQuotedSubParams(parseCliArgString(rawText.trim()));
    
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
    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [editingValue, subArgsText, currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: delete a value's sub-params entry and remove from values ─
  const deleteSubParamsEntry = useCallback(async (paramKey: string, valueName: string) => {
    if (!currentProvider || !editorUnlocked) return;
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
    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, editorUnlocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: restore param to provider default (full reset) ─────────
  const handleRestoreParam = useCallback(async (key: string) => {
    if (!currentProvider || !editorUnlocked) return;
    try {
      const freshFromTemplateParam: UserEditedTemplateParam = await invoke("reset_param_to_template", {
        providerId: selectedProviderId, paramKey: key
      });
      const currentUserParams = buildUserSavedParams(currentProvider);
      const updatedUserParams = currentUserParams.map(d => d.key === key ? { ...d, ...freshFromTemplateParam } : d);
      const updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
      onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
      await persistProviderToConfig(updatedProvider);
      showSaved("RESTORED");
    } catch (err) {
      console.error("[CONFIG] reset_param_to_template failed:", err);
    }
  }, [currentProvider, editorUnlocked, buildUserSavedParams, persistProviderToConfig, selectedProviderId]);

  // ── Admin: remove user-added param entirely ──────────────────────
  const handleRemoveParam = useCallback(async (key: string) => {
    if (!currentProvider || !editorUnlocked) return;
    try {
      const currentUserParams = buildUserSavedParams(currentProvider);
      const def = currentUserParams.find((d) => d.key === key);
      if (!def) return;
      const isFactoryParam =
        providerDefaultParams.length > 0 && providerDefaultParams.some((gp) => gp.key === key);
      const isUserAdded =
        providerDefaultParams.length > 0 && !providerDefaultParams.some((gp) => gp.key === key);
      const caps = paramEditCaps(configActor, {
        protectedGroup: isProtectedGroup(def.ui_group, protectedGroups),
        placementChrome: isPlacementChromeParam(def),
        userAddedParam: isUserAdded,
      });
      if (isFactoryParam ? !caps.deleteFactoryParam : !caps.deleteUserParam) return;
      const updatedUserParams = currentUserParams.filter((d) => d.key !== key);
      const excluded = [...(currentProvider.excludedParamKeys || [])];
      if (isFactoryParam) {
        if (!excluded.includes(key)) excluded.push(key);
      } else {
        const idx = excluded.indexOf(key);
        if (idx >= 0) excluded.splice(idx, 1);
      }
      const updatedProvider: ProviderConfig = {
        ...currentProvider,
        userEditedTemplateParams: updatedUserParams,
        excludedParamKeys: excluded.length > 0 ? excluded : undefined,
      };
      onProvidersChange((prev) => prev.map((p) => (p.id !== selectedProviderId ? p : updatedProvider)));
      await persistProviderToConfig(updatedProvider);
      dispatchAppEvent(EVENTS.paramConfigChanged);
      showSaved("REMOVED");
    } catch (err) {
      console.error("[CONFIG] remove param failed:", err);
    }
  }, [
    configActor,
    protectedGroups,
    currentProvider,
    editorUnlocked,
    buildUserSavedParams,
    persistProviderToConfig,
    selectedProviderId,
    providerDefaultParams,
  ]);

  // ── Admin: open param metadata editor ───────────────────────────
  const openParamMetaEditor = useCallback((def: UserEditedTemplateParam) => {
    setEditingParamKey(def.key);
    const group = paramUiGroup(def.ui_group);
    setParamMetaForm({
      label: def.label || def.key,
      ptype: def.ptype || "arg_select",
      flag: def.flag ?? "",
      pattern: def.pattern ?? "",
      uiGroup: group,
      customGroup: "",
      values: (() => { const merged = [...(def.values || [])]; const ua = def.userAddedValues || []; for (const v of ua) { if (!merged.some(x => String(x) === String(v))) merged.push(v); } return merged; })(),
      defaultValue: effectiveParamDefault(def.defaultValue) ?? "",
      subParams: Object.fromEntries(
        Object.entries(def.sub_params || {}).map(([k, v]) => [
          k,
          formatCliArgString(repairBrokenQuotedSubParams(v as string[])),
        ])
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
        const args = repairBrokenQuotedSubParams(parseCliArgString(v.trim()));
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
      const placementLocked = isPlacementChromeParam(d) && !isDevActor;
      const rawGroup =
        paramMetaForm.uiGroup === "__custom__" ? paramMetaForm.customGroup : paramMetaForm.uiGroup;
      const newUiGroup = placementLocked
        ? paramUiGroup(d.ui_group)
        : rawGroup
          ? paramUiGroup(rawGroup)
          : paramUiGroup("Feature Flags");
      const nextPtype = placementLocked
        ? d.ptype
        : ((paramMetaForm.ptype === d.ptype ? d.ptype : paramMetaForm.ptype) as UserEditedTemplateParam["ptype"]);
      const nextDefault = paramMetaForm.defaultValue !== "" && paramMetaForm.defaultValue != null
        ? paramMetaForm.defaultValue
        : undefined;
      const nextLabel = paramMetaForm.label.trim() || d.key;
      return {
        ...d,
        label: nextLabel,
        ptype: nextPtype,
        flag: placementLocked ? d.flag : paramMetaForm.flag || null,
        pattern: placementLocked
          ? d.pattern
          : paramMetaForm.ptype === "path_scanner"
            ? paramMetaForm.pattern
            : undefined,
        ui_group: newUiGroup,
        values: sortParamValues(vals),
        defaultValue: nextDefault,
        sub_params: Object.keys(subParams).length > 0 ? subParams : undefined,
        userAddedValues: mergedUserAdded.length > 0 ? mergedUserAdded : undefined,
      };
    });

    // Append target group to custom order (preserve existing order — never promote to first)
    const rawGroup =
      paramMetaForm.uiGroup === "__custom__" ? paramMetaForm.customGroup : paramMetaForm.uiGroup;
    const newUiGroup = rawGroup ? paramUiGroup(rawGroup) : paramUiGroup("Feature Flags");
    let updatedProvider = { ...currentProvider, userEditedTemplateParams: updatedUserParams };
    const baseOrder = resolveGroupOrder(updatedUserParams, customGroupOrder);
    if (!baseOrder.includes(newUiGroup)) {
      const newOrder = [...baseOrder, newUiGroup];
      writeJsonStorage(groupOrderKey(selectedProviderId), newOrder);
      setCustomGroupOrder(newOrder);
      updatedProvider = { ...updatedProvider, groupOrder: newOrder };
    }

    onProvidersChange(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    setEditingParamKey(null);
    setParamMetaForm(null);
    showSaved("SAVED");
  }, [paramMetaForm, editingParamKey, currentProvider, buildUserSavedParams, persistProviderToConfig, selectedProviderId, customGroupOrder, isDevActor]);

  // ── Drag state for reorder ───────────────────────────────────────
  const dragKeyRef = useRef<string | null>(null);
  const hasMovedRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const handleDragStart = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    const def = catalogVisibleParams[idx];
    if (!def) return;
    const caps = paramEditCaps(configActor, {
      protectedGroup: isProtectedGroup(def.ui_group, protectedGroups),
      placementChrome: isPlacementChromeParam(def),
      userAddedParam: false,
    });
    if (!caps.structure) return;
    startPosRef.current = { x: e.clientX, y: e.clientY };
    hasMovedRef.current = false;
    dragKeyRef.current = def.key ?? null;
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
      const fromIdx = catalogVisibleParams.findIndex((d) => d.key === sourceKey);
      const targetDef = catalogVisibleParams[targetIdx];
      const targetCaps = targetDef
        ? paramEditCaps(configActor, {
            protectedGroup: isProtectedGroup(targetDef.ui_group, protectedGroups),
            placementChrome: isPlacementChromeParam(targetDef),
            userAddedParam: false,
          })
        : null;
      if (
        fromIdx < 0 ||
        targetIdx === fromIdx ||
        !targetDef ||
        !targetCaps?.structure
      ) {
        setDragging(false);
        dragKeyRef.current = null;
        hasMovedRef.current = false;
        return;
      }
      const globalFromIdx = userSavedParamsWithDefaults.findIndex((d) => d.key === sourceKey);
      const globalToIdx = userSavedParamsWithDefaults.findIndex((d) => d.key === targetDef.key);
      if (globalFromIdx < 0 || globalToIdx < 0) {
        setDragging(false);
        dragKeyRef.current = null;
        hasMovedRef.current = false;
        return;
      }
      swapItems(globalFromIdx, globalToIdx);
      setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false;
    };
    window.addEventListener("mouseup", h, { once: true });
    return () => window.removeEventListener("mouseup", h);
  }, [dragging, catalogVisibleParams, userSavedParamsWithDefaults, swapItems, configActor, protectedGroups]);

  // ── Group drag state for reorder ───────────────────────────────
  const groupDragRef = useRef<string | null>(null);
  const groupHasMovedRef = useRef(false);
  const groupStartPosRef = useRef({ x: 0, y: 0 });
  const [draggingGroup, setDraggingGroup] = useState<string | null>(null);

  const handleGroupDragStart = (e: React.MouseEvent, groupName: string) => {
    e.stopPropagation();
    const gCaps = groupEditCaps(configActor, {
      protectedGroup: isProtectedGroup(groupName, protectedGroups),
    });
    if (!gCaps.reorder) return;
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

      const currentOrder = resolveGroupOrder(catalogVisibleParams, customGroupOrder);

      const sourceName = groupDragRef.current;
      const fromIdx = currentOrder.indexOf(sourceName);
      if (fromIdx < 0 || targetIdx === fromIdx) { setDraggingGroup(null); groupDragRef.current = null; groupHasMovedRef.current = false; return; }

      // Reorder groups and persist (saveGroupOrder pins protected last)
      const newOrder = [...currentOrder];
      const [moved] = newOrder.splice(fromIdx, 1);
      newOrder.splice(targetIdx, 0, moved);
      // User cannot drag protected groups; DEV can reorder within section only for UX:
      // pin always re-applies. Block dropping a free group into protected zone for users.
      const srcProt = isProtectedGroup(sourceName, protectedGroups);
      const tgtName = currentOrder[targetIdx];
      const tgtProt = tgtName ? isProtectedGroup(tgtName, protectedGroups) : false;
      if (!isDevActor && srcProt !== tgtProt) {
        setDraggingGroup(null);
        groupDragRef.current = null;
        groupHasMovedRef.current = false;
        return;
      }
      saveGroupOrder(newOrder);
      setDraggingGroup(null); groupDragRef.current = null; groupHasMovedRef.current = false;
    };
    window.addEventListener("mouseup", h, { once: true });
    return () => window.removeEventListener("mouseup", h);
  }, [draggingGroup, catalogVisibleParams, customGroupOrder, saveGroupOrder, protectedGroups, isDevActor]);

  const enabledProviders = useMemo(() => providers.filter(p => p.enabled), [providers]);

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col overflow-hidden" data-config-page>
      <div className="flex-1 flex flex-col overflow-hidden min-h-0">
          {/* Toolbar */}
          <div className="px-4 py-2.5 config-section-bar flex items-center justify-between flex-wrap gap-2 relative">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xs font-mono theme-accent-text tracking-widest">PARAMETER CONFIGURATION</h2>
                <button onClick={onEditorToggle}
                  className={`value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm transition-colors ${
                    editorUnlocked ? "value-chip-active" : ""
                  }`}
                  title="Click to toggle editor lock state">
                  {powerUserState === "permanently" ? "\u{1F511} EDITOR — PERMANENTLY UNLOCKED"
                    : powerUserState === "unlocked" ? "\u{1F513} EDITOR — UNLOCKED"
                    : "\u{1F512} EDITOR — LOCKED"}
                </button>
                {isDevBuild() && editorUnlocked && (
                  <button
                    type="button"
                    onClick={() => {
                      const next = !devPreviewAsUser;
                      setDevPreviewAsUser(next);
                      saveConfigDevPreviewAsUser(next);
                    }}
                    className={`value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm transition-colors ${
                      devPreviewAsUser ? "border-yellow-400/50 text-yellow-300" : "value-chip-active"
                    }`}
                    title={
                      devPreviewAsUser
                        ? "Previewing user restrictions — click for unrestricted DEV edit"
                        : "Unrestricted DEV edit — click to preview what users can do"
                    }
                  >
                    {devPreviewAsUser ? "👁 USER VIEW" : "🛠 DEV EDIT"}
                  </button>
                )}
                <button
                  type="button"
                  onClick={toggleAllParamGroupsCollapsed}
                  disabled={visibleParamGroups.length === 0}
                  className={`value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
                    allParamGroupsCollapsed ? "value-chip-active" : ""
                  }`}
                  title={allParamGroupsCollapsed ? "Expand all parameter groups" : "Collapse all parameter groups"}
                >
                  {allParamGroupsCollapsed ? "▶ EXPAND ALL" : "▼ COLLAPSE ALL"}
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

            <div className="ml-auto flex flex-wrap gap-2 items-start justify-end">
              {/* Action buttons — visible when unlocked */}
              <div className={`flex gap-2 transition-opacity ${editorUnlocked || factoryExportEnabled ? "opacity-100" : "opacity-0 pointer-events-none"}`}>
                {editorUnlocked && (
                  <button
                    type="button"
                    onClick={() => setShowResetConfirm(true)}
                    className="value-chip text-[9px] font-mono px-2 py-1 rounded-sm"
                    title="Restore this provider from factory template — one-click recovery"
                  >
                    RESET TO DEFAULTS
                  </button>
                )}
                {factoryExportEnabled && (
                  <button
                    type="button"
                    onClick={() => setShowExportConfirm(true)}
                    className="value-chip-active text-[9px] font-mono px-2 py-1 rounded-sm"
                    title="Admin: write param defaults to factory JSON (dev build only)"
                  >
                    EXPORT FACTORY
                  </button>
                )}
              </div>
              <ConfigParamLegend editorUnlocked={editorUnlocked} />
            </div>
          </div>

          {/* Reset confirm + saved flash */}
          <div className="relative">
            {showExportConfirm && (
              <div className="absolute inset-0 bg-black/60 z-50" onClick={() => setShowExportConfirm(false)}>
                <div className="config-form-panel rounded-sm p-6 max-w-sm absolute top-[85px] right-4 shadow-2xl" onClick={(e) => e.stopPropagation()}>
                  <h3 className="text-xs font-mono theme-accent-text mb-3">EXPORT FACTORY TEMPLATE</h3>
                  <p className="text-[10px] font-mono config-muted mb-4">
                    Writes param defaults, groups, layout, and Essentials list to factory JSON and bumps templateVersion. Dev build also updates src-tauri/runtime. Cannot be undone easily — commit the JSON if you mean it.
                  </p>
                  <div className="flex gap-2 justify-end">
                    <button
                      type="button"
                      onClick={() => setShowExportConfirm(false)}
                      className="value-chip text-[9px] font-mono px-3 py-1 rounded-sm"
                    >
                      CANCEL
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setShowExportConfirm(false);
                        void handleExportFactoryTemplate();
                      }}
                      className="value-chip-active text-[9px] font-mono px-3 py-1 rounded-sm"
                    >
                      YES, EXPORT
                    </button>
                  </div>
                </div>
              </div>
            )}

            {showResetConfirm && (
              <div className="absolute inset-0 bg-black/60 z-50" onClick={() => setShowResetConfirm(false)}>
                <div className="config-form-panel rounded-sm p-6 max-w-sm absolute top-[85px] right-4 shadow-2xl" onClick={e => e.stopPropagation()}>
                  <h3 className="text-xs font-mono theme-accent-text mb-3">CONFIRM RESET TO FACTORY</h3>
                  <p className="text-[10px] font-mono config-muted mb-4">
                    This is hard factory reset, remove added params and values, restore hidden items. Cannot be undone - but APP will work. APP restart is needed!
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
            <div className="mx-4 mt-3 px-3 py-2 foundry-profile-row rounded-sm">
              <span className="text-[9px] font-mono config-muted leading-tight">
                ⚠ Factory template updated — new options were merged automatically. Save any change to dismiss.
              </span>
            </div>
          )}

          {/* Param rows */}
          <div className="config-params-list flex-1 overflow-y-auto eink-scrollbar p-4 min-h-0">
            {catalogVisibleParams.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full gap-3 px-4 text-center">
                <p className="text-stealth-muted text-xs font-mono">
                  {editorUnlocked
                    ? "No parameters yet — add from catalog or seed a starter pack."
                    : "No parameters on this provider. Unlock EDITOR to add from catalog."}
                </p>
                {editorUnlocked && (
                  <div className="flex flex-col sm:flex-row gap-2 w-full max-w-md">
                    <button
                      type="button"
                      onClick={() => setShowCatalogSearch(true)}
                      className="flex-1 py-3 text-sm font-mono bg-nv-green/15 border border-nv-green/40 text-nv-green hover:bg-nv-green/25 transition-colors rounded tracking-wider"
                    >
                      + ADD FROM CATALOG
                    </button>
                    {isCustomTemplateType(currentProvider?.template_type) && (
                      <button
                        type="button"
                        onClick={() => { void handleAddEssentialsPack(); }}
                        className="flex-1 py-3 text-sm font-mono border border-stealth-border/50 text-stealth-muted hover:text-nv-green hover:border-nv-green/40 transition-colors rounded tracking-wider"
                        title="Insert Master-aligned ctx/parallel/kv/port/split/… as normal user-editable rows"
                      >
                        + STARTER PACK
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              (() => {
                const rawOrder = editorUnlocked
                  ? resolveGroupOrderForAdmin(catalogVisibleParams, customGroupOrder)
                  : resolveGroupOrder(catalogVisibleParams, customGroupOrder);
                const groupOrder = pinProtectedGroupsLast(rawOrder, protectedGroups);

                const groups: Record<string, UserEditedTemplateParam[]> = {};
                for (const def of catalogVisibleParams) {
                  const g = paramUiGroup(def.ui_group);
                  if (!groups[g]) groups[g] = [];
                  groups[g].push(def);
                }

                let systemSectionStarted = false;

                return (
                  <div className="config-param-group-block space-y-3">
                      {editorUnlocked && (
                        <div className="mb-3 flex flex-col gap-2">
                          <button
                            onClick={() => setShowCatalogSearch(true)}
                            className="w-full py-3 text-xl font-mono bg-nv-green/15 border border-nv-green/40 text-nv-green hover:bg-nv-green/25 transition-colors rounded tracking-wider"
                          >
                            + ADD NEW FROM CATALOG
                          </button>
                          {isCustomTemplateType(currentProvider?.template_type) && (
                            <button
                              type="button"
                              onClick={() => { void handleAddEssentialsPack(); }}
                              className="w-full py-2 text-[10px] font-mono border border-stealth-border/40 text-stealth-muted hover:text-nv-green hover:border-nv-green/40 transition-colors rounded tracking-wider"
                              title="Insert Master-aligned essentials as editable user rows"
                            >
                              + STARTER PACK (MASTER KEYS)
                            </button>
                          )}
                        </div>
                      )}
                    {groupOrder.map((groupName, groupIdx) => {
                      const groupParams = groups[groupName] ?? [];
                      const isEmpty = groupParams.length === 0;
                      if (isEmpty && !editorUnlocked) return null;
                      if (isEmpty && !isEmptyGroupDeletable(groupName, groups, protectedGroups)) return null;
                      const isGroupCollapsed = collapsedConfigGroups.has(groupName);
                      const groupProtected = isProtectedGroup(groupName, protectedGroups);
                      const gCaps = groupEditCaps(configActor, { protectedGroup: groupProtected });
                      const isRenaming = renamingGroup === groupName;
                      const showSystemHeader = groupProtected && !systemSectionStarted;
                      if (groupProtected) systemSectionStarted = true;
                      return (
                        <div key={groupName} data-group-idx={groupIdx}>
                          {showSystemHeader && (
                            <div className="mt-4 mb-2 pt-3 border-t border-stealth-border/50">
                              <div className="text-[9px] font-mono tracking-[0.2em] uppercase text-theme-accent/80">
                                SYSTEM PARAMS
                              </div>
                              <p className="text-[7px] font-mono config-muted mt-0.5">
                                Protected factory groups — expand values and hide options; structure locked for users
                              </p>
                            </div>
                          )}
                          {/* Group header — click to collapse/expand (session only) */}
                          <div
                            className={`config-param-group-header flex items-center gap-1 text-[8px] font-mono tracking-widest uppercase mb-1.5 pb-1 border-b ${
                              isEmpty ? "border-dashed border-stealth-border/25" : "border-stealth-border/30"
                            } ${groupProtected ? "config-param-group-header--system" : ""} ${
                              draggingGroup === groupName ? "text-yellow-400" : groupProtected ? "" : "text-stealth-muted/60"
                            }`}
                            title={groupProtected ? PROTECTED_GROUP_TOOLTIP : undefined}
                          >
                            {editorUnlocked && gCaps.reorder && (
                              <button onMouseDown={(e) => handleGroupDragStart(e, groupName)}
                                className="select-none px-1 cursor-grab active:cursor-grabbing hover:text-nv-green transition-colors"
                                title="Click and drag to reorder group">
                                &#x2630;
                              </button>
                            )}
                            {isRenaming ? (
                              <div className="flex items-center gap-1 flex-1 min-w-0">
                                <input
                                  type="text"
                                  value={renameGroupDraft}
                                  onChange={(e) => setRenameGroupDraft(e.target.value)}
                                  onKeyDown={(e) => {
                                    if (e.key === "Enter") void renameGroup(groupName, renameGroupDraft);
                                    if (e.key === "Escape") {
                                      setRenamingGroup(null);
                                      setRenameGroupDraft("");
                                    }
                                  }}
                                  className="flex-1 min-w-0 bg-transparent border-b border-yellow-400/40 text-[9px] font-mono text-white focus:outline-none px-1 py-0.5"
                                  autoFocus
                                />
                                <button
                                  type="button"
                                  onClick={() => void renameGroup(groupName, renameGroupDraft)}
                                  className="px-1.5 py-0 text-[7px] font-mono rounded-sm border border-nv-green/40 text-nv-green/90"
                                >
                                  OK
                                </button>
                                <button
                                  type="button"
                                  onClick={() => {
                                    setRenamingGroup(null);
                                    setRenameGroupDraft("");
                                  }}
                                  className="px-1 py-0 text-[8px] font-mono text-stealth-muted"
                                >
                                  ✕
                                </button>
                              </div>
                            ) : (
                            <button
                              type="button"
                              onClick={() => toggleConfigGroupCollapsed(groupName)}
                              className="flex items-center gap-1 flex-1 min-w-0 text-left hover:text-white transition-colors"
                              title={isGroupCollapsed ? "Expand group" : "Collapse group"}
                            >
                              <span className="text-[7px] flex-shrink-0">{isGroupCollapsed ? "▶" : "▼"}</span>
                              <span className="truncate">{groupName}</span>
                              <span className="opacity-40 flex-shrink-0">
                                {isEmpty ? "(empty)" : `(${groupParams.length})`}
                              </span>
                            </button>
                            )}
                            {editorUnlocked && gCaps.toggleProtected && !isRenaming && (
                              <button
                                type="button"
                                onClick={() => { void toggleGroupProtected(groupName); }}
                                className={`flex-shrink-0 px-1.5 py-0 text-[7px] font-mono rounded-sm border transition-colors ${
                                  groupProtected
                                    ? "border-theme-accent/50 text-theme-accent/90 bg-theme-accent/10"
                                    : "border-stealth-border/40 text-stealth-muted/55 hover:text-stealth-muted"
                                }`}
                                title={
                                  groupProtected
                                    ? "Protected — click to unflag (DEV)"
                                    : "Flag as protected / SYSTEM PARAMS (DEV)"
                                }
                              >
                                {groupProtected ? "SYS" : "SYS?"}
                              </button>
                            )}
                            {editorUnlocked && gCaps.rename && isGroupRenamable(groupName, protectedGroups) && !isRenaming && (
                              <button
                                type="button"
                                onClick={() => {
                                  setRenamingGroup(groupName);
                                  setRenameGroupDraft(groupName);
                                }}
                                className="flex-shrink-0 px-1.5 py-0 text-[7px] font-mono rounded-sm border border-stealth-border/40 text-stealth-muted/55 hover:text-stealth-muted transition-colors"
                                title="Rename group"
                              >
                                REN
                              </button>
                            )}
                            {editorUnlocked && isEmpty && gCaps.deleteEmpty && (
                              <button
                                type="button"
                                onClick={() => { void deleteEmptyGroup(groupName); }}
                                className="flex-shrink-0 px-1.5 py-0 text-[7px] font-mono rounded-sm border border-red-400/35 text-red-400/75 hover:text-red-400 hover:border-red-400/55 transition-colors"
                                title="Remove empty group"
                              >
                                DEL
                              </button>
                            )}
                            {editorUnlocked && !isEmpty && gCaps.pinDisplay && (
                            <button
                              type="button"
                              onClick={() => toggleGroupDisplayZone(groupName)}
                              className={`flex-shrink-0 px-1.5 py-0 text-[7px] font-mono rounded-sm border transition-colors ${
                                customGroupDisplayZone[normalizeUiGroup(groupName)] === "above"
                                  ? "border-nv-green/50 text-nv-green/90 bg-nv-green/10"
                                  : "border-stealth-border/40 text-stealth-muted/45 hover:text-stealth-muted"
                              }`}
                              title={
                                customGroupDisplayZone[normalizeUiGroup(groupName)] === "above"
                                  ? "Pinned above VRAM display — click to move below"
                                  : "Pin group above VRAM display"
                              }
                            >
                              {customGroupDisplayZone[normalizeUiGroup(groupName)] === "above" ? "▲ DISP" : "▽ DISP"}
                            </button>
                            )}
                          </div>
                          {!isGroupCollapsed && !isEmpty && (
                          <div className="space-y-1.5">
{groupParams.map((def, localIdx) => {
                               const catalogIdx = catalogVisibleParams.findIndex(
                                 (d) => d.key === def.key && d.order === def.order,
                               );
                               const rowKey = `${def.key || "param"}-${def.order}-${localIdx}`;
                               const defKey = def.key;
                               const isChromeParam = isPlacementChromeParam(def);
                               const isUserAdded = providerDefaultParams.length > 0 && !providerDefaultParams.some(gp => gp.key === def.key);
                               const caps = paramEditCaps(configActor, {
                                 protectedGroup: groupProtected,
                                 placementChrome: isChromeParam,
                                 userAddedParam: isUserAdded,
                               });

                               // Effective value: user override > current default
                               const factoryDefault = effectiveParamDefault(def.factoryDefault);
                               const effectiveDefault = effectiveParamDefault(def.defaultValue);
                               const currentOverride = userOverrides[defKey];
                               const currentValue = currentOverride !== undefined
                                 ? String(currentOverride)
                                 : (effectiveDefault !== undefined ? String(effectiveDefault) : "");

                               const essentialActive = isEssentialParam(def, essentialFactoryKeys);
                               const essentialForced = def.essential === true;
                               const essentialExcluded = def.essential === false;

                                 return (
                                    <React.Fragment key={rowKey}>
                                    <div
                                      data-row-idx={catalogIdx}
                                      title={
                                        isChromeParam
                                          ? SYSTEM_CATALOG_PARAM_TOOLTIP
                                          : groupProtected
                                            ? PROTECTED_GROUP_TOOLTIP
                                            : def.key
                                      }
                                      className={`config-param-row flex items-center gap-2 p-2 rounded transition-all duration-150 ${
                                        isChromeParam || groupProtected ? "config-param-row--system" : ""
                                      } ${
                                       (dragging && def.key === dragKeyRef.current)
                                         ? "border-yellow-400/60 bg-yellow-400/10 opacity-70"
                                         : def.hidden
                                           ? "opacity-30 grayscale"
                                           : `border ${isUserAdded ? 'border-yellow-400/30' : 'border-stealth-border'} hover:border-stealth-muted ${isUserAdded ? 'bg-yellow-400/3' : ''}`
                                     }`}>

                                   {/* Drag handle */}
                                   {editorUnlocked && caps.structure && (
                                     <button onMouseDown={(e) => handleDragStart(e, catalogIdx)}
                                       className="text-[8px] text-stealth-muted select-none px-1 cursor-grab active:cursor-grabbing hover:text-nv-green transition-colors"
                                       title="Click and drag to reorder">&#x2630;</button>
                                   )}
                                   {editorUnlocked && !caps.structure && (
                                     <span className="text-[8px] text-stealth-muted/25 select-none px-1" title={isChromeParam ? SYSTEM_CATALOG_PARAM_TOOLTIP : PROTECTED_GROUP_TOOLTIP}>&#x2630;</span>
                                   )}

                                   {/* Essentials toggle */}
                                   {editorUnlocked && caps.structure && (
                                     <button
                                       onClick={() => toggleParamEssential(def.key)}
                                       className={`config-param-ess text-[8px] font-mono px-0.5 select-none transition-colors ${
                                         essentialExcluded
                                           ? "text-stealth-muted/30 line-through"
                                           : essentialActive
                                             ? essentialForced
                                               ? "config-param-ess--forced text-nv-green"
                                               : "text-nv-green/70"
                                             : "text-stealth-muted/35 hover:text-stealth-muted"
                                       }`}
                                       title={
                                         essentialActive
                                           ? essentialForced
                                             ? "In Essentials (forced) — click to exclude"
                                             : essentialExcluded
                                               ? "Excluded from Essentials — click to include"
                                               : "In Essentials (factory default) — click to exclude"
                                           : "Not in Essentials — click to include"
                                       }
                                     >
                                       ESS
                                     </button>
                                   )}
                                   {editorUnlocked && !caps.structure && (
                                     <span className="config-param-ess text-[8px] font-mono px-0.5 text-stealth-muted/20 select-none" title={PROTECTED_GROUP_TOOLTIP}>ESS</span>
                                   )}

                                   {/* Hidden toggle — whole param row (not for protected groups under user/DEV-preview) */}
                                   {editorUnlocked && caps.hideParam && (
                                     <button onClick={() => toggleRowHidden(def.key)}
                                       className={`text-[10px] select-none transition-colors ${def.hidden ? "text-yellow-400/35" : "text-nv-green/25 hover:text-nv-green"}`}
                                       title={
                                         isChromeParam
                                           ? def.hidden
                                             ? "Show in catalog (engine panel placement unchanged)"
                                             : "Hide from catalog (engine panel placement unchanged)"
                                           : def.hidden
                                             ? "Show parameter in catalog"
                                             : "Hide from catalog"
                                       }>
                                       {def.hidden ? "\u2713" : "\u25EF"}
                                     </button>
                                   )}

                                   {/* Edit meta / Restore / Delete */}
{editorUnlocked && (caps.editMeta || caps.restore || caps.deleteFactoryParam || caps.deleteUserParam) && (
                                      <div className="flex items-center gap-1 mr-2">
                                        {caps.editMeta && (
                                        <button onClick={() => openParamMetaEditor(def)}
                                          className="leading-none text-[15px] font-mono text-nv-green/40 hover:text-yellow-400 transition-colors"
                                          title="Edit param metadata">E</button>
                                        )}
                                        {caps.restore && !isUserAdded && (
                                          <button onClick={() => handleRestoreParam(def.key)}
                                            className="leading-none text-[15px] font-mono text-blue-500/50 hover:text-blue-400 transition-colors"
                                            title="Restore this parameter row to DEFAULT">R</button>
                                        )}
                                        {((isUserAdded && caps.deleteUserParam) || (!isUserAdded && caps.deleteFactoryParam)) && (
                                        <button onClick={() => handleRemoveParam(def.key)}
                                          className="leading-none text-[15px] font-mono text-red-500/50 hover:text-red-400 transition-colors"
                                          title={isUserAdded ? "Remove this parameter entirely" : "Remove factory param from config (excluded until reset)"}>D</button>
                                        )}
                                      </div>
                                    )}
                                   {editorUnlocked && !caps.editMeta && !caps.restore && !caps.deleteFactoryParam && !caps.deleteUserParam && (
                                     <div className="flex items-center gap-1 mr-2 w-[3.25rem]" title={isChromeParam ? SYSTEM_CATALOG_PARAM_TOOLTIP : PROTECTED_GROUP_TOOLTIP} />
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
                                     editorUnlocked={editorUnlocked}
                                     currentValue={currentValue}
                                      onOverrideChange={(val) => setOverride(defKey, val)}
                                      onClearOverride={() => clearOverride(def.key)}
                                     addValue={editorUnlocked && caps.addValue ? (v: string | number) => addValueToParam(def.key, v) : undefined}
                                     removeValue={editorUnlocked ? (v: string | number) => removeValueFromParam(def.key, v) : undefined}
                                     canRemoveValue={(_v, isUa) =>
                                       isUa ? caps.deleteUserValue : caps.deleteFactoryValue
                                     }
                                     toggleHiddenValue={editorUnlocked && caps.hideValue ? (_k: string, v: string | number) => toggleHiddenValue(def.key, v) : undefined}
                                     hiddenValues={def.hiddenValues || []}
                                     toggleEssentialsHiddenValue={
                                       editorUnlocked && caps.structure
                                         ? (_k: string, v: string | number) => toggleEssentialsHiddenValue(def.key, v)
                                         : undefined
                                     }
                                     essentialsHiddenValues={def.essentialsHiddenValues || []}
                                      availableValues={def.values || []}
                                      userAddedValues={def.userAddedValues || []}
                                      defaultValue={effectiveDefault !== undefined ? String(effectiveDefault) : undefined}
                                      factoryDefault={factoryDefault !== undefined ? String(factoryDefault) : undefined}
                                      onChangeDefault={editorUnlocked && caps.setDefault
                                        ? (v: string | number) => changeDefaultValue(def.key, v)
                                        : undefined}
                                      onEditValue={editorUnlocked && caps.editMeta ? (val: string | number) => openSubParamsEditor(def.key, String(val)) : undefined}
                                      ptype={def.ptype}
                                      subParams={def.sub_params || undefined}
                                   />
                                 </div>

                                  {/* Inline editors below the row being edited */}
{editingParamKey === def.key && caps.editMeta && (
                                     <ParamMetaEditor
                                       editingKey={editingParamKey}
                                       form={paramMetaForm!}
                                       onFieldChange={(field, val) => setParamMetaForm(prev => prev ? ({ ...prev, [field]: val }) : null)}
                                       onSave={saveParamMetaEdit}
                                       onCancel={() => { setEditingParamKey(null); setParamMetaForm(null); }}
                                       existingGroups={existingGroups}
                                       lockGroup={isChromeParam && !isDevActor}
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
                          )}
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
            <span className="text-[9px] font-mono config-muted">{catalogVisibleParams.length} parameter{catalogVisibleParams.length !== 1 ? "s" : ""}{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}</span>
            {currentProvider && (<span className="text-[9px] font-mono theme-accent-text">{currentProvider.display_name}</span>)}
          </div>
        </div>

      {/* Param Catalog Search Modal */}
      {showCatalogSearch && (
        <ParamCatalogSearch
          providerId={selectedProviderId}
          existingKeys={catalogVisibleParams.map((d) => d.key)}
          existingParams={catalogVisibleParams.map((d) => ({
            key: d.key,
            flag: d.flag,
            ui_group: d.ui_group,
          }))}
          blockedKeys={catalogVisibleParams.filter((d) => isPlacementChromeParam(d)).map((d) => d.key)}
          editorUnlocked={editorUnlocked}
          onAdd={handleCatalogAdd}
          onClose={() => setShowCatalogSearch(false)}
        />
      )}

    </div>
  );
}

