import { motion, AnimatePresence } from "framer-motion";
import { useState, useCallback, useMemo, useEffect, type Dispatch, type SetStateAction } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry, EngineConfig, GpuInfo, ProviderConfig, SystemInfo, ModelMetadata, StackEntry } from "../lib/types";
// SANITY-BOX — added SanityEntry import + SanityBadge/SanityPanel components
import type { SanityEntry } from "../lib/types";
import EngineConfigPanel from "./EngineConfigPanel";
import { SanityBadge, SanityPanel } from "./SanityBox";

import { useKeyboardNav } from "../hooks/useKeyboardNav";

interface ModelCatalogProps {
  models: ModelEntry[];
  gpus: GpuInfo[];
  onLaunch: (config: EngineConfig) => void;
  error: string | null;
  onReload: () => void;
  providers?: ProviderConfig[];
  committedVramMib: number;
  isAdminUnlocked: boolean;
  systemInfo?: SystemInfo | null;
  scanningPath: string | null;
  setScanningPath: (p: string | null) => void;
  batchScanState: {active: boolean; scanned: number; failed: number; total: number};
  setBatchScanState: React.Dispatch<React.SetStateAction<{active: boolean; scanned: number; failed: number; total: number}>>;
  stack: StackEntry[];
  // SANITY-BOX — sanity log entries from App.tsx
  sanityLog?: SanityEntry[];
}

const LAST_MODEL_KEY = "BlackOps-last-model";
const SORT_FIELD_KEY = "BlackOps-sort-field";
const SORT_DIR_KEY = "BlackOps-sort-dir";

type SortField = (keyof ModelEntry) | "date";
type SortDirection = "asc" | "desc";

