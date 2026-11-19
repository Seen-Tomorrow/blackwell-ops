import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ExtraFileEntry, GpuInfo, ModelEntry, ProviderConfig, StackEntry } from "../lib/types";
import { DEFAULT_PROVIDER_ID } from "../lib/types";
import { useKeyboardNav } from "./useKeyboardNav";
import { useTauriListen } from "./useTauriListen";
import { KEYS, loadLastModel, normalizeModelPathKey, readStorage, saveLastModel, subscribeStorage, writeStorage } from "../lib/storage";
import { dispatchAppEvent, EVENTS } from "../lib/events";
import {
  compareCatalogModels,
  SORT_FIRST_DIRECTION,
  type SortDirection,
  type SortField,
} from "../lib/catalogSort";

import {
  type CatalogDraftFilter,
  draftRoleFromModel,
  hasBakedMtp,
  isExternalDraftOnly,
  isAttachmentModel,
  isLaunchableMain,
  isUnclassifiedModel,
  matchesCatalogDraftFilter,
} from "../lib/specDraft";
import {
  endpointRoleForPath,
  isCatalogPinned,
  loadCatalogActiveSet,
  loadCatalogEndpoints,
  loadCatalogPins,
  loadCatalogRecents,
  loadCatalogSets,
  pushCatalogRecent,
  putCatalogEndpoint,
  removeCatalogEndpoint,
  replaceCatalogEndpoint,
  setCatalogActiveSet,
  toggleCatalogPin,
  type CatalogRecentEntry,
  type CatalogSetIndex,
  type EndpointRole,
  type EndpointSet,
} from "../lib/catalogQuickAccess";
import { deleteEndpointBag, pruneEndpointBags } from "../lib/endpointBags";
import {
  cancelMetadataScan,
  getMetadataJob,
  startMetadataScan,
  subscribeLibraryJobs,
  type ModelScanPatch,
} from "../lib/libraryJobs";

// Sort types and the ordering rule belong to the sort module; re-exported here
// because the catalog component has always imported its SortField from the hook.
export type { SortDirection, SortField } from "../lib/catalogSort";
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
  if (hasBakedMtp(m)) parts.push("mtp");
  if (draftRole === "external_dflash") parts.push("dflash", "draft");
  if (draftRole === "external_eagle3") parts.push("eagle3", "draft");
  if (draftRole === "external_mtp") parts.push("mtp", "draft");
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

/** Present an attachment as a read-only catalog row (EXTRA filter). */
function extraAsModel(e: ExtraFileEntry): ModelEntry {
  return {
    path: e.path,
    author: e.rootLabel || "extras",
    name: e.fileName,
    // The role chip on the card carries ENGRAM / MMPROJ / LORA — do not repeat the raw
    // role here (`ple` would surface as "PLE" in the quant slot and the glass meta).
    quant: "",
    size_str: e.sizeStr,
    vision: false,
    sourcePathLabel: e.rootLabel,
    fileRole: e.role,
    roleEvidence: e.roleEvidence,
  };
}

interface UseModelCatalogParams {
  models: ModelEntry[];
  /** Attachment GGUFs from extras roots — shown by the EXTRAS filter, never launchable. */
  extras?: ExtraFileEntry[];
  stack: StackEntry[];
  providers?: ProviderConfig[];
  /** Live GPU free memory for catalog fit-now chips (read-only; no forecast). */
  gpus?: GpuInfo[];
  scanningPath: string | null;
  setScanningPath: (p: string | null) => void;
  batchScanState: { active: boolean; scanned: number; failed: number; total: number };
  setBatchScanState: React.Dispatch<React.SetStateAction<{ active: boolean; scanned: number; failed: number; total: number }>>;
  /** Publish each probed model immediately (App patches its catalog array). */
  onModelScanned?: (path: string, patch: ModelScanPatch) => void;
  onReload: () => void;
}

