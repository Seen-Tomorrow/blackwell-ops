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

  // Frozen stats shown after request ends (2s delay before clearing)
  const [frozenStats, setFrozenStats] = useState<LastRequestStats | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveSnapshot = useRef<LastRequestStats>({ genTokensSlots: 0, ttftMs: null, elapsedMs: "0ms" });
  const wasActiveRef = useRef(false);

  const handleStopEngine = useCallback(async () => {
    try {
      await invoke("stop_engine", { alias: displayAlias });
    } catch (e) {
      console.error("[FUSION] stop_engine failed:", e);
    }
  }, [displayAlias]);

  const clearFadeTimer = useCallback(() => {
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => clearFadeTimer();
  }, [clearFadeTimer]);

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
      clearFadeTimer();
    } else if (wasActiveRef.current && !isActive) {
      wasActiveRef.current = false;
      const snap = { ...liveSnapshot.current };
      if (snap.genTokensSlots > 0) {
        setFrozenStats(snap);
        clearFadeTimer();
        fadeTimerRef.current = setTimeout(() => {
          setFrozenStats(null);
          fadeTimerRef.current = null;
        }, 2000);
      }
    }
  }, [fusion, isActive, clearFadeTimer]);

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

  // Slot bars: S0 always shown + any other slot with n_decoded > 0
  const visibleSlots = fusion.slotCtx.filter(s => s.id === 0 || s.n_decoded > 0);

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

              {/* Per-request micro-stats — compact row under TG */}
              {statsToDisplay && statsToDisplay.genTokensSlots > 0 && (
                <div className="flex items-center gap-2 mt-1.5">
                  <span className={`text-[8px] font-mono ${showLive ? "text-nv-green/70" : "text-stealth-muted/35"}`}>
                    {statsToDisplay.genTokensSlots} tok
                  </span>
                  {statsToDisplay.ttftMs && (
                    <>
                      <span className="text-[6px] text-stealth-muted/15">│</span>
                      <span className={`text-[8px] font-mono ${showLive ? "text-telemetry-amber/70" : "text-stealth-muted/35"}`}>
                        TTFT {statsToDisplay.ttftMs}
                      </span>
                    </>
                  )}
                  <span className="text-[6px] text-stealth-muted/15">│</span>
                  <span className={`text-[8px] font-mono ${showLive ? "text-nv-green/70" : "text-stealth-muted/35"}`}>
                    {statsToDisplay.elapsedMs}
                  </span>
                </div>
              )}
            </div>

            {/* ── RIGHT: PREFILL (secondary) ─── */}
            <div className={`flex flex-col items-center justify-start px-2 py-1.5 rounded-sm border transition-colors ${
              fusion.phase === "PP"
                ? "border-telemetry-amber/30 bg-black/8"
                : "border-stone-500/10 bg-black/4"
            }`} style={{ flex: '1 1 40%' }}>
              {/* Phase label */}
              <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider mb-0.5">PREFILL</span>

              {/* PP TPS number */}
              <div className="flex items-baseline gap-1">
                <motion.span
                  key={fusion.prefillTpsMetrics}
                  initial={{ opacity: 0.7, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2 }}
                  className="font-mono font-bold tracking-tight leading-none"
                  style={{
                    fontSize: 'clamp(1.5rem, 4vh, 2.5rem)',
                    color: fusion.prefillTpsMetrics > 0 ? '#d97706' : 'rgba(148,163,184,0.25)'
                  }}
                >
                  {fusion.prefillTpsMetrics > 0 ? fusion.prefillTpsMetrics.toFixed(0) : "--"}
                </motion.span>
                <span className="text-[7px] font-mono text-stealth-muted/30 tracking-wider">tok/s</span>
              </div>

              {/* LP_ prefill TPS — red, half size */}
              {fusion.LP_prefillTps != null && fusion.LP_prefillTps > 0 && (
                <motion.span
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  className="font-mono font-bold text-red-400 leading-none mt-0.5"
                  style={{ fontSize: 'clamp(0.6rem, 1.5vh, 0.85rem)' }}
                >
                  LP {fusion.LP_prefillTps.toFixed(0)}
                </motion.span>
              )}

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

              {/* LP prompt tokens */}
              {fusion.LP_promptTokens != null && fusion.LP_promptTokens > 0 && (
                <span className="text-[7px] font-mono text-red-400/60 mt-0.5">
                  {formatK(fusion.LP_promptTokens)} tok
                </span>
              )}
            </div>
          </div>

          {/* ═══ SESSION CONTEXT FILL — cumulative, prominent ═══════ */}
          <div className="flex items-center gap-2 px-1 mt-1.5 flex-shrink-0">
            <span className="text-[7px] font-mono text-stealth-muted/30 tracking-wider w-16 flex-shrink-0">CONTEXT</span>
            <div className="flex-1 h-1.5 rounded-full bg-black/20 overflow-hidden relative">
              <motion.div
                className="h-full rounded-full"
                style={{
                  width: `${sessionPct}%`,
                  backgroundColor: sessionPct > 85 ? '#ef4444' : sessionPct > 60 ? '#d97706' : '#6366f1'
                }}
                animate={{ width: `${sessionPct}%` }}
                transition={{ duration: 0.3 }}
              />
            </div>
            <span className="text-[7px] font-mono text-stealth-muted/40 whitespace-nowrap flex-shrink-0">
              {formatK(fusion.genTokensPerSession)} / {formatK(ctxTotal)}
            </span>
          </div>

          {/* ═══ SLOT BARS — compact, only active slots ═════════════ */}
          <div className="flex flex-col gap-px mt-1 flex-shrink-0">
            {visibleSlots.map((slot) => {
              const slotPct = ctxTotal > 0 ? Math.min((slot.n_decoded / ctxTotal) * 100, 100) : 0;
              return (
                <div key={slot.id} className="flex items-center gap-2">
                  <span className={`text-[6px] font-mono w-7 text-right flex-shrink-0 ${slot.n_decoded > 0 ? 'text-stealth-muted/35' : 'text-stealth-muted/15'}`}>
                    S{slot.id + 1}
                  </span>
                  <div className="flex-1 h-1 rounded-full bg-black/8 overflow-hidden">
                    <motion.div
                      className="h-full rounded-full"
                      style={{
                        width: `${slotPct}%`,
                        backgroundColor: slot.is_processing ? '#22c55e' : 'rgba(99,102,241,0.3)',
                      }}
                      animate={{ width: `${slotPct}%` }}
                      transition={{ duration: 0.2 }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          {/* ═══ FOOTER — mode + phase indicators ══════════════════ */}
          <div className="flex items-center justify-between mt-1 flex-shrink-0">
            <span className={`text-[6px] font-mono tracking-wider ${fusion.unified_kv ? "text-nv-green/70" : "text-stealth-muted/30"}`}>
              {fusion.unified_kv ? "UNIFIED KV" : `×${fusion.parallel}`}
            </span>
            <div className="flex items-center gap-2">
              {fusion.LP_phase && fusion.LP_phase !== "IDLE" && (
                <span className="text-[6px] font-mono text-red-400/70">
                  LP:{fusion.LP_phase}
                </span>
              )}
              {fusion.LP_resetSource && (
                <span className={`text-[6px] font-mono tracking-wider ${
                  fusion.LP_resetSource === 'prompt' ? 'text-nv-green/70' : 'text-telemetry-amber/70'
                }`}>
                  {fusion.LP_resetSource === 'prompt' ? "BELT" : "SUSPENDERS"}
                </span>
              )}
            </div>
          </div>

          {/* ═══ BENCH WIDGET — compact, below footer ══════════════ */}
          {fusion.engine_state === "READY" && (
            <div className="flex-shrink-0 mt-1">
              <BenchWidget port={displayPort} variant="compact" />
            </div>
          )}
        </motion.div>
      )}
    </AnimatePresence>
  );
}