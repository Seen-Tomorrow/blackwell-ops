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
import SlotCtxBars, { formatTokenCount, fusionSlotColumnLayout } from "./SlotCtxBars";
import FusionHeroSparkline from "./FusionHeroSparkline";
import FusionMicroReadout from "./FusionMicroReadout";
import type { GpuInfo } from "../lib/types";
import { useFusionBenchTray } from "../hooks/useFusionBenchTray";
import { useFusionHeroTpsMode } from "../hooks/useFusionHeroTpsMode";
import { useTauriListen } from "../hooks/useTauriListen";
import {
  loadFusionLogVerbosity,
  saveFusionLogVerbosity,
  type FusionLogVerbosity,
} from "../lib/storage";

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
  /** Dual secondary pane — no bench tray (primary owns tray height). */
  hideBenchTray?: boolean;

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
  /** Last seen requestElapsedMs — detect rewound clocks on consecutive benches. */
  lastElapsedRaw: number;
  /** Last applied fusion.meterSeq — edge-triggered wipe on NewPrompt / bench reset. */
  lastMeterSeq: number;
}

function freshMicroLatch(): MicroStatsLatch {
  return {
    genTokens: 0,
    prefillMs: null,
    decodeTtftMs: null,
    elapsedMs: "0ms",
    sessionOpen: false,
    lastBusyAt: 0,
    lastElapsedRaw: 0,
    lastMeterSeq: 0,
  };
}

