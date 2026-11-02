import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-shell';
import type { DownloadTargetCheck, DiskCheckResult, GgufFile, GgufRole, GgufShard, HfModel, HfModelInfo, HfSearchResponse, HfRepoUpdateStatus } from '@/lib/types';
import { useModelHubSplitResize } from '../hooks/useCatalogSplitResize';
import QuantBadge from './QuantBadge';
import VramFitBadge from './VramFitBadge';
import ModelStatsRow from './ModelStatsRow';

function hfModelUrl(modelId: string): string {
  return `https://huggingface.co/${modelId}`;
}

function parseHfRepoParts(modelId: string): { hfAuthor: string; repoName: string } {
  const slashIdx = modelId.indexOf('/');
  if (slashIdx <= 0 || slashIdx >= modelId.length - 1) {
    return { hfAuthor: 'unknown', repoName: modelId };
  }
  return {
    hfAuthor: modelId.slice(0, slashIdx),
    repoName: modelId.slice(slashIdx + 1),
  };
}

function shardCount(file: GgufFile): number {
  return file.shardCount ?? file.shards?.length ?? 1;
}

function getDownloadParts(file: GgufFile): GgufShard[] {
  if (file.shards?.length) return file.shards;
  const pathInRepo = file.url.split('/resolve/main/')[1] || `${file.type}.gguf`;
  const fileName = pathInRepo.split('/').pop() || `${file.type}.gguf`;
  return [{
    fileName,
    pathInRepo,
    size_bytes: file.size_bytes,
    url: file.url,
    lfsOid: file.lfsOid,
  }];
}

function collectGgufRepoPaths(files: GgufFile[]): string[] {
  const paths: string[] = [];
  for (const file of files) {
    for (const part of getDownloadParts(file)) {
      if (part.pathInRepo) paths.push(part.pathInRepo);
    }
  }
  return paths;
}

/** Stable row identity — labels repeat across folders, repo paths do not. */
function fileKey(file: GgufFile): string {
  const first = getDownloadParts(file)[0];
  return first?.pathInRepo || file.url || `${file.type}:${file.size_bytes}`;
}

function roleOf(file: GgufFile): GgufRole {
  return file.role ?? 'quant';
}

function isQuantRole(file: GgufFile): boolean {
  return roleOf(file) === 'quant';
}

const ROLE_BADGE: Record<GgufRole, string> = {
  quant: 'MAIN',
  draft: 'DRAFT',
  swap: 'SWAP',
  aux: 'SIDECAR',
  extra: 'EXTRA',
};

/** Sidecars we can name precisely — llama.cpp vocabulary, not a repo folder list. */
function roleBadgeText(file: GgufFile): string {
  if (roleOf(file) === 'aux') {
    const label = (file.type || '').toLowerCase();
    if (label.startsWith('mmproj')) return 'VISION';
    if (label.includes('imatrix')) return 'IMATRIX';
  }
  return ROLE_BADGE[roleOf(file)];
}

function roleHint(file: GgufFile): string {
  const label = (file.type || '').toLowerCase();
  switch (roleOf(file)) {
    case 'quant':
      return 'Model weights — one launchable quantization set';
    case 'draft':
      return 'Speculative draft head — pairs with a main model, never launched alone';
    case 'swap':
      return 'Swappable piece — kept as .gguf_file so it never appears as a model; swap it in by hand';
    case 'aux':
      if (label.startsWith('mmproj')) {
        return 'Vision projector (mmproj) — enables image input for the model beside it';
      }
      if (label.includes('imatrix')) {
        return 'Importance matrix — quantization calibration data, never loaded at inference';
      }
      return 'llama.cpp sidecar — never launched directly';
    default:
      return file.folder ? `Extra file in ${file.folder}/` : 'Extra file shipped by this repo';
  }
}

/**
 * Show the repo folder only when it says something the label does not.
 * `UD-Q4_K_XL` holding `Q4_K_XL` is noise; `engram/` holding `Q6_K` is the point.
 */
function folderAddsInfo(file: GgufFile): boolean {
  if (!file.folder) return false;
  const compact = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return !compact(file.folder).endsWith(compact(file.type));
}

/**
 * Dates arrive keyed by repo path; a sharded quant takes its latest part.
 * Keying by quant label instead would alias `engram/Q6_K` onto `UD-Q6_K/Q6_K`.
 */
