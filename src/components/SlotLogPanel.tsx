import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef, memo } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { StackEntry, LogEntry, EnginePerfEvent, FusionUpdate, BenchResult } from "../lib/types";
import EnginePerformanceTile from "./EnginePerformanceTile";
import AnsiText from "./AnsiText";

interface SlotLogPanelProps {
  entry: StackEntry;
  logs: LogEntry[];
  systemEvents: Array<{ text: string; timestamp: string }>;
  enginePerfEvent?: EnginePerfEvent;
  fusionUpdate?: FusionUpdate | null;
  n_ctx?: number;
  onStop: (alias: string) => void;
}

// Telemetry state for this engine
interface EngineTelemetryData {
  phase: string;
  ttft_ms?: number | null;
  instantaneous_tps: number;
  avg_tps_5: number;
  total_tokens_generated: number;
  prompt_tokens_evaluated: number;
  prompt_progress: number; // 0.0-1.0 scale during prompt processing
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

export default memo(function SlotLogPanel({ entry, logs, systemEvents, enginePerfEvent, fusionUpdate, n_ctx = 32768, onStop }: SlotLogPanelProps) {
  const [telemetry, setTelemetry] = useState<EngineTelemetryData>({
    phase: "IDLE",
    instantaneous_tps: 0,
    avg_tps_5: 0,
    total_tokens_generated: 0,
    prompt_tokens_evaluated: 0,
    prompt_progress: 0,
  });
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  // Benchmark state
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResult, setBenchResult] = useState<BenchResult | null>(null);
  const [benchExpanded, setBenchExpanded] = useState(false);
  const benchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (benchResult && !benchRunning) {
      // Keep benchmark results visible until user manually closes — no auto-close timer
    }
    return () => { if (benchTimerRef.current) clearTimeout(benchTimerRef.current); };
  }, [benchResult, benchRunning]);

  const runBench = async () => {
    if (benchRunning || entry.status !== "RUNNING") return;
    setBenchRunning(true);
    setBenchResult(null);
    setBenchExpanded(true);
    try {
      const res: BenchResult = await invoke("cmd_burst_bench", { port: entry.port, nPredict: 256 });
      setBenchResult(res);
    } catch (e) {
      const errMsg = typeof e === "string" ? e : String(e);
      setBenchResult({
        prompt_tokens: 0, gen_tokens: 0,
        prompt_tps_min: 0, prompt_tps_avg: 0, prompt_tps_max: 0,
        gen_tps_min: 0, gen_tps_avg: 0, gen_tps_max: 0,
        itl_ms_avg: 0, runs_count: 0, success: false, error: errMsg,
      });
    } finally {
      setBenchRunning(false);
    }
  };

  // Listen for engine-specific telemetry events from Rust backend
  useEffect(() => {
    let unsub: (() => void) | null = null;
    
    listen("engine-perf", (e: any) => {
      try {
        const data = e.payload as EnginePerfEvent;
        if (data.slot === entry.idx && data.tps !== undefined) {
          setTelemetry((prevTel) => {
            let newPhase = prevTel.phase;

            // Phase detection based on TPS activity and progress tracking
            if (entry.status === "RUNNING") {
              if (data.prompt_progress !== null && data.prompt_progress !== undefined && data.prompt_progress > 0 && data.prompt_progress < 1) {
                newPhase = "PROMPT_PROCESSING";
              } else if (data.tps > 0) {
                newPhase = "GENERATING";
              } else {
                newPhase = prevTel.phase;
              }
            } else {
              newPhase = "IDLE";
            }

            return {
              ...prevTel,
              phase: newPhase,
              ttft_ms: data.ttft_ms ?? prevTel.ttft_ms,
              instantaneous_tps: data.tps || 0,
              avg_tps_5: data.tps > 0 ? (prevTel.avg_tps_5 === 0 ? data.tps : (prevTel.avg_tps_5 + data.tps) / 2) : prevTel.avg_tps_5,
              total_tokens_generated: data.n_tokens ?? prevTel.total_tokens_generated,
              prompt_tokens_evaluated: data.prompt_tokens ?? prevTel.prompt_tokens_evaluated,
              prompt_progress: data.prompt_progress ?? 0,
            };
          });

          // Reset idle timer on any perf event
          if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
          idleTimerRef.current = setTimeout(() => {
            setTelemetry(prev => {
              if (prev.phase !== "IDLE") return { ...prev, phase: "IDLE", prompt_progress: 0 };
              return prev;
            });
            idleTimerRef.current = null;
          }, 2500);
        }
      } catch {}
    }).then((u) => { unsub = u; });

    return () => {
      if (unsub) unsub();
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    };
  }, [entry.idx, entry.status]);

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
  const fusionPhase = fusionUpdate?.engine_state === "ACTIVE" ? "GENERATING"
    : fusionUpdate?.engine_state === "READY" ? "IDLE" : null;
  const displayPhase = fusionPhase ?? telemetry.phase;

  // Phase-specific styling (memoized via useMemo)
  const phaseColor = displayPhase === "PROMPT_PROCESSING"
    ? "text-telemetry-amber"
    : displayPhase === "GENERATING"
      ? "text-nv-green"
      : "text-stealth-muted";

  const phaseBg = displayPhase === "PROMPT_PROCESSING"
    ? "bg-telemetry-amber/10 border-telemetry-amber/30"
    : displayPhase === "GENERATING"
      ? "bg-nv-green/10 border-nv-green/30"
      : "bg-stealth-panel border-stealth-border";

  // TPS value for display — fusion /slots data is real-time, log-based is fallback
  const fusionTps = (fusionUpdate?.engine_state === "ACTIVE" && fusionUpdate?.genTpsSlots > 0) ? fusionUpdate.genTpsSlots : null;
  const tps = fusionTps ?? (telemetry.instantaneous_tps > 0 ? telemetry.instantaneous_tps : telemetry.avg_tps_5);

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
                {displayPhase === "PROMPT_PROCESSING" && "\u{25C7}"}
                {displayPhase === "GENERATING" && "\u{25CF}"}
                {" "}
                {displayPhase === "PROMPT_PROCESSING" ? "PROMPT PROCESSING" : "TOKEN GENERATION"}
              </span>
              <div className="flex items-center gap-3">
                {/* Real-time progress bar during prompt processing */}
                {(telemetry.phase === "PROMPT_PROCESSING" || fusionUpdate?.phase === "PP") && telemetry.prompt_progress > 0 && (
                  <>
                    <div className="w-16 h-1.5 bg-stealth-dark border border-stealth-border rounded-sm overflow-hidden">
                      <div
                        className="h-full bg-telemetry-amber transition-all duration-100"
                        style={{ width: `${telemetry.prompt_progress * 100}%` }}
                      />
                    </div>
                    <span className="text-[8px] font-mono text-telemetry-amber">
                      {(telemetry.prompt_progress * 100).toFixed(0)}%
                    </span>
                  </>
                )}
                {telemetry.ttft_ms !== undefined && telemetry.ttft_ms !== null && (
                  <span className="text-[9px] font-mono text-telemetry-amber">
                    TTFT: {telemetry.ttft_ms.toFixed(0)}ms
                  </span>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Engine stats */}
      <div className="px-3 py-2 grid grid-cols-5 gap-2">
        <StatBlock label="PORT" value={`:${entry.port}`} />
        <StatBlock label="STATUS" value={entry.status} highlight={entry.status === "RUNNING"} />
        
        {/* Benchmark button */}
        {entry.status === "RUNNING" && (
          <div className="col-span-1 flex items-center">
            <button
              onClick={runBench}
              disabled={benchRunning}
              className="px-2 py-0.5 text-[9px] font-mono bg-nv-green/10 text-nv-green border border-nv-green/30 hover:bg-nv-green/20 transition-all duration-200 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              {benchRunning ? "RUNNING..." : "BENCH"}
            </button>
          </div>
        )}

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
        </div>

        {/* Tokens generated — fusion /slots is real-time, log-based is fallback */}
        <StatBlock label="TOKENS" value={(fusionUpdate?.genTokensPerRequestSlots ?? fusionUpdate?.genTokensPerSession ?? telemetry.total_tokens_generated).toString()} />
      </div>

      {/* Benchmark results — inline panel */}
      <AnimatePresence>
        {(benchRunning || benchResult) && benchExpanded && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.15 }}
            className="border-t border-b border-nv-green/30 bg-nv-green/5 overflow-hidden"
          >
            <div className="flex items-center justify-between px-3 py-1">
              <span className="text-[9px] font-mono text-yellow-400 tracking-wider">BENCHMARK</span>
              <button
                onClick={() => { setBenchExpanded(false); if (!benchRunning) setBenchResult(null); }}
                className="text-[8px] font-mono text-stealth-muted hover:text-white transition-colors"
              >
                CLOSE
              </button>
            </div>
            <div className="px-3 pb-2">
              {benchRunning ? (
                <div className="flex items-center gap-2">
                  <span className="inline-block w-1.5 h-1.5 bg-yellow-400 rounded-full animate-pulse" />
                  <span className="text-[9px] font-mono text-stealth-muted">RUNNING (warmup + 3 measured)...</span>
                </div>
              ) : benchResult ? (
                benchResult.success ? (
                  <div className="grid grid-cols-4 gap-x-5 gap-y-2">
                    <div>
                      <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">PREFILL</p>
                      <p className="text-xs font-mono text-telemetry-amber">{benchResult.prompt_tps_avg.toFixed(1)} TPS</p>
                      <p className="text-[8px] font-mono text-stealth-muted/60">min {benchResult.prompt_tps_min.toFixed(1)} / max {benchResult.prompt_tps_max.toFixed(1)}</p>
                    </div>
                    <div>
                      <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">GENERATION</p>
                      <p className="text-xs font-mono text-nv-green">{benchResult.gen_tps_avg.toFixed(1)} TPS</p>
                      <p className="text-[8px] font-mono text-stealth-muted/60">min {benchResult.gen_tps_min.toFixed(1)} / max {benchResult.gen_tps_max.toFixed(1)}</p>
                    </div>
                    <div>
                      <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">ITL</p>
                      <p className="text-xs font-mono text-white">{benchResult.itl_ms_avg.toFixed(2)} ms</p>
                    </div>
                    <div>
                      <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">TOKENS</p>
                      <p className="text-xs font-mono text-white">{benchResult.prompt_tokens}P / {benchResult.gen_tokens}G</p>
                      <p className="text-[8px] font-mono text-stealth-muted/60">{benchResult.runs_count} runs averaged</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-[9px] font-mono text-red-400">FAILED: {benchResult.error || "unknown"}</p>
                )
              ) : null}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Secondary stats row */}
      {entry.status === "RUNNING" && (
        <div className="px-3 py-1 border-t border-stealth-border grid grid-cols-2 gap-2">
          <span className="text-[9px] font-mono text-stealth-muted">
            PROMPT: {telemetry.prompt_tokens_evaluated} tok
          </span>
          <span className="text-[9px] font-mono text-stealth-muted">
            GEN: {fusionUpdate?.genTokensPerRequestSlots ?? telemetry.total_tokens_generated ?? 0} tok
          </span>
        </div>
      )}

      {/* Engine Performance Pulse tile — shows TPS, TTFT, FuelTank for all running engines */}
      {entry.status === "RUNNING" && enginePerfEvent && (
        <EnginePerformanceTile perf={enginePerfEvent} n_ctx={n_ctx} />
      )}

      {/* Live log stream from LogHub (stdout streaming, batched at 100ms) */}
      <div ref={logRef} className="px-3 py-2 border-t border-stealth-border bg-black/40 h-[90px] overflow-y-auto">
        {visibleLogs.length === 0 && systemEvents.length === 0 ? (
          <p className="text-[10px] font-mono text-stealth-muted/50 italic">
            {entry.status === "LOADING" 
              ? "WAITING FOR READY..." 
              : entry.status === "RUNNING" && telemetry.phase === "IDLE"
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
