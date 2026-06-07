import { useEffect, useRef, memo } from "react";
import type { StackEntry, LogEntry, FusionUpdate } from "../lib/types";
import AnsiText from "./AnsiText";
import BenchWidget from "./BenchWidget";

interface SlotLogPanelProps {
  entry: StackEntry;
  logs: LogEntry[];
  systemEvents: Array<{ text: string; timestamp: string }>;
  fusionUpdate?: FusionUpdate | null;
  n_ctx?: number;
  onStop: (alias: string) => void;
}

function StatBlock({ label, value, highlight }: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-[9px] font-mono text-stealth-muted tracking-wider">{label}</p>
      <p className={`text-xs font-mono mt-0.5 ${highlight ? "text-nv-green" : "text-white/80"}`}>
        {value}
      </p>
    </div>
  );
}
// Memoized SlotLogPanel — only re-renders when entry, logs, or onStop change

export default memo(function SlotLogPanel({ entry, logs, systemEvents, fusionUpdate, n_ctx = 32768, onStop }: SlotLogPanelProps) {
  const logRef = useRef<HTMLDivElement>(null);
  // Auto-scroll only on mount or when system events change (not every log line)
  useEffect(() => {
    if (logRef.current && systemEvents.length > 0) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [systemEvents]);

  // Phase: fusion /slots is authoritative for BUSY/READY, logs provide PROMPT_PROCESSING detail.
  // Prioritize explicit "PP" phase so prefill is not overridden to GENERATING by ACTIVE state.
  const displayPhase = fusionUpdate?.phase === "PP" ? "PP"
    : fusionUpdate?.phase === "TG" ? "GENERATING"
    : fusionUpdate?.engine_state === "READY" ? "IDLE" : (fusionUpdate?.phase ?? "IDLE");

  // Phase-specific styling
  const phaseColor = displayPhase === "PP"
    ? "text-telemetry-amber"
    : displayPhase === "GENERATING"
      ? "text-nv-green"
      : "text-stealth-muted";

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
      <div className="engine-stack-header flex items-center justify-between px-3 py-2 border-b border-stealth-border/30">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          {entry.model_name && entry.model_name !== "none" && (
            <span className="text-[10px] font-mono text-nv-green/60 truncate min-w-0" title={entry.model_name}>
              {entry.model_name}
            </span>
          )}
        </div>
        <button
          onClick={() => onStop(entry.alias)}
          disabled={entry.status === "IDLE" || entry.status === "ERROR"}
          className="text-[10px] font-mono text-red-400/70 hover:text-red-400 transition-colors disabled:opacity-20 disabled:cursor-not-allowed px-2 py-0.5 border border-transparent hover:border-red-500/30"
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
            <span className="text-[9px] font-mono tracking-wider">
              {displayPhase === "PP" && "\u{25C7}"}
              {displayPhase === "GENERATING" && "\u{25CF}"}
              {" "}
              {displayPhase === "PP" ? "PROMPT PROCESSING" : displayPhase === "GENERATING" ? "TOKEN GENERATION" : "\u00A0"}
            </span>
            {fusionUpdate?.ttftMs != null && fusionUpdate.ttftMs > 0 ? (
              <span className="text-[9px] font-mono text-telemetry-amber">
                TTFT: {fusionUpdate.ttftMs.toFixed(0)}ms
              </span>
            ) : (
              <span className="text-[9px] font-mono opacity-0 select-none" aria-hidden="true">{"\u00A0"}</span>
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
          <span className="text-[9px] font-mono text-stealth-muted tracking-wider">TPS</span>
          {tps > 0 ? (
            <span className={`text-lg font-mono font-bold ${phaseColor}`}>
              {tps.toFixed(1)}
            </span>
          ) : (
            <span className="text-lg font-mono text-stealth-muted">--</span>
          )}
        </div>
      </div>

      {/* Benchmark controls — full width */}
      {entry.status === "RUNNING" && (
        <div className="px-3 py-1">
          <BenchWidget port={entry.port} />
        </div>
      )}

      {/* Live log stream from LogHub (stdout streaming, batched at 100ms) */}
      <div ref={logRef} className="engine-stack-log px-3 py-2 border-t border-stealth-border/30 h-[90px] overflow-y-auto overflow-x-hidden eink-scrollbar">
        {visibleLogs.length === 0 && systemEvents.length === 0 ? (
          <p className="text-[10px] font-mono text-stealth-muted/50 italic">
            {entry.status === "LOADING" 
              ? "WAITING FOR READY..." 
              : entry.status === "RUNNING" && displayPhase === "IDLE"
                ? "AWAITING INFERENCE..."
                : "NO LOGS"}
          </p>
        ) : (
          <>
            {systemEvents.map((evt, i) => (
                <p key={`sys-${i}`} className="text-[10px] font-mono leading-relaxed text-yellow-400/70">
                {evt.text}
              </p>
            ))}
            {visibleLogs.map((log, i) => {
              const isPhase = log.text.includes("PHASE") || log.text.includes("READY") || log.text.includes("LAUNCHED");
              return (
                <p key={i} className={`text-[10px] font-mono leading-relaxed ${
                    isPhase 
                        ? phaseColor === "text-nv-green" ? "text-nv-green/80" : "text-telemetry-amber/80"
                        : "text-stealth-muted"
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
        <div className="px-3 py-1 border-t border-stealth-border/30 flex items-center justify-between engine-stack-footer">
          <span className="text-[9px] font-mono text-stealth-muted">SLOT {entry.idx + 1}</span>
          <span className="text-[9px] font-mono">{entry.ready_at || "RUNNING"}</span>
        </div>
      )}
    </div>
  );
});
