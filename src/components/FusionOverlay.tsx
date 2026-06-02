import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FusionUpdate } from "../lib/types";
import BenchWidget from "./BenchWidget";

interface FusionOverlayProps {
  alias?: string;
  enginePort?: number;
  fusion: FusionUpdate | null;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatK(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

interface LastRequestStats {
  genTokensSlots: number;
  ttftMs: string | null;
  elapsedMs: string;
}

export default function FusionOverlay({ alias, enginePort, fusion }: FusionOverlayProps) {
  const displayAlias = alias ?? "ENGINE";
  const displayPort = enginePort ?? 9090;

  // Frozen stats shown after request ends — persist until next run starts
  const [frozenStats, setFrozenStats] = useState<LastRequestStats | null>(null);
  const liveSnapshot = useRef<LastRequestStats>({ genTokensSlots: 0, ttftMs: null, elapsedMs: "0ms" });
  const wasActiveRef = useRef(false);

  const handleStopEngine = useCallback(async () => {
    try {
      await invoke("stop_engine", { alias: displayAlias });
    } catch (e) {
      console.error("[FUSION] stop_engine failed:", e);
    }
  }, [displayAlias]);

  const isActive = fusion && fusion.phase !== "IDLE";

  if (fusion && isActive) {
    liveSnapshot.current = {
      genTokensSlots: fusion.genTokensPerRequestSlots,
      ttftMs: fusion.ttftMs != null ? formatMs(fusion.ttftMs) : null,
      elapsedMs: formatMs(fusion.requestElapsedMs),
    };
  }

  useEffect(() => {
    if (!fusion) return;

    if (isActive) {
      wasActiveRef.current = true;
      setFrozenStats(null);
    } else if (wasActiveRef.current && !isActive) {
      wasActiveRef.current = false;
      const snap = { ...liveSnapshot.current };
      if (snap.genTokensSlots > 0) {
        setFrozenStats(snap);
      }
    }
  }, [fusion, isActive]);

  const showLive = fusion && isActive;
  const statsToDisplay = showLive ? {
    genTokensSlots: fusion.genTokensPerRequestSlots,
    ttftMs: fusion.ttftMs != null ? formatMs(fusion.ttftMs) : null,
    elapsedMs: formatMs(fusion.requestElapsedMs),
  } as LastRequestStats : (frozenStats ?? liveSnapshot.current);

  if (!fusion) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 w-full h-full">
        <span className="text-[16px] font-mono text-stealth-muted/40 tracking-widest">{displayAlias}</span>
        <span className="text-[8px] font-mono text-stealth-muted/30">PORT {displayPort}</span>
      </div>
    );
  }

  const isLaunching = fusion.engine_state === "LOADING";
  const ctxTotal = fusion.ctxTotal || 0;
  const sessionPct = ctxTotal > 0 ? Math.min((fusion.genTokensPerSession / ctxTotal) * 100, 100) : 0;

  // Context bars logic:
  // - unified_kv ON or parallel=1 → show 1 cumulative bar
  // - unified_kv OFF and parallel>1 → show per-slot bars
  const isUnifiedContext = fusion.unified_kv || fusion.parallel <= 1;
  const visibleSlots = isUnifiedContext
    ? [{ id: 0, n_decoded: fusion.genTokensPerSession, is_processing: false }]
    : fusion.slotCtx.filter(s => s.n_decoded > 0);

  // PP TPS value — prefer log parser when available, fallback to /metrics
  const ppTpsValue = fusion.LP_prefillTps != null && fusion.LP_prefillTps > 0
    ? fusion.LP_prefillTps.toFixed(0)
    : fusion.prefillTpsMetrics > 0
      ? fusion.prefillTpsMetrics.toFixed(0)
      : "--";

