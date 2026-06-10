import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { join } from '@tauri-apps/api/path';
import { open } from '@tauri-apps/plugin-shell';
import type { HfModel, GgufFile, HfSearchResponse, HfModelInfo } from '@/lib/types';
import { useModelHubSplitResize } from '../hooks/useCatalogSplitResize';
import QuantBadge from './QuantBadge';
import VramFitBadge from './VramFitBadge';
import ModelStatsRow from './ModelStatsRow';

function hfModelUrl(modelId: string): string {
  return `https://huggingface.co/${modelId}`;
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
    if (!selectedId) { setDetailInfo(null); return; }
    let cancelled = false;
    setLoadingDetail(true);
    (async () => {
      try {
        const token = await invoke<string | null>('get_hf_token').catch(() => null);
        const info = await invoke<HfModelInfo>('get_hf_model_info', {
          modelId: selectedId,
          hfToken: token || undefined,
        });
        if (!cancelled) setDetailInfo(info);
      } catch (e) {
        console.error('Failed to load model info:', e);
      } finally {
        if (!cancelled) setLoadingDetail(false);
      }
    })();
    return () => { cancelled = true; };
  }, [selectedId]);

  const doSearch = useCallback(async () => {
    if (!query.trim()) return;
    setLoading(true);
    setSelectedId(null);
    try {
      const token = await invoke<string | null>('get_hf_token').catch(() => null);
      const resp = await invoke<HfSearchResponse>('search_hf_models', {
        query: query.trim(),
        vramLimitGb: vramTier > 0 ? vramTier : undefined,
        sort: sortBy,
        limit: 50,
        hfToken: token || undefined,
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
    try {
      const defaultPath = await invoke<string>('get_default_download_path');
      const urlParts = file.url.split('/resolve/main/');
      const filePathInRepo = urlParts.length > 1 ? urlParts[1] : '';
      const fileName = filePathInRepo.split('/').pop() || `${file.type}.gguf`;

      const slashIdx = modelId.indexOf('/');
      const hfAuthor = slashIdx > 0 ? modelId.slice(0, slashIdx) : 'unknown';
      const repoName = slashIdx > 0 ? modelId.slice(slashIdx + 1) : modelId;
      const destPath = await join(defaultPath, hfAuthor, repoName, fileName);

      await invoke('start_download', {
        hfModelId: modelId,
        fileName,
        url: file.url,
        totalBytes: file.size_bytes,
        destPath,
        hfAuthor,
        quantType: file.type,
        lfsOid: file.lfsOid || '',
      });
      showToast(`⬇ DOWNLOADING ${file.type}...`);
    } catch (e) {
      console.error('Download failed:', e);
      showToast(`DOWNLOAD FAILED: ${typeof e === 'string' ? e : 'unknown error'}`);
    }
  }, [showToast]);

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
                <button
                  type="button"
                  onClick={() => handleOpenHfPage(detailInfo.id)}
                  className="shrink-0 rounded-sm border border-telemetry-cyan/30 px-2 py-1 text-[8px] font-mono text-telemetry-cyan/80 transition-colors whitespace-nowrap hover:bg-telemetry-cyan/10 hover:text-telemetry-cyan"
                >
                  VIEW ON HF ↗
                </button>
              </div>

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
                <h3 className="text-[8px] font-mono text-nv-green tracking-wider uppercase mb-2">
                  QUANTS ({selectedGgufFiles.length})
                </h3>

                {selectedGgufFiles.map((file) => {
                  const vramGb = vramTier > 0 ? vramTier : 24;
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
                      </div>

                      <button
                        onClick={() => handleDownload(detailInfo.id, file)}
                        className="px-3 py-1 text-[9px] font-mono tracking-wider bg-nv-green/20 text-nv-green border border-nv-green/40 rounded-sm hover:bg-nv-green/30 transition-all flex-shrink-0 ml-2"
                      >
                        DOWNLOAD
                      </button>
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
