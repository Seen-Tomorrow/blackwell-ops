import { useState, useCallback, useEffect, useRef, Fragment } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProviderConfig, ParamDef, FitScanComplete, FitScanProgress, FitScanFull, BuildInfo } from "../lib/types";
import FoundryModal from "./FoundryModal";

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

  const detectTemplateType = useCallback((id: string) => {
    const lower = id.toLowerCase();
    if (lower.includes("ik")) return "ik-llama";
    return "ggml-llama";
  }, []);
  const [showAddForm, setShowAddForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Param editing state for the form (legacy — kept for backward compat)
  const [newParamKey, setNewParamKey] = useState("");
  const [newParamValue, setNewParamValue] = useState("");

  // Per-provider scan states
  const [scanStates, setScanStates] = useState<Record<string, ProviderScanState>>({});

  // Ref to always have the latest parallel setting available during async operations
  const parallelRef = useRef<Record<string, number>>({});

  // Reactor Foundry modal state
  const [foundryModal, setFoundryModal] = useState<{ provider: ProviderConfig; environment: "vanguard" | "stable" | "fresh" } | null>(null);

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

    // binary_path is optional for Foundry providers (git_url + branch set)
    if (!form.binary_path.trim() && !(form.git_url.trim() && form.branch.trim())) {
      setError("Binary path is required, or set Git URL and Branch for a Foundry provider.");
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

    setScanStates((prev) => ({
      ...prev,
      [providerId]: {
        status: "scanning",
        parallel: currentParallel,
        totalModels: 0,
        completed: 0,
        failed: 0,
        results: undefined, // Clear old in-memory points so progress starts fresh
      },
    }));

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
        flashAttn: true,
        forceRescan: true, // Always clear stale cache before scanning
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

              // Track point count — only increment on "complete" status events, cap at 21
              let pointCount = prevEntry ? (prevEntry.points.length || 0) : 0;
              if (evt.status === "complete" && pointCount < 21) {
                pointCount++;
              }

              // Create new entry object to ensure React detects state change
              const entry: FitScanFull = prevEntry
                ? { ...prevEntry, points: new Array(pointCount) }
                : { model_path: evt.model_path, points: [], error: undefined };

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
              {state.status === "scanning" ? `${Object.keys(state.results?.results ?? {}).length} models...` : `${state.completed} / ${state.totalModels}`}{state.failed > 0 && state.status !== "scanning" ? ` (${state.failed} failed)` : ""}
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

               // Find base (8K/q4_0) and 128K/q4_0 points — filter undefined slots from progress tracking
               const realPts = pts.filter(Boolean);
               const basePt = realPts.find(p => p.label === "base");
               const q4Pt = realPts.find(p => p.label === "quant_q4");
              const isComplete = nPts >= 21;

              return (
                <div key={path} className="grid grid-cols-[20px_minmax(0,_1fr)_64px_64px_56px] items-center gap-1 text-[8px] font-mono py-0.5">
                  <span className={`${isComplete ? "text-nv-green" : nPts > 0 ? "text-telemetry-cyan" : full.error ? "text-red-400" : "text-yellow-400"}`}>
                    {isComplete ? "\u2713" : nPts > 0 ? "\u25CF" : full.error ? "\u2716" : "!"}
                  </span>
                  <span className="text-stealth-muted truncate" title={path}>
                    {modelName}
                  </span>
                  {basePt ? <span className="text-telemetry-cyan">{(basePt.vram_mib / 1024).toFixed(1)}G</span> : <span></span>}
                  {q4Pt ? <span className="text-telemetry-cyan">{(q4Pt.vram_mib / 1024).toFixed(1)}G</span> : <span></span>}
                  <span className={`${isComplete ? "text-nv-green" : "text-stealth-muted"}`}>{nPts}/21</span>
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
                <option value="ggml-llama">GGML-Llama (19 params)</option>
                <option value="ik-llama">IK-Llama (7 params)</option>
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
            {/* Binary path */}
            <div className="flex items-center gap-2">
              <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Binary Path</label>
              <input type="text" placeholder="C:\path\to\llama-server.exe" value={form.binary_path}
                onChange={(e) => setForm((prev) => ({ ...prev, binary_path: e.target.value }))}
                className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white placeholder:text-yellow-400/30 focus:border-yellow-400 focus:outline-none px-1 py-0.5" />
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
            {/* Reactor Foundry fields */}
            <div className="pt-2 border-t border-stealth-border/50">
              <h4 className="text-[9px] font-mono text-cyan-400 uppercase tracking-wider mb-1.5">Reactor Foundry Build Config</h4>
              <div className="flex items-start gap-2 mb-2">
                <label className="text-[9px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider mt-1">Git URL</label>
                <input type="text" placeholder="https://github.com/ggml-org/llama.cpp" value={form.git_url}
                  onChange={(e) => setForm((prev) => ({ ...prev, git_url: e.target.value }))}
                  className="flex-1 bg-transparent border-b border-cyan-400/60 text-[11px] font-mono text-white placeholder:text-cyan-400/30 focus:border-cyan-400 focus:outline-none px-1 py-0.5" />
              </div>
              <div className="flex items-center gap-2 mb-2">
                <label className="text-[9px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Branch</label>
                <input type="text" placeholder="master, dev, main" value={form.branch}
                  onChange={(e) => setForm((prev) => ({ ...prev, branch: e.target.value }))}
                  className="flex-1 bg-transparent border-b border-cyan-400/60 text-[11px] font-mono text-white placeholder:text-cyan-400/30 focus:border-cyan-400 focus:outline-none px-1 py-0.5" />
              </div>
              <div className="flex items-start gap-2">
                <label className="text-[9px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider mt-1">CMake Flags</label>
                <textarea rows={3} placeholder={form.template_type === "ik-llama" ? "[IK-LLAMA defaults applied]\n-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=\"120a\" ..." : "[GGML defaults applied]\n-DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=\"120a\" -DGGML_AVX512=ON ..."}
                  value={form.build_profile} onChange={(e) => setForm((prev) => ({ ...prev, build_profile: e.target.value }))}
                  className="flex-1 bg-transparent border border-cyan-400/30 text-white placeholder:text-cyan-400/30 focus:border-cyan-400 focus:outline-none px-2 py-1 font-mono text-[9px] resize-y" />
              </div>
            </div>
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
          <div className="space-y-2 mb-6">
            {providers.map((p) => (
              <Fragment key={p.id}>
              <div
                className={`flex gap-4 p-4 rounded border transition-all ${
                  editingId === p.id
                    ? "border-yellow-400/60 bg-yellow-400/5"
                    : p.enabled
                      ? "border-stealth-border hover:border-stealth-muted"
                      : "border-stealth-border/30 opacity-40"
                }`}>
                {/* ── Foundry Block (wider, more breathing room) ─────────── */}
                <div className="flex flex-col items-center gap-2.5 px-4 py-3 flex-shrink-0 relative overflow-hidden rounded-sm" style={{
                  minWidth: "160px",
                  background: "linear-gradient(180deg, rgba(234,179,8,0.06) 0%, rgba(234,179,8,0.02) 40%, transparent 100%)",
                  border: "1px solid rgba(234,179,8,0.15)",
                }}>
                  {/* Haze/smoke overlay */}
                  <div className="absolute inset-0 pointer-events-none" style={{
                    background: "radial-gradient(ellipse at 50% 0%, rgba(251,191,36,0.08) 0%, transparent 70%)",
                  }} />

                  {/* FOUNDRY banner */}
                  <div className="relative z-10 flex items-center justify-center px-3 py-1 rounded-sm" style={{
                    background: "linear-gradient(90deg, rgba(234,179,8,0.2), rgba(249,115,22,0.15))",
                    border: "1px solid rgba(234,179,8,0.25)",
                    boxShadow: "0 0 8px rgba(234,179,8,0.1), inset 0 1px 0 rgba(251,191,36,0.1)",
                  }}>
                    <span className="text-[7px] font-mono tracking-[0.2em] text-yellow-400/80">FOUNDRY</span>
                  </div>

                  {/* Build buttons + scan */}
                  <div className="relative z-10 flex flex-col items-center gap-1.5">
                    <div className="flex gap-1.5">
                      <button onClick={() => setFoundryModal({ provider: p, environment: "vanguard" })}
                        disabled={!p.git_url || !p.branch}
                        className={`px-2.5 py-1 text-[8px] font-mono border transition-colors ${
                          !p.git_url || !p.branch
                            ? "border-stealth-border/30 text-stealth-muted/30 cursor-not-allowed"
                            : "border-cyan-400/60 text-cyan-400 hover:bg-cyan-400/20"
                        }`}>
                        VANGUARD
                      </button>
                      <button onClick={() => setFoundryModal({ provider: p, environment: "fresh" })}
                        disabled={!p.git_url || !p.branch}
                        className={`px-2.5 py-1 text-[8px] font-mono border transition-colors ${
                          !p.git_url || !p.branch
                            ? "border-stealth-border/30 text-stealth-muted/30 cursor-not-allowed"
                            : "border-amber-400/60 text-amber-400 hover:bg-amber-400/20"
                        }`}>
                        FRESH
                      </button>
                      <button onClick={() => setFoundryModal({ provider: p, environment: "stable" })}
                        disabled={!p.git_url || !p.branch}
                        className={`px-2.5 py-1 text-[8px] font-mono border transition-colors ${
                          !p.git_url || !p.branch
                            ? "border-stealth-border/30 text-stealth-muted/30 cursor-not-allowed"
                            : "border-nv-green/60 text-nv-green hover:bg-nv-green/20"
                        }`}>
                        STABLE
                      </button>
                    </div>

                  {/* Build info scan buttons + display */}
                  <BuildInfoDisplay provider={p} onScan={async (env) => {
                    if (!p.binary_path) return;
                    try {
                      const info = await invoke<BuildInfo>("get_binary_build_info", { binaryPath: p.binary_path });
                      setProviders(prev => prev.map(pr =>
                        pr.id === p.id
                          ? { ...pr, buildInfoPerEnv: { ...(pr.buildInfoPerEnv || {}), [env]: info } }
                          : pr
                      ));
                      await invoke("set_build_info_for_env", {
                        providerId: p.id,
                        envLabel: env,
                        buildInfo: info,
                      });
                    } catch (err) {
                      console.error(`Build info scan failed for ${p.id}/${env}:`, err);
                    }
                  }} />
                  </div>
                </div>

                {/* ── Table columns ─────────────────────────────────────── */}
                <div className="flex items-center gap-6 flex-1 min-w-0">
                  {/* ID + name column */}
                  <div className="flex items-center gap-2.5 flex-shrink-0">
                    <button onClick={() => handleToggleEnabled(p.id)}
                      className={`text-[10px] select-none transition-colors ${
                        p.enabled ? "text-nv-green hover:text-nv-green/80" : "text-stealth-muted/30"
                      }`}
                      title={p.enabled ? "Disable provider" : "Enable provider"}>
                      {p.enabled ? "\u25CF" : "\u25EF"}
                    </button>
                    <span className="text-[10px] font-mono text-yellow-400">
                      {p.id}
                    </span>
                    <span className="text-[10px] font-mono text-white truncate max-w-[180px]" title={p.display_name}>
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
                      <button onClick={() => handleEdit(p)}
                       className="px-2 py-0.5 text-[9px] font-mono border border-yellow-400/40 text-yellow-400 hover:bg-yellow-500/20 transition-colors">
                       EDIT
                     </button>
                    <button onClick={() => handleDelete(p.id)}
                      className="px-2 py-0.5 text-[9px] font-mono border border-red-500/30 text-red-400 hover:bg-red-500/20 transition-colors">
                      REMOVE
                    </button>

                    {/* SCAN LIBRARY + parallel */}
                    <div className="flex items-center gap-1.5 ml-2 pl-2 border-l border-stealth-border/30">
                      {[4, 8, 16].map(n => (
                        <button
                          key={n}
                          onClick={() => {
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
                        onClick={() => handleScanLibrary(p.id)}
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
                      <option value="ggml-llama" style={{fontSize: '11px'}}>GGML-Llama (19 params)</option>
                      <option value="ik-llama" style={{fontSize: '11px'}}>IK-Llama (7 params)</option>
                      <option value="" style={{fontSize: '11px'}}>Custom (manual)</option>
                    </select>
                  </div>
                  {/* Display name */}
                  <div className="flex items-center gap-2">
                    <label className="text-[10px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Name</label>
                    <input type="text" value={form.display_name} onChange={(e) => setForm((prev) => ({ ...prev, display_name: e.target.value }))}
                      className="flex-1 bg-transparent border-b border-yellow-400/60 text-[11px] font-mono text-white focus:border-yellow-400 focus:outline-none px-1 py-0.5" />
                  </div>
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
                  {/* Reactor Foundry fields */}
                  <div className="pt-2 border-t border-stealth-border/50">
                    <h4 className="text-[9px] font-mono text-cyan-400 uppercase tracking-wider mb-1.5">Reactor Foundry Build Config</h4>
                    <div className="flex items-start gap-2 mb-2">
                      <label className="text-[9px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider mt-1">Git URL</label>
                      <input type="text" value={form.git_url} onChange={(e) => setForm((prev) => ({ ...prev, git_url: e.target.value }))}
                        className="flex-1 bg-transparent border-b border-cyan-400/60 text-[11px] font-mono text-white focus:border-cyan-400 focus:outline-none px-1 py-0.5" />
                    </div>
                    <div className="flex items-center gap-2 mb-2">
                      <label className="text-[9px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider">Branch</label>
                      <input type="text" value={form.branch} onChange={(e) => setForm((prev) => ({ ...prev, branch: e.target.value }))}
                        className="flex-1 bg-transparent border-b border-cyan-400/60 text-[11px] font-mono text-white focus:border-cyan-400 focus:outline-none px-1 py-0.5" />
                    </div>
                    <div className="flex items-start gap-2">
                      <label className="text-[9px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider mt-1">CMake Flags</label>
                      <textarea rows={3} value={form.build_profile} onChange={(e) => setForm((prev) => ({ ...prev, build_profile: e.target.value }))}
                        className="flex-1 bg-transparent border border-cyan-400/30 text-white focus:border-cyan-400 focus:outline-none px-2 py-1 font-mono text-[9px] resize-y" />
                    </div>
                  </div>
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
            ))}
          </div>
        )}

      </div>

      {/* Footer */}
      <div className="px-4 py-3 border-t border-stealth-border flex items-center justify-between">
        <span className="text-[9px] font-mono text-stealth-muted">
          {providers.length} provider{providers.length !== 1 ? "s" : ""} registered
        </span>
      </div>

      {/* Reactor Foundry Build Modal */}
      {foundryModal && (
        <FoundryModal
          provider={foundryModal.provider}
          environment={foundryModal.environment}
          onClose={() => setFoundryModal(null)}
        />
      )}
    </div>
  );
}

interface BuildInfoDisplayProps {
  provider: ProviderConfig;
  onScan: (env: "vanguard" | "stable" | "fresh") => Promise<void>;
}

function BuildInfoDisplay({ provider, onScan }: BuildInfoDisplayProps) {
  const envs: Array<"vanguard" | "stable" | "fresh"> = ["vanguard", "fresh", "stable"];
  const envColors: Record<string, string> = {
    vanguard: "text-cyan-400/60",
    fresh: "text-amber-400/60",
    stable: "text-nv-green/60",
  };

  return (
    <div className="flex flex-col items-center gap-1">
      {/* SCAN buttons — one per environment */}
      <div className="flex gap-1.5">
        {envs.map(env => (
          <button
            key={env}
            onClick={() => onScan(env)}
            disabled={!provider.binary_path}
            className={`px-1 py-0 text-[7px] font-mono border transition-colors ${
              !provider.binary_path
                ? "border-stealth-border/20 text-stealth-muted/30 cursor-not-allowed"
                : "border-stealth-border/40 text-stealth-muted/50 hover:text-white hover:border-stealth-muted/60"
            }`}
          >
            SCAN
          </button>
        ))}
      </div>

      {/* Build info display with tooltip */}
      {provider.buildInfoPerEnv && Object.entries(provider.buildInfoPerEnv).map(([env, info]) => (
        <div key={env} className="relative group">
          <span className={`text-[7px] font-mono ${envColors[env] || "text-stealth-muted/50"}`}>
            {env.toUpperCase()}: v{info.version}{info.cudaVersion ? ` @ CUDA ${info.cudaVersion}` : ""} · {info.buildDate}
          </span>
          {/* Tooltip on hover */}
          <div className="hidden group-hover:block absolute top-full left-1/2 -translate-x-1/2 z-50 mt-1 px-2 py-1.5 border rounded-sm bg-stealth-panel whitespace-nowrap" style={{
            borderColor: env === "vanguard" ? "#22d3ee40" : env === "fresh" ? "#f59e0b40" : "#4ade8040",
          }}>
            <div className="text-[8px] font-mono text-white">{info.version}</div>
            {info.cudaVersion && <div className="text-[7px] font-mono text-telemetry-amber mt-0.5">CUDA {info.cudaVersion}</div>}
            <div className="text-[7px] font-mono text-stealth-muted mt-0.5">Built: {info.buildDate}</div>
          </div>
        </div>
      ))}
    </div>
  );
}

interface LastBuildDisplayProps {
  provider: ProviderConfig;
}

function LastBuildDisplay({ provider }: LastBuildDisplayProps) {
  const entries = Object.entries(provider.buildInfoPerEnv || {});
  if (entries.length === 0) return null;

  // Find the most recent build by date
  const latest = entries.sort((a, b) => b[1].buildDate.localeCompare(a[1].buildDate))[0];
  const [env, info] = latest!;

  const envColors: Record<string, string> = {
    vanguard: "text-cyan-400/70",
    fresh: "text-amber-400/70",
    stable: "text-nv-green/70",
  };

  return (
    <div className="flex items-start gap-2 pt-1">
      <label className="text-[9px] font-mono text-stealth-muted w-24 flex-shrink-0 uppercase tracking-wider mt-1">
        Last Build
      </label>
      <span className={`text-[8px] font-mono ${envColors[env] || 'text-stealth-muted/50'}`}>
        build {info.version}{info.cudaVersion ? ` @ CUDA ${info.cudaVersion}` : ""} at {info.buildDate}
      </span>
    </div>
  );
}

