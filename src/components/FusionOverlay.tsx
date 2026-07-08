import { useState, useEffect, useRef, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { FusionUpdate } from "../lib/types";
import { FUSION_HERO_ROW_PX } from "../lib/benchPanelLayout";
import {
  getBenchPortState,
  notifyBenchPortStore,
  subscribeBenchPortStore,
} from "../lib/benchPortStore";
import BenchWidget, { type BenchHeroPatch, type BenchSessionMode } from "./BenchWidget";
import FusionBooter from "./FusionBooter";
import type { FusionShareLaunchConfig } from "../lib/fusionShareCapture";
import FusionBenchTrayLatch from "./FusionBenchTrayLatch";
import SlotCtxBars, { formatTokenCount } from "./SlotCtxBars";
import type { GpuInfo } from "../lib/types";
import { useFusionBenchTray } from "../hooks/useFusionBenchTray";
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

/** Matches backend inter-request hold — micro-stats must not flicker on brief /slots idle. */
const MICRO_STATS_IDLE_HOLD_MS = 1500;

interface MicroStatsLatch {
  genTokens: number;
  prefillMs: string | null;
  decodeTtftMs: string | null;
  elapsedMs: string;
  sessionOpen: boolean;
  lastBusyAt: number;
}

function freshMicroLatch(): MicroStatsLatch {
  return {
    genTokens: 0,
    prefillMs: null,
    decodeTtftMs: null,
    elapsedMs: "0ms",
    sessionOpen: false,
    lastBusyAt: 0,
  };
}

function resetMicroLatch(latch: MicroStatsLatch) {
  Object.assign(latch, freshMicroLatch());
}

function fusionRequestInFlight(fusion: FusionUpdate): boolean {
  if (fusion.requestClosed === true) return false;
  const tokens = fusion.genTokensPerRequestSlots ?? 0;
  return (
    fusion.phase !== "IDLE"
    || fusion.engine_state === "ACTIVE"
    || tokens > 0
    || fusion.logPhase === "TG"
    || fusion.logPhase === "PP"
    || (fusion.busySlotCount ?? 0) > 0
  );
}

function fusionNewPromptReset(fusion: FusionUpdate, latch: MicroStatsLatch): boolean {
  if (fusion.phaseResetSource === "prompt") return true;
  const tokens = fusion.genTokensPerRequestSlots ?? 0;
  return (
    latch.genTokens > 0
    && tokens === 0
    && fusion.phase === "PP"
    && (fusion.prefillProgress ?? 0) < 0.15
  );
}

function updateMicroLatch(latch: MicroStatsLatch, fusion: FusionUpdate) {
  const now = Date.now();
  if (fusionNewPromptReset(fusion, latch)) {
    resetMicroLatch(latch);
  }
  const timing = fusionTimingStats(fusion);
  const tokens = fusion.genTokensPerRequestSlots ?? 0;
  if (fusionRequestInFlight(fusion)) {
    latch.sessionOpen = true;
    latch.lastBusyAt = now;
    if (tokens >= latch.genTokens) latch.genTokens = tokens;
    if (timing.prefillMs != null) latch.prefillMs = timing.prefillMs;
    if (timing.decodeTtftMs != null) latch.decodeTtftMs = timing.decodeTtftMs;
    latch.elapsedMs = formatMs(fusion.requestElapsedMs);
    return;
  }
  if (latch.sessionOpen && now - latch.lastBusyAt > MICRO_STATS_IDLE_HOLD_MS) {
    latch.sessionOpen = false;
  }
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
    microLatch: MicroStatsLatch;
  }
  const engineStates = useRef<Map<number, EngineStateData>>(new Map());
  const [, setMicroLatchTick] = useState(0);
  const [isStopping, setIsStopping] = useState(false);
  const stoppingRef = useRef(false);
  const [benchHero, setBenchHero] = useState<{ tg: number | null; pp: number | null }>({
    tg: null,
    pp: null,
  });
  const [benchSessionMode, setBenchSessionMode] = useState<BenchSessionMode>("idle");
  const [, setBenchPortTick] = useState(0);
  useEffect(() => subscribeBenchPortStore(() => setBenchPortTick((n) => n + 1)), []);
  const benchPort = getBenchPortState(displayPort);
  const { mode: heroTpsMode, toggle: toggleHeroTpsMode } = useFusionHeroTpsMode();
  const { open: benchTrayOpen, toggle: toggleBenchTray } = useFusionBenchTray();

  const handleCloseBenchResults = useCallback(() => {
    const ps = getBenchPortState(displayPort);
    ps.showResults = false;
    ps.tgResult = null;
    ps.ppResult = null;
    setBenchSessionMode("idle");
    setBenchHero({ tg: null, pp: null });
    notifyBenchPortStore();
  }, [displayPort]);

  useTauriListen<{ slot: number }>("slot-cleared", ({ slot }) => {
    engineStates.current.delete(slot);
    setBenchHero({ tg: null, pp: null });
    setBenchSessionMode("idle");
    if (fusion?.slotIdx === slot) {
      stoppingRef.current = false;
      setIsStopping(false);
    }
  });

  useTauriListen("engines-all-stopped", () => {
    engineStates.current.clear();
    setBenchHero({ tg: null, pp: null });
    setBenchSessionMode("idle");
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

  const isActive =
    fusion != null && fusion.phase !== "IDLE" && fusion.requestClosed !== true;

  useEffect(() => {
    if (!fusion || fusion.slotIdx < 0) return;

    let engState = engineStates.current.get(fusion.slotIdx);
    if (!engState) {
      engState = { microLatch: freshMicroLatch() };
      engineStates.current.set(fusion.slotIdx, engState);
    }

    const before = { ...engState.microLatch };
    updateMicroLatch(engState.microLatch, fusion);
    const after = engState.microLatch;
    if (
      before.genTokens !== after.genTokens
      || before.prefillMs !== after.prefillMs
      || before.decodeTtftMs !== after.decodeTtftMs
      || before.elapsedMs !== after.elapsedMs
      || before.sessionOpen !== after.sessionOpen
    ) {
      setMicroLatchTick((t) => t + 1);
    }
  }, [
    fusion?.slotIdx,
    fusion?.phase,
    fusion?.engine_state,
    fusion?.genTokensPerRequestSlots,
    fusion?.prefillMs,
    fusion?.decodeTtftMs,
    fusion?.requestElapsedMs,
    fusion?.requestClosed,
    fusion?.logPhase,
    fusion?.busySlotCount,
    fusion?.prefillProgress,
    fusion?.phaseResetSource,
  ]);

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
  const ctxPerSlot = fusion.ctxPerSlot || 0;

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

  // "both" sequence: hide PP hero only during TG; show live PP bar once PP bench starts.
  const suppressPrefillHero =
    benchSessionMode === "tg" ||
    (benchSessionMode === "both" && benchHero.pp == null && !benchPort.ppRunning);
  const suppressTgHero = benchSessionMode === "pp";
  const ppHeroTps = benchHero.pp;
  const ppHeroDisplay = suppressPrefillHero
    ? "--"
    : ppHeroTps != null
      ? ppHeroTps.toFixed(0)
      : ppTpsValue;
  const ppHeroActive = !suppressPrefillHero && (ppHeroTps != null ? ppHeroTps > 0 : ppTpsValue !== "--");

  const isParallelLane = fusion.meterLane === "parallel";
  const tgTpsLive = clampHeroTps(
    (fusion.genTpsInstant ?? 0) > 0
      ? (fusion.genTpsInstant ?? 0)
      : (fusion.logGenTps ?? 0),
  );
  const tgTpsAvg = clampHeroTps(
    isParallelLane
      ? (fusion.genTpsSession ?? fusion.genTps ?? 0)
      : ((fusion.genTpsSession ?? 0) > 0 ? (fusion.genTpsSession ?? 0) : (fusion.genTps ?? 0)),
  );
  const tgTpsPick = clampHeroTps(heroTpsMode === "avg" ? tgTpsAvg : tgTpsLive);
  const tgTpsValue = tgTpsPick > 0 ? tgTpsPick.toFixed(1) : "--";
  const tgHeroTps = benchHero.tg;
  const tgHeroDisplay = suppressTgHero
    ? "--"
    : tgHeroTps != null
      ? tgHeroTps.toFixed(1)
      : tgTpsValue;
  const tgHeroActive = !suppressTgHero && (tgHeroTps != null ? tgHeroTps > 0 : tgTpsPick > 0);

  const microLatch =
    engineStates.current.get(fusion.slotIdx)?.microLatch ?? freshMicroLatch();
  const microReadoutLive = microLatch.sessionOpen || isActive;
  const microTokenText = microLatch.genTokens > 0 ? `${microLatch.genTokens} tok` : "--";

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
              <span className="text-[9px] font-mono text-stealth-muted/40 tracking-widest">
                CONTEXT SLOTS
              </span>
              {ctxTotal > 0 && (
                <>
                  <span className="text-[8px] font-mono text-stealth-muted/25 select-none">│</span>
                  <span
                    className="text-[8px] font-mono text-stealth-muted/50 tracking-wider"
                    title={
                      fusion.parallel > 1 && ctxPerSlot > 0
                        ? `${formatTokenCount(ctxTotal)} total · ${formatTokenCount(ctxPerSlot)} per slot`
                        : `${formatTokenCount(ctxTotal)} total context`
                    }
                  >
                    {formatTokenCount(ctxTotal)} total
                  </span>
                </>
              )}
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

          {/* ═══ MAIN BODY — fixed-height hero row (PP progress slot always reserved) ═══ */}
          <div
            className="flex gap-2 flex-shrink-0 items-stretch"
            style={{ height: FUSION_HERO_ROW_PX, minHeight: FUSION_HERO_ROW_PX }}
          >

            {/* ── LEFT: Slot CTX bars — up to 8 individual bars; compact ×N above that ─── */}
            <div className="flex-shrink-0 self-stretch min-h-0 min-w-0" style={{ width: "24%", minWidth: 132 }}>
              <SlotCtxBars
                slotCtx={fusion.slotCtx}
                ctxTotal={ctxTotal}
                ctxPerSlot={ctxPerSlot}
                parallel={fusion.parallel}
              />
            </div>

            {/* ── RIGHT: TG hero + PREFILL side by side ─── */}
            <div className="flex gap-3 flex-1 min-w-0">
              {/* ── LEFT: TG TPS HERO (dominant) ─── */}
              <div className={`flex flex-col items-center justify-start px-2 py-1.5 rounded-sm border transition-colors relative h-full min-h-0 ${
                 !suppressTgHero && fusion.phase === "TG"
                   ? "border-green-500/30 bg-black/8"
                   : "border-stone-500/10 bg-black/4"
               }`} style={{ flex: "1 1 45%", minWidth: 0 }}>
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

                {/* Per-request micro-stats — latched + fixed-width cells (no jitter on multi-slot idle gaps) */}
                 <div className="flex items-center justify-center w-full min-w-0 gap-x-1 mt-1.5 overflow-hidden flex-nowrap fusion-micro-readout">
                   <span
                     className={`fusion-micro-stat-cell fusion-micro-tokens text-[7px] font-mono ${microReadoutLive ? "fusion-readout-emphasis" : "fusion-readout-idle"}`}
                   >
                     {microTokenText}
                   </span>
                   <span className={`text-[6px] flex-shrink-0 ${microReadoutLive ? "fusion-readout-divider" : "fusion-readout-divider-idle"}`}>│</span>
                   <span
                     className={`fusion-micro-stat-cell fusion-micro-pp text-[7px] font-mono ${microReadoutLive ? "fusion-readout-emphasis" : "fusion-readout-idle"}`}
                     title="Prompt prefill duration"
                   >
                     PP {microLatch.prefillMs ?? "--"}
                   </span>
                   <span className={`text-[6px] flex-shrink-0 ${microReadoutLive ? "fusion-readout-divider" : "fusion-readout-divider-idle"}`}>│</span>
                   <span
                     className={`fusion-micro-stat-cell fusion-micro-decode text-[7px] font-mono ${microReadoutLive ? "fusion-readout-emphasis" : "fusion-readout-idle"}`}
                     title="First output token after prefill"
                   >
                     +1st {microLatch.decodeTtftMs ?? "--"}
                   </span>
                   <span className={`text-[6px] flex-shrink-0 ${microReadoutLive ? "fusion-readout-divider" : "fusion-readout-divider-idle"}`}>│</span>
                   <span className={`fusion-micro-stat-cell fusion-micro-elapsed text-[7px] font-mono ${microReadoutLive ? "fusion-readout-emphasis" : "fusion-readout-idle"}`}>
                     ELAPSED {microLatch.elapsedMs}
                   </span>
                   {(specSlotActive || mtpAcceptPct != null) && mtpAcceptPct != null && (
                     <>
                       <span className={`text-[6px] flex-shrink-0 ${microReadoutLive ? "fusion-readout-divider" : "fusion-readout-divider-idle"}`}>│</span>
                       <span
                         className={`text-[7px] font-mono flex-shrink-0 whitespace-nowrap ${microReadoutLive ? "text-amber-300/90" : "fusion-readout-idle"}`}
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
              <div className={`flex flex-col items-center justify-start px-2 py-1.5 rounded-sm border transition-colors h-full min-h-0 ${
                !suppressPrefillHero && isPrefillPhase
                  ? "border-stealth-muted/30 bg-black/8"
                  : "border-stone-500/10 bg-black/4"
              }`} style={{ flex: "1 1 35%", minWidth: 0 }}>
                <div className="flex items-center justify-between w-full mb-0.5 gap-1">
                  <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider">PREFILL</span>
                </div>

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

                {/* PP progress + prompt row — fixed height so hero row never shifts */}
                <div className="flex flex-col justify-end flex-1 w-full min-h-0 mt-auto">
                  <div
                    className="flex items-center gap-1 w-full h-[18px] flex-shrink-0"
                    style={{ visibility: showPrefillProgress ? "visible" : "hidden" }}
                    aria-hidden={!showPrefillProgress}
                  >
                    <div className="flex-1 h-1 rounded-full bg-black/20 overflow-hidden relative">
                      <div
                        className="h-full rounded-full absolute left-0 top-0"
                        style={{
                          width: `${(primaryPrefillProgress ?? 0) * 100}%`,
                          backgroundColor: "rgba(148,163,184,0.7)",
                        }}
                      />
                    </div>
                    <span className="text-[12px] font-mono fusion-readout-emphasis flex-shrink-0">
                      {(primaryPrefillProgress * 100).toFixed(0)}%
                    </span>
                  </div>
                  <span
                    className="text-[7px] font-mono text-stealth-muted/40 h-[14px] leading-[14px] flex-shrink-0"
                    title="Prompt tokens processed / estimated task size"
                    style={{
                      visibility:
                        !suppressPrefillHero && isPrefillPhase && primaryPrefillTokens > 0
                          ? "visible"
                          : "hidden",
                    }}
                    aria-hidden={suppressPrefillHero || !isPrefillPhase || primaryPrefillTokens <= 0}
                  >
                    {primaryPrefillTokens > 0
                      ? prefillTotal > 0 && primaryPrefillTokens < prefillTotal
                        ? `${primaryPrefillTokens.toLocaleString()} / ${prefillTotal.toLocaleString()} prompt tok`
                        : `${primaryPrefillTokens.toLocaleString()} prompt tok`
                      : "--"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {!benchTrayOpen && <div className="flex-1 min-h-0" aria-hidden />}

          {/* ═══ BENCHMARK TRAY — stowable bench + results (persisted) ═══ */}
          {fusion.engine_state !== "LOADING" && (
            <div className="flex-shrink-0 flex flex-col">
              <FusionBenchTrayLatch open={benchTrayOpen} onToggle={toggleBenchTray} />
              {benchTrayOpen && (
                <BenchWidget
                  port={displayPort}
                  footerDocked
                  onHeroPatch={handleBenchHeroPatch}
                  onBenchSessionChange={setBenchSessionMode}
                  onCloseResults={handleCloseBenchResults}
                  shareMeta={{
                    alias: displayAlias,
                    providerName,
                    providerBuildVersion,
                    modelName,
                    modelQuant,
                    profileLabel,
                    cudaVersion,
                    launchConfig,
                    hwTopo,
                    shareGpus: gpus,
                    shareGpuMask: gpuMask,
                    shareSplitMode: launchConfig?.splitMode,
                    tgTps:
                      benchHero.tg ??
                      (tgTpsPick > 0 ? tgTpsPick : null),
                  }}
                  benchHw={{
                    gpus,
                    gpuMask,
                    splitMode: launchConfig?.splitMode,
                  }}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}