import type { ModelEntry, ModelMetadata } from "../lib/types";
import { draftRoleBadge, draftRoleFromModel, isExternalDraftOnly } from "../lib/specDraft";
import { revealPathInExplorer } from "../lib/utils";

/**
 * Compact param-count formatting with T/B/M suffix.
 * Keeps 1 decimal for values < 10 (e.g. 8.4B), rounds above (e.g. 284B).
 */
function fmtParamCount(val: number, suffix: string): string {
  const s = suffix.toUpperCase();
  if (s === "T") return `${val}T`;
  if (s === "M") return `${val}M`;
  return val >= 10 ? `${Math.round(val)}B` : `${val.toFixed(1)}B`;
}

/** Parse "284.33 B", "122.11 B", "20.91 B" → { val, suffix } or null. */
function parseParamCount(raw: string | undefined | null): { val: number; suffix: string } | null {
  if (!raw) return null;
  const m = raw.trim().match(/^([\d.]+)\s*([TMB])$/i);
  if (!m) return null;
  const val = parseFloat(m[1]);
  if (isNaN(val)) return null;
  return { val, suffix: m[2].toUpperCase() };
}

/**
 * Extract the ACTIVE param count from a size label string.
 * Handles "230B.A10B" (total.active), "122B-A10B" (dash), "256x8.4B" (experts x active).
 * Returns null if the label carries no active-params info (e.g. plain "20B").
 */
function parseActiveFromLabel(label: string): { val: number; suffix: string } | null {
  if (!label) return null;
  // TOTAL.Active / TOTAL-Active → active is after the A marker
  const taMatch = label.match(/^[\d.]+[TMB][.-]A([\d.]+)([TMB])$/i);
  if (taMatch) {
    const val = parseFloat(taMatch[1]);
    if (!isNaN(val)) return { val, suffix: taMatch[2].toUpperCase() };
  }
  // NxActive (256x8.4B) → active is the second component. The expert count is NOT a
  // param total — never derive total from it (256 × 8.4B ≠ total).
  const xMatch = label.match(/^(\d+)x([\d.]+)([TMB])$/i);
  if (xMatch) {
    const val = parseFloat(xMatch[2]);
    if (!isNaN(val)) return { val, suffix: xMatch[3].toUpperCase() };
  }
  return null;
}

/**
 * Resolve the TOTAL / ACTIVE param display for a scanned model.
 *
 * Sources (in order of authority):
 *   - total_params_str  → print_info "model params" (e.g. "284.33 B"). Authoritative total.
 *   - modelTypeLabel    → "230B.A10B" | "122B-A10B" | "256x8.4B" | "20B"
 *   - rawKvs[general.size_label] → original quantizer label (kept when print_info is ?B)
 *
 * The "NxX" format means "N experts, X active params". It does NOT mean X params per
 * expert, so multiplying N × X to get a total is wrong (it produced bogus 2.2T for
 * DeepSeek V4 Flash). Total must come from total_params_str; if absent we show the
 * active count alone rather than fabricating a total.
 */
function resolveParamsDisplay(meta: ModelMetadata): { paramsNum: string; archBadge: string } {
  const isMoE = meta.n_expert_used > 0;

  // Prefer rawKvs size_label when modelTypeLabel is unparseable (e.g. deepseek4 prints
  // "?B" for model type, which would otherwise discard the informative "256x8.4B").
  let label = meta.modelTypeLabel || "";
  const rawLabel = meta.rawKvs?.["general.size_label"];
  if (!label.trim() || label.trim().toLowerCase() === "?b" || label.trim() === "?B") {
    label = rawLabel || label;
  }

  const active = parseActiveFromLabel(label);
  // Authoritative total from print_info "model params".
  let total = parseParamCount(meta.total_params_str);
  // Fallback: leading number of TOTAL.Active / plain label (NOT the expert count of NxX).
  if (!total && label && !/^\d+x/i.test(label)) {
    const lead = label.match(/^([\d.]+)([TMB])/i);
    if (lead) total = { val: parseFloat(lead[1]), suffix: lead[2].toUpperCase() };
  }

  let paramsNum = "";
  if (total && active) {
    paramsNum = `${fmtParamCount(total.val, total.suffix)} / ${fmtParamCount(active.val, active.suffix)}`;
  } else if (total) {
    paramsNum = fmtParamCount(total.val, total.suffix);
  } else if (active) {
    paramsNum = `${fmtParamCount(active.val, active.suffix)} active`;
  }

  return { paramsNum, archBadge: isMoE ? "MOE" : "DENSE" };
}

