import React, { useState, useCallback, useEffect, useRef, Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig, ParamDef, FitScanComplete, FitScanProgress, FitScanFull, FitDataPoint } from "../lib/types";

function formatElapsed(startTime: number): string {
  const secs = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

interface ProvidersConfigProps {
  providers: ProviderConfig[];
  onProvidersChange: (providers: ProviderConfig[]) => void;
  onNavigateToFoundry?: () => void;
}

interface FormState {
  id: string;
  display_name: string;
  binary_path: string;
  enabled: boolean;
  params: Record<string, string>;
  param_definitions?: ParamDef[];
  _original_id?: string;
  git_url: string;
  branch: string;
  build_profile: string;
  template_type: string;
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
  scanStartTime?: number; // epoch ms when scan started
}

export default function ProvidersConfig({ providers: initialProviders, onProvidersChange, onNavigateToFoundry }: ProvidersConfigProps) {
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

  const detectTemplateType = useCallback((id: string) => {
    const lower = id.toLowerCase();
    if (lower.includes("ik")) return "ik-llama";
    return "ggml-llama";
  }, []);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedProviderId, setSelectedProviderId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Param editing state for the form (legacy — kept for backward compat)
  const [newParamKey, setNewParamKey] = useState("");
  const [newParamValue, setNewParamValue] = useState("");

  // Per-provider scan states
  const [scanStates, setScanStates] = useState<Record<string, ProviderScanState>>({});

  // Ref to always have the latest parallel setting available during async operations
  const parallelRef = useRef<Record<string, number>>({});
  // FIT scan state per provider

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

  // Load once on mount — fixed: useEffect instead of useState
  useEffect(() => { loadProviders(); }, [loadProviders]);

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
      console.log("File dialog failed:", err);
    }
  }, []);

  const handleSave = useCallback(async () => {
    if (!form.id.trim() || !form.display_name.trim()) {
      setError("Type ID and Name are required.");
      return;
    }

    // binary_path is required (Foundry config managed in FOUNDRY tab)
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
        param_definitions: form.param_definitions || [],
        _original_id: form._original_id || undefined,
        git_url: form.git_url || "",
        branch: form.branch || "",
        build_profile: form.build_profile || "",
        template_type: form.template_type || "ggml-llama",
      };

      await invoke("save_provider", { provider });
      await loadProviders();

      setForm({ id: "", display_name: "", binary_path: "", enabled: true, params: {}, git_url: "", branch: "", build_profile: "", template_type: "ggml-llama" });
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
      param_definitions: p.param_definitions || [],
      _original_id: p.id,
      git_url: p.git_url || "",
      branch: p.branch || "",
      build_profile: p.build_profile || "",
      template_type: p.template_type || "ggml-llama",
    });
    setEditingId(p.id);
    setShowAddForm(true);
  }, []);

  const handleCancel = useCallback(() => {
    setForm({ id: "", display_name: "", binary_path: "", enabled: true, params: {}, git_url: "", branch: "", build_profile: "", template_type: "ggml-llama" });
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

  const addParam = () => {
    if (!newParamKey.trim() || !newParamValue.trim()) return;
    setForm((prev) => ({
      ...prev,
      params: { ...prev.params, [newParamKey.trim()]: newParamValue.trim() },
    }));
    setNewParamKey("");
    setNewParamValue("");
  };

  const removeParam = (key: string) => {
    setForm((prev) => {
      const next = { ...prev.params };
      delete next[key];
      return { ...prev, params: next };
    });
  };

  const updateParamValue = (key: string, value: string) => {
    setForm((prev) => ({
      ...prev,
      params: { ...prev.params, [key]: value },
    }));
  };

  // Start library scan for a provider — uses parallelRef to always get latest setting
  const handleScanLibrary = useCallback(async (providerId: string) => {
    const currentParallel = parallelRef.current[providerId] ?? 2;

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
          results: oldState?.results ? { ...oldState.results, results: {} } : undefined, // Preserve scan_points_total for live progress display
          scanStartTime: Date.now(),
        },
      };
    });

    try {
      // Get provider config to find batch/ubatch defaults
      const allProviders = await invoke<ProviderConfig[]>("list_providers");
      const provider = allProviders.find(p => p.id === providerId);
      const batch = (provider?.params as any)?.batch || 2048;
      const ubatch = (provider?.params as any)?.ubatch || (provider?.params as any)?.ubatch_size || 512;

      // Backend resolves empty string to first configured path automatically
      const result = await invoke<FitScanComplete>("fit_scan_library", {
        providerId,
        modelBase: "",
        parallelCount: Math.max(currentParallel, 1),
        batch,
        ubatch,
        forceRescan: false, // Incremental — only scans missing points per model
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

  // Stop a running scan — signals cancellation on backend and resets UI state
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

  // Listen for real-time progress events from backend — tracks model count + point counts during scan
  const listenerGuardRef = useRef(false);
  useEffect(() => {
    if (listenerGuardRef.current) return; // Prevent HMR stacking duplicate listeners
    listenerGuardRef.current = true;

    let unsub: (() => void) | null = null;
    const init = async () => {
      const { listen } = await import("@tauri-apps/api/event");
      unsub = await listen<FitScanProgress>("fit-scan-progress", (e) => {
        try {
          const evt: FitScanProgress = e.payload;
          if (!evt || !evt.model_path) return;

          setScanStates((prev) => {
            const hasActiveScan = Object.values(prev).some(s => s.status === "scanning");
            if (!hasActiveScan) return prev;

            for (const [pid, ps] of Object.entries(prev)) {
              if (ps.status !== "scanning") continue;

               const existingResults = ps.results?.results ?? {};
               const prevEntry: FitScanFull | undefined = existingResults[evt.model_path];

                // On "complete" events with label + vram_mib, store the actual point data so VRAM columns update live during scan
                let newPoints = prevEntry ? (prevEntry.points as any[]).filter(Boolean) : [];
                 if (evt.status === "complete" && evt.vram_mib != null && evt.label) {
                   const pt: FitDataPoint = {
                     label: evt.label, ctx: 0, kv_quant: "", batch: 0, parallel: 0, split_mode: "",
                     vram_mib: evt.vram_mib,
                   };
                  // Replace existing point with same label if present (from old cache), otherwise append
                  const existingIdx = newPoints.findIndex((p: FitDataPoint) => p.label === evt.label);
                  if (existingIdx >= 0) {
                    newPoints[existingIdx] = pt;
                   } else if (newPoints.length < (ps.results?.scan_points_total ?? 999)) {
                    newPoints.push(pt);
                  }
                }

               // Create new entry — during scan this has live point data, after completion it gets replaced by full result
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

  // Render scan progress/results for a provider
  const renderScanProgress = (providerId: string) => {
    const state = scanStates[providerId];

    // Idle state — nothing below card; parallel selector lives in the card row itself
    if (!state || state.status === "idle") {
      return null;
    }

    return (
      <div className="mt-2 p-2 border border-stealth-border/50 bg-stealth-panel rounded-sm w-full">
        {/* Header row */}
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[9px] font-mono tracking-wider" style={{
            color: state.status === "scanning" ? "#22d3ee" :
                   state.status === "complete" ? "#4ade80" :
                   state.status === "error" ? "#f87171" : "#9ca3af"
          }}>
            {state.status === "scanning" ? "\u25CF SCANNING..." : 
             state.status === "complete" ? "\uD83C\uDF6C COMPLETE" :
             state.status === "error" ? "\u2716 ERROR" : ""}
          </span>
          <div className="flex items-center gap-2">
            {state.status === "scanning" && (
              <button
                onClick={() => handleStopScan(providerId)}
                className="px-2 py-0.5 text-[9px] font-mono border border-red-400/60 text-red-400 hover:bg-red-500/20 transition-colors"
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
                className={`h-full transition-all duration-300 ${
                  state.status === "error" ? "bg-red-400" : "bg-nv-green"
                }`}
                style={{ width: `${state.status === "scanning" && state.results ? (Object.keys(state.results.results).length / Math.max(state.totalModels, 1)) * 100 : (state.completed / Math.max(state.totalModels, 1)) * 100}%` }}
              />
            </div>
            <p className="text-[8px] font-mono text-stealth-muted mt-0.5">
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

        {/* Results — show during scanning (progress) and after complete/error */}
        {state.results && Object.keys(state.results.results).length > 0 && (
          <div className="max-h-48 overflow-y-auto pr-1">
            {/* Column headers */}
            <div className="grid grid-cols-[20px_minmax(0,_1fr)_64px_64px_56px] items-center gap-1 text-[7px] font-mono py-0.5 text-stealth-muted/60 uppercase tracking-wider border-b border-stealth-border/30 mb-0.5">
              <span></span><span>Model</span>
              <span>Base(8K)</span>
              <span>128K/q4</span>
              <span>Points</span>
            </div>
            {Object.entries(state.results.results).map(([path, entry]) => {
               let modelName = path.split("\\").pop()?.replace(".gguf", "") || path;
               modelName = modelName.replace(/-\d{3,}-of-\d{3,}$/i, "");
              const full: FitScanFull = entry as any;
              const pts = full.points ?? [];
              const nPts = pts.length;

               // Only show VRAM columns when we have labeled data (post-completion or mid-scan with real labels)
               const basePt = pts.find((p: FitDataPoint) => p?.label === "base");
               const q4Pt = pts.find((p: FitDataPoint) => p?.label === "quant_q4");
                const pointsTotal = state.results!.scan_points_total ?? 999;
                const isComplete = nPts >= pointsTotal;

              return (
                <div key={path} className="grid grid-cols-[20px_minmax(0,_1fr)_64px_64px_56px] items-center gap-1 text-[8px] font-mono py-0.5">
                  <span className={`${isComplete ? "text-nv-green" : nPts > 0 ? "text-telemetry-cyan" : full.error ? "text-red-400" : "text-yellow-400"}`}>
                    {isComplete ? "\u2713" : nPts > 0 ? "\u25CF" : full.error ? "\u2716" : "!"}
                  </span>
                  <span className="text-stealth-muted truncate" title={path}>
                    {modelName}
                  </span>
                  {basePt && basePt.vram_mib > 0 ? <span className="text-telemetry-cyan">{(basePt.vram_mib / 1024).toFixed(1)}G</span> : <span></span>}
                  {q4Pt && q4Pt.vram_mib > 0 ? <span className="text-telemetry-cyan">{(q4Pt.vram_mib / 1024).toFixed(1)}G</span> : <span></span>}
                    <span className={`${isComplete ? "text-nv-green" : "text-stealth-muted"}`}>{nPts}/{pointsTotal}</span>
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
              className="px-2 py-0.5 text-[8px] font-mono border border-nv-green/60 text-nv-green hover:bg-nv-green/20 transition-colors"
            >
              {"RESCAN"}
            </button>
          )}
          <button
            onClick={() => handleStopScan(providerId)}
            className="px-2 py-0.5 text-[8px] font-mono border border-stealth-border text-stealth-muted hover:text-white transition-colors"
          >
            CLEAR
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Toolbar header — matches ConfigPage layout */}
      <div className="px-4 py-3 border-b border-stealth-border flex items-center justify-between flex-wrap gap-2 relative">
        <div>
          <div className="flex items-center gap-2">
            <h2 className="text-xs font-mono text-nv-green tracking-wider">BACKEND PROVIDERS</h2>
            <span className="text-[10px] text-stealth-border/60">|</span>
            <span className="text-[9px] font-mono text-stealth-muted">{providers.length} REGISTERED</span>
          </div>
          <div className="h-4"></div>
        </div>
      </div>

      {/* Error display */}
      {error && (
        <div className="mx-4 mt-3 p-2 border border-red-500/30 bg-red-500/5 rounded-sm">
          <p className="text-[10px] font-mono text-red-400 break-all">{error}</p>
        </div>
      )}

      {/* Provider list */}
      <div className="flex-1 overflow-y-auto p-4 min-h-0">
        {/* Add new provider button */}
        <button onClick={() => { setEditingId(null); setShowAddForm(!showAddForm); }}
          className={`flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider transition-colors ${showAddForm && !editingId ? "text-yellow-400" : "text-yellow-400/60 hover:text-yellow-400"}`}>
          <span className="text-[8px]">{showAddForm && !editingId ? "\u25BC" : "\u25B6"}</span>
          ADD NEW PROVIDER
        </button>

        {showAddForm && !editingId && (
          <div className="space-y-2 mt-1 mb-3 px-4">
            {/* ID field */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Type ID</label>
              <input type="text" placeholder="e.g. stable, nightly, my-ik-fork" value={form.id}
                onChange={(e) => setForm((prev) => ({ ...prev, id: e.target.value, template_type: detectTemplateType(e.target.value) }))}
                className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white placeholder:text-yellow-400/30 focus:border-yellow-400 focus:outline-none px-1 py-0.5" />
            </div>
            {/* Template Type selector */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Template</label>
              <select value={form.template_type} onChange={(e) => setForm((prev) => ({ ...prev, template_type: e.target.value }))}
                className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white focus:border-yellow-400 focus:outline-none px-1 py-0.5 appearance-none">
                <option value="ggml-llama">GGML-Llama (22 params)</option>
                <option value="ik-llama">IK-Llama (8 params)</option>
                <option value="">Custom (manual)</option>
              </select>
            </div>
            {/* Display name */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Name</label>
              <input type="text" placeholder="e.g. llama.cpp Stable" value={form.display_name}
                onChange={(e) => setForm((prev) => ({ ...prev, display_name: e.target.value }))}
                className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white placeholder:text-yellow-400/30 focus:border-yellow-400 focus:outline-none px-1 py-0.5" />
            </div>
            <ProviderFormFields form={form} setForm={setForm} handleBrowse={handleBrowse} />
            {/* Action buttons */}
            <div className="flex gap-2 pt-1">
              <button onClick={handleSave} disabled={loading || !form.id.trim() || !form.display_name.trim() || !form.binary_path.trim()}
                className="px-3 py-1 text-[10px] font-mono border border-nv-green/60 text-nv-green hover:bg-nv-green/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
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
            {/* Sort bar — matches ModelCatalog style */}
            <div className="flex items-center gap-1 px-3 py-2 border-b border-stealth-border/50">
              <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider w-6">#</span>
              <div className="w-7" />
              <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider flex-1">Provider</span>
              {selectedProviderId && (() => {
                const si = providers.findIndex(p => p.id === selectedProviderId);
                return (
                  <div className="flex items-center gap-2.5 flex-shrink-0">
                    <button onClick={() => handleReorder(selectedProviderId, -1)} disabled={si <= 0}
                      className="text-[9px] font-mono text-stealth-muted hover:text-nv-green transition-colors disabled:opacity-20 disabled:cursor-not-allowed" title="Move up">
                      ▲
                    </button>
                    <button onClick={() => handleReorder(selectedProviderId, 1)} disabled={si >= providers.length - 1}
                      className="text-[9px] font-mono text-stealth-muted hover:text-nv-green transition-colors disabled:opacity-20 disabled:cursor-not-allowed" title="Move down">
                      ▼
                    </button>
                    <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Actions</span>
                  </div>
                );
              })()}
              {!selectedProviderId && (
                <span className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Actions</span>
              )}
            </div>

            {providers.map((p, idx) => {
              const isSelected = selectedProviderId === p.id;
              return (
              <Fragment key={p.id}>
              <div
                onClick={() => setSelectedProviderId(isSelected ? null : p.id)}
                className={`flex gap-4 p-4 rounded border transition-all cursor-pointer ${
                  editingId === p.id
                    ? "border-yellow-400/60 bg-yellow-400/5"
                    : isSelected
                      ? "border-nv-green/60 bg-nv-green/5"
                      : p.enabled
                        ? "border-stealth-border hover:border-stealth-muted"
                        : "border-stealth-border/30 opacity-40"
                }`}>
                {/* ── Position number ─────────── */}
                <div className="flex items-center flex-shrink-0" style={{ minWidth: "16px" }}>
                  <span className={`text-[9px] font-mono ${isSelected ? "text-nv-green" : "text-stealth-muted"}`}>{idx + 1}</span>
                </div>

                {/* ── Foundry badge (removed — button in actions instead) ─────────── */}

                {/* ── Table columns ─────────────────────────────────────── */}
                <div className="flex items-center gap-6 flex-1 min-w-0">
                  {/* ID + name column */}
                  <div className="flex items-center gap-2.5 flex-shrink-0">
                    <button onClick={(e) => { e.stopPropagation(); handleToggleEnabled(p.id); }}
                      className={`text-[10px] select-none transition-colors ${
                        p.enabled ? "text-nv-green hover:text-nv-green/80" : "text-stealth-muted/30"
                      }`}
                      title={p.enabled ? "Disable provider" : "Enable provider"}>
                      {p.enabled ? "\u25CF" : "\u25EF"}
                    </button>
                    <span className="text-[10px] font-mono text-yellow-400">
                      {p.id}
                    </span>
                    <span className={`text-[10px] font-mono truncate max-w-[180px] ${isSelected ? "text-nv-green" : "text-white"}`} title={p.display_name}>
                      {p.display_name}
                    </span>
                  </div>

                  {/* Params badge */}
                  {p.param_definitions && p.param_definitions.length > 0 && (
                    <span className="text-[9px] font-mono text-telemetry-cyan px-2 py-0.5 border border-telemetry-cyan/30 rounded-sm flex-shrink-0">
                      {p.param_definitions.length} params
                    </span>
                  )}

                  {/* Spacer */}
                  <div className="flex-1 min-w-4" />

                  {/* Actions group */}
                  <div className="flex items-center gap-2.5 flex-shrink-0">
                    {p.git_url && onNavigateToFoundry && (
                      <button onClick={(e) => { e.stopPropagation(); onNavigateToFoundry(); }}
                        className="px-2 py-0.5 text-[9px] font-mono bg-orange-500 text-black hover:bg-orange-400 transition-colors flex-shrink-0">
                        FOUNDRY
                      </button>
                    )}
                      <button onClick={(e) => { e.stopPropagation(); handleEdit(p); }}
                       className="px-2 py-0.5 text-[9px] font-mono border border-yellow-400/40 text-yellow-400 hover:bg-yellow-500/20 transition-colors">
                       EDIT
                     </button>
                    <button onClick={(e) => { e.stopPropagation(); handleDelete(p.id); }}
                      className="px-2 py-0.5 text-[9px] font-mono border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-colors">
                      REMOVE
                    </button>

                    {/* SCAN LIBRARY + parallel */}
                    <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-stealth-border/30">
                      {[4, 8, 16].map(n => (
                        <button
                          key={n}
                          onClick={(e) => {
                            e.stopPropagation();
                            setScanStates(prev => ({ ...prev, [p.id]: { status: "idle" as const, parallel: n, totalModels: 0, completed: 0, failed: 0 } }));
                            parallelRef.current[p.id] = n;
                          }}
                          className={`px-1.5 py-0.5 text-[9px] font-mono border transition-colors ${
                            (scanStates[p.id]?.parallel ?? 2) === n
                              ? "bg-nv-green/20 text-nv-green border-nv-green/60"
                              : "text-stealth-muted border-stealth-border hover:text-white"
                          }`}
                        >
                          {n}x
                        </button>
                      ))}
                      <button
                        onClick={(e) => { e.stopPropagation(); handleScanLibrary(p.id); }}
                        disabled={scanStates[p.id]?.status === "scanning"}
                        className="px-2 py-0.5 text-[9px] font-mono border border-telemetry-cyan/60 text-telemetry-cyan hover:bg-telemetry-cyan/10 transition-colors"
                      >
                        {scanStates[p.id]?.status === "scanning" ? "\u25CF SCANNING..." : "SCAN LIBRARY"}
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Scan progress / parallel selector — full-width below provider card */}
              <div className="w-full">
                {renderScanProgress(p.id)}
              </div>

              {/* Inline edit form — appears directly below the edited provider */}
              {editingId === p.id && (
                <div className="mt-2 border border-yellow-400/40 bg-[#1a1a2e] rounded p-3 space-y-2">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] font-mono text-yellow-400">{p.id} — EDIT PROVIDER</span>
                    <button onClick={handleCancel} className="text-stealth-muted hover:text-white transition-colors leading-none">✕</button>
                  </div>
                  {/* ID field */}
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Type ID</label>
                    <input type="text" value={form.id} onChange={(e) => setForm((prev) => ({ ...prev, id: e.target.value }))}
                      className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white focus:border-yellow-400 focus:outline-none px-1 py-0.5" />
                  </div>
                  {/* Template Type selector */}
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Template</label>
                    <select value={form.template_type} onChange={(e) => setForm((prev) => ({ ...prev, template_type: e.target.value }))}
                      className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white focus:border-yellow-400 focus:outline-none px-1 py-0.5">
                      <option value="ggml-llama" style={{fontSize: '11px'}}>GGML-Llama (22 params)</option>
                      <option value="ik-llama" style={{fontSize: '11px'}}>IK-Llama (8 params)</option>
                      <option value="" style={{fontSize: '11px'}}>Custom (manual)</option>
                    </select>
                  </div>
                  {/* Display name */}
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Name</label>
                    <input type="text" value={form.display_name} onChange={(e) => setForm((prev) => ({ ...prev, display_name: e.target.value }))}
                      className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white focus:border-yellow-400 focus:outline-none px-1 py-0.5" />
                  </div>
                  <ProviderFormFields form={form} setForm={setForm} handleBrowse={handleBrowse} />
                  {/* Action buttons */}
                  <div className="flex gap-2 pt-1">
                    <button onClick={handleSave} disabled={loading || !form.id.trim() || !form.display_name.trim() || !form.binary_path.trim()}
                      className="px-3 py-1 text-[10px] font-mono border border-nv-green/60 text-nv-green hover:bg-nv-green/20 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                      {loading ? "SAVING..." : "UPDATE"}
                    </button>
                    <button onClick={handleCancel} className="px-3 py-1 text-[10px] font-mono border border-stealth-border text-stealth-muted hover:text-white transition-colors">CANCEL</button>
                  </div>
                </div>
              )}
              </Fragment>
              );
            })}
          </div>
        )}

      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-stealth-border flex items-center justify-between">
        <span className="text-[9px] font-mono text-stealth-muted">
          {providers.length} provider{providers.length !== 1 ? "s" : ""} registered
        </span>
      </div>

    </div>
  );
}

// Shared form fields for both add and edit forms
interface ProviderFormFieldsProps {
  form: FormState;
  setForm: React.Dispatch<React.SetStateAction<FormState>>;
  handleBrowse: () => void;
}

function ProviderFormFields({ form, setForm, handleBrowse }: ProviderFormFieldsProps) {
  return (
    <>
      {/* Binary path */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Binary Path</label>
        <input type="text" value={form.binary_path} onChange={(e) => setForm((prev) => ({ ...prev, binary_path: e.target.value }))}
          className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white focus:border-yellow-400 focus:outline-none px-1 py-0.5" />
        <button onClick={handleBrowse} className="px-2 py-0.5 text-[9px] font-mono border border-stealth-border text-stealth-muted hover:text-nv-green transition-colors flex-shrink-0">BROWSE</button>
      </div>
      {/* Enabled toggle */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Active</label>
        <button onClick={() => setForm((prev) => ({ ...prev, enabled: !prev.enabled }))}
          className={`w-8 h-4 rounded-full transition-colors relative ${form.enabled ? "bg-nv-green/60" : "bg-stealth-border"}`}>
          <span className={`absolute top-0.5 w-3 h-3 bg-white rounded-full transition-transform ${form.enabled ? "left-4.5 translate-x-0.5" : "left-0.5"}`} />
        </button>
      </div>
      {/* Git URL */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Git URL</label>
        <input type="text" placeholder="https://github.com/ggml-org/llama.cpp" value={form.git_url}
          onChange={(e) => setForm((prev) => ({ ...prev, git_url: e.target.value }))}
          className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white placeholder:text-yellow-400/30 focus:border-yellow-400 focus:outline-none px-1 py-0.5" />
      </div>
      {/* Branch */}
      <div className="flex items-center gap-2">
        <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Branch</label>
        <input type="text" placeholder="master, main, dev" value={form.branch}
          onChange={(e) => setForm((prev) => ({ ...prev, branch: e.target.value }))}
          className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white placeholder:text-yellow-400/30 focus:border-yellow-400 focus:outline-none px-1 py-0.5" />
      </div>
      {/* Build Profile (CMake flags) */}
      <div className="flex items-start gap-2">
        <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider mt-1">Build Profile</label>
        <textarea rows={3} placeholder="-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=&quot;120a&quot;"
          value={form.build_profile} onChange={(e) => setForm((prev) => ({ ...prev, build_profile: e.target.value }))}
          className="flex-1 bg-transparent border border-yellow-400/30 text-white placeholder:text-yellow-400/30 focus:border-yellow-400 focus:outline-none px-2 py-1 font-mono text-[9px] resize-y" />
      </div>
    </>
  );
}

// NOTE: Foundry build UI moved to top-level FOUNDRY tab (FoundryPage.tsx)


