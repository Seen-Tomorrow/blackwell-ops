import type { ModelEntry } from "../lib/types";
import { draftRoleBadge, draftRoleFromModel, isExternalDraftOnly } from "../lib/specDraft";
import { revealPathInExplorer } from "../lib/utils";

interface ModelCardProps {
  model: ModelEntry;
  isSelected: boolean;
  onSelect: (model: ModelEntry) => void;
  onScanModel?: (model: ModelEntry) => void;
  scanningPath: string | null;
  hfUpdateAvailable?: boolean;
  fitScanBadge?: string | null;
  fitScanAvailable?: boolean;
  needsFitScan?: boolean;
  fitScanning?: boolean;
  fitScanActiveLabel?: string | null;
  onFitScanModel?: (model: ModelEntry) => void;
}

export default function ModelCard({
  model,
  isSelected,
  onSelect,
  onScanModel,
  scanningPath,
  hfUpdateAvailable = false,
  fitScanBadge = null,
  fitScanAvailable = false,
  needsFitScan = false,
  fitScanning = false,
  fitScanActiveLabel = null,
  onFitScanModel,
}: ModelCardProps) {
  const hasMetadata = !!model.metadata;
  const isScanning = scanningPath === model.path;
  const draftRole = draftRoleFromModel(model);
  const draftBadge = draftRoleBadge(draftRole);
  const isDraftOnly = isExternalDraftOnly(model);

  const isShardNoiseQuant = (label: string) => /^\d{3,}$/.test(label.trim());
  let quantBadge: string | null = null;
  const headerQuant = model.metadata?.file_type_str?.trim() ?? "";
  const catalogQuant = model.quant?.trim() ?? "";
  const resolvedQuant =
    headerQuant && !isShardNoiseQuant(headerQuant)
      ? headerQuant
      : catalogQuant && catalogQuant !== "GGUF" && !isShardNoiseQuant(catalogQuant)
        ? catalogQuant
        : "";
  if (resolvedQuant) {
    quantBadge = resolvedQuant.toUpperCase();
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
    ? 'model-card-quant-badge model-card-quant-badge--nvfp bg-nv-green/10 border border-nv-green/20 text-nv-green/50'
    : 'model-card-quant-badge model-card-quant-badge--cyan border border-telemetry-cyan/15 text-telemetry-cyan/50';

  return (
    <div
      onClick={() => onSelect(model)}
      className={`relative cursor-pointer rounded-sm p-2.5 model-catalog-card ${
        isDraftOnly ? "model-catalog-card--draft " : ""
      }${
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
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void revealPathInExplorer(model.path);
              }}
              className="text-[7px] font-mono text-stealth-muted/50 bg-stealth-surface px-1 py-0.5 rounded-sm hover:text-stealth-muted hover:bg-stealth-surface/80 transition-colors cursor-pointer"
              title={`Open in Explorer: ${model.path}`}
            >
              📁 {model.sourcePathLabel}
            </button>
          )}
          <span className="text-[8px] font-mono px-1 py-0.5 rounded-sm border border-gray-500/20 text-gray-500">
            GGUF
          </span>
          {hfUpdateAvailable && (
            <span
              className="text-[7px] font-mono px-1 py-0.5 rounded-sm border border-yellow-400/30 text-yellow-400/80 bg-yellow-400/10"
              title="Newer version available on Hugging Face"
            >
              HF UPDATE
            </span>
          )}
        </div>
      </div>

      {/* ── Name + params ─── */}
      <span
        className="text-[11px] font-mono block truncate model-card-name"
        title={model.name}
      >
        {model.name}
      </span>

      {(paramsNum || (model.metadata?.nextn_predict_layers ?? 0) > 0 || draftBadge) && (
        <div className="flex items-center gap-1 mt-0.5">
          {paramsNum && (
            <span className="text-[8px] font-mono text-white">{paramsNum}</span>
          )}
          {archBadge && (
            <span className="text-[7px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm">{archBadge}</span>
          )}
          {draftBadge && !isDraftOnly && (
            <span className="text-[7px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm">
              {draftBadge}
            </span>
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
            {fitScanBadge && (
              <span
                className="text-[7px] font-mono px-1 py-0.5 rounded-sm border border-nv-green/25 text-nv-green/70 bg-nv-green/10 whitespace-nowrap"
                title="VRAM fit probe data cached for forecast"
              >
                {fitScanBadge}
              </span>
            )}
            {fitScanAvailable && needsFitScan && (
              <button
                onClick={(e) => { e.stopPropagation(); onFitScanModel?.(model); }}
                disabled={fitScanning}
                className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm transition-colors whitespace-nowrap ${
                  fitScanning
                    ? "text-nv-green border border-nv-green/40 bg-nv-green/10"
                    : "text-stealth-muted border border-stealth-border/60 hover:border-stealth-muted/50 hover:text-white/70 hover:bg-white/[0.04] disabled:opacity-30"
                }`}
                title="Run full VRAM fit probe (same 28 points as library FIT scan)"
              >
                {fitScanning
                  ? (fitScanActiveLabel ? `⠋ FIT ${fitScanActiveLabel}` : "⠋ FIT…")
                  : "FIT SCAN"}
              </button>
            )}
            {draftBadge && isDraftOnly && (
              <span className="text-[7px] font-mono px-1 py-0.5 rounded-sm bg-violet-500/15 border border-violet-400/25 text-violet-300/80">
                {draftBadge}
              </span>
            )}
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
          <div className="flex items-center gap-1">
            {draftBadge && (
              <span className="text-[7px] font-mono px-1 py-0.5 rounded-sm bg-violet-500/15 border border-violet-400/25 text-violet-300/80">
                {draftBadge}
              </span>
            )}
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
        </div>
      )}
    </div>
  );
}