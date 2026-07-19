import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FitScanFull, FitScanProgress, ModelEntry, ProviderConfig, StackEntry } from "../lib/types";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import { useKeyboardNav } from "./useKeyboardNav";
import { useTauriListen } from "./useTauriListen";
import { KEYS, loadLastModel, normalizeModelPathKey, readStorage, saveLastModel, writeStorage } from "../lib/storage";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import { bootstrapFitScanCache } from "../lib/fitScanSessionStore";
import {
  FIT_SCAN_POINTS_TOTAL,
  findFitScanEntry,
  fitScanBadgeLabel,
  mergeFitScanProgressPoint,
  modelHasCompleteFitScan,
} from "../lib/fitScanTable";
import {
  type CatalogDraftFilter,
  draftRoleFromModel,
  isLaunchableMain,
  matchesCatalogDraftFilter,
} from "../lib/specDraft";

export type SortField = (keyof ModelEntry) | "date";
export type SortDirection = "asc" | "desc";
function modelFileName(path: string): string {
  const normalized = path.replace(/[/\\]+$/, "");
  const slash = Math.max(normalized.lastIndexOf("/"), normalized.lastIndexOf("\\"));
  return (slash >= 0 ? normalized.slice(slash + 1) : normalized).toLowerCase();
}

/** Non-quant free-text fields (name/author only — quant is matched via extractModelQuants). */
function modelGeneralSearchText(m: ModelEntry): string {
  const parts = [m.name, m.author];
  const meta = m.metadata;
  if (meta) {
    const rawTotal = meta.modelTypeLabel || meta.total_params_str;
    const numPart = parseFloat(String(rawTotal).replace(/[^0-9.]/g, ""));
    if (!isNaN(numPart)) {
      parts.push(meta.n_expert_used > 0 ? "moe" : "dense");
    }
    if ((meta.nextn_predict_layers ?? 0) > 0) parts.push("mtp");
  }
  const draftRole = draftRoleFromModel(m);
  if (draftRole === "external_dflash") parts.push("dflash", "draft");
  if (draftRole === "external_eagle3") parts.push("eagle3", "draft");
  return parts.join(" ").toLowerCase();
}

/**
 * Canonical quant string for matching.
 * Llama print_info uses "Q4_K - Medium"; normalize to q4_k_m. XL stays _xl.
 */
