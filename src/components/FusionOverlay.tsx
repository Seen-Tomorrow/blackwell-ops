import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { FusionUpdate } from "../lib/types";
import BenchWidget from "./BenchWidget";
import SlotCtxBars from "./SlotCtxBars";
import { useFusionHeroTpsMode } from "../hooks/useFusionHeroTpsMode";

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

  // Per-engine state stored in a Map keyed by slotIdx — no remounting needed on switch
  interface EngineStateData {
    frozenStats: LastRequestStats | null;
    liveSnapshot: LastRequestStats;
    wasActive: boolean;
  }
  const engineStates = useRef<Map<number, EngineStateData>>(new Map());

  // Get or create state for current engine
  const currentSlotIdx = fusion?.slotIdx ?? -1;
  let engState = engineStates.current.get(currentSlotIdx);
  if (!engState) {
    engState = { frozenStats: null, liveSnapshot: { genTokensSlots: 0, ttftMs: null, elapsedMs: "0ms" }, wasActive: false };
    engineStates.current.set(currentSlotIdx, engState);
  }

  // Force re-render when frozen stats change for this engine
  const [renderTick, setRenderTick] = useState(0);
  const frozenStats = engState.frozenStats;

  const handleStopEngine = useCallback(async () => {
    try {
      await invoke("stop_engine", { alias: displayAlias });
    } catch (e) {
      console.error("[FUSION] stop_engine failed:", e);
    }
  }, [displayAlias]);

  const isActive = fusion && fusion.phase !== "IDLE";

  if (fusion && isActive) {
    engState.liveSnapshot = {
      genTokensSlots: fusion.genTokensPerRequestSlots,
      ttftMs: fusion.ttftMs != null ? formatMs(fusion.ttftMs) : null,
      elapsedMs: formatMs(fusion.requestElapsedMs),
    };
  }

  useEffect(() => {
    if (!fusion || !engState) return;

    if (isActive) {
      engState.wasActive = true;
      engState.frozenStats = null;
    } else if (engState.wasActive && !isActive) {
      engState.wasActive = false;
      const snap = { ...engState.liveSnapshot };
      if (snap.genTokensSlots > 0) {
        engState.frozenStats = snap;
      }
    }
    setRenderTick(t => t + 1); // trigger re-render for frozen stats change
  }, [fusion, isActive]);

  const showLive = fusion && isActive;
  const statsToDisplay = showLive ? {
    genTokensSlots: fusion.genTokensPerRequestSlots,
    ttftMs: fusion.ttftMs != null ? formatMs(fusion.ttftMs) : null,
    elapsedMs: formatMs(fusion.requestElapsedMs),
  } as LastRequestStats : (frozenStats ?? engState.liveSnapshot);

  // Track bench warmup phase from Tauri event — covers TG meter during benchmark warmup
  const [isBenchWarmup, setIsBenchWarmup] = useState(false);
  const unsubBenchProgress = useRef<(() => void) | null>(null);

  useEffect(() => {
    let cancelled = false;
    listen<any>("bench-tg-progress", (e) => {
      if (cancelled || e.payload.port !== displayPort) return;
      setIsBenchWarmup(e.payload.phase === "warmup");
    }).then((u) => { if (!cancelled) unsubBenchProgress.current = u; });
    return () => { cancelled = true; unsubBenchProgress.current?.(); };
  }, [displayPort]);

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
  const { mode: heroTpsMode, toggle: toggleHeroTpsMode } = useFusionHeroTpsMode();

  const MAX_HERO_TPS = 200_000;
  const clampHeroTps = (n: number) => (n > 0 && n <= MAX_HERO_TPS ? n : 0);

  const ppTpsLive = clampHeroTps(Math.max(
    fusion.prefillTpsInstant ?? 0,
    fusion.logPrefillTps ?? 0,
  ));
  const ppTpsAvg = clampHeroTps(fusion.prefillTpsSession ?? 0);
  const ppTpsPick = heroTpsMode === "avg" ? ppTpsAvg : ppTpsLive;
  const ppTpsValue =
    ppTpsPick > 0
      ? ppTpsPick.toFixed(0)
      : fusion.prefillTpsMetrics > 0
        ? fusion.prefillTpsMetrics.toFixed(0)
        : "--";

  const tgTpsLive = clampHeroTps(Math.max(fusion.genTpsInstant ?? 0, fusion.logGenTps ?? 0));
  const tgTpsPick = clampHeroTps(heroTpsMode === "avg" ? fusion.genTps : tgTpsLive);
  const tgTpsValue = tgTpsPick > 0 ? tgTpsPick.toFixed(1) : "--";

  // Primary prefill progress/tokens from /slots poll (reliable); LP log is red comparison fallback
  const prefillTotal = fusion.prefillTokensTotal ?? 0;
  // Belt: ACTIVE without TG = still prefill (fixes /slots lag during bench + WebUI text)
  const isPrefillPhase =
    fusion.phase === "PP" ||
    (fusion.engine_state === "ACTIVE" && fusion.phase !== "TG");
  const primaryPrefillProgress = Math.max(
    fusion.prefillProgress ?? 0,
    fusion.logPrefillProgress ?? 0,
  );
  const primaryPrefillTokens = Math.max(
    fusion.prefillTokens ?? 0,
    fusion.logPromptTokens ?? 0,
  );
  const showPrefillProgress =
    isPrefillPhase && (prefillTotal > 0 || primaryPrefillProgress > 0);

  return (
    <div className="relative w-full h-full overflow-hidden">
      {isLaunching ? (
        <div
          key="launching"
          className="flex flex-col items-center justify-center gap-3 w-full h-full absolute inset-0"
          style={{ animation: 'fadeIn 0.2s ease' }}
        >
          <div
            className="w-8 h-8 rounded-full border-2 border-nv-green/60 flex items-center justify-center"
            style={{ animation: 'pulseScale 1.5s ease-in-out infinite' }}
          >
            <div className="w-2 h-2 bg-nv-green rounded-full" />
          </div>

          <span className="text-[10px] font-mono text-nv-green tracking-widest animate-pulse">
            INITIALIZING CORE
          </span>
          <span className="text-[8px] font-mono text-stealth-muted/40">{displayAlias} : {displayPort}</span>
        </div>
      ) : (
        <div
          key="dashboard"
          className="flex flex-col w-full h-full px-2 py-1 gap-0 overflow-hidden absolute inset-0"
          style={{ animation: 'fadeIn 0.2s ease' }}
        >
          {/* ═══ HEADER — alias + phase indicator + controls ═══════ */}
          <div className="flex items-center justify-between flex-shrink-0 mb-1">
            <div className="flex items-center gap-2">
              <span className="text-[9px] font-mono text-stealth-muted/40 tracking-widest">
                CONTEXT SLOTS
              </span>
              <button
                type="button"
                onClick={toggleHeroTpsMode}
                title={heroTpsMode === "live" ? "Hero TPS: live (per chunk). Click for session average." : "Hero TPS: session average (bench). Click for live."}
                className="text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border border-stealth-border/50 text-stealth-muted/70 hover:text-white hover:border-stealth-muted/60 cursor-pointer select-none"
              >
                {heroTpsMode === "live" ? "LIVE" : "AVG"}
              </button>
            </div>
            {/* Phase indicator — alternating between values, fixed position */}
            <div className="flex items-center gap-2">
              {isPrefillPhase && (
                <span className="text-[9px] font-mono font-bold tracking-widest text-orange-400">
                  PROMPT PROCESSING
                </span>
              )}
              {fusion.phase === "IDLE" && fusion.engine_state !== "ACTIVE" && (
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
              <span className="text-[14px] font-mono text-stealth-muted/50 tracking-wider truncate" title={displayAlias}>
                {displayAlias.toUpperCase()}
              </span>
              <span className="text-[12px] font-mono text-stealth-muted/30">:{displayPort}</span>
              <button
                onClick={handleStopEngine}
                className="text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-red-600/80 hover:bg-red-500 active:bg-red-700 text-white cursor-pointer select-none"
              >
                STOP
              </button>
            </div>
          </div>

          {/* ═══ MAIN BODY — bars | TG hero | PREFILL ═══ */}
          <div className="flex gap-2 flex-1 min-h-0" style={{ alignItems: 'stretch' }}>

            {/* ── LEFT: Slot CTX bars (side-by-side, full height) ─── */}
            {/* Give more room when multiple bars are shown (parallel > 1), whether unified or partitioned. */}
            <div className="flex-shrink-0" style={{ width: (fusion.parallel <= 1) ? '12%' : '18%', minWidth: (fusion.parallel <= 1) ? 64 : 110 }}>
              <SlotCtxBars
                slotCtx={fusion.slotCtx}
                ctxTotal={ctxTotal}
                parallel={fusion.parallel}
                unifiedKv={fusion.unified_kv}
              />
            </div>

            {/* ── RIGHT: TG hero + PREFILL side by side ─── */}
            <div className="flex gap-3 flex-1 min-h-0">
              {/* ── LEFT: TG TPS HERO (dominant) ─── */}
              <div className={`flex flex-col items-center justify-start px-2 py-1.5 rounded-sm border transition-colors relative ${
                 fusion.phase === "TG"
                   ? "border-green-500/30 bg-black/8"
                   : "border-stone-500/10 bg-black/4"
               }`} style={{ flex: '1 1 60%' }}>
                 {/* Phase label */}
                 <div className="flex items-center justify-between mb-0.5">
                   <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">GENERATION</span>
                 </div>

                 {/* Big TG number */}
                 <div className="flex items-baseline gap-1">
                   <span
                     className="font-mono font-bold tracking-tight leading-none"
                     style={{
                       fontSize: 'clamp(2rem, 6vh, 3.5rem)',
                       color: tgTpsPick > 0 ? '#22c55e' : 'rgba(148,163,184,0.25)'
                     }}
                   >
                     {tgTpsValue}
                   </span>
                   <span className="text-[7px] font-mono text-stealth-muted/30 tracking-wider">tok/s</span>
                 </div>

                {/* Per-request micro-stats — always visible, no layout shifts */}
                 <div className="flex items-center gap-2 mt-1.5">
                   <span className={`text-[8px] font-mono ${showLive ? "text-black" : "text-stealth-muted/35"}`}>
                     {statsToDisplay.genTokensSlots > 0 ? statsToDisplay.genTokensSlots + " tok" : "--"}
                   </span>
                   <span className={`text-[6px] ${showLive ? "text-black" : "text-stealth-muted/15"}`}>│</span>
                   <span className={`text-[8px] font-mono ${showLive ? "text-black" : "text-stealth-muted/35"}`}>
                     TTFT {statsToDisplay.ttftMs ?? "--"}
                   </span>
                   <span className={`text-[6px] ${showLive ? "text-black" : "text-stealth-muted/15"}`}>│</span>
                   <span className={`text-[8px] font-mono ${showLive ? "text-black" : "text-stealth-muted/35"}`}>
                     {statsToDisplay.elapsedMs}
                   </span>
                 </div>

                 {/* Bench warmup overlay — TEMP DISABLED */}
                 {/* {isBenchWarmup && (
                   <div className="absolute inset-0 flex items-center justify-center rounded-sm z-10" style={{ backgroundColor: '#3d3d3d' }}>
                     <p className="text-xl font-mono animate-pulse" style={{ color: '#22c55e' }}>WARMING UP</p>
                   </div>
                 )} */}
               </div>

              {/* ── RIGHT: PREFILL (secondary) — use logPrefillTps as primary, fallback to /metrics ─── */}
              <div className={`flex flex-col items-center justify-start px-2 py-1.5 rounded-sm border transition-colors ${
                isPrefillPhase
                  ? "border-stealth-muted/30 bg-black/8"
                  : "border-stone-500/10 bg-black/4"
              }`} style={{ flex: '1 1 40%' }}>
                {/* Phase label */}
                <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider mb-0.5">PREFILL</span>

                {/* PP TPS number — primary value from log parser, fallback to /metrics */}
                <div className="flex items-baseline gap-1">
                  <span
                    className="font-mono font-bold tracking-tight leading-none"
                    style={{
                      fontSize: 'clamp(2rem, 6vh, 3.5rem)',
                      color: ppTpsValue !== "--" ? 'rgba(148,163,184,0.7)' : 'rgba(148,163,184,0.25)'
                    }}
                  >
                    {ppTpsValue}
                  </span>
                  <span className="text-[7px] font-mono text-stealth-muted/30 tracking-wider">tok/s</span>
                </div>

                {/* PP progress bar — processed/task.n_tokens from /slots + NewPrompt total */}
                {showPrefillProgress && (
                  <div className="flex items-center gap-1 mt-1 w-full">
                    <div className="flex-1 h-1 rounded-full bg-black/20 overflow-hidden relative">
                      <div
                        className="h-full rounded-full absolute left-0 top-0"
                        style={{
                          width: `${(primaryPrefillProgress ?? 0) * 100}%`,
                          backgroundColor: 'rgba(148,163,184,0.7)',
                        }}
                      />
                    </div>
                    <span className="text-[12px] font-mono text-black flex-shrink-0">
                      {(primaryPrefillProgress * 100).toFixed(0)}%
                    </span>
                  </div>
                )}

                {/* Prompt fill: processed vs task size (from logs + /slots). Hidden outside PP so TG doesn't show stale "274/274". */}
                {isPrefillPhase && (
                  <span className="text-[7px] font-mono text-stealth-muted/40 mt-0.5" title="Prompt tokens processed / estimated task size">
                    {primaryPrefillTokens > 0
                      ? prefillTotal > 0 && primaryPrefillTokens < prefillTotal
                        ? `${primaryPrefillTokens.toLocaleString()} / ${prefillTotal.toLocaleString()} prompt tok`
                        : `${primaryPrefillTokens.toLocaleString()} prompt tok`
                      : "--"}
                  </span>
                )}
              </div>
            </div>
          </div>

          {/* ═══ BENCH WIDGET — compact ══════════════ */}
          <div className="flex-shrink-0 mt-1">
            {fusion.engine_state !== "LOADING" && (
              <BenchWidget port={displayPort} />
            )}
          </div>
        </div>
      )}
    </div>
  );
}