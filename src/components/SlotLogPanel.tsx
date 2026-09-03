import { useEffect, useRef, useState, memo } from "react";
import type { StackEntry, LogEntry } from "../lib/types";
import AnsiText from "./AnsiText";
import BenchWidget from "./BenchWidget";
import { useFusionSlot } from "../hooks/useFusionData";
import { getBenchPortState, subscribeBenchPortStore } from "../lib/benchPortStore";

interface SlotLogPanelProps {
  entry: StackEntry;
  logs: LogEntry[];
  systemEvents: Array<{ text: string; timestamp: string }>;
  n_ctx?: number;
  onStop: (slotIdx: number) => void;
}

function StatBlock({ label, value, highlight }: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="type-label font-mono slot-log-stat-label tracking-wider">{label}</p>
      <p className={`text-xs font-mono mt-0.5 ${highlight ? "slot-log-stat-value--accent" : "slot-log-stat-value"}`}>
        {value}
      </p>
    </div>
  );
}
// Memoized SlotLogPanel — only re-renders when entry, logs, or onStop change

function benchStackSummary(port: number): string | null {
  const ps = getBenchPortState(port);
  if (ps.tgRunning || ps.ppRunning) return "running…";
  if (ps.tgResult?.success && ps.tgResult.gen_tps > 0) {
    return `TG ${ps.tgResult.gen_tps.toFixed(0)} tok/s`;
  }
  if (ps.ppResult?.success && ps.ppResult.bench_prefill_tps > 0) {
    return `PP ${ps.ppResult.bench_prefill_tps.toFixed(0)} tok/s`;
  }
  return null;
}

