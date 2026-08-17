import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { bench_TGBenchResult, bench_PPBurstResult, GpuInfo } from "../lib/types";
import {
  BENCH_RESULT_ROW_DUAL_PX,
  BENCH_RESULT_ROW_PX,
  computeBenchPanelHeight,
  computeFusionBenchSlotHeight,
  isDualBenchResults,
  shouldShowBenchGpuTopo,
} from "../lib/benchPanelLayout";
import {
  buildBenchGpuTopoEntries,
  formatBenchSplitHeadline,
} from "../lib/benchHwTopo";
import { benchFailureLine } from "../lib/benchErrorUtils";
import {
  BENCH_PP_TOKEN_OPTIONS,
  BENCH_TG_PARALLEL_OPTIONS,
  BENCH_TG_PREDICT_OPTIONS,
} from "../lib/storage";
import {
  getBenchPortState,
  notifyBenchPortStore,
  persistBenchControls,
  resetAllBenchPortStates,
  subscribeBenchPortStore,
  tgWarmupWillRun,
  type BenchSessionMode,
} from "../lib/benchPortStore";
import { useTauriListen } from "../hooks/useTauriListen";
import FusionShareMenu from "./FusionShareMenu";
import type { FusionShareMeta } from "../lib/fusionShareCapture";

export type { BenchSessionMode };

export type BenchHeroPatch = {
  tg?: number | null;
  pp?: number | null;
};

export interface BenchResultsFooterProps {
  shareMeta?: FusionShareMeta & { alias?: string };
  onClose: () => void;
}

export interface BenchHwTopoProps {
  gpus: GpuInfo[];
  gpuMask?: string;
  splitMode?: string;
}

