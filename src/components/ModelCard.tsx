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

  let quantBadge: string | null = null;
  if (hasMetadata && model.metadata.file_type_str) {
    const ft = model.metadata.file_type_str.trim();
    if (ft) {
      quantBadge = ft.toUpperCase();
    }
  }

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
      archBadge = model.metadata.n_expert_used > 0 ? "MOE" : "DENSE";
    }
  }

  const hasMultimodal = model.vision;

  const isNvfp = quantBadge && (quantBadge.toLowerCase().includes('nvfp4') || quantBadge.toLowerCase().includes('mxfp4'));
  const quantBadgeClass = isNvfp
    ? 'bg-nv-green/10 border border-nv-green/20 text-nv-green/50'
    : 'border border-telemetry-cyan/15 text-telemetry-cyan/50';

  return (
    <div
      key={model.path}
      onClick={() => onSelect(model)}
      className={`relative cursor-pointer rounded-sm p-2.5 model-card-enter ${
        isSelected
           ? "gunmetal-card border"
           : "buried-card"
      }`}
    >
      {/* ── Author + path + GGUF badge ─── */}
      <div className="flex items-center justify-between gap-1.5 mb-1">
        <span className="text-[8px] font-mono text-stealth-muted truncate">{model.author}</span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {model.sourcePathLabel && (
            <span className="text-[7px] font-mono text-stealth-muted/50 bg-stealth-surface px-1 py-0.5 rounded-sm" title={model.path}>
              📁 {model.sourcePathLabel}
            </span>
          )}
          <span className="text-[8px] font-mono px-1 py-0.5 rounded-sm border border-gray-500/20 text-gray-500">
            GGUF
          </span>
        </div>
      </div>

      {/* ── Name + params ─── */}
      <span
        className="text-[11px] font-mono block truncate model-card-name"
        title={model.name}
      >
        {model.name}
      </span>

      {(paramsNum || (model.metadata?.nextn_predict_layers ?? 0 > 0)) && (
        <div className="flex items-center gap-1 mt-0.5">
          {paramsNum && (
            <span className="text-[8px] font-mono text-white">{paramsNum}</span>
          )}
          {archBadge && (
            <span className="text-[7px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm">{archBadge}</span>
          )}
          {(model.metadata?.nextn_predict_layers ?? 0) > 0 && (
            <span className="text-[7px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm">MTP</span>
          )}
          {hasMetadata && (
            <span className="text-[7px] font-mono text-white/[0.06]" title={model.metadata.architecture}>
              · {model.metadata.architecture} · KV:{model.metadata.n_ctx_train.toLocaleString()}
            </span>
          )}
        </div>
      )}

      {/* Footer — size/date (left) | multimodal+quant (right) */}
      {hasMetadata ? (
        <div className="mt-1 pt-1 border-t border-stealth-border/30 flex items-center justify-between">
          <div className="min-w-0 flex flex-col gap-0.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[8px] font-mono text-stealth-muted">{model.size_str}</span>
              <span className="text-[7px] font-mono text-white/60">
                {model.metadata?.file_created
                  ? new Date(model.metadata.file_created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                  : '--'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-0.5 flex-shrink-0 ml-2">
            {hasMultimodal && (
              <span className="text-[8px] font-mono px-1 py-0.5 rounded-sm border border-amber-400/15 text-amber-400/50">
                MULTIMODAL
              </span>
            )}
            {quantBadge && (
              <span className={`text-[8px] font-mono px-1 py-0.5 rounded-sm whitespace-nowrap ${quantBadgeClass}`}>
                {quantBadge}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="mt-1 pt-1 border-t border-stealth-border/30 flex items-center justify-between">
          <div className="flex items-center gap-1.5">
            <span className="text-[8px] font-mono text-stealth-muted">{model.size_str}</span>
            <span className="text-[7px] font-mono text-white/60">
              {model.metadata?.file_created
                ? new Date(model.metadata.file_created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })
                : '--'}
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
