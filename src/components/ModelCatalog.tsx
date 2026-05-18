import { motion } from "framer-motion";
import { useRef, useEffect, useMemo, useState } from "react";
import type { EngineConfig, ProviderConfig, SystemInfo, StackEntry } from "../lib/types";
import EngineConfigPanel from "./EngineConfigPanel";
import ModelCard from "./ModelCard";
import MiniModelCard from "./MiniModelCard";
import { useModelCatalog, type SortField } from "../hooks/useModelCatalog";
import { KEYS } from "../lib/storage";
import { useTelemetry } from "../context/TelemetryContext";

interface ModelCatalogProps {
  models: any[];
  onLaunch: (config: EngineConfig) => void;
  error: string | null;
  onReload: () => void;
  providers?: ProviderConfig[];
  committedVramMib: number;
  isAdminUnlocked: boolean;
  scanningPath: string | null;
  setScanningPath: (p: string | null) => void;
  batchScanState: { active: boolean; scanned: number; failed: number; total: number };
  setBatchScanState: React.Dispatch<React.SetStateAction<{ active: boolean; scanned: number; failed: number; total: number }>>;
  stack: StackEntry[];
}

const sortLabels: Record<string, string> = {
  name: 'NAME', author: 'AUTHOR', size_str: 'SIZE', date: 'DATE'
};

