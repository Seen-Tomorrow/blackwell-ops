import React, { useState, useCallback, useEffect, useRef, Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useTauriListen } from "../hooks/useTauriListen";
import type { ProviderConfig, UserEditedTemplateParam, FitScanComplete, FitScanProgress, FitScanFull, FitDataPoint, BinaryUpdateInfo } from "../lib/types";
import { DEFAULT_PROVIDER_ID, isProfileBuilt } from "../lib/types";
import { useFoundry, type Env } from "../hooks/useBuildDock";
import { ENV_ORDER, ENV_META } from "../lib/foundry_constants";
import { FIT_SCAN_PARALLEL_OPTIONS } from "../lib/onboarding";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import { loadFoundryLastRefresh, loadStartupUpdatesCache, saveFoundryLastRefresh } from "../lib/storage";
import { BuildProfileRow, RestoreConfirmModal, parseCmakeFlags, UpdateStatus } from "./FoundryComponents";

function formatElapsed(startTime: number): string {
  const secs = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface ProvidersConfigProps {
  providers: ProviderConfig[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
}

interface FormState {
  id: string;
  display_name: string;
  binary_path: string;
  enabled: boolean;
  params: Record<string, string>;
  userEditedTemplateParams?: UserEditedTemplateParam[];
  _original_id?: string;
  git_url: string;
  branch: string;
  build_profile: string;
  template_type: string;
  factory_provided?: boolean;
}

type ScanStatus = "idle" | "scanning" | "complete" | "error";

interface ProviderScanState {
  status: ScanStatus;
  parallel: number;
  totalModels: number;
  completed: number;
  failed: number;
  results?: FitScanComplete;
  error?: string;
  scanStartTime?: number;
}

export default function ProvidersConfig({ providers: initialProviders, onProvidersChange }: ProvidersConfigProps) {
  const [providers, setProviders] = useState<ProviderConfig[]>(initialProviders);
  const [form, setForm] = useState<FormState>({
    id: "",
    display_name: "",
    binary_path: "",
    enabled: true,
    params: {},
    git_url: "",
    branch: "",
    build_profile: "",
    template_type: "ggml-llama",
  });

  const { openBuildModal, buildProgress } = useFoundry();
  const [restoreConfirm, setRestoreConfirm] = useState<{ providerId: string; env: Env } | null>(null);

  const detectTemplateType = useCallback((id: string) => {
    const lower = id.toLowerCase();
    if (lower.includes("ik")) return "ik-llama";
    return "ggml-llama";
  }, []);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [scanLibraryMenuId, setScanLibraryMenuId] = useState<string | null>(null);
  const didAutoExpandRef = useRef(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-provider scan states
  const [scanStates, setScanStates] = useState<Record<string, ProviderScanState>>({});

  // Ref to always have the latest parallel setting available during async operations
  const parallelRef = useRef<Record<string, number>>({});

  // Binary update state per provider/profile
  const [binaryUpdates, setBinaryUpdates] = useState<Record<string, Record<string, BinaryUpdateInfo>>>({});
  const [updateStatuses, setUpdateStatuses] = useState<Record<string, UpdateStatus>>({});
  const [updateErrors, setUpdateErrors] = useState<Record<string, string>>({});

  const loadProviders = useCallback(async () => {
    try {
      const data = await invoke<ProviderConfig[]>("list_providers");
      setProviders(data);
      onProvidersChange(data);
      setError(null);
    } catch (err) {
      console.error("Failed to load providers:", err);
      setError(typeof err === "string" ? err : JSON.stringify(err));
    }
  }, [onProvidersChange]);

  useEffect(() => { loadProviders(); }, [loadProviders]);

  useEffect(() => {
    if (didAutoExpandRef.current || providers.length === 0) return;
    setExpandedIds(new Set(providers.map((p) => p.id)));
    didAutoExpandRef.current = true;
  }, [providers]);

  const toggleExpanded = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Stay in sync when parent App state reloads (e.g. after Foundry build completes).
  useEffect(() => {
    if (initialProviders.length > 0) {
      setProviders(initialProviders);
    }
  }, [initialProviders]);

  useEffect(() => {
    const handler = () => { void loadProviders(); };
    window.addEventListener(EVENTS.reloadProviders, handler);
    return () => window.removeEventListener(EVENTS.reloadProviders, handler);
  }, [loadProviders]);

  const handleBrowse = useCallback(async () => {
    try {
      const result: string | null = await invoke("open_file_dialog", {
        title: "Select Provider Binary",
        filter: "Executable (*.exe)|exe|All Files (*.*)|*",
      });
      if (result) {
        setForm((prev) => ({ ...prev, binary_path: result }));
      }
    } catch (err) {
      console.error("File dialog failed:", err);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.id.trim() || !form.display_name.trim()) {
      setError("Type ID and Name are required.");
      return;
    }

    if (!form.binary_path.trim()) {
      setError("Binary path is required.");
      return;
    }

    setLoading(true);
    setError(null);

    try {
      const provider: ProviderConfig = {
        id: form.id.toLowerCase().replace(/\s+/g, "-"),
        display_name: form.display_name.trim(),
        binary_path: form.binary_path.trim(),
        enabled: form.enabled,
        params: Object.fromEntries(
          Object.entries(form.params).filter(([_, v]) => v.trim() !== "")
        ),
        userEditedTemplateParams: form.userEditedTemplateParams || [],
        _original_id: form._original_id || undefined,
        git_url: form.git_url || "",
        branch: form.branch || "",
        build_profile: form.build_profile || "",
        template_type: form.template_type || "ggml-llama",
      };

      await invoke("save_provider", { provider });
      await loadProviders();

  setForm({ id: "", display_name: "", binary_path: "", enabled: true, params: {}, git_url: "", branch: "", build_profile: "", template_type: "ggml-llama", factory_provided: false });
      setEditingId(null);
      setShowAddForm(false);
    } catch (err) {
      console.error("Failed to save provider:", err);
      setError(typeof err === "string" ? err : JSON.stringify(err));
    } finally {
      setLoading(false);
    }
  }, [form, loadProviders]);

  const handleEdit = useCallback((p: ProviderConfig) => {
    let paramPairs: Record<string, string> = {};
    if (p.params && typeof p.params === "object" && !Array.isArray(p.params)) {
      for (const [k, v] of Object.entries(p.params)) {
        paramPairs[k] = String(v);
      }
    }

    setForm({
      id: p.id,
      display_name: p.display_name,
      binary_path: p.binary_path,
      enabled: p.enabled,
      params: paramPairs,
      userEditedTemplateParams: p.userEditedTemplateParams || [],
      _original_id: p.id,
      git_url: p.git_url || "",
      branch: p.branch || "",
      build_profile: p.build_profile || "",
      template_type: p.template_type || "ggml-llama",
      factory_provided: p.factory_provided,
    });
    setEditingId(p.id);
    setExpandedIds((prev) => new Set(prev).add(p.id));
    setShowAddForm(true);
  }, []);

  const handleCancel = useCallback(() => {
    setForm({ id: "", display_name: "", binary_path: "", enabled: true, params: {}, git_url: "", branch: "", build_profile: "", template_type: "ggml-llama", factory_provided: false });
    setEditingId(null);
    setShowAddForm(false);
    setError(null);
  }, []);

  const handleDelete = useCallback(async (id: string) => {
    if (!confirm(`Remove provider "${id}"?`)) return;

    try {
      await invoke("remove_provider", { id });
      await loadProviders();
      if (editingId === id) handleCancel();
    } catch (err) {
      console.error("Failed to remove provider:", err);
      setError(typeof err === "string" ? err : JSON.stringify(err));
    }
  }, [loadProviders, editingId, handleCancel]);

  const handleReorder = useCallback(async (id: string, direction: number) => {
    try {
      await invoke("reorder_provider", { providerId: id, direction });
      await loadProviders();
    } catch (err) {
      console.error("Failed to reorder provider:", err);
    }
  }, [loadProviders]);

  const handleToggleEnabled = useCallback(async (id: string) => {
    try {
      const updated = providers.map((p) =>
        p.id === id ? { ...p, enabled: !p.enabled } : p
      );
      for (const p of updated) {
        if (p.id === id) {
          await invoke("save_provider", { provider: p });
        }
      }
      setProviders(updated);
      onProvidersChange(updated);
    } catch (err) {
      console.error("Failed to toggle provider:", err);
    }
  }, [providers, onProvidersChange]);

  // ── FIT Scan handlers ────────────────────────────────────────

  const handleScanLibrary = useCallback(async (providerId: string) => {
    const currentParallel = parallelRef.current[providerId] ?? FIT_SCAN_PARALLEL_OPTIONS[0];

    setScanStates((prev) => {
      const oldState = prev[providerId];
      return {
        ...prev,
        [providerId]: {
          status: "scanning",
          parallel: currentParallel,
          totalModels: 0,
          completed: 0,
          failed: 0,
          results: oldState?.results ? { ...oldState.results, results: {} } : undefined,
          scanStartTime: Date.now(),
        },
      };
    });

    try {
      const allProviders = await invoke<ProviderConfig[]>("list_providers");
      const provider = allProviders.find(p => p.id === providerId);
      const batch = provider?.params?.batch || 2048;
      const ubatch = provider?.params?.ubatch || provider?.params?.ubatch_size || 512;

      const result = await invoke<FitScanComplete>("fit_scan_library", {
        providerId,
        modelBase: "",
        parallelCount: Math.max(currentParallel, 1),
        batch,
        ubatch,
        forceRescan: false,
      });

      setScanStates((prev) => ({
        ...prev,
        [providerId]: {
          status: "complete",
          parallel: currentParallel,
          totalModels: result.total_models,
          completed: result.completed,
          failed: result.failed,
          results: result,
        },
      }));

    } catch (err) {
      console.error(`Scan library failed for ${providerId}:`, err);
      setScanStates((prev) => ({
        ...prev,
        [providerId]: {
          status: "error",
          parallel: currentParallel,
          totalModels: 0,
          completed: 0,
          failed: 0,
          error: typeof err === "string" ? err : JSON.stringify(err),
        },
      }));
    }
  }, []);

  const handleStopScan = useCallback(async (providerId: string) => {
    try {
      await invoke("fit_stop_scan");
    } catch {}
    setScanStates((prev) => ({
      ...prev,
      [providerId]: {
        status: "idle",
        parallel: prev[providerId]?.parallel || 2,
        totalModels: 0,
        completed: 0,
        failed: 0,
      },
    }));
  }, []);

  // ── FIT scan event listener ───────────────────────────────────

  const listenerGuardRef = useRef(false);
  useEffect(() => {
    if (listenerGuardRef.current) return;
    listenerGuardRef.current = true;

    let unsub: (() => void) | null = null;
    const init = async () => {
      unsub = await listen<FitScanProgress>("fit-scan-progress", (e) => {
        try {
          const evt: FitScanProgress = e.payload;
          if (!evt || !evt.model_path) return;

          if (evt.status !== "error") {
            void invoke("emit_to_blackwell_console", {
              category: "utils",
              content: `[FIT-SCAN] ${evt.model_path} | ${evt.status} | ${evt.label || ''} | ${evt.vram_mib != null ? evt.vram_mib + ' MiB' : ''}`,
              style: evt.status === "complete" ? "Success" : "Normal",
            });
          }

          setScanStates((prev) => {
            const hasActiveScan = Object.values(prev).some(s => s.status === "scanning");
            if (!hasActiveScan) return prev;

            for (const [pid, ps] of Object.entries(prev)) {
              if (ps.status !== "scanning") continue;

               const existingResults = ps.results?.results ?? {};
               const prevEntry: FitScanFull | undefined = existingResults[evt.model_path];

                let newPoints = prevEntry ? prevEntry.points.filter(Boolean) : [];
                 if (evt.status === "complete" && evt.vram_mib != null && evt.label) {
                   const pt: FitDataPoint = {
                     label: evt.label, ctx: 0, kv_quant: "", batch: 0, parallel: 0, split_mode: "",
                     vram_mib: evt.vram_mib,
                   };
                   const existingIdx = newPoints.findIndex((p: FitDataPoint) => p.label === evt.label);
                   if (existingIdx >= 0) {
                     newPoints[existingIdx] = pt;
                    } else if (newPoints.length < (ps.results?.scan_points_total ?? 999)) {
                     newPoints.push(pt);
                   }
                 }

               const entry: FitScanFull = prevEntry
                  ? { ...prevEntry, points: newPoints }
                  : { model_path: evt.model_path, points: newPoints, error: undefined };

              const updatedResults = { ...existingResults, [evt.model_path]: entry };
              return {
                ...prev,
                [pid]: {
                  ...ps,
                  totalModels: Math.max(ps.totalModels, Object.keys(updatedResults).length),
                  results: ps.results ? { ...ps.results, results: updatedResults } : { total_models: 0, completed: 0, failed: 0, provider_id: pid, results: updatedResults },
                },
              };
            }
            return prev;
          });
        } catch {}
      });
    };
    init();
    return () => { if (unsub) unsub(); };
  }, []);

  // ── Foundry build info refresh on mount ───────────────────────

  const hasRefreshed = useRef(false);
  useEffect(() => {
    if (hasRefreshed.current) return;
    hasRefreshed.current = true;

    const providerSignature = providers.map(p => p.id).join(",");
    const lastRefresh = loadFoundryLastRefresh(providerSignature);
    const now = Date.now();
    if (now - lastRefresh < 5000) {
      hasRefreshed.current = false;
      return;
    }
    saveFoundryLastRefresh(providerSignature, now);

    const foundryProviders = providers.filter(p => p.git_url && p.branch);
    let cancelled = false;
    foundryProviders.forEach(async (p) => {
      try {
        const updated = await invoke<ProviderConfig[]>("refresh_build_info", { providerId: p.id });
        if (!cancelled && updated.length > 0) onProvidersChange(updated);
      } catch (err) {
        console.error("[Foundry] Failed to refresh build info for", p.id, err);
      }
    });

    let cachedUpdates: Record<string, BinaryUpdateInfo[]> | null = null;
    try {
      const parsed = loadStartupUpdatesCache();
      if (parsed?.timestamp && Date.now() - parsed.timestamp < 300_000 && parsed.binaryUpdates) {
        cachedUpdates = {};
        parsed.binaryUpdates.forEach((bu: any) => {
          cachedUpdates![bu.providerId] = bu.updates;
        });
      }
    } catch (err) { console.error("[Foundry] Build info refresh error:", err); }

    foundryProviders.forEach(async (p) => {
      try {
        let updates: BinaryUpdateInfo[];
        if (cachedUpdates && cachedUpdates[p.id]) {
          updates = cachedUpdates[p.id];
        } else {
          updates = await invoke<BinaryUpdateInfo[]>("check_binary_updates", { providerId: p.id });
        }
        if (!cancelled && updates.length > 0) {
          const withInstalled = updates.map(u => ({
            ...u,
            installedVersion: (p.downloadedVersionPerEnv?.[u.profile] || null),
            available: u.available && !(p.downloadedVersionPerEnv?.[u.profile] === `v${u.latestVersion}`),
          }));
          setBinaryUpdates(prev => {
            const next = { ...prev };
            next[p.id] = {};
            withInstalled.forEach(u => { next[p.id]![u.profile] = u; });
            return next;
          });
        }
      } catch (err) {
        console.error("[Foundry] Failed to check binary updates for", p.id, err);
      }
    });

    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Foundry build complete event listener ─────────────────────

  useEffect(() => {
    const unsub = listen<{ build_id: number; phase: string; provider_id: string }>("foundry-progress", async (e) => {
      if (e.payload.phase === "Complete") {
        try {
          const updated = await invoke<ProviderConfig[]>("refresh_build_info", { providerId: e.payload.provider_id });
          if (updated.length > 0) {
            setProviders(updated);
            onProvidersChange(updated);
          }
          dispatchAppEvent(EVENTS.reloadProviders);
        } catch (err) { console.error("[Foundry] Status check error:", err); }
      }
    });
    return () => { unsub.then(u => u()); };
  }, [onProvidersChange]);

  useTauriListen<{ provider_id: string; profile: string }>("binary-update:download-start", (payload) => {
    const key = `${payload.provider_id}:${payload.profile}`;
    setUpdateStatuses((prev) => ({ ...prev, [key]: "downloading" }));
  });

  useTauriListen<{ provider_id: string; profile: string; status: string }>("binary-update:download-progress", (payload) => {
    const key = `${payload.provider_id}:${payload.profile}`;
    setUpdateStatuses((prev) => ({
      ...prev,
      [key]: payload.status === "extracting" ? "extracting" : "downloading",
    }));
  });

  useTauriListen<{ provider_id: string; profile: string }>("binary-update:download-complete", (payload) => {
    const key = `${payload.provider_id}:${payload.profile}`;
    setUpdateStatuses((prev) => ({ ...prev, [key]: "complete" }));
    invoke<ProviderConfig[]>("refresh_build_info", { providerId: payload.provider_id })
      .then((updated) => { if (updated.length > 0) onProvidersChange(updated); })
      .catch((err) => console.error("[Foundry] Binary update event error:", err));
  }, [onProvidersChange]);

  // ── Foundry handlers ──────────────────────────────────────────

  const handleBinaryUpdate = useCallback(async (providerId: string, profile: Env) => {
    const key = `${providerId}:${profile}`;
    setUpdateStatuses(prev => ({ ...prev, [key]: "checking" }));
    setUpdateErrors(prev => { const next = { ...prev }; delete next[key]; return next; });

    try {
      await invoke("download_binary_update", { providerId, profile });
    } catch (err) {
      const msg = typeof err === "string" ? err : String(err);
      setUpdateStatuses(prev => ({ ...prev, [key]: "error" }));
      setUpdateErrors(prev => ({ ...prev, [key]: msg }));
      console.error("[Foundry] Binary update failed:", err);
    }
  }, []);

  const handleRevert = useCallback(async (providerId: string, profile: Env) => {
    try {
      await invoke("revert_binary_to_bundled", { providerId, profile });
      invoke<ProviderConfig[]>("refresh_build_info", { providerId })
        .then(updated => { if (updated.length > 0) onProvidersChange(updated); })
        .catch((err) => console.error("[Foundry] Binary update event error:", err));
    } catch (err) {
      console.error("[Foundry] Revert failed:", err);
    }
  }, [onProvidersChange]);

  const handleRestore = async () => {
    if (!restoreConfirm) return;
    try {
      await invoke("foundry_restore", {
        providerId: restoreConfirm.providerId,
        environment: restoreConfirm.env,
      });
      await invoke<ProviderConfig[]>("refresh_build_info", { providerId: restoreConfirm.providerId })
        .then(updated => { if (updated.length > 0) onProvidersChange(updated); })
        .catch((err) => console.error("[Foundry] Binary update event error:", err));
    } catch (err) {
      console.error("[Foundry] Restore failed:", err);
    } finally {
      setRestoreConfirm(null);
    }
  };

  // ── Scan progress render ──────────────────────────────────────

  const renderScanProgress = (providerId: string) => {
    const state = scanStates[providerId];

    if (!state || state.status === "idle") {
      return null;
    }

    return (
      <div className="config-scan-panel mt-2 p-2 rounded-sm w-full">
        {/* Header row */}
        <div className="flex items-center justify-between mb-1.5">
          <span className={`text-[9px] font-mono tracking-wider ${state.status === "error" ? "text-red-400" : "theme-accent-text"}`}>
            {state.status === "scanning" ? "\u25CF SCANNING..." : 
             state.status === "complete" ? "\uD83C\uDF6C COMPLETE" :
             state.status === "error" ? "\u2716 ERROR" : ""}
          </span>
          <div className="flex items-center gap-2">
            {state.status === "scanning" && (
              <button
                onClick={() => handleStopScan(providerId)}
                className="value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm text-red-400"
              >
                STOP
              </button>
            )}
          </div>
        </div>

        {/* Progress bar */}
        {state.totalModels > 0 && (
          <div className="mb-1.5">
            <div className="h-0.5 bg-stealth-border rounded-sm overflow-hidden">
              <div
                className={`h-full transition-all duration-300 ${state.status === "error" ? "bg-red-400" : ""}`}
                style={{
                  backgroundColor: state.status === "error" ? undefined : "var(--theme-accent)",
                  width: `${state.status === "scanning" && state.results ? (Object.keys(state.results.results).length / Math.max(state.totalModels, 1)) * 100 : (state.completed / Math.max(state.totalModels, 1)) * 100}%`,
                }}
              />
            </div>
            <p className="text-[8px] font-mono config-muted mt-0.5">
              {state.status === "scanning"
                ? `${Object.keys(state.results?.results ?? {}).length} models...`
                : `${state.completed} / ${state.totalModels}`}{state.failed > 0 && state.status !== "scanning" ? ` (${state.failed} failed)` : ""}
              {state.scanStartTime && state.status === "complete" ? ` — done in ${formatElapsed(state.scanStartTime)}` : ""}
            </p>
          </div>
        )}

        {/* Error message */}
        {state.error && (
          <p className="text-[8px] font-mono text-red-400 mb-1.5 break-all">{state.error}</p>
        )}

        {/* Results table */}
        {state.results && Object.keys(state.results.results).length > 0 && (
          <div className="max-h-48 overflow-y-auto pr-1">
            <div className="grid grid-cols-[20px_minmax(0,_1fr)_64px_64px_56px] items-center gap-1 text-[7px] font-mono py-0.5 config-muted uppercase tracking-wider border-b border-stealth-border/30 mb-0.5">
              <span></span><span>Model</span>
              <span>Base(8K)</span>
              <span>128K/q4</span>
              <span>Points</span>
            </div>
            {Object.entries(state.results.results).map(([path, entry]) => {
               let modelName = path.split("\\").pop()?.replace(".gguf", "") || path;
               modelName = modelName.replace(/-\d{3,}-of-\d{3,}$/i, "");
              const full = entry;
              const pts = full.points ?? [];
              const nPts = pts.length;

               const basePt = pts.find((p: FitDataPoint) => p?.label === "base");
               const q4Pt = pts.find((p: FitDataPoint) => p?.label === "quant_q4");
               const pointsTotal = state.results!.scan_points_total ?? 999;
               const isComplete = nPts >= pointsTotal;

              return (
                <div key={path} className="grid grid-cols-[20px_minmax(0,_1fr)_64px_64px_56px] items-center gap-1 text-[8px] font-mono py-0.5">
                  <span className={`${full.error ? "text-red-400" : isComplete || nPts > 0 ? "theme-accent-text" : "config-muted"}`}>
                    {isComplete ? "\u2713" : nPts > 0 ? "\u25CF" : full.error ? "\u2716" : "!"}
                  </span>
                  <span className="config-muted truncate" title={path}>
                    {modelName}
                  </span>
                  {basePt && basePt.vram_mib > 0 ? <span className="theme-accent-text">{(basePt.vram_mib / 1024).toFixed(1)}G</span> : <span></span>}
                  {q4Pt && q4Pt.vram_mib > 0 ? <span className="theme-accent-text">{(q4Pt.vram_mib / 1024).toFixed(1)}G</span> : <span></span>}
                    <span className={isComplete ? "theme-accent-text" : "config-muted"}>{nPts}/{pointsTotal}</span>
                </div>
              );
            })}
          </div>
        )}

        {/* Action buttons */}
        <div className="flex gap-2 mt-2 pt-1.5 border-t border-stealth-border/50">
          {state.status !== "scanning" && (
            <button
              onClick={() => handleScanLibrary(providerId)}
              className="value-chip text-[8px] font-mono px-2 py-0.5 rounded-sm"
            >
              {"RESCAN"}
            </button>
          )}
          <button
            onClick={() => handleStopScan(providerId)}
            className="value-chip text-[8px] font-mono px-2 py-0.5 rounded-sm"
          >
            CLEAR
          </button>
        </div>
      </div>
    );
  };

  // ── Render ────────────────────────────────────────────────────

  return (
    <div className="h-full flex flex-col overflow-hidden" data-config-page>
      {/* Toolbar header */}
      <div className="px-4 py-2.5 config-section-bar flex items-center justify-between flex-wrap gap-2 relative">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-mono theme-accent-text tracking-widest">BACKEND PROVIDERS</h2>
          <span className="text-[8px] font-mono config-muted opacity-60">{providers.length} REGISTERED</span>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mx-4 mt-3 p-2 border border-red-500/30 bg-red-500/5 rounded-sm">
          <p className="text-[10px] font-mono text-red-400 break-all">{error}</p>
        </div>
      )}

      {/* Provider list */}
      <div className="flex-1 overflow-y-auto eink-scrollbar p-4 min-h-0">
        {/* Add new provider button */}
        <button onClick={() => { setEditingId(null); setShowAddForm(!showAddForm); }}
          className={`flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider transition-colors theme-accent-text ${showAddForm && !editingId ? "opacity-100" : "opacity-60 hover:opacity-100"}`}>
          <span className="text-[8px]">{showAddForm && !editingId ? "\u25BC" : "\u25B6"}</span>
          ADD NEW PROVIDER
        </button>

        {showAddForm && !editingId && (
          <div className="config-form-panel space-y-2 mt-2 mb-3 p-4 rounded-sm">
            {/* ID field */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Type ID</label>
              <input type="text" placeholder="e.g. stable, nightly, my-ik-fork" value={form.id}
                onChange={(e) => setForm((prev) => ({ ...prev, id: e.target.value, template_type: detectTemplateType(e.target.value) }))}
                className="config-input flex-1 text-[11px] font-mono px-1 py-0.5" />
            </div>
            {/* Template Type selector */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Template</label>
              <select value={form.template_type} onChange={(e) => setForm((prev) => ({ ...prev, template_type: e.target.value }))}
                className="config-input flex-1 text-[11px] font-mono px-1 py-0.5 appearance-none">
                <option value="ggml-llama">GGML-Llama (22 params)</option>
                <option value="ik-llama">IK-Llama (8 params)</option>
                <option value="">Custom (manual)</option>
              </select>
            </div>
            {/* Display name */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Name</label>
              <input type="text" placeholder="e.g. llama.cpp Stable" value={form.display_name}
                onChange={(e) => setForm((prev) => ({ ...prev, display_name: e.target.value }))}
                className="config-input flex-1 text-[11px] font-mono px-1 py-0.5" />
            </div>
            <ProviderFormFields form={form} setForm={setForm} handleBrowse={handleBrowse} isFactoryProvided={false} />
            {/* Action buttons */}
            <div className="flex gap-2 pt-1">
              <button onClick={handleSave} disabled={loading || !form.id.trim() || !form.display_name.trim() || !form.binary_path.trim()}
                className="value-chip-active text-[10px] font-mono px-3 py-1 rounded-sm disabled:opacity-40 disabled:cursor-not-allowed">
                {loading ? "SAVING..." : "REGISTER"}
              </button>
            </div>
          </div>
        )}

        {providers.length === 0 ? (
          <div className="flex items-center justify-center h-full text-stealth-muted text-xs font-mono">
            NO PROVIDERS REGISTERED — ADD ONE ABOVE
          </div>
        ) : (
          <div className="mb-6">
            {/* Sort bar */}
            <div className="flex items-center gap-1 px-3 py-2 config-section-bar">
              <span className="text-[8px] font-mono config-muted uppercase tracking-wider w-6">#</span>
              <span className="text-[7px] font-mono config-muted uppercase tracking-wider w-12">Order</span>
              <span className="text-[8px] font-mono config-muted uppercase tracking-wider flex-1">Provider</span>
              <span className="text-[8px] font-mono config-muted uppercase tracking-wider">Actions</span>
            </div>

            {providers.map((p, idx) => {
              const isExpanded = expandedIds.has(p.id);
              return (
              <Fragment key={p.id}>
              <div
                onClick={() => toggleExpanded(p.id)}
                className={`config-provider-card flex gap-4 p-3 cursor-pointer mb-2 ${
                  editingId === p.id ? "is-editing" : isExpanded ? "is-expanded" : ""
                } ${!p.enabled ? "opacity-40" : ""}`}>
                {/* ── Position number ─────────── */}
                <div className="flex items-center flex-shrink-0" style={{ minWidth: "16px" }}>
                  <span className={`text-[9px] font-mono ${isExpanded ? "theme-accent-text" : "config-muted"}`}>{idx + 1}</span>
                </div>

                {/* ── Reorder arrows (always visible) ─────────── */}
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button onClick={(e) => { e.stopPropagation(); handleReorder(p.id, -1); }} disabled={idx <= 0}
                    className="text-[9px] font-mono config-muted hover:theme-accent-text transition-colors disabled:opacity-20 disabled:cursor-not-allowed leading-none" title="Move up">
                    ▲
                  </button>
                  <button onClick={(e) => { e.stopPropagation(); handleReorder(p.id, 1); }} disabled={idx >= providers.length - 1}
                    className="text-[9px] font-mono config-muted hover:theme-accent-text transition-colors disabled:opacity-20 disabled:cursor-not-allowed leading-none" title="Move down">
                    ▼
                  </button>
                </div>

                {/* ── Table columns ─────────── */}
                <div className="flex items-center gap-6 flex-1 min-w-0">
                  {/* ID + name column */}
                  <div className="flex items-center gap-2.5 flex-shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); handleToggleEnabled(p.id); }}
                      className={`text-[10px] select-none transition-colors ${
                        p.enabled ? "theme-accent-text" : "config-muted opacity-40"
                      }`}
                      title={p.enabled ? "Disable provider" : "Enable provider"}>
                      {p.enabled ? "\u25CF" : "\u25EF"}
                    </button>
                    <span className="provider-pill border text-[9px] font-mono px-1.5 py-0.5 rounded-sm shrink-0">
                      {p.id}
                    </span>
                    <span className={`text-[10px] font-mono truncate max-w-[180px] ${isExpanded ? "theme-accent-text" : ""}`} title={p.display_name}>
                      {p.display_name}
                    </span>
                    {p.id === DEFAULT_PROVIDER_ID && (
                      <span className="value-chip text-[7px] font-mono px-1.5 py-0.5 rounded-sm shrink-0">DEFAULT</span>
                    )}
                  </div>

                  {/* Params badge */}
                  {p.userEditedTemplateParams && p.userEditedTemplateParams.length > 0 && (
                    <span className="value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm shrink-0">
                      {p.userEditedTemplateParams.length} params
                    </span>
                  )}

                  {/* Spacer */}
                  <div className="flex-1 min-w-4" />

                  {/* Actions group */}
                  <div className="flex items-center gap-2.5 flex-shrink-0">
                      <button onClick={(e) => { e.stopPropagation(); handleEdit(p); }}
                       className="value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm">
                       EDIT
                     </button>
                    {!p.factory_provided && (
                      <button onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}
                        className="value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm text-red-400">
                        REMOVE
                      </button>
                    )}

                    {/* SCAN LIBRARY — click to pick parallelism */}
                    <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-stealth-border/30">
                      {scanStates[p.id]?.status === "scanning" ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleStopScan(p.id); }}
                          className="value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm text-telemetry-red"
                        >
                          ⏹ STOP
                        </button>
                      ) : scanLibraryMenuId === p.id ? (
                        <div className="flex items-center gap-1">
                          {FIT_SCAN_PARALLEL_OPTIONS.map((n) => (
                            <button
                              key={n}
                              onClick={(e) => {
                                e.stopPropagation();
                                parallelRef.current[p.id] = n;
                                setScanLibraryMenuId(null);
                                void handleScanLibrary(p.id);
                              }}
                              className="px-1.5 py-0.5 text-[9px] font-mono rounded-sm transition-colors value-chip hover:value-chip-active"
                              title={`Scan library with ${n}x parallelism`}
                            >
                              {n}×
                            </button>
                          ))}
                        </div>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); setScanLibraryMenuId(p.id); }}
                          data-onboarding="scan-library"
                          className="value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm"
                        >
                          SCAN LIBRARY ▾
                        </button>
                      )}
                    </div>

                    {/* Expand chevron */}
                    <span className={`text-[8px] transition-transform ${isExpanded ? "rotate-90" : ""}`}>▶</span>
                  </div>
                </div>
              </div>

              {/* ── Expanded section ─────────── */}
              {isExpanded && (
                <div className="ml-8 mr-2 mb-3 space-y-3">
                  {/* Foundry build environments — only show for providers with git config */}
                  {p.git_url && p.branch && (() => {
                    const latestEnv = (() => {
                      let latestDate = "";
                      let latestKey: Env | null = null;
                      for (const env of ENV_ORDER) {
                        const info = p.buildInfoPerEnv?.[env];
                        if (info && info.buildDate > latestDate) {
                          latestDate = info.buildDate;
                          latestKey = env;
                        }
                      }
                      return latestKey;
                    })();

                    const cmakeFlags = p.build_profile?.trim() || "";
                    const isCustomFlags = cmakeFlags.length > 0;
                    const flagLines = parseCmakeFlags(cmakeFlags);

                    return (
                      <div className="foundry-build-panel">
                        {/* Foundry header */}
                        <div className="foundry-build-header flex items-center gap-3 px-3 py-2">
                          <span style={{ fontSize: '12px' }}>⚒</span>
                          <span className="text-[9px] font-mono theme-accent-text tracking-wider">FOUNDRY BUILDS</span>
                          {/* CMake flags badge */}
                          <div className="relative inline-block group">
                            <span className={`value-chip text-[7px] font-mono px-1.5 py-0.5 rounded-sm cursor-help ${isCustomFlags ? "value-chip-active" : ""}`}>
                              {isCustomFlags ? "CUSTOM FLAGS" : "DEFAULT"}
                            </span>
                            <div className="absolute top-full left-0 mt-1 w-[320px] config-form-panel rounded-sm p-2 pointer-events-none z-[9999] opacity-0 group-hover:opacity-100 transition-opacity shadow-2xl">
                              {flagLines.length > 0 ? (
                                <div className="space-y-0.5">
                                  {flagLines.map((f, i) => (
                                    <div key={i} className="text-[7px] font-mono config-muted whitespace-pre-wrap break-all">{f}</div>
                                  ))}
                                </div>
                              ) : (
                                <div className="text-[7px] font-mono config-muted">Using default cmake flags for {p.template_type || "ggml-llama"}</div>
                              )}
                            </div>
                          </div>
                          <span className="text-[8px] font-mono config-muted truncate max-w-[240px]" title={p.git_url}>
                            {p.git_url.replace(/.*\/\/|\.git$/g, "")} :{p.branch}
                          </span>
                        </div>

                        {/* Build profiles — vertical stack */}
                        <div className="p-3 space-y-2">
                          {ENV_ORDER.map(env => {
                            const meta = ENV_META[env];
                            const hasBackup = isProfileBuilt(p, env);
                            return (
                              <BuildProfileRow
                                key={env}
                                env={env}
                                meta={meta}
                                provider={p}
                                isLatestBuild={latestEnv === env}
                                hasBackup={!!hasBackup}
                                isBuilding={buildProgress?.providerId === p.id && buildProgress?.environment.toLowerCase() === env}
                                onBuild={() => openBuildModal(p.id, env)}
                                onRestoreConfirm={() => setRestoreConfirm({ providerId: p.id, env })}
                                binaryUpdate={(binaryUpdates[p.id] || {})[env]}
                                updateStatus={updateStatuses[`${p.id}:${env}`] || "idle"}
                                updateError={updateErrors[`${p.id}:${env}`]}
                                onUpdateBinary={() => handleBinaryUpdate(p.id, env)}
                                onRevert={() => handleRevert(p.id, env)}
                              />
                            );
                          })}
                        </div>
                      </div>
                    );
                  })()}

                  {/* Scan progress/results */}
                  {renderScanProgress(p.id)}

                  {/* Inline edit form — appears directly below the expanded provider */}
                  {editingId === p.id && (
                    <div className="config-form-panel rounded-sm p-3 space-y-2">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-[10px] font-mono theme-accent-text">{p.id} — EDIT PROVIDER</span>
                        <button onClick={handleCancel} className="config-muted hover:theme-accent-text transition-colors leading-none">✕</button>
                      </div>
                      {/* ID field */}
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Type ID</label>
                        <input type="text" value={form.id} onChange={(e) => setForm((prev) => ({ ...prev, id: e.target.value }))}
                          className="config-input flex-1 text-[11px] font-mono px-1 py-0.5" />
                      </div>
                      {/* Template Type selector */}
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Template</label>
                        <select value={form.template_type} onChange={(e) => setForm((prev) => ({ ...prev, template_type: e.target.value }))}
                          className="config-input flex-1 text-[11px] font-mono px-1 py-0.5">
                          <option value="ggml-llama" style={{fontSize: '11px'}}>GGML-Llama (22 params)</option>
                          <option value="ik-llama" style={{fontSize: '11px'}}>IK-Llama (8 params)</option>
                          <option value="" style={{fontSize: '11px'}}>Custom (manual)</option>
                        </select>
                      </div>
                      {/* Display name */}
                      <div className="flex items-center gap-2">
                        <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Name</label>
                        <input type="text" value={form.display_name} onChange={(e) => setForm((prev) => ({ ...prev, display_name: e.target.value }))}
                          className="config-input flex-1 text-[11px] font-mono px-1 py-0.5" />
                      </div>
                      <ProviderFormFields form={form} setForm={setForm} handleBrowse={handleBrowse} isFactoryProvided={form.factory_provided} />
                        {/* Action buttons */}
                        <div className="flex gap-2 pt-1">
                          <button onClick={handleSave} disabled={loading || !form.id.trim() || !form.display_name.trim() || !form.binary_path.trim()}
                            className="value-chip-active text-[10px] font-mono px-3 py-1 rounded-sm disabled:opacity-40 disabled:cursor-not-allowed">
                            {loading ? "SAVING..." : "UPDATE"}
                          </button>
                          <button onClick={handleCancel} className="value-chip text-[10px] font-mono px-3 py-1 rounded-sm">CANCEL</button>
                        </div>
                    </div>
                  )}
                </div>
              )}

              </Fragment>
              );
            })}
          </div>
        )}

      </div>

      {/* Footer */}
      <div className="px-4 py-2.5 config-section-bar flex items-center justify-between">
        <span className="text-[9px] font-mono config-muted">
          {providers.length} provider{providers.length !== 1 ? "s" : ""} registered
        </span>
      </div>

      {/* Restore Confirmation Modal */}
      {restoreConfirm && (
        <RestoreConfirmModal
          providerId={restoreConfirm.providerId}
          env={restoreConfirm.env}
          onConfirm={handleRestore}
          onCancel={() => setRestoreConfirm(null)}
        />
      )}
    </div>
  );
}

