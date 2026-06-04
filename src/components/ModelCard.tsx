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
  const isNvfp = model.quant.toLowerCase().includes("nvfp");
  const isScanning = scanningPath === model.path;

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

  return (
    <div
      key={model.path}
      onClick={() => onSelect(model)}
      className={`relative cursor-pointer rounded-sm p-3 model-card-enter ${
        isSelected
           ? "brushed-steel-card border"
           : "cyber-card hover:bg-black/40"
      }`}
    >
      <div className="flex items-center gap-1.5 mb-1">
        <span className="text-[8px] font-mono text-stealth-muted truncate">{model.author}</span>
        {model.sourcePathLabel && (
          <span className="text-[7px] font-mono text-stealth-muted/50 bg-stealth-surface px-1 py-0.5 rounded-sm shrink-0" title={model.path}>
            📁 {model.sourcePathLabel}
          </span>
        )}
      </div>

      <div className="flex items-center justify-between gap-2">
        <span className="text-xs font-mono truncate flex-shrink min-w-0" style={isSelected ? { color: '#b87a00' } : undefined} title={model.name}>
          {model.name}
          {model.vision && (
            <span className="text-[8px] font-mono text-telemetry-cyan ml-1 flex-shrink-0">👁</span>
          )}
        </span>

        <div className="flex flex-col items-end flex-shrink-0 gap-0.5">
          <span className={`text-[9px] font-mono px-1 py-0.5 rounded-sm ${isNvfp
            ? 'bg-nv-green/20 border border-nv-green/40 text-nv-green'
            : 'border border-telemetry-cyan/30 text-telemetry-cyan'}`}>
            {model.quant}
          </span>
          <div className="flex items-center gap-1.5">
            <span className="text-[8px] font-mono text-stealth-muted">{model.size_str}</span>
            <span className="text-[7px] font-mono text-white/60">
              {model.metadata?.file_created ? new Date(model.metadata.file_created * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' }) : '--'}
            </span>
          </div>
        </div>
      </div>

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

      
      {hasMetadata ? (
        <div className="mt-1.5 pt-1.5 border-t border-stealth-border/30 flex justify-end">
          <span className="text-[7px] font-mono text-stealth-muted" title={model.metadata.architecture}>
            {model.metadata.architecture} · KV:{model.metadata.n_ctx_train.toLocaleString()} H:{model.metadata.n_head}({model.metadata.n_head_kv})
          </span>
        </div>
      ) : (
        <div className="mt-1.5 pt-1.5 border-t border-stealth-border/30 flex justify-end">
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
