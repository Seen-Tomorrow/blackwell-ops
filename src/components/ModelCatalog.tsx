import { useRef, useEffect, useMemo, useState } from "react";
import type { EngineConfig, ProviderConfig, StackEntry } from "../lib/types";
import EngineConfigPanel from "./EngineConfigPanel";
import ModelCard from "./ModelCard";

import { useModelCatalog, type SortField } from "../hooks/useModelCatalog";
import { useCatalogSplitResize } from "../hooks/useCatalogSplitResize";
import { useTelemetry } from "../context/TelemetryContext";


interface ModelCatalogProps {
  models: any[];
  onLaunch: (config: EngineConfig) => Promise<any>;
  error: string | null;
  onReload: () => void;
  providers?: ProviderConfig[];
  committedVramMib: number;
  isPowerUser: boolean;
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
  const { models, onLaunch, error, onReload, providers: externalProviders, committedVramMib, isPowerUser, scanningPath, setScanningPath, batchScanState, setBatchScanState, stack } = props;
  const { gpus, systemInfo } = useTelemetry();
  const [showScanMenu, setShowScanMenu] = useState(false);

  const catalog = useModelCatalog({
    models, gpus, stack, scanningPath, setScanningPath, batchScanState, setBatchScanState, onReload,
  });

  const { containerRef: splitContainerRef, catalogWidth, isDragging, startDrag, resetWidth } =
    useCatalogSplitResize();

  const { search, setSearch, catalogSelectedModel, panelActiveModel, handleSelect, handleSelectBySlot, selectedSlotIdx, sortField, sortDirection, handleSort,
    pinnedModels, catalogModels, allFiltered, runningModelPaths, runningInstances, activeEngineByModel,
    getFitStatus, handleScanModel, handleScanAll, handleCancelScan,
    highlightIndex, zone, visibleCount, setVisibleCount } = catalog;

  const startScan = (concurrency: number) => {
    setShowScanMenu(false);
    handleScanAll(concurrency);
  };

  // Auto-scroll selected model into view in the catalog scroll container
  const catalogScrollRef = useRef<HTMLDivElement>(null);
  const [dynamicMaxHeight, setDynamicMaxHeight] = useState<number | undefined>(undefined);