export default function ModelCatalog(props: ModelCatalogProps) {
  const { models, onLaunch, error, onReload, providers: externalProviders, committedVramMib, isAdminUnlocked, scanningPath, setScanningPath, batchScanState, setBatchScanState, stack } = props;
  const { gpus, systemInfo } = useTelemetry();

  const catalog = useModelCatalog({
    models, gpus, stack, scanningPath, setScanningPath, batchScanState, setBatchScanState, onReload,
  });

  const { search, setSearch, catalogSelectedModel, panelActiveModel, handleSelect, handleSelectByAlias, selectedEngineAlias, sortField, sortDirection, handleSort,
    pinnedModels, catalogModels, allFiltered, runningModelPaths, runningInstances, activeEngineByModel,
    getFitStatus, handleScanModel, handleScanAll, handleCancelScan,
    highlightIndex, zone, visibleCount, setVisibleCount, newlyLaunchedAlias } = catalog;

  // Auto-scroll selected model into view in the catalog scroll container
  const catalogScrollRef = useRef<HTMLDivElement>(null);
  const [dynamicMaxHeight, setDynamicMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!catalogScrollRef.current || visibleCount === "all") {
      setDynamicMaxHeight(undefined);
      return;
    }
    const container = catalogScrollRef.current;
    const gap = 8; // gap-2 = 8px between cards
    const count = parseInt(visibleCount);

    const measureAndSet = () => {
      const cards = container.querySelectorAll('[data-model-path]');
      if (cards.length === 0) return;
      let totalH = 0;
      cards.forEach((c: Element) => { totalH += (c as HTMLElement).offsetHeight; });
      let avgHeight = totalH / cards.length;
      const computed = avgHeight * count + gap * (count - 1);
      setDynamicMaxHeight(computed);
    };

    const observer = new ResizeObserver(measureAndSet);
    observer.observe(container);
    requestAnimationFrame(measureAndSet);
    return () => observer.disconnect();
  }, [visibleCount, catalogModels.length]);

  useEffect(() => {
    if (!catalogSelectedModel || !catalogScrollRef.current) return;
    const container = catalogScrollRef.current;
    requestAnimationFrame(() => {
      const el = container.querySelector(`[data-model-path="${catalogSelectedModel.path}"]`);
      if (el) {
        el.scrollIntoView({ block: "start", behavior: "smooth" });
      }
    });
  }, [catalogSelectedModel?.path]);



  // Build flat list of all running instances for pinned grid
  const pinnedInstanceList = useRef<{ entry: StackEntry; modelAuthor?: string; sourcePathLabel?: string; modelName: string; quant: string; sizeStr: string }[]>([]).current;
  const buildPinnedInstances = () => {
    const result: typeof pinnedInstanceList = [];
    for (const [path, entries] of runningInstances) {
      const model = models.find(m => m.path === path);
      for (const entry of entries) {
        result.push({
          entry,
          modelAuthor: model?.author,
          sourcePathLabel: model?.sourcePathLabel,
          modelName: model?.name || entry.model_name || "",
          quant: model?.quant || "",
          sizeStr: model?.size_str || "",
        });
      }
    }
    return result;
  };

  // Determine effective alias for right panel: ONLY from mini card click (selectedEngineAlias)
  const effectiveEngineAlias = selectedEngineAlias;

  // Determine effective port for right panel
  const effectiveEnginePort = useMemo(() => {
    if (!selectedEngineAlias) return undefined;
    const entry = stack.find(s => s.alias === selectedEngineAlias);
    return entry?.port;
  }, [selectedEngineAlias, stack]);

  // ── Sort bar ────────────────
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
      <button
        onClick={onReload}
        className="px-2 py-0.5 text-[8px] font-mono border border-stealth-border text-stealth-muted hover:text-nv-green hover:border-nv-green/60 transition-colors rounded-sm"
        title="Refresh model list"
      >
        ↻
      </button>
      <div className="flex items-center gap-1 ml-2">
        {(["4", "6", "8"] as const).map(count => (
          <button
            key={count}
            onClick={() => setVisibleCount(count)}
            className={`px-1.5 py-0 text-[7px] font-mono rounded-sm transition-colors ${
              visibleCount === count ? "value-chip-active" : "value-chip"
            }`}
          >
            {count}
          </button>
        ))}
        <button
          onClick={() => setVisibleCount("all")}
          className={`px-1.5 py-0 text-[7px] font-mono rounded-sm transition-colors ${
            visibleCount === "all" ? "value-chip-active" : "value-chip"
          }`}
        >
          ALL
        </button>
      </div>
    </div>
  );



  const totalRunning = runningInstances.size;

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
          <span className="text-[9px] font-mono text-stealth-muted">{allFiltered.length} / {models.length}</span>
          {zone === "config" && (
            <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-telemetry-cyan/40 text-telemetry-cyan bg-telemetry-cyan/10">
              CONFIG [Ctrl+Enter]
            </span>
          )}
        </div>
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

      {/* Split panels */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left panel — model browser */}
        <div className="w-[420px] min-w-[320px] flex flex-col border-r border-stealth-border/50 cyber-panel">

          {/* Pinned running instances zone (fixed, no scroll) */}
          {totalRunning > 0 && (() => {
            const instances = buildPinnedInstances();
            return (
              <div className="flex-shrink-0 flex flex-col">
                {/* Spacer matching right-side provider selector to align mini cards with VramBadge top */}
                <div className="h-[56px] flex-shrink-0" />
                <div className="flex-shrink-0 px-3 py-2 border-b section-divider relative bg-black/20">
                  <label className="text-[9px] font-mono tracking-widest uppercase block mb-1.5 glitch-text" style={{ color: '#FBBF24' }}>
                    ▶ RUNNING ({instances.length} instances / {totalRunning} models)
                  </label>
                </div>
                <div className="grid grid-cols-2 gap-1 px-3 pb-2">
                  {instances.map(item => {
                    // Mini card selection is driven ONLY by alias — catalog clicks must not affect it
                    const isThisSelected = selectedEngineAlias === item.entry.alias;
                    return (
                      <MiniModelCard
                        key={item.entry.alias!}
                        entry={item.entry}
                        modelAuthor={item.modelAuthor}
                        modelName={item.modelName}
                        quant={item.quant}
                        sizeStr={item.sizeStr}
                        isSelected={isThisSelected}
                        isNewLaunch={newlyLaunchedAlias === item.entry.alias}
                        onSelect={handleSelectByAlias}
                      />
                    );
                  })}
                </div>
              </div>
            );
          })()}

          {/* Search bar */}
          <div className="px-3 py-2 border-b border-stealth-border/50 flex-shrink-0">
            <input
              type="text"
              placeholder="▶  SEARCH MODELS..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              className="w-full bg-depth-black/50 border border-stealth-border text-white text-xs font-mono px-3 py-1.5 focus:outline-none focus:border-nv-green/60 placeholder:text-stealth-muted rounded-sm"
            />
          </div>

          {renderSortBar()}

          {/* Scrollable catalog zone — all models, height constrained by visibleCount */}
          {(() => {
            const style = visibleCount !== 'all' && dynamicMaxHeight ? { height: `${dynamicMaxHeight}px` } : undefined;
            return (
              <div ref={catalogScrollRef} id="model-table-container" className={`overflow-y-auto cyber-scrollbar p-3 pb-[60px] ${visibleCount === 'all' ? 'flex-1 min-h-0' : 'flex-shrink-0'}`} style={style}>
            {allFiltered.length === 0 ? (
              <div className="flex items-center justify-center h-full text-stealth-muted text-xs font-mono opacity-50">
                NO MODELS FOUND
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {catalogModels.map((model, idx) => {
                    const isSelected = catalogSelectedModel?.path === model.path;
                    return (
                      <div key={model.path} data-model-path={model.path}>
                        <ModelCard
                          model={model}
                          idx={idx}
                          isSelected={isSelected}
                          isHighlighted={highlightIndex >= pinnedModels.length && highlightIndex - pinnedModels.length === idx && zone !== "config"}
                          fitStatus={getFitStatus(
                            model.metadata && model.metadata.file_size_bytes > 0
                              ? Math.floor(model.metadata.file_size_bytes / (1024 * 1024))
                              : Math.floor(parseFloat(model.size_str) * 1024)
                          )}
                          onSelect={handleSelect}
                          onScanModel={handleScanModel}
                          scanningPath={scanningPath}
                        />
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
            );
          })()}
        </div>
        {/* end left panel */}

        {/* Right panel — config + diagnostics */}
        <div className="flex-1 cyber-panel overflow-hidden flex flex-col">
          <div className="flex-shrink-0">
            <EngineConfigPanel
              model={panelActiveModel}
              gpus={gpus}
              providers={externalProviders}
              committedVramMib={committedVramMib}
              isAdminUnlocked={isAdminUnlocked}
              systemInfo={systemInfo}
              stack={stack}
              onLaunch={onLaunch}
              isModelRunning={panelActiveModel ? runningModelPaths.has(panelActiveModel.path) : false}
              activeEngineAlias={effectiveEngineAlias}
              activeEnginePort={effectiveEnginePort}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