interface ModelCardProps {
  model: ModelEntry;
  isSelected: boolean;
  onSelect: (model: ModelEntry) => void;
  onScanModel?: (model: ModelEntry) => void;
  scanningPath: string | null;
  hfUpdateKind?: "header" | "full" | "current" | null;
  hfUpdateBusy?: boolean;
  onApplyHfUpdate?: () => void;
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
  hfUpdateKind = null,
  hfUpdateBusy = false,
  onApplyHfUpdate,
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
  const draftBadge = draftRoleBadge(draftRole, model);
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
    const resolved = resolveParamsDisplay(model.metadata);
    paramsNum = resolved.paramsNum;
    archBadge = resolved.archBadge;
  }

  const hasMultimodal = model.vision;

  const isNvfp = quantBadge && (quantBadge.toLowerCase().includes('nvfp4') || quantBadge.toLowerCase().includes('mxfp4'));
  const quantBadgeClass = isNvfp
    ? 'model-card-quant-badge model-card-quant-badge--nvfp bg-nv-green/10 border border-nv-green/20 text-nv-green/50'
    : 'model-card-quant-badge model-card-quant-badge--cyan border border-telemetry-cyan/15 text-telemetry-cyan/50';

  const metaTip = [
    model.metadata?.architecture ? `arch ${model.metadata.architecture}` : null,
    model.metadata?.n_ctx_train ? `KV ${model.metadata.n_ctx_train.toLocaleString()}` : null,
    fitScanBadge || null,
  ]
    .filter(Boolean)
    .join(" · ");

  const dateLabel = model.metadata?.file_created
    ? new Date(model.metadata.file_created * 1000).toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "2-digit",
      })
    : "--";

  return (
    <div
      onClick={() => onSelect(model)}
      className={`relative cursor-pointer rounded-sm px-2.5 py-2 model-catalog-card ${
        isDraftOnly ? "model-catalog-card--draft " : ""
      }${
        isSelected
          ? "gunmetal-card border"
          : "buried-card"
      }`}
      title={isDraftOnly ? "Draft model — cannot launch as main (use as speculative draft)" : undefined}
    >
      {isDraftOnly && (
        <div className="model-card-draft-hatch" aria-hidden="true" />
      )}
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
          {hfUpdateKind === "header" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onApplyHfUpdate?.();
              }}
              disabled={hfUpdateBusy}
              className="text-[7px] font-mono px-1 py-0.5 rounded-sm border border-cyan-400/40 text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/20 disabled:opacity-40"
              title="Metadata / jinja template only — small download"
            >
              {hfUpdateBusy ? "PATCHING…" : "HEADER"}
            </button>
          )}
          {hfUpdateKind === "full" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onApplyHfUpdate?.();
              }}
              disabled={hfUpdateBusy}
              className="text-[7px] font-mono px-1 py-0.5 rounded-sm border border-yellow-400/40 text-yellow-400 bg-yellow-400/10 hover:bg-yellow-400/20 disabled:opacity-40"
              title="Weights changed — full re-download (confirmation required)"
            >
              {hfUpdateBusy ? "QUEUING…" : "FULL"}
            </button>
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
        <div className="flex items-center gap-1 mt-0.5 min-w-0">
          {paramsNum && (
            <span className="text-[8px] font-mono text-white shrink-0">{paramsNum}</span>
          )}
          {archBadge && (
            <span className="text-[7px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm shrink-0">{archBadge}</span>
          )}
          {draftBadge && !isDraftOnly && (
            <span className="text-[7px] font-mono bg-black text-white/70 px-1 py-0.5 rounded-sm shrink-0">
              {draftBadge}
            </span>
          )}
        </div>
      )}

      {/* Footer — size/date (left) | stacked badges (right). Arch/KV/FIT in hover tip. */}
      {hasMetadata ? (
        <div className="model-card-footer mt-1 pt-1 border-t border-stealth-border/30">
          <div
            className={`model-card-meta${metaTip ? " model-card-meta--tip" : ""}`}
            {...(metaTip ? { "data-tip": metaTip } : {})}
          >
            <span className="model-card-size font-mono text-stealth-muted">{model.size_str}</span>
            <span className="model-card-date font-mono text-white/60">{dateLabel}</span>
          </div>
          <div className="model-card-badges">
            {fitScanAvailable && needsFitScan && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  onFitScanModel?.(model);
                }}
                disabled={fitScanning}
                className={`model-card-fit-scan text-[7px] font-mono px-1.5 py-0.5 rounded-sm transition-colors whitespace-nowrap ${
                  fitScanning
                    ? "text-nv-green border border-nv-green/40 bg-nv-green/10"
                    : "text-stealth-muted border border-stealth-border/60 hover:border-stealth-muted/50 hover:text-white/70 hover:bg-white/[0.04] disabled:opacity-30"
                }`}
                title="Run full VRAM fit probe (same 28 points as library FIT scan)"
              >
                {fitScanning
                  ? fitScanActiveLabel
                    ? `⠋ FIT ${fitScanActiveLabel}`
                    : "⠋ FIT…"
                  : "FIT SCAN"}
              </button>
            )}
            {draftBadge && isDraftOnly && (
              <span className="model-card-draft-badge text-[7px] font-mono px-1 py-0.5 rounded-sm">
                {draftBadge}
              </span>
            )}
            {/* Stack MULTIMODAL above QUANT so date never collides on narrow panels */}
            {(hasMultimodal || quantBadge) && (
              <div className="model-card-badges__stack">
                {hasMultimodal && (
                  <span
                    className="model-card-mm-badge text-[7px] font-mono px-1 py-0.5 rounded-sm border border-amber-400/20 text-amber-400/60"
                    title="Multimodal / vision"
                  >
                    MM
                  </span>
                )}
                {quantBadge && (
                  <span className={`text-[8px] font-mono px-1 py-0.5 rounded-sm whitespace-nowrap ${quantBadgeClass}`}>
                    {quantBadge}
                  </span>
                )}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="model-card-footer mt-1 pt-1 border-t border-stealth-border/30">
          <div className="model-card-meta">
            <span className="model-card-size font-mono text-stealth-muted">{model.size_str}</span>
            <span className="model-card-date font-mono text-white/60">{dateLabel}</span>
          </div>
          <div className="model-card-badges">
            {draftBadge && (
              <span className="model-card-draft-badge text-[7px] font-mono px-1 py-0.5 rounded-sm">
                {draftBadge}
              </span>
            )}
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onScanModel?.(model);
              }}
              disabled={isScanning || scanningPath !== null}
              className={`text-[7px] font-mono px-1.5 py-0.5 rounded-sm transition-colors ${
                isScanning
                  ? "text-telemetry-cyan border border-telemetry-cyan/40 bg-telemetry-cyan/10"
                  : "text-orange-400 border border-orange-400/30 hover:bg-orange-400/10 disabled:opacity-30"
              }`}
            >
              {isScanning ? "⠋ SCANNING..." : "⚠ SCAN"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}