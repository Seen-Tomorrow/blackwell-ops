import { motion } from "framer-motion";
import { useState, useCallback, useMemo, useEffect } from "react";
import type { ModelEntry, EngineConfig, GpuInfo, ProviderConfig } from "../lib/types";
import EngineConfigPanel from "./EngineConfigPanel";

interface ModelCatalogProps {
  models: ModelEntry[];
  gpus: GpuInfo[];
  onLaunch: (config: EngineConfig) => void;
  error: string | null;
  onReload: () => void;
  providers?: ProviderConfig[];
  committedVramMib: number;
  osOverheadMib: number;
  isAdminUnlocked: boolean;
}

const LAST_MODEL_KEY = "BlackOps-last-model";

type SortField = keyof ModelEntry;
type SortDirection = "asc" | "desc";

export default function ModelCatalog(props: ModelCatalogProps) {
  const { models, gpus, onLaunch, error, onReload, providers: externalProviders, committedVramMib, osOverheadMib, isAdminUnlocked } = props;
  const [search, setSearch] = useState("");
  const [selectedModel, setSelectedModel] = useState<ModelEntry | null>(null);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");

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

  const filtered = useMemo(() => {
    let sorted = [...models].sort((a, b) => {
      const aVal = a[sortField];
      const bVal = b[sortField];
      let comparison = 0;
      if (typeof aVal === "string" && typeof bVal === "string") {
        comparison = aVal.localeCompare(bVal);
      } else if (typeof aVal === "boolean" && typeof bVal === "boolean") {
        comparison = Number(aVal) - Number(bVal);
      }
      return sortDirection === "asc" ? comparison : -comparison;
    });

    if (!search.trim()) return sorted;
    const q = search.toLowerCase();
    return sorted.filter(
      (m) =>
        m.name.toLowerCase().includes(q) ||
        m.author.toLowerCase().includes(q) ||
        m.quant.toLowerCase().includes(q)
    );
  }, [models, sortField, sortDirection, search]);

  // ── Model card ────────────────
  const renderModelCard = (model: ModelEntry, idx: number) => {
    const isSelected = selectedModel?.path === model.path;
    return (
      <motion.div
        key={`${model.author}|${model.name}|${model.quant}`}
        initial={{ opacity: 0, y: 8 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: Math.min(idx * 0.02, 0.4), duration: 0.3 }}
        onClick={() => handleSelect(model)}
        className={`cyber-card cursor-pointer rounded-sm p-3 ${isSelected ? "cyber-card-selected" : ""}`}
      >
        <div className="flex items-start justify-between gap-1 mb-1.5">
          <div className="flex items-center gap-1.5 min-w-0 flex-1">
            {model.vision && (
              <span className="text-[8px] font-mono text-telemetry-cyan px-1 py-0.5 border border-telemetry-cyan/30 bg-telemetry-cyan/5 rounded-sm flex-shrink-0" title="Vision capable">V</span>
            )}
            <span className={`text-xs font-mono truncate ${isSelected ? "text-nv-green" : "text-white"}`} title={model.name}>
              {model.name}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-1.5 text-[9px] font-mono text-stealth-muted">
          <span className="truncate max-w-[80px]" title={model.author}>{model.author}</span>
          <span>·</span>
          <span className="text-nv-green flex-shrink-0">{model.quant}</span>
          <span>·</span>
          <span className="flex-shrink-0">{model.size_str}</span>
        </div>
      </motion.div>
    );
  };

  // ── Sort bar ────────────────
  const renderSortBar = () => (
    <div className="flex items-center gap-1 px-3 py-2 border-b border-stealth-border/50">
      {(["name", "author", "quant", "size_str"] as SortField[]).map((field) => (
        <button
          key={field}
          onClick={() => handleSort(field)}
          className={`px-2 py-0.5 text-[8px] font-mono uppercase tracking-wider transition-colors rounded-sm ${
            sortField === field
              ? "text-nv-green bg-nv-green/10"
              : "text-stealth-muted hover:text-white"
          }`}
        >
          {field.replace("_", " ")}
          {sortField === field && <span className="ml-1">{sortDirection === "asc" ? "▲" : "▼"}</span>}
        </button>
      ))}
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
        </div>
        <button
          onClick={onReload}
          className="px-2 py-0.5 text-[8px] font-mono border border-stealth-border text-stealth-muted hover:text-nv-green hover:border-nv-green/60 transition-colors rounded-sm"
          title="Refresh model list"
        >
          ➸ REFRESH
        </button>
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

      {/* Split panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — model browser */}
        <div className="w-[420px] min-w-[320px] flex flex-col border-r border-stealth-border/50 cyber-panel panel-scanline">
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

        {/* Right panel — config */}
        <div className="flex-1 cyber-panel panel-scanline overflow-hidden">
          <EngineConfigPanel
            model={selectedModel}
            gpus={gpus}
            providers={externalProviders}
            committedVramMib={committedVramMib}
            osOverheadMib={osOverheadMib}
            isAdminUnlocked={isAdminUnlocked}
            onLaunch={onLaunch}
          />
        </div>
      </div>
    </div>
  );
}