  return (
    <AnimatePresence mode="wait">
      {isLaunching ? (
        <motion.div
          key="launching"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex flex-col items-center justify-center gap-3 w-full h-full"
        >
          <motion.div
            animate={{ scale: [1, 1.15, 1], opacity: [0.6, 1, 0.6] }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
            className="w-8 h-8 rounded-full border-2 border-nv-green/60 flex items-center justify-center"
          >
            <div className="w-2 h-2 bg-nv-green rounded-full" />
          </motion.div>

          <span className="text-[10px] font-mono text-nv-green tracking-widest animate-pulse">
            INITIALIZING CORE
          </span>
          <span className="text-[8px] font-mono text-stealth-muted/40">{displayAlias} : {displayPort}</span>
        </motion.div>
      ) : (
        <motion.div
          key="dashboard"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex flex-col w-full h-full px-2 py-1 gap-0 overflow-hidden"
        >
          {/* ═══ HEADER — alias + phase indicator + controls ═══════ */}
          <div className="flex items-center justify-between flex-shrink-0 mb-1">
            <span className="text-[14px] font-mono text-stealth-muted/50 tracking-wider truncate" title={displayAlias}>
              {displayAlias.toUpperCase()}
            </span>
            {/* Phase indicator — alternating between values, fixed position */}
            <div className="flex items-center gap-2">
              {fusion.phase === "PP" && (
                <span className="text-[9px] font-mono font-bold tracking-widest text-orange-400">
                  PROMPT PROCESSING
                </span>
              )}
              {fusion.phase === "IDLE" && (
                <span className="text-[9px] font-mono font-bold tracking-widest text-stealth-muted/60">
                  AWAITING REQUEST
                </span>
              )}
              {fusion.phase === "TG" && (
                <span className="text-[9px] font-mono font-bold tracking-widest text-nv-green">
                  GENERATION
                </span>
              )}
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[12px] font-mono text-stealth-muted/30">:{displayPort}</span>
              <button
                onClick={handleStopEngine}
                className="text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-red-600/80 hover:bg-red-500 active:bg-red-700 text-white cursor-pointer select-none"
              >
                STOP
              </button>
            </div>
          </div>

          {/* ═══ MAIN METRICS — TG hero + PP progress side by side ═══ */}
          <div className="flex gap-3 flex-shrink-0 min-h-0">
            {/* ── LEFT: TG TPS HERO (dominant) ─── */}
            <div className={`flex flex-col items-center justify-start px-2 py-1.5 rounded-sm border transition-colors ${
              fusion.phase === "TG"
                ? "border-green-500/30 bg-black/8"
                : "border-stone-500/10 bg-black/4"
            }`} style={{ flex: '1 1 60%' }}>
              {/* Phase label */}
              <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider mb-0.5">GENERATION</span>

              {/* Big TG number — the hero metric */}
              <div className="flex items-baseline gap-1">
                <motion.span
                  key={fusion.genTpsSlots}
                  initial={{ opacity: 0.7, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2 }}
                  className="font-mono font-bold tracking-tight leading-none"
                  style={{
                    fontSize: 'clamp(2rem, 6vh, 3.5rem)',
                    color: fusion.genTpsSlots > 0 ? '#22c55e' : 'rgba(148,163,184,0.25)'
                  }}
                >
                  {fusion.genTpsSlots > 0 ? fusion.genTpsSlots.toFixed(1) : "--"}
                </motion.span>
                <span className="text-[7px] font-mono text-stealth-muted/30 tracking-wider">tok/s</span>
              </div>

              {/* Per-request micro-stats — always visible, no layout shifts */}
              <div className="flex items-center gap-2 mt-1.5">
                <span className={`text-[8px] font-mono ${showLive ? "text-nv-green/70" : "text-stealth-muted/35"}`}>
                  {statsToDisplay.genTokensSlots > 0 ? statsToDisplay.genTokensSlots + " tok" : "--"}
                </span>
                <span className="text-[6px] text-stealth-muted/15">│</span>
                <span className={`text-[8px] font-mono ${showLive ? "text-telemetry-amber/70" : "text-stealth-muted/35"}`}>
                  TTFT {statsToDisplay.ttftMs ?? "--"}
                </span>
                <span className="text-[6px] text-stealth-muted/15">│</span>
                <span className={`text-[8px] font-mono ${showLive ? "text-nv-green/70" : "text-stealth-muted/35"}`}>
                  {statsToDisplay.elapsedMs}
                </span>
              </div>
            </div>

            {/* ── RIGHT: PREFILL (secondary) — use LP_prefillTps as primary, fallback to /metrics ─── */}
            <div className={`flex flex-col items-center justify-start px-2 py-1.5 rounded-sm border transition-colors ${
              fusion.phase === "PP"
                ? "border-telemetry-amber/30 bg-black/8"
                : "border-stone-500/10 bg-black/4"
            }`} style={{ flex: '1 1 40%' }}>
              {/* Phase label */}
              <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider mb-0.5">PREFILL</span>

              {/* PP TPS number — primary value from log parser, fallback to /metrics */}
              <div className="flex items-baseline gap-1">
                <motion.span
                  key={ppTpsValue}
                  initial={{ opacity: 0.7, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2 }}
                  className="font-mono font-bold tracking-tight leading-none"
                  style={{
                    fontSize: 'clamp(1.5rem, 4vh, 2.5rem)',
                    color: ppTpsValue !== "--" ? '#d97706' : 'rgba(148,163,184,0.25)'
                  }}
                >
                  {ppTpsValue}
                </motion.span>
                <span className="text-[7px] font-mono text-stealth-muted/30 tracking-wider">tok/s</span>
              </div>

              {/* PP progress bar — only during active prefill */}
              {fusion.phase === "PP" && fusion.LP_prefillProgress != null && (
                <div className="flex items-center gap-1 mt-1 w-full">
                  <div className="flex-1 h-1 rounded-full bg-black/20 overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      style={{ backgroundColor: '#d97706' }}
                      animate={{ width: `${(fusion.LP_prefillProgress ?? 0) * 100}%` }}
                      transition={{ duration: 0.15 }}
                    />
                  </div>
                  <span className="text-[6px] font-mono text-telemetry-amber/70">
                    {((fusion.LP_prefillProgress ?? 0) * 100).toFixed(0)}%
                  </span>
                </div>
              )}

              {/* LP prompt tokens — always visible */}
              <span className="text-[7px] font-mono text-red-400/60 mt-0.5">
                {fusion.LP_promptTokens != null && fusion.LP_promptTokens > 0 ? formatK(fusion.LP_promptTokens) + " tok" : "--"}
              </span>
            </div>
          </div>

          {/* ═══ CONTEXT FILL — unified or per-slot, always visible ═══ */}
          <div className="flex flex-col gap-px mt-1.5 flex-shrink-0">
            {visibleSlots.map((slot) => {
              const slotPct = ctxTotal > 0 ? Math.min((slot.n_decoded / ctxTotal) * 100, 100) : 0;
              return (
                <div key={slot.id} className="flex items-center gap-2">
                  <span className={`text-[6px] font-mono w-7 text-right flex-shrink-0 ${isUnifiedContext ? 'text-stealth-muted/35' : 'text-stealth-muted/35'}`}>
                    {isUnifiedContext ? "CTX" : `S${slot.id + 1}`}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-black/20 overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      style={{
                        width: `${slotPct}%`,
                        backgroundColor: slotPct > 85 ? '#ef4444' : slotPct > 60 ? '#d97706' : isUnifiedContext ? '#6366f1' : (slot.is_processing ? '#22c55e' : 'rgba(99,102,241,0.3)'),
                      }}
                      animate={{ width: `${slotPct}%` }}
                      transition={{ duration: 0.3 }}
                    />
                  </div>
                  <span className="text-[6px] font-mono text-stealth-muted/40 whitespace-nowrap flex-shrink-0">
                    {formatK(slot.n_decoded)} / {formatK(ctxTotal)}
                  </span>
                </div>
              );
            })}
          </div>

          {/* ═══ FOOTER — mode indicator only (LP:TG and BELT removed) ═══ */}
          <div className="flex items-center justify-between mt-1 flex-shrink-0">
            <span className={`text-[6px] font-mono tracking-wider ${fusion.unified_kv ? "text-nv-green/70" : "text-stealth-muted/30"}`}>
              {fusion.unified_kv ? "UNIFIED KV" : `×${fusion.parallel}`}
            </span>
          </div>

          {/* ═══ BENCH WIDGET — compact, below footer ══════════════ */}
          <div className="flex-shrink-0 mt-1">
            {fusion.engine_state !== "LOADING" && (
              <BenchWidget port={displayPort} variant="compact" />
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}