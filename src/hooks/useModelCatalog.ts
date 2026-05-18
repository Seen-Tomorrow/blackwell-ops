import { useState, useCallback, useMemo, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ModelEntry, EngineConfig, GpuInfo, ProviderConfig, SystemInfo, StackEntry } from "../lib/types";
import { useKeyboardNav } from "./useKeyboardNav";
import { KEYS } from "../lib/storage";

const LAST_MODEL_KEY = KEYS.lastModel;
const SORT_FIELD_KEY = KEYS.sortField;
const SORT_DIR_KEY = KEYS.sortDir;

export type SortField = (keyof ModelEntry) | "date";
export type SortDirection = "asc" | "desc";
export type FitStatus = { label: string; colorClass: string };

interface UseModelCatalogParams {
  models: ModelEntry[];
  gpus: GpuInfo[];
  stack: StackEntry[];
  scanningPath: string | null;
  setScanningPath: (p: string | null) => void;
  batchScanState: { active: boolean; scanned: number; failed: number; total: number };
  setBatchScanState: React.Dispatch<React.SetStateAction<{ active: boolean; scanned: number; failed: number; total: number }>>;
  onReload: () => void;
}

export function useModelCatalog({ models, gpus, stack, scanningPath, setScanningPath, batchScanState, setBatchScanState, onReload }: UseModelCatalogParams) {
  const [search, setSearch] = useState("");
  // Visual highlight in catalog list only — set by catalog card clicks
  const [catalogSelectedModel, setCatalogSelectedModel] = useState<ModelEntry | null>(null);
  // Right panel active model — set by catalog OR mini card clicks
  const [panelActiveModel, setPanelActiveModel] = useState<ModelEntry | null>(null);
  const [selectedSlotIdx, setSelectedSlotIdx] = useState<number | null>(null);
  const [visibleCount, setVisibleCount] = useState<"4" | "6" | "8" | "all">(() => {
    try { return (localStorage.getItem(KEYS.catalogVisibleCount) as any) || "6"; } catch { return "6"; }
  });
  const [sortField, setSortField] = useState<SortField>(() => {
    try { return (localStorage.getItem(SORT_FIELD_KEY) as SortField) || "name"; } catch { return "name"; }
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    try { return (localStorage.getItem(SORT_DIR_KEY) as SortDirection) || "asc"; } catch { return "asc"; }
  });

  // Restore last selected model from localStorage once models are loaded
  useEffect(() => {
    if (models.length === 0 || catalogSelectedModel !== null) return;
    try {
      const savedPath = localStorage.getItem(LAST_MODEL_KEY);
      if (savedPath) {
        const match = models.find(m => m.path === savedPath);
        if (match) {
          setCatalogSelectedModel(match);
          setPanelActiveModel(match);
        }
      }
    } catch {}
  }, [models, catalogSelectedModel]);

  // Refresh catalog selected model reference when models array updates
  useEffect(() => {
    if (!catalogSelectedModel || models.length === 0) return;
    const fresh = models.find(m => m.path === catalogSelectedModel.path);
    if (fresh && fresh !== catalogSelectedModel) {
      setCatalogSelectedModel(fresh);
    }
  }, [models, catalogSelectedModel]);

  // Refresh panel active model reference when models array updates
  useEffect(() => {
    if (!panelActiveModel || models.length === 0) return;
    const fresh = models.find(m => m.path === panelActiveModel.path);
    if (fresh && fresh !== panelActiveModel) {
      setPanelActiveModel(fresh);
    }
  }, [models, panelActiveModel]);

  // Persist sort state
  useEffect(() => { try { localStorage.setItem(SORT_FIELD_KEY, sortField); } catch {} }, [sortField]);
  useEffect(() => { try { localStorage.setItem(SORT_DIR_KEY, sortDirection); } catch {} }, [sortDirection]);
  useEffect(() => { try { localStorage.setItem(KEYS.catalogVisibleCount, visibleCount); } catch {} }, [visibleCount]);

  // Listen for engine launch event — deterministic auto-select from backend return value
  useEffect(() => {
    const onLaunch = (e: Event) => {
      const detail = (e as CustomEvent).detail as { slotIdx: number; modelPath: string };
      if (detail?.slotIdx !== undefined) {
        setSelectedSlotIdx(detail.slotIdx);
        setPanelActiveModel(models.find(m => m.path === detail.modelPath) || null);
      }
    };
    const onStopAll = () => {
      setSelectedSlotIdx(null);
    };
    window.addEventListener("blackops-engine-launched", onLaunch);
    window.addEventListener("blackops-stop-all", onStopAll);
    return () => {
      window.removeEventListener("blackops-engine-launched", onLaunch);
      window.removeEventListener("blackops-stop-all", onStopAll);
    };
  }, [models]);

  const handleSelect = useCallback((model: ModelEntry) => {
    setCatalogSelectedModel(model);
    setPanelActiveModel(model);
    setSelectedSlotIdx(null); // Generic selection — clear engine-specific pairing
    try { localStorage.setItem(LAST_MODEL_KEY, model.path); } catch {}
  }, []);

  // Select a specific running engine instance by slot index (for mini card clicks)
  const handleSelectBySlot = useCallback((slotIdx: number) => {
    const entry = stack.find(s => s.idx === slotIdx && (s.status === "RUNNING" || s.status === "LOADING"));
    if (entry?.model_path) {
      const model = models.find(m => m.path === entry.model_path);
      if (model) {
        setPanelActiveModel(model);
        setSelectedSlotIdx(slotIdx);
        try { localStorage.setItem(LAST_MODEL_KEY, model.path); } catch {}
      }
    }
  }, [stack, models]);

  // Clear engine selection when all engines are stopped or the selected slot is cleared
  const clearEngineSelection = useCallback(() => {
    setSelectedSlotIdx(null);
  }, []);

  const handleSort = useCallback((field: SortField) => {
    if (sortField === field) {
      setSortDirection(d => (d === "asc" ? "desc" : "asc"));
    } else {
      setSortField(field);
      setSortDirection("asc");
    }
  }, [sortField]);

  // Map model_path → array of ALL running stack entries (supports multiple instances)
  const runningInstances = useMemo(() => {
    const map = new Map<string, StackEntry[]>();
    for (const s of stack) {
      if (s.status !== "RUNNING" && s.status !== "LOADING") continue;
      const path = s.model_path!;
      if (!map.has(path)) map.set(path, []);
      map.get(path)!.push(s);
    }
    return map;
  }, [stack]);

  // Set of model paths that have at least one running instance (for quick lookup)
  const runningModelPaths = useMemo(() => new Set(runningInstances.keys()), [runningInstances]);

  // First engine per model (backward compat for EngineConfigPanel)
  const activeEngineByModel = useMemo(() => {
    const map = new Map<string, { alias: string; port?: number }>();
    stack.filter(s => s.status === "RUNNING" || s.status === "LOADING").forEach(s => {
      if (!map.has(s.model_path!)) map.set(s.model_path!, { alias: s.alias!, port: s.port });
    });
    return map;
  }, [stack]);

  // All models sorted, then split for pinned zone (running) and catalog zone (all models)
  const { pinnedModels, catalogModels, allFiltered } = useMemo(() => {
    let sorted = [...models].sort((a, b) => {
      let comparison = 0;
      if (sortField === "date") {
        comparison = (a.metadata?.file_created ?? 0) - (b.metadata?.file_created ?? 0);
      } else {
        const aVal = a[sortField];
        const bVal = b[sortField];
        if (sortField === "size_str") {
          const parseGb = (s: string) => parseFloat(String(s).replace(/[^0-9.]/g, "")) || 0;
          comparison = parseGb(aVal as string) - parseGb(bVal as string);
        } else if (typeof aVal === "string" && typeof bVal === "string") {
          comparison = aVal.localeCompare(bVal);
        } else if (typeof aVal === "boolean" && typeof bVal === "boolean") {
          comparison = Number(aVal) - Number(bVal);
        }
      }
      return sortDirection === "asc" ? comparison : -comparison;
    });

    // Pinned zone: models with running instances (one entry per model, not per instance — instances shown in pinned grid)
    const pinned: ModelEntry[] = [];
    for (const m of sorted) {
      if (runningModelPaths.has(m.path)) pinned.push(m);
    }

    // Apply search filter to pinned zone
    let filteredPinned = pinned;
    if (search.trim()) {
      const words = search.toLowerCase().trim().split(/\s+/);
      const matches = (m: ModelEntry) => {
        const combined = `${m.name} ${m.author} ${m.quant}`.toLowerCase();
        return words.every(word => combined.includes(word));
      };
      filteredPinned = pinned.filter(matches);
    }

    // Catalog zone: ALL models (including running), with search filter
    let catalogAll = [...sorted];
    if (search.trim()) {
      const words = search.toLowerCase().trim().split(/\s+/);
      const matches = (m: ModelEntry) => {
        const combined = `${m.name} ${m.author} ${m.quant}`.toLowerCase();
        return words.every(word => combined.includes(word));
      };
      catalogAll = sorted.filter(matches);
    }

    // allFiltered is pinned + catalog for keyboard nav indexing
    const all = [...filteredPinned, ...catalogAll];
    return { pinnedModels: filteredPinned, catalogModels: catalogAll, allFiltered: all };
  }, [models, sortField, sortDirection, search, runningModelPaths]);

  // VRAM fit status
  const getFitStatus = useCallback((modelSizeMib: number): FitStatus => {
    if (gpus.length === 0) return { label: "—", colorClass: "text-stealth-muted" };
    const singleGpuVram = gpus[0].memory_total_manufactured || gpus[0].memory_total;
    const totalVramMib = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);
    if (modelSizeMib <= singleGpuVram) return { label: "FITS", colorClass: "text-nv-green" };
    if (modelSizeMib <= totalVramMib) return { label: "SPLIT", colorClass: "text-telemetry-cyan" };
    return { label: "RAM OFFLOAD", colorClass: "text-telemetry-red" };
  }, [gpus]);

  // Scan handlers
  const handleScanModel = useCallback(async (model: ModelEntry) => {
    if (scanningPath) return;
    setScanningPath(model.path);
    try {
      await invoke("scan_model_metadata_cmd", { modelPath: model.path, providerId: null });
      onReload();
    } catch (e) { console.error("Scan failed:", e); }
    finally { setScanningPath(null); }
  }, [scanningPath, onReload]);

  const handleScanAll = useCallback(async () => {
    setBatchScanState({ active: true, scanned: 0, failed: 0, total: models.length });
    try {
      await invoke("scan_all_models_cmd", { modelBase: null, providerId: null });
      onReload();
    } catch (e) { console.error("Batch scan failed:", e); }
    finally { setBatchScanState(s => ({ ...s, active: false })); }
  }, [models.length, onReload]);

  const handleCancelScan = useCallback(async () => {
    try { await invoke("cancel_gguf_scan_cmd"); } catch {}
  }, []);

  // Keyboard navigation
  const handleKeyboardSelect = useCallback((index: number) => {
    if (allFiltered[index]) handleSelect(allFiltered[index]);
  }, [allFiltered, handleSelect]);

  const handleLaunchFromConfig = useCallback(() => {
    window.dispatchEvent(new CustomEvent("blackops-launch-engine"));
  }, []);

  const { highlightIndex, zone } = useKeyboardNav({
    modelCount: allFiltered.length,
    onSelectModel: handleKeyboardSelect,
    onLaunch: handleLaunchFromConfig,
  });

  return {
    search, setSearch,
    catalogSelectedModel, setCatalogSelectedModel, handleSelect, handleSelectBySlot, clearEngineSelection,
    panelActiveModel, setPanelActiveModel,
    selectedSlotIdx, setSelectedSlotIdx,
    visibleCount, setVisibleCount,
    sortField, sortDirection, handleSort,
    pinnedModels, catalogModels, allFiltered,
    runningModelPaths, runningInstances, activeEngineByModel,
    getFitStatus,
    scanningPath, setScanningPath, handleScanModel,
    batchScanState, setBatchScanState, handleScanAll, handleCancelScan,
    highlightIndex, zone,
  };
}
