import { useState, useCallback, useMemo, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { HfModel, GgufFile, HfSearchResponse, HfModelInfo } from '@/lib/types';

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

function extractQuantName(filename: string): string {
  const base = filename.replace('.gguf', '');
  const parts = base.split('-');
  return parts.length > 1 ? parts.slice(-2).join('-') : base;
}

export default function ModelHubSearch() {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<HfModel[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detailInfo, setDetailInfo] = useState<HfModelInfo | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [vramTier, setVramTier] = useState<number>(0);
  const [sortBy, setSortBy] = useState<'downloads' | 'likes' | 'lastModified'>('downloads');
  const [loading, setLoading] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  // Fetch full model info when selection changes
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

  const doSearch = async () => {
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
  };

  const handleDownload = async (modelId: string, file: GgufFile) => {
    try {
      const defaultPath = await invoke<string>('get_default_download_path');
      // Extract filename from URL — tree endpoint gives path like "Qwen3.6-35B-A3B-Q8_0.gguf"
      // or subpath like "BF16/model-BF16-001-of-002.gguf"
      const urlParts = file.url.split('/resolve/main/');
      const filePathInRepo = urlParts.length > 1 ? urlParts[1] : '';
      const fileName = filePathInRepo.split('/').pop() || `${file.type}.gguf`;

      // Derive author and repo from modelId ("author/repo") — catalog expects base_path/author/model_dir/*.gguf
      const slashIdx = modelId.indexOf('/');
      const hfAuthor = slashIdx > 0 ? modelId.slice(0, slashIdx) : 'unknown';
      const repoName = slashIdx > 0 ? modelId.slice(slashIdx + 1) : modelId;
      const destPath = `${defaultPath}/${hfAuthor}/${repoName}/${fileName}`;

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
  };

  const handleVramToggle = useCallback((gb: number) => {
    setVramTier(prev => prev === gb ? 0 : gb);
  }, []);

  // Search results only have filenames (no sizes), so no client-side VRAM filtering needed
  const filteredResults = useMemo(() => results, [results]);

  const selectedGgufFiles = useMemo(() => {
    if (!detailInfo) return [];
    return [...(detailInfo.gguf_files || [])].sort((a, b) => a.size_bytes - b.size_bytes);
  }, [detailInfo]);

  const selectedSearchModel = useMemo(() => results.find(m => m.id === selectedId), [results, selectedId]);

  return (
    <div className="flex flex-col h-full">
      {/* ── Toast ── */}
      {toast && (
        <div className="absolute top-4 right-4 z-50 px-3 py-1.5 text-[10px] font-mono tracking-wider bg-nv-green/20 border border-nv-green/40 text-nv-green rounded-sm toast-enter">
          {toast}
        </div>
      )}

      {/* ── Search Bar Area ── */}
      <div className="px-4 py-3 border-b border-stealth-border/50">
        <div className="flex items-center gap-2 mb-2.5">
          <span className="text-nv-green text-xs select-none">🔍</span>
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && doSearch()}
            placeholder="SEARCH HUGGING FACE MODELS..."
            className="flex-1 bg-stealth-dark border border-stealth-border rounded-sm px-3 py-2 text-xs font-mono text-white placeholder:text-stealth-muted/40 focus:outline-none focus:border-nv-green/40"
          />
          <button
            onClick={doSearch}
            disabled={loading || !query.trim()}
            className="px-4 py-2 text-xs font-mono tracking-wider bg-nv-green/20 text-nv-green border border-nv-green/40 rounded-sm hover:bg-nv-green/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed whitespace-nowrap"
          >
            {loading ? 'SEARCHING...' : 'SEARCH'}
          </button>
        </div>

        {/* VRAM tier filter + sort */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-[9px] font-mono text-stealth-muted tracking-wider uppercase">VRAM FIT:</span>
          {VRAM_TIERS.map(gb => (
            <button
              key={gb}
              onClick={() => handleVramToggle(gb)}
              className={`px-2 py-0.5 text-[10px] font-mono tracking-wider rounded-sm transition-all ${
                vramTier === gb
                  ? 'bg-nv-green/30 border border-nv-green/60 text-nv-green'
                  : 'border border-stealth-border/40 text-stealth-muted hover:border-nv-green/30 hover:text-white'
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

          <span className="text-[9px] font-mono text-stealth-muted tracking-wider uppercase">SORT:</span>
          {SORT_OPTIONS.map(opt => (
            <button
              key={opt.key}
              onClick={() => setSortBy(opt.key)}
              className={`px-2 py-0.5 text-[10px] font-mono tracking-wider rounded-sm transition-all ${
                sortBy === opt.key
                  ? 'bg-nv-green/30 border border-nv-green/60 text-nv-green'
                  : 'border border-stealth-border/40 text-stealth-muted hover:border-nv-green/30 hover:text-white'
              }`}
            >
              {opt.icon} {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* ── Results + Detail Split ── */}
      <div className="flex flex-1 overflow-hidden">
        {/* Left: Results List (~350px) */}
        <div className="w-[360px] min-w-[280px] border-r border-stealth-border/50 flex flex-col">
          <div className="px-3 py-1.5 border-b border-stealth-border/40 flex items-center justify-between">
            <span className="text-[9px] font-mono text-stealth-muted tracking-wider uppercase">
              RESULTS ({filteredResults.length})
            </span>
            {vramTier > 0 && (
              <span className="text-[8px] font-mono text-nv-green/60">{vramTier}GB FILTER</span>
            )}
          </div>

          <div className="flex-1 overflow-y-auto cyber-scrollbar">
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

            {filteredResults.map((model, idx) => (
              <button
                key={model.id}
                onClick={() => setSelectedId(model.id)}
                className={`w-full text-left border-b border-stealth-border/30 p-3 transition-all hover:bg-depth-black/40 hub-result-enter ${
                  selectedId === model.id ? 'bg-depth-black/60 border-l-2 border-l-nv-green' : ''
                }`}
              >
                  <div className="flex items-start justify-between gap-2 mb-1.5">
                    <span className="text-[9px] font-mono text-stealth-muted truncate">{model.author}</span>
                    {model.gguf_files && model.gguf_files.length > 0 && (
                      <span className="text-[8px] font-mono px-1 py-0.5 rounded-sm flex-shrink-0 border border-telemetry-cyan/20 text-telemetry-cyan/60">
                        {model.gguf_files.length} quants
                      </span>
                    )}
                  </div>

                  <div className="text-xs font-mono text-white/90 truncate mb-1.5">{model.id}</div>

                  <div className="flex items-center gap-3 text-[10px] font-mono text-stealth-muted">
                    <span>⬇ {formatNum(model.downloads)}</span>
                    <span>⭐ {formatNum(model.likes_count)}</span>
                  </div>

                  {/* Show quant names from search (filenames only, no sizes) */}
                  {model.gguf_files && model.gguf_files.length > 0 && (
                    <div className="flex gap-1 mt-1.5 flex-wrap">
                      {model.gguf_files.slice(0, 4).map((gf, i) => (
                        <span key={i} className="text-[8px] font-mono px-1 py-0.5 rounded-sm border border-telemetry-cyan/20 text-telemetry-cyan/60">
                          {extractQuantName(gf.type)}
                        </span>
                      ))}
                      {model.gguf_files!.length > 4 && (
                        <span className="text-[8px] font-mono text-stealth-muted/40">+{model.gguf_files!.length - 4}</span>
                      )}
                    </div>
                  )}
              </button>
            ))}
          </div>
        </div>

        {/* Right: Detail Panel — fetches full info on selection */}
        <div className="flex-1 overflow-y-auto cyber-scrollbar">
          <div className="flex-1 overflow-y-auto cyber-scrollbar">
            {loadingDetail ? (
              <div key="loading-detail" className="flex items-center justify-center h-full fade-in">
                <span className="text-xs font-mono text-nv-green hub-search-pulse">
                  LOADING MODEL INFO...
                </span>
              </div>
            ) : detailInfo ? (
              <div key={detailInfo.id} className="p-5 fade-in">
                {/* Back button + title */}
                <div className="flex items-center gap-3 mb-4">
                  <button
                    onClick={() => setSelectedId(null)}
                    className="text-[10px] font-mono text-stealth-muted hover:text-nv-green transition-colors px-2 py-1 border border-stealth-border/40 rounded-sm hover:border-nv-green/30"
                  >
                    ← BACK
                  </button>
                  <div>
                    <h2 className="text-sm font-mono text-white tracking-wide">{detailInfo.id}</h2>
                    <span className="text-[10px] font-mono text-stealth-muted">{detailInfo.author}</span>
                  </div>
                </div>

                {/* Stats row */}
                <div className="flex items-center gap-4 mb-4 pb-3 border-b border-stealth-border/40">
                  <div className="text-center">
                    <div className="text-xs font-mono text-white">{formatNum(detailInfo.downloads)}</div>
                    <div className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Downloads</div>
                  </div>
                  <div className="w-px h-6 bg-stealth-border/40" />
                  <div className="text-center">
                    <div className="text-xs font-mono text-white">{formatNum(detailInfo.likes_count)}</div>
                    <div className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Likes</div>
                  </div>
                  <div className="w-px h-6 bg-stealth-border/40" />
                  <div className="text-center">
                    <div className="text-xs font-mono text-white">{detailInfo.gguf_files?.length || 0}</div>
                    <div className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">Quants</div>
                  </div>
                </div>

                {/* Description */}
                {detailInfo.description && (
                  <div className="mb-4 pb-3 border-b border-stealth-border/40">
                    <p className="text-[11px] font-mono text-white/60 leading-relaxed line-clamp-6">
                      {detailInfo.description.slice(0, 500)}{detailInfo.description.length > 500 ? '...' : ''}
                    </p>
                  </div>
                )}

                {/* Tags */}
                {detailInfo.tags && detailInfo.tags.length > 0 && (
                  <div className="mb-4">
                    <h3 className="text-[9px] font-mono text-stealth-muted tracking-wider uppercase mb-1.5">TAGS</h3>
                    <div className="flex flex-wrap gap-1">
                      {detailInfo.tags.slice(0, 12).map(tag => (
                        <span key={tag} className="px-2 py-0.5 text-[9px] font-mono bg-stealth-dark border border-stealth-border rounded-sm text-stealth-muted/60">
                          {tag}
                        </span>
                      ))}
                    </div>
                  </div>
                )}

                {/* Quantization files with sizes + download */}
                <div>
                  <h3 className="text-[9px] font-mono text-nv-green tracking-wider uppercase mb-3">
                    QUANTIZATION OPTIONS ({selectedGgufFiles.length})
                  </h3>

                  {selectedGgufFiles.map((file, idx) => {
                    const vramGb = vramTier > 0 ? vramTier : 24;
                    const fitColor = getVramFitColor(file.size_bytes, vramGb);
                    const fitLabel = getVramFitLabel(file.size_bytes, vramGb);

                    return (
                      <div
                        key={file.type}
                        className="flex items-center justify-between py-2.5 px-3 mb-1 bg-stealth-dark/40 border border-stealth-border/30 rounded-sm hover:border-nv-green/20 transition-all hub-file-enter"
                      >
                        <div className="flex items-center gap-3 min-w-0">
                          <span className={`w-2 h-2 rounded-full flex-shrink-0 ${fitColor}`} />
                          <span className="text-xs font-mono text-white px-1.5 py-0.5 rounded-sm border border-telemetry-cyan/30 text-telemetry-cyan flex-shrink-0">
                            {extractQuantName(file.type)}
                          </span>
                          <span className="text-[10px] font-mono text-stealth-muted/60 flex-shrink-0">
                            {formatSize(file.size_bytes)}
                          </span>
                          {fitLabel && (
                            <span className={`text-[8px] font-mono tracking-wider flex-shrink-0 ${
                              fitColor === 'bg-nv-green' ? 'text-nv-green/60' :
                              fitColor.includes('yellow') ? 'text-yellow-500/60' :
                              'text-red-400/60'
                            }`}>
                              {fitLabel}
                            </span>
                          )}
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
    </div>
  );
}
