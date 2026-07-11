import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-shell';
import type { DownloadTargetCheck, DiskCheckResult, GgufFile, GgufShard, HfModel, HfModelInfo, HfSearchResponse, HfRepoUpdateStatus } from '@/lib/types';
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

function applyQuantDates(info: HfModelInfo, dates: Record<string, string>): HfModelInfo {
  if (!dates || Object.keys(dates).length === 0) return info;
  return {
    ...info,
    gguf_files: info.gguf_files.map((file) => ({
      ...file,
      lastModified: dates[file.type] ?? file.lastModified,
    })),
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

function downloadToastLabel(file: GgufFile, action?: 'update' | 'replace'): string {
  const n = shardCount(file);
  const shardLabel = n > 1 ? ` (${n} shards)` : '';
  if (action === 'update') return `⬇ UPDATING ${file.type}${shardLabel}...`;
  if (action === 'replace') return `⬇ REPLACING ${file.type}${shardLabel}...`;
  return `⬇ DOWNLOADING ${file.type}${shardLabel}...`;
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

function getVramFitColor(sizeBytes: number, vramGb: number): string {
  if (!vramGb || sizeBytes === 0) return 'bg-stealth-muted/30';
  const sizeGb = sizeBytes / (1024 * 1024 * 1024);
  if (sizeGb + 2 <= vramGb) return 'bg-nv-green';
  if (sizeGb + 2 <= vramGb * 1.3) return 'bg-yellow-500';
  return 'bg-red-500';
}

function getVramFitLabel(sizeBytes: number, vramGb: number): string {
  if (!vramGb || sizeBytes === 0) return '';
  const sizeGb = sizeBytes / (1024 * 1024 * 1024);
  if (sizeGb + 2 <= vramGb) return 'FITS';
  if (sizeGb + 2 <= vramGb * 1.3) return 'TIGHT';
  return 'OVER';
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
  const [ggufOnly, setGgufOnly] = useState(true);
  const [confirmDownload, setConfirmDownload] = useState<{
    modelId: string;
    file: GgufFile;
    action: 'update' | 'replace';
    diskFileSize?: number | null;
    diskAuthor?: string | null;
  } | null>(null);
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
                map.set(r.quantType, r);
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
        models = [...models].sort((a, b) => (b.last_modified || '').localeCompare(a.last_modified || ''));
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

  const handleDownload = useCallback(async (modelId: string, file: GgufFile) => {
    if (!file.url?.trim()) {
      showToast('DOWNLOAD URL MISSING — RELOAD MODEL DETAILS');
      return;
    }

    try {
      const { hfAuthor } = parseHfRepoParts(modelId);
      const { allComplete, anyExists } = await checkQuantPartsOnDisk(modelId, file);

      if (allComplete) {
        showToast(`✓ ${file.type} ALREADY DOWNLOADED`);
        return;
      }
      if (anyExists) {
        const diskCheck = diskChecks?.get(file.type) ?? null;
        setConfirmDownload({
          modelId,
          file,
          action: 'update',
          diskFileSize: diskCheck?.diskFileSize ?? null,
          diskAuthor: diskCheck?.diskAuthor ?? null,
        });
        return;
      }

      await invoke<string[]>('start_quant_download', {
        hfModelId: modelId,
        hfAuthor,
        quantType: file.type,
        ggufFile: file,
      });
      showToast(downloadToastLabel(file));
    } catch (e) {
      console.error('Download failed:', e);
      showToast(`DOWNLOAD FAILED: ${typeof e === 'string' ? e : 'unknown error'}`);
    }
  }, [showToast, diskChecks]);

  const handleConfirmDownload = useCallback(async () => {
    if (!confirmDownload) return;
    const { modelId, file, action } = confirmDownload;
    setConfirmDownload(null);

    if (!file.url?.trim()) {
      showToast('DOWNLOAD URL MISSING — RELOAD MODEL DETAILS');
      return;
    }

    try {
      const { hfAuthor } = parseHfRepoParts(modelId);
      const { allComplete } = await checkQuantPartsOnDisk(modelId, file);

      if (allComplete) {
        showToast(`✓ ${file.type} ALREADY DOWNLOADED`);
        return;
      }

      await invoke<string[]>('start_quant_download', {
        hfModelId: modelId,
        hfAuthor,
        quantType: file.type,
        ggufFile: file,
      });
      showToast(downloadToastLabel(file, action === 'update' ? 'update' : 'replace'));
    } catch (e) {
      console.error('Download failed:', e);
      showToast(`DOWNLOAD FAILED: ${typeof e === 'string' ? e : 'unknown error'}`);
    }
  }, [confirmDownload, showToast]);

  const handleVramToggle = useCallback((gb: number) => {
    setVramTier(prev => prev === gb ? 0 : gb);
  }, []);

  const filteredResults = useMemo(() => {
    if (!ggufOnly) return results;
    return results.filter(m => m.gguf_files && m.gguf_files.length > 0);
  }, [results, ggufOnly]);

  const selectedGgufFiles = useMemo(() => {
    if (!detailInfo) return [];
    return [...(detailInfo.gguf_files || [])].sort((a, b) => a.size_bytes - b.size_bytes);
  }, [detailInfo]);

  const selectedSearchModel = useMemo(() => results.find(m => m.id === selectedId), [results, selectedId]);

  return (
    <div className="flex flex-col h-full">
      {toast && (
        <div className="absolute top-4 right-4 z-50 px-3 py-1.5 text-[10px] font-mono tracking-wider bg-nv-green/20 border border-nv-green/40 text-nv-green rounded-sm toast-enter">
          {toast}
        </div>
      )}

      {confirmDownload && (
        <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/60 fade-in">
          <div className="gunmetal-card p-5 max-w-sm w-full mx-4 border border-yellow-400/30 rounded-sm">
            <div className="text-[10px] font-mono text-yellow-400 tracking-wider uppercase mb-3">
              {confirmDownload.action === 'update' ? '⚠ MODEL UPDATED ON HF' : '⚠ REPLACE EXISTING FILE'}
            </div>
            <p className="text-[11px] font-mono text-white/80 mb-3">
              {confirmDownload.action === 'update'
                ? shardCount(confirmDownload.file) > 1
                  ? `A newer version of this quant is available on HuggingFace. All ${shardCount(confirmDownload.file)} shard files will be replaced after download completes.`
                  : 'A newer version of this quant is available on HuggingFace. The existing file will be replaced after download completes.'
                : shardCount(confirmDownload.file) > 1
                  ? `Some shard files already exist. All ${shardCount(confirmDownload.file)} parts will be re-downloaded.`
                  : 'A file with this name already exists. It will be replaced after download completes.'}
            </p>
            {(confirmDownload.diskFileSize || confirmDownload.diskAuthor) ? (
              <div className="mb-3 space-y-1.5 text-[9px] font-mono">
                <div className="flex items-center gap-2">
                  <span className="text-stealth-muted w-16">DISK</span>
                  {confirmDownload.diskAuthor && <span className="text-stealth-muted/70">{confirmDownload.diskAuthor}</span>}
                  <span className="text-yellow-400/80">{confirmDownload.file.type}</span>
                  {confirmDownload.diskFileSize && <span className="text-stealth-muted/50">{formatSize(confirmDownload.diskFileSize)}</span>}
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-stealth-muted w-16">HF</span>
                  <span className="text-nv-green/80">{confirmDownload.file.type}</span>
                  <span className="text-stealth-muted/50">{formatSize(confirmDownload.file.size_bytes)}</span>
                </div>
              </div>
            ) : (
              <p className="text-[10px] font-mono text-stealth-muted mb-4">
                {confirmDownload.file.type}
              </p>
            )}
            <div className="flex items-center gap-2 justify-end">
              <button
                type="button"
                onClick={() => setConfirmDownload(null)}
                className="px-3 py-1.5 text-[10px] font-mono tracking-wider border border-stealth-border/60 text-stealth-muted rounded-sm hover:bg-stealth-muted/10 transition-all"
              >
                CANCEL
              </button>
              <button
                type="button"
                onClick={handleConfirmDownload}
                className="px-3 py-1.5 text-[10px] font-mono tracking-wider bg-yellow-400/20 text-yellow-400 border border-yellow-400/40 rounded-sm hover:bg-yellow-400/30 transition-all"
              >
                {confirmDownload.action === 'update' ? 'UPDATE MODEL' : 'REPLACE FILE'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="px-4 py-3 border-b border-stealth-border/50">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-nv-green text-xs select-none">🔍</span>
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
            className="px-4 py-2 text-xs font-mono tracking-wider bg-nv-green/20 text-nv-green border border-nv-green/40 rounded-sm hover:bg-nv-green/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {loading ? 'SEARCHING...' : 'SEARCH'}
          </button>
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[9px] font-mono text-stealth-muted tracking-wider uppercase">VRAM FIT:</span>
          {VRAM_TIERS.map(gb => (
            <button
              key={gb}
              onClick={() => handleVramToggle(gb)}
              className={`px-2 py-0.5 text-[10px] font-mono tracking-wider rounded-sm transition-all ${
                vramTier === gb ? 'value-chip-active' : 'value-chip'
              }`}
            >
              {gb}GB
            </button>
          ))}
          {vramTier > 0 && (
            <button
              onClick={() => setVramTier(0)}
              className="px-2 py-0.5 text-[9px] font-mono tracking-wider border border-red-400/30 text-red-400 hover:bg-red-400/10 rounded-sm transition-all"
            >
              CLEAR
            </button>
          )}

          <div className="flex-1" />

          <button
            onClick={() => setGgufOnly(prev => !prev)}
            className={`px-2 py-0.5 text-[10px] font-mono tracking-wider rounded-sm transition-all ${
              ggufOnly ? 'value-chip-active' : 'value-chip'
            }`}
          >
            {ggufOnly ? 'GGUF ON' : 'ALL'}
          </button>

          <span className="text-[9px] font-mono text-stealth-muted tracking-wider uppercase">SORT:</span>
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => setSortBy(opt.key)}
              className={`px-2 py-0.5 text-[10px] font-mono tracking-wider rounded-sm transition-all ${
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
          <div className="px-3 py-1.5 border-b border-stealth-border/40 flex items-center justify-between flex-shrink-0">
            <span className="text-[9px] font-mono text-stealth-muted tracking-wider uppercase">
              RESULTS ({filteredResults.length})
            </span>
            {vramTier > 0 && (
              <span className="text-[8px] font-mono text-nv-green/60">{vramTier}GB FILTER</span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto eink-scrollbar px-3 py-2 space-y-2 min-h-0">
            {!loading && filteredResults.length === 0 && (
              <div className="flex items-center justify-center h-full text-stealth-muted/50">
                <p className="text-[10px] font-mono italic text-center py-8 px-4">
                  {query ? 'NO RESULTS FOUND' : 'ENTER A QUERY TO SEARCH'}
                </p>
              </div>
            )}

            {loading && (
              <div className="flex items-center justify-center h-full">
                <span className="text-xs font-mono text-nv-green hub-search-pulse">
                  SEARCHING...
                </span>
              </div>
            )}

            {filteredResults.map((model) => (
              <button
                key={model.id}
                onClick={() => setSelectedId(model.id)}
                className={`w-full text-left p-3 rounded-sm transition-all hub-result-enter ${
                  selectedId === model.id ? 'gunmetal-card border-l-2 border-l-nv-green' : 'buried-card'
                }`}
              >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span className="text-[9px] font-mono text-stealth-muted truncate">{model.author}</span>
                    {model.gguf_files && model.gguf_files.length > 0 && (
                      <span className="shrink-0 rounded-sm border border-nv-green/30 bg-nv-green/10 px-1 py-0.5 text-[8px] font-mono text-nv-green/70">
                        GGUF
                      </span>
                    )}
                  </div>

                  <div className="text-xs font-mono model-card-name truncate mb-1.5">{model.id}</div>

                  <div className="flex items-center gap-3 text-[10px] font-mono text-stealth-muted">
                    <span>⬇ {formatNum(model.downloads)}</span>
                    <span>⭐ {formatNum(model.likes_count)}</span>
                  </div>

                  {model.gguf_files && model.gguf_files.length > 0 && (
                    <div className="mt-1.5 flex flex-wrap gap-1">
                      {model.gguf_files.slice(0, 5).map((gf, i) => (
                        <QuantBadge key={i} type={gf.type} />
                      ))}
                      {model.gguf_files.length > 5 && (
                        <span className="text-[8px] font-mono text-stealth-muted/40">+{model.gguf_files.length - 5}</span>
                      )}
                    </div>
                  )}
              </button>
            ))}
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

        <div className="flex-1 min-w-0 min-h-0 eink-panel-wrapper overflow-y-auto eink-scrollbar">
          {loadingDetail ? (
            <div key="loading-detail" className="flex items-center justify-center h-full fade-in">
              <span className="text-xs font-mono text-nv-green hub-search-pulse">
                LOADING MODEL INFO...
              </span>
            </div>
          ) : detailInfo ? (
            <div key={detailInfo.id} className="p-4 fade-in">
              <div className="flex items-start justify-between gap-3 mb-2 pb-2 border-b border-stealth-border/40">
                <div className="min-w-0">
                  <h2 className="text-xs font-mono model-card-name tracking-wide truncate">{detailInfo.id}</h2>
                  <span className="text-[9px] font-mono text-stealth-muted">{detailInfo.author}</span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={checkUpdates}
                    disabled={checkingUpdates}
                    className="rounded-sm border border-yellow-400/30 px-2 py-1 text-[8px] font-mono text-yellow-400/80 transition-colors whitespace-nowrap hover:bg-yellow-400/10 hover:text-yellow-400 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {checkingUpdates ? 'CHECKING...' : 'CHECK UPDATES'}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleOpenHfPage(detailInfo.id)}
                    className="rounded-sm border border-telemetry-cyan/30 px-2 py-1 text-[8px] font-mono text-telemetry-cyan/80 transition-colors whitespace-nowrap hover:bg-telemetry-cyan/10 hover:text-telemetry-cyan"
                  >
                    VIEW ON HF ↗
                  </button>
                </div>
              </div>
              {hfUpdates && hfUpdates.localCopyCount > 0 && hfUpdates.updateCount > 0 && (
                <div className="mb-2 pb-2 border-b border-stealth-border/40">
                  <div className="text-[9px] font-mono text-yellow-400 tracking-wider">
                    ⚠ {hfUpdates.updateCount} OF {hfUpdates.localCopyCount} LOCAL QUANT{hfUpdates.localCopyCount > 1 ? 'S' : ''} OUT OF DATE ON HF
                  </div>
                </div>
              )}

              <ModelStatsRow
                downloads={detailInfo.downloads}
                likes={detailInfo.likes_count}
                quants={detailInfo.gguf_files?.length || 0}
                tags={detailInfo.tags}
              />

              {detailInfo.description && (
                <div className="mb-3 pb-2 border-b border-stealth-border/40">
                  <p className="text-[10px] font-mono text-stealth-muted leading-relaxed line-clamp-4">
                    {detailInfo.description.slice(0, 500)}{detailInfo.description.length > 500 ? '...' : ''}
                  </p>
                </div>
              )}

              <div>
                <h3 className="text-[8px] font-mono text-nv-green tracking-wider uppercase mb-2 flex items-center gap-2">
                  <span>QUANTS ({selectedGgufFiles.length})</span>
                  {loadingQuantDates && (
                    <span className="text-stealth-muted/50 normal-case tracking-normal">dates…</span>
                  )}
                </h3>

                <div className="max-h-[300px] overflow-y-auto eink-scrollbar pr-1">
                  {selectedGgufFiles.map((file) => {
                    const vramGb = vramTier > 0 ? vramTier : 24;
                    const diskCheck = diskChecks?.get(file.type) ?? null;
                    const matchType = diskCheck?.matchType ?? 'none';
                    const hfUpdate = (matchType !== 'none')
                      ? (hfUpdates?.files.find(f => f.quantType === file.type) ?? null)
                      : null;
                    const shards = shardCount(file);
                    return (
                      <div
                        key={`${file.type}-${file.size_bytes}-${file.url}`}
                        className="theme-surface-row flex items-center justify-between py-2 px-2.5 mb-1 rounded-sm hover:border-nv-green/20 transition-all hub-file-enter"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <VramFitBadge sizeBytes={file.size_bytes} vramGb={vramGb} />
                          <QuantBadge type={file.type} sizeBytes={file.size_bytes} />
                          <span className="text-[10px] font-mono text-stealth-muted/60 flex-shrink-0">
                            {formatSize(file.size_bytes)}
                          </span>
                          {file.lastModified ? (
                            <span
                              className="shrink-0 text-[8px] font-mono text-stealth-muted/50"
                              title={file.lastModified}
                            >
                              {formatQuantDate(file.lastModified)}
                            </span>
                          ) : loadingQuantDates ? (
                            <span className="shrink-0 text-[8px] font-mono text-stealth-muted/30">…</span>
                          ) : null}
                          {shards > 1 && (
                            <span className="shrink-0 rounded-sm border border-stealth-border/50 bg-stealth-surface/60 px-1 py-0.5 text-[8px] font-mono text-stealth-muted/70">
                              {shards} SHARDS
                            </span>
                          )}
                          {hfUpdate?.hasUpdate && (
                            <span className="shrink-0 text-[8px] font-mono text-yellow-400/70 flex items-center gap-1">
                              ⚠ UPDATED
                            </span>
                          )}
                        </div>

                        {matchType === 'lfs' ? (
                          <span className="shrink-0 px-2 py-1 text-[9px] font-mono tracking-wider text-nv-green border border-nv-green/30 rounded-sm bg-nv-green/10">
                            ✓ IDENTICAL
                          </span>
                        ) : matchType === 'size' ? (
                          <span className="shrink-0 px-2 py-1 text-[9px] font-mono tracking-wider text-blue-400 border border-blue-400/30 rounded-sm bg-blue-400/10">
                            ✓ ON DISK
                          </span>
                        ) : matchType === 'mismatch' ? (
                          <button
                            onClick={() => handleDownload(detailInfo.id, file)}
                            className="shrink-0 px-3 py-1 text-[9px] font-mono tracking-wider bg-yellow-400/20 text-yellow-400 border border-yellow-400/40 rounded-sm hover:bg-yellow-400/30 transition-all"
                          >
                            UPDATE
                          </button>
                        ) : (
                          <button
                            onClick={() => handleDownload(detailInfo.id, file)}
                            className="shrink-0 px-3 py-1 text-[9px] font-mono tracking-wider bg-nv-green/20 text-nv-green border border-nv-green/40 rounded-sm hover:bg-nv-green/30 transition-all"
                          >
                            DOWNLOAD
                          </button>
                        )}
                      </div>
                    );
                  })}

                  {selectedGgufFiles.length === 0 && (
                    <p className="text-[10px] font-mono text-stealth-muted/40 italic py-4 text-center">
                      NO GGUF FILES FOUND FOR THIS MODEL
                    </p>
                  )}
                </div>
              </div>
            </div>
          ) : selectedSearchModel ? (
            <div key="placeholder-detail" className="flex items-center justify-center h-full text-stealth-muted/30 fade-in">
              <p className="text-[10px] font-mono italic">CLICK A MODEL TO LOAD DETAILS</p>
            </div>
          ) : (
            <div key="empty-detail" className="flex items-center justify-center h-full text-stealth-muted/30 fade-in">
              <p className="text-[10px] font-mono italic">SELECT A MODEL TO VIEW DETAILS</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
