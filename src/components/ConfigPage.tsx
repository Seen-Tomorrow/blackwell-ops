/**
 * ConfigPage — Provider & Parameter Configuration
 *
 * ARCHITECTURE (single source of truth):
 * - Each ParamDef carries both `defaultValue` (current) and `factoryDefault` (never changes).
 *   No cross-referencing templates at render time.
 * - Genesis template is only read:
 *   a) At startup — populates factory_default on fresh param_definitions
 *   b) By TEMPLATE UPDATE — shows diff vs current state
 *
 * Storage:
 * - Provider metadata (binary_path, git_url…) + full param_definitions → %APPDATA%/blackwell-ops/provider_meta.json
 * - Per-model runtime overrides → localStorage BlackOps-admin-catalog-override:{providerId}
 */

import { useState, useCallback, useEffect, useMemo, useRef } from "react";
import type { ParamDef, ProviderConfig, ProviderTemplate, TemplateParam } from "../lib/types";
import ValueBubbles from "./ValueBubbles";
import ProvidersConfig from "./ProvidersConfig";

const OVERRIDES_KEY_PREFIX = "BlackOps-admin-catalog-override:";

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

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  message: string;
  onConfirm: () => void;
  onCancel: () => void;
}

type ConfigSubTab = "providers" | "params";

interface ConfigPageProps {
  providers?: ProviderConfig[];
  onProvidersChange?: (providers: ProviderConfig[]) => void;
  modelBase?: string;
}

/** Parse a value as int, float, or string. */
function parseValue(v: string): string | number {
  const t = v.trim();
  if (/^-?\d+$/.test(t)) return parseInt(t, 10);
  if (/^-?\d+\.\d+$/.test(t)) return parseFloat(t);
  return t;
}

