import { useRef, useEffect, useMemo, useState, useCallback } from "react";
import type { CatalogDraftFilter } from "../lib/specDraft";
import type { CatalogUpdateEntry, EngineConfig, HfModelInfo, ModelEntry, ProviderConfig, StackEntry } from "../lib/types";
import { invoke } from "@tauri-apps/api/core";
import EngineConfigPanel from "./EngineConfigPanel";
import ModelCard from "./ModelCard";
import ModelSearchPalette from "./ModelSearchPalette";

import { useModelCatalog, type SortField } from "../hooks/useModelCatalog";
import type { SetupGuideState } from "../hooks/useSetupGuide";
import { useCatalogSplitResize } from "../hooks/useCatalogSplitResize";
import { useTelemetry } from "../context/TelemetryContext";
import { dispatchNavigateConfig } from "../lib/events";
import { loadCatalogListDim, saveCatalogListDim } from "../lib/storage";
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
  catalogHfUpdates?: CatalogUpdateEntry[];
  catalogUpdatesBusy?: boolean;
  onCheckCatalogUpdates?: (onlyPath?: string) => void;
  onClearCatalogUpdate?: (path: string) => void;
}

/** Sort chips — no NAME (search covers free-text); keep one row when rail is narrow. */
const CATALOG_SORT_FIELDS = ["author", "size_str", "date"] as const satisfies readonly SortField[];
const sortLabels: Record<string, string> = {
  author: "AUTHOR",
  size_str: "SIZE",
  date: "DATE",
};

const DRAFT_FILTER_CYCLE: CatalogDraftFilter[] = ["regular", "draft", "all"];

const draftFilterLabels: Record<CatalogDraftFilter, string> = {
  regular: "MAIN",
  draft: "DRAFT",
  all: "ALL",
};