// Shared form fields for both add and edit forms
interface ProviderFormFieldsProps {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  handleBrowse: () => void;
  isFactoryProvided?: boolean;
}

function ProviderFormFields({ form, setForm, handleBrowse, isFactoryProvided }: ProviderFormFieldsProps) {
  return (
    <>
      {/* Binary path */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Binary Path</label>
        {isFactoryProvided ? (
          <>
            <input type="text" value={form.binary_path} disabled
              className="config-input flex-1 text-[11px] font-mono px-1 py-0.5 cursor-not-allowed opacity-60" />
            <span className="value-chip text-[8px] font-mono px-1.5 py-0.5 rounded-sm shrink-0">MANAGED</span>
          </>
        ) : (
          <>
            <input type="text" value={form.binary_path} onChange={(e) => setForm((prev) => ({ ...prev, binary_path: e.target.value }))}
              className="config-input flex-1 text-[11px] font-mono px-1 py-0.5" />
            <button onClick={handleBrowse} className="value-chip text-[9px] font-mono px-2 py-0.5 rounded-sm shrink-0">BROWSE</button>
          </>
        )}
      </div>
      {/* Enabled toggle */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Active</label>
        <button
          type="button"
          onClick={() => setForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
          className={`value-chip text-[8px] font-mono px-2 py-0.5 rounded-sm ${form.enabled ? "value-chip-active" : ""}`}
        >
          {form.enabled ? "ON" : "OFF"}
        </button>
      </div>
      {/* Git URL */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Git URL</label>
        <input type="text" placeholder="https://github.com/ggml-org/llama.cpp" value={form.git_url}
          onChange={(e) => setForm((prev) => ({ ...prev, git_url: e.target.value }))}
          className="config-input flex-1 text-[11px] font-mono px-1 py-0.5" />
      </div>
      {/* Branch */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider">Branch</label>
        <input type="text" placeholder="master, main, dev" value={form.branch}
          onChange={(e) => setForm((prev) => ({ ...prev, branch: e.target.value }))}
          className="config-input flex-1 text-[11px] font-mono px-1 py-0.5" />
      </div>
      {/* Build Profile (CMake flags) */}
      <div className="flex items-start gap-2">
        <label className="text-[10px] font-mono config-muted w-24 flex-shrink-0 uppercase tracking-wider mt-1">Build Profile</label>
        <textarea rows={3} placeholder="-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=&quot;120a&quot;"
          value={form.build_profile} onChange={(e) => setForm((prev) => ({ ...prev, build_profile: e.target.value }))}
          className="config-textarea flex-1 border rounded-sm px-2 py-1 font-mono text-[9px] resize-y" />
      </div>
    </>
  );
}