function applyQuantDates(info: HfModelInfo, dates: Record<string, string>): HfModelInfo {
  if (!dates || Object.keys(dates).length === 0) return info;
  return {
    ...info,
    gguf_files: info.gguf_files.map((file) => {
      let latest = '';
      for (const part of getDownloadParts(file)) {
        const date = part.pathInRepo ? dates[part.pathInRepo] : undefined;
        if (date && date > latest) latest = date;
      }
      return { ...file, lastModified: latest || file.lastModified };
    }),
  };
}

async function buildDownloadDestPath(modelId: string, pathInRepo: string): Promise<string> {
  const defaultPath = await invoke<string>('get_default_download_path');
  const { hfAuthor, repoName } = parseHfRepoParts(modelId);
  const segments = pathInRepo.split('/').filter(Boolean);
  return join(defaultPath, hfAuthor, repoName, ...segments);
}

async function checkQuantPartsOnDisk(
  modelId: string,
  file: GgufFile,
): Promise<{ allComplete: boolean; anyExists: boolean }> {
  const parts = getDownloadParts(file);
  let allComplete = true;
  let anyExists = false;
  for (const part of parts) {
    const destPath = await buildDownloadDestPath(modelId, part.pathInRepo);
    const check = await invoke<DownloadTargetCheck>('check_download_target', {
      destPath,
      lfsOid: part.lfsOid || '',
    });
    if (check.exists) anyExists = true;
    if (!check.exists || !check.lfsMatch) allComplete = false;
  }
  return { allComplete, anyExists };
}

function downloadToastLabel(files: GgufFile[]): string {
  if (files.length === 1) {
    const n = shardCount(files[0]);
    return `⬇ DOWNLOADING ${files[0].type}${n > 1 ? ` (${n} shards)` : ''}...`;
  }
  const shards = files.reduce((sum, f) => sum + shardCount(f), 0);
  return `⬇ QUEUED ${files.length} FILES (${shards} PARTS)...`;
}

const VRAM_TIERS = [8, 12, 16, 24, 48, 96];
const SORT_OPTIONS: { key: 'downloads' | 'likes' | 'lastModified'; label: string; icon: string }[] = [
  { key: 'downloads', label: 'Downloads', icon: '⬇' },
  { key: 'likes', label: 'Likes', icon: '⭐' },
  { key: 'lastModified', label: 'Recent', icon: '🕐' },
];

function formatNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

function formatQuantDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

interface FileRowProps {
  file: GgufFile;
  vramGb: number;
  loadingDates: boolean;
  diskCheck: DiskCheckResult | null;
  updated: boolean;
  selected: boolean;
  onToggle: () => void;
  onDownload: () => void;
  onPatch: () => void;
}

