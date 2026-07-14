import { useRef, useEffect, useMemo, useState } from "react";
import type { EngineConfig, ModelEntry, ProviderConfig, StackEntry } from "../lib/types";
import EngineConfigPanel from "./EngineConfigPanel";
import ModelCard from "./ModelCard";

import { useModelCatalog, type SortField } from "../hooks/useModelCatalog";
import type { SetupGuideState } from "../hooks/useSetupGuide";
import { useCatalogSplitResize } from "../hooks/useCatalogSplitResize";
import { useTelemetry } from "../context/TelemetryContext";
import { dispatchNavigateConfig } from "../lib/events";
import TabPageHeader from "./TabPageHeader";


interface ModelCatalogProps {
  models: any[];
  onLaunch: (config: EngineConfig) => Promise<any>;
  error: string | null;
  onReload: () => void;
  providers?: ProviderConfig[];
  committedVramMib: number;

  scanningPath: string | null;
  setScanningPath: (p: string | null) => void;
  batchScanState: { active: boolean; scanned: number; failed: number; total: number };
  setBatchScanState: React.Dispatch<React.SetStateAction<{ active: boolean; scanned: number; failed: number; total: number }>>;
  stack: StackEntry[];
  setupGuide: SetupGuideState;
  catalogHfUpdates?: Set<string>;
}

const sortLabels: Record<string, string> = {
  name: 'NAME', author: 'AUTHOR', size_str: 'SIZE', date: 'DATE'
};

