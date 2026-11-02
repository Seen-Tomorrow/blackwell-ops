import type { ModelEntry, ModelMetadata, CatalogUpdateEntry } from "../lib/types";
import { BAKED_MTP_BADGE, draftRoleBadge, draftRoleFromModel, hasBakedMtp, isExternalDraftOnly } from "../lib/specDraft";
import { revealPathInExplorer } from "../lib/utils";
import { CATALOG_SEAT_LABEL, type CatalogSeatRole } from "../lib/catalogQuickAccess";
import { fitNowLabel, type FitNowVerdict } from "../lib/catalogFitNow";

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
 *   - total_params_str  → summed from the header's tensor table (e.g. "284.33 B")
 *   - modelTypeLabel    → `general.size_label` verbatim: "230B.A10B" | "122B-A10B" | "20B"
 *
 * The "NxX" format means "N experts, X active params". It does NOT mean X params per
 * expert, so multiplying N × X to get a total is wrong (it produced bogus 2.2T for
 * DeepSeek V4 Flash). Total must come from total_params_str; if absent we show the
 * active count alone rather than fabricating a total.
 */
function resolveParamsDisplay(meta: ModelMetadata): { paramsNum: string; archBadge: string } {
  const isMoE = meta.n_expert_used > 0;

  const label = meta.modelTypeLabel || "";

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
  pinned?: boolean;
  onTogglePin?: (model: ModelEntry) => void;
  seatRole?: CatalogSeatRole | null;
  fitNow?: { verdict: FitNowVerdict; title: string } | null;
  /** Transient result of the most recent update check — renders a fading bubble. */
  checkVerdict?: CatalogUpdateEntry | null;
  /** Click-to-dismiss the verdict-only bubble (UP TO DATE / NOT PAIRED). */
  onBubbleDismiss?: () => void;
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
  pinned = false,
  onTogglePin,
  seatRole = null,
  fitNow = null,
  checkVerdict = null,
  onBubbleDismiss,
}: ModelCardProps) {
  const hasMetadata = !!model.metadata;
  const isScanning = scanningPath === model.path;
  const draftRole = draftRoleFromModel(model);
  const draftBadge = draftRoleBadge(draftRole, model) ?? (hasBakedMtp(model) ? BAKED_MTP_BADGE : null);
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
    ? 'model-card-quant-badge model-card-quant-badge--nvfp mcard-quant--nvfp border'
    : 'model-card-quant-badge model-card-quant-badge--cyan mcard-quant--cyan border';

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

  // Update-check verdict for this card: UP TO DATE / NOT PAIRED / HEADER / FULL.
  // Persistent until applied or dismissed — a verdict that vanishes after 6 s cannot be
  // re-read, which made the check feel like it had done nothing.
  const checkBubble = (() => {
    if (!checkVerdict) return null;
    if (checkVerdict.kind === "full") {
      return { text: "UPDATE · FULL", variant: "full" as const, icon: "▲", actionable: true, btnLabel: hfUpdateBusy ? "QUEUING…" : "DOWNLOAD" };
    }
    if (checkVerdict.kind === "header") {
      return { text: "UPDATE · METADATA", variant: "header" as const, icon: "◆", actionable: true, btnLabel: hfUpdateBusy ? "PATCHING…" : "PATCH" };
    }
    // kind === "current"
    if (checkVerdict.noRemote) {
      return { text: "NOT PAIRED", variant: "none" as const, icon: "∅", actionable: false, btnLabel: "" };
    }
    return { text: "UP TO DATE", variant: "current" as const, icon: "✓", actionable: false, btnLabel: "" };
  })();


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
      {checkBubble && (
        <div
          className={`model-card-check-bubble model-card-check-bubble--${checkBubble.variant}${
            checkBubble.actionable ? " model-card-check-bubble--actionable" : ""
          }`}
          role="status"
          aria-live="polite"
          title={checkVerdict?.reason || undefined}
          onClick={
            checkBubble.actionable
              ? undefined
              : (e) => {
                  e.stopPropagation();
                  onBubbleDismiss?.();
                }
          }
        >
          <span className="model-card-check-bubble__icon" aria-hidden>{checkBubble.icon}</span>
          {checkBubble.text}
          {checkBubble.actionable && onApplyHfUpdate && (
            <button
              type="button"
              className="model-card-check-bubble__btn"
              onClick={(e) => {
                e.stopPropagation();
                onApplyHfUpdate();
              }}
              disabled={hfUpdateBusy}
            >
              {checkBubble.btnLabel}
            </button>
          )}
        </div>
      )}
      {isDraftOnly && (
        <div className="model-card-draft-hatch" aria-hidden="true" />
      )}
      {/* Reserved one-line row. It is always there (so nothing moves when it appears) and
          only shows the library path while the card is hovered. */}
      <div className="model-card-path-row">
        {model.sourcePathLabel && (
          <span
            className="model-card-path-hover type-micro font-mono"
            title={`Double-click to open in Explorer:\n${model.path}`}
            onDoubleClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              void revealPathInExplorer(model.path);
            }}
          >
            {model.sourcePathLabel}
          </span>
        )}
      </div>

      {/* Name leads, star alone on the right. Author sits beneath it. */}
      <div className="flex items-start justify-between gap-1.5 mb-0.5">
        <span className="type-md font-mono block truncate model-card-name min-w-0" title={model.name}>
          {model.name}
        </span>
        {onTogglePin && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTogglePin(model);
            }}
            className={`model-card-pin type-label leading-none px-0.5 py-0 border-0 bg-transparent cursor-pointer flex-shrink-0 ${
              pinned ? "model-card-pin--on" : "model-card-pin--off"
            }`}
            title={pinned ? "Unpin from catalog quick strip" : "Pin to catalog quick strip"}
            aria-label={pinned ? "Unpin model" : "Pin model"}
            aria-pressed={pinned}
          >
            {pinned ? "\u2605" : "\u2606"}
          </button>
        )}
      </div>

      {/* Author line; seat + HF-update chips live here so the name row keeps only the star. */}
      <div className="flex items-center justify-between gap-1.5 mb-1 min-w-0">
        <span className="type-tiny font-mono mcard-author truncate min-w-0">{model.author}</span>
        <div className="flex items-center gap-1.5 flex-shrink-0">
          {seatRole && (
            <span
              className={`model-card-seat model-card-seat--${seatRole} type-micro font-mono px-1 py-0.5 rounded-sm`}
              title={`Sticky seat: ${CATALOG_SEAT_LABEL[seatRole]}`}
            >
              {CATALOG_SEAT_LABEL[seatRole]}
            </span>
          )}
          {hfUpdateKind === "header" && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onApplyHfUpdate?.();
              }}
              disabled={hfUpdateBusy}
              className="mcard-hf type-micro font-mono px-1 py-0.5 rounded-sm border mcard-hf--header disabled:opacity-40"
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
              className="mcard-hf type-micro font-mono px-1 py-0.5 rounded-sm border mcard-hf--full disabled:opacity-40"
              title="Weights changed — full re-download (confirmation required)"
            >
              {hfUpdateBusy ? "QUEUING…" : "FULL"}
            </button>
          )}
        </div>
      </div>

      {(paramsNum || hasMultimodal || fitNow || hasBakedMtp(model) || draftBadge) && (
        <div className="flex items-center gap-1 mt-0.5 min-w-0">
          {paramsNum && (
            <span className="type-tiny font-mono mcard-params shrink-0">{paramsNum}</span>
          )}
          {archBadge && (
            <span className="type-micro font-mono mcard-inkchip px-1 py-0.5 rounded-sm shrink-0">{archBadge}</span>
          )}
          {draftBadge && !isDraftOnly && (
            <span className="type-micro font-mono mcard-inkchip px-1 py-0.5 rounded-sm shrink-0">
              {draftBadge}
            </span>
          )}
          {/* Right-aligned group. A green FITS on every card said nothing, so only the
              states that need attention are printed - TIGHT / NO - while the filter in the
              catalog header still works on the full verdict. */}
          <span className="ml-auto flex items-center gap-1 shrink-0">
            {fitNow && (fitNow.verdict === "tight" || fitNow.verdict === "no") && (
              <span
                className={`model-card-fitnow model-card-fitnow--${fitNow.verdict} type-micro font-mono px-1 py-0.5 rounded-sm shrink-0`}
                title={fitNow.title}
              >
                {fitNowLabel(fitNow.verdict)}
              </span>
            )}
            {hasMultimodal && (
              <span className="model-card-mm-badge mcard-mm type-micro font-mono px-1 py-0.5 rounded-sm border shrink-0 whitespace-nowrap">
                MULTIMODAL
              </span>
            )}
          </span>
        </div>
      )}

      {/* Footer — size/date (left) | stacked badges (right). Arch/KV/FIT in hover tip. */}
      {hasMetadata ? (
        <div className="model-card-footer mcard-footer mt-1 pt-1 border-t">
          <div
            className={`model-card-meta${metaTip ? " model-card-meta--tip" : ""}`}
            {...(metaTip ? { "data-tip": metaTip } : {})}
          >
            <span className="model-card-size font-mono mcard-meta-mut">{model.size_str}</span>
            <span className="model-card-date font-mono mcard-date">{dateLabel}</span>
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
                className={`model-card-fit-scan type-micro font-mono px-1.5 py-0.5 rounded-sm transition-colors whitespace-nowrap ${
                  fitScanning
                    ? "mcard-fit-scan--scanning border"
                    : "mcard-fit-scan border"
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
              <span className="model-card-draft-badge type-micro font-mono px-1 py-0.5 rounded-sm">
                {draftBadge}
              </span>
            )}
            {quantBadge && (
              <span className={`type-tiny font-mono px-1 py-0.5 rounded-sm whitespace-nowrap ${quantBadgeClass}`}>
                {quantBadge}
              </span>
            )}
          </div>
        </div>
      ) : (
        <div className="model-card-footer mcard-footer mt-1 pt-1 border-t">
          <div className="model-card-meta">
            <span className="model-card-size font-mono mcard-meta-mut">{model.size_str}</span>
            <span className="model-card-date font-mono mcard-date">{dateLabel}</span>
          </div>
          <div className="model-card-badges">
            {draftBadge && (
              <span className="model-card-draft-badge type-micro font-mono px-1 py-0.5 rounded-sm">
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
              className={`type-micro font-mono px-1.5 py-0.5 rounded-sm transition-colors ${
                isScanning
                  ? "mcard-scan--scanning border"
                  : "mcard-scan border"
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