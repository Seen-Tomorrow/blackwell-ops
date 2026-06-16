import type { ReactNode } from "react";
import type { SlotCtxInfo } from "../lib/types";

interface SlotCtxBarsProps {
  slotCtx: SlotCtxInfo[];
  ctxTotal: number;
  parallel: number;
  unifiedKv: boolean;
}

interface SlotBarData {
  index: number;
  isProcessing: boolean;
  pct: number;
}

/** Individual bars up to this count; above → single aggregate bar + slot count. */
const MAX_INDIVIDUAL_BARS = 8;

const equalBarStyle = { flex: "1 1 0%" } as const;

const outlineChip =
  "ctx-bar-capacity-chip text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border bg-transparent";

const sharedPoolChip =
  "ctx-shared-pool-chip text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border bg-transparent w-full text-center block";

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

function slotUsage(slot: SlotCtxInfo, barCapacity: number): { pct: number; tokenBase: number } {
  const live =
    (slot.promptTokensCache || 0) + (slot.promptTokensProcessed || 0) + (slot.n_decoded || 0);
  // Short agent turns reset live fields before session KV — never flash 0% when session still full.
  const tokenBase = Math.max(live, slot.sessionNDecoded ?? 0);
  const pct = barCapacity > 0 ? Math.min((tokenBase / barCapacity) * 100, 100) : 0;
  return { pct, tokenBase };
}

function buildSlotBarData(
  slotCtx: SlotCtxInfo[],
  numSlots: number,
  barCapacity: number,
): SlotBarData[] {
  return Array.from({ length: numSlots }, (_, i) => {
    const slot = slotCtx.find((s) => s.id === i);
    if (!slot) {
      return { index: i, isProcessing: false, pct: 0 };
    }
    const { pct } = slotUsage(slot, barCapacity);
    return { index: i, isProcessing: slot.is_processing, pct };
  });
}

function aggregateSlotBarData(slotCtx: SlotCtxInfo[], barCapacity: number) {
  let maxPct = 0;
  let anyProcessing = false;
  let inUse = 0;
  for (const slot of slotCtx) {
    const { pct } = slotUsage(slot, barCapacity);
    if (pct > 0 || slot.is_processing) inUse += 1;
    maxPct = Math.max(maxPct, pct);
    anyProcessing = anyProcessing || slot.is_processing;
  }
  return { maxPct, anyProcessing, inUse };
}

function pctTitle(
  pct: number,
  unifiedKv: boolean,
  ctxTotal: number,
  barCapacity: number,
  slotLabel?: string,
): string | undefined {
  if (pct <= 0) return undefined;
  if (unifiedKv) {
    return `${Math.round(pct)}% of shared ${formatTokenCount(ctxTotal)} pool${slotLabel ? ` (${slotLabel})` : ""}`;
  }
  return `${Math.round(pct)}% of ${formatTokenCount(barCapacity)} slot budget${slotLabel ? ` (${slotLabel})` : ""}`;
}

function BarTrack({
  pct,
  isProcessing,
  isActive,
  emptyLabel,
  fillTitle,
}: {
  pct: number;
  isProcessing: boolean;
  isActive: boolean;
  emptyLabel?: ReactNode;
  fillTitle?: string;
}) {
  return (
    <div
      className={`ctx-bar-track flex-1 min-h-0 w-full rounded-sm overflow-hidden relative ${
        isActive ? "ctx-bar-track--active" : "ctx-bar-track--empty"
      }`}
    >
      {isActive && emptyLabel && pct <= 0 && (
        <span className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5">
          {emptyLabel}
        </span>
      )}
      {isActive && (
        <span
          className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5"
          title={fillTitle}
        >
          <span
            className={`inline-block text-[6px] font-mono font-bold leading-none ctx-bar-fill-pct ${
              pct > 0 ? "ctx-bar-fill-pct--active" : "ctx-bar-fill-pct--idle"
            }`}
          >
            {pct > 0 ? `${Math.round(pct)}%` : ""}
          </span>
        </span>
      )}
      {isActive && pct > 0 && (
        <div
          className={`ctx-bar-fill absolute bottom-0 left-0 right-0 rounded-sm z-[1] ${
            isProcessing ? "ctx-bar-fill--processing" : "ctx-bar-fill--idle"
          }`}
          style={{
            height: `${pct}%`,
            transition: "height 0.3s ease",
          }}
        />
      )}
    </div>
  );
}

