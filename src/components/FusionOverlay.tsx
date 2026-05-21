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
          {/* ── Header row ─────────────────────────────── */}
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

          {/* ── Main metrics area: Prefill + bordered Generation box ─── */}
          <div className="flex gap-2 flex-1 min-h-0">
            {/* Col 1: Idle animation or Prefill TPS (narrow, ~30% width) */}
            <div className="flex flex-col items-center justify-start py-0.5 gap-0.5 w-[30%] flex-shrink-0 overflow-hidden">
              {fusion.phase === "IDLE" ? (
                /* ── Idle neural network animation ─── */
                <svg viewBox="0 0 120 160" className="w-full h-auto opacity-40" aria-hidden>
                  {[
                    [30,25],[70,20],[95,35],
                    [20,60],[60,55],[100,65],
                    [35,95],[75,90],[95,100],
                    [25,130],[65,125],[100,135]
                  ].map((p, i) => (
                    <circle key={`n${i}`} cx={p[0]} cy={p[1]} r="2.5" fill="#22c55e">
                      <animate attributeName="r" values="2;4.5;2" dur={`${1.2 + (i % 4) * 0.3}s`} repeatCount="indefinite" />
                      <animate attributeName="opacity" values="0.3;1;0.3" dur={`${1.2 + (i % 4) * 0.3}s`} repeatCount="indefinite" />
                    </circle>
                  ))}
                  {[
                    [30,25,70,20],[70,20,95,35],
                    [20,60,60,55],[60,55,100,65],
                    [35,95,75,90],[75,90,95,100],
                    [25,130,65,125],[65,125,100,135],
                    [30,25,20,60],[70,20,60,55],[95,35,100,65],
                    [20,60,35,95],[60,55,75,90],[100,65,95,100],
                    [35,95,25,130],[75,90,65,125],[95,100,100,135]
                  ].map((l, i) => (
                    <line key={`l${i}`} x1={l[0]} y1={l[1]} x2={l[2]} y2={l[3]} stroke="#22c55e" strokeWidth="0.4">
                      <animate attributeName="stroke-opacity" values="0.1;0.5;0.1" dur={`${1.8 + (i % 3) * 0.4}s`} repeatCount="indefinite" />
                    </line>
                  ))}
                </svg>
              ) : (
                /* ── Active: Prefill TPS ─── */
                <>
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
                </>
              )}
            </div>

            {/* Col 2: Bordered Generation box (~70% width) */}
            <div className="border border-stone-500/30 rounded-sm p-2 flex flex-col justify-between min-h-[80px] flex-1 overflow-hidden">
              {/* Active: Generation TPS + request stats + session ─── */}
              <div className="flex flex-col h-full justify-between">
                {/* Top row: big TPS left, stats right — contained */}
                <div className="flex items-start justify-between">
                  {/* Big TPS number — left aligned, grows to fill space */}
                  <div className="flex flex-col items-start min-w-0 flex-shrink">
                    <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">GENERATION</p>
                    <span className="font-mono font-bold tracking-tight" style={{ fontSize: 'clamp(1.5rem, 6vh, 3rem)', color: fusion.genTpsSlots > 0 ? '#22c55e' : 'rgba(148,163,184,0.5)' }}>
                      {fusion.genTpsSlots > 0 ? fusion.genTpsSlots.toFixed(0) : "--"}
                    </span>
                    <span className="text-[6px] font-mono text-stealth-muted/30 tracking-widest">[slots]</span>
                  </div>

                  {/* Request stats — right side, fixed width */}
                  {statsToDisplay && statsToDisplay.genTokensSlots > 0 ? (
                    <div className="flex flex-col gap-1.5 items-end text-right flex-shrink-0 ml-3">
                      <div>
                        <p className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">GEN</p>
                        <p className={`text-[9px] font-mono mt-0.5 ${showLive ? "text-nv-green" : "text-stealth-muted/60"}`}>
                          {statsToDisplay.genTokensSlots}
                        </p>
                      </div>
                      {statsToDisplay.ttftMs && (
                        <div>
                          <p className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">TTFT</p>
                          <p className={`text-[9px] font-mono mt-0.5 ${showLive ? "text-telemetry-amber" : "text-stealth-muted/60"}`}>
                            {statsToDisplay.ttftMs}
                          </p>
                        </div>
                      )}
                      <div>
                        <p className="text-[6px] font-mono text-stealth-muted/40 tracking-wider">ELAPSED</p>
                        <p className={`text-[9px] font-mono mt-0.5 ${showLive ? "text-nv-green" : "text-stealth-muted/60"}`}>
                          {statsToDisplay.elapsedMs}
                        </p>
                      </div>
                    </div>
                  ) : null}
                </div>

                {/* Bottom: Session tokens centered */}
                <div className="flex flex-col items-center mt-2">
                  <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">SESSION</p>
                  <span className="font-mono text-xs text-stealth-muted/60" style={{ fontSize: 'clamp(1rem, 3.5vh, 2rem)' }}>
                    {fusion.genTokensPerSession}
                  </span>
                  <span className="text-[7px] font-mono text-stealth-muted/40 tracking-widest">TOKENS</span>
                </div>
              </div>
            </div>
          </div>

          {/* ── Session cumulative fill bar (full width) ─── */}
          <div className="flex items-center gap-2 px-1 py-0.5">
            <span className="text-[6px] font-mono text-stealth-muted/40 w-16 flex-shrink-0">SESSION FILL</span>
            <div className="flex-1 h-2 rounded-full bg-black/10 overflow-hidden relative">
              <div
                className="h-full rounded-full transition-all duration-300"
                style={{ width: `${sessionPct}%`, backgroundColor: sessionPct > 80 ? '#ef4444' : '#6366f1' }}
              />
            </div>
            <span className="text-[7px] font-mono text-stealth-muted/40 whitespace-nowrap flex-shrink-0">
              {formatK(fusion.genTokensPerSession)} / {formatK(ctxTotal)}
            </span>
          </div>

          {/* ── Divider ──────────────────────────────────────── */}
          <div className="w-full h-px bg-black/15" />

          {/* ── Slot bars (only active slots) ─── */}
          <div className="flex flex-col gap-0.5">
            {visibleSlots.map((slot) => {
              const slotPct = ctxTotal > 0 ? Math.min((slot.n_decoded / ctxTotal) * 100, 100) : 0;
              return (
                <div key={slot.id} className="flex items-center gap-2">
                  <span className={`text-[7px] font-mono w-8 text-right flex-shrink-0 ${slot.n_decoded > 0 ? 'text-stealth-muted/50' : 'text-stealth-muted/20'}`}>
                    {formatK(slot.n_decoded)}
                  </span>
                  <div className="flex-1 h-2 rounded-full bg-black/10 overflow-hidden">
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