export default function ConfigPage({ providers: externalProviders, onProvidersChange, modelBase }: ConfigPageProps) {
  const [subTab, setSubTab] = useState<ConfigSubTab>("providers");
  const [selectedProviderId, setSelectedProviderId] = useState<string>("ggml-stable");
  const [allProviders, setAllProviders] = useState<ProviderConfig[]>(externalProviders || []);
  // Admin lock state: "locked" | "unlocked" | "permanently"
  const [adminLockState, setAdminLockStateRaw] = useState<string>("locked");

  const isAdminLocked = adminLockState === "locked";
  const isPermanentlyUnlocked = adminLockState === "permanently";

  // Load persisted lock state from localStorage on mount
  useEffect(() => {
    try {
      const stored = localStorage.getItem("BlackOps-admin-lock");
      if (stored === "unlocked" || stored === "permanently") {
        setAdminLockStateRaw(stored);
      }
    } catch {}
  }, []);

  // Cycle through lock states: locked → unlocked → permanently → locked
  const cycleAdminLock = () => {
    let next: string;
    if (adminLockState === "locked") next = "unlocked";
    else if (adminLockState === "unlocked") next = "permanently";
    else next = "locked";

    setAdminLockStateRaw(next);
    localStorage.setItem("BlackOps-admin-lock", next);
    window.dispatchEvent(new Event("admin-lock-changed"));
  };

  // ── Sync with parent's provider updates ───────────────────────────
  useEffect(() => {
    if (externalProviders && externalProviders.length > 0) {
      setAllProviders(externalProviders);
    }
  }, [externalProviders]);

  // ── Refresh providers from Rust after any save ─────────────────────
  useEffect(() => {
    import("@tauri-apps/api/core").then(async ({ invoke }) => {
      try {
        const data = await invoke<ProviderConfig[]>("list_providers");
        setAllProviders(data);
      } catch {}
    });
  }, [selectedProviderId]);

  // ── UI state ───────────────────────────────────────────────────────
  const [savedFlash, setSavedFlash] = useState<string | null>(null);
  const showSaved = (msg: string) => { setSavedFlash(msg); setTimeout(() => setSavedFlash(null), 1200); };

  // Reset confirm dialog
  const [showResetConfirm, setShowResetConfirm] = useState(false);

  // Template update modal state
  const [templateDiff, setTemplateDiff] = useState<TemplateDiffResult | null>(null);
  const [selectedNewParams, setSelectedNewParams] = useState<Set<string>>(new Set());
  const [showUpdateModal, setShowUpdateModal] = useState(false);

  // ── Inline sub-params editor state ───────────────────────────────
  type SubEditorTarget = { paramKey: string; valueName: string } | null;
  const [editingValue, setEditingValue] = useState<SubEditorTarget>(null);
  const [subArgsText, setSubArgsText] = useState<Record<string, string>>({});

  // ── Full param metadata editor state ─────────────────────────────
  type ParamMetaForm = {
    ptype: string; flag: string; mapId: string; pattern: string;
    values: (string | number)[]; defaultValue: string | number;
    subParams: Record<string, string>;
  };
  const [editingParamKey, setEditingParamKey] = useState<string | null>(null);
  const [paramMetaForm, setParamMetaForm] = useState<ParamMetaForm | null>(null);

  // ── User overrides (localStorage per provider) ─────────────────────
  const [userOverrides, setUserOverrides] = useState<Record<string, string | number>>({});

  useEffect(() => {
    try {
      const stored = localStorage.getItem(OVERRIDES_KEY_PREFIX + selectedProviderId);
      if (stored) setUserOverrides(JSON.parse(stored));
      else setUserOverrides({});
    } catch { setUserOverrides({}); }
  }, [selectedProviderId]);

  // ── Current provider & param definitions ───────────────────────────
  const currentProvider = useMemo(() => allProviders.find(p => p.id === selectedProviderId), [allProviders, selectedProviderId]);
  const buildCompleteDefs = useCallback((provider: ProviderConfig | undefined): ParamDef[] => {
    if (!provider || !provider.param_definitions) return [];
    return [...provider.param_definitions].sort((a, b) => a.order - b.order);
  }, []);
  const paramDefsBase = useMemo(() => buildCompleteDefs(currentProvider), [currentProvider, buildCompleteDefs]);

  // ── Load raw template (for sub_params / ptype at runtime — no reset needed) ───
  const [templateParams, setTemplateParams] = useState<TemplateParam[]>([]);
  useEffect(() => {
    if (!selectedProviderId) return;
    import("@tauri-apps/api/core").then(async ({ invoke }) => {
      try {
        const template: ProviderTemplate = await invoke("get_template", { providerId: selectedProviderId });
        setTemplateParams(template.params || []);
      } catch {}
    });
  }, [selectedProviderId]);

  // ── Merge base defs with runtime template data (sub_params, ptype) ───────────
  const paramDefs = useMemo(() => {
    if (!paramDefsBase.length || !templateParams.length) return paramDefsBase;
    const templateMap = new Map(templateParams.map(p => [p.key, p]));
    return paramDefsBase.map(def => {
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
  }, [paramDefsBase, templateParams]);

  // ── Hidden count for status bar ───────────────────────────────────
  const hiddenCount = useMemo(() => paramDefs.filter(d => d.hidden).length, [paramDefs]);
  useEffect(() => {
    if (paramDefs.length === 0) return;
    window.dispatchEvent(new CustomEvent("param-config-changed", { detail: { totalParams: paramDefs.length, hiddenCount } }));
  }, [paramDefs, hiddenCount]);

  // ── Persist provider to Rust ───────────────────────────────────────
  const persistProviderToConfig = useCallback(async (provider: ProviderConfig) => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_provider", { provider });
    } catch (err) { console.error("[CONFIG] save_provider FAILED:", err); }
  }, []);

  // ── User override (selecting a value for this model + provider) ───
  const setOverride = useCallback((defKey: string, value: string | number) => {
    try { localStorage.setItem(OVERRIDES_KEY_PREFIX + selectedProviderId, JSON.stringify({ [defKey]: value })); } catch {}
    window.dispatchEvent(new CustomEvent("param-config-changed"));
  }, [selectedProviderId]);

  // ── Reset to factory defaults (RESET TO DEFAULTS) ─────────────────
  const confirmReset = useCallback(async () => {
    if (!currentProvider || adminLockState === "locked") return;
    setShowResetConfirm(false);

    try {
      const { invoke } = await import("@tauri-apps/api/core");
      
      // Get fresh factory defaults from genesis template for this provider
      const template = await invoke<ProviderTemplate>("get_template", { providerId: selectedProviderId });
      const resetDefs: ParamDef[] = (template.params || []).map((p, i) => ({
        key: p.key,
        label: p.label,
        values: p.values as (string | number)[],
        order: i,
        hidden: false,
        config_key: p.config_key,
        flag: p.flag ?? undefined,
        ptype: p.ptype,
        map_id: p.map_id,
        ui_group: p.ui_group,
        note: p.note,
        pattern: p.pattern,
        sub_params: (p as any).sub_params,
        defaultValue: (p as any).default as string | number,
        factoryDefault: (p as any).default as string | number,
      }));
      
      const updatedProvider = { ...currentProvider, param_definitions: resetDefs };
      await invoke("save_provider", { provider: updatedProvider });
      
      // Refresh from backend
      const allProviders = await invoke<ProviderConfig[]>("list_providers");
      setAllProviders(allProviders);
    } catch (err) { console.error("[CONFIG] Reset failed:", err); }

    // Clear localStorage overrides for this provider
    setUserOverrides({});
    try { localStorage.removeItem(OVERRIDES_KEY_PREFIX + selectedProviderId); } catch {}
    
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    showSaved("RESET TO DEFAULTS");
  }, [currentProvider, isAdminLocked, selectedProviderId]);

  // ── Check template update (TEMPLATE UPDATE) ─────────────────
  const handleCheckUpdate = useCallback(async () => {
    if (adminLockState === "locked") return;
    
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const diff: { new_params: DiffParam[]; orphaned_params: DiffParam[] } = 
        await invoke("check_template_update", { providerId: selectedProviderId });
      
      setTemplateDiff(diff);
      // Pre-select all new params (user can un-check unwanted ones)
      setSelectedNewParams(new Set(diff.new_params.map(p => p.key)));
      setShowUpdateModal(true);
    } catch (err) {
      console.error("[CONFIG] check_template_update failed:", err);
    }
  }, [selectedProviderId]);

  // ── Validate provider_meta.json schema ───────────────────────────
  const handleValidate = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const errors: string[] = await invoke("validate_provider_meta");
      if (errors.length === 0) {
        alert(`provider_meta.json is valid — no schema issues found.`);
      } else {
        alert(`provider_meta.json has ${errors.length} issue(s):\n${errors.join("\n")}`);
      }
    } catch (err) {
      console.error("[CONFIG] validate_provider_meta failed:", err);
    }
  }, []);

  // ── Apply template update with user-selected params ───────────────
  const handleApplyTemplateUpdate = useCallback(async () => {
    if (!templateDiff || !currentProvider) return;
    
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      
      // Build the param_def to add (only selected new ones)
      const template = await invoke<ProviderTemplate>("get_template", { providerId: selectedProviderId });
      const paramsToAdd: ParamDef[] = [];
      for (const p of template.params) {
        if (selectedNewParams.has(p.key)) {
          paramsToAdd.push({
            key: p.key,
            label: p.label,
            values: p.values as (string | number)[],
            order: currentProvider.param_definitions.length + paramsToAdd.length,
            hidden: false,
            config_key: p.config_key,
            flag: p.flag ?? undefined,
            ptype: p.ptype,
            map_id: p.map_id,
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
        .filter(p => !selectedNewParams.has(p.key))
        .map(p => p.key);

      if (paramsToAdd.length > 0 || orphanedToRemove.length > 0) {
        await invoke("apply_template_update", {
          providerId: selectedProviderId,
          addParams: paramsToAdd,
          removeKeys: orphanedToRemove,
        });
        
        // Refresh from backend
        const allProviders = await invoke<ProviderConfig[]>("list_providers");
        setAllProviders(allProviders);
      }
    } catch (err) { console.error("[CONFIG] apply_template_update failed:", err); }

    setShowUpdateModal(false);
    setTemplateDiff(null);
    showSaved("TEMPLATE UPDATED");
  }, [templateDiff, currentProvider, selectedProviderId, selectedNewParams]);

  // ── Admin: add new param definition ───────────────────────────────
  const addParamDefinition = useCallback(async (key: string, values: (string | number)[]) => {
    if (!currentProvider || !values.length) return;
    
    const completeDefs = buildCompleteDefs(currentProvider);
    const maxOrder = Math.max(...completeDefs.map(d => d.order), -1);
    const newDef: ParamDef = { key, label: key, values, order: maxOrder + 1 };
    const updatedProvider = { ...currentProvider, param_definitions: [...completeDefs, newDef] };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: remove param definition ───────────────────────────────
  const removeParamDefinition = useCallback(async (key: string) => {
    if (!currentProvider || adminLockState === "locked") return;
    
    const completeDefs = buildCompleteDefs(currentProvider);
    const updatedDefs = completeDefs.filter(d => d.key !== key);
    const updatedProvider = { ...currentProvider, param_definitions: updatedDefs };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    setUserOverrides(prev => {
      const n = { ...prev };
      delete n[key];
      try { localStorage.setItem(OVERRIDES_KEY_PREFIX + selectedProviderId, JSON.stringify(n)); } catch {}
      return n;
    });
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: toggle hidden row (catalog visibility) ───────────────
  const toggleRowHidden = useCallback(async (key: string) => {
    if (!currentProvider || adminLockState === "locked") return;
    
    const completeDefs = buildCompleteDefs(currentProvider);
    const updatedDefs = completeDefs.map(d => d.key === key ? { ...d, hidden: !d.hidden } : d);
    const updatedProvider = { ...currentProvider, param_definitions: updatedDefs };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: toggle hidden value (hide from catalog only) ─────────
  const toggleHiddenValue = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || adminLockState === "locked") return;
    
    const completeDefs = buildCompleteDefs(currentProvider);
    const updatedDefs = completeDefs.map(d => {
      if (d.key !== key) return d;
      const hv = d.hiddenValues || [];
      const idx = hv.findIndex(v => String(v) === String(value));
      let newHv: (string | number)[];
      if (idx >= 0) { newHv = [...hv]; newHv.splice(idx, 1); }
      else { newHv = [...hv, value]; }
      return { ...d, hiddenValues: newHv.length > 0 ? newHv : undefined };
    });
    const updatedProvider = { ...currentProvider, param_definitions: updatedDefs };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: change default value for a param ─────────────────────
  const changeDefaultValue = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || adminLockState === "locked") return;
    
    const completeDefs = buildCompleteDefs(currentProvider);
    const updatedDefs = completeDefs.map(d => d.key === key ? { ...d, defaultValue: value } : d);
    const updatedProvider = { ...currentProvider, param_definitions: updatedDefs };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    showSaved("DEFAULT CHANGED");
  }, [currentProvider, isAdminLocked, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: drag reorder ─────────────────────────────────────────
  const swapItems = useCallback(async (fromIdx: number, toIdx: number) => {
    if (fromIdx === toIdx || fromIdx < 0 || !currentProvider || adminLockState === "locked") return;
    
    const completeDefs = buildCompleteDefs(currentProvider);
    const d = [...completeDefs];
    const [m] = d.splice(fromIdx, 1);
    d.splice(toIdx, 0, m);
    const updatedProvider = { ...currentProvider, param_definitions: d.map((x, i) => ({ ...x, order: i })) };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: add value to param (user-added values) ───────────────
  const addValueToParam = useCallback(async (key: string, value: string | number) => {
    if (!currentProvider || adminLockState === "locked") return;
    
    const completeDefs = buildCompleteDefs(currentProvider);
    const updatedDefs = completeDefs.map(d => d.key === key ? { ...d, userAddedValues: [...(d.userAddedValues || []), value] } : d);
    const updatedProvider = { ...currentProvider, param_definitions: updatedDefs };

    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    window.dispatchEvent(new CustomEvent("param-config-changed"));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: open sub-params editor for a value ───────────────────
  const openSubParamsEditor = useCallback((paramKey: string, valueName: string) => {
    if (!currentProvider || adminLockState === "locked") return;
    setEditingValue({ paramKey, valueName });
    const def = paramDefs.find(d => d.key === paramKey);
    const existingArgs = (def as any)?.sub_params?.[valueName]?.join(" ") ?? "";
    setSubArgsText(prev => ({ ...prev, [paramKey + "::" + valueName]: existingArgs }));
  }, [paramDefs, currentProvider, isAdminLocked]);

  // ── Admin: save sub-params edit for a value ─────────────────────
  const saveSubParamsEdit = useCallback(async () => {
    if (!editingValue || !currentProvider) return;
    const { paramKey, valueName } = editingValue;
    const rawText = subArgsText[paramKey + "::" + valueName] ?? "";
    
    // Parse space-separated args
    const args: string[] = rawText.trim().split(/\s+/).filter(Boolean);
    
    const completeDefs = buildCompleteDefs(currentProvider);
    let updatedDefs = completeDefs.map(d => {
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
    updatedDefs = updatedDefs.map(d => {
      if (d.key !== paramKey) return d;
      const vals = [...(d.values || [])];
      if (!vals.includes(valueName)) { vals.push(valueName); }
      return { ...d, values: vals };
    });
    
    // If args empty and sub_params is now gone for this value, remove from values too
    updatedDefs = updatedDefs.map(d => {
      if (d.key !== paramKey) return d;
      const sp = (d as any).sub_params || {};
      if (!sp[valueName]) {
        return { ...d, values: (d.values || []).filter(v => String(v) !== valueName) };
      }
      return d;
    });

    const updatedProvider = { ...currentProvider, param_definitions: updatedDefs };
    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [editingValue, subArgsText, currentProvider, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: delete a value's sub-params entry and remove from values ─
  const deleteSubParamsEntry = useCallback(async (paramKey: string, valueName: string) => {
    if (!currentProvider || adminLockState === "locked") return;
    const completeDefs = buildCompleteDefs(currentProvider);
    let updatedDefs = completeDefs.map(d => {
      if (d.key !== paramKey) return d;
      const existingSubParams = (d as any).sub_params || {};
      const {[valueName]: _, ...rest} = existingSubParams;
      return { ...d, sub_params: Object.keys(rest).length > 0 ? rest : undefined };
    });
    // Also remove from values array
    updatedDefs = updatedDefs.map(d => {
      if (d.key !== paramKey) return d;
      const sp = (d as any).sub_params || {};
      if (!sp[valueName]) {
        return { ...d, values: (d.values || []).filter(v => String(v) !== valueName) };
      }
      return d;
    });
    const updatedProvider = { ...currentProvider, param_definitions: updatedDefs };
    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    showSaved("SAVED");
  }, [currentProvider, isAdminLocked, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: restore param to genesis template (full reset) ─────────
  const handleRestoreParam = useCallback(async (key: string) => {
    if (!currentProvider || adminLockState === "locked") return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const freshDef: ParamDef = await invoke("reset_param_to_template", {
        providerId: selectedProviderId, paramKey: key
      });
      const completeDefs = buildCompleteDefs(currentProvider);
      const updatedDefs = completeDefs.map(d => d.key === key ? { ...d, ...freshDef } : d);
      const updatedProvider = { ...currentProvider, param_definitions: updatedDefs };
      setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
      await persistProviderToConfig(updatedProvider);
      showSaved("RESTORED");
    } catch (err) {
      console.error("[CONFIG] reset_param_to_template failed:", err);
    }
  }, [currentProvider, isAdminLocked, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Admin: open param metadata editor ───────────────────────────
  const openParamMetaEditor = useCallback((def: ParamDef) => {
    setEditingParamKey(def.key);
    setParamMetaForm({
      ptype: (def as any).ptype || "arg_select",
      flag: (def as any).flag ?? "",
      mapId: (def as any).map_id ?? "",
      pattern: (def as any).pattern ?? "",
      values: [...(def.values || [])],
      defaultValue: def.defaultValue ?? "",
      subParams: Object.fromEntries(
        Object.entries((def as any).sub_params || {}).map(([k, v]) => [k, (v as string[]).join(" ")])
      ),
    });
  }, []);

  // ── Admin: save param metadata edit ─────────────────────────────
  const saveParamMetaEdit = useCallback(async () => {
    if (!paramMetaForm || !editingParamKey || !currentProvider) return;
    const completeDefs = buildCompleteDefs(currentProvider);
    const updatedDefs = completeDefs.map(d => {
      if (d.key !== editingParamKey) return d;
      const subParams: Record<string, string[]> = {};
      for (const [k, v] of Object.entries(paramMetaForm.subParams)) {
        const args = v.trim().split(/\s+/).filter(Boolean);
        if (args.length > 0) subParams[k] = args;
      }
      // Add any new values that have sub-params but aren't in values yet
      let vals = [...(d.values || [])];
      for (const k of Object.keys(paramMetaForm.subParams)) {
        const n = Number.isFinite(Number(k)) ? Number(k) : k;
        if (!vals.includes(n as string | number)) vals.push(n as string | number);
      }
      return {
        ...d,
        ptype: paramMetaForm.ptype !== "arg_select" && paramMetaForm.ptype !== "logic_only" ? undefined : (paramMetaForm.ptype === d.ptype ? d.ptype : paramMetaForm.ptype),
        flag: ["mapper", "path_scanner"].includes(paramMetaForm.ptype) ? undefined : paramMetaForm.flag || null,
        map_id: paramMetaForm.ptype === "mapper" ? paramMetaForm.mapId : undefined,
        pattern: paramMetaForm.ptype === "path_scanner" ? paramMetaForm.pattern : undefined,
        values: vals,
        defaultValue: paramMetaForm.defaultValue !== "" ? paramMetaForm.defaultValue : undefined,
        sub_params: Object.keys(subParams).length > 0 ? subParams : undefined,
      };
    });
    const updatedProvider = { ...currentProvider, param_definitions: updatedDefs };
    setAllProviders(prev => prev.map(p => p.id !== selectedProviderId ? p : updatedProvider));
    await persistProviderToConfig(updatedProvider);
    setEditingParamKey(null);
    setParamMetaForm(null);
    showSaved("SAVED");
  }, [paramMetaForm, editingParamKey, currentProvider, buildCompleteDefs, persistProviderToConfig, selectedProviderId]);

  // ── Drag state for reorder ───────────────────────────────────────
  const dragKeyRef = useRef<string | null>(null);
  const hasMovedRef = useRef(false);
  const startPosRef = useRef({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  const handleDragStart = (e: React.MouseEvent, idx: number) => {
    e.stopPropagation();
    startPosRef.current = { x: e.clientX, y: e.clientY };
    hasMovedRef.current = false;
    dragKeyRef.current = paramDefs[idx]?.key ?? null;
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
      const fromIdx = paramDefs.findIndex(d => d.key === sourceKey);
      if (fromIdx < 0 || targetIdx === fromIdx) { setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false; return; }
      swapItems(fromIdx, targetIdx);
      setDragging(false); dragKeyRef.current = null; hasMovedRef.current = false;
    };
    window.addEventListener("mouseup", h, { once: true });
    return () => window.removeEventListener("mouseup", h);
  }, [dragging, paramDefs, swapItems]);

  const handleAdminToggle = cycleAdminLock;

  const enabledProviders = useMemo(() => allProviders.filter(p => p.enabled), [allProviders]);

  // ── Render ───────────────────────────────────────────────────────
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Tab bar */}
      <div className="px-4 py-2 border-b border-stealth-border flex items-center gap-1">
        <button onClick={() => setSubTab("providers")} className={`px-3 py-1 text-[10px] font-mono tracking-wider transition-colors ${subTab === "providers" ? "text-nv-green border-b border-nv-green/60" : "text-stealth-muted hover:text-white"}`}>PROVIDERS</button>
        <button onClick={() => setSubTab("params")} className={`px-3 py-1 text-[10px] font-mono tracking-wider transition-colors ${subTab === "params" ? "text-nv-green border-b border-nv-green/60" : "text-stealth-muted hover:text-white"}`}>PARAMETERS</button>
      </div>

      {subTab === "providers" ? (
        <ProvidersConfig providers={allProviders} onProvidersChange={setAllProviders} modelBase={modelBase} />
      ) : (
        <div className="h-full flex flex-col overflow-hidden">
          {/* Toolbar */}
          <div className="px-4 py-3 border-b border-stealth-border flex items-center justify-between flex-wrap gap-2 relative">
            <div>
              <h2 className="text-xs font-mono text-nv-green tracking-wider">PARAMETER CONFIGURATION</h2>
              <p className="text-[9px] font-mono text-stealth-muted mt-0.5">Green = factory default, Yellow border = admin changed.</p>

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

              <div className="flex items-center gap-2 mt-1">
                <span className="text-[9px] font-mono text-stealth-muted uppercase tracking-wider">Admin:</span>
                <button onClick={handleAdminToggle}
                  className={`text-[10px] transition-colors ${
                    adminLockState === "permanently"
                      ? "text-red-400 animate-pulse"
                      : adminLockState === "unlocked" ? "text-yellow-400" : "text-stealth-muted hover:text-white"
                  }`}>
                  {adminLockState === "permanently" ? "\u{1F5A4} UNLOCKED PARMANNENTLY"
                    : adminLockState === "unlocked" ? "\u{1F513} UNLOCKED"
                    : "\u{1F512} LOCKED"}
                </button>
              </div>
            </div>

            {/* Admin action buttons */}
            <div className="flex gap-2">
              {adminLockState !== "locked" && (
                <>
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
                </>
              )}
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
          <div className="flex-1 overflow-y-auto p-4">
            {paramDefs.length === 0 ? (
              <div className="flex items-center justify-center h-full text-stealth-muted text-xs font-mono">LOADING PARAMETERS...</div>
            ) : (
              <div className="space-y-1.5">
                {paramDefs.map((def, idx) => {
                  const defKey = def.config_key || def.key;

                  // Effective value: user override > current default
                  const factoryDefault = (def as any).factoryDefault;
                  const effectiveDefault = def.defaultValue !== undefined ? String(def.defaultValue) : undefined;
                  const currentOverride = userOverrides[defKey];
                  const currentValue = currentOverride !== undefined ? String(currentOverride) : (effectiveDefault ?? "");

                  return (
                    <div key={`row-${idx}`} data-row-idx={idx}
                      className={`flex items-center gap-2 p-2 rounded transition-all duration-150 ${
                        (dragging && def.key === dragKeyRef.current)
                          ? "border-yellow-400/60 bg-yellow-400/10 opacity-70"
                          : def.hidden
                            ? "opacity-30 grayscale"
                            : "border border-stealth-border hover:border-stealth-muted"
                      }`}>

                      {/* Drag handle — admin only */}
                      {adminLockState !== "locked" && (
                        <button onMouseDown={(e) => handleDragStart(e, idx)}
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

                      <span className="w-32 text-[13px] font-mono px-1 py-0.5 truncate" title={def.key}>{def.key}</span>

                      {/* Value bubbles */}
                      <ValueBubbles
                        paramKey={def.key}
                        isAdmin={adminLockState !== "locked"}
                        currentValue={currentValue}
                        onOverrideChange={(val) => setOverride(defKey, val)}
                        addValue={adminLockState !== "locked" ? (v: string | number) => addValueToParam(def.key, v) : undefined}
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

                      {/* Edit param metadata + Restore to genesis — admin only */}
                      {adminLockState !== "locked" && (
                        <div className="flex items-center gap-0.5 ml-auto">
                          <button onClick={() => openParamMetaEditor(def)}
                            className="leading-none text-[10px] font-mono text-nv-green/40 hover:text-yellow-400 transition-colors"
                            title="Edit param metadata">E</button>
                          <button onClick={() => handleRestoreParam(def.key)}
                            className="leading-none text-[10px] font-mono text-blue-500/50 hover:text-blue-400 transition-colors"
                            title="Restore this param from genesis template">R</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}

            {/* Add new param — admin only */}
            {adminLockState !== "locked" && (
              <AddParamSection
                onAdd={addParamDefinition}
                existingKeys={paramDefsBase.map(d => d.key)}
              />
            )}

            {/* Editor panels — inside flex-1 but outside map */}
            {editingParamKey && (
              <ParamMetaEditor
                editingKey={editingParamKey}
                form={paramMetaForm!}
                onFieldChange={(field, val) => setParamMetaForm(prev => prev ? ({ ...prev, [field]: val }) : null)}
                onSave={saveParamMetaEdit}
                onCancel={() => { setEditingParamKey(null); setParamMetaForm(null); }}
              />
            )}

            {editingValue && (
              <SubParamsEditor
                editingValue={editingValue}
                subArgsText={subArgsText}
                onTextChange={(k, v) => setSubArgsText(prev => ({ ...prev, [k]: v }))}
                onSave={saveSubParamsEdit}
                onDelete={deleteSubParamsEntry}
                onCancel={() => setEditingValue(null)}
              />
            )}
          </div>

          {/* Status bar footer */}
          <div className="px-4 py-3 border-t border-stealth-border flex items-center justify-between">
            <span className="text-[9px] font-mono text-stealth-muted">{paramDefs.length} parameter{paramDefs.length !== 1 ? "s" : ""}{hiddenCount > 0 ? ` (${hiddenCount} hidden)` : ""}</span>
            {currentProvider && (<span className="text-[9px] font-mono text-telemetry-cyan">{currentProvider.display_name}</span>)}
          </div>
        </div>
      )}

      {/* Template Update Modal */}
      {showUpdateModal && templateDiff && (
        <TemplateUpdateModal
          diff={templateDiff}
          selectedNewParams={selectedNewParams}
          providerId={selectedProviderId}
          onToggle={(key) => setSelectedNewParams(prev => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key); else next.add(key);
            return next;
          })}
          onCancel={() => { setShowUpdateModal(false); setTemplateDiff(null); }}
          onApply={handleApplyTemplateUpdate}
        />
      )}
    </div>
  );
}

function OverwriteTemplateButton({ providerId }: { providerId: string }) {
  const [step, setStep] = useState<"idle"|"pin"|"confirm"|"done">("idle");
  const [pinInput, setPinInput] = useState("");
  const [error, setError] = useState("");
  const PIN = "770909";

  if (step === "idle") {
    return (
      <button onClick={() => setStep("pin")}
        className="px-4 py-1 text-[9px] font-mono border border-red-400/40 bg-red-400/10 text-red-300 hover:bg-red-400/20 transition-colors">
        OVERWRITE TEMPLATE
      </button>
    );
  }
  if (step === "pin") {
    return (
      <div className="flex items-center gap-1">
        <input type="password" value={pinInput}
          onChange={(e) => { setPinInput(e.target.value); setError(""); }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (pinInput === PIN) { setStep("confirm"); setError(""); }
              else { setError("Invalid PIN"); setPinInput(""); }
            } else if (e.key === "Escape") {
              setStep("idle"); setPinInput("");
            }
          }}
          placeholder="PIN"
          className="w-16 bg-transparent border border-stealth-border/50 text-[9px] font-mono text-white px-1 py-0.5 focus:outline-none" />
        {error && <span className="text-[8px] font-mono text-red-400">{error}</span>}
      </div>
    );
  }
  if (step === "confirm") {
    return (
      <button onClick={async () => {
        try {
          const { invoke } = await import("@tauri-apps/api/core");
          await invoke("overwrite_template", { providerId, pin: parseInt(PIN, 10) });
          setStep("done");
          setTimeout(() => setStep("idle"), 1500);
        } catch (err) {
          console.error("[CONFIG] overwrite_template failed:", err);
          alert("Failed to overwrite template. See console for details.");
          setStep("idle");
        }
      }}
        className="px-4 py-1 text-[9px] font-mono border border-red-400/60 bg-red-400/20 text-red-300 hover:bg-red-400/30 transition-colors animate-pulse">
        CONFIRM OVERWRITE
      </button>
    );
  }
  return (
    <span className="text-[9px] font-mono text-nv-green px-2 py-1">✓ TEMPLATE SAVED</span>
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
}: {
  editingKey: string;
  form: { ptype: string; flag: string; mapId: string; pattern: string; values: (string | number)[]; defaultValue: string | number; subParams: Record<string, string> };
  onFieldChange: (field: string, val: any) => void;
  onSave: () => void;
  onCancel: () => void;
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
            className="bg-transparent border border-stealth-border/50 text-[10px] font-mono text-white px-1 py-0.5 focus:outline-none">
            <option value="arg_select">arg_select</option>
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

        {form.ptype === "mapper" && (
          <div className="flex flex-col gap-0.5">
            <span className="text-[8px] font-mono text-stealth-muted">map_id</span>
            <input type="text" value={form.mapId}
              onChange={(e) => onFieldChange("mapId", e.target.value)}
              placeholder="CTX_TO_INT"
              className="w-32 bg-transparent border-b border-stealth-border/50 text-[10px] font-mono text-white focus:outline-none px-1 py-0.5" />
          </div>
        )}

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

      {/* sub_params section */}
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

      <button onClick={onSave}
        className="mt-3 px-3 py-1 text-[9px] font-mono border border-nv-green/60 bg-nv-green/20 text-nv-green hover:bg-nv-green/30 transition-colors">APPLY</button>
    </div>
  );
}

// ── Sub-components ─────────────────────────────────────────────────

function TemplateUpdateModal({
  diff,
  selectedNewParams,
  onToggle,
  onCancel,
  onApply,
  providerId,
}: {
  diff: { new_params: DiffParam[]; orphaned_params: DiffParam[] };
  selectedNewParams: Set<string>;
  onToggle: (key: string) => void;
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
                  onChange={() => onToggle(p.key)}
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
            <h3 className={`text-[10px] font-mono mt-4 mb-2 ${selectedNewParams.size === diff.new_params.length ? "text-yellow-400" : "text-stealth-muted"}`}>
              ORPHANED PARAMS — UNCHECK TO REMOVE
            </h3>
            {diff.orphaned_params.map(p => (
              <div key={p.key} className="flex items-center gap-2 py-1">
                <input type="checkbox"
                  checked={selectedNewParams.has(p.key)}
                  onChange={() => onToggle(p.key)}
                  className="accent-yellow-400"
                />
                <span className={`text-[10px] font-mono ${selectedNewParams.has(p.key) ? "text-white" : "line-through text-stealth-muted"}`}>
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
          <OverwriteTemplateButton providerId={providerId} />
        </div>
      </div>
    </div>
  );
}

function AddParamSection({ onAdd, existingKeys }: {
  onAdd: (key: string, values: (string | number)[]) => void;
  existingKeys: string[];
}) {
  const [newKey, setNewKey] = useState("");
  const [newValueInput, setNewValueInput] = useState("");
  const [newValuesList, setNewValuesList] = useState<(string | number)[]>([]);

  const addNewValue = () => {
    const t = newValueInput.trim();
    if (!t) return;
    let p: string | number;
    if (/^-?\d+$/.test(t)) p = parseInt(t, 10);
    else if (/^-?\d+\.\d+$/.test(t)) p = parseFloat(t);
    else p = t;
    if (newValuesList.some(v => String(v) === String(p))) return;
    setNewValuesList(prev => [...prev, p]);
    setNewValueInput("");
  };

  const removeNewValue = (idx: number) => setNewValuesList(prev => prev.filter((_, i) => i !== idx));

  const addParam = () => {
    if (!newKey.trim() || newValuesList.length === 0) return;
    onAdd(newKey.trim(), [...newValuesList]);
    setNewKey(""); setNewValueInput(""); setNewValuesList([]);
  };

  return (
    <div className="mt-4 pt-3 border-t border-stealth-border">
      <h3 className="text-[10px] font-mono text-yellow-400 uppercase tracking-wider mb-2">ADD PARAMETER</h3>

      {newValuesList.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap mb-2">
          {newValuesList.map((val, idx) => (
            <span key={idx} className="inline-flex items-center gap-0.5 px-1.5 py-0.5 border text-[9px] font-mono rounded-sm bg-yellow-400/20 border-yellow-400/40 text-yellow-400">
              {String(val)}
              <button onClick={() => removeNewValue(idx)} className="ml-0.5 hover:text-red-400 transition-colors leading-none">×</button>
            </span>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-center flex-wrap">
        <input type="text" placeholder="Param key (e.g., CustomFlag)" value={newKey}
          onChange={(e) => setNewKey(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && addParam()}
          className="w-40 bg-transparent border-b border-stealth-border/50 text-[10px] font-mono text-white focus:outline-none px-1 py-0.5 placeholder:text-stealth-muted/50" />
        <input type="text" placeholder="+ add value" value={newValueInput}
          onChange={(e) => setNewValueInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); addNewValue(); } }}
          className="w-32 bg-transparent border-b border-stealth-border/50 text-[10px] font-mono text-white focus:outline-none px-1 py-0.5 placeholder:text-white/40" />
        <button onClick={addNewValue}
          disabled={!newValueInput.trim()}
          className="px-2 py-0.5 text-[9px] font-mono border border-yellow-400/40 text-yellow-400 hover:bg-yellow-500/20 transition-colors disabled:opacity-30">+ VALUE</button>
        <button onClick={addParam}
          disabled={!newKey.trim() || newValuesList.length === 0}
          className="px-2 py-0.5 text-[9px] font-mono border border-yellow-400/60 text-yellow-400 hover:bg-yellow-500/20 transition-colors disabled:opacity-30">ADD</button>
      </div>
    </div>
  );
}