export default function ModelCatalog(props: ModelCatalogProps) {
  const { models, onLaunch, error, onReload, providers: externalProviders, committedVramMib, scanningPath, setScanningPath, batchScanState, setBatchScanState, stack, setupGuide, catalogHfUpdates, catalogUpdatesBusy, onCheckCatalogUpdates, onClearCatalogUpdate } = props;
  const [updatesOnly, setUpdatesOnly] = useState(false);
  const [fullConfirm, setFullConfirm] = useState<CatalogUpdateEntry | null>(null);
  const [updateBusyPath, setUpdateBusyPath] = useState<string | null>(null);

  const updateByPath = useMemo(() => {
    const map = new Map<string, CatalogUpdateEntry>();
    for (const row of catalogHfUpdates ?? []) {
      if (row.hasUpdate) map.set(row.path, row);
    }
    return map;
  }, [catalogHfUpdates]);
  const { gpus, systemInfo } = useTelemetry();
  const [showScanMenu, setShowScanMenu] = useState(false);
  const [editMode, setEditMode] = useState(false);
  /** Opacity of sort + model cards (search chrome stays full). Same range as HW monitor dim. */
  const [catalogListDim, setCatalogListDim] = useState(loadCatalogListDim);
  const onCatalogListDimChange = useCallback((value: number) => {
    const next = Math.min(1, Math.max(0.2, value));
    setCatalogListDim(next);
    saveCatalogListDim(next);
  }, []);
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
    expandCatalog,
  } = useCatalogSplitResize();

  const splitRailRef = useRef<HTMLDivElement>(null);
  const catalogSearchInputRef = useRef<HTMLInputElement>(null);
  const [toggleTopPx, setToggleTopPx] = useState<number | null>(null);
  /** Floating search palette — only when full list is closed. */
  const [searchPaletteOpen, setSearchPaletteOpen] = useState(false);

  /** Portable CUDA runtime required for llama-server GGUF probe (backend hard gate). */
  const scanBlockedByToolchain = !setupGuide.runtimeReady;

  const applyHeaderUpdate = useCallback(async (row: CatalogUpdateEntry) => {
    setUpdateBusyPath(row.path);
    try {
      await invoke<string>("patch_model_metadata", {
        localPath: row.path,
        remoteUrl: row.remoteUrl ?? "",
        remoteTotalSize: row.remoteTotalSize ?? 0,
      });
      onClearCatalogUpdate?.(row.path);
    } catch (e) {
      console.error("Header patch failed:", e);
    } finally {
      setUpdateBusyPath(null);
    }
  }, [onClearCatalogUpdate]);

  const applyFullUpdate = useCallback(async (row: CatalogUpdateEntry) => {
    setUpdateBusyPath(row.path);
    try {
      const info = await invoke<HfModelInfo>("get_hf_model_info", { modelId: row.hfModelId });
      const file = info.gguf_files.find((f) => f.type === row.quant);
      if (!file) throw new Error(`Quant ${row.quant} not on Hub`);
      const slash = row.hfModelId.indexOf("/");
      const hfAuthor = slash > 0 ? row.hfModelId.slice(0, slash) : info.author || "unknown";
      await invoke<string[]>("start_quant_download", {
        hfModelId: row.hfModelId,
        hfAuthor,
        quantType: file.type,
        ggufFile: file,
      });
      onClearCatalogUpdate?.(row.path);
      setFullConfirm(null);
    } catch (e) {
      console.error("Full update failed:", e);
    } finally {
      setUpdateBusyPath(null);
    }
  }, [onClearCatalogUpdate]);

  const { search, setSearch, draftFilter, setCatalogDraftFilter, catalogSelectedModel, panelActiveModel, handleSelect, handleSelectBySlot, selectedSlotIdx, sortField, sortDirection, handleSort,
    catalogModels: catalogModelsRaw, runningModelPaths,
    handleScanModel, handleScanAll, handleCancelScan,
    handleDeleteModel, handleRenameModel,
    fitScanAvailable, isFitScanning, getFitScanActiveLabel, getFitScanBadge, modelNeedsFitScan, handleFitScanModel,
    fitScanningCount,
    zone } = catalog;

  const catalogModels = useMemo(
    () => (updatesOnly ? catalogModelsRaw.filter((m) => updateByPath.has(m.path)) : catalogModelsRaw),
    [updatesOnly, catalogModelsRaw, updateByPath],
  );


  useEffect(() => {
    const workspace = splitContainerRef.current;
    if (!workspace) return;

    /** Open/close chevron aligns with top of first model card (list body). */
    const measureToggleTop = () => {
      const rail = splitRailRef.current;
      if (!rail) {
        setToggleTopPx(null);
        return;
      }
      const railRect = rail.getBoundingClientRect();
      const firstCard =
        workspace.querySelector(".catalog-list-card-wrap") ??
        workspace.querySelector(".model-catalog-card");
      if (firstCard) {
        setToggleTopPx(
          Math.max(0, Math.round(firstCard.getBoundingClientRect().top - railRect.top)),
        );
        return;
      }
      // Empty list — top of scroll pad (first-card line)
      const scroll = workspace.querySelector(".catalog-list-scroll");
      if (scroll) {
        setToggleTopPx(
          Math.max(0, Math.round(scroll.getBoundingClientRect().top + 12 - railRect.top)),
        );
        return;
      }
      setToggleTopPx(0);
    };

    measureToggleTop();

    const observer = new ResizeObserver(measureToggleTop);
    observer.observe(workspace);
    const catalogPanel = workspace.querySelector(".catalog-list-panel");
    if (catalogPanel) observer.observe(catalogPanel);
    const body = workspace.querySelector(".catalog-list-panel__body");
    if (body) observer.observe(body);
    const scroll = workspace.querySelector(".catalog-list-scroll");
    if (scroll) observer.observe(scroll);
    const rail = splitRailRef.current;
    if (rail) observer.observe(rail);

    window.addEventListener("resize", measureToggleTop);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measureToggleTop);
    };
  }, [splitContainerRef, catalogCollapsed, catalogModels.length]);

  const startScan = (concurrency: number) => {
    setShowScanMenu(false);
    handleScanAll(concurrency);
  };

  const toggleTopStyle =
    toggleTopPx != null
      ? ({ "--catalog-toggle-top": `${toggleTopPx}px` } as React.CSSProperties)
      : undefined;

  const focusFullCatalogSearch = useCallback(() => {
    const el = catalogSearchInputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const openSearchPalette = useCallback(() => {
    setSearchPaletteOpen(true);
  }, []);

  const closeSearchPalette = useCallback(() => {
    setSearchPaletteOpen(false);
  }, []);

  const handlePaletteSelect = useCallback(
    (model: ModelEntry) => {
      handleSelect(model);
      setSearchPaletteOpen(false);
    },
    [handleSelect],
  );

  const openFullCatalogFromPalette = useCallback(() => {
    setSearchPaletteOpen(false);
    expandCatalog();
    // Focus in-panel search after layout paints the full list
    window.setTimeout(() => {
      catalogSearchInputRef.current?.focus();
    }, 50);
  }, [expandCatalog]);

  // `/` / Ctrl+K: full catalog open → focus its search box; closed → floating palette.
  // Ctrl+Shift+F: open full catalog (and focus search).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const t = e.target as HTMLElement | null;
      const tag = t?.tagName;
      const typing =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        t?.isContentEditable;

      if ((e.key === "f" || e.key === "F") && (e.ctrlKey || e.metaKey) && e.shiftKey) {
        e.preventDefault();
        openFullCatalogFromPalette();
        return;
      }

      if (typing) return;

      const slash = e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey;
      const ctrlK = (e.key === "k" || e.key === "K") && (e.ctrlKey || e.metaKey) && !e.altKey;
      if (!slash && !ctrlK) return;

      e.preventDefault();
      if (!catalogCollapsed) {
        // Full list visible — only focus the in-panel search, never open the modal
        focusFullCatalogSearch();
      } else {
        openSearchPalette();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [catalogCollapsed, openSearchPalette, openFullCatalogFromPalette, focusFullCatalogSearch]);

  const renderCatalogToggle = (className: string) => (
    <button
      type="button"
      className={`${className}${catalogCollapsed ? " catalog-split-toggle--collapsed-hint" : ""}`}
      style={toggleTopStyle}
      onClick={() => {
        // Chevron always open/closes the full catalog (persisted) — never the / search palette.
        toggleCatalogCollapsed();
      }}
      title={catalogCollapsed ? "Open full model catalog" : "Close full model catalog"}
      aria-expanded={!catalogCollapsed}
      aria-label={catalogCollapsed ? "Open full model catalog" : "Close full model catalog"}
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
        className="catalog-scan-btn px-1.5 py-0.5 text-[7px] font-mono transition-colors rounded-sm disabled:opacity-30 whitespace-nowrap"
        title={
          scanBlockedByToolchain
            ? "Install the portable toolchain in setup before scanning GGUF metadata"
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
          {editTarget && (
            <button
              type="button"
              onClick={() => handleScanModel(editTarget)}
              disabled={scanningPath !== null}
              className={`catalog-scan-btn px-1.5 py-0.5 text-[7px] font-mono transition-colors rounded-sm whitespace-nowrap ${
                scanningPath === editTarget.path
                  ? 'text-telemetry-cyan border border-telemetry-cyan/40 bg-telemetry-cyan/10'
                  : 'text-orange-400 border border-orange-400/30 hover:bg-orange-400/10 disabled:opacity-30'
              }`}
              title="Re-scan GGUF metadata — updates draft role, architecture, param count, etc."
            >
              {scanningPath === editTarget.path ? '⠋ RESCAN…' : 'RESCAN'}
            </button>
          )}
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

  // ── Kind cycler (MAIN / DRAFT / ALL) — single button, docked in the search row ──
  const renderKindCycler = () => (
    <button
      type="button"
      data-kind={draftFilter}
      onClick={() => {
        const idx = DRAFT_FILTER_CYCLE.indexOf(draftFilter);
        const next = DRAFT_FILTER_CYCLE[(idx + 1) % DRAFT_FILTER_CYCLE.length];
        setCatalogDraftFilter(next);
      }}
      className="catalog-kind-cycler value-chip px-2 py-0 text-[7px] font-mono uppercase rounded-sm transition-colors"
      title={`Model kind — ${draftFilterLabels[draftFilter]} (click to cycle MAIN / DRAFT / ALL)`}
      aria-label={`Model kind: ${draftFilterLabels[draftFilter]}. Click to cycle.`}
    >
      {draftFilterLabels[draftFilter]}
    </button>
  );

  // ── Chrome tools row: sort + MAIN/MAX + dim (always full opacity) ────────────────
  const renderChromeTools = () => (
    <div className="catalog-list-panel__chrome-tools">
      <div className="catalog-chrome-row catalog-chrome-row--filters">
        <div className="catalog-sort-actions">
          {fitScanningCount > 0 && (
            <span className="catalog-scan-status text-[8px] font-mono text-stealth-muted whitespace-nowrap">
              FIT {fitScanningCount}
            </span>
          )}
          <button
            type="button"
            onClick={() => onCheckCatalogUpdates?.()}
            disabled={catalogUpdatesBusy}
            className="catalog-cycle-btn value-chip px-1.5 py-0 text-[7px] font-mono uppercase rounded-sm transition-colors disabled:opacity-40"
            title="Check every local HF-paired model against the Hub (tree listing only unless size is close)"
          >
            {catalogUpdatesBusy ? "CHECKING…" : "CHECK ALL"}
          </button>
          <button
            type="button"
            onClick={() => {
              const path = catalogSelectedModel?.path ?? panelActiveModel?.path;
              if (path) onCheckCatalogUpdates?.(path);
            }}
            disabled={catalogUpdatesBusy || !(catalogSelectedModel || panelActiveModel)}
            className="catalog-cycle-btn value-chip px-1.5 py-0 text-[7px] font-mono uppercase rounded-sm transition-colors disabled:opacity-40"
            title="Check only the selected model against Hugging Face"
          >
            CHECK SELECTED
          </button>
          <button
            type="button"
            onClick={() => setUpdatesOnly((v) => !v)}
            className={`catalog-cycle-btn value-chip px-1.5 py-0 text-[7px] font-mono uppercase rounded-sm transition-colors ${
              updatesOnly ? "value-chip-active" : ""
            }`}
            title="Show only models with a Hub update"
          >
            UPDATES{updateByPath.size > 0 ? ` ${updateByPath.size}` : ""}
          </button>
        </div>
      </div>
      <div className="catalog-chrome-row catalog-chrome-row--sort">
        <div className="catalog-sort-group">
          {CATALOG_SORT_FIELDS.map((field) => (
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
        <label
          className="panel-dim-control"
          title={`Catalog list dim — ${Math.round(catalogListDim * 100)}% (header + selected model stay full)`}
        >
          <span className="panel-dim-control__label">DIM</span>
          <input
            type="range"
            className="panel-dim-control__slider"
            min={20}
            max={100}
            step={1}
            value={Math.round(catalogListDim * 100)}
            onChange={(e) => onCatalogListDimChange(Number(e.target.value) / 100)}
            aria-label="Catalog list dim"
          />
        </label>
      </div>
    </div>
  );



  return (
    <div className="flex flex-col h-full min-h-0 overflow-hidden" data-model-catalog>
      <TabPageHeader
        title="OPERATIONS"
        actions={
          <span className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => {
                if (catalogCollapsed) openSearchPalette();
                else focusFullCatalogSearch();
              }}
              className={`text-[8px] font-mono px-1.5 py-0.5 rounded-sm border transition-colors config-catalog-search-hint ${
                catalogCollapsed
                  ? "config-catalog-search-hint--pulse"
                  : "border-stealth-border/50 config-muted hover:theme-accent-text"
              }`}
              title={
                catalogCollapsed
                  ? "Search models (/ or Ctrl+K) — floating picker while list is closed"
                  : "Focus catalog search (/ or Ctrl+K)"
              }
            >
              / SEARCH
            </button>
            {catalogCollapsed && (
              <button
                type="button"
                onClick={openFullCatalogFromPalette}
                className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-stealth-border/50 config-muted hover:theme-accent-text transition-colors"
                title="Open full model catalog (Ctrl+Shift+F)"
              >
                FULL LIST
              </button>
            )}
            {zone === "config" ? (
              <span className="text-[8px] font-mono px-1.5 py-0.5 rounded-sm border border-telemetry-cyan/40 text-telemetry-cyan bg-telemetry-cyan/10">
                CONFIG [Ctrl+Enter]
              </span>
            ) : null}
          </span>
        }
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

          {/*
            Chrome header — full opacity always (search, sort, MAIN/MAX, dim).
            Only unselected cards dim; selected card stays full strength.
          */}
          <div className="catalog-list-panel__chrome">
            <div className="catalog-list-panel__chrome-search">
              <div className="catalog-search-wrap min-w-0">
                <div className="catalog-search-field">
                  <input
                    ref={catalogSearchInputRef}
                    type="text"
                    placeholder="▶  SEARCH MODELS..."
                    value={search}
                    onChange={(e) => setSearch(e.target.value.replace(/\//g, ""))}
                    onKeyDown={(e) => {
                      // `/` is the focus/open shortcut — never type into the query
                      if (e.key === "/" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                        e.preventDefault();
                      }
                    }}
                    autoFocus
                    className="catalog-search-input theme-input w-full text-xs font-mono pl-3 pr-20 rounded-sm"
                  />
                  {renderKindCycler()}
                  <span
                    className="catalog-search-count"
                    aria-hidden="true"
                    title={`${catalogModels.length} shown / ${models.length} total`}
                  >
                    {catalogModels.length} / {models.length}
                  </span>
                </div>
              </div>
              <div className="catalog-search-tools">
                {renderScanMetaControl()}
                {renderEditControl()}
              </div>
            </div>
            {renderChromeTools()}
            {fileEditError && (
              <p className="catalog-list-panel__chrome-msg text-[7px] font-mono text-telemetry-red/90 break-all">
                {fileEditError}
              </p>
            )}
            {renameOpen && editTarget && (
              <div
                className="catalog-list-panel__chrome-dialog rounded-sm border border-stealth-border/60 bg-stealth-panel/90 px-2 py-2 space-y-2"
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
            {fullConfirm && (
              <div
                className="catalog-list-panel__chrome-dialog rounded-sm border border-yellow-400/35 bg-yellow-400/5 px-2 py-2 space-y-2"
                role="alertdialog"
                aria-label="Confirm full weight re-download"
              >
                <p className="text-[7px] font-mono text-white/90 leading-relaxed">
                  FULL update for <span className="text-yellow-400">{fullConfirm.quant}</span> re-downloads weights
                  ({fullConfirm.reason || "tensor data changed"}).
                </p>
                <div className="flex gap-1.5">
                  <button
                    type="button"
                    onClick={() => void applyFullUpdate(fullConfirm)}
                    disabled={updateBusyPath === fullConfirm.path}
                    className="value-chip-active text-[7px] font-mono px-2 py-0.5 rounded-sm border border-yellow-400/40 text-yellow-400 disabled:opacity-30"
                  >
                    DOWNLOAD
                  </button>
                  <button
                    type="button"
                    onClick={() => setFullConfirm(null)}
                    className="value-chip text-[7px] font-mono px-2 py-0.5 rounded-sm"
                  >
                    CANCEL
                  </button>
                </div>
              </div>
            )}
            {deleteConfirmOpen && editTarget && (
              <div
                className="catalog-list-panel__chrome-dialog rounded-sm border border-telemetry-red/35 bg-telemetry-red/5 px-2 py-2 space-y-2"
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

          {/* Card list only — dim unselected rows; selected stays full opacity */}
          <div className="catalog-list-panel__body">
          <div
            ref={catalogScrollRef}
            id="model-table-container"
            className="catalog-list-scroll overflow-y-auto eink-scrollbar pt-3 px-3 pb-5 flex-1 min-h-0"
          >
            {catalogModels.length === 0 ? (
              <div
                className="flex flex-col items-center justify-center h-full min-h-[8rem] text-center px-4 py-6 gap-3"
                style={{ opacity: catalogListDim }}
              >
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
                    <div
                      key={model.path}
                      data-model-path={model.path}
                      className={
                        isSelected
                          ? "catalog-list-card-wrap catalog-list-card-wrap--selected"
                          : "catalog-list-card-wrap"
                      }
                      style={isSelected ? undefined : { opacity: catalogListDim }}
                    >
                      <ModelCard
                        model={model}
                        isSelected={isSelected}
                        onSelect={handleSelect}
                        onScanModel={handleScanModel}
                        scanningPath={scanningPath}
                        hfUpdateKind={updateByPath.get(model.path)?.kind ?? null}
                        hfUpdateBusy={updateBusyPath === model.path}
                        onApplyHfUpdate={() => {
                          const row = updateByPath.get(model.path);
                          if (!row) return;
                          if (row.kind === "full") setFullConfirm(row);
                          else void applyHeaderUpdate(row);
                        }}
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

      <ModelSearchPalette
        open={searchPaletteOpen}
        models={catalogModels}
        search={search}
        onSearchChange={setSearch}
        selectedPath={panelActiveModel?.path ?? catalogSelectedModel?.path}
        onSelect={handlePaletteSelect}
        onClose={closeSearchPalette}
        onOpenFullCatalog={openFullCatalogFromPalette}
        scanningPath={scanningPath}
        onScanModel={handleScanModel}
      />
    </div>
  );
}