export function useModelCatalog({
  models,
  extras = [],
  stack,
  providers,
  gpus = [],
  scanningPath,
  setScanningPath,
  batchScanState,
  setBatchScanState,
  onModelScanned,
  onReload,
}: UseModelCatalogParams) {
  const [search, setSearch] = useState("");
  const [draftFilter, setDraftFilter] = useState<CatalogDraftFilter>(() => {
    const v = readStorage(KEYS.catalogDraftFilter);
    if (v === "extras" || v === "all") return v;
    return "main";
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

  // Validate selected slot against stack — only clear when the slot is *known dead*.
  // Do not clear when idx is missing: stack-changed can lag launch_engine (preset multi-seat).
  useEffect(() => {
    if (selectedSlotIdxState === null || stack.length === 0) return;
    const entry = stack.find((s) => s.idx === selectedSlotIdxState);
    if (!entry) return; // wait for stack push
    if (entry.status !== "RUNNING" && entry.status !== "LOADING") {
      setSelectedSlotIdxState(null);
    }
  }, [stack, selectedSlotIdxState]);

  // Persist to localStorage on change + listen for slot-cleared to clear stale selection
  useEffect(() => {
    writeStorage(KEYS.selectedSlotIdx, String(selectedSlotIdxState ?? -1));
  }, [selectedSlotIdxState]);

  const setSelectedSlotIdx = useCallback((v: number | null) => {
    setSelectedSlotIdxState(v);
  }, []);

  // Agent harness: `automation ui --slot N` selects the running engine, which is what makes the
  // fusion dashboard (and therefore its memory log / bench controls) render.
  useTauriListen<{ command?: string; slot?: number | null }>(
    "automation-ui",
    (payload) => {
      if (payload?.command !== "select-slot") return;
      const slot = payload.slot;
      setSelectedSlotIdxState(typeof slot === "number" && slot >= 0 ? slot : null);
    },
    [],
  );
  const [sortField, setSortField] = useState<SortField>(() => {
    const v = readStorage(KEYS.sortField) as SortField | null;
    // NAME removed from UI (search covers it) — migrate legacy storage
    if (!v || v === "name") return "date";
    return v;
  });
  const [sortDirection, setSortDirection] = useState<SortDirection>(() => {
    const v = readStorage(KEYS.sortDir);
    return v === "asc" || v === "desc" ? v : "desc";
  });

  // Pins / recents / endpoint sets — path-only; launch knobs stay on the cockpit.
  const [catalogPins, setCatalogPins] = useState<string[]>(() => loadCatalogPins());
  const [catalogRecents, setCatalogRecents] = useState<CatalogRecentEntry[]>(() => loadCatalogRecents());
  const [catalogEndpoints, setCatalogEndpoints] = useState<EndpointSet>(() => loadCatalogEndpoints());
  const [activeSet, setActiveSetState] = useState<CatalogSetIndex>(() => loadCatalogActiveSet());

  // A hand-edited or older store may leave bags behind; the endpoint list owns id life.
  useEffect(() => {
    pruneEndpointBags(loadCatalogSets().flat().map((e) => e.id));
  }, []);
  /** Temporary: only the favorite just clicked sits at catalog top. */
  const [floatFavoritePath, setFloatFavoritePath] = useState<string | null>(null);
  // After onboarding — pick first scannable model when nothing is selected (fresh install has no lastModel).
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ active?: boolean }>).detail;
      if (detail?.active !== false) return;
      if (panelActiveModel) return;
      // A saved path only counts when it still exists in the catalog — a stale
      // one must not block the post-setup auto-pick.
      const savedPath = loadLastModel();
      if (savedPath && findModelByPath(models, savedPath)) return;
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
    const match = savedPath ? findModelByPath(models, savedPath) : undefined;
    if (match) {
      applyCatalogSelection(match, setCatalogSelectedModel, setPanelActiveModel);
      restoreAttemptedRef.current = true;
      return;
    }

    // Saved path resolved to nothing in this catalog — the library moved, the
    // folder was removed, or config was reset. Falling through to the default
    // pick matters: returning here left the OPS pane on a permanent
    // “SELECT A MODEL” even though the catalog was full.
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

  // Listen for engine launch event — deterministic auto-select from backend return value
  useEffect(() => {
    const onLaunch = (e: Event) => {
      const detail = (e as CustomEvent).detail as { slotIdx: number; modelPath: string };
      if (detail?.slotIdx !== undefined) {
        setSelectedSlotIdx(detail.slotIdx);
        if (detail.modelPath) {
          saveLastModel(detail.modelPath);
          setCatalogRecents(pushCatalogRecent(detail.modelPath));
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
          if (saved != null && Number(saved) === payload.slot) setSelectedSlotIdx(null);
        } catch {}
      }
    };
    const onEndpointsChanged = () => {
      setCatalogEndpoints(loadCatalogEndpoints());
      setActiveSetState(loadCatalogActiveSet());
    };
    window.addEventListener(EVENTS.engineLaunched, onLaunch);
    window.addEventListener(EVENTS.stopAll, onStopAll);
    window.addEventListener(EVENTS.slotCleared, onSlotCleared);
    window.addEventListener(EVENTS.catalogEndpointsChanged, onEndpointsChanged);
    return () => {
      window.removeEventListener(EVENTS.engineLaunched, onLaunch);
      window.removeEventListener(EVENTS.stopAll, onStopAll);
      window.removeEventListener(EVENTS.slotCleared, onSlotCleared);
      window.removeEventListener(EVENTS.catalogEndpointsChanged, onEndpointsChanged);
    };
  }, [models]);

  const handleSelect = useCallback((model: ModelEntry) => {
    setCatalogSelectedModel(model);
    setPanelActiveModel(model);
    setSelectedSlotIdx(null); // Generic selection — clear engine-specific pairing
    saveLastModel(model.path);
    setFloatFavoritePath(isCatalogPinned(model.path, catalogPins) ? model.path : null);
  }, [catalogPins]);

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
      setSortDirection(SORT_FIRST_DIRECTION[field] ?? "asc");
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

  const handleTogglePin = useCallback((model: ModelEntry) => {
    setCatalogPins(toggleCatalogPin(model.path));
  }, []);

  const handleTogglePinPath = useCallback((path: string) => {
    setCatalogPins(toggleCatalogPin(path));
  }, []);

  /** Assign the selected model to BRAIN, or refresh WORKER's empty slot. */
  const handleAssignEndpoint = useCallback(
    (role: EndpointRole, path?: string | null, model?: ModelEntry | null) => {
      const target = path ?? model?.path ?? catalogSelectedModel?.path ?? panelActiveModel?.path;
      if (!target) return;
      const next = putCatalogEndpoint(loadCatalogActiveSet(), role, target);
      setCatalogEndpoints(next.endpoints);
      if (next.ok) dispatchAppEvent(EVENTS.catalogEndpointsChanged);
    },
    [catalogSelectedModel, panelActiveModel],
  );

  /** `+` adds the selected model as a WORKER (BRAIN is filled separately). */
  const handleAddEndpoint = useCallback(
    (path?: string | null, model?: ModelEntry | null) => {
      const target = path ?? model?.path ?? catalogSelectedModel?.path ?? panelActiveModel?.path;
      if (!target) return;
      const next = putCatalogEndpoint(loadCatalogActiveSet(), "worker", target);
      setCatalogEndpoints(next.endpoints);
      if (next.ok) dispatchAppEvent(EVENTS.catalogEndpointsChanged);
    },
    [catalogSelectedModel, panelActiveModel],
  );

  const handleReplaceEndpoint = useCallback((id: string, path: string) => {
    const next = replaceCatalogEndpoint(loadCatalogActiveSet(), id, path);
    setCatalogEndpoints(next.endpoints);
    if (next.ok) dispatchAppEvent(EVENTS.catalogEndpointsChanged);
  }, []);

  const handleRemoveEndpoint = useCallback((id: string) => {
    setCatalogEndpoints(removeCatalogEndpoint(loadCatalogActiveSet(), id));
    deleteEndpointBag(id);
    dispatchAppEvent(EVENTS.catalogEndpointsChanged);
  }, []);

  const handleSelectSet = useCallback((index: CatalogSetIndex) => {
    const next = setCatalogActiveSet(index);
    setActiveSetState(next.activeSet);
    setCatalogEndpoints(next.endpoints);
  }, []);

  const isPinned = useCallback(
    (path: string) => isCatalogPinned(path, catalogPins),
    [catalogPins],
  );

  const getEndpointRole = useCallback(
    (path: string) => endpointRoleForPath(path, catalogEndpoints),
    [catalogEndpoints],
  );

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
    // Same per-model runner as the first-run backfill: each model is published
    // as it lands instead of one batch reload at the end.
    await startMetadataScan({
      models,
      firstPath: panelActiveModel?.path ?? loadLastModel(),
      concurrency: concurrency && concurrency > 0 ? concurrency : 3,
      onModelScanned,
      // Header strip reads this to say MANUAL SCAN instead of ONE-TIME SCAN.
      manual: true,
    });
    onReload();
  }, [models, onModelScanned, onReload, panelActiveModel?.path]);

  const handleCancelScan = useCallback(async () => {
    cancelMetadataScan();
  }, []);

  // The catalog's scan chrome mirrors the shared job (whoever started it).
  useEffect(() => {
    const sync = () => {
      const job = getMetadataJob();
      setBatchScanState({
        active: job.status === "running",
        scanned: job.done,
        failed: job.failed,
        total: job.total,
      });
    };
    sync();
    return subscribeLibraryJobs(sync);
  }, [setBatchScanState]);

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

  // MAIN = launchable model rows; EXTRAS = every companion (attachments + draft heads);
  // ALL = the whole library, models and companions together (debug view).
  const kindRows = useMemo(() => {
    // A file the classifier could not place is not a companion: it is a main model whose
    // header was unreadable (an interrupted download, typically), so it stays in MAIN.
    // EXTRAS holds everything that is NOT a main model.
    const draftRows = models.filter((m) => isExternalDraftOnly(m));
    const mainRows = models.filter((m) => !isExternalDraftOnly(m) && !isAttachmentModel(m));
    // Interrupted downloads, whatever kind they would have been.
    const incompleteRows = models.filter((m) => m.completeness === "incomplete");
    return { mainRows, draftRows, incompleteRows, extrasRows: extras.map(extraAsModel) };
  }, [models, extras]);

  const kindCounts = useMemo(
    () => ({
      main: kindRows.mainRows.length,
      extras: kindRows.extrasRows.length + kindRows.draftRows.length,
      all: models.length + extras.length,
      incomplete: kindRows.incompleteRows.length,
    }),
    [kindRows, models.length, extras.length],
  );

  // Fit-now + sorted/filtered list (after FIT cache is available; no forecast calls)
  const catalogModels = useMemo(() => {
    // EXTRAS is its own list, not a filter over models: those rows are attachments
    // (PLE/Engram tables, projectors). ALL shows models and attachments together.
    const { extrasRows, draftRows, mainRows, incompleteRows } = kindRows;
    const pool =
      draftFilter === "incomplete"
        ? incompleteRows
        : draftFilter === "extras"
          ? [...extrasRows, ...draftRows]
          : draftFilter === "all"
          ? // ALL is models + companion files. Unknown rows are already in `models`, and
            // `extrasRows` carries them for the EXTRAS filter — do not add them twice.
            [...models, ...extras.map(extraAsModel)]
          : mainRows;
    let sorted = [...pool].sort((a, b) =>
      compareCatalogModels(a, b, sortField, sortDirection),
    );

    const searchWords = search.trim()
      ? search.toLowerCase().trim().split(/\s+/)
      : null;

    if (draftFilter !== "extras") {
      sorted = sorted.filter((m) => matchesCatalogDraftFilter(m, draftFilter));
    }

    if (searchWords) {
      sorted = sorted.filter(m => modelMatchesSearch(m, searchWords));
    }


    // Clicking a favorite briefly floats *that* card to top — not the whole pin list.
    if (floatFavoritePath) {
      const key = normalizeModelPathKey(floatFavoritePath);
      const hit = sorted.find((m) => normalizeModelPathKey(m.path) === key);
      if (hit) {
        sorted = [hit, ...sorted.filter((m) => normalizeModelPathKey(m.path) !== key)];
      }
    }

    return sorted;
  }, [
    models,
    extras,
    kindRows,
    sortField,
    sortDirection,
    search,
    draftFilter,
    floatFavoritePath,
  ]);

  useEffect(() => {
    setFloatFavoritePath(null);
  }, [sortField, sortDirection, search, draftFilter]);

  const setCatalogDraftFilter = useCallback((filter: CatalogDraftFilter) => {
    setDraftFilter(filter);
    writeStorage(KEYS.catalogDraftFilter, filter);
  }, []);

  const handleSelectPath = useCallback(
    (path: string) => {
      const m = findModelByPath(models, path);
      if (m) handleSelect(m);
    },
    [models, handleSelect],
  );

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
    kindCounts,
    catalogSelectedModel, setCatalogSelectedModel, handleSelect, handleSelectBySlot, clearEngineSelection,
    panelActiveModel, setPanelActiveModel,
    selectedSlotIdx: selectedSlotIdxState, setSelectedSlotIdx,
    sortField, sortDirection, handleSort,
    catalogModels,
    runningModelPaths, runningInstances, activeEngineByModel,
    scanningPath, setScanningPath, handleScanModel,
    batchScanState, setBatchScanState, handleScanAll, handleCancelScan,
    handleDeleteModel, handleRenameModel,
    // Quick access (pins / recents / endpoint sets)
    catalogPins, catalogRecents, catalogEndpoints, activeSet,
    handleTogglePin, handleTogglePinPath,
    handleAssignEndpoint, handleAddEndpoint, handleReplaceEndpoint, handleRemoveEndpoint,
    handleSelectSet, handleSelectPath,
    isPinned, getEndpointRole,
    zone,
  };
}
