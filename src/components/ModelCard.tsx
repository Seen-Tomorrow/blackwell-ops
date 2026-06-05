import type { ModelEntry } from "../lib/types";
import type { FitStatus } from "../hooks/useModelCatalog";

interface ModelCardProps {
  model: ModelEntry;
  idx: number;
  isSelected: boolean;
  isHighlighted: boolean;
  fitStatus: FitStatus;
  onSelect: (model: ModelEntry) => void;
  onScanModel?: (model: ModelEntry) => void;
  scanningPath: string | null;
}

export default function ModelCard({ model, idx, isSelected, isHighlighted, fitStatus, onSelect, onScanModel, scanningPath }: ModelCardProps) {
  const hasMetadata = !!model.metadata;
  const isScanning = scanningPath === model.path;

  // Derive quant badge from GGUF file_type_str — authoritative source (e.g., "Q4_K - Medium", "NVFP4")
  let quantBadge: string | null = null;
  if (hasMetadata && model.metadata.file_type_str) {
    const ft = model.metadata.file_type_str.trim();
    if (ft) {
      quantBadge = ft.toUpperCase();
    }
  }

  // Build params label + architecture badge
  let paramsNum = "";
  let archBadge = "";
  if (hasMetadata) {
    const rawTotal = model.metadata.modelTypeLabel || model.metadata.total_params_str;
    const numPart = parseFloat(rawTotal.replace(/[^0-9.]/g, ""));
    const suffixMatch = rawTotal.match(/([TMB])$/i);
    const suffix = suffixMatch ? suffixMatch[1].toUpperCase() : "B";
    if (!isNaN(numPart)) {
      const rounded = Math.round(numPart);
      paramsNum = `${rounded}${suffix}`;
      if (model.metadata.n_expert_used > 0) {
        archBadge = "MOE";
      } else {
        archBadge = "DENSE";
      }
    }
  }

  const hasMultimodal = model.vision;
  const hasQuant = !!quantBadge;
  const needsBottomBadges = hasMultimodal || hasQuant;

  return (
    <div
      key={model.path}
      onClick={() => onSelect(model)}
      className={`relative cursor-pointer rounded-sm p-3 ${
        needsBottomBadges ? 'pb-6' : 'pb-3'
      } model-card-enter ${
        isSelected
           ? "brushed-steel-card border"
           : "cyber-card hover:bg-black/40"
      }`}
    >
      {/* ── Top-right: GGUF badge ─── */}
      <span className="absolute top-1.5 right-1.5 text-[8px] font-mono px-1 py-0.5 rounded-sm border border-gray-500/20 text-gray-500">
        GGUF
      </span>

      {/* ── Bottom-right: MULTIMODAL + QUANT badges ─── */}
      {needsBottomBadges && (
        <div className="absolute bottom-1.5 right-1.5 flex flex-col items-end gap-0.5">
          {hasMultimodal && (
            <span className="text-[8px] font-mono px-1 py-0.5 rounded-sm border border-amber-400/30 text-amber-400">
              MULTIMODAL
            </span>
          )}
          {hasQuant && (
            <span className={`text-[8px] font-mono px-1 py-0.5 rounded-sm whitespace-nowrap ${
              quantBadge.toLowerCase().includes('nvfp4') || quantBadge.toLowerCase().includes('mxfp4')
                ? 'bg-nv-green/20 border border-nv-green/40 text-nv-green'
                : 'border border-telemetry-cyan/30 text-telemetry-cyan'
            }`}>
              {quantBadge}
            </span>
          )}
        </div>
      )}

      {/* ── Header: author row ─── */}
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[8px] font-mono text-stealth-muted truncate">{model.author}</span>
        {model.sourcePathLabel && (
          <span className="text-[7px] font-mono text-stealth-muted/50 bg-stealth-surface px-1 py-0.5 rounded-sm shrink-0" title={model.path}>
            📁 {model.sourcePathLabel}
          </span>
        )}
      </div>

      {/* ── Main row: name only ─── */}
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono truncate flex-shrink min-w-0" style={isSelected ? { color: '#b87a00' } : undefined} title={model.name}>
          {model.name}
        </span>
      </div>

      {/* ── Params / arch badges row ─── */}
      {(paramsNum || (model.metadata?.nextn_predict_layers ?? 0 > 0)) && (
        <div className="flex items-center gap-1.5 mt-0.5">
          {paramsNum && (
            <>
              <span className="text-[8px] font-mono text-white">{paramsNum}</span>
              {archBadge && (
                <span className="text-[7px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm">{archBadge}</span>
              )}
            </>
          )}
          {(model.metadata?.nextn_predict_layers ?? 0) > 0 && (
            <span className="text-[7px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm">MTP</span>
          )}
        </div>
      )}

      {/* ── Footer ─── */}
      {hasMetadata ? (
        <div className="mt-1.5 pt-1.5 border-t border-stealth-border/30 flex flex-col gap-0.5">
          <div className="flex items-center gap-1.5">
            <span className="text-[8px] font-mono text-stealth-muted">{model.size_str}</span>
            <span className="text-[7px] font-mono text-white/60">
              {model.metadata?.file_created ? new Date(model.metadata.file_created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '--'}
            </span>
          </div>
          <span className="text-[7px] font-mono text-stealth-muted" title={model.metadata.architecture}>
            {model.metadata.architecture} · KV:{model.metadata.n_ctx_train.toLocaleString()} H:{model.metadata.n_head}({model.metadata.n_head_kv})
          </span>
        </div>
      ) : (
        <div className="mt-1.5 pt-1.5 border-t border-stealth-border/30 flex justify-between items-center">
          <div className="flex items-center gap-1.5">
            <span className="text-[8px] font-mono text-stealth-muted">{model.size_str}</span>
            <span className="text-[7px] font-mono text-white/60">
              {model.metadata?.file_created ? new Date(model.metadata.file_created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '--'}
            </span>
          </div>
          <button
            onClick={(e) => { e.stopPropagation(); onScanModel?.(model); }}
            disabled={isScanning || scanningPath !== null}
            className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm transition-colors ${
              isScanning
                ? 'text-telemetry-cyan border border-telemetry-cyan/40 bg-telemetry-cyan/10'
                : 'text-orange-400 border border-orange-400/30 hover:bg-orange-400/10 disabled:opacity-30'
            }`}
          >
            {isScanning ? '⠋ SCANNING...' : '⚠ SCAN'}
          </button>
        </div>
      )}
    </div>
  );
}