function HubFileRow({
  file,
  vramGb,
  loadingDates,
  diskCheck,
  updated,
  selected,
  onToggle,
  onDownload,
  onPatch,
}: FileRowProps) {
  const role = roleOf(file);
  const quant = role === 'quant';
  const shards = shardCount(file);
  const matchType = diskCheck?.matchType ?? 'none';

  return (
    <div
      className={`hub-file theme-surface-row flex items-center justify-between py-2 px-2.5 mb-1 rounded-sm transition-all hub-file-enter${
        selected ? ' hub-file--selected' : ''
      }`}
    >
      <div className="flex items-center gap-2.5 min-w-0">
        <input
          type="checkbox"
          className="hub-file-check"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${file.type}`}
        />
        <span className={`hub-role hub-role--${role}`} title={roleHint(file)}>
          {roleBadgeText(file)}
        </span>
        <QuantBadge type={file.type} />
        {folderAddsInfo(file) && (
          <span className="hub-file-folder" title={`Repo folder ${file.folder}/`}>
            {file.folder}/
          </span>
        )}
        <span className="hub-file-size font-mono flex-shrink-0">{formatSize(file.size_bytes)}</span>
        {quant && vramGb > 0 && <VramFitBadge sizeBytes={file.size_bytes} vramGb={vramGb} />}
        {file.lastModified ? (
          <span className="hub-file-date shrink-0 font-mono" title={file.lastModified}>
            {formatQuantDate(file.lastModified)}
          </span>
        ) : loadingDates ? (
          <span className="hub-file-datespend shrink-0 font-mono">…</span>
        ) : null}
        {shards > 1 && (
          <span className="hub-file-shards shrink-0 rounded-sm border px-1 py-0.5 font-mono">
            {shards} SHARDS
          </span>
        )}
        {updated && (
          <span className="hub-file-updated shrink-0 font-mono flex items-center gap-1">⚠ UPDATED</span>
        )}
      </div>

      {quant && matchType === 'lfs' ? (
        <span className="hub-file-match shrink-0 px-2 py-1 font-mono tracking-wider border rounded-sm">
          ✓ IDENTICAL
        </span>
      ) : quant && matchType === 'size' ? (
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="hub-file-disk px-2 py-1 font-mono tracking-wider border rounded-sm">✓ ON DISK</span>
          <button
            onClick={onPatch}
            className="hub-file-patch px-2 py-1 font-mono tracking-wider border rounded-sm transition-all"
          >
            PATCH
          </button>
        </div>
      ) : quant && matchType === 'mismatch' ? (
        <button
          onClick={onDownload}
          className="hub-file-update shrink-0 px-3 py-1 font-mono tracking-wider border rounded-sm transition-all"
        >
          UPDATE
        </button>
      ) : (
        <button
          onClick={onDownload}
          className={`${quant ? 'hub-file-download' : 'hub-file-extra'} shrink-0 px-3 py-1 font-mono tracking-wider border rounded-sm transition-all`}
        >
          DOWNLOAD
        </button>
      )}
    </div>
  );
}

interface ConfirmPlan {
  primary: GgufFile[];
  extras: GgufFile[];
  extraChecked: Set<string>;
  disk: Map<string, { allComplete: boolean; anyExists: boolean }>;
}

export default function ModelHubSearch() {
  const { containerRef: splitContainerRef, panelWidth, isDragging, startDrag, resetWidth } =
    useModelHubSplitResize();
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HfModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailInfo, setDetailInfo] = useState<HfModelInfo | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [vramTier, setVramTier] = useState<number>(0);
  const [sortBy, setSortBy] = useState<'downloads' | 'likes' | 'lastModified'>('downloads');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [showExtras, setShowExtras] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const [confirmPlan, setConfirmPlan] = useState<ConfirmPlan | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [diskChecks, setDiskChecks] = useState<Map<string, DiskCheckResult> | null>(null);
  const [hfUpdates, setHfUpdates] = useState<HfRepoUpdateStatus | null>(null);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [loadingQuantDates, setLoadingQuantDates] = useState(false);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const showToast = useCallback((msg: string) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast(msg);
    toastTimer.current = setTimeout(() => setToast(null), 3000);
  }, []);

  useEffect(() => {
    return () => { if (toastTimer.current) clearTimeout(toastTimer.current); };
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetailInfo(null);
      setDiskChecks(null);
      setHfUpdates(null);
      setLoadingQuantDates(false);
      return;
    }
    let cancelled = false;
    setLoadingDetail(true);
    setLoadingQuantDates(false);
    setSelectedFiles(new Set());
    setShowExtras(false);
    (async () => {
      try {
        const info = await invoke<HfModelInfo>('get_hf_model_info', {
          modelId: selectedId,
        });
        if (cancelled) return;

        setDetailInfo(info);
        setLoadingDetail(false);

        if (info.gguf_files?.length) {
          const paths = collectGgufRepoPaths(info.gguf_files);
          if (paths.length > 0) {
            setLoadingQuantDates(true);
            invoke<Record<string, string>>('get_hf_quant_dates', {
              modelId: selectedId,
              paths,
            })
              .then((dates) => {
                if (!cancelled) {
                  setDetailInfo((prev) => (prev ? applyQuantDates(prev, dates) : prev));
                }
              })
              .catch((e) => console.error('Quant date fetch failed:', e))
              .finally(() => {
                if (!cancelled) setLoadingQuantDates(false);
              });
          }

          invoke<DiskCheckResult[]>('check_hf_files_against_disk', {
            ggufFiles: info.gguf_files,
            hfModelId: info.id,
          })
            .then((results) => {
              if (cancelled) return;
              const map = new Map<string, DiskCheckResult>();
              for (const r of results) {
                map.set(r.pathInRepo || r.quantType, r);
              }
              setDiskChecks(map);
            })
            .catch((e) => console.error('Disk check failed:', e));
        }
      } catch (e) {
        console.error('Failed to load model info:', e);
        if (!cancelled) {
          showToast(`FAILED TO LOAD MODEL: ${typeof e === 'string' ? e : 'unknown error'}`);
          setLoadingDetail(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId, showToast]);

  const checkUpdates = useCallback(async () => {
    if (!selectedId) return;
    setCheckingUpdates(true);
    try {
      const status = await invoke<HfRepoUpdateStatus>('check_hf_repo_updates', {
        modelId: selectedId,
      });
      setHfUpdates(status);
      if (status.localCopyCount === 0) {
        showToast('NO LOCAL COPIES OF THIS REPO — DOWNLOAD A QUANT FIRST');
      } else if (status.updateCount > 0) {
        showToast(`⚠ ${status.updateCount} LOCAL QUANT${status.updateCount > 1 ? 'S' : ''} OUT OF DATE ON HF`);
      } else {
        showToast(`✓ ALL ${status.localCopyCount} LOCAL QUANT${status.localCopyCount > 1 ? 'S' : ''} UP TO DATE`);
      }
    } catch (e) {
      console.error('Update check failed:', e);
      showToast(`UPDATE CHECK FAILED: ${typeof e === 'string' ? e : 'unknown'}`);
    } finally {
      setCheckingUpdates(false);
    }
  }, [selectedId, showToast]);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSelectedId(null);
    try {
      const resp = await invoke<HfSearchResponse>('search_hf_models', {
        query: query.trim(),
        vramLimitGb: vramTier > 0 ? vramTier : undefined,
        sort: sortBy,
        limit: 50,
      });
      let models = resp.models;
      if (sortBy === 'lastModified') {
        models = [...models].sort((a, b) => (b.lastModified || '').localeCompare(a.lastModified || ''));
      }
      setResults(models);
    } catch (e) {
      console.error('Search failed:', e);
      showToast(`SEARCH FAILED: ${typeof e === 'string' ? e : 'unknown error'}`);
    } finally {
      setLoading(false);
    }
  }, [query, vramTier, sortBy, showToast]);

  const handleOpenHfPage = useCallback(async (modelId: string) => {
    try {
      await open(hfModelUrl(modelId));
    } catch (e) {
      console.error('Failed to open HF page:', e);
      showToast('FAILED TO OPEN HUGGING FACE PAGE');
    }
  }, [showToast]);

  const handlePatchMetadata = useCallback(async (modelId: string, file: GgufFile) => {
    const parts = getDownloadParts(file);
    showToast(`PATCHING ${file.type}…`);
    void invoke('emit_to_blackwell_console', {
      category: 'utils',
      content: `[gguf-patch] UI click  quant=${file.type}  parts=${parts.length}`,
      style: 'Highlight',
    });
    try {
      let patched = 0;
      let current = 0;
      for (const part of parts) {
        const localPath = await buildDownloadDestPath(modelId, part.pathInRepo);
        void invoke('emit_to_blackwell_console', {
          category: 'utils',
          content: `[gguf-patch] UI invoke  ${localPath}`,
          style: 'Command',
        });
        const result = await invoke<string>('patch_model_metadata', {
          localPath,
          remoteUrl: part.url,
          remoteTotalSize: part.size_bytes,
        });
        if (result === 'patched') patched += 1;
        else if (result === 'already_current') current += 1;
      }
      if (patched > 0) {
        showToast(`PATCHED ${file.type} METADATA`);
      } else if (current > 0) {
        showToast(`${file.type} ALREADY CURRENT`);
      } else {
        showToast(`${file.type} PATCH FINISHED`);
      }
    } catch (e) {
      console.error('Patch failed:', e);
      const msg = typeof e === 'string' ? e : 'patch failed';
      showToast(`PATCH FAILED: ${msg}`);
    }
  }, [showToast]);

  const toggleSelect = useCallback((file: GgufFile) => {
    const key = fileKey(file);
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  /**
   * Step 2 of the flow: whatever the user picked, the repo's remaining artifacts are
   * offered as an optional add-on. Nothing extra is ever queued without this confirm.
   */
  const openConfirm = useCallback(async (files: GgufFile[], modelId: string) => {
    if (files.length === 0) return;
    const primary = files.filter(isQuantRole);
    const extras = (detailInfo?.gguf_files || []).filter((f) => !isQuantRole(f));
    const extraChecked = new Set(files.filter((f) => !isQuantRole(f)).map(fileKey));

    const disk = new Map<string, { allComplete: boolean; anyExists: boolean }>();
    for (const file of primary) {
      disk.set(fileKey(file), await checkQuantPartsOnDisk(modelId, file));
    }
    setConfirmPlan({ primary, extras, extraChecked, disk });
  }, [detailInfo]);

  const toggleExtra = useCallback((key: string) => {
    setConfirmPlan((prev) => {
      if (!prev) return prev;
      const next = new Set(prev.extraChecked);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...prev, extraChecked: next };
    });
  }, []);

  const runDownload = useCallback(async () => {
    if (!confirmPlan || !selectedId) return;
    const { hfAuthor } = parseHfRepoParts(selectedId);
    const chosen = [
      ...confirmPlan.primary,
      ...confirmPlan.extras.filter((f) => confirmPlan.extraChecked.has(fileKey(f))),
    ];
    if (chosen.length === 0) {
      setConfirmPlan(null);
      return;
    }
    setConfirmBusy(true);
    let queued = 0;
    let skipped = 0;
    try {
      for (const file of chosen) {
        const disk = confirmPlan.disk.get(fileKey(file));
        if (disk?.allComplete) {
          skipped += 1;
          continue;
        }
        await invoke<string[]>('start_quant_download', {
          hfModelId: selectedId,
          hfAuthor,
          quantType: file.type,
          ggufFile: file,
        });
        queued += 1;
      }
      if (queued === 0) {
        showToast(skipped > 0 ? '✓ ALREADY DOWNLOADED' : 'NOTHING TO DOWNLOAD');
      } else {
        showToast(downloadToastLabel(chosen.filter((f) => !confirmPlan.disk.get(fileKey(f))?.allComplete)));
      }
      setSelectedFiles(new Set());
      setConfirmPlan(null);
    } catch (e) {
      console.error('Download failed:', e);
      showToast(`DOWNLOAD FAILED: ${typeof e === 'string' ? e : 'unknown error'}`);
    } finally {
      setConfirmBusy(false);
    }
  }, [confirmPlan, selectedId, showToast]);

  const handleVramToggle = useCallback((gb: number) => {
    setVramTier(prev => prev === gb ? 0 : gb);
  }, []);

  const allFiles = useMemo(() => {
    if (!detailInfo) return [] as GgufFile[];
    return [...(detailInfo.gguf_files || [])].sort((a, b) => a.size_bytes - b.size_bytes);
  }, [detailInfo]);

  const quantFiles = useMemo(() => allFiles.filter(isQuantRole), [allFiles]);
  const extraFiles = useMemo(() => allFiles.filter((f) => !isQuantRole(f)), [allFiles]);
  const repoBytes = useMemo(() => allFiles.reduce((sum, f) => sum + f.size_bytes, 0), [allFiles]);

  const selectedList = useMemo(
    () => allFiles.filter((f) => selectedFiles.has(fileKey(f))),
    [allFiles, selectedFiles],
  );
  const selectedBytes = useMemo(
    () => selectedList.reduce((sum, f) => sum + f.size_bytes, 0),
    [selectedList],
  );

  const selectedSearchModel = useMemo(() => results.find(m => m.id === selectedId), [results, selectedId]);

  const confirmTotal = useMemo(() => {
    if (!confirmPlan) return 0;
    const extras = confirmPlan.extras.filter((f) => confirmPlan.extraChecked.has(fileKey(f)));
    return [...confirmPlan.primary, ...extras].reduce((sum, f) => sum + f.size_bytes, 0);
  }, [confirmPlan]);

  return (
    <div className="flex flex-col h-full">
      {toast && (
        <div className="hub-toast absolute top-4 right-4 z-50 px-3 py-1.5 font-mono tracking-wider rounded-sm toast-enter">
          {toast}
        </div>
      )}

      {confirmPlan && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 fade-in">
          <div className="hub-confirm gunmetal-card p-5 max-w-xl w-full mx-4 border rounded-sm flex flex-col max-h-[80%]">
            <div className="hub-confirm-title font-mono tracking-wider uppercase mb-2">
              ⬇ DOWNLOAD FROM THIS REPO
            </div>

            <div className="overflow-y-auto eink-scrollbar min-h-0 flex-1 pr-1">
              {confirmPlan.primary.length > 0 && (
                <div className="hub-confirm-sect font-mono tracking-wider uppercase">MODEL WEIGHTS</div>
              )}
              {confirmPlan.primary.map((file) => {
                const disk = confirmPlan.disk.get(fileKey(file));
                const status = disk?.allComplete
                  ? 'ON DISK — SKIPPED'
                  : disk?.anyExists
                    ? 'REPLACES EXISTING PARTS'
                    : '';
                return (
                  <div key={fileKey(file)} className="hub-confirm-row flex items-center justify-between gap-2 py-1">
                    <div className="flex items-center gap-2 min-w-0">
                      <QuantBadge type={file.type} />
                      <span className="hub-confirm-fallback font-mono truncate">{formatSize(file.size_bytes)}</span>
                      {shardCount(file) > 1 && (
                        <span className="hub-file-shards shrink-0 rounded-sm border px-1 py-0.5 font-mono">
                          {shardCount(file)} SHARDS
                        </span>
                      )}
                    </div>
                    {status && <span className="hub-confirm-status font-mono shrink-0">{status}</span>}
                  </div>
                );
              })}

              {confirmPlan.extras.length > 0 && (
                <>
                  <div className="hub-confirm-sect hub-confirm-sect--extras font-mono tracking-wider uppercase mt-3">
                    ALSO IN THIS REPO ({confirmPlan.extras.length})
                  </div>
                  <p className="hub-confirm-note font-mono py-1">
                    OPTIONAL — NOTHING HERE IS NEEDED TO RUN A QUANT
                  </p>
                  {confirmPlan.extras.map((file) => {
                    const key = fileKey(file);
                    const role = roleOf(file);
                    return (
                      <label key={key} className="hub-confirm-row hub-confirm-row--extra flex items-center gap-2 py-1 cursor-pointer">
                        <input
                          type="checkbox"
                          className="hub-file-check"
                          checked={confirmPlan.extraChecked.has(key)}
                          onChange={() => toggleExtra(key)}
                        />
                        <span className={`hub-role hub-role--${role}`} title={roleHint(file)}>
                          {roleBadgeText(file)}
                        </span>
                        <QuantBadge type={file.type} />
                        {folderAddsInfo(file) && <span className="hub-file-folder">{file.folder}/</span>}
                        <span className="hub-confirm-fallback font-mono ml-auto">{formatSize(file.size_bytes)}</span>
                      </label>
                    );
                  })}
                </>
              )}
            </div>

            <div className="hub-confirm-total font-mono tracking-wider mt-2 pt-2">
              TOTAL {formatSize(confirmTotal)}
            </div>

            <div className="flex items-center gap-2 justify-end mt-2">
              <button
                type="button"
                onClick={() => setConfirmPlan(null)}
                className="hub-confirm-cancel px-3 py-1.5 font-mono tracking-wider border rounded-sm transition-all"
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={runDownload}
                disabled={confirmBusy}
                className="hub-confirm-go px-3 py-1.5 font-mono tracking-wider border rounded-sm transition-all disabled:opacity-40"
              >
                {confirmBusy ? 'QUEUEING...' : 'DOWNLOAD'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="hub-searchbar px-4 py-3 border-b">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="hub-searchbar-icon select-none">🔍</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            placeholder="SEARCH HUGGING FACE MODELS..."
            className="theme-input flex-1 text-xs font-mono px-3 py-1.5 rounded-sm"
          />
          <button
            onClick={doSearch}
            disabled={loading || !query.trim()}
            className="hub-searchbar-btn px-4 py-2 font-mono tracking-wider border rounded-sm transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {loading ? 'SEARCHING...' : 'SEARCH'}
          </button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <span className="hub-filter-label">VRAM FIT:</span>
          {VRAM_TIERS.map(gb => (
            <button
              key={gb}
              onClick={() => handleVramToggle(gb)}
              className={`hub-filter-chip px-2 py-0.5 font-mono tracking-wider rounded-sm transition-all ${
                vramTier === gb ? 'value-chip-active' : 'value-chip'
              }`}
            >
              {gb}GB
            </button>
          ))}
          {vramTier > 0 && (
            <button
              onClick={() => setVramTier(0)}
              className="hub-filter-clear px-2 py-0.5 font-mono tracking-wider border rounded-sm transition-all"
            >
              CLEAR
            </button>
          )}

          <div className="flex-1" />

          <span className="hub-filter-label">SORT:</span>
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => setSortBy(opt.key)}
              className={`hub-filter-chip px-2 py-0.5 font-mono tracking-wider rounded-sm transition-all ${
                sortBy === opt.key ? 'value-chip-active' : 'value-chip'
              }`}
            >
              {opt.icon} {opt.label}
            </button>
          ))}
        </div>
      </div>

      <div ref={splitContainerRef} className="flex flex-1 overflow-hidden min-h-0">
        <div
          className="flex flex-col eink-panel-wrapper flex-shrink-0 min-h-0"
          style={{ width: panelWidth }}
        >
          <div className="hub-results-head px-3 py-1.5 border-b flex items-center justify-between flex-shrink-0">
            <span className="hub-results-count font-mono tracking-wider uppercase">
              RESULTS ({results.length})
            </span>
            {vramTier > 0 && (
              <span className="hub-results-filter font-mono">{vramTier}GB FILTER</span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto eink-scrollbar px-3 py-2 space-y-2 min-h-0">
            {!loading && results.length === 0 && (
              <div className="hub-empty flex items-center justify-center h-full">
                <p className="hub-empty-text font-mono italic text-center py-8 px-4">
                  {query ? 'NO RESULTS FOUND' : 'ENTER A QUERY TO SEARCH'}
                </p>
              </div>
            )}

            {loading && (
              <div className="flex items-center justify-center h-full">
                <span className="hub-busy font-mono hub-search-pulse">
                  SEARCHING...
                </span>
              </div>
            )}

            {results.map((model) => {
              const files = model.gguf_files || [];
              const quants = files.filter(isQuantRole);
              const extras = files.length - quants.length;
              return (
                <button
                  key={model.id}
                  onClick={() => setSelectedId(model.id)}
                  className={`hub-result w-full text-left p-3 rounded-sm transition-all hub-result-enter ${
                    selectedId === model.id ? 'hub-result--selected gunmetal-card border-l-2' : 'buried-card'
                  }`}
                >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span className="hub-result-author truncate font-mono">{model.author}</span>
                    {quants.length > 0 && (
                      <span className="hub-result-counts shrink-0 font-mono">
                        {quants.length} QUANT{quants.length > 1 ? 'S' : ''}
                      </span>
                    )}
                  </div>

                  <div className="text-xs font-mono model-card-name truncate mb-1.5">{model.id}</div>

                  <div className="hub-result-meta flex items-center gap-3 font-mono">
                    <span>⬇ {formatNum(model.downloads)}</span>
                    <span>⭐ {formatNum(model.likes_count)}</span>
                  </div>

                  {quants.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-1">
                      {quants.slice(0, 4).map((gf, i) => (
                        <QuantBadge key={`${gf.type}-${i}`} type={gf.type} />
                      ))}
                      {quants.length > 4 && (
                        <span className="hub-result-more font-mono">+{quants.length - 4}</span>
                      )}
                      {extras > 0 && (
                        <span className="hub-result-extra font-mono">+{extras} EXTRAS</span>
                      )}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div
          role="separator"
          aria-orientation="vertical"
          aria-valuenow={panelWidth}
          aria-label="Resize search results and quant list panels"
          className={`catalog-split-handle${isDragging ? ' is-dragging' : ''}`}
          onMouseDown={(e) => {
            e.preventDefault();
            startDrag();
          }}
          onDoubleClick={resetWidth}
          title="Drag to resize · double-click to reset"
        />

        <div className="flex-1 min-w-0 min-h-0 flex flex-col">
          <div className="flex-1 min-h-0 eink-panel-wrapper overflow-y-auto eink-scrollbar">
            {loadingDetail ? (
              <div key="loading-detail" className="flex items-center justify-center h-full fade-in">
                <span className="hub-busy font-mono hub-search-pulse">
                  LOADING MODEL INFO...
                </span>
              </div>
            ) : detailInfo ? (
              <div key={detailInfo.id} className="p-4 fade-in">
                <div className="hub-detail-head flex items-start justify-between gap-3 mb-2 pb-2 border-b">
                  <div className="min-w-0">
                    <h2 className="text-xs font-mono model-card-name tracking-wide truncate">{detailInfo.id}</h2>
                    <span className="hub-detail-author font-mono">{detailInfo.author}</span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      type="button"
                      onClick={checkUpdates}
                      disabled={checkingUpdates}
                      className="hub-detail-check rounded-sm border px-2 py-1 font-mono transition-colors whitespace-nowrap disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {checkingUpdates ? 'CHECKING...' : 'CHECK UPDATES'}
                    </button>
                    <button
                      type="button"
                      onClick={() => handleOpenHfPage(detailInfo.id)}
                      className="hub-detail-hf rounded-sm border px-2 py-1 font-mono transition-colors whitespace-nowrap"
                    >
                      VIEW ON HF ↗
                    </button>
                  </div>
                </div>
                {hfUpdates && hfUpdates.localCopyCount > 0 && hfUpdates.updateCount > 0 && (
                  <div className="hub-detail-updates mb-2 pb-2 border-b">
                    <div className="hub-detail-updates-text font-mono tracking-wider">
                      ⚠ {hfUpdates.updateCount} OF {hfUpdates.localCopyCount} LOCAL QUANT{hfUpdates.localCopyCount > 1 ? 'S' : ''} OUT OF DATE ON HF
                    </div>
                  </div>
                )}

                <ModelStatsRow
                  downloads={detailInfo.downloads}
                  likes={detailInfo.likes_count}
                  quants={quantFiles.length}
                  extras={extraFiles.length}
                  totalBytes={repoBytes}
                />

                {detailInfo.description && (
                  <div className="hub-detail-desc mb-3 pb-2 border-b">
                    <p className="hub-detail-desc-text font-mono leading-relaxed line-clamp-4">
                      {detailInfo.description.slice(0, 500)}{detailInfo.description.length > 500 ? '...' : ''}
                    </p>
                  </div>
                )}

                <div>
                  <h3 className="hub-quant-head font-mono tracking-wider uppercase mb-2 flex items-center gap-2">
                    <span>QUANTS ({quantFiles.length})</span>
                    {loadingQuantDates && (
                      <span className="hub-quant-dates normal-case tracking-normal">dates…</span>
                    )}
                    {extraFiles.length > 0 && (
                      <button
                        type="button"
                        onClick={() => setShowExtras((prev) => !prev)}
                        className={`hub-extras-toggle font-mono ml-auto rounded-sm border transition-all ${
                          showExtras ? 'hub-extras-toggle--on' : ''
                        }`}
                        title="Draft heads, swap pieces and sidecars this repo also ships"
                        aria-expanded={showExtras}
                      >
                        {showExtras ? '▾' : '▸'} EXTRAS ({extraFiles.length})
                      </button>
                    )}
                  </h3>

                  <div className="max-h-[320px] overflow-y-auto eink-scrollbar pr-1">
                    {quantFiles.map((file) => {
                      const diskCheck = diskChecks?.get(fileKey(file)) ?? null;
                      const matchType = diskCheck?.matchType ?? 'none';
                      const hfUpdate = (matchType !== 'none')
                        ? (hfUpdates?.files.find(f => f.quantType === file.type) ?? null)
                        : null;
                      return (
                        <HubFileRow
                          key={fileKey(file)}
                          file={file}
                          vramGb={vramTier}
                          loadingDates={loadingQuantDates}
                          diskCheck={diskCheck}
                          updated={Boolean(hfUpdate?.hasUpdate)}
                          selected={selectedFiles.has(fileKey(file))}
                          onToggle={() => toggleSelect(file)}
                          onDownload={() => { void openConfirm([file], detailInfo.id); }}
                          onPatch={() => { void handlePatchMetadata(detailInfo.id, file); }}
                        />
                      );
                    })}

                    {quantFiles.length === 0 && (
                      <p className="hub-file-empty font-mono italic py-4 text-center">
                        NO LAUNCHABLE QUANT IN THIS REPO
                      </p>
                    )}
                  </div>

                  {showExtras && extraFiles.length > 0 && (
                    <div className="hub-extras mt-3">
                      <h4 className="hub-extras-head font-mono tracking-wider uppercase mb-1">
                        EXTRAS ({extraFiles.length}) · NOT MODEL WEIGHTS
                      </h4>
                      <div className="max-h-[220px] overflow-y-auto eink-scrollbar pr-1">
                        {extraFiles.map((file) => (
                          <HubFileRow
                            key={fileKey(file)}
                            file={file}
                            vramGb={0}
                            loadingDates={loadingQuantDates}
                            diskCheck={null}
                            updated={false}
                            selected={selectedFiles.has(fileKey(file))}
                            onToggle={() => toggleSelect(file)}
                            onDownload={() => { void openConfirm([file], detailInfo.id); }}
                            onPatch={() => {}}
                          />
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            ) : selectedSearchModel ? (
              <div key="placeholder-detail" className="hub-detail-empty flex items-center justify-center h-full fade-in">
                <p className="hub-detail-empty-text font-mono italic">CLICK A MODEL TO LOAD DETAILS</p>
              </div>
            ) : (
              <div key="empty-detail" className="hub-detail-empty flex items-center justify-center h-full fade-in">
                <p className="hub-detail-empty-text font-mono italic">SELECT A MODEL TO VIEW DETAILS</p>
              </div>
            )}
          </div>

          {detailInfo && selectedList.length > 0 && (
            <div className="hub-selection-bar flex items-center gap-2 px-4 py-2 border-t flex-shrink-0">
              <span className="hub-selection-count font-mono tracking-wider">
                {selectedList.length} SELECTED · {formatSize(selectedBytes)}
              </span>
              <div className="flex-1" />
              <button
                type="button"
                onClick={() => setSelectedFiles(new Set())}
                className="hub-selection-clear px-2 py-1 font-mono tracking-wider border rounded-sm transition-all"
              >
                CLEAR
              </button>
              <button
                type="button"
                onClick={() => { if (detailInfo) void openConfirm(selectedList, detailInfo.id); }}
                className="hub-selection-download px-3 py-1 font-mono tracking-wider border rounded-sm transition-all"
              >
                ⬇ DOWNLOAD SELECTED
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
