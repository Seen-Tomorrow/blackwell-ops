import type { ReactNode } from "react";
import type { SlotCtxInfo } from "../lib/types";

interface SlotCtxBarsProps {
  slotCtx: SlotCtxInfo[];
  ctxTotal: number;
  ctxPerSlot: number;
  parallel: number;
}

interface SlotBarData {
  index: number;
  isProcessing: boolean;
  pct: number;
  capacity: number;
}

/** Individual bars up to this count; above → single aggregate bar + slot count. */
const MAX_INDIVIDUAL_BARS = 8;

const equalBarStyle = { flex: "1 1 0%" } as const;

const outlineChip =
  "ctx-bar-capacity-chip text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border bg-transparent";

function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

function slotCapacity(slot: SlotCtxInfo | undefined, ctxPerSlot: number, ctxTotal: number): number {
  if (slot?.nCtxSlot && slot.nCtxSlot > 0) return slot.nCtxSlot;
  if (ctxPerSlot > 0) return ctxPerSlot;
  return ctxTotal;
}

/** Fill % = log-primary sessionNDecoded / per-slot engine budget. */
function slotUsage(slot: SlotCtxInfo | undefined, capacity: number): { pct: number; tokenBase: number } {
  const tokenBase = slot?.sessionNDecoded ?? 0;
  const denom = capacity > 0 ? capacity : 0;
  const pct = denom > 0 ? Math.min((tokenBase / denom) * 100, 100) : 0;
  return { pct, tokenBase };
}

function buildSlotBarData(
  slotCtx: SlotCtxInfo[],
  numSlots: number,
  ctxPerSlot: number,
  ctxTotal: number,
): SlotBarData[] {
  return Array.from({ length: numSlots }, (_, i) => {
    const slot = slotCtx.find((s) => s.id === i);
    const capacity = slotCapacity(slot, ctxPerSlot, ctxTotal);
    const { pct } = slotUsage(slot, capacity);
    return {
      index: i,
      isProcessing: slot?.is_processing ?? false,
      pct,
      capacity,
    };
  });
}

function aggregateSlotBarData(
  slotCtx: SlotCtxInfo[],
  ctxPerSlot: number,
  ctxTotal: number,
) {
  let maxPct = 0;
  let anyProcessing = false;
  let inUse = 0;
  let peakCapacity = ctxPerSlot > 0 ? ctxPerSlot : ctxTotal;
  for (const slot of slotCtx) {
    const capacity = slotCapacity(slot, ctxPerSlot, ctxTotal);
    peakCapacity = Math.max(peakCapacity, capacity);
    const { pct } = slotUsage(slot, capacity);
    if (pct > 0 || slot.is_processing) inUse += 1;
    maxPct = Math.max(maxPct, pct);
    anyProcessing = anyProcessing || slot.is_processing;
  }
  return { maxPct, anyProcessing, inUse, peakCapacity };
}

function pctTitle(pct: number, capacity: number, slotLabel?: string): string | undefined {
  if (pct <= 0) return undefined;
  return `${Math.round(pct)}% of ${formatTokenCount(capacity)} slot budget${slotLabel ? ` (${slotLabel})` : ""}`;
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
      {emptyLabel && pct <= 0 && (
        <span className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5">
          {emptyLabel}
        </span>
      )}
      {pct > 0 && (
        <span
          className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5"
          title={fillTitle}
        >
          <span
            className={`inline-block text-[6px] font-mono font-bold leading-none ctx-bar-fill-pct ${
              isProcessing ? "ctx-bar-fill-pct--active" : "ctx-bar-fill-pct--idle"
            }`}
          >
            {`${Math.round(pct)}%`}
          </span>
        </span>
      )}
      {pct > 0 && (
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

export default function SlotCtxBars({ slotCtx, ctxTotal, ctxPerSlot, parallel }: SlotCtxBarsProps) {
  const numSlots = Math.max(1, parallel || 1);
  const compact = numSlots > MAX_INDIVIDUAL_BARS;
  const defaultCapacity = ctxPerSlot > 0 ? ctxPerSlot : ctxTotal;

  const slots = compact
    ? null
    : buildSlotBarData(slotCtx, numSlots, ctxPerSlot, ctxTotal);

  const aggregate = compact ? aggregateSlotBarData(slotCtx, ctxPerSlot, ctxTotal) : null;

  const compactTitle = compact
    ? `${numSlots} slots · ${formatTokenCount(aggregate!.peakCapacity)} per slot`
      + (aggregate!.inUse > 0 ? ` · ${aggregate!.inUse} in use` : "")
      + (aggregate!.maxPct > 0 ? ` · peak fill ${Math.round(aggregate!.maxPct)}%` : "")
    : undefined;

  const renderIndividualBars = () => {
    if (!slots) return null;

    return (
      <>
        <div className="relative flex gap-0.5 flex-1 min-h-[28px] h-full items-stretch min-w-0">
          {slots.map((slot) => (
            <div key={slot.index} className="flex flex-col min-w-0 h-full" style={equalBarStyle}>
              <BarTrack
                pct={slot.pct}
                isProcessing={slot.isProcessing}
                isActive={slot.isProcessing}
                emptyLabel={
                  <span className={`inline-block ${outlineChip}`}>
                    {formatTokenCount(slot.capacity)}
                  </span>
                }
                fillTitle={pctTitle(slot.pct, slot.capacity, `S${slot.index + 1}`)}
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

    return (
      <>
        <div className="relative flex flex-1 min-h-[28px] h-full items-stretch min-w-0">
          <div className="flex flex-col min-w-0 h-full w-full">
            <BarTrack
              pct={aggregate.maxPct}
              isProcessing={aggregate.anyProcessing}
              isActive
              emptyLabel={
                <span className={`inline-block ${outlineChip}`}>
                  {formatTokenCount(aggregate.peakCapacity)}/slot
                </span>
              }
              fillTitle={pctTitle(aggregate.maxPct, aggregate.peakCapacity, "peak slot")}
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
        {numSlots > 1 && defaultCapacity > 0 && !compact && (
          <span
            className="text-[6px] font-mono text-stealth-muted/40 text-center mt-0.5 tracking-wide"
            title={`Engine allocates ${formatTokenCount(defaultCapacity)} KV per slot (${formatTokenCount(ctxTotal)} ÷ ${numSlots})`}
          >
            {formatTokenCount(defaultCapacity)}/slot
          </span>
        )}
      </div>
    </div>
  );
}