export function BenchHwTopo({ gpus, gpuMask, splitMode, fullWidth = false }: BenchHwTopoProps & { fullWidth?: boolean }) {
  const gpuTopoEntries = useMemo(
    () => buildBenchGpuTopoEntries(gpus, gpuMask),
    [gpus, gpuMask],
  );
  const gpuSplitHeadline = useMemo(
    () => formatBenchSplitHeadline(gpus, gpuMask, splitMode),
    [gpus, gpuMask, splitMode],
  );
  if (gpuTopoEntries.length === 0 || !gpuSplitHeadline) return null;

  return (
    <div
      className={`bench-hw-topo flex-shrink-0 pt-0.5 mt-2.5 border-t border-stealth-border/15 ${
        fullWidth ? "bench-hw-topo--row w-full px-1.5" : "px-1"
      }`}
    >
      <p className="text-[5px] font-mono text-stealth-muted/45 tracking-wider uppercase leading-none mb-0.5">
        {gpuSplitHeadline}
      </p>
      <div className="bench-hw-topo-grid">
        {gpuTopoEntries.map((entry) => (
          <div key={entry.key} className="bench-hw-topo-entry">
            <span
              className="bench-hw-topo-swatch"
              style={{ backgroundColor: entry.color }}
              aria-hidden
            />
            <span className="bench-hw-topo-label">
              {entry.count}× {entry.label}
              {entry.driverVersion && (
                <span className="bench-hw-topo-driver">drv {entry.driverVersion}</span>
              )}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BenchResultsActionsCol({ shareMeta, onClose }: BenchResultsFooterProps) {
  return (
    <div
      className="bench-results-actions flex flex-col items-end justify-end self-stretch min-w-0 w-full"
      data-fusion-share-exclude
    >
      {shareMeta && (
        <div className="flex flex-col items-end gap-0.5 w-full">
          <span className="text-[5px] font-mono text-stealth-muted/45 uppercase tracking-wider leading-none">
            SHARE results
          </span>
          <FusionShareMenu
            providerName={shareMeta.providerName}
            tgTps={shareMeta.tgTps}
            providerBuildVersion={shareMeta.providerBuildVersion}
            modelName={shareMeta.modelName}
            modelQuant={shareMeta.modelQuant}
            profileLabel={shareMeta.profileLabel}
            cudaVersion={shareMeta.cudaVersion}
            launchConfig={shareMeta.launchConfig}
            hwTopo={shareMeta.hwTopo}
            shareGpus={shareMeta.shareGpus}
            shareGpuMask={shareMeta.shareGpuMask}
            shareSplitMode={shareMeta.shareSplitMode}
            triggerStyle="share-icon"
          />
        </div>
      )}
      <button
        type="button"
        onClick={onClose}
        className="bench-results-hide-btn bench-muted-btn text-[6px] font-mono transition-colors px-1.5 py-0.5 rounded-sm leading-none uppercase tracking-wide self-end"
      >
        HIDE results
      </button>
    </div>
  );
}

export function BenchResultsFooter({ shareMeta, onClose }: BenchResultsFooterProps) {
  return (
    <div
      className="bench-results-footer flex justify-end items-center gap-2 flex-shrink-0 px-1 pt-0.5"
      data-fusion-share-exclude
    >
      {shareMeta && (
        <FusionShareMenu
          labeled
          providerName={shareMeta.providerName}
          tgTps={shareMeta.tgTps}
          providerBuildVersion={shareMeta.providerBuildVersion}
          modelName={shareMeta.modelName}
          modelQuant={shareMeta.modelQuant}
          profileLabel={shareMeta.profileLabel}
          cudaVersion={shareMeta.cudaVersion}
          launchConfig={shareMeta.launchConfig}
          hwTopo={shareMeta.hwTopo}
          shareGpus={shareMeta.shareGpus}
          shareGpuMask={shareMeta.shareGpuMask}
          shareSplitMode={shareMeta.shareSplitMode}
        />
      )}
      <button
        type="button"
        onClick={onClose}
        className="bench-muted-btn text-[6px] font-mono transition-colors px-1.5 py-0.5 rounded-sm leading-none uppercase tracking-wide"
      >
        HIDE RESULTS
      </button>
    </div>
  );
}

interface BenchWidgetProps {
  port: number;
  /** Tighter layout for engine stack cards — smaller result type + panel height. */
  compact?: boolean;
  /**
   * Engine stack slot — shares per-port bench store with Fusion overlay but UI is
   * controls + results + HIDE only (no share capture, no GPU topo).
   */
  stackMode?: boolean;
  /** SHARE/HIDE row owned by FusionOverlay — widget only renders results + topo. */
  footerDocked?: boolean;
  /** Sync fusion hero TPS with bench results while the results panel is open. */
  onHeroPatch?: (patch: BenchHeroPatch) => void;
  /** TG / PP / both — fusion overlay shows only the matching hero lane. */
  onBenchSessionChange?: (mode: BenchSessionMode) => void;
  /** Fusion share card — inline actions col or footer row when results are shown. */
  shareMeta?: FusionShareMeta & { alias?: string };
  /** Fusion overlay close — overrides default store reset when provided. */
  onCloseResults?: () => void;
  /** GPUs + split used for bench result footer (included in share capture). */
  benchHw?: BenchHwContext;
  /**
   * Per-slot KV budget (n_ctx_seq). PP target chips above this are disabled —
   * full-slot targets trip "out of context" after specials / calibration.
   */
  maxPpTokens?: number;
  /** Live engine `--parallel` (slot bank size). Bench ×N above this is capped at run. */
  engineParallel?: number;

}

export interface BenchHwContext {
  gpus: GpuInfo[];
  gpuMask?: string;
  splitMode?: string;
}

function formatBenchK(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

const BENCH_CONCURRENCY_HELP =
  "Measured TG only (warmup stays ×1). Each concurrent feed pins to its own engine slot — ×4 needs --parallel ≥ 4 at launch. "
  + "Picking more than the engine has caps to the slot count (e.g. ×128 with 16 slots runs ×16). "
  + "MTP / speculative models: use ×1 parallel when the draft model conflicts with multi-slot decode.";

function benchConcurrencyChipTitle(n: number): string {
  if (n === 1) {
    return "Single /completion feed — no multi-slot stress. Safe for MTP / speculative models.";
  }
  return `×${n}: ${n} parallel /completion feeds pinned to slots 0–${n - 1}. Requires --parallel ≥ ${n} at launch; capped to live slot count if lower. Not for MTP models.`;
}


type BenchLastRunGhost = {
  tgTps: number | null;
  ppTps: number | null;
  tgPar: number;
};

function BenchConcurrencyBadge({
  parallel,
  compact = false,
}: {
  parallel: number;
  compact?: boolean;
}) {
  return (
    <span
      className={`bench-concurrency-badge${compact ? " bench-concurrency-badge--compact" : ""}`}
      title={benchConcurrencyChipTitle(parallel)}
    >
      <span className="bench-concurrency-badge__label">CONCURRENCY</span>
      <span className="bench-concurrency-badge__mult fusion-mult-chip">×{parallel}</span>
    </span>
  );
}

export default function BenchWidget({
  port,
  compact = false,
  stackMode = false,
  onHeroPatch,
  onBenchSessionChange,
  shareMeta,
  benchHw,
  footerDocked = false,
  onCloseResults,
  maxPpTokens,
  engineParallel,
}: BenchWidgetProps) {
  const isCompact = compact || stackMode;
  const ps = getBenchPortState(port);
  /** Chips at or above per-slot n_ctx are not runnable (need headroom). */
  const ppChipAllowed = (tok: number) =>
    maxPpTokens == null || maxPpTokens <= 0 || tok < maxPpTokens;

  const [, setTick] = useState(0);
  const bump = () => {
    notifyBenchPortStore();
    setTick((t) => t + 1);
  };
  const bumpControls = () => {
    persistBenchControls(ps);
    bump();
  };
  const benchAbortRef = useRef(false);
  const [stopPending, setStopPending] = useState(false);

  const isBenchStopped = (error?: string) => error === "Cancelled" || error === "Stopped";

  useEffect(() => subscribeBenchPortStore(() => setTick((t) => t + 1)), []);

  const [lastRun, setLastRun] = useState<BenchLastRunGhost | null>(null);

  // Keep a ghost of the last successful bench after HIDE clears live results.
  useEffect(() => {
    const tgOk = ps.tgResult?.success && ps.tgResult.gen_tps > 0 ? ps.tgResult : null;
    const ppOk = ps.ppResult?.success && ps.ppResult.bench_prefill_tps > 0 ? ps.ppResult : null;
    if (!tgOk && !ppOk) return;
    setLastRun((prev) => ({
      tgTps: tgOk ? tgOk.gen_tps : prev?.tgTps ?? null,
      ppTps: ppOk ? ppOk.bench_prefill_tps : prev?.ppTps ?? null,
      tgPar: tgOk ? (tgOk.parallel_requests ?? 1) : prev?.tgPar ?? 1,
    }));
  }, [ps.tgResult, ps.ppResult]);


  // If saved PP target exceeds live slot budget, drop to the largest allowed chip.
  useEffect(() => {
    if (maxPpTokens == null || maxPpTokens <= 0) return;
    if (ps.ppTargetTokens < maxPpTokens) return;
    const allowed = [...BENCH_PP_TOKEN_OPTIONS].filter((t) => t < maxPpTokens);
    const next = allowed.length > 0 ? allowed[allowed.length - 1]! : BENCH_PP_TOKEN_OPTIONS[0]!;
    if (next !== ps.ppTargetTokens) {
      ps.ppTargetTokens = next;
      persistBenchControls(ps);
      bump();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only when budget / port changes
  }, [maxPpTokens, port]);

  /** Restore this port's cached results when navigating between running engines. */
  useEffect(() => {
    const state = getBenchPortState(port);
    if (!state.showResults) {
      onBenchSessionChange?.("idle");
      onHeroPatch?.({ tg: null, pp: null });
    } else {
      onBenchSessionChange?.(state.sessionMode);
      const heroPatch: BenchHeroPatch = {};
      if (state.tgResult?.success && state.tgResult.gen_tps > 0) {
        heroPatch.tg = state.tgResult.gen_tps;
      }
      if (state.ppResult?.success && state.ppResult.bench_prefill_tps > 0) {
        heroPatch.pp = state.ppResult.bench_prefill_tps;
      }
      onHeroPatch?.(heroPatch);
    }
    // Sync UI when this instance mounts or port changes (other tab may have updated the store).
    bump();
  }, [port, onBenchSessionChange, onHeroPatch]);

  const patchHero = (patch: BenchHeroPatch) => {
    onHeroPatch?.(patch);
  };

  const setSessionMode = (mode: BenchSessionMode) => {
    ps.sessionMode = mode;
    onBenchSessionChange?.(mode);
  };

  const handleBenchStopped = () => {
    ps.showResults = false;
    ps.tgResult = null;
    ps.ppResult = null;
    setSessionMode("idle");
    patchHero({ tg: null, pp: null });
    benchAbortRef.current = true;
    setStopPending(false);
    bump();
  };

  const stopBench = async () => {
    if (stopPending) return;
    benchAbortRef.current = true;
    setStopPending(true);
    try {
      await invoke("cmd_cancel_bench", { port: Number(port) });
    } catch (e) {
      console.error("[BENCH] cmd_cancel_bench failed", e);
    }
  };

  const clearBenchOnEngineStop = () => {
    resetAllBenchPortStates();
    onBenchSessionChange?.("idle");
    patchHero({ tg: null, pp: null });
    bump();
  };

  useTauriListen<{ slot: number }>("slot-cleared", clearBenchOnEngineStop);
  useTauriListen("engines-all-stopped", clearBenchOnEngineStop);

  useTauriListen<{
    port: number;
    phase: string;
    effectiveLength?: number;
    parallelRequests?: number;
  }>(
    "bench-tg-progress",
    (payload) => {
      if (payload.port !== port) return;
      ps.tgPhase = payload.phase as "warmup" | "measured";
      if (payload.effectiveLength != null) ps.tgEffectiveLength = payload.effectiveLength;
      if (payload.parallelRequests != null) ps.tgParallel = payload.parallelRequests;
      bump();
    },
    [port],
  );

  useTauriListen<{ port: number; phase: string; effectiveLength?: number }>(
    "bench-pp-progress",
    (payload) => {
      if (payload.port !== port) return;
      ps.ppPhase = payload.phase as "warmup" | "measured";
      if (payload.effectiveLength != null) ps.ppEffectiveLength = payload.effectiveLength;
      bump();
    },
    [port],
  );

  const executeBenchTg = async (patchHeroOnSuccess = true): Promise<void> => {
    const willWarmup = tgWarmupWillRun(ps.nPredict, ps.tgWarmupEnabled);
    ps.tgRunning = true;
    ps.tgResult = null;
    ps.tgPhase = willWarmup ? "warmup" : "measured";
    ps.tgEffectiveLength = willWarmup ? 512 : ps.nPredict;
    if (patchHeroOnSuccess) patchHero({ tg: null });
    bump();
    try {
      const res: bench_TGBenchResult = await invoke("cmd_burst_bench", {
        port,
        nPredict: ps.nPredict,
        benchPromptMode: ps.promptMode,
        tgWarmupEnabled: ps.tgWarmupEnabled,
        parallelRequests: ps.tgParallel,
      });
      ps.tgResult = res;
      if (!res.success && isBenchStopped(res.error)) {
        handleBenchStopped();
        return;
      }
      if (patchHeroOnSuccess && res.success && res.gen_tps > 0) {
        patchHero({ tg: res.gen_tps });
      }
    } catch (e) {
      const errMsg = typeof e === "string" ? e : String(e);
      ps.tgResult = {
        prompt_tokens: 0, gen_tokens: 0,
        prompt_tps: 0, gen_tps: 0, itl_ms: 0,
        success: false, error: errMsg,
      };
    } finally {
      ps.tgRunning = false;
      ps.tgPhase = null;
      setStopPending(false);
      bump();
    }
  };

  const executeBenchPp = async (patchHeroOnSuccess = true): Promise<void> => {
    ps.ppRunning = true;
    ps.ppResult = null;
    ps.ppPhase = "warmup";
    ps.ppEffectiveLength = 1024;
    if (patchHeroOnSuccess) patchHero({ pp: null });
    bump();
    try {
      const res: bench_PPBurstResult = await invoke("cmd_bench_pp_burst", {
        port,
        targetTokens: ps.ppTargetTokens,
        benchPromptMode: ps.promptMode,
      });
      ps.ppResult = res;
      if (!res.success && isBenchStopped(res.error)) {
        handleBenchStopped();
        return;
      }
      if (patchHeroOnSuccess && res.success && res.bench_prefill_tps > 0) {
        patchHero({ pp: res.bench_prefill_tps });
      }
    } catch (e) {
      const errMsg = typeof e === "string" ? e : String(e);
      ps.ppResult = {
        bench_prefill_tps: 0, bench_prompt_tokens_actual: 0,
        success: false, error: errMsg,
      };
    } finally {
      ps.ppRunning = false;
      ps.ppPhase = null;
      setStopPending(false);
      bump();
    }
  };

  const runBenchTg = async () => {
    if (ps.tgRunning || ps.ppRunning || !port) return;
    benchAbortRef.current = false;
    setStopPending(false);
    setSessionMode("tg");
    ps.showResults = true;
    ps.ppResult = null;
    patchHero({ tg: null, pp: null });
    bump();
    await executeBenchTg();
  };

  const runBenchPp = async () => {
    if (ps.tgRunning || ps.ppRunning || !port) return;
    benchAbortRef.current = false;
    setStopPending(false);
    setSessionMode("pp");
    ps.showResults = true;
    ps.tgResult = null;
    patchHero({ tg: null, pp: null });
    bump();
    await executeBenchPp();
  };

  const runBenchBoth = async () => {
    if (ps.tgRunning || ps.ppRunning || !port) return;
    benchAbortRef.current = false;
    setStopPending(false);
    setSessionMode("both");
    ps.showResults = true;
    ps.tgResult = null;
    ps.ppResult = null;
    patchHero({ tg: null, pp: null });
    bump();

    // PP first, then TG — so the display ends in the TG state. The share card's
    // per-slot TG meter (concurrent ÷ slots) is only present while the engine sits in
    // a concurrent TG state; running PP last left it without the per-slot value.
    await executeBenchPp(false);
    if (benchAbortRef.current || isBenchStopped(ps.ppResult?.error)) return;

    // Pin the PP result as soon as it lands so the hero keeps it during the TG run
    // (otherwise the live PP metric resets when the PP bench ends, briefly clearing it).
    if (ps.ppResult?.success && ps.ppResult.bench_prefill_tps > 0) {
      patchHero({ pp: ps.ppResult.bench_prefill_tps });
    }

    await executeBenchTg(false);
    if (benchAbortRef.current || isBenchStopped(ps.tgResult?.error)) return;

    const heroPatch: BenchHeroPatch = {};
    if (ps.tgResult?.success && ps.tgResult.gen_tps > 0) heroPatch.tg = ps.tgResult.gen_tps;
    if (ps.ppResult?.success && ps.ppResult.bench_prefill_tps > 0) {
      heroPatch.pp = ps.ppResult.bench_prefill_tps;
    }
    patchHero(heroPatch);
    bump();
  };

  const cyclePromptMode = () => {
    ps.promptMode = ps.promptMode === "unique" ? "repetitive" : "unique";
    bumpControls();
  };

  const toggleTgWarmup = () => {
    ps.tgWarmupEnabled = !ps.tgWarmupEnabled;
    bumpControls();
  };

  const tgWarmupTitle = ps.tgWarmupEnabled
    ? "512-token warmup decode, then measured run at selected n_predict"
    : "Warmup off — measured run only";

  const isAnyRunning = ps.tgRunning || ps.ppRunning;
  // BOTH finishes PP first — never paint live result grids until the whole session is idle
  // (avoids PREV-TG ghost + full PP results mixed mid-run).
  const showTgResults =
    !isAnyRunning
    && (ps.sessionMode === "tg" || ps.sessionMode === "both")
    && Boolean(ps.tgResult);
  const showPpResults =
    !isAnyRunning
    && (ps.sessionMode === "pp" || ps.sessionMode === "both")
    && Boolean(ps.ppResult);
  const hasResults = showTgResults || showPpResults;

  const chipBtnClass = (active: boolean, _disabled: boolean) =>
    `value-chip fusion-bench-chip ${active ? "value-chip-active" : ""} whitespace-nowrap focus:outline-none cursor-pointer select-none disabled:opacity-30`;

  const concurrencyChipClass = (active: boolean, _disabled: boolean) =>
    `bench-concurrency-chip value-chip fusion-bench-chip ${active ? "value-chip-active" : ""} whitespace-nowrap focus:outline-none cursor-pointer select-none disabled:opacity-30`;

  const runBtnClass = (_disabled: boolean) =>
    "fusion-bench-run text-[8px] font-bold tracking-wider px-1.5 py-0.5 rounded cursor-pointer select-none disabled:opacity-30";

  const stopBtnClass =
    "fusion-bench-stop text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded cursor-pointer select-none flex-shrink-0";

  const chipPadClass = isCompact ? "px-1 py-0 text-[6px]" : "px-1.5 py-0.5 text-[7px]";

  const closeResults = () => {
    ps.showResults = false;
    setSessionMode("idle");
    if (!isAnyRunning) {
      ps.tgResult = null;
      ps.ppResult = null;
      patchHero({ tg: null, pp: null });
    }
    bump();
  };

  const benchRowH = isCompact ? 16 : 18;
  const dualResults = ps.sessionMode === "both";
  const dualBenchLayout = isDualBenchResults({
    showResults: ps.showResults,
    tgRunning: ps.tgRunning,
    ppRunning: ps.ppRunning,
    sessionMode: ps.sessionMode,
    tgResult: ps.tgResult,
    ppResult: ps.ppResult,
    inlineActions: footerDocked,
  });
  const benchResultRowPx = dualResults ? BENCH_RESULT_ROW_DUAL_PX : BENCH_RESULT_ROW_PX;

  const showGpuTopo =
    !stackMode
    && benchHw
    && shouldShowBenchGpuTopo({
      showResults: ps.showResults,
      sessionMode: ps.sessionMode,
      tgRunning: ps.tgRunning,
      ppRunning: ps.ppRunning,
      tgResult: ps.tgResult,
      ppResult: ps.ppResult,
      compact: isCompact,
      stackMode,
      gpus: benchHw.gpus,
      gpuMask: benchHw.gpuMask,
      /* Fusion overlay — GPU topo lives in share capture HW band only */
      inlineActions: footerDocked,
    });

  /** Fixed height — fusion overlay reserves max slot; stack/compact stay dynamic. */
  const panelHeight = useMemo(
    () => {
      const layoutOpts = {
        showResults: ps.showResults,
        tgRunning: ps.tgRunning,
        ppRunning: ps.ppRunning,
        sessionMode: ps.sessionMode,
        tgResult: ps.tgResult,
        ppResult: ps.ppResult,
        compact: isCompact,
        stackMode,
        gpus: benchHw?.gpus,
        gpuMask: benchHw?.gpuMask,
        inlineActions: footerDocked,
      };
      if (footerDocked) {
        return computeFusionBenchSlotHeight(layoutOpts);
      }
      return computeBenchPanelHeight(layoutOpts);
    },
    [
      ps.showResults,
      ps.tgRunning,
      ps.ppRunning,
      ps.sessionMode,
      ps.tgResult,
      ps.ppResult,
      isCompact,
      stackMode,
      benchHw,
      footerDocked,
    ],
  );
  const benchLabelClass = dualResults ? "text-[5px]" : "text-[6px]";
  const benchValueClass = dualResults
    ? (isCompact ? "text-[10px]" : "text-[15px]")
    : (isCompact ? "text-sm" : "text-xl");
  const benchUnitClass = dualResults ? "text-[5px]" : "text-[6px]";
  const benchRowPadClass = dualResults ? "gap-y-0 py-0" : (isCompact ? "gap-y-0 py-0" : "gap-y-0.5 py-0.5");
  const benchResultGridClass = () =>
    `bench-results-grid grid gap-x-1.5 ${benchRowPadClass}`;
  const showInlineActions = footerDocked && Boolean(shareMeta) && hasResults && !isAnyRunning;
  const showStackDismiss = stackMode && hasResults && !isAnyRunning;
  const showShareFooter = !footerDocked && !stackMode && !isAnyRunning && hasResults && Boolean(shareMeta);
  const tgErrorNotice =
    showTgResults && ps.tgResult && !ps.tgResult.success
      ? benchFailureLine("tg", ps.tgResult.error)
      : null;
  const ppErrorNotice =
    showPpResults && ps.ppResult && !ps.ppResult.success
      ? benchFailureLine("pp", ps.ppResult.error)
      : null;
  const benchErrorNotice = tgErrorNotice ?? ppErrorNotice;
  const showResultsSidebar = Boolean(benchErrorNotice) || showInlineActions || showStackDismiss;
  const dismissResults = onCloseResults ?? closeResults;

  return (
      <div
        className={`bench-widget-panel fusion-bench-panel w-full h-full rounded-sm flex flex-col overflow-hidden flex-shrink-0 ${isCompact ? "p-1" : "p-1.5"}`}
        data-bench-dual-results={dualBenchLayout ? "" : undefined}
        style={{
          height: panelHeight,
          minHeight: panelHeight,
          maxHeight: panelHeight,
          ["--bench-control-row-h" as string]: `${benchRowH}px`,
          ["--bench-result-row-h" as string]: `${benchResultRowPx}px`,
        }}
      >
        {!isAnyRunning && !ps.showResults && (
          <div
            className={`fusion-bench-controls mt-auto flex-shrink-0${
              isCompact || stackMode ? " fusion-bench-controls--solo" : ""
            }`}
          >
            {!(isCompact || stackMode) && (
              <div className="fusion-bench-controls__bay">
                <div className="fusion-bench-bay__armed">
                  <span className="fusion-bench-bay__armed-label">ARMED</span>
                  <span className="fusion-bench-bay__armed-line">
                    TG {formatBenchK(ps.nPredict)}
                    {ps.tgParallel > 1 ? ` · ×${ps.tgParallel}` : ""}
                    {ps.tgWarmupEnabled ? " · W" : ""}
                  </span>
                  <span className="fusion-bench-bay__armed-line">
                    PP {formatBenchK(ps.ppTargetTokens)}
                    {" · "}
                    {ps.promptMode === "unique" ? "uniq" : "rep"}
                  </span>
                </div>
                <div className="fusion-bench-bay__last">
                  <span className="fusion-bench-bay__last-label">LAST</span>
                  {lastRun && (lastRun.tgTps != null || lastRun.ppTps != null) ? (
                    <span className="fusion-bench-bay__last-vals">
                      {lastRun.tgTps != null && (
                        <span title="Last TG gen tok/s">
                          TG {lastRun.tgTps.toFixed(1)}
                          {lastRun.tgPar > 1 ? `×${lastRun.tgPar}` : ""}
                        </span>
                      )}
                      {lastRun.tgTps != null && lastRun.ppTps != null && (
                        <span className="fusion-bench-bay__last-sep">·</span>
                      )}
                      {lastRun.ppTps != null && (
                        <span title="Last PP prefill tok/s">PP {lastRun.ppTps >= 1000 ? `${(lastRun.ppTps / 1000).toFixed(1)}k` : lastRun.ppTps.toFixed(0)}</span>
                      )}
                    </span>
                  ) : (
                    <span className="fusion-bench-bay__last-empty">—</span>
                  )}
                </div>
              </div>
            )}
            <div className="fusion-bench-controls__table" role="table" aria-label="Benchmark controls">
              <div className="fusion-bench-table__row" role="row">
                <span className="fusion-bench-row-label" role="rowheader" title="Token generation (decode) length">DECODE</span>
                <div className="fusion-bench-table__chips" role="cell">
                  {BENCH_TG_PREDICT_OPTIONS.map((tok) => (
                    <button
                      key={tok}
                      onClick={() => { ps.nPredict = tok; bumpControls(); }}
                      disabled={isAnyRunning}
                      className={`font-mono rounded-sm ${chipPadClass} ${chipBtnClass(ps.nPredict === tok, isAnyRunning)}`}
                    >
                      {formatBenchK(tok)}
                    </button>
                  ))}
                </div>
                <div className="fusion-bench-table__ops" role="cell">
                  <button
                    onClick={runBenchTg}
                    disabled={isAnyRunning}
                    className={runBtnClass(isAnyRunning)}
                  >
                    RUN
                  </button>
                </div>
              </div>

              <div className="fusion-bench-table__row" role="row">
                <span className="fusion-bench-row-label" role="rowheader" title="Prompt prefill size">PREFILL</span>
                <div className="fusion-bench-table__chips" role="cell">
                  {BENCH_PP_TOKEN_OPTIONS.map((tok) => {
                    const overCtx = !ppChipAllowed(tok);
                    const disabled = isAnyRunning || overCtx;
                    return (
                      <button
                        key={tok}
                        onClick={() => {
                          if (overCtx) return;
                          ps.ppTargetTokens = tok;
                          bumpControls();
                        }}
                        disabled={disabled}
                        title={
                          overCtx
                            ? `Disabled — exceeds per-slot context (${maxPpTokens?.toLocaleString() ?? "?"} tok). Full-slot targets trip out-of-context.`
                            : undefined
                        }
                        className={`font-mono rounded-sm ${chipPadClass} ${
                          overCtx
                            ? "opacity-30 cursor-not-allowed line-through"
                            : chipBtnClass(ps.ppTargetTokens === tok, isAnyRunning)
                        }`}
                      >
                        {formatBenchK(tok)}
                      </button>
                    );
                  })}
                </div>
                <div className="fusion-bench-table__ops" role="cell">
                  <button
                    onClick={runBenchPp}
                    disabled={isAnyRunning || !ppChipAllowed(ps.ppTargetTokens)}
                    className={runBtnClass(isAnyRunning)}
                  >
                    RUN
                  </button>
                </div>
              </div>

              <div className="fusion-bench-table__row" role="row">
                <span
                  className="fusion-bench-row-label"
                  role="rowheader"
                  title={BENCH_CONCURRENCY_HELP}
                >
                  AGENTS
                </span>
                <div className="fusion-bench-table__chips fusion-bench-table__chips--concur" role="cell">
                  {BENCH_TG_PARALLEL_OPTIONS.map((n) => {
                    const overEngine =
                      engineParallel != null && engineParallel > 0 && n > engineParallel;
                    return (
                      <button
                        key={`par-${n}`}
                        onClick={() => { ps.tgParallel = n; bumpControls(); }}
                        disabled={isAnyRunning}
                        title={
                          overEngine
                            ? `×${n} needs engine --parallel ≥ ${n} (live ×${engineParallel}). Bench will cap to ×${engineParallel}. Hot-swap the engine card (HS) to raise slots.`
                            : benchConcurrencyChipTitle(n)
                        }
                        className={`font-mono rounded-sm ${chipPadClass} ${concurrencyChipClass(ps.tgParallel === n, isAnyRunning)}${
                          overEngine && ps.tgParallel !== n ? " fusion-bench-chip--over-engine" : ""
                        }${overEngine && ps.tgParallel === n ? " fusion-bench-chip--over-engine-active" : ""}`}
                      >
                        ×{n}
                      </button>
                    );
                  })}
                  {engineParallel != null && engineParallel > 0 && ps.tgParallel > engineParallel ? (
                    <span
                      className="fusion-bench-par-hint"
                      title={`Selected ×${ps.tgParallel} exceeds live engine --parallel ×${engineParallel}. Run caps to ×${engineParallel}. Use HS on the running engine card after raising Agents in the panel.`}
                    >
                      ENG×{engineParallel}
                    </span>
                  ) : null}
                </div>
                <div className="fusion-bench-table__ops" role="cell">
                  <button
                    onClick={runBenchBoth}
                    disabled={isAnyRunning}
                    className={runBtnClass(isAnyRunning)}
                    title="Run PREFILL then DECODE with current selections (DECODE last so the share card keeps its per-slot meter)"
                  >
                    BOTH
                  </button>
                </div>
              </div>

              <div className="fusion-bench-table__row" role="row">
                <span className="fusion-bench-row-label" role="rowheader" title="Decode warmup + prompt style">SETTINGS</span>
                <div className="fusion-bench-table__chips" role="cell">
                  <div className="fusion-bench-field">
                    <span className="fusion-bench-field__lab" title="TG warmup pass before measured decode">WARMUP </span>
                    <button
                      type="button"
                      onClick={toggleTgWarmup}
                      disabled={isAnyRunning}
                      title={tgWarmupTitle}
                      className={`bench-muted-btn fusion-bench-toggle font-mono rounded-sm focus:outline-none cursor-pointer select-none disabled:opacity-30 flex-shrink-0 ${chipPadClass} ${
                        ps.tgWarmupEnabled ? "fusion-bench-toggle--on" : ""
                      }`}
                    >
                      {ps.tgWarmupEnabled ? "ON" : "OFF"}
                    </button>
                  </div>
                  <div className="fusion-bench-field">
                    <span className="fusion-bench-field__lab" title="Prefill prompt vocabulary style">CONTENT style</span>
                    <button
                      onClick={cyclePromptMode}
                      disabled={isAnyRunning}
                      className={`bench-muted-btn fusion-bench-toggle font-mono rounded-sm focus:outline-none cursor-pointer select-none disabled:opacity-30 ${chipPadClass}`}
                      title={
                        ps.promptMode === "unique"
                          ? "Unique: diverse technical vocabulary (512-tok prefill, token-calibrated). TG decode is temp-0 continuation."
                          : "Repetitive: fixed phrase cycled to 512-tok prefill — predictable for MTP/spec-decode. TG decode is temp-0 continuation of the pattern."
                      }
                    >
                      {ps.promptMode === "unique" ? "Unique" : "CODE gen"}
                    </button>
                  </div>
                </div>
                <div className="fusion-bench-table__ops" role="cell" aria-hidden="true" />
              </div>
            </div>
          </div>
        )}

        {ps.showResults && (
           <div className={`bench-results-stack flex flex-col flex-shrink-0 min-h-0 ${footerDocked ? "" : "h-full overflow-hidden"}`}>
             <div className="bench-results-body flex flex-row items-start gap-x-1 px-1 flex-shrink-0">
               <div className={`flex flex-col flex-1 min-w-0${dualBenchLayout ? " gap-y-2.5" : ""}`}>
               {isAnyRunning && (
                 <div className="fusion-bench-running flex items-center justify-between gap-1.5 px-1 py-0.5">
                   <div className="flex items-center gap-1.5 min-w-0">
                     <span className="fusion-bench-running__dot" aria-hidden />
                     <span className="fusion-bench-running__text text-[7px] font-mono truncate">
                       {stopPending
                         ? "Stopping…"
                         : ps.tgRunning
                           ? (ps.tgPhase === "warmup"
                             ? `TG warmup · ${ps.tgEffectiveLength} tok`
                             : `TG measured · ${ps.tgEffectiveLength} tok${ps.tgParallel > 1 ? ` · ×${ps.tgParallel}` : ""}`)
                           : ps.ppRunning
                             ? (ps.ppPhase === "warmup"
                               ? `PP warmup · ${ps.ppEffectiveLength} tok`
                               : `PP measured · ${ps.ppEffectiveLength} tok`)
                             : "Running…"}
                     </span>
                   </div>
                   <button
                     type="button"
                     onClick={() => { void stopBench(); }}
                     disabled={stopPending}
                     className={stopBtnClass}
                     title="Abort the in-flight completion and stop the bench"
                   >
                     STOP
                   </button>
                 </div>
               )}

               {isAnyRunning && (
                 <div className="fusion-bench-ghost" aria-label="Previous bench scores">
                   <div className="fusion-bench-ghost__lane">
                     <span className="fusion-bench-ghost__lab">PREV TG</span>
                     <span className={`fusion-bench-ghost__value fusion-instrument__value ${lastRun?.tgTps != null ? "is-ghost" : "is-empty"}`}>
                       {lastRun?.tgTps != null
                         ? lastRun.tgTps.toFixed(1)
                         : "—"}
                     </span>
                     <span className="fusion-bench-ghost__unit">
                       tok/s{lastRun != null && lastRun.tgPar > 1 ? ` · ×${lastRun.tgPar}` : ""}
                     </span>
                   </div>
                   <div className="fusion-bench-ghost__lane">
                     <span className="fusion-bench-ghost__lab">PREV PP</span>
                     <span className={`fusion-bench-ghost__value fusion-instrument__value ${lastRun?.ppTps != null ? "is-ghost" : "is-empty"}`}>
                       {lastRun?.ppTps != null
                         ? (lastRun.ppTps >= 1000
                           ? `${(lastRun.ppTps / 1000).toFixed(1)}k`
                           : lastRun.ppTps.toFixed(0))
                         : "—"}
                     </span>
                     <span className="fusion-bench-ghost__unit">tok/s</span>
                   </div>
                 </div>
               )}

               {showTgResults && ps.tgResult?.success && (() => {
                 const tg = ps.tgResult!;
                 const par = tg.parallel_requests ?? 1;
                 const multi = par > 1;
                 const systemTps = multi && tg.aggregate_gen_tps && tg.aggregate_gen_tps > 0
                   ? tg.aggregate_gen_tps
                   : tg.gen_tps;
                 const perReq = multi
                   ? (tg.per_request_gen_tps && tg.per_request_gen_tps > 0
                     ? tg.per_request_gen_tps
                     : systemTps / par)
                   : null;
                 const itl = multi && perReq && perReq > 0
                   ? 1000 / perReq
                   : tg.itl_ms;
                 return (
                  <div className={`${benchResultGridClass()} fusion-bench-result fusion-bench-result--tg`}>
                    <div className="fusion-bench-metric">
                      <p className={`${benchLabelClass} fusion-bench-metric__label`}>DECODE</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none fusion-bench-metric__value ${benchValueClass}`}>{tg.gen_tokens}</p>
                      <p className={`${benchUnitClass} fusion-bench-metric__unit`}>
                        {tg.prompt_tokens > 0
                          ? `${tg.prompt_tokens.toLocaleString()} pp · ${ps.promptMode}`
                          : ps.promptMode}
                      </p>
                    </div>
                    <div className="fusion-bench-metric">
                      <p className={`${benchLabelClass} fusion-bench-metric__label`}>{multi ? "SYSTEM" : "GENERATION"}</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none fusion-bench-metric__value ${benchValueClass}`}>{systemTps.toFixed(1)}</p>
                      <div className="bench-result-unit-slot">
                        {multi ? (
                          <BenchConcurrencyBadge
                            parallel={par}
                            compact={dualResults}
                          />
                        ) : (
                          <p className={`${benchUnitClass} fusion-bench-metric__unit`}>
                            {tg.prompt_tps > 0 ? `tok/s · pp ${tg.prompt_tps.toFixed(0)}` : "tok/s"}
                          </p>
                        )}
                      </div>
                    </div>
                    <div className="fusion-bench-metric">
                      <p className={`${benchLabelClass} fusion-bench-metric__label`}>{multi ? "/REQ" : "ITL"}</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none fusion-bench-metric__value ${benchValueClass}`}>
                        {multi && perReq != null ? perReq.toFixed(1) : itl.toFixed(2)}
                      </p>
                      <p className={`${benchUnitClass} fusion-bench-metric__unit`}>
                        {multi ? `${itl.toFixed(2)} ms itl` : "ms"}
                      </p>
                    </div>
                  </div>
                 );
               })()}

              {showPpResults && ps.ppResult?.success && (() => {
                const pp = ps.ppResult!;
                const ppMs = pp.bench_prefill_tps > 0 && pp.bench_prompt_tokens_actual > 0
                  ? (pp.bench_prompt_tokens_actual / pp.bench_prefill_tps) * 1000
                  : null;
                return (
                  <div className={`${benchResultGridClass()} fusion-bench-result fusion-bench-result--pp`}>
                    <div className="fusion-bench-metric">
                      <p className={`${benchLabelClass} fusion-bench-metric__label`}>TOKENS</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none fusion-bench-metric__value ${benchValueClass}`}>
                        {pp.bench_prompt_tokens_actual.toLocaleString()}
                      </p>
                      <p className={`${benchUnitClass} fusion-bench-metric__unit`}>prompt tok</p>
                    </div>
                    <div className="fusion-bench-metric">
                      <p className={`${benchLabelClass} fusion-bench-metric__label`}>PREFILL</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none fusion-bench-metric__value ${benchValueClass}`}>
                        {pp.bench_prefill_tps.toFixed(1)}
                      </p>
                      <p className={`${benchUnitClass} fusion-bench-metric__unit`}>tok/s</p>
                    </div>
                    {ppMs != null && (
                      <div className="fusion-bench-metric">
                        <p className={`${benchLabelClass} fusion-bench-metric__label`}>WALL</p>
                        <p className={`font-mono fusion-readout-emphasis leading-none fusion-bench-metric__value ${benchValueClass}`}>
                          {ppMs >= 1000 ? `${(ppMs / 1000).toFixed(2)}s` : `${ppMs.toFixed(0)}ms`}
                        </p>
                        <p className={`${benchUnitClass} fusion-bench-metric__unit`}>duration</p>
                      </div>
                    )}
                  </div>
                );
              })()}
             </div>

             {showResultsSidebar && (
               <div
                 className="bench-results-sidebar flex flex-col items-end justify-end flex-shrink-0 self-stretch max-w-[11rem] min-w-[4.25rem]"
                 style={{
                   minHeight:
                     benchErrorNotice && !(showTgResults && ps.tgResult?.success) && !(showPpResults && ps.ppResult?.success)
                       ? benchResultRowPx
                       : undefined,
                 }}
               >
                 {benchErrorNotice && (
                   <p className="text-[6px] font-mono text-red-400 text-right leading-snug mb-auto pt-0.5 max-w-[11rem]">
                     {benchErrorNotice}
                   </p>
                 )}
                 {showInlineActions && shareMeta && (
                   <BenchResultsActionsCol shareMeta={shareMeta} onClose={dismissResults} />
                 )}
                 {showStackDismiss && (
                   <button
                     type="button"
                     onClick={dismissResults}
                     className="bench-muted-btn text-[6px] font-mono transition-colors px-1.5 py-0.5 rounded-sm leading-none uppercase tracking-wide"
                   >
                     HIDE results
                   </button>
                 )}
               </div>
             )}
             </div>

            {showGpuTopo && benchHw && (
              <BenchHwTopo
                fullWidth
                gpus={benchHw.gpus}
                gpuMask={benchHw.gpuMask}
                splitMode={benchHw.splitMode}
              />
            )}

            {showShareFooter && shareMeta && (
              <BenchResultsFooter shareMeta={shareMeta} onClose={dismissResults} />
            )}
          </div>
        )}
      </div>
    );
}
