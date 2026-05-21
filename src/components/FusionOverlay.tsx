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

interface LastRequestStats {
  genTokensSlots: number;
  genTokensMetrics: number;
  ttftMs: string | null;
  elapsedMs: string;
}

export default function FusionOverlay({ alias, enginePort, fusion }: FusionOverlayProps) {
  const displayAlias = alias ?? "ENGINE";
  const displayPort = enginePort ?? 9090;

  // Frozen stats shown after request ends (2s delay before clearing)
  const [frozenStats, setFrozenStats] = useState<LastRequestStats | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveSnapshot = useRef<LastRequestStats>({ genTokensSlots: 0, genTokensMetrics: 0, ttftMs: null, elapsedMs: "0ms" });
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

  // Active when phase is PP or TG (not IDLE)
  const isActive = fusion && fusion.phase !== "IDLE";

  if (fusion && isActive) {
    liveSnapshot.current = {
      genTokensSlots: fusion.genTokensPerRequestSlots,
      genTokensMetrics: fusion.genTokensPerRequestMetrics,
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
      if (snap.genTokensSlots > 0 || snap.genTokensMetrics > 0) {
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
    genTokensMetrics: fusion.genTokensPerRequestMetrics,
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

  return (
    <AnimatePresence mode="wait">
      {isLaunching ? (
        /* ── Launch sequence ───────────────────────────────────── */
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
        /* ── Full FUSION dashboard — dual-source display for Phase 1 testing ─── */
        <motion.div
          key="dashboard"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="flex flex-col gap-1 w-full h-full px-1 py-0.5"
        >
          {/* ── Header row: ALIAS | PHASE | PORT ─────────────── */}
          <div className="grid grid-cols-3 items-center">
            <span className="text-[16px] font-mono text-stealth-muted/60 tracking-wider truncate" title={displayAlias}>
              {displayAlias.toUpperCase()}
            </span>
            <div className="flex justify-center">
              <FusionPhaseBadge phase={fusion.phase} />
            </div>
            <div className="flex flex-col items-end gap-0.5">
              <span className="text-[14px] font-mono text-stealth-muted/40">:{displayPort}</span>
              <button
                onClick={handleStopEngine}
                className="text-[7px] font-bold tracking-wider px-1 py-px rounded bg-red-600/80 hover:bg-red-500 active:bg-red-700 text-white cursor-pointer select-none"
              >
                STOP
              </button>
            </div>
          </div>

          {/* ── Middle section: per-req | PREFILL | GEN TPS (dual source) ─── */}
          <div className="grid grid-cols-4 gap-1 flex-1 min-h-0">
            {/* Col 1: Per-request stats (always visible) */}
            <div className="flex flex-col justify-start py-0.5">
              {statsToDisplay && (statsToDisplay.genTokensSlots > 0 || statsToDisplay.genTokensMetrics > 0) ? (
                <>
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">GEN [slots]</p>
                    <p className={`text-[10px] font-mono mt-0.5 ${showLive ? "text-nv-green" : "text-stealth-muted/60"}`}>
                      {statsToDisplay.genTokensSlots}
                    </p>
                  </div>
                  <div className="mt-0.5">
                    <p className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">GEN [metrics]</p>
                    <p className={`text-[10px] font-mono mt-0.5 ${showLive ? "text-nv-green" : "text-stealth-muted/60"}`}>
                      {statsToDisplay.genTokensMetrics}
                    </p>
                  </div>
                  {statsToDisplay.ttftMs && (
                    <div className="mt-1">
                      <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">TTFT</p>
                      <p className={`text-[9px] font-mono mt-0.5 ${showLive ? "text-telemetry-amber" : "text-stealth-muted/60"}`}>
                        {statsToDisplay.ttftMs}
                      </p>
                    </div>
                  )}
                  <div className="mt-1">
                    <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">ELAPSED</p>
                    <p className={`text-[9px] font-mono mt-0.5 ${showLive ? "text-nv-green" : "text-stealth-muted/60"}`}>
                      {statsToDisplay.elapsedMs}
                    </p>
                  </div>
                </>
              ) : (
                <span className="text-[8px] font-mono text-stealth-muted/30 italic">AWAITING REQUEST</span>
              )}
            </div>

            {/* Col 2: Prefill TPS — dual source */}
            <div className="flex flex-col items-center justify-start py-0.5 gap-0.5">
              <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">PREFILL</p>
              {fusion.phase === "PP" && (
                <div className="w-full h-1 rounded-full bg-black/10 overflow-hidden">
                  <motion.div
                    className="h-full rounded-full"
                    style={{ backgroundColor: '#b87a00' }}
                    animate={{ width: ["20%", "60%", "20%"] }}
                    transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
                  />
                </div>
              )}
              <span className="font-mono font-bold tracking-tight text-stealth-muted/50" style={{ fontSize: 'clamp(1rem, 4vh, 2rem)' }}>
                {fusion.prefillTpsMetrics > 0 ? fusion.prefillTpsMetrics.toFixed(0) : "--"}
              </span>
              <span className="text-[6px] font-mono text-stealth-muted/30 tracking-widest">[metrics]</span>
              <span className="text-[7px] font-mono text-stealth-muted/40 tracking-widest">TOKENS / SEC</span>
            </div>

            {/* Col 3: Generation TPS — dual source side by side */}
            <div className="flex flex-col items-center justify-start py-0.5 gap-0.5">
              <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">GENERATION</p>

              {/* [slots] TPS */}
              <span className="font-mono font-bold tracking-tight" style={{ fontSize: 'clamp(1.2rem, 5vh, 2.5rem)', color: fusion.genTpsSlots > 0 ? '#22c55e' : 'rgba(148,163,184,0.5)' }}>
                {fusion.genTpsSlots > 0 ? fusion.genTpsSlots.toFixed(0) : "--"}
              </span>
              <span className="text-[6px] font-mono text-stealth-muted/30 tracking-widest">[slots]</span>

              {/* [metrics] TPS */}
              <span className="font-mono font-bold tracking-tight" style={{ fontSize: 'clamp(1.2rem, 5vh, 2.5rem)', color: fusion.genTpsMetrics > 0 ? '#22c55e' : 'rgba(148,163,184,0.5)' }}>
                {fusion.genTpsMetrics > 0 ? fusion.genTpsMetrics.toFixed(0) : "--"}
              </span>
              <span className="text-[6px] font-mono text-stealth-muted/30 tracking-widest">[metrics]</span>
            </div>

            {/* Col 4: Session totals */}
            <div className="flex flex-col items-center justify-start py-0.5 gap-1">
              <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">SESSION</p>
              <span className="font-mono text-xs text-stealth-muted/60" style={{ fontSize: 'clamp(0.8rem, 3vh, 1.5rem)' }}>
                {fusion.genTokensPerSession}
              </span>
              <span className="text-[7px] font-mono text-stealth-muted/40 tracking-widest">TOKENS</span>

              <div className="mt-1 w-full px-1">
                <p className="text-[6px] font-mono text-stealth-muted/30 tracking-wider">CTX FILL</p>
                <div className="w-full h-1 rounded-full bg-black/10 overflow-hidden mt-0.5">
                  <div
                    className="h-full rounded-full transition-all duration-200"
                    style={{ width: `${Math.min(fusion.ctxFillPct, 100)}%`, backgroundColor: fusion.ctxFillPct > 80 ? '#ef4444' : '#6366f1' }}
                  />
                </div>
                <span className="text-[6px] font-mono text-stealth-muted/40">{fusion.ctxFillPct.toFixed(1)}%</span>
              </div>
            </div>
          </div>

          {/* ── Divider ──────────────────────────────────────── */}
          <div className="w-full h-px bg-black/15" />

          {/* ── Bottom: Per-slot CTX bars (full width) ───────── */}
          <div className="flex flex-col gap-1">
            {fusion.slotCtx.length > 0 ? (
              fusion.slotCtx.map((slot) => (
                <div key={slot.id} className="flex items-center gap-1">
                  <span className="text-[6px] font-mono text-stealth-muted/40 w-6">S{slot.id}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-black/10 overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all duration-200"
                      style={{
                        width: `${Math.min((slot.n_decoded / Math.max(fusion.ctxUsedSession, 1)) * 100, 100)}%`,
                        backgroundColor: slot.is_processing ? '#22c55e' : 'rgba(99,102,241,0.4)',
                      }}
                    />
                  </div>
                  <span className="text-[6px] font-mono text-stealth-muted/40 w-8 text-right">
                    {slot.n_decoded}
                  </span>
                </div>
              ))
            ) : (
              <span className="text-[7px] font-mono text-stealth-muted/30 italic">NO SLOT DATA</span>
            )}

            {/* Unified/multi mode indicator */}
            {fusion.slotCtx.length > 0 && (
              <div className="flex items-center justify-between mt-0.5">
                <span className={`text-[6px] font-mono tracking-wider ${fusion.unified_kv ? "text-nv-green/70" : "text-stealth-muted/40"}`}>
                  {fusion.unified_kv ? "UNIFIED KV" : `MULTI-SLOT ×${fusion.parallel}`}
                </span>
                <span className="text-[6px] font-mono text-stealth-muted/30">
                  PHASE: {fusion.phase}
                </span>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
