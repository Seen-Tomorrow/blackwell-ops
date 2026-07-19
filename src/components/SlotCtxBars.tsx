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

/**
 * Classic fusion dashboard: up to 8 equal vertical bars in one row.
 * 9–32 keep the same bar language as a multi-row bank (8 per row).
 * Above 32 → single aggregate peak bar (extreme / future).
 */
const BARS_PER_ROW = 8;
const MAX_INDIVIDUAL_SLOTS = 32;

const equalBarStyle = { flex: "1 1 0%" } as const;

const outlineChip =
  "ctx-bar-capacity-chip text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border bg-transparent";

export function formatTokenCount(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

/** Left hero-column width so 16/32 banks stay readable without crushing TG/PP heroes. */
export function fusionSlotColumnLayout(parallel: number): { widthPct: number; minWidth: number } {
  const n = Math.max(1, parallel || 1);
  if (n <= 8) return { widthPct: 24, minWidth: 132 };
  if (n <= 16) return { widthPct: 30, minWidth: 168 };
  return { widthPct: 36, minWidth: 200 };
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

function chunkSlots<T>(items: T[], size: number): T[][] {
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    rows.push(items.slice(i, i + size));
  }
  return rows;
}

function BarTrack({
  pct,
  isProcessing,
  isActive,
  emptyLabel,
  fillTitle,
  dense,
}: {
  pct: number;
  isProcessing: boolean;
  isActive: boolean;
  emptyLabel?: ReactNode;
  fillTitle?: string;
  dense?: boolean;
}) {
  return (
    <div
      className={`ctx-bar-track flex-1 min-h-0 w-full rounded-sm overflow-hidden relative ${
        isActive ? "ctx-bar-track--active" : "ctx-bar-track--empty"
      }`}
      title={fillTitle}
    >
      {emptyLabel && pct <= 0 && (
        <span className="absolute top-0.5 left-0 right-0 text-center z-10 pointer-events-none px-0.5">
          {emptyLabel}
        </span>
      )}
      {pct > 0 && !dense && (
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
      {pct > 0 && dense && (
        <span
          className="absolute inset-x-0 top-0 z-10 pointer-events-none text-center"
          title={fillTitle}
        >
          <span
            className={`inline-block text-[5px] font-mono font-bold leading-none ctx-bar-fill-pct ${
              isProcessing ? "ctx-bar-fill-pct--active" : "ctx-bar-fill-pct--idle"
            }`}
          >
            {Math.round(pct)}
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
  const useAggregate = numSlots > MAX_INDIVIDUAL_SLOTS;
  const dense = numSlots > BARS_PER_ROW;
  const rowCount = Math.min(
    Math.ceil(Math.min(numSlots, MAX_INDIVIDUAL_SLOTS) / BARS_PER_ROW),
    Math.ceil(MAX_INDIVIDUAL_SLOTS / BARS_PER_ROW),
  );

  const slots = useAggregate
    ? null
    : buildSlotBarData(slotCtx, numSlots, ctxPerSlot, ctxTotal);

  const aggregate = useAggregate ? aggregateSlotBarData(slotCtx, ctxPerSlot, ctxTotal) : null;

  const bankTitle =
    slots != null
      ? `${numSlots} slots · ${formatTokenCount(ctxPerSlot > 0 ? ctxPerSlot : ctxTotal)} per slot`
        + (slots.filter((s) => s.pct > 0 || s.isProcessing).length > 0
          ? ` · ${slots.filter((s) => s.pct > 0 || s.isProcessing).length} active`
          : "")
      : undefined;

  const compactTitle = aggregate
    ? `${numSlots} slots · ${formatTokenCount(aggregate.peakCapacity)} per slot`
      + (aggregate.inUse > 0 ? ` · ${aggregate.inUse} in use` : "")
      + (aggregate.maxPct > 0 ? ` · peak fill ${Math.round(aggregate.maxPct)}%` : "")
    : undefined;

  const renderIndividualBars = () => {
    if (!slots) return null;

    // Classic single-row 1–8 (pixel-identical structure)
    if (!dense) {
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
    }

    // 9–32: same bars, multi-row bank (8 per row) — heroes stay full glory on the right
    const rows = chunkSlots(slots, BARS_PER_ROW);

    return (
      <div
        className="flex flex-col flex-1 min-h-0 h-full gap-0.5 min-w-0"
        title={bankTitle}
        data-slot-bank-rows={rowCount}
      >
        {rows.map((row, rowIdx) => (
          <div
            key={rowIdx}
            className="flex flex-1 min-h-0 gap-px items-stretch min-w-0"
            style={{ flex: "1 1 0%" }}
          >
            {row.map((slot) => (
              <div
                key={slot.index}
                className="flex flex-col min-w-0 h-full gap-px"
                style={equalBarStyle}
                title={
                  pctTitle(slot.pct, slot.capacity, `S${slot.index + 1}`)
                  ?? `S${slot.index + 1} · ${formatTokenCount(slot.capacity)} budget`
                }
              >
                <BarTrack
                  pct={slot.pct}
                  isProcessing={slot.isProcessing}
                  isActive={slot.isProcessing}
                  dense
                  fillTitle={pctTitle(slot.pct, slot.capacity, `S${slot.index + 1}`)}
                />
                <span
                  className={`ctx-bar-slot-label text-center font-mono leading-none rounded-sm flex-shrink-0 ${
                    slot.isProcessing ? "ctx-bar-slot-label--live" : ""
                  }`}
                  style={{ fontSize: numSlots > 16 ? 5 : 6, padding: "1px 0" }}
                >
                  {slot.index + 1}
                </span>
              </div>
            ))}
            {/* Pad incomplete last row so bar widths match full rows */}
            {row.length < BARS_PER_ROW &&
              Array.from({ length: BARS_PER_ROW - row.length }, (_, pad) => (
                <div key={`pad-${pad}`} className="min-w-0" style={equalBarStyle} aria-hidden />
              ))}
          </div>
        ))}
      </div>
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
        {useAggregate ? renderCompactBars() : renderIndividualBars()}
      </div>
    </div>
  );
}