export default function ModelCatalog(props: ModelCatalogProps) {
  const { models, onLaunch, error, onReload, providers: externalProviders, committedVramMib, scanningPath, setScanningPath, batchScanState, setBatchScanState, stack, setupGuide, catalogHfUpdates } = props;
  const { gpus, systemInfo } = useTelemetry();
  const [showScanMenu, setShowScanMenu] = useState(false);
  const [editMode, setEditMode] = useState(false);
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [renameValue, setRenameValue] = useState("");
  const [fileEditBusy, setFileEditBusy] = useState(false);
  const [fileEditError, setFileEditError] = useState<string | null>(null);

  const catalog = useModelCatalog({
    models, stack, providers: externalProviders, scanningPath, setScanningPath, batchScanState, setBatchScanState, onReload,
  });

  const {
    containerRef: splitContainerRef,
    catalogWidth,
    catalogCollapsed,
    isDragging,
    startDrag,
    resetWidth,
    toggleCatalogCollapsed,
  } = useCatalogSplitResize();

  const splitRailRef = useRef<HTMLDivElement>(null);
  const [toggleTopPx, setToggleTopPx] = useState<number | null>(null);

  const scanBlockedByToolchain =
    setupGuide.active
    && setupGuide.phase === "scan-meta"
    && !setupGuide.runtimeReady;

  const { search, setSearch, draftFilter, setCatalogDraftFilter, catalogSelectedModel, panelActiveModel, handleSelect, handleSelectBySlot, selectedSlotIdx, sortField, sortDirection, handleSort,
    catalogModels, runningModelPaths,
    handleScanModel, handleScanAll, handleCancelScan,
    handleDeleteModel, handleRenameModel,
    fitScanAvailable, isFitScanning, getFitScanActiveLabel, getFitScanBadge, modelNeedsFitScan, handleFitScanModel,
    fitScanningCount,
    zone, visibleCount, setVisibleCount } = catalog;

  useEffect(() => {
    const workspace = splitContainerRef.current;
    if (!workspace) return;

    const measureToggleTop = () => {
      const rail = splitRailRef.current;
      if (!rail) {
        setToggleTopPx(null);
        return;
      }
      const catalogPanel = workspace.querySelector(".catalog-list-panel");
      const anchor = catalogPanel ?? workspace;
      const anchorRect = anchor.getBoundingClientRect();
      const railRect = rail.getBoundingClientRect();
      setToggleTopPx(Math.round(anchorRect.top - railRect.top));
    };

    measureToggleTop();

    const observer = new ResizeObserver(measureToggleTop);
    observer.observe(workspace);
    const catalogPanel = workspace.querySelector(".catalog-list-panel");
    if (catalogPanel) observer.observe(catalogPanel);
    const rail = splitRailRef.current;
    if (rail) observer.observe(rail);

    window.addEventListener("resize", measureToggleTop);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureToggleTop);
    };
  }, [splitContainerRef, catalogCollapsed]);

  const startScan = (concurrency: number) => {
    setShowScanMenu(false);
    handleScanAll(concurrency);
  };

  const toggleTopStyle =
    toggleTopPx != null
      ? ({ "--catalog-toggle-top": `${toggleTopPx}px` } as React.CSSProperties)
      : undefined;

  const renderCatalogToggle = (className: string) => (
    <button
      type="button"
      className={className}
      style={toggleTopStyle}
      onClick={toggleCatalogCollapsed}
      title={catalogCollapsed ? "Expand model catalog" : "Collapse model catalog"}
      aria-expanded={!catalogCollapsed}
      aria-label={catalogCollapsed ? "Expand model catalog" : "Collapse model catalog"}
    >
      <span
        className={`catalog-split-toggle__glyph${catalogCollapsed ? "" : " catalog-split-toggle__glyph--collapse"}`}
        aria-hidden
      >
        ▶
      </span>
    </button>
  );

  const editTarget = panelActiveModel ?? catalogSelectedModel;
  const editTargetRunning = editTarget ? runningModelPaths.has(editTarget.path) : false;
  const editActionsDisabled = !editTarget || fileEditBusy || editTargetRunning;

  const closeEditMode = () => {
    setEditMode(false);
    setDeleteConfirmOpen(false);
    setRenameOpen(false);
    setFileEditError(null);
  };

  const openRename = () => {
    if (!editTarget) return;
    const slash = Math.max(editTarget.path.lastIndexOf("/"), editTarget.path.lastIndexOf("\\"));
    setRenameValue(slash >= 0 ? editTarget.path.slice(slash + 1) : editTarget.path);
    setRenameOpen(true);
    setDeleteConfirmOpen(false);
    setFileEditError(null);
  };

  const confirmRename = async () => {
    if (!editTarget || !renameValue.trim()) return;
    setFileEditBusy(true);
    setFileEditError(null);
    try {
      await handleRenameModel(editTarget, renameValue.trim());
      setRenameOpen(false);
      setEditMode(false);
    } catch (e) {
      setFileEditError(typeof e === "string" ? e : String(e));
    } finally {
      setFileEditBusy(false);
    }
  };

  const confirmDelete = async () => {
    if (!editTarget) return;
    setFileEditBusy(true);
    setFileEditError(null);
    try {
      await handleDeleteModel(editTarget);
      setDeleteConfirmOpen(false);
      setEditMode(false);
    } catch (e) {
      setFileEditError(typeof e === "string" ? e : String(e));
    } finally {
      setFileEditBusy(false);
    }
  };

  const searchInputPadding = () => {
    if (batchScanState.active) return "pr-[8.25rem]";
    if (showScanMenu && editMode) return "pr-[15rem]";
    if (showScanMenu) return "pr-[8.25rem]";
    if (editMode) return "pr-[11.5rem]";
    return "pr-[8.5rem]";
  };

  // Auto-scroll selected model into view in the catalog scroll container
  const catalogScrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!catalogSelectedModel || !catalogScrollRef.current) return;
    const container = catalogScrollRef.current;
    requestAnimationFrame(() => {
      const el = container.querySelector(`[data-model-path="${CSS.escape(catalogSelectedModel.path)}"]`);
      if (el) {
        el.scrollIntoView({ block: "nearest", behavior: "auto" });
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

  const renderScanMetaControl = () => {
    if (batchScanState.active) {
      return (
        <>
          <span className="catalog-scan-status text-[7px] font-mono whitespace-nowrap">
            {batchScanState.scanned}/{batchScanState.total}
          </span>
          <button
            onClick={handleCancelScan}
            className="catalog-scan-btn px-1.5 py-0.5 text-[7px] font-mono border border-telemetry-red/40 text-telemetry-red hover:bg-telemetry-red/10 transition-colors rounded-sm"
            title="Stop batch scan"
          >
            STOP
          </button>
        </>
      );
    }
    if (showScanMenu) {
      return (
        <>
          <button
            onClick={() => startScan(4)}
            disabled={scanningPath !== null}
            className="catalog-scan-btn px-1.5 py-0.5 text-[7px] font-mono transition-colors rounded-sm disabled:opacity-30"
            title="Scan all models with 4x parallelism (~2GB RAM)"
          >
            4×
          </button>
          <button
            onClick={() => startScan(8)}
            disabled={scanningPath !== null}
            className="catalog-scan-btn px-1.5 py-0.5 text-[7px] font-mono transition-colors rounded-sm disabled:opacity-30"
            title="Scan all models with 8x parallelism (~4GB RAM)"
          >
            8×
          </button>
          <button
            onClick={() => setShowScanMenu(false)}
            className="catalog-scan-btn px-1 py-0.5 text-[7px] font-mono transition-colors rounded-sm opacity-60"
            title="Close scan menu"
          >
            ✕
          </button>
        </>
      );
    }
    return (
      <button
        onClick={() => setShowScanMenu(true)}
        disabled={scanningPath !== null || scanBlockedByToolchain}
        data-onboarding={setupGuide.phase === "scan-meta" && !scanBlockedByToolchain ? "scan-meta" : undefined}
        className={`catalog-scan-btn px-1.5 py-0.5 text-[7px] font-mono transition-colors rounded-sm disabled:opacity-30 whitespace-nowrap${
          setupGuide.phase === "scan-meta" && !scanBlockedByToolchain ? " catalog-scan-btn--onboarding" : ""
        }`}
        title={
          scanBlockedByToolchain
            ? "Install toolchain or use NEXT in setup to skip metadata scan"
            : "Scan all models for metadata"
        }
      >
        SCAN META ▾
      </button>
    );
  };

  const renderEditControl = () => {
    if (editMode) {
      return (
        <>
          <button
            type="button"
            onClick={openRename}
            disabled={editActionsDisabled}
            className="catalog-scan-btn px-1.5 py-0.5 text-[7px] font-mono transition-colors rounded-sm disabled:opacity-30 whitespace-nowrap"
            title={
              editTargetRunning
                ? "Stop the engine before renaming"
                : editTarget
                  ? `Rename ${editTarget.name}.gguf on disk — catalog display name is heuristic and updates after rescan`
                  : "Select a model first"
            }
          >
            REN
          </button>
          <button
            type="button"
            onClick={() => {
              setRenameOpen(false);
              setDeleteConfirmOpen(true);
              setFileEditError(null);
            }}
            disabled={editActionsDisabled}
            className="catalog-scan-btn px-1.5 py-0.5 text-[7px] font-mono border border-telemetry-red/35 text-telemetry-red hover:bg-telemetry-red/10 transition-colors rounded-sm disabled:opacity-30 whitespace-nowrap"
            title={
              editTargetRunning
                ? "Stop the engine before deleting"
                : editTarget
                  ? `Move ${editTarget.name} to Recycle Bin`
                  : "Select a model first"
            }
          >
            DEL
          </button>
          <button
            type="button"
            onClick={closeEditMode}
            className="catalog-scan-btn px-1 py-0.5 text-[7px] font-mono transition-colors rounded-sm opacity-60"
            title="Close file edit"
          >
            ✕
          </button>
        </>
      );
    }
    return (
      <button
        type="button"
        onClick={() => {
          setEditMode(true);
          setFileEditError(null);
        }}
        disabled={fileEditBusy}
        className="catalog-scan-btn px-1.5 py-0.5 text-[7px] font-mono transition-colors rounded-sm disabled:opacity-30 whitespace-nowrap"
        title="Rename or delete the selected model file"
      >
        EDIT ▾
      </button>
    );
  };

  // ── Sort bar ────────────────
  const renderSortBar = () => (
    <div className="catalog-sort-bar flex items-center gap-2 px-3 py-1.5 min-w-0">
      <div className="catalog-sort-group flex items-center gap-0.5 min-w-0 flex-1">
        {(["name", "author", "size_str", "date"] as SortField[]).map((field) => (
          <button
            key={field}
            onClick={() => handleSort(field)}
            className={`catalog-sort-btn px-1.5 py-0.5 text-[8px] font-mono uppercase tracking-wider transition-colors rounded-sm ${
              sortField === field
                ? "text-nv-green bg-nv-green/10"
                : "text-stealth-muted hover:text-white"
            }`}
          >
            <span>{sortLabels[field] || field.replace("_", " ")}</span>
            <span className="catalog-sort-arrow" aria-hidden="true">
              {sortField === field ? (sortDirection === "asc" ? "▲" : "▼") : ""}
            </span>
          </button>
        ))}
      </div>
      <div className="catalog-sort-actions flex items-center gap-1 shrink-0">
      {fitScanningCount > 0 && (
        <span className="catalog-scan-status text-[8px] font-mono text-violet-300/80 whitespace-nowrap">
          FIT {fitScanningCount}
        </span>
      )}
      <div className="catalog-draft-filter flex items-center gap-0.5 mr-1">
        {(["regular", "draft", "all"] as const).map((mode) => (
          <button
            key={mode}
            onClick={() => setCatalogDraftFilter(mode)}
            className={`px-1.5 py-0 text-[7px] font-mono uppercase rounded-sm transition-colors ${
              draftFilter === mode ? "value-chip-active" : "value-chip"
            }`}
            title={
              mode === "regular"
                ? "Main models only"
                : mode === "draft"
                  ? "Draft models (DFlash / Eagle3)"
                  : "All GGUF files"
            }
          >
            {mode === "regular" ? "MAIN" : mode === "draft" ? "DRAFT" : "ALL"}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1">
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
    </div>
  );



  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" data-model-catalog>
      <TabPageHeader
        title="OPERATIONS"
        meta={<span className="text-[8px] font-mono opacity-40">({catalogModels.length} / {models.length})</span>}
        actions={zone === "config" ? (
          <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-telemetry-cyan/40 text-telemetry-cyan bg-telemetry-cyan/10">
            CONFIG [Ctrl+Enter]
          </span>
        ) : undefined}
      />

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
      <div
        ref={splitContainerRef}
        className={`catalog-split-workspace flex flex-1 overflow-hidden min-h-0${
          catalogCollapsed ? " catalog-split-workspace--collapsed" : ""
        }`}
      >
        {/* Left panel — model browser */}
        {!catalogCollapsed && (
        <div
          className="catalog-list-panel flex flex-col eink-panel-wrapper flex-shrink-0 min-h-0 min-w-0 overflow-hidden"
          style={{ width: catalogWidth }}
        >

          {/* Search bar + scan meta / file edit (in-field, right) */}
          <div className="px-3 py-2 flex-shrink-0 relative">
            <div className="catalog-search-wrap relative min-w-0">
              <input
                type="text"
                placeholder="▶  SEARCH MODELS..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                autoFocus
                className={`catalog-search-input theme-input w-full text-xs font-mono pl-3 py-1.5 rounded-sm ${searchInputPadding()}`}
              />
              <div className="catalog-search-actions absolute inset-y-0 right-1.5 flex items-center gap-1 pointer-events-none">
                <div className="flex items-center gap-1 pointer-events-auto">
                  {renderScanMetaControl()}
                  {renderEditControl()}
                </div>
              </div>
            </div>
            {fileEditError && (
              <p className="mt-1 text-[7px] font-mono text-telemetry-red/90 break-all">{fileEditError}</p>
            )}
            {renameOpen && editTarget && (
              <div
                className="mt-2 rounded-sm border border-stealth-border/60 bg-stealth-panel/90 px-2 py-2 space-y-2"
                role="dialog"
                aria-label="Rename model file"
              >
                <p className="text-[7px] font-mono text-stealth-muted truncate" title={editTarget.path}>
                  RENAME — {editTarget.name}
                </p>
                <p className="text-[7px] font-mono text-stealth-muted/70 leading-relaxed">
                  Renames the .gguf filename on disk. The catalog label ({editTarget.name}) is heuristic and updates after rescan.
                </p>
                <input
                  type="text"
                  value={renameValue}
                  onChange={(e) => setRenameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void confirmRename();
                    if (e.key === "Escape") setRenameOpen(false);
                  }}
                  autoFocus
                  className="theme-input w-full text-[10px] font-mono px-2 py-1 rounded-sm"
                />
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void confirmRename()}
                    disabled={fileEditBusy || !renameValue.trim()}
                    className="value-chip-active text-[7px] font-mono px-2 py-0.5 rounded-sm disabled:opacity-30"
                  >
                    REN
                  </button>
                  <button
                    type="button"
                    onClick={() => setRenameOpen(false)}
                    disabled={fileEditBusy}
                    className="value-chip text-[7px] font-mono px-2 py-0.5 rounded-sm"
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            )}
            {deleteConfirmOpen && editTarget && (
              <div
                className="mt-2 rounded-sm border border-telemetry-red/35 bg-telemetry-red/5 px-2 py-2 space-y-2"
                role="alertdialog"
                aria-label="Confirm delete model file"
              >
                <p className="text-[7px] font-mono text-white/90 leading-relaxed">
                  Move <span className="text-telemetry-red">{editTarget.name}</span> to Recycle Bin?
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void confirmDelete()}
                    disabled={fileEditBusy}
                    className="value-chip-active text-[7px] font-mono px-2 py-0.5 rounded-sm border border-telemetry-red/40 text-telemetry-red disabled:opacity-30"
                  >
                    YES
                  </button>
                  <button
                    type="button"
                    onClick={() => setDeleteConfirmOpen(false)}
                    disabled={fileEditBusy}
                    className="value-chip text-[7px] font-mono px-2 py-0.5 rounded-sm"
                  >
                    NO
                  </button>
                </div>
              </div>
            )}
          </div>

          {renderSortBar()}

          {/* Scrollable catalog zone — all models, height constrained by visibleCount */}
          <div
            ref={catalogScrollRef}
            id="model-table-container"
            data-visible-count={visibleCount}
            className={`overflow-y-auto eink-scrollbar pt-3 px-3 pb-5 ${
              visibleCount === "all" ? "flex-1 min-h-0" : "catalog-scroll--limited flex-shrink-0"
            }`}
          >
            {catalogModels.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full min-h-[8rem] text-center px-4 py-6 gap-3">
                <p className="text-stealth-muted text-xs font-mono opacity-50">
                  {models.length > 0 && search.trim() ? "NO MATCHING MODELS" : "NO MODELS FOUND"}
                </p>
                {models.length === 0 && !setupGuide.pathsDone && (
                  <>
                    <p className="text-[10px] font-mono text-stealth-muted/70 leading-relaxed max-w-[220px]">
                      Did you add your model path?
                    </p>
                    <button
                      type="button"
                      onClick={() => dispatchNavigateConfig({ subTab: "paths" })}
                      className="px-2 py-0.5 text-[8px] font-mono tracking-widest rounded-sm border border-nv-green/50 text-nv-green hover:bg-nv-green/10 transition-colors"
                    >
                      CONFIG → PATHS
                    </button>
                  </>
                )}
              </div>
            ) : (
              <div className="grid grid-cols-1 gap-2">
                {catalogModels.map((model) => {
                  const isSelected = catalogSelectedModel?.path === model.path;
                  return (
                    <div key={model.path} data-model-path={model.path}>
                      <ModelCard
                        model={model}
                        isSelected={isSelected}
                        onSelect={handleSelect}
                        onScanModel={handleScanModel}
                        scanningPath={scanningPath}
                        hfUpdateAvailable={catalogHfUpdates?.has(model.path) ?? false}
                        fitScanBadge={getFitScanBadge(model)}
                        fitScanAvailable={fitScanAvailable}
                        needsFitScan={modelNeedsFitScan(model)}
                        fitScanning={isFitScanning(model.path)}
                        fitScanActiveLabel={getFitScanActiveLabel(model.path)}
                        onFitScanModel={handleFitScanModel}
                      />
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </div>
        )}

        <div
          ref={splitRailRef}
          className={`catalog-split-rail flex-shrink-0${catalogCollapsed ? " catalog-split-rail--collapsed" : ""}${
            isDragging ? " is-dragging" : ""
          }`}
        >
          {renderCatalogToggle("catalog-split-toggle")}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-valuenow={catalogCollapsed ? 0 : catalogWidth}
            aria-label="Resize catalog and engine config panels"
            className={`catalog-split-handle${isDragging ? " is-dragging" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              startDrag();
            }}
            onDoubleClick={() => {
              if (catalogCollapsed) toggleCatalogCollapsed();
              else resetWidth();
            }}
            title={
              catalogCollapsed
                ? "Drag to expand and resize · double-click to expand"
                : "Drag to resize · double-click to reset width"
            }
          />
        </div>

        {/* Right panel — config + diagnostics (height-bound; internal scroll only) */}
        <div className="flex-1 min-w-0 min-h-0 eink-panel-wrapper overflow-hidden flex flex-col">
          <EngineConfigPanel
            model={panelActiveModel}
            gpus={gpus}
            providers={externalProviders}
            committedVramMib={committedVramMib}

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
            setupGuide={setupGuide}
          />
        </div>
      </div>
    </div>
  );
}