  useEffect(() => {
    if (!catalogScrollRef.current || visibleCount === "all") {
      setDynamicMaxHeight(undefined);
      return;
    }
    const container = catalogScrollRef.current;
    const count = parseInt(visibleCount);

    const measureAndSet = () => {
      const cards = container.querySelectorAll('[data-model-path]');
      if (cards.length === 0) return;
      const totalCards = cards.length;
      const style = window.getComputedStyle(container);
      const padTop = parseFloat(style.paddingTop);
      const padBottom = parseFloat(style.paddingBottom);
      const contentHeight = container.scrollHeight - padTop - padBottom;
      const gapsTotal = 8 * (totalCards - 1);
      const cardsTotalHeight = contentHeight - gapsTotal;
      const avgCardH = cardsTotalHeight / totalCards;
      const needed = avgCardH * count + 8 * (count - 1) + padTop + padBottom;
      // Cap at available parent space (use offsetHeight, not getBoundingClientRect)
      const parentH = container.parentElement.offsetHeight;
      const usedAbove = container.offsetTop;
      const available = parentH - usedAbove;
      setDynamicMaxHeight(Math.min(needed, available));
    };

    requestAnimationFrame(() => setTimeout(measureAndSet, 100));
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




  // Determine effective engine entry from selected slot index
  const effectiveEngineEntry = useMemo(() => {
    if (selectedSlotIdx === null) return undefined;
    return stack.find(s => s.idx === selectedSlotIdx);
  }, [selectedSlotIdx, stack]);

  // Effective alias for Fusion overlay — resolved from slot entry
  const effectiveEngineAlias = effectiveEngineEntry?.alias || undefined;

  // Determine effective port for right panel
  const effectiveEnginePort = effectiveEngineEntry?.port;
  const effectiveSupportsFusion = effectiveEngineEntry?.supportsFusion ?? true;

  // ── Sort bar ────────────────
  const renderSortBar = () => (
    <div className="flex items-center gap-1 px-3 py-2">
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
          ⏹ STOP
        </button>
      ) : showScanMenu ? (
        <div className="flex items-center gap-1">
          <button
            onClick={() => startScan(4)}
            disabled={scanningPath !== null}
            className="px-2 py-0.5 text-[8px] font-mono border border-telemetry-cyan/30 text-telemetry-cyan hover:bg-telemetry-cyan/10 transition-colors rounded-sm disabled:opacity-30"
            title="Scan all models with 4x parallelism (~2GB RAM)"
          >
            SPEED 4×
          </button>
          <button
            onClick={() => startScan(8)}
            disabled={scanningPath !== null}
            className="px-2 py-0.5 text-[8px] font-mono border border-telemetry-cyan/30 text-telemetry-cyan hover:bg-telemetry-cyan/10 transition-colors rounded-sm disabled:opacity-30"
            title="Scan all models with 8x parallelism (~4GB RAM)"
          >
            SPEED 8×
          </button>
        </div>
      ) : (
        <button
          onClick={() => setShowScanMenu(true)}
          disabled={scanningPath !== null}
          className="px-2 py-0.5 text-[8px] font-mono border border-telemetry-cyan/30 text-telemetry-cyan hover:bg-telemetry-cyan/10 transition-colors rounded-sm disabled:opacity-30"
          title="Scan all models for metadata"
        >
          SCAN META ▾
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



  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" data-model-catalog>
      {/* Top bar */}
      <div className="px-4 py-2.5 border-b border-stealth-border/50 flex items-center justify-between fade-in">
        <div className="flex items-center gap-3">
          <h2 className="text-xs font-mono theme-accent-text tracking-widest">✦ MODEL CATALOG</h2>
          <span className="text-[8px] font-mono opacity-40">({allFiltered.length} / {models.length})</span>
          {zone === "config" && (
            <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-telemetry-cyan/40 text-telemetry-cyan bg-telemetry-cyan/10">
              CONFIG [Ctrl+Enter]
            </span>
          )}
        </div>
      </div>

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

      {/* Split panels — drag handle resets to default on double-click */}
      <div ref={splitContainerRef} className="flex flex-1 overflow-hidden min-h-0">
        {/* Left panel — model browser */}
        <div
          className="flex flex-col eink-panel-wrapper flex-shrink-0 min-h-0"
          style={{ width: catalogWidth }}
        >

          {/* Search bar */}
          <div className="px-3 py-2 flex-shrink-0">
            <input
              type="text"
              placeholder="▶  SEARCH MODELS..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              autoFocus
              className="theme-input w-full text-xs font-mono px-3 py-1.5 rounded-sm"
            />
          </div>

          {renderSortBar()}

          {/* Scrollable catalog zone — all models, height constrained by visibleCount */}
          {(() => {
            const style = visibleCount !== 'all' && dynamicMaxHeight ? { height: `${dynamicMaxHeight}px` } : undefined;
            return (
              <div ref={catalogScrollRef} id="model-table-container" className={`overflow-y-auto eink-scrollbar pt-3 px-3 pb-5 ${visibleCount === 'all' ? 'flex-1 min-h-0' : 'flex-shrink-0'}`} style={style}>
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

        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={catalogWidth}
          aria-label="Resize catalog and engine config panels"
          className={`catalog-split-handle${isDragging ? " is-dragging" : ""}`}
          onMouseDown={(e) => {
            e.preventDefault();
            startDrag();
          }}
          onDoubleClick={resetWidth}
          title="Drag to resize · double-click to reset"
        />

        {/* Right panel — config + diagnostics (height-bound; internal scroll only) */}
        <div className="flex-1 min-w-0 min-h-0 eink-panel-wrapper overflow-hidden flex flex-col">
          <EngineConfigPanel
            model={panelActiveModel}
            gpus={gpus}
            providers={externalProviders}
            committedVramMib={committedVramMib}
            isPowerUser={isPowerUser}
            systemInfo={systemInfo}
            stack={stack}
            onLaunch={onLaunch}
            isModelRunning={panelActiveModel ? runningModelPaths.has(panelActiveModel.path) : false}
            activeEngineAlias={effectiveEngineAlias}
            activeEnginePort={effectiveEnginePort}
            selectedSlotIdx={selectedSlotIdx}
            supportsFusion={effectiveSupportsFusion}
            models={models}
            onSelectEngine={handleSelectBySlot}
          />
        </div>
      </div>
    </div>
  );
}