export default memo(function SlotLogPanel({ entry, logs, systemEvents, n_ctx = 32768, onStop }: SlotLogPanelProps) {
  const fusionUpdate = useFusionSlot(entry.idx);
  const logRef = useRef<HTMLDivElement>(null);
  const [benchExpanded, setBenchExpanded] = useState(false);
  const [, setBenchTick] = useState(0);

  useEffect(() => subscribeBenchPortStore(() => setBenchTick((t) => t + 1)), []);

  const benchPs = getBenchPortState(entry.port);
  const benchBusy = benchPs.tgRunning || benchPs.ppRunning;
  const benchHasResults = benchPs.showResults && Boolean(benchPs.tgResult || benchPs.ppResult);

  useEffect(() => {
    if (benchBusy || benchHasResults) setBenchExpanded(true);
  }, [benchBusy, benchHasResults]);
  // Tail-follow stderr batch stream (same buffer as LOG tab — 90px viewport needs explicit scroll).
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [logs.length, systemEvents.length]);

  // Phase: fusion /slots is authoritative for BUSY/READY, logs provide PROMPT_PROCESSING detail.
  // Prioritize explicit "PP" phase so prefill is not overridden to GENERATING by ACTIVE state.
  const displayPhase = fusionUpdate?.phase === "PP" ? "PP"
    : fusionUpdate?.phase === "TG" ? "GENERATING"
    : fusionUpdate?.engine_state === "READY" ? "IDLE" : (fusionUpdate?.phase ?? "IDLE");

  // Phase-specific styling
  const phaseColor = displayPhase === "PP"
    ? "slot-log-phase--pp"
    : displayPhase === "GENERATING"
      ? "slot-log-phase--tg"
      : "slot-log-phase";

  const phaseBg = displayPhase === "PP"
    ? "engine-stack-phase-pp"
    : displayPhase === "GENERATING"
      ? "engine-stack-phase-tg"
      : "engine-stack-phase-idle";

  // TPS value for display — fusion /slots data is the source of truth
  const tps = (fusionUpdate?.engine_state === "ACTIVE" && fusionUpdate?.genTps > 0) ? fusionUpdate.genTps : 0;

  const phaseBarVisible = entry.status === "RUNNING" && displayPhase !== "IDLE";

  // Logs are already flat — cap visible lines to prevent DOM bloat
  const MAX_VISIBLE_LOGS = 100;
  const visibleLogs = logs.slice(-MAX_VISIBLE_LOGS);

    return (
      <div className="engine-stack-body" style={{ animation: 'fadeIn 0.3s ease' }}>
      {/* Card header with model name + stop */}
      <div className="engine-stack-header flex items-center justify-between px-3 py-2 border-b slot-log-header-rule">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {entry.model_name && entry.model_name !== "none" && (
            <span className="type-body font-mono slot-log-model truncate min-w-0" title={entry.model_name}>
              {entry.model_name}
            </span>
          )}
        </div>
        <button
          onClick={() => onStop(entry.idx)}
          disabled={entry.status === "IDLE" || entry.status === "ERROR"}
          className="type-body font-mono slot-log-stop transition-colors disabled:opacity-20 disabled:cursor-not-allowed px-2 py-0.5 border"
        >
          STOP
        </button>
      </div>

      {/* Phase indicator bar — fixed-height slot so layout never jumps */}
      {entry.status === "RUNNING" && (
        <div className="relative h-7 flex-shrink-0">
          <div
            className={`absolute inset-0 px-3 flex items-center justify-between border-b transition-opacity duration-200 ${
              phaseBarVisible ? `${phaseBg} opacity-100` : "opacity-0 pointer-events-none border-transparent"
            }`}
          >
            <span className="type-label font-mono tracking-wider">
              {displayPhase === "PP" && "\u{25C7}"}
              {displayPhase === "GENERATING" && "\u{25CF}"}
              {" "}
              {displayPhase === "PP" ? "PROMPT PROCESSING" : displayPhase === "GENERATING" ? "TOKEN GENERATION" : "\u00A0"}
            </span>
            {fusionUpdate?.prefillMs != null && fusionUpdate.prefillMs > 0 ? (
              <span className="type-label font-mono slot-log-phase--pp">
                PP: {fusionUpdate.prefillMs.toFixed(0)}ms
                {fusionUpdate.decodeTtftMs != null
                  ? ` · +1st: ${fusionUpdate.decodeTtftMs < 1 ? "<1" : fusionUpdate.decodeTtftMs.toFixed(0)}ms`
                  : ""}
              </span>
            ) : (
              <span className="type-label font-mono opacity-0 select-none" aria-hidden="true">{"\u00A0"}</span>
            )}
          </div>
        </div>
      )}

      {/* Engine stats */}
      <div className="px-3 py-2 grid grid-cols-3 gap-2">
        <StatBlock label="PORT" value={`:${entry.port}`} />
        <StatBlock label="STATUS" value={entry.status} highlight={entry.status === "RUNNING"} />

        {/* TPS — fusion /slots source of truth */}
        <div className="flex flex-col items-center justify-center">
          <span className="type-label font-mono slot-log-stat-label tracking-wider">TPS</span>
          {tps > 0 ? (
            <span className={`text-lg font-mono font-bold ${phaseColor}`}>
              {tps.toFixed(1)}
            </span>
          ) : (
            <span className="text-lg font-mono slot-log-phase">--</span>
          )}
        </div>
      </div>

      {/* Benchmark — same per-port store as Fusion overlay; stack UI is controls + results only */}
      {entry.status === "RUNNING" && (
        <div className="engine-stack-bench border-t slot-log-header-rule">
          <button
            type="button"
            className="engine-stack-bench-toggle w-full flex items-center justify-between gap-2 px-3 py-1.5 text-left"
            onClick={() => setBenchExpanded((open) => !open)}
            aria-expanded={benchExpanded}
            aria-controls={`engine-stack-bench-${entry.idx}`}
          >
            <span className="type-tiny font-mono slot-log-caption tracking-wider uppercase">
              Benchmark
            </span>
            <span className="flex items-center gap-2 min-w-0">
              {!benchExpanded && (
                <span className="type-tiny font-mono slot-log-bench-summary truncate">
                  {benchStackSummary(entry.port) ?? ""}
                </span>
              )}
              <span className="type-xl leading-none font-mono slot-log-caret flex-shrink-0" aria-hidden>
                {benchExpanded ? "▾" : "▸"}
              </span>
            </span>
          </button>
          {benchExpanded && (
            <div id={`engine-stack-bench-${entry.idx}`} className="px-3 pb-2 min-w-0">
              <BenchWidget key={`bench-${entry.idx}-${entry.port}`} port={entry.port} stackMode />
            </div>
          )}
        </div>
      )}

      {/* Live log stream from LogHub (stderr only, batched ~25ms) */}
      <div ref={logRef} className="engine-stack-log px-3 py-2 border-t slot-log-header-rule h-[90px] overflow-y-auto overflow-x-hidden eink-scrollbar">
        {visibleLogs.length === 0 && systemEvents.length === 0 ? (
          <p className="type-body font-mono slot-log-empty italic">
            {entry.status === "LOADING" 
              ? "WAITING FOR READY..." 
              : entry.status === "RUNNING" && displayPhase === "IDLE"
                ? "AWAITING INFERENCE..."
                : "NO LOGS"}
          </p>
        ) : (
          <>
            {systemEvents.map((evt, i) => (
                <p key={`sys-${i}`} className="type-body font-mono leading-relaxed slot-log-sys">
                {evt.text}
              </p>
            ))}
            {visibleLogs.map((log, i) => {
              const isPhase = log.text.includes("PHASE") || log.text.includes("READY") || log.text.includes("LAUNCHED");
              return (
                <p key={i} className={`type-body font-mono leading-relaxed ${
                    isPhase 
                        ? phaseColor === "slot-log-phase--tg" ? "slot-log-line--tg" : "slot-log-line--pp"
                        : "slot-log-line"
                }`}>
                  <AnsiText text={log.text} />
                </p>
              );
            })}
          </>
        )}
      </div>

      {/* Ready timestamp */}
      {entry.status === "RUNNING" && (
        <div className="px-3 py-1 border-t slot-log-header-rule flex items-center justify-between engine-stack-footer">
          <span className="type-label font-mono slot-log-stat-label">SLOT {entry.idx + 1}</span>
          <span className="type-label font-mono slot-log-stat-label">{entry.ready_at || "RUNNING"}</span>
        </div>
      )}
    </div>
  );
});
