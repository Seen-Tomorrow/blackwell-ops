import { motion, AnimatePresence } from "framer-motion";
import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FusionUpdate } from "../lib/types";
import FusionTpsDisplay from "./FusionTpsDisplay";
import FusionPhaseBadge from "./FusionPhaseBadge";
import FusionSlotCtxBar from "./FusionSlotCtxBar";

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
  promptTokens: number;
  genTokens: number;
  ttftMs: string | null;
  elapsedMs: string;
}

export default function FusionOverlay({ alias, enginePort, fusion }: FusionOverlayProps) {
  const displayAlias = alias ?? "ENGINE";
  const displayPort = enginePort ?? 9090;

  // Frozen stats shown after request ends (2s delay before clearing)
  const [frozenStats, setFrozenStats] = useState<LastRequestStats | null>(null);
  const fadeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveSnapshot = useRef<LastRequestStats>({ promptTokens: 0, genTokens: 0, ttftMs: null, elapsedMs: "0ms" });
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

  const isActive = fusion && fusion.active_slots > 0;

  // Per-request token count from slot request_tokens delta (matches llama.cpp webUI)
  const totalGenTokens = fusion ? fusion.slotCtx.reduce((sum, s) => sum + s.request_tokens, 0) : 0;

  if (fusion && isActive) {
    liveSnapshot.current = {
      promptTokens: fusion.request_tokens_prompt,
      genTokens: totalGenTokens,
      ttftMs: fusion.request_ttft_ms != null ? formatMs(fusion.request_ttft_ms) : null,
      elapsedMs: formatMs(fusion.request_elapsed_ms),
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
      if (snap.genTokens > 0 || snap.promptTokens > 0) {
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
    promptTokens: fusion.request_tokens_prompt,
    genTokens: totalGenTokens,
    ttftMs: fusion.request_ttft_ms != null ? formatMs(fusion.request_ttft_ms) : null,
    elapsedMs: formatMs(fusion.request_elapsed_ms),
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
        /* ── Full FUSION dashboard — 3-col grid ─────────────────── */
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

          {/* ── Middle section: per-req | PREFILL TPS | GEN TPS | reserved ─── */}
          <div className="grid grid-cols-4 gap-1 flex-1 min-h-0">
            {/* Col 1: Per-request stats (always visible) */}
            <div className="flex flex-col justify-start py-0.5">
              {statsToDisplay && (statsToDisplay.genTokens > 0 || statsToDisplay.promptTokens > 0) ? (
                <>
                  {statsToDisplay.promptTokens > 0 && (
                    <div>
                      <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">PROMPT</p>
                      <p className={`text-[10px] font-mono mt-0.5 ${showLive ? "text-nv-green" : "text-stealth-muted/60"}`}>
                        {statsToDisplay.promptTokens}
                      </p>
                    </div>
                  )}
                  {statsToDisplay.genTokens > 0 && (
                    <div className="mt-1">
                      <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">GENERATED</p>
                      <p className={`text-[10px] font-mono mt-0.5 ${showLive ? "text-nv-green" : "text-stealth-muted/60"}`}>
                        {statsToDisplay.genTokens}
                      </p>
                    </div>
                  )}
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

            {/* Col 2: Prefill TPS (grey) */}
            <div className="flex flex-col items-center justify-start py-0.5 gap-1">
              <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">PREFILL</p>
              {fusion.phase === "PP" && (
                <div className="w-full h-1 rounded-full bg-black/10 overflow-hidden">
                  <div
                    className="h-full rounded-full transition-all duration-150"
                    style={{ width: `${Math.round(fusion.prefillProgress * 100)}%`, backgroundColor: '#b87a00' }}
                  />
                </div>
              )}
              <span className="font-mono font-bold tracking-tight text-stealth-muted/50" style={{ fontSize: 'clamp(1.2rem, 5vh, 2.5rem)' }}>
                {fusion.prefillTps > 0 ? fusion.prefillTps.toFixed(0) : "--"}
              </span>
              <span className="text-[7px] font-mono text-stealth-muted/40 tracking-widest">TOKENS / SEC</span>
            </div>

            {/* Col 3: Generation TPS (big, green) + sparkline */}
            <div className="flex flex-col items-center justify-start py-0.5 gap-1">
              <p className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">GENERATION</p>
              <FusionTpsDisplay tps={fusion.tps} history={fusion.tpsHistory} />
            </div>

            {/* Col 4: Reserved for HW telemetry */}
            <div className="flex items-center justify-center">
              <span className="text-[8px] font-mono text-stealth-muted/20 tracking-widest italic">HW TELEMETRY</span>
            </div>
          </div>

          {/* ── Divider ──────────────────────────────────────── */}
          <div className="w-full h-px bg-black/15" />

          {/* ── Bottom: Per-slot CTX bars (full width) ───────── */}
          <div className="flex flex-col gap-1.5">
            {fusion.slotCtx.length > 0 ? (
              fusion.slotCtx.map((slot) => (
                <FusionSlotCtxBar
                  key={slot.id}
                  slotId={slot.id}
                  totalTokens={slot.total_tokens}
                  ctxTotal={fusion.ctx_total}
                  isProcessing={slot.is_processing}
                />
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
                  ACTIVE {fusion.active_slots}/{fusion.slot_count}
                </span>
              </div>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