export default function SlotCtxBars({ slotCtx, ctxTotal, parallel, unifiedKv }: SlotCtxBarsProps) {
  const numSlots = Math.max(1, parallel || 1);
  const compact = numSlots > MAX_INDIVIDUAL_BARS;
  const isSingleSlot = numSlots === 1;
  // Partitioned: each slot owns ctx/parallel. Unified: all slots share one ctx-sized pool.
  const barCapacity = unifiedKv ? ctxTotal : Math.floor(ctxTotal / numSlots);
  const showSharedSpan = unifiedKv && numSlots > 1 && !compact;

  const slots = compact
    ? null
    : buildSlotBarData(slotCtx, numSlots, barCapacity);

  const aggregate = compact ? aggregateSlotBarData(slotCtx, barCapacity) : null;

  const compactTitle = compact
    ? `${numSlots} slots`
      + (unifiedKv
        ? ` · shared ${formatTokenCount(ctxTotal)} pool`
        : ` · ${formatTokenCount(barCapacity)} per slot`)
      + (aggregate!.inUse > 0 ? ` · ${aggregate!.inUse} in use` : "")
      + (aggregate!.maxPct > 0 ? ` · peak fill ${Math.round(aggregate!.maxPct)}%` : "")
    : undefined;

  const renderIndividualBars = () => {
    if (!slots) return null;

    const emptyLabelForSlot = (slot: SlotBarData) => {
      if (!unifiedKv) {
        return <span className={`inline-block ${outlineChip}`}>{formatTokenCount(barCapacity)}</span>;
      }
      if (isSingleSlot) {
        return (
          <span className={`inline-block ${sharedPoolChip}`}>
            {formatTokenCount(barCapacity)} · shared pool
          </span>
        );
      }
      return undefined;
    };

    return (
      <>
        <div
          className="relative flex gap-0.5 flex-1 min-h-[28px] h-full items-stretch min-w-0"
          style={{ paddingTop: showSharedSpan ? 11 : 0 }}
        >
          {showSharedSpan && (
            <div className="absolute -top-1 left-0 right-0 z-10 pointer-events-none px-0.5">
              <span className={sharedPoolChip}>
                {formatTokenCount(barCapacity)} · shared pool
              </span>
            </div>
          )}
          {slots.map((slot) => (
            <div key={slot.index} className="flex flex-col min-w-0 h-full" style={equalBarStyle}>
              <BarTrack
                pct={slot.pct}
                isProcessing={slot.isProcessing}
                isActive
                emptyLabel={emptyLabelForSlot(slot)}
                fillTitle={pctTitle(slot.pct, unifiedKv, ctxTotal, barCapacity, `S${slot.index + 1}`)}
              />
            </div>
          ))}
        </div>

        <div className="flex gap-0.5 mt-0.5 flex-shrink-0 min-w-0">
          {slots.map((slot) => (
            <div
              key={slot.index}
              className="flex flex-col items-center min-w-0"
              style={equalBarStyle}
            >
              <span className="ctx-bar-slot-label text-[7px] font-mono px-1 py-0.5 rounded-sm leading-none">
                S{slot.index + 1}
              </span>
            </div>
          ))}
        </div>
      </>
    );
  };

  const renderCompactBars = () => {
    if (!aggregate) return null;

    const emptyLabel = !unifiedKv ? (
      <span className={`inline-block ${outlineChip}`}>{formatTokenCount(barCapacity)}/slot</span>
    ) : (
      <span className={`inline-block ${sharedPoolChip}`}>
        {formatTokenCount(barCapacity)} · shared
      </span>
    );

    return (
      <>
        <div className="relative flex flex-1 min-h-[28px] h-full items-stretch min-w-0">
          <div className="flex flex-col min-w-0 h-full w-full">
            <BarTrack
              pct={aggregate.maxPct}
              isProcessing={aggregate.anyProcessing}
              isActive
              emptyLabel={emptyLabel}
              fillTitle={pctTitle(aggregate.maxPct, unifiedKv, ctxTotal, barCapacity, "peak slot")}
            />
          </div>
        </div>

        <div className="flex justify-center mt-0.5 flex-shrink-0 min-w-0">
          <span
            className="fusion-mult-chip ctx-bar-compact-label text-[7px] font-mono px-1.5 py-0.5 rounded-sm leading-none tracking-wide"
            title={compactTitle}
          >
            ×{numSlots}
          </span>
        </div>
      </>
    );
  };

  return (
    <div className="flex w-full h-full min-h-0">
      <div className="flex flex-col flex-1 min-w-0 h-full min-h-0">
        {compact ? renderCompactBars() : renderIndividualBars()}
      </div>
    </div>
  );
}