import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FusionUpdate } from "../lib/types";
import FusionPhaseBadge from "./FusionPhaseBadge";

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
  if (n >= 1000) return `${(n / 1000).toFixed(0)}K`;
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
          className="flex flex-col gap-1 w-full h-full px-1 py-0.5"
        >
          {/* ═══ HEADER ═══════════════════════════════════════ */}
          <div className="flex items-center justify-between">
            <span className="text-[16px] font-mono text-stealth-muted/60 tracking-wider truncate" title={displayAlias}>
              {displayAlias.toUpperCase()}
            </span>
            <FusionPhaseBadge phase={fusion.phase} />
            <div className="flex items-center gap-2">
              <span className="text-[14px] font-mono text-stealth-muted/40">:{displayPort}</span>
              <button
                onClick={handleStopEngine}
                className="text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-red-600/80 hover:bg-red-500 active:bg-red-700 text-white cursor-pointer select-none"
              >
                STOP
              </button>
            </div>
          </div>

          {/* ═══ SPEED METRICS ROW — centered PP + TG pair, radar scanline below ═══ */}
          <div className="flex items-center justify-center gap-2 flex-1 min-h-0 relative">
            {fusion.phase !== "IDLE" && (
              /* ── PREFILL card (left) — hidden during idle ─── */
              <div className="flex flex-col items-center justify-center px-3 py-2 rounded-sm border border-stone-500/20 bg-black/10 flex-shrink-0 min-h-[72px]" style={{ width: '24%' }}>
                <p className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">PREFILL</p>
                {fusion.phase === "PP" && (
                  <div className="w-full h-0.5 rounded-full bg-black/20 overflow-hidden my-0.5">
                    <motion.div
                      className="h-full rounded-full absolute left-0"
                      style={{ backgroundColor: '#b87a00', width: '40%' }}
                      animate={{ x: ['-100%', '350%'] }}
                      transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut" }}
                    />
                  </div>
                )}
                <span className="font-mono font-bold tracking-tight text-stealth-muted/50 leading-none" style={{ fontSize: 'clamp(1.25rem, 4vh, 2rem)' }}>
                  {fusion.prefillTpsMetrics > 0 ? fusion.prefillTpsMetrics.toFixed(0) : "--"}
                </span>
                <span className="text-[6px] font-mono text-stealth-muted/30 tracking-wider">tok/s</span>
              </div>
            )}

            {/* ── GENERATION card (right) — always visible, no box ─── */}
            <div className="flex flex-col items-center justify-center px-3 py-2 flex-shrink-0 min-h-[72px]" style={{ width: '24%' }}>
              <p className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">GENERATION</p>
              <div className="flex items-baseline gap-1.5">
                <span
                  className="font-mono font-bold tracking-tight leading-none"
                  style={{ fontSize: 'clamp(1.25rem, 4vh, 2rem)', color: fusion.genTpsSlots > 0 ? '#22c55e' : 'rgba(148,163,184,0.4)' }}
                >
                  {fusion.genTpsSlots > 0 ? fusion.genTpsSlots.toFixed(0) : "--"}
                </span>
                <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">tok/s</span>
              </div>
            </div>

            {/* ── Radar scanline — sweeps across the gap below cards ─── */}
            <motion.div
              className="absolute bottom-0 left-[15%] h-px bg-gradient-to-r from-transparent via-nv-green/40 to-transparent"
              style={{ width: '70%' }}
              animate={{ opacity: [0.2, 0.8, 0.2], x: ['-30%', '30%', '-30%'] }}
              transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
            />
          </div>

          {/* ═══ PER-REQUEST METRICS (grouped together) ══════ */}
          {statsToDisplay && statsToDisplay.genTokensSlots > 0 && (
            <div className="flex items-center gap-3 px-2 py-1 rounded-sm border border-stone-500/15 bg-black/5">
              {/* GEN tokens */}
              <div className="flex flex-col items-center flex-1">
                <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">GEN</span>
                <span className={`text-[10px] font-mono font-bold ${showLive ? "text-nv-green" : "text-stealth-muted/50"}`}>
                  {statsToDisplay.genTokensSlots}
                </span>
              </div>
              {/* TTFT */}
              {statsToDisplay.ttftMs && (
                <>
                  <div className="w-px h-4 bg-stone-500/20" />
                  <div className="flex flex-col items-center flex-1">
                    <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">TTFT</span>
                    <span className={`text-[10px] font-mono font-bold ${showLive ? "text-telemetry-amber" : "text-stealth-muted/50"}`}>
                      {statsToDisplay.ttftMs}
                    </span>
                  </div>
                </>
              )}
              {/* ELAPSED */}
              <>
                <div className="w-px h-4 bg-stone-500/20" />
                <div className="flex flex-col items-center flex-1">
                  <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">ELAPSED</span>
                  <span className={`text-[10px] font-mono font-bold ${showLive ? "text-nv-green" : "text-stealth-muted/50"}`}>
                    {statsToDisplay.elapsedMs}
                  </span>
                </div>
              </>
            </div>
          )}

          {/* ═══ SESSION + CONTEXT FILL ══════════════════════ */}
          <div className="flex flex-col gap-1">
            {/* Session tokens row */}
            <div className="flex items-center justify-between px-1">
              <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">SESSION</span>
              <span className="font-mono text-xs text-stealth-muted/60">{fusion.genTokensPerSession} tokens</span>
            </div>
            {/* Context fill bar */}
            <div className="flex items-center gap-2 px-1">
              <div className="flex-1 h-1.5 rounded-full bg-black/15 overflow-hidden relative">
                <div
                  className="h-full rounded-full transition-all duration-300"
                  style={{ width: `${sessionPct}%`, backgroundColor: sessionPct > 80 ? '#ef4444' : '#6366f1' }}
                />
              </div>
              <span className="text-[7px] font-mono text-stealth-muted/40 whitespace-nowrap flex-shrink-0">
                {formatK(fusion.genTokensPerSession)} / {formatK(ctxTotal)}
              </span>
            </div>
          </div>

          {/* ═══ DIVIDER ═════════════════════════════════════ */}
          <div className="w-full h-px bg-black/15" />

          {/* ═══ SLOT BARS (only active slots) ══════════════ */}
          <div className="flex flex-col gap-0.5">
            {visibleSlots.map((slot) => {
              const slotPct = ctxTotal > 0 ? Math.min((slot.n_decoded / ctxTotal) * 100, 100) : 0;
              return (
                <div key={slot.id} className="flex items-center gap-2">
                  <span className={`text-[7px] font-mono w-8 text-right flex-shrink-0 ${slot.n_decoded > 0 ? 'text-stealth-muted/50' : 'text-stealth-muted/20'}`}>
                    {formatK(slot.n_decoded)}
                  </span>
                  <div className="flex-1 h-1.5 rounded-full bg-black/10 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-200"
                      style={{
                        width: `${slotPct}%`,
                        backgroundColor: slot.is_processing ? '#22c55e' : 'rgba(99,102,241,0.4)',
                      }}
                    />
                  </div>
                  <span className="text-[6px] font-mono text-stealth-muted/30 w-8 flex-shrink-0">
                    {formatK(ctxTotal)}
                  </span>
                </div>
              );
            })}

            {/* Unified/multi mode indicator */}
            <div className="flex items-center justify-between mt-0.5">
              <span className={`text-[6px] font-mono tracking-wider ${fusion.unified_kv ? "text-nv-green/70" : "text-stealth-muted/40"}`}>
                {fusion.unified_kv ? "UNIFIED KV" : `MULTI-SLOT ×${fusion.parallel}`}
              </span>
              <span className="text-[6px] font-mono text-stealth-muted/30">
                PHASE: {fusion.phase}
              </span>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