function normalizeQuantTag(raw: string): string {
  return raw
    .toLowerCase()
    .trim()
    .replace(/^\.+|\.+$/g, "")
    .replace(/\.gguf$/i, "")
    // "Q4_K - Medium" / "Q4_K-Medium" → q4_k_medium then _m
    .replace(/\s*-\s*/g, "_")
    .replace(/\s+/g, "_")
    .replace(/_medium\b/g, "_m")
    .replace(/_small\b/g, "_s")
    .replace(/_large\b/g, "_l")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

/**
 * Quant for search = GGUF scan `file_type_str` only when metadata exists.
 * Do NOT merge filename-derived `model.quant` — catalog historically filled that from the path,
 * which made UD-Q4_K_XL (header: "Q4_K - Medium") match both `xl` and `medium`.
 */
function extractModelQuants(m: ModelEntry): string[] {
  const found = new Set<string>();
  const push = (raw: string | undefined | null) => {
    if (!raw) return;
    const trimmed = raw.trim();
    if (!trimmed || trimmed.toUpperCase() === "GGUF" || trimmed === "unknown") return;
    const n = normalizeQuantTag(trimmed);
    if (!n) return;
    if (
      /^(?:iq|q)\d/.test(n) ||
      /^(?:nvfp4|mxfp4|fp16|bf16|f16|f32)$/.test(n)
    ) {
      found.add(n);
    }
  };

  if (m.metadata) {
    push(m.metadata.file_type_str);
  } else {
    // Unscanned row — quant is filename heuristic only; still better than nothing for lazy search
    push(m.quant);
  }

  return [...found];
}

/** Size-tier shortcuts lazy users type (whole word only). */
const QUANT_SIZE_SHORTCUTS: Record<string, string[]> = {
  xl: ["_xl"],
  xxl: ["_xxl"],
  xs: ["_xs"],
  xxs: ["_xxs"],
  medium: ["_m", "_medium"],
  small: ["_s", "_small"],
  large: ["_l", "_large"], // not xl
  // bare m/s/l — only match as quant *suffix*, never free-text
  m: ["_m"],
  s: ["_s"],
  l: ["_l"],
};

function isQuantSearchWord(word: string): boolean {
  const w = word.toLowerCase().replace(/^_+/, "");
  if (QUANT_SIZE_SHORTCUTS[w]) return true;
  if (/^iq\d*$/.test(w)) return true; // iq, iq2, iq3, iq4
  if (/^q\d+$/.test(w)) return true; // q4, q5, q6, q8
  if (/^(?:iq|q)\d/.test(w)) return true; // q4_k_xl, iq3_xxs
  if (/^(?:nvfp4|mxfp4|fp16|bf16)$/.test(w)) return true;
  if (w === "_m" || w === "_s" || w === "_l" || w === "_xl") return true;
  return false;
}

/**
 * Match one search word against a model's quant set.
 * Returns null if the word is general text (caller uses name/author includes).
 */
function quantWordMatches(quants: string[], word: string): boolean | null {
  const w = word.toLowerCase().replace(/^_+/, "");
  if (!isQuantSearchWord(word) && !isQuantSearchWord(w)) return null;

  const norms = quants.map(normalizeQuantTag);

  // Size shortcuts: xl → *_xl only; medium/m → *_m (not xl)
  const sizeSufs = QUANT_SIZE_SHORTCUTS[w];
  if (sizeSufs) {
    return norms.some((q) => sizeSufs.some((suf) => q.endsWith(suf)));
  }

  // iq → any iq*; iq3 → iq3*
  if (w === "iq") {
    return norms.some((q) => q.startsWith("iq"));
  }
  if (/^iq\d+$/.test(w)) {
    return norms.some((q) => q === w || q.startsWith(`${w}_`));
  }

  // q4 → q4* but never iq4*
  if (/^q\d+$/.test(w)) {
    return norms.some((q) => (q === w || q.startsWith(`${w}_`) || q.startsWith(w)) && !q.startsWith("iq"));
  }

  // Full / long tags: q4_k_xl, iq4_xs, q8_0
  const want = normalizeQuantTag(w);
  return norms.some((q) => q === want || q.startsWith(`${want}_`));
}

function modelMatchesSearch(m: ModelEntry, words: string[]): boolean {
  const quants = extractModelQuants(m);
  const general = modelGeneralSearchText(m);

  return words.every((word) => {
    const q = quantWordMatches(quants, word);
    if (q !== null) {
      // Quant words only match GGUF header quant — never path/name guesswork.
      // Unscanned models (no quant yet) simply do not match quant queries.
      return q;
    }
    const w = word.toLowerCase();
    // Free text: name / author / badges only (not path)
    return general.includes(w);
  });
}

function findModelByPath(models: ModelEntry[], path: string): ModelEntry | undefined {
  const key = normalizeModelPathKey(path);
  const exact = models.find((m) => normalizeModelPathKey(m.path) === key);
  if (exact) return exact;

  // Merge dedup may keep a different folder path for the same file identity.
  const base = modelFileName(path);
  if (!base) return undefined;
  const byFileName = models.filter((m) => modelFileName(m.path) === base);
  return byFileName.length === 1 ? byFileName[0] : undefined;
}

function pickDefaultCatalogModel(models: ModelEntry[]): ModelEntry | undefined {
  const sorted = [...models].sort((a, b) => a.name.localeCompare(b.name));
  return (
    sorted.find((m) => m.metadata && isLaunchableMain(m))
    ?? sorted.find((m) => isLaunchableMain(m))
    ?? sorted.find((m) => m.metadata)
    ?? sorted[0]
  );
}

function applyCatalogSelection(
  model: ModelEntry,
  setCatalogSelectedModel: (m: ModelEntry) => void,
  setPanelActiveModel: (m: ModelEntry) => void,
): void {
  setCatalogSelectedModel(model);
  setPanelActiveModel(model);
  saveLastModel(model.path);
}

interface UseModelCatalogParams {
  models: ModelEntry[];
  stack: StackEntry[];
  providers?: ProviderConfig[];
  scanningPath: string | null;
  setScanningPath: (p: string | null) => void;
  batchScanState: { active: boolean; scanned: number; failed: number; total: number };
  setBatchScanState: React.Dispatch<React.SetStateAction<{ active: boolean; scanned: number; failed: number; total: number }>>;
  onReload: () => void;
}

export function useModelCatalog({
  models,
  stack,
  providers,
  scanningPath,
  setScanningPath,
  batchScanState,
  setBatchScanState,
  onReload,
}: UseModelCatalogParams) {
  const [search, setSearch] = useState("");
  const [draftFilter, setDraftFilter] = useState<CatalogDraftFilter>(() => {
    const v = readStorage(KEYS.catalogDraftFilter);
    if (v === "draft" || v === "all") return v;
    return "regular";
  });
  // Visual highlight in catalog list only — set by catalog card clicks
  const [catalogSelectedModel, setCatalogSelectedModel] = useState<ModelEntry | null>(null);
  // Right panel active model — set by catalog OR mini card clicks
  const [panelActiveModel, setPanelActiveModel] = useState<ModelEntry | null>(null);
  const restoreAttemptedRef = useRef(false);
  const [selectedSlotIdxState, setSelectedSlotIdxState] = useState<number | null>(() => {
    try {
      const saved = readStorage(KEYS.selectedSlotIdx);
      return saved ? parseInt(saved) : null;
    } catch { return null; }
  });

  // Validate restored slotIdx against current stack — discard if engine no longer running
  useEffect(() => {
    if (selectedSlotIdxState === null || stack.length === 0) return;
    const stillRunning = stack.some(s => s.idx === selectedSlotIdxState && (s.status === "RUNNING" || s.status === "LOADING"));
    if (!stillRunning) setSelectedSlotIdxState(null);
  }, [stack, selectedSlotIdxState]);

  // Persist to localStorage on change + listen for slot-cleared to clear stale selection
  useEffect(() => {
    writeStorage(KEYS.selectedSlotIdx, String(selectedSlotIdxState ?? -1));
  }, [selectedSlotIdxState]);

  const setSelectedSlotIdx = useCallback((v: number | null) => {
    setSelectedSlotIdxState(v);
  }, []);
  const [visibleCount, setVisibleCount] = useState<"4" | "6" | "8" | "all">(() => {
    const v = readStorage(KEYS.catalogVisibleCount);
    if (v === "4" || v === "6" || v === "8" || v === "all") return v;
    return "all";
  });
  const [sortField, setSortField] = useState<SortField>(() => {
    const v = readStorage(KEYS.sortField) as SortField | null;
    return v || "date";
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    const v = readStorage(KEYS.sortDir);
    return v === "asc" || v === "desc" ? v : "desc";
  });

  // After onboarding — pick first scannable model when nothing is selected (fresh install has no lastModel).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ active?: boolean }>).detail;
      if (detail?.active !== false) return;
      if (panelActiveModel || loadLastModel()) return;
      const pick = pickDefaultCatalogModel(models);
      if (!pick) return;
      applyCatalogSelection(pick, setCatalogSelectedModel, setPanelActiveModel);
    };
    window.addEventListener(EVENTS.setupGuideChanged, handler);
    return () => window.removeEventListener(EVENTS.setupGuideChanged, handler);
  }, [models, panelActiveModel]);

  // Restore last model from localStorage once catalog is available. Do not overwrite a
  // valid saved path when match fails (merge dedup may expose a different path for the
  // same identity, or the catalog may still be loading).
  useEffect(() => {
    if (models.length === 0 || panelActiveModel !== null) return;

    const savedPath = loadLastModel();
    if (savedPath) {
      const match = findModelByPath(models, savedPath);
      if (match) {
        applyCatalogSelection(match, setCatalogSelectedModel, setPanelActiveModel);
        restoreAttemptedRef.current = true;
      }
      return;
    }

    if (restoreAttemptedRef.current) return;
    const pick = pickDefaultCatalogModel(models);
    if (!pick) return;
    applyCatalogSelection(pick, setCatalogSelectedModel, setPanelActiveModel);
    restoreAttemptedRef.current = true;
  }, [models, panelActiveModel]);

  // Persist whenever the right-panel model changes (catalog click, engine pick, launch, restore).
  useEffect(() => {
    if (panelActiveModel?.path) {
      saveLastModel(panelActiveModel.path);
    }
  }, [panelActiveModel?.path]);

  // Refresh catalog selected model reference when models array updates
  useEffect(() => {
    if (!catalogSelectedModel || models.length === 0) return;
    const fresh = findModelByPath(models, catalogSelectedModel.path);
    if (fresh && fresh !== catalogSelectedModel) {
      setCatalogSelectedModel(fresh);
    }
  }, [models, catalogSelectedModel]);

  // Refresh panel active model reference when models array updates
  useEffect(() => {
    if (!panelActiveModel || models.length === 0) return;
    const fresh = findModelByPath(models, panelActiveModel.path);
    if (fresh && fresh !== panelActiveModel) {
      setPanelActiveModel(fresh);
    }
  }, [models, panelActiveModel]);

  // Persist sort state
  useEffect(() => { writeStorage(KEYS.sortField, sortField); }, [sortField]);
  useEffect(() => { writeStorage(KEYS.sortDir, sortDirection); }, [sortDirection]);
  useEffect(() => { writeStorage(KEYS.catalogVisibleCount, visibleCount); }, [visibleCount]);

  // Listen for engine launch event — deterministic auto-select from backend return value
  useEffect(() => {
    const onLaunch = (e: Event) => {
      const detail = (e as CustomEvent).detail as { slotIdx: number; modelPath: string };
      if (detail?.slotIdx !== undefined) {
        setSelectedSlotIdx(detail.slotIdx);
        if (detail.modelPath) {
          saveLastModel(detail.modelPath);
        }
        setPanelActiveModel(findModelByPath(models, detail.modelPath) || null);
      }
    };
    const onStopAll = () => {
      setSelectedSlotIdx(null);
    };
    const onSlotCleared = (e: Event) => {
      const payload = (e as CustomEvent).detail as { slot: number };
      if (payload?.slot !== undefined) {
        try {
          const saved = readStorage(KEYS.selectedSlotIdx);
          if (saved && parseInt(saved) === payload.slot) setSelectedSlotIdx(null);
        } catch {}
      }
    };
    window.addEventListener(EVENTS.engineLaunched, onLaunch);
    window.addEventListener(EVENTS.stopAll, onStopAll);
    window.addEventListener(EVENTS.slotCleared, onSlotCleared);
    return () => {
      window.removeEventListener(EVENTS.engineLaunched, onLaunch);
      window.removeEventListener(EVENTS.stopAll, onStopAll);
      window.removeEventListener(EVENTS.slotCleared, onSlotCleared);
    };
  }, [models]);

  const handleSelect = useCallback((model: ModelEntry) => {
    setCatalogSelectedModel(model);
    setPanelActiveModel(model);
    setSelectedSlotIdx(null); // Generic selection — clear engine-specific pairing
    saveLastModel(model.path);
  }, []);

  // Select a specific running engine instance by slot index (for mini card clicks)
  const handleSelectBySlot = useCallback((slotIdx: number) => {
    const entry = stack.find(s => s.idx === slotIdx && (s.status === "RUNNING" || s.status === "LOADING"));
    if (entry?.model_path) {
      const model = findModelByPath(models, entry.model_path);
      if (model) {
        setPanelActiveModel(model);
        setSelectedSlotIdx(slotIdx);
        saveLastModel(model.path);
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

  // Sorted + filtered model list — flat catalog (running engines shown on right panel only)
  const catalogModels = useMemo(() => {
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

    const searchWords = search.trim()
      ? search.toLowerCase().trim().split(/\s+/)
      : null;

    sorted = sorted.filter((m) => matchesCatalogDraftFilter(m, draftFilter));

    if (searchWords) {
      sorted = sorted.filter(m => modelMatchesSearch(m, searchWords));
    }

    return sorted;
  }, [models, sortField, sortDirection, search, draftFilter]);

  const setCatalogDraftFilter = useCallback((filter: CatalogDraftFilter) => {
    setDraftFilter(filter);
    writeStorage(KEYS.catalogDraftFilter, filter);
  }, []);

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

  const handleScanAll = useCallback(async (concurrency?: number) => {
    setBatchScanState({ active: true, scanned: 0, failed: 0, total: models.length });
    try {
      await invoke("scan_all_models_cmd", { modelBase: null, providerId: null, concurrency: concurrency ? concurrency : undefined });
      onReload();
    } catch (e) { console.error("Batch scan failed:", e); }
    finally { setBatchScanState(s => ({ ...s, active: false })); }
  }, [models.length, onReload]);

  const handleCancelScan = useCallback(async () => {
    try { await invoke("cancel_gguf_scan_cmd"); } catch {}
  }, []);

  const clearModelSelection = useCallback(() => {
    setCatalogSelectedModel(null);
    setPanelActiveModel(null);
  }, []);

  const handleDeleteModel = useCallback(async (model: ModelEntry) => {
    await invoke("delete_model_file_cmd", { path: model.path });
    if (catalogSelectedModel?.path === model.path || panelActiveModel?.path === model.path) {
      clearModelSelection();
    }
    await onReload();
  }, [catalogSelectedModel, panelActiveModel, clearModelSelection, onReload]);

  const handleRenameModel = useCallback(async (model: ModelEntry, newFileName: string) => {
    const newPath = await invoke<string>("rename_model_file_cmd", {
      path: model.path,
      newFileName,
    });
    if (catalogSelectedModel?.path === model.path) {
      setCatalogSelectedModel({ ...model, path: newPath });
    }
    if (panelActiveModel?.path === model.path) {
      setPanelActiveModel({ ...model, path: newPath });
      saveLastModel(newPath);
    }
    await onReload();
  }, [catalogSelectedModel, panelActiveModel, onReload]);

  const [fitProviderId, setFitProviderId] = useState(
    () => readStorage(KEYS.lastProvider) || DEFAULT_PROVIDER_ID,
  );
  const [fitScanResults, setFitScanResults] = useState<Record<string, FitScanFull>>({});
  const [fitScanPointsTotal, setFitScanPointsTotal] = useState(FIT_SCAN_POINTS_TOTAL);
  const [fitScanningPaths, setFitScanningPaths] = useState<Set<string>>(() => new Set());
  const [fitScanActiveLabels, setFitScanActiveLabels] = useState<Record<string, string>>({});
  const fitScanInFlightRef = useRef(new Set<string>());
  const fitScanningPathsRef = useRef(fitScanningPaths);
  fitScanningPathsRef.current = fitScanningPaths;

  const reloadFitScanCache = useCallback(async (providerId: string) => {
    const cached = await bootstrapFitScanCache(providerId);
    if (cached) {
      setFitScanResults(cached.results);
      setFitScanPointsTotal(cached.scan_points_total ?? FIT_SCAN_POINTS_TOTAL);
    } else {
      setFitScanResults({});
      setFitScanPointsTotal(FIT_SCAN_POINTS_TOTAL);
    }
  }, []);

  useEffect(() => {
    void reloadFitScanCache(fitProviderId);
  }, [fitProviderId, reloadFitScanCache]);

  useEffect(() => {
    const onProviderChanged = (e: Event) => {
      const detail = (e as CustomEvent<{ providerId?: string }>).detail;
      const next = detail?.providerId || readStorage(KEYS.lastProvider) || DEFAULT_PROVIDER_ID;
      setFitProviderId(next);
    };
    const onFitCacheChanged = () => {
      const pid = readStorage(KEYS.lastProvider) || DEFAULT_PROVIDER_ID;
      void reloadFitScanCache(pid);
    };
    window.addEventListener(EVENTS.providerChanged, onProviderChanged);
    window.addEventListener(EVENTS.fitScanCacheChanged, onFitCacheChanged);
    return () => {
      window.removeEventListener(EVENTS.providerChanged, onProviderChanged);
      window.removeEventListener(EVENTS.fitScanCacheChanged, onFitCacheChanged);
    };
  }, [reloadFitScanCache]);

  useTauriListen<FitScanProgress>("fit-scan-progress", (evt) => {
    if (!evt.model_path) return;
    if (evt.status === "scanning") {
      if (fitScanningPathsRef.current.has(evt.model_path) && evt.label) {
        setFitScanActiveLabels((prev) => ({ ...prev, [evt.model_path]: evt.label! }));
      }
      if (evt.scan_points_total) setFitScanPointsTotal(evt.scan_points_total);
      return;
    }
    setFitScanResults((prev) => {
      const entry = findFitScanEntry(prev, evt.model_path);
      if (evt.status === "skipped") {
        return {
          ...prev,
          [evt.model_path]: {
            model_path: evt.model_path,
            points: [],
            skip_reason: evt.skip_reason,
          },
        };
      }
      if (evt.status === "point_skipped" && evt.label) {
        const prevSkipped = { ...(entry?.skipped_points ?? {}) };
        if (evt.skip_reason) prevSkipped[evt.label] = evt.skip_reason;
        return {
          ...prev,
          [evt.model_path]: {
            model_path: evt.model_path,
            points: entry?.points ?? [],
            error: entry?.error,
            skip_reason: entry?.skip_reason,
            skipped_points: prevSkipped,
          },
        };
      }
      if (evt.status === "complete" && evt.vram_mib != null && evt.label) {
        return {
          ...prev,
          [evt.model_path]: mergeFitScanProgressPoint(entry, evt.model_path, evt.label, evt.vram_mib),
        };
      }
      return prev;
    });
  });

  const fitScanAvailable = useMemo(() => {
    if (!providers?.length) return true;
    const provider = providers.find((p) => p.id === fitProviderId);
    return Boolean(provider?.enabled);
  }, [fitProviderId, providers]);

  const getFitScanBadge = useCallback(
    (model: ModelEntry) => {
      const entry = findFitScanEntry(fitScanResults, model.path);
      return fitScanBadgeLabel(entry, fitScanPointsTotal);
    },
    [fitScanResults, fitScanPointsTotal],
  );

  const modelNeedsFitScan = useCallback(
    (model: ModelEntry) => {
      if (!model.metadata) return false;
      const entry = findFitScanEntry(fitScanResults, model.path);
      return !modelHasCompleteFitScan(entry, fitScanPointsTotal);
    },
    [fitScanResults, fitScanPointsTotal],
  );

  const isFitScanning = useCallback(
    (modelPath: string) => fitScanningPaths.has(modelPath),
    [fitScanningPaths],
  );

  const getFitScanActiveLabel = useCallback(
    (modelPath: string) => fitScanActiveLabels[modelPath] ?? null,
    [fitScanActiveLabels],
  );

  const handleFitScanModel = useCallback((model: ModelEntry) => {
    if (!model.metadata || fitScanInFlightRef.current.has(model.path)) return;
    fitScanInFlightRef.current.add(model.path);
    setFitScanningPaths((prev) => new Set(prev).add(model.path));
    setFitScanActiveLabels((prev) => ({ ...prev, [model.path]: "" }));

    void invoke<FitScanFull>("fit_scan_single_model", {
      modelPath: model.path,
      providerId: fitProviderId,
      forceRescan: false,
    })
      .then(() => reloadFitScanCache(fitProviderId))
      .then(() => dispatchAppEvent(EVENTS.fitScanCacheChanged))
      .catch((e) => console.error("FIT scan failed:", e))
      .finally(() => {
        fitScanInFlightRef.current.delete(model.path);
        setFitScanningPaths((prev) => {
          const next = new Set(prev);
          next.delete(model.path);
          return next;
        });
        setFitScanActiveLabels((prev) => {
          const { [model.path]: _removed, ...rest } = prev;
          return rest;
        });
      });
  }, [fitProviderId, reloadFitScanCache]);

  // Keyboard navigation
  const handleKeyboardSelect = useCallback((index: number) => {
    if (catalogModels[index]) handleSelect(catalogModels[index]);
  }, [catalogModels, handleSelect]);

  const handleLaunchFromConfig = useCallback((highlightIndex: number) => {
    const highlighted = catalogModels[highlightIndex];
    if (highlighted) handleSelect(highlighted);
    // Defer one tick so EngineConfigPanel receives the updated model prop.
    window.setTimeout(() => dispatchAppEvent(EVENTS.launchEngine), 0);
  }, [catalogModels, handleSelect]);

  const { zone } = useKeyboardNav({
    modelCount: catalogModels.length,
    onSelectModel: handleKeyboardSelect,
    onLaunch: handleLaunchFromConfig,
  });

  return {
    search, setSearch,
    draftFilter, setCatalogDraftFilter,
    catalogSelectedModel, setCatalogSelectedModel, handleSelect, handleSelectBySlot, clearEngineSelection,
    panelActiveModel, setPanelActiveModel,
    selectedSlotIdx: selectedSlotIdxState, setSelectedSlotIdx,
    visibleCount, setVisibleCount,
    sortField, sortDirection, handleSort,
    catalogModels,
    runningModelPaths, runningInstances, activeEngineByModel,
    scanningPath, setScanningPath, handleScanModel,
    batchScanState, setBatchScanState, handleScanAll, handleCancelScan,
    handleDeleteModel, handleRenameModel,
    fitScanAvailable, isFitScanning, getFitScanActiveLabel, getFitScanBadge, modelNeedsFitScan, handleFitScanModel,
    fitScanningCount: fitScanningPaths.size,
    zone,
  };
}
