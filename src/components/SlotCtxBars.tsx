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
  speculative: boolean;
  pct: number;
  capacity: number;
  sessionDecoded: number;
  promptTokens: number;
  promptProcessed: number;
  nRemain: number | null;
}

/**
 * Classic fusion dashboard: up to 8 equal vertical bars in one row.
 * 9–32 keep the same bar language as a multi-row bank (8 per row).
 * Above 32 → single aggregate peak bar (extreme / future).
 */
const BARS_PER_ROW = 8;
const MAX_INDIVIDUAL_SLOTS = 32;

const equalBarStyle = { flex: "1 1 0%" } as const;

export function formatTokenCount(n: number): string {
  // Binary K/M (÷1024) — matches the app's own `750k` → 750×1024 = 768,000 token
  // convention (see parse_ctx_token_str). A 768,000-token ctx displays as "750K".
  if (n >= 1024 * 1024) {
    const v = n / (1024 * 1024);
    return Number.isInteger(v) ? `${v}M` : `${v.toFixed(1)}M`;
  }
  if (n >= 1024) {
    const v = n / 1024;
    return Number.isInteger(v) ? `${v}K` : `${v.toFixed(1)}K`;
  }
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
    const { pct, tokenBase } = slotUsage(slot, capacity);
    return {
      index: i,
      isProcessing: slot?.is_processing ?? false,
      speculative: slot?.speculative ?? false,
      pct,
      capacity,
      sessionDecoded: tokenBase,
      promptTokens: slot?.promptTokens ?? 0,
      promptProcessed: slot?.promptTokensProcessed ?? 0,
      nRemain: slot?.nRemain != null && slot.nRemain >= 0 ? slot.nRemain : null,
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
  let anySpec = false;
  let inUse = 0;
  let peakCapacity = ctxPerSlot > 0 ? ctxPerSlot : ctxTotal;
  let totalDecoded = 0;
  for (const slot of slotCtx) {
    const capacity = slotCapacity(slot, ctxPerSlot, ctxTotal);
    peakCapacity = Math.max(peakCapacity, capacity);
    const { pct, tokenBase } = slotUsage(slot, capacity);
    totalDecoded += tokenBase;
    if (pct > 0 || slot.is_processing) inUse += 1;
    maxPct = Math.max(maxPct, pct);
    anyProcessing = anyProcessing || slot.is_processing;
    anySpec = anySpec || Boolean(slot.speculative);
  }
  return { maxPct, anyProcessing, anySpec, inUse, peakCapacity, totalDecoded };
}

function slotTooltip(slot: SlotBarData): string {
  const parts = [
    `S${slot.index + 1}`,
    `${Math.round(slot.pct)}% of ${formatTokenCount(slot.capacity)}`,
  ];
  if (slot.sessionDecoded > 0) parts.push(`${slot.sessionDecoded.toLocaleString()} gen tok`);
  if (slot.promptTokens > 0) {
    parts.push(
      slot.promptProcessed > 0 && slot.promptProcessed < slot.promptTokens
        ? `pp ${slot.promptProcessed.toLocaleString()}/${slot.promptTokens.toLocaleString()}`
        : `pp ${slot.promptTokens.toLocaleString()}`,
    );
  }
  if (slot.nRemain != null) parts.push(`remain ${slot.nRemain.toLocaleString()}`);
  if (slot.speculative) parts.push("spec");
  if (slot.isProcessing) parts.push("live");
  return parts.join(" · ");
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
  speculative,
  emptyLabel,
  fillTitle,
  dense,
}: {
  pct: number;
  isProcessing: boolean;
  isActive: boolean;
  speculative?: boolean;
  emptyLabel?: ReactNode;
  fillTitle?: string;
  dense?: boolean;
}) {
  return (
    <div
      className={`ctx-bar-track flex-1 min-h-0 w-full overflow-hidden relative ${
        isActive ? "ctx-bar-track--active" : "ctx-bar-track--empty"
      }${speculative ? " ctx-bar-track--spec" : ""}${isProcessing ? " ctx-bar-track--live" : ""}`}
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
          className={`ctx-bar-fill absolute bottom-0 left-0 right-0 z-[1] ${
            isProcessing ? "ctx-bar-fill--processing" : "ctx-bar-fill--idle"
          }${speculative ? " ctx-bar-fill--spec" : ""}`}
          style={{
            height: `${pct}%`,
            transition: "height 0.3s ease",
          }}
        />
      )}
      {speculative && <span className="ctx-bar-spec-tick" aria-hidden />}
    </div>
  );
}

