import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef, memo } from "react";
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
  const cardRef = useRef<HTMLDivElement>(null);

  // Auto-scroll only on mount or when system events change (not every log line)
  useEffect(() => {
    if (logRef.current && systemEvents.length > 0) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [systemEvents]);

  const statusColor = {
    RUNNING: "status-online",
    LOADING: "status-loading",
    ERROR: "status-error",
    IDLE: "status-offline",
  }[entry.status] || "status-offline";

  const borderClass = {
    RUNNING: "glow-border",
    LOADING: "glow-border-warning",
    ERROR: "glow-border-error",
    IDLE: "",
  }[entry.status] || "";

  // Phase: fusion /slots is authoritative for BUSY/READY, logs provide PROMPT_PROCESSING detail
  const displayPhase = fusionUpdate?.engine_state === "ACTIVE" ? "GENERATING"
    : fusionUpdate?.engine_state === "READY" ? "IDLE" : (fusionUpdate?.phase ?? "IDLE");

  // Phase-specific styling
  const phaseColor = displayPhase === "PP"
    ? "text-telemetry-amber"
    : displayPhase === "GENERATING"
      ? "text-nv-green"
      : "text-stealth-muted";

  const phaseBg = displayPhase === "PP"
    ? "bg-telemetry-amber/10 border-telemetry-amber/30"
    : displayPhase === "GENERATING"
      ? "bg-nv-green/10 border-nv-green/30"
      : "bg-stealth-panel border-stealth-border";

  // TPS value for display — fusion /slots data is the source of truth
  const tps = (fusionUpdate?.engine_state === "ACTIVE" && fusionUpdate?.genTpsSlots > 0) ? fusionUpdate.genTpsSlots : 0;

  // Logs are already flat — cap visible lines to prevent DOM bloat
  const MAX_VISIBLE_LOGS = 100;
  const visibleLogs = logs.slice(-MAX_VISIBLE_LOGS);

    return (
      <motion.div
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          exit={{ opacity: 0, scale: 0.95 }}
          transition={{ duration: 0.3 }}
           className={`eink-panel ${borderClass} rounded-sm overflow-hidden`}
        >
      {/* Card header with phase indicator */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-stealth-border bg-stealth-dark/50">
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

      {/* Phase indicator bar */}
      <AnimatePresence mode="wait">
        {entry.status === "RUNNING" && displayPhase !== "IDLE" && (
          <motion.div
            key={displayPhase}
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2 }}
          >
            <div className={`px-3 py-1 border-b ${phaseBg} flex items-center justify-between`}>
              <span className="text-[9px] font-mono tracking-wider">
                {displayPhase === "PP" && "\u{25C7}"}
                {displayPhase === "GENERATING" && "\u{25CF}"}
                {" "}
                {displayPhase === "PP" ? "PROMPT PROCESSING" : "TOKEN GENERATION"}
              </span>
              <div className="flex items-center gap-3">
                {/* LP_ prefill progress comparison (red) — from print_timing PP line */}
                {fusionUpdate?.LP_prefillProgress != null && fusionUpdate.LP_prefillProgress > 0 && displayPhase === "PP" && (
                  <>
                    <div className="w-16 h-1.5 bg-stealth-dark border border-red-500/30 rounded-sm overflow-hidden">
                      <div
                        className="h-full bg-red-400 transition-all duration-100"
                        style={{ width: `${fusionUpdate.LP_prefillProgress * 100}%` }}
                      />
                    </div>
                    <span className="text-[8px] font-mono text-red-400">
                      LP {(fusionUpdate.LP_prefillProgress * 100).toFixed(0)}%
                    </span>
                  </>
                )}

                {/* LP_ phase indicator */}
                {fusionUpdate?.LP_phase && fusionUpdate.LP_phase !== "IDLE" && (
                  <span className="text-[8px] font-mono text-red-400/70">
                    LP:{fusionUpdate.LP_phase}
                  </span>
                )}

                {fusionUpdate?.ttftMs != null && fusionUpdate.ttftMs > 0 && (
                  <span className="text-[9px] font-mono text-telemetry-amber">
                    TTFT: {fusionUpdate.ttftMs.toFixed(0)}ms
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Engine stats */}
      <div className="px-3 py-2 grid grid-cols-4 gap-2">
        <StatBlock label="PORT" value={`:${entry.port}`} />
        <StatBlock label="STATUS" value={entry.status} highlight={entry.status === "RUNNING"} />

        {/* TPS display */}
        <div className="col-span-1 flex flex-col items-center justify-center">
          <span className="text-[9px] font-mono text-stealth-muted tracking-wider">TPS</span>
          {tps > 0 ? (
            <span className={`text-lg font-mono font-bold ${phaseColor}`}>
              {tps.toFixed(1)}
            </span>
          ) : (
            <span className="text-lg font-mono text-stealth-muted">--</span>
          )}
          {/* LP_ TPS comparison (red) */}
          {(fusionUpdate?.LP_prefillTps != null && fusionUpdate.LP_prefillTps > 0 && displayPhase === "PP") && (
            <span className="text-[10px] font-mono text-red-400 font-bold">
              LP {fusionUpdate.LP_prefillTps.toFixed(0)}
            </span>
          )}
          {(fusionUpdate?.LP_genTps != null && fusionUpdate.LP_genTps > 0) && (
            <span className="text-[10px] font-mono text-red-400 font-bold">
              LP {fusionUpdate.LP_genTps.toFixed(0)}
            </span>
          )}
        </div>

        {/* Tokens generated — fusion /slots is real-time source of truth */}
        <StatBlock label="TOKENS" value={(fusionUpdate?.genTokensPerRequestSlots ?? fusionUpdate?.genTokensPerSession ?? 0).toString()} />
      </div>

      {/* Benchmark controls — full width */}
      {entry.status === "RUNNING" && (
        <div className="px-3 py-1">
          <BenchWidget port={entry.port} />
        </div>
      )}

      {/* Secondary stats row */}
      {entry.status === "RUNNING" && fusionUpdate && (
        <div className="px-3 py-1 border-t border-stealth-border grid grid-cols-2 gap-2">
          <span className="text-[9px] font-mono text-stealth-muted">
            GEN: {fusionUpdate.genTokensPerRequestSlots ?? 0} tok
          </span>
          <span className="text-[9px] font-mono text-stealth-muted">
            SESSION: {fusionUpdate.genTokensPerSession ?? 0} tok
          </span>
        </div>
      )}

      {/* LP_ log-parsed metrics row (red) */}
      {entry.status === "RUNNING" && fusionUpdate && (fusionUpdate.LP_promptTokens != null || fusionUpdate.LP_prefillTps != null) && (
        <div className="px-3 py-1 border-t border-stealth-border/50 grid grid-cols-2 gap-2">
          {fusionUpdate.LP_promptTokens != null && fusionUpdate.LP_promptTokens > 0 && (
            <span className="text-[9px] font-mono text-red-400">
              LP PROMPT: {fusionUpdate.LP_promptTokens} tok
            </span>
          )}
          {fusionUpdate.LP_prefillTps != null && fusionUpdate.LP_prefillTps > 0 && (
            <span className="text-[9px] font-mono text-red-400">
              LP PP: {fusionUpdate.LP_prefillTps.toFixed(0)} t/s
            </span>
          )}
        </div>
      )}

      {/* LP_ reset source indicator — belt (green) vs suspenders (amber) */}
      {entry.status === "RUNNING" && fusionUpdate?.LP_resetSource && (
        <div className="px-3 py-0.5 border-t border-stealth-border/30">
          <span className={`text-[8px] font-mono tracking-wider ${
            fusionUpdate.LP_resetSource === 'prompt' ? 'text-nv-green/70' : 'text-telemetry-amber/70'
          }`}>
            LP RESET: {fusionUpdate.LP_resetSource === 'prompt' ? "BELT (NewPrompt)" : "SUSPENDERS (regression)"}
          </span>
        </div>
      )}

      {/* Live log stream from LogHub (stdout streaming, batched at 100ms) */}
      <div ref={logRef} className="px-3 py-2 border-t border-stealth-border bg-black/40 h-[90px] overflow-y-auto overflow-x-hidden">
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
        <div className="px-3 py-1 border-t border-stealth-border flex items-center justify-between">
          <span className="text-[9px] font-mono text-nv-green/60">SLOT {entry.idx + 1}</span>
          <span className="text-[9px] font-mono text-nv-green/80">{entry.ready_at || "RUNNING"}</span>
        </div>
      )}
    </motion.div>
  );
});
