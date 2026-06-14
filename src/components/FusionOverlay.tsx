import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FusionUpdate } from "../lib/types";
import BenchWidget, { type BenchHeroPatch, type BenchSessionMode } from "./BenchWidget";
import FusionBooter from "./FusionBooter";
import FusionShareMenu from "./FusionShareMenu";
import type { FusionShareLaunchConfig } from "../lib/fusionShareCapture";
import SlotCtxBars from "./SlotCtxBars";
import type { GpuInfo } from "../lib/types";
import { useFusionHeroTpsMode } from "../hooks/useFusionHeroTpsMode";
import { useTauriListen } from "../hooks/useTauriListen";

interface FusionOverlayProps {
  alias?: string;
  enginePort?: number;
  fusion: FusionUpdate | null;
  supportsFusion?: boolean;
  /** Stack status when fusion is off (RUNNING, LOADING, ERROR, …). */
  engineStatus?: string;
  slotIdx?: number;
  gpus?: GpuInfo[];
  gpuMask?: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
  modelName?: string;
  modelQuant?: string;
  providerName?: string;
  providerBuildVersion?: string;
  profileLabel?: string;
  cudaVersion?: string;
  launchConfig?: FusionShareLaunchConfig;
  hwTopo?: string;
}

function formatMs(ms: number): string {
  if (ms < 1) return "<1ms";
  if (ms < 1000) return ms < 100 ? `${ms.toFixed(1)}ms` : `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function formatK(n: number): string {
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

interface LastRequestStats {
  genTokensSlots: number;
  prefillMs: string | null;
  decodeTtftMs: string | null;
  elapsedMs: string;
}

function fusionTimingStats(fusion: FusionUpdate): Pick<LastRequestStats, "prefillMs" | "decodeTtftMs"> {
  return {
    prefillMs: fusion.prefillMs != null ? formatMs(fusion.prefillMs) : null,
    decodeTtftMs: fusion.decodeTtftMs != null ? formatMs(fusion.decodeTtftMs) : null,
  };
}

export default function FusionOverlay({
  alias,
  enginePort,
  fusion,
  supportsFusion = true,
  engineStatus,
  slotIdx = -1,
  gpus = [],
  gpuMask = "",
  vramTargetMib,
  modelLayerTotal,
  gpuLoadTargetsMib,
  modelName,
  modelQuant,
  providerName,
  providerBuildVersion,
  profileLabel,
  cudaVersion,
  launchConfig,
  hwTopo,
}: FusionOverlayProps) {
  const displayAlias = alias ?? "ENGINE";
  const displayPort = enginePort ?? 9090;

  // Per-engine state stored in a Map keyed by slotIdx — no remounting needed on switch
  interface EngineStateData {
    frozenStats: LastRequestStats | null;
    liveSnapshot: LastRequestStats;
    wasActive: boolean;
  }
  const engineStates = useRef<Map<number, EngineStateData>>(new Map());
  const [displayFrozen, setDisplayFrozen] = useState<LastRequestStats | null>(null);
  const [isStopping, setIsStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [benchHero, setBenchHero] = useState<{ tg: number | null; pp: number | null }>({
    tg: null,
    pp: null,
  });
  const [benchSessionMode, setBenchSessionMode] = useState<BenchSessionMode>("idle");
  const { mode: heroTpsMode, toggle: toggleHeroTpsMode } = useFusionHeroTpsMode();

  useTauriListen<{ slot: number }>("slot-cleared", ({ slot }) => {
    engineStates.current.delete(slot);
    setBenchHero({ tg: null, pp: null });
    setBenchSessionMode("idle");
    if (fusion?.slotIdx === slot) {
      setDisplayFrozen(null);
      stoppingRef.current = false;
      setIsStopping(false);
    }
  });

  useTauriListen("engines-all-stopped", () => {
    engineStates.current.clear();
    setBenchHero({ tg: null, pp: null });
    setBenchSessionMode("idle");
    setDisplayFrozen(null);
    stoppingRef.current = false;
    setIsStopping(false);
  });

  const handleStopEngine = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    setIsStopping(true);
    try {
      if (slotIdx >= 0) {
        await invoke("stop_engine_slot", { slotIdx });
      } else {
        await invoke("stop_engine", { alias: displayAlias });
      }
    } catch (e) {
      console.error("[FUSION] stop_engine failed:", e);
      stoppingRef.current = false;
      setIsStopping(false);
    }
  }, [displayAlias, slotIdx]);

  const isActive = fusion != null && fusion.phase !== "IDLE";

  useEffect(() => {
    if (!fusion || fusion.slotIdx < 0) return;

    let engState = engineStates.current.get(fusion.slotIdx);
    if (!engState) {
      engState = {
        frozenStats: null,
        liveSnapshot: { genTokensSlots: 0, prefillMs: null, decodeTtftMs: null, elapsedMs: "0ms" },
        wasActive: false,
      };
      engineStates.current.set(fusion.slotIdx, engState);
    }

    const active = fusion.phase !== "IDLE";
    if (active) {
      engState.wasActive = true;
      engState.frozenStats = null;
      engState.liveSnapshot = {
        genTokensSlots: fusion.genTokensPerRequestSlots,
        ...fusionTimingStats(fusion),
        elapsedMs: formatMs(fusion.requestElapsedMs),
      };
      setDisplayFrozen(null);
    } else if (engState.wasActive) {
      engState.wasActive = false;
      engState.frozenStats = { ...engState.liveSnapshot };
      setDisplayFrozen(engState.frozenStats);
    } else {
      setDisplayFrozen(engState.frozenStats);
    }
  }, [
    fusion?.slotIdx,
    fusion?.phase,
    fusion?.genTokensPerRequestSlots,
    fusion?.prefillMs,
    fusion?.decodeTtftMs,
    fusion?.requestElapsedMs,
  ]);

  const showLive = fusion != null && isActive;
  const defaultSnapshot: LastRequestStats = {
    genTokensSlots: 0,
    prefillMs: null,
    decodeTtftMs: null,
    elapsedMs: "0ms",
  };
  const statsToDisplay = showLive && fusion ? {
    genTokensSlots: fusion.genTokensPerRequestSlots,
    ...fusionTimingStats(fusion),
    elapsedMs: formatMs(fusion.requestElapsedMs),
  } as LastRequestStats : (displayFrozen ?? defaultSnapshot);

  const handleBenchHeroPatch = useCallback((patch: BenchHeroPatch) => {
    setBenchHero((prev) => ({
      tg: patch.tg !== undefined ? patch.tg : prev.tg,
      pp: patch.pp !== undefined ? patch.pp : prev.pp,
    }));
  }, []);

  const [isBenchWarmup, setIsBenchWarmup] = useState(false);
  useTauriListen<{ port: number; phase: string }>("bench-tg-progress", (payload) => {
    if (payload.port !== displayPort) return;
    setIsBenchWarmup(payload.phase === "warmup");
  }, [displayPort]);

  if (!supportsFusion) {
    const isLaunching = engineStatus === "LOADING";

    if (isLaunching && slotIdx >= 0) {
      return (
        <div className="relative w-full h-full overflow-hidden">
          <FusionBooter
            slotIdx={slotIdx}
            alias={displayAlias}
            port={displayPort}
            gpus={gpus}
            gpuMask={gpuMask}
            vramTargetMib={vramTargetMib}
            modelLayerTotal={modelLayerTotal}
            gpuLoadTargetsMib={gpuLoadTargetsMib}
          />
        </div>
      );
    }

    const statusLabel = engineStatus === "RUNNING"
      ? "ENGINE RUNNING"
      : engineStatus === "ERROR"
        ? "ENGINE ERROR"
        : engineStatus === "LOADING"
          ? "ENGINE LOADING"
          : "ENGINE ACTIVE";

    return (
      <div className="relative flex flex-col w-full h-full px-2 py-1 gap-2 overflow-hidden">
        <div className="flex items-center flex-shrink-0 gap-2">
          <span className="text-[9px] font-mono text-stealth-muted/50 tracking-widest flex-1 truncate">
            {statusLabel}
          </span>
          <span className="text-[12px] font-mono text-stealth-muted/50 tracking-wider truncate" title={displayAlias}>
            {displayAlias.toUpperCase()}
          </span>
          <span className="text-[10px] font-mono text-stealth-muted/35">:{displayPort}</span>
          <button
            type="button"
            onClick={handleStopEngine}
            disabled={isStopping}
            className={`text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded text-white select-none ${
              isStopping
                ? "bg-red-600/50 cursor-wait animate-pulse"
                : "bg-red-600/80 hover:bg-red-500 active:bg-red-700 cursor-pointer"
            }`}
          >
            {isStopping ? "STOPPING…" : "STOP"}
          </button>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2 px-4 text-center min-h-0">
          <span className="text-[9px] font-mono text-stealth-muted/55 tracking-wider">FUSION MONITORING OFF</span>
          <span className="text-[8px] font-mono text-stealth-muted/40 leading-relaxed max-w-[280px]">
            Live /slots telemetry is not enabled for this provider. Engine stop is still available here.
          </span>
        </div>
      </div>
    );
  }

  if (!fusion) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 w-full h-full px-4 text-center">
        <span className="text-[16px] font-mono text-stealth-muted/40 tracking-widest">{displayAlias}</span>
        <span className="text-[9px] font-mono text-nv-green/70 tracking-wider animate-pulse">
          SYNCING FUSION…
        </span>
        <span className="text-[8px] font-mono text-stealth-muted/40 leading-relaxed">
          Telemetry link lost (remount or idle dedup). Restores within a few seconds.
        </span>
        <span className="text-[8px] font-mono text-stealth-muted/30">PORT {displayPort}</span>
      </div>
    );
  }

  const isLaunching = fusion.engine_state === "LOADING";
  const ctxTotal = fusion.ctxTotal || 0;

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

  const suppressPrefillHero =
    benchSessionMode === "tg" ||
    (benchSessionMode === "both" && benchHero.pp == null);
  const suppressTgHero = benchSessionMode === "pp";
  const ppHeroTps = benchHero.pp;
  const ppHeroDisplay = suppressPrefillHero
    ? "--"
    : ppHeroTps != null
      ? ppHeroTps.toFixed(0)
      : ppTpsValue;
  const ppHeroActive = !suppressPrefillHero && (ppHeroTps != null ? ppHeroTps > 0 : ppTpsValue !== "--");

  const tgTpsLive = clampHeroTps(Math.max(fusion.genTpsInstant ?? 0, fusion.logGenTps ?? 0));
  const tgTpsPick = clampHeroTps(heroTpsMode === "avg" ? fusion.genTps : tgTpsLive);
  const tgTpsValue = tgTpsPick > 0 ? tgTpsPick.toFixed(1) : "--";
  const tgHeroTps = benchHero.tg;
  const tgHeroDisplay = suppressTgHero
    ? "--"
    : tgHeroTps != null
      ? tgHeroTps.toFixed(1)
      : tgTpsValue;
  const tgHeroActive = !suppressTgHero && (tgHeroTps != null ? tgHeroTps > 0 : tgTpsPick > 0);

  const specSlotActive = fusion.slotCtx?.some((s) => s.speculative) ?? false;
  const mtpAcceptPct =
    fusion.specDraftAcceptRate != null && fusion.specDraftAcceptRate > 0
      ? (fusion.specDraftAcceptRate * 100).toFixed(1)
      : null;
  const mtpAcceptTitle =
    fusion.specDraftAcceptedLast != null && fusion.specDraftGeneratedLast != null
      ? `Last: ${fusion.specDraftAcceptedLast}/${fusion.specDraftGeneratedLast} accepted · Session: ${fusion.specDraftAccepted ?? 0}/${fusion.specDraftGenerated ?? 0}`
      : fusion.specDraftGenerated
        ? `Session: ${fusion.specDraftAccepted ?? 0}/${fusion.specDraftGenerated} draft tokens accepted`
        : "MTP draft acceptance (updates when a request completes)";

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
    !suppressPrefillHero && isPrefillPhase && (prefillTotal > 0 || primaryPrefillProgress > 0);

  return (
    <div className="relative w-full h-full overflow-hidden">
      {isLaunching && slotIdx >= 0 ? (
        <div
          key="launching"
          className="absolute inset-0 w-full h-full"
          style={{ animation: "fadeIn 0.2s ease" }}
        >
          <FusionBooter
            slotIdx={slotIdx}
            alias={displayAlias}
            port={displayPort}
            gpus={gpus}
            gpuMask={gpuMask}
            vramTargetMib={vramTargetMib}
            modelLayerTotal={modelLayerTotal}
            gpuLoadTargetsMib={gpuLoadTargetsMib}
          />
        </div>
      ) : isLaunching ? (
        <div
          key="launching-fallback"
          className="flex flex-col items-center justify-center gap-2 w-full h-full absolute inset-0"
        >
          <span className="text-[10px] font-mono text-nv-green tracking-widest animate-pulse">FUSION BOOT</span>
          <span className="text-[8px] font-mono text-stealth-muted/40">{displayAlias} : {displayPort}</span>
        </div>
      ) : (
        <div
          key="dashboard"
          className="flex flex-col w-full h-full px-2 py-1 gap-0 overflow-hidden absolute inset-0"
          style={{ animation: 'fadeIn 0.2s ease' }}
        >
          {/* ═══ HEADER — alias + phase indicator + controls ═══════ */}
          <div className="flex items-center flex-shrink-0 mb-1 gap-2">
            <div className="flex items-center flex-1 min-w-0 justify-start gap-1.5">
              <FusionShareMenu
                alias={displayAlias}
                providerName={providerName}
                providerBuildVersion={providerBuildVersion}
                modelName={modelName}
                modelQuant={modelQuant}
                profileLabel={profileLabel}
                cudaVersion={cudaVersion}
                launchConfig={launchConfig}
                hwTopo={hwTopo}
              />
              <span className="text-[9px] font-mono text-stealth-muted/40 tracking-widest">
                CONTEXT SLOTS
              </span>
            </div>
            <div className="flex items-center justify-center gap-2 flex-shrink-0">
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
            <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">
              <span className="text-[14px] font-mono text-stealth-muted/50 tracking-wider truncate" title={displayAlias}>
                {displayAlias.toUpperCase()}
              </span>
              <span className="text-[12px] font-mono text-stealth-muted/30">:{displayPort}</span>
              <button
                onClick={handleStopEngine}
                disabled={isStopping}
                className={`text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded text-white select-none ${
                  isStopping
                    ? "bg-red-600/50 cursor-wait animate-pulse"
                    : "bg-red-600/80 hover:bg-red-500 active:bg-red-700 cursor-pointer"
                }`}
              >
                {isStopping ? "STOPPING…" : "STOP"}
              </button>
            </div>
          </div>

          {/* ═══ MAIN BODY — bars | TG hero | PREFILL ═══ */}
          <div className="flex gap-2 flex-1 min-h-0" style={{ alignItems: 'stretch' }}>

            {/* ── LEFT: Slot CTX bars — fixed 4-slot baseline width (bars scale inside) ─── */}
            <div className="flex-shrink-0" style={{ width: "18%", minWidth: 110 }}>
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
                 !suppressTgHero && fusion.phase === "TG"
                   ? "border-green-500/30 bg-black/8"
                   : "border-stone-500/10 bg-black/4"
               }`} style={{ flex: '1 1 60%' }}>
                 <div className="flex items-center justify-between w-full mb-0.5 gap-1">
                   <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">GENERATION</span>
                   <button
                     type="button"
                     onClick={toggleHeroTpsMode}
                     title={heroTpsMode === "live" ? "Hero TPS: live (per chunk). Click for session average." : "Hero TPS: session average (bench). Click for live."}
                     className="text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border border-stealth-border/50 text-stealth-muted/70 hover:text-white hover:border-stealth-muted/60 cursor-pointer select-none flex-shrink-0"
                   >
                     {heroTpsMode === "live" ? "LIVE" : "AVG"}
                   </button>
                 </div>

                 {/* Big TG number */}
                 <div className="flex items-baseline gap-1">
                   <span
                     className="font-mono font-bold tracking-tight leading-none"
                     style={{
                       fontSize: 'clamp(2rem, 6vh, 3.5rem)',
                       color: tgHeroActive ? '#22c55e' : 'rgba(148,163,184,0.25)'
                     }}
                   >
                     {tgHeroDisplay}
                   </span>
                   <span className="text-[7px] font-mono text-stealth-muted/30 tracking-wider">tok/s</span>
                 </div>

                {/* Per-request micro-stats — PP prefill vs +1st decode after prefill */}
                 <div className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-1.5">
                   <span className={`text-[8px] font-mono ${showLive ? "fusion-readout-emphasis" : "text-stealth-muted/35"}`}>
                     {statsToDisplay.genTokensSlots > 0 ? statsToDisplay.genTokensSlots + " tok" : "--"}
                   </span>
                   <span className={`text-[6px] ${showLive ? "fusion-readout-divider" : "text-stealth-muted/15"}`}>│</span>
                   <span
                     className={`text-[8px] font-mono ${showLive ? "fusion-readout-emphasis" : "text-stealth-muted/35"}`}
                     title="Prompt prefill duration"
                   >
                     PP {statsToDisplay.prefillMs ?? "--"}
                   </span>
                   <span className={`text-[6px] ${showLive ? "fusion-readout-divider" : "text-stealth-muted/15"}`}>│</span>
                   <span
                     className={`text-[8px] font-mono ${showLive ? "fusion-readout-emphasis" : "text-stealth-muted/35"}`}
                     title="First output token after prefill"
                   >
                     +1st {statsToDisplay.decodeTtftMs ?? "--"}
                   </span>
                   <span className={`text-[6px] ${showLive ? "fusion-readout-divider" : "text-stealth-muted/15"}`}>│</span>
                   <span className={`text-[8px] font-mono ${showLive ? "fusion-readout-emphasis" : "text-stealth-muted/35"}`}>
                     ELAPSED {statsToDisplay.elapsedMs}
                   </span>
                   {(specSlotActive || mtpAcceptPct != null) && mtpAcceptPct != null && (
                     <>
                       <span className={`text-[6px] ${showLive ? "fusion-readout-divider" : "text-stealth-muted/15"}`}>│</span>
                       <span
                         className={`text-[8px] font-mono ${showLive ? "text-amber-300/90" : "text-stealth-muted/45"}`}
                         title={mtpAcceptTitle}
                       >
                         MTP {mtpAcceptPct}%
                       </span>
                     </>
                   )}
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
                !suppressPrefillHero && isPrefillPhase
                  ? "border-stealth-muted/30 bg-black/8"
                  : "border-stone-500/10 bg-black/4"
              }`} style={{ flex: '1 1 40%' }}>
                {/* Phase label */}
                <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider mb-0.5">PREFILL</span>

                {/* PP TPS number — primary value from log parser, fallback to /metrics */}
                <div className="flex items-baseline gap-1">
                  <span
                    className={`fusion-prefill-hero-value font-mono font-bold tracking-tight leading-none ${
                      ppHeroActive
                        ? "fusion-prefill-hero-value--active"
                        : "fusion-prefill-hero-value--idle"
                    }`}
                    style={{ fontSize: "clamp(2rem, 6vh, 3.5rem)" }}
                  >
                    {ppHeroDisplay}
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
                    <span className="text-[12px] font-mono fusion-readout-emphasis flex-shrink-0">
                      {(primaryPrefillProgress * 100).toFixed(0)}%
                    </span>
                  </div>
                )}

                {/* Prompt fill: processed vs task size (from logs + /slots). Hidden outside PP so TG doesn't show stale "274/274". */}
                {!suppressPrefillHero && isPrefillPhase && (
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

          {/* ═══ BENCH WIDGET — fixed panel height (see BenchWidget) ═══ */}
          <div className="flex-shrink-0 mt-1">
            {fusion.engine_state !== "LOADING" && (
              <BenchWidget
                port={displayPort}
                onHeroPatch={handleBenchHeroPatch}
                onBenchSessionChange={setBenchSessionMode}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}