function SlotCtxBars({ slotCtx, ctxTotal, ctxPerSlot, parallel }: SlotCtxBarsProps) {
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

  const activeCount = slots
    ? slots.filter((s) => s.pct > 0 || s.isProcessing).length
    : aggregate?.inUse ?? 0;
  const perSlotBudget = ctxPerSlot > 0 ? ctxPerSlot : ctxTotal;
  const bankLive = slots?.some((s) => s.isProcessing) || aggregate?.anyProcessing;

  const bankTitle =
    slots != null
      ? `${numSlots} slots · ${formatTokenCount(perSlotBudget)} per slot`
        + (activeCount > 0 ? ` · ${activeCount} active` : "")
      : undefined;

  const compactTitle = aggregate
    ? `${numSlots} slots · ${formatTokenCount(aggregate.peakCapacity)} per slot`
      + (aggregate.inUse > 0 ? ` · ${aggregate.inUse} in use` : "")
      + (aggregate.maxPct > 0 ? ` · peak fill ${Math.round(aggregate.maxPct)}%` : "")
    : undefined;

  const renderIndividualBars = () => {
    if (!slots) return null;

    if (!dense) {
      return (
        <>
          <div className="relative flex gap-0.5 flex-1 min-h-[28px] h-full items-stretch min-w-0">
            {slots.map((slot) => (
              <div key={slot.index} className="flex flex-col min-w-0 h-full" style={equalBarStyle}>
                <BarTrack
                  pct={slot.pct}
                  isProcessing={slot.isProcessing}
                  isActive={slot.isProcessing || slot.pct > 0}
                  speculative={slot.speculative}
                  emptyLabel={
                    <span className="ctx-bar-capacity-chip fusion-slot-cap-chip">
                      {formatTokenCount(slot.capacity)}
                    </span>
                  }
                  fillTitle={slotTooltip(slot)}
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
                <span
                  className={`ctx-bar-slot-label text-[7px] font-mono px-1 py-0.5 rounded-sm leading-none${
                    slot.isProcessing ? " ctx-bar-slot-label--live" : ""
                  }${slot.speculative ? " ctx-bar-slot-label--spec" : ""}`}
                  title={slotTooltip(slot)}
                >
                  S{slot.index + 1}
                </span>
              </div>
            ))}
          </div>
        </>
      );
    }

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
                title={slotTooltip(slot)}
              >
                <BarTrack
                  pct={slot.pct}
                  isProcessing={slot.isProcessing}
                  isActive={slot.isProcessing || slot.pct > 0}
                  speculative={slot.speculative}
                  dense
                  fillTitle={slotTooltip(slot)}
                />
                <span
                  className={`ctx-bar-slot-label text-center font-mono leading-none rounded-sm flex-shrink-0 ${
                    slot.isProcessing ? "ctx-bar-slot-label--live" : ""
                  }${slot.speculative ? " ctx-bar-slot-label--spec" : ""}`}
                  style={{ fontSize: numSlots > 16 ? 5 : 6, padding: "1px 0" }}
                >
                  {slot.index + 1}
                </span>
              </div>
            ))}
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
              speculative={aggregate.anySpec}
              emptyLabel={
                <span className="ctx-bar-capacity-chip fusion-slot-cap-chip">
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
            {aggregate.inUse > 0 ? ` · ${aggregate.inUse}` : ""}
          </span>
        </div>
      </>
    );
  };

  return (
    <div
      className={`fusion-slot-bank flex w-full h-full min-h-0${bankLive ? " fusion-slot-bank--live" : ""}`}
      title={bankTitle ?? compactTitle}
    >
      <div className="fusion-slot-bank__well flex flex-col flex-1 min-w-0 h-full min-h-0">
        <div className="fusion-slot-bank__chrome flex items-center justify-between gap-1 flex-shrink-0">
          <span className="fusion-slot-bank__title">SLOTS</span>
          <span className="fusion-slot-bank__meta">
            ×{numSlots}
            {perSlotBudget > 0 ? ` · ${formatTokenCount(perSlotBudget)}` : ""}
            {activeCount > 0 ? ` · ${activeCount}↑` : ""}
          </span>
        </div>
        <div className="fusion-slot-bank__body flex flex-col flex-1 min-h-0 min-w-0">
          {useAggregate ? renderCompactBars() : renderIndividualBars()}
        </div>
      </div>
    </div>
  );
}

export { SlotCtxBars };
export default SlotCtxBars;