function resetMicroLatch(latch: MicroStatsLatch, keepMeterSeq?: number) {
  const seq = keepMeterSeq ?? latch.lastMeterSeq;
  Object.assign(latch, freshMicroLatch());
  latch.lastMeterSeq = seq;
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

/** True when backend started a new request / bench phase — wipe latched tok / PP / +1st. */
function fusionNewPromptReset(fusion: FusionUpdate, latch: MicroStatsLatch): boolean {
  const seq = fusion.meterSeq ?? 0;
  if (seq > 0 && seq !== latch.lastMeterSeq) {
    return true;
  }
  if (fusion.phaseResetSource === "prompt" || fusion.phaseResetSource === "regression") {
    return true;
  }
  const elapsed = fusion.requestElapsedMs ?? 0;
  // Consecutive bench: backend restarts clock → elapsed jumps down while we still show old stats.
  if (
    latch.lastElapsedRaw > 800
    && elapsed + 100 < latch.lastElapsedRaw
    && (latch.genTokens > 0 || latch.prefillMs != null || latch.decodeTtftMs != null)
  ) {
    return true;
  }
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
  const seq = fusion.meterSeq ?? 0;
  if (fusionNewPromptReset(fusion, latch)) {
    resetMicroLatch(latch, seq > 0 ? seq : latch.lastMeterSeq);
  } else if (seq > 0) {
    latch.lastMeterSeq = seq;
  }
  const timing = fusionTimingStats(fusion);
  const tokens = fusion.genTokensPerRequestSlots ?? 0;
  const elapsed = fusion.requestElapsedMs ?? 0;
  if (fusionRequestInFlight(fusion)) {
    latch.sessionOpen = true;
    latch.lastBusyAt = now;
    // Follow token count both ways after a reset (never only ratchet up forever).
    if (tokens >= latch.genTokens || latch.genTokens === 0 || fusion.phase === "PP") {
      latch.genTokens = tokens;
    } else if (tokens > 0) {
      latch.genTokens = Math.max(latch.genTokens, tokens);
    }
    // Early request: clear stale timings until backend reports new values.
    if (elapsed < 400 && timing.prefillMs == null) latch.prefillMs = null;
    if (elapsed < 400 && timing.decodeTtftMs == null) latch.decodeTtftMs = null;
    if (timing.prefillMs != null) latch.prefillMs = timing.prefillMs;
    if (timing.decodeTtftMs != null) latch.decodeTtftMs = timing.decodeTtftMs;
    latch.elapsedMs = formatMs(elapsed);
    latch.lastElapsedRaw = elapsed;
    return;
  }
  latch.lastElapsedRaw = elapsed;
  if (latch.sessionOpen && now - latch.lastBusyAt > MICRO_STATS_IDLE_HOLD_MS) {
    // Engine fully idle past the hold — clear the latched per-request readout
    // (tok / PP / +1st) so the small print deterministically shows `--` instead of
    // non-deterministically keeping stale values from the last bench/request.
    latch.sessionOpen = false;
    latch.genTokens = 0;
    latch.prefillMs = null;
    latch.decodeTtftMs = null;
    latch.elapsedMs = "0ms";
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
  hideBenchTray = false,
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
  const { mode: heroTpsMode, setMode: setHeroTpsMode } = useFusionHeroTpsMode();
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
    fusion?.meterSeq,
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

  // ── Quiet-mode toggle (silent models like DS4 emit no stderr PP/TG logs) ──
  // Persisted per model so it re-applies on the next launch of the same model.
  const quietKey = `fusion.quiet.${(modelName || displayAlias).trim().toLowerCase()}`;
  const [quietMode, setQuietMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem(quietKey) === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(quietKey, quietMode ? "1" : "0");
    } catch {
      /* ignore */
    }
    // Push the runtime flip to the backend so the live brain switches between
    // log-belt (master/tom) and /slots-derived (quiet) PP + multi-slot TG math.
    invoke("set_fusion_quiet_mode", { port: displayPort, quiet: quietMode }).catch(() => {});
  }, [quietMode, quietKey, displayPort]);

  // ── Engine `-lv` for *next* launch (CLI; cannot change a running process) ──
  const [logVerbosity, setLogVerbosity] = useState<FusionLogVerbosity>(() => loadFusionLogVerbosity());
  useEffect(() => {
    saveFusionLogVerbosity(logVerbosity);
  }, [logVerbosity]);
  const toggleLogVerbosity = useCallback(() => {
    setLogVerbosity((v) => (v === 3 ? 4 : 3));
  }, []);

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
  const clampHeroTps = (n: number) => (n > 0 && n < MAX_HERO_TPS ? n : 0);

  const ppTpsAvg = clampHeroTps(fusion.prefillTpsSession ?? 0);
  const ppTpsLive = clampHeroTps(Math.max(
    fusion.prefillTpsInstant ?? 0,
    fusion.logPrefillTps ?? 0,
  ));
  // Default hero mode is AVG, but AVG is 0 until a long wall / print_timing.
  // Show the live /slots rate until AVG exists; print_timing then replaces it.
  const ppTpsPick = heroTpsMode === "avg" && ppTpsAvg > 0 ? ppTpsAvg : ppTpsLive;
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
  // Prefer pinned genTps after request end (frozen) — genTpsSession can still spike briefly.
  const tgTpsAvgRaw = fusion.requestClosed
    ? (fusion.genTps ?? fusion.genTpsSession ?? 0)
    : isParallelLane
      ? (fusion.genTpsSession ?? fusion.genTps ?? 0)
      : ((fusion.genTpsSession ?? 0) > 0 ? (fusion.genTpsSession ?? 0) : (fusion.genTps ?? 0));
  const tgTpsAvg = clampHeroTps(tgTpsAvgRaw);
  const tgTpsPick = clampHeroTps(heroTpsMode === "avg" ? tgTpsAvg : tgTpsLive);
  const tgTpsValue = tgTpsPick > 0 ? tgTpsPick.toFixed(1) : "--";
  const tgHeroTps = benchHero.tg;
  const tgHeroDisplay = suppressTgHero
    ? "--"
    : tgHeroTps != null
      ? tgHeroTps.toFixed(1)
      : tgTpsValue;
  const tgHeroActive = !suppressTgHero && (tgHeroTps != null ? tgHeroTps > 0 : tgTpsPick > 0);

  // Parallel “per agent” meter — system tok/s ÷ concurrent slots (LIVE vs AVG follows hero toggle).
  const concurrentSlots = Math.max(
    fusion.concurrentSlots ?? 0,
    fusion.busySlotCount ?? 0,
    isParallelLane ? 2 : 0,
  );
  const showPerSlotMeter =
    !suppressTgHero
    && concurrentSlots > 1
    && (isParallelLane || (fusion.busySlotCount ?? 0) > 1 || (fusion.concurrentSlots ?? 0) > 1);
  const perSlotFromFusion = clampHeroTps(
    heroTpsMode === "live"
      ? (fusion.genTpsPerSlotInstant ?? fusion.genTpsPerSlot ?? 0)
      : (fusion.genTpsPerSlot ?? fusion.genTpsPerSlotInstant ?? 0),
  );
  // If hero is bench-patched, derive per-slot from that system number.
  const perSlotTps =
    tgHeroTps != null && concurrentSlots > 1
      ? clampHeroTps(tgHeroTps / concurrentSlots)
      : perSlotFromFusion;
  const perSlotLabel =
    showPerSlotMeter && perSlotTps > 0
      ? perSlotTps >= 100
        ? perSlotTps.toFixed(0)
        : perSlotTps.toFixed(1)
      : null;

  const microLatch =
    engineStates.current.get(fusion.slotIdx)?.microLatch ?? freshMicroLatch();
  const microReadoutLive = microLatch.sessionOpen || isActive;
  const microTokenText = microLatch.genTokens > 0 ? `${microLatch.genTokens} tok` : "--";

  const specSlotActive = fusion.slotCtx?.some((s) => s.speculative) ?? false;
  const mtpAcceptPct =
    fusion.specDraftAcceptRate != null && fusion.specDraftAcceptRate > 0
      ? (fusion.specDraftAcceptRate * 100).toFixed(1)
      : null;
  // Draft family suffix — from `common_specu` log line; MTP is the fallback when only
  // the `print_timing draft acceptance` rate is seen (baked-in nextn emits no spec line).
  const specModeLabel = (fusion.specMode ?? "mtp").toUpperCase();
  const mtpAcceptLabel = `ACC ${specModeLabel}`;
  const mtpAcceptTitle =
    fusion.specDraftAcceptedLast != null && fusion.specDraftGeneratedLast != null
      ? `Last: ${fusion.specDraftAcceptedLast}/${fusion.specDraftGeneratedLast} accepted · Session: ${fusion.specDraftAccepted ?? 0}/${fusion.specDraftGenerated ?? 0}`
      : fusion.specDraftGenerated
        ? `Session: ${fusion.specDraftAccepted ?? 0}/${fusion.specDraftGenerated} draft tokens accepted`
        : `${specModeLabel} draft acceptance (updates when a request completes)`;

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
  const slotCol = fusionSlotColumnLayout(fusion.parallel);

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
          className="fusion-dashboard flex flex-col w-full h-full px-2 py-1 gap-0 overflow-hidden absolute inset-0"
          style={{ animation: "fadeIn 0.2s ease" }}
        >
          {/* ═══ IDENTITY RAIL ═══════════════════════════════════════════ */}
          <div className="fusion-identity-rail flex items-center flex-shrink-0 mb-1 gap-2">
            <div className="flex items-center flex-1 min-w-0 justify-start gap-1.5">
              <span className="fusion-identity-rail__label">CONTEXT</span>
              {ctxTotal > 0 && (
                <>
                  <span className="fusion-identity-rail__rule" aria-hidden>
                    │
                  </span>
                  <span
                    className="fusion-identity-rail__meta"
                    title={
                      fusion.parallel > 1 && ctxPerSlot > 0
                        ? `${formatTokenCount(ctxTotal)} total · ${formatTokenCount(ctxPerSlot)} per slot`
                        : `${formatTokenCount(ctxTotal)} total context`
                    }
                  >
                    {formatTokenCount(ctxTotal)}
                    {fusion.parallel > 1 ? ` · ×${fusion.parallel}` : ""}
                  </span>
                </>
              )}
            </div>
            <div className="flex items-center gap-1.5 flex-1 min-w-0 justify-end">
              <span className="fusion-identity-rail__alias truncate" title={displayAlias}>
                {displayAlias.toUpperCase()}
              </span>
              <span className="fusion-identity-rail__port">:{displayPort}</span>
              <button
                type="button"
                onClick={() => setQuietMode((q) => !q)}
                title={
                  quietMode
                    ? "FULL mode - fully realtime GENERATION AND PREFILL data"
                    : "FALLBACK mode for quiet models — not fully supported yet"
                }
                className={`fusion-ops-chip ${quietMode ? "fusion-ops-chip--quiet" : ""}`}
              >
                {quietMode ? "FALLBACK" : "FULL"}
              </button>
              <button
                type="button"
                onClick={toggleLogVerbosity}
                title={
                  logVerbosity === 3
                    ? "Engine -lv 3 (default): print_timing / draft / eval belt, less boot spam. Applies on NEXT launch. Click for -lv 4 (full metadata belt)."
                    : "Engine -lv 4: full model_loader / slot chatter. Applies on NEXT launch. Click for -lv 3 (timing belt only)."
                }
                className={`fusion-ops-chip ${logVerbosity === 4 ? "fusion-ops-chip--lv" : ""}`}
              >
                LV{logVerbosity}
              </button>
              <button
                type="button"
                onClick={handleStopEngine}
                disabled={isStopping}
                className={`fusion-ops-chip fusion-ops-chip--stop ${isStopping ? "is-stopping" : ""}`}
              >
                {isStopping ? "STOPPING…" : "STOP"}
              </button>
            </div>
          </div>

          {/* ═══ INSTRUMENT ROW — slots · TG · PP (fixed height) ═════════ */}
          <div
            className="fusion-instrument-row flex gap-2 flex-shrink-0 items-stretch"
            style={{ height: FUSION_HERO_ROW_PX, minHeight: FUSION_HERO_ROW_PX }}
          >
            <div
              className="fusion-instrument-slots flex-shrink-0 self-stretch min-h-0 min-w-0"
              style={{ width: `${slotCol.widthPct}%`, minWidth: slotCol.minWidth }}
            >
              <SlotCtxBars
                slotCtx={fusion.slotCtx}
                ctxTotal={ctxTotal}
                ctxPerSlot={ctxPerSlot}
                parallel={fusion.parallel}
              />
            </div>

            <div className="fusion-instrument-meters flex gap-2 flex-1 min-w-0">
              {/* ── TG INSTRUMENT ── */}
              <div
                className={`fusion-instrument fusion-instrument--tg relative h-full min-h-0 min-w-0 ${
                  !suppressTgHero && fusion.phase === "TG"
                    ? "fusion-instrument--live"
                    : ""
                } ${tgHeroActive ? "fusion-instrument--hot" : ""}`}
                style={{ flex: "1 1 48%" }}
                data-phase={
                  isPrefillPhase ? "pp" : fusion.phase === "TG" ? "tg" : "idle"
                }
              >
                {showPerSlotMeter && (
                  <div
                    className="fusion-per-slot-meter absolute top-1 right-1.5 z-[1] flex flex-col items-end leading-none select-none pointer-events-none"
                    title={`Per-agent TG ≈ ${perSlotLabel ?? "—"} tok/s (system ÷ concurrent slots). Big number = total system throughput.`}
                  >
                    <span
                      className={`fusion-per-slot-meter__value font-mono font-bold tracking-tight ${
                        perSlotLabel ? "is-hot" : "is-ghost"
                      }`}
                    >
                      {perSlotLabel ?? "--"}
                    </span>
                    <span className="fusion-per-slot-meter__unit">/slot</span>
                  </div>
                )}

                <div
                  className={`fusion-instrument__chrome flex items-center gap-1.5 w-full min-w-0 ${
                    showPerSlotMeter ? "pr-12" : ""
                  }`}
                >
                  <span
                    className={`fusion-instrument__phase ${
                      isPrefillPhase
                        ? "fusion-instrument__phase--pp"
                        : fusion.phase === "TG"
                          ? "fusion-instrument__phase--tg"
                          : fusion.phase === "IDLE" && fusion.engine_state !== "ACTIVE"
                            ? "fusion-instrument__phase--idle"
                            : "fusion-instrument__phase--tg-dim"
                    }`}
                  >
                    {isPrefillPhase
                      ? "PROMPT PROCESSING"
                      : fusion.phase === "IDLE" && fusion.engine_state !== "ACTIVE"
                        ? "AWAITING REQUEST"
                        : "GENERATION"}
                  </span>
                  <div className="fusion-mode-seg" role="group" aria-label="Hero TPS mode">
                    <button
                      type="button"
                      onClick={() => setHeroTpsMode("live")}
                      title="Hero TPS: live (per chunk)"
                      className={`fusion-mode-seg__btn ${heroTpsMode === "live" ? "is-active" : ""}`}
                    >
                      LIVE
                    </button>
                    <button
                      type="button"
                      onClick={() => setHeroTpsMode("avg")}
                      title="Hero TPS: session average (bench)"
                      className={`fusion-mode-seg__btn ${heroTpsMode === "avg" ? "is-active" : ""}`}
                    >
                      AVG
                    </button>
                  </div>
                </div>

                <div className="fusion-instrument__figure">
                  <span
                    className={`fusion-tg-hero-value fusion-instrument__value ${
                      tgHeroActive ? "is-hot" : "is-ghost"
                    }`}
                  >
                    {tgHeroDisplay}
                  </span>
                  <span className="fusion-instrument__unit">tok/s</span>
                </div>

                <div className="fusion-instrument__spark">
                  <FusionHeroSparkline
                    value={!suppressTgHero && tgTpsLive > 0 ? tgTpsLive : 0}
                    active={tgHeroActive && fusion.phase === "TG"}
                  />
                </div>

                <FusionMicroReadout
                  live={microReadoutLive}
                  tokensText={microTokenText}
                  prefillMs={microLatch.prefillMs}
                  decodeTtftMs={microLatch.decodeTtftMs}
                  elapsedMs={microLatch.elapsedMs}
                  mtpAcceptPct={
                    (specSlotActive || mtpAcceptPct != null) && mtpAcceptPct != null
                      ? mtpAcceptPct
                      : null
                  }
                  mtpAcceptTitle={mtpAcceptTitle}
                  mtpAcceptLabel={mtpAcceptLabel}
                />
              </div>

              {/* ── PP INSTRUMENT ── */}
              <div
                className={`fusion-instrument fusion-instrument--pp h-full min-h-0 min-w-0 ${
                  !suppressPrefillHero && isPrefillPhase ? "fusion-instrument--live" : ""
                } ${ppHeroActive ? "fusion-instrument--hot" : ""}`}
                style={{ flex: "1 1 36%" }}
                data-phase={isPrefillPhase ? "pp" : "idle"}
              >
                <div className="fusion-instrument__chrome flex items-center justify-between w-full gap-1">
                  <span className="fusion-instrument__phase fusion-instrument__phase--pp-label">
                    PREFILL
                  </span>
                  {showPrefillProgress && (
                    <span className="fusion-instrument__pct fusion-readout-emphasis">
                      {(primaryPrefillProgress * 100).toFixed(0)}%
                    </span>
                  )}
                </div>

                <div className="fusion-instrument__figure">
                  <span
                    className={`fusion-prefill-hero-value fusion-instrument__value ${
                      ppHeroActive
                        ? "fusion-prefill-hero-value--active is-hot"
                        : "fusion-prefill-hero-value--idle is-ghost"
                    }`}
                  >
                    {ppHeroDisplay}
                  </span>
                  <span className="fusion-instrument__unit">tok/s</span>
                </div>

                <div className="fusion-instrument__pp-foot flex flex-col justify-end flex-1 w-full min-h-0 mt-auto">
                  <div
                    className="fusion-pp-progress"
                    style={{ visibility: showPrefillProgress ? "visible" : "hidden" }}
                    aria-hidden={!showPrefillProgress}
                  >
                    <div className="fusion-pp-progress__track">
                      <div
                        className={`fusion-pp-progress__fill${isPrefillPhase ? " is-active" : ""}`}
                        style={{ width: `${(primaryPrefillProgress ?? 0) * 100}%` }}
                      />
                    </div>
                  </div>
                  <span
                    className="fusion-instrument__prompt-meta"
                    title="Prompt tokens processed / estimated task size"
                    style={{
                      visibility:
                        !suppressPrefillHero && isPrefillPhase && primaryPrefillTokens > 0
                          ? "visible"
                          : "hidden",
                    }}
                    aria-hidden={
                      suppressPrefillHero || !isPrefillPhase || primaryPrefillTokens <= 0
                    }
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
          {!hideBenchTray && fusion.engine_state !== "LOADING" && (
            <div className="flex-shrink-0 flex flex-col">
              <FusionBenchTrayLatch open={benchTrayOpen} onToggle={toggleBenchTray} />
              {benchTrayOpen && (
                <BenchWidget
                  port={displayPort}
                  footerDocked
                  maxPpTokens={ctxPerSlot > 0 ? ctxPerSlot : ctxTotal > 0 ? ctxTotal : undefined}
                  engineParallel={fusion.parallel > 0 ? fusion.parallel : undefined}
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
                    tgTps: benchHero.tg ?? (tgTpsPick > 0 ? tgTpsPick : null),
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