export default function ModelCatalog(props: ModelCatalogProps) {
  const { models, gpus, onLaunch, error, onReload, providers: externalProviders, committedVramMib, isAdminUnlocked, systemInfo, scanningPath, setScanningPath, batchScanState, setBatchScanState, stack, sanityLog } = props;
  const [search, setSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelEntry | null>(null);
  const [sortField, setSortField] = useState<SortField>(() => {
    try { return (localStorage.getItem(SORT_FIELD_KEY) as SortField) || "name"; } catch { return "name"; }
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    try { return (localStorage.getItem(SORT_DIR_KEY) as SortDirection) || "asc"; } catch { return "asc"; }
  });

  // SANITY-BOX — state for expanded panel + tab selection (persisted)
  const [sanityExpanded, setSanityExpanded] = useState(() => {
    try { return localStorage.getItem("BlackOps-sanity-expanded") === "true"; } catch { return false; }
  });
  const [sanityTab, setSanityTab] = useState<"all" | "js" | "rust" | "scenario">(() => {
    try { return (localStorage.getItem("BlackOps-sanity-tab") as "all" | "js" | "rust") || "all"; } catch { return "all"; }
  });

  // SANITY-BOX — persist state changes
  useEffect(() => {
    try { localStorage.setItem("BlackOps-sanity-expanded", String(sanityExpanded)); } catch {}
  }, [sanityExpanded]);
  useEffect(() => {
    try { localStorage.setItem("BlackOps-sanity-tab", sanityTab); } catch {}
  }, [sanityTab]);

  // Restore last selected model from localStorage once models are loaded
  useEffect(() => {
    if (models.length === 0 || selectedModel !== null) return;
    try {
      const savedPath = localStorage.getItem(LAST_MODEL_KEY);
      if (savedPath) {
        const match = models.find(m => m.path === savedPath);
        if (match) setSelectedModel(match);
      }
    } catch {}
  }, [models, selectedModel]);

  // Refresh selected model reference when models array updates (e.g. after scan reloads metadata)
  useEffect(() => {
    if (!selectedModel || models.length === 0) return;
    const fresh = models.find(m => m.path === selectedModel.path);
    if (fresh && fresh !== selectedModel) {
      setSelectedModel(fresh);
    }
  }, [models, selectedModel]);

  const handleSelect = useCallback((model: ModelEntry) => {
    setSelectedModel(model);
    try { localStorage.setItem(LAST_MODEL_KEY, model.path); } catch {}
  }, []);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection((d) => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  }, [sortField]);

  // Compute which models are currently running from stack
  const runningModelPaths = useMemo(() => {
    return new Set(
      stack
        .filter(s => s.status === "RUNNING" || s.status === "LOADING")
        .map(s => s.model_path)
    );
  }, [stack]);

  // Get most recent engine alias and port per model path
  const activeEngineByModel = useMemo(() => {
    const map = new Map<string, { alias: string; port?: number }>();
    stack
      .filter(s => s.status === "RUNNING" || s.status === "LOADING")
      .forEach(s => {
        if (!map.has(s.model_path!)) {
          map.set(s.model_path!, { alias: s.alias!, port: s.port });
        }
      });
    return map;
  }, [stack]);

  const handleScanModel = useCallback(async (model: ModelEntry) => {
    if (scanningPath) return;
    setScanningPath(model.path);
    try {
      await invoke("scan_model_metadata_cmd", { modelPath: model.path, providerId: null });
      onReload();
    } catch (e) {
      console.error("Scan failed:", e);
    } finally {
      setScanningPath(null);
    }
  }, [scanningPath, onReload]);

  const handleScanAll = useCallback(async () => {
    setBatchScanState({ active: true, scanned: 0, failed: 0, total: models.length });
    try {
      await invoke("scan_all_models_cmd", { modelBase: null, providerId: null });
      onReload();
    } catch (e) {
      console.error("Batch scan failed:", e);
    } finally {
      setBatchScanState(s => ({ ...s, active: false }));
    }
  }, [models.length, onReload]);

  const handleCancelScan = useCallback(async () => {
    try {
      await invoke("cancel_gguf_scan_cmd");
    } catch (e) {
      console.error("Cancel scan failed:", e);
    }
  }, []);

  // Persist sort state to localStorage
  useEffect(() => {
    try { localStorage.setItem(SORT_FIELD_KEY, sortField); } catch {}
  }, [sortField]);

  useEffect(() => {
    try { localStorage.setItem(SORT_DIR_KEY, sortDirection); } catch {}
  }, [sortDirection]);

  const filtered = useMemo(() => {
    let sorted = [...models].sort((a, b) => {
      let comparison = 0;
      if (sortField === "date") {
        const aTs = (a.metadata?.file_created ?? 0);
        const bTs = (b.metadata?.file_created ?? 0);
        comparison = aTs - bTs;
      } else {
        const aVal = a[sortField];
        const bVal = b[sortField];
        if (sortField === "size_str") {
          // Parse numeric GB from size strings like "126.2GB" for proper numeric sort
          const parseGb = (s: string) => parseFloat(String(s).replace(/[^0-9.]/g, "")) || 0;
          comparison = parseGb(aVal as string) - parseGb(bVal as string);
        } else if (typeof aVal === "string" && typeof bVal === "string") {
          comparison = aVal.localeCompare(bVal);
        } else if (typeof aVal === "boolean" && typeof bVal === "boolean") {
          comparison = Number(aVal) - Number(bVal);
        } else {
          comparison = 0;
        }
      }
      return sortDirection === "asc" ? comparison : -comparison;
    });

    if (!search.trim()) return sorted;
    const words = search.toLowerCase().trim().split(/\s+/);
    return sorted.filter((m) => {
      // Combine all searchable fields into one string for cross-word matching
      const combined = `${m.name} ${m.author} ${m.quant}`.toLowerCase();
      return words.every(word => combined.includes(word));
    });
  }, [models, sortField, sortDirection, search]);

  // ── VRAM fit status per model ────────────────
  type FitStatus = { label: string; colorClass: string };

  const getFitStatus = useCallback((modelSizeMib: number): FitStatus => {
    if (gpus.length === 0) return { label: "—", colorClass: "text-stealth-muted" };
    const singleGpuVram = gpus[0].memory_total_manufactured || gpus[0].memory_total;
    const totalVramMib = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);

    if (modelSizeMib <= singleGpuVram) {
      return { label: "FITS", colorClass: "text-nv-green" };
    } else if (modelSizeMib <= totalVramMib) {
      return { label: "SPLIT", colorClass: "text-telemetry-cyan" };
    } else {
      return { label: "RAM OFFLOAD", colorClass: "text-telemetry-red" };
    }
  }, [gpus]);

  // Keyboard navigation — arrow keys navigate list, Enter selects, Ctrl+Enter launches
  const handleKeyboardSelect = useCallback((index: number) => {
    if (filtered[index]) handleSelect(filtered[index]);
  }, [filtered, handleSelect]);

  const handleLaunchFromConfig = useCallback(() => {
    window.dispatchEvent(new CustomEvent("blackops-launch-engine"));
  }, []);

  const { highlightIndex, zone } = useKeyboardNav({
    modelCount: filtered.length,
    onSelectModel: handleKeyboardSelect,
    onLaunch: handleLaunchFromConfig,
  });

  // ── Model card ────────────────
  const renderModelCard = (model: ModelEntry, idx: number) => {
    const isSelected = selectedModel?.path === model.path;
    const isHighlighted = highlightIndex === idx && zone !== "config";
    const hasMetadata = !!model.metadata;
    const isNvfp = model.quant.toLowerCase().includes("nvfp");

    // Derive size in MiB from metadata file_size_bytes, or parse size_str fallback
    const modelSizeMib = hasMetadata && model.metadata.file_size_bytes > 0
      ? Math.floor(model.metadata.file_size_bytes / (1024 * 1024))
      : Math.floor(parseFloat(model.size_str) * 1024); // size_str is in GB

    const fitStatus = getFitStatus(modelSizeMib);
    const isScanning = scanningPath === model.path;
    const isRunning = runningModelPaths.has(model.path);
    const engineInfo = activeEngineByModel.get(model.path);

    // Build params label: "27B dense" or "MOE 262B total 17 active"
    // Prefer modelTypeLabel (GGUF general.size_label, author-set) over calculated total_params_str
    let paramsLabel = "";
    if (hasMetadata) {
      const rawTotal = model.metadata.modelTypeLabel || model.metadata.total_params_str;
      const numPart = parseFloat(rawTotal.replace(/[^0-9.]/g, ""));
      // Only keep valid size suffix (B, T, M), strip everything else like "-A17B"
      const suffixMatch = rawTotal.match(/([TMB])$/i);
      const suffix = suffixMatch ? suffixMatch[1].toUpperCase() : "B";
      if (!isNaN(numPart)) {
        const rounded = Math.round(numPart);
        if (model.metadata.n_expert_used > 0) {
          // Try to parse active params from model name pattern like "A17B"
          const activeMatch = model.name.match(/A(\d+)B/i);
          const activeBillions = activeMatch ? parseInt(activeMatch[1]) : null;
          if (activeBillions) {
            paramsLabel = `MOE ${rounded}${suffix} total ${activeBillions} active`;
          } else {
            paramsLabel = `MOE ${rounded}${suffix} total ${model.metadata.n_expert_used} active`;
          }
        } else {
          paramsLabel = `${rounded}${suffix} dense`;
        }
      }
    }

    return (
      <motion.div
        key={model.path}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: Math.min(idx * 0.02, 0.4), duration: 0.3 }}
        onClick={() => handleSelect(model)}
        className={`relative cursor-pointer rounded-sm p-3 ${
          isSelected 
            ? "bg-white/10 border border-nv-green" 
            : isRunning
              ? "bg-black/40 border-2 border-amber-400 hover:bg-black/60"
              : "cyber-card hover:bg-black/40"
        }`}
      >
        {/* Gold badge — top right corner when model is running */}
        {isRunning && (
          <motion.div
            initial={{ scale: 0, rotate: -180 }}
            animate={{ scale: 1, rotate: 0 }}
            className="absolute -top-2 -right-2 z-10"
          >
            <svg width="36" height="36" viewBox="0 0 36 36">
              {/* Gold circle with black border */}
              <circle cx="18" cy="18" r="17" fill="#FBBF24" stroke="#000" strokeWidth="2"/>
              
              {/* "RUNNING" text curved along top arc */}
              <text
                x="18"
                y="12"
                textAnchor="middle"
                fill="#000"
                fontSize="4"
                fontWeight="bold"
                fontFamily="monospace"
              >
                RUNNING
              </text>
              
              {/* Checkmark in center */}
              <path 
                d="M12 18L15.5 21.5L23 14" 
                stroke="#000" 
                strokeWidth="2.5" 
                strokeLinecap="round" 
                strokeLinejoin="round"
                fill="none"
              />
            </svg>
          </motion.div>
        )}

        {/* Author + source path — top-left, tight above model name */}
        <div className="flex items-center gap-1.5 mb-1">
          <span className="text-[8px] font-mono text-stealth-muted truncate">{model.author}</span>
          {model.sourcePathLabel && (
            <span className="text-[7px] font-mono text-stealth-muted/50 bg-stealth-surface px-1 py-0.5 rounded-sm shrink-0" title={model.path}>
              📁 {model.sourcePathLabel}
            </span>
          )}
        </div>

        {/* Model name (left) + quant/size stack (right) */}
        <div className="flex items-center justify-between gap-2">
          <span className={`text-xs font-mo truncate flex-shrink min-w-0 ${isSelected ? "text-nv-green" : "text-white"}`} title={model.name}>
            {model.name}
            {model.vision && (
              <span className="text-[8px] font-mono text-telemetry-cyan ml-1 flex-shrink-0" title="Vision capable">👁</span>
            )}
          </span>

          {/* Right-aligned: quant above size, fit status below */}
          <div className="flex flex-col items-end flex-shrink-0 gap-0.5">
            <span className={`text-[9px] font-mono px-1 py-0.5 rounded-sm ${isNvfp
              ? 'bg-nv-green/20 border border-nv-green/40 text-nv-green'
              : 'border border-telemetry-cyan/30 text-telemetry-cyan'}`}>
              {model.quant}
            </span>
            <div className="flex items-center gap-1.5">
              <span className="text-[8px] font-mono text-stealth-muted">{model.size_str}</span>
              <span className={`text-[7px] font-mono tracking-wider ${fitStatus.colorClass}`}>● {fitStatus.label}</span>
            </div>
          </div>
        </div>

        {/* Params label below model name (left-aligned) */}
        {paramsLabel && (
          <div className="text-[8px] font-mono text-white mt-0.5">{paramsLabel}</div>
        )}

        {/* Metadata row or scan button */}
        {hasMetadata ? (
          <div className="mt-1.5 pt-1.5 border-t border-stealth-border/30 flex justify-end">
            <span className="text-[7px] font-mono text-stealth-muted" title={model.metadata.architecture}>
              {model.metadata.architecture} · KV:{model.metadata.n_ctx_train.toLocaleString()} H:{model.metadata.n_head}({model.metadata.n_head_kv})
            </span>
          </div>
        ) : (
          <div className="mt-1.5 pt-1.5 border-t border-stealth-border/30 flex justify-end">
            <button
              onClick={(e) => { e.stopPropagation(); handleScanModel(model); }}
              disabled={isScanning || scanningPath !== null}
              className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm transition-colors ${
                isScanning 
                  ? 'text-telemetry-cyan border border-telemetry-cyan/40 bg-telemetry-cyan/10'
                  : 'text-orange-400 border border-orange-400/30 hover:bg-orange-400/10 disabled:opacity-30'
              }`}
            >
              {isScanning ? '⠋ SCANNING...' : '⚠ SCAN'}
            </button>
          </div>
        )}
      </motion.div>
    );
  };

  // ── Sort bar ────────────────
  const sortLabels: Record<string, string> = {
    name: 'NAME', author: 'AUTHOR', size_str: 'SIZE', date: 'DATE'
  };

  const renderSortBar = () => (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-stealth-border/50">
      {(["name", "author", "size_str", "date"] as SortField[]).map((field) => (
        <button
          key={field}
          onClick={() => handleSort(field)}
          className={`px-2 py-0.5 text-[8px] font-mono uppercase tracking-wider transition-colors rounded-sm ${
            sortField === field
              ? "text-nv-green bg-nv-green/10"
              : "text-stealth-muted hover:text-white"
          }`}
        >
          {sortLabels[field] || field.replace("_", " ")}
          {sortField === field && <span className="ml-1">{sortDirection === "asc" ? "▲" : "▼"}</span>}
        </button>
      ))}
      <div className="flex-1" />
      {batchScanState.active && (
        <span className="text-[8px] font-mono text-telemetry-cyan mr-2">
          SCAN: {batchScanState.scanned}/{batchScanState.total}
        </span>
      )}
      {batchScanState.active ? (
        <button
          onClick={handleCancelScan}
          className="px-2 py-0.5 text-[8px] font-mono border border-telemetry-red/40 text-telemetry-red hover:bg-telemetry-red/10 transition-colors rounded-sm"
          title="Stop batch scan"
        >
          ⏹ STOP SCAN
        </button>
      ) : (
        <button
          onClick={handleScanAll}
          disabled={scanningPath !== null}
          className="px-2 py-0.5 text-[8px] font-mono border border-telemetry-cyan/30 text-telemetry-cyan hover:bg-telemetry-cyan/10 transition-colors rounded-sm disabled:opacity-30"
          title="Scan all models for metadata"
        >
          SCAN ALL
        </button>
      )}
      {/* SANITY-BOX — REFRESH moved from top bar to here */}
      <button
        onClick={onReload}
        className="px-2 py-0.5 text-[8px] font-mono border border-stealth-border text-stealth-muted hover:text-nv-green hover:border-nv-green/60 transition-colors rounded-sm"
        title="Refresh model list"
      >
        ➸ REFRESH
      </button>
    </div>
  );

  return (
    <div className="flex flex-col h-full">
      {/* Top bar */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.3 }}
        className="px-4 py-2.5 border-b border-stealth-border/50 flex items-center justify-between"
      >
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-mono text-nv-green tracking-widest glitch-text">✦ MODEL CATALOG</h2>
          <span className="text-[9px] font-mono text-stealth-muted">{filtered.length} / {models.length}</span>
          {zone === "config" && (
            <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-telemetry-cyan/40 text-telemetry-cyan bg-telemetry-cyan/10">
              CONFIG [Ctrl+Enter]
            </span>
          )}
        </div>
        {/* SANITY-BOX — inline badge in header right side */}
        <SanityBadge entries={sanityLog || []} isAdminUnlocked={isAdminUnlocked} expanded={sanityExpanded} onToggle={() => setSanityExpanded(v => !v)} />
      </motion.div>

      {/* Error banner */}
      {error && (
        <div className="px-4 py-3 border-b border-telemetry-red/30 bg-telemetry-red/5">
          <p className="text-[10px] font-mono text-telemetry-red mb-2 break-all">{error}</p>
          <button
            onClick={onReload}
            className="px-3 py-1 text-[9px] font-mono border border-telemetry-red/60 text-telemetry-red hover:bg-telemetry-red/20 transition-colors rounded-sm"
          >
            RELOAD
          </button>
        </div>
      )}

      {/* Search bar */}
      <div className="px-4 py-2 border-b border-stealth-border/50">
        <input
          type="text"
          placeholder="▶  SEARCH MODELS..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          autoFocus
          className="w-full bg-depth-black/50 border border-stealth-border text-white text-xs font-mono px-3 py-1.5 focus:outline-none focus:border-nv-green/60 placeholder:text-stealth-muted rounded-sm"
        />
      </div>

      {/* SANITY-BOX — expanded panel, full-width below search bar */}
      <AnimatePresence>
        <SanityPanel entries={sanityLog || []} isAdminUnlocked={isAdminUnlocked} expanded={sanityExpanded} tab={sanityTab} onTabChange={setSanityTab} />
      </AnimatePresence>

      {/* Split panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — model browser */}
        <div className="w-[420px] min-w-[320px] flex flex-col border-r border-stealth-border/50 cyber-panel">
          {renderSortBar()}

          <div id="model-table-container" className="flex-1 overflow-y-auto cyber-scrollbar p-3">
            {filtered.length === 0 ? (
              <div className="flex items-center justify-center h-full text-stealth-muted text-xs font-mono opacity-50">
                NO MODELS FOUND
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {filtered.map((model, idx) => renderModelCard(model, idx))}
              </div>
            )}
          </div>
        </div>

        {/* Right panel — config + diagnostics */}
        <div className="flex-1 cyber-panel overflow-hidden flex flex-col">
          <div className="flex-shrink-0">
            <EngineConfigPanel
              model={selectedModel}
              gpus={gpus}
              providers={externalProviders}
              committedVramMib={committedVramMib}
              isAdminUnlocked={isAdminUnlocked}
              systemInfo={systemInfo}
              stack={stack}
              onLaunch={onLaunch}
              isModelRunning={selectedModel ? runningModelPaths.has(selectedModel.path) : false}
              activeEngineAlias={selectedModel ? activeEngineByModel.get(selectedModel.path)?.alias : undefined}
              activeEnginePort={selectedModel ? activeEngineByModel.get(selectedModel.path)?.port : undefined}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
