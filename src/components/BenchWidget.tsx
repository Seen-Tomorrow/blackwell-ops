import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { bench_TGBenchResult, bench_PPBurstResult, GpuInfo } from "../lib/types";
import {
  BENCH_RESULT_ROW_DUAL_PX,
  BENCH_RESULT_ROW_PX,
  computeBenchPanelHeight,
  isDualBenchResults,
  shouldShowBenchGpuTopo,
} from "../lib/benchPanelLayout";
import {
  buildBenchGpuTopoEntries,
  formatBenchSplitHeadline,
} from "../lib/benchHwTopo";
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
      className="bench-results-actions flex flex-col items-end justify-end gap-0.5 self-stretch min-w-0"
      data-fusion-share-exclude
    >
      {shareMeta && (
        <>
          <span className="text-[5px] font-mono text-stealth-muted/45 uppercase tracking-wider leading-none">
            SHARE results
          </span>
          <FusionShareMenu
            alias={shareMeta.alias}
            providerName={shareMeta.providerName}
            providerBuildVersion={shareMeta.providerBuildVersion}
            modelName={shareMeta.modelName}
            modelQuant={shareMeta.modelQuant}
            profileLabel={shareMeta.profileLabel}
            cudaVersion={shareMeta.cudaVersion}
            launchConfig={shareMeta.launchConfig}
            hwTopo={shareMeta.hwTopo}
            triggerStyle="share-icon"
          />
        </>
      )}
      <button
        type="button"
        onClick={onClose}
        className="bench-muted-btn text-[6px] font-mono transition-colors px-1.5 py-0.5 rounded-sm leading-none uppercase tracking-wide"
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
          alias={shareMeta.alias}
          providerName={shareMeta.providerName}
          providerBuildVersion={shareMeta.providerBuildVersion}
          modelName={shareMeta.modelName}
          modelQuant={shareMeta.modelQuant}
          profileLabel={shareMeta.profileLabel}
          cudaVersion={shareMeta.cudaVersion}
          launchConfig={shareMeta.launchConfig}
          hwTopo={shareMeta.hwTopo}
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
  + "MTP / speculative models: use ×1 — ik_llama disables speculative decoding when --parallel > 1 at launch.";

function benchConcurrencyChipTitle(n: number): string {
  if (n === 1) {
    return "Single /completion feed — no multi-slot stress. Safe for MTP / speculative models.";
  }
  return `×${n}: ${n} parallel /completion feeds pinned to slots 0–${n - 1}. Requires --parallel ≥ ${n} at launch; capped to live slot count if lower. Not for MTP models.`;
}

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
}: BenchWidgetProps) {
  const isCompact = compact || stackMode;
  const ps = getBenchPortState(port);

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
  const benchStopPendingRef = useRef(false);

  const isBenchStopped = (error?: string) => error === "Cancelled" || error === "Stopped";

  useEffect(() => subscribeBenchPortStore(() => setTick((t) => t + 1)), []);

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
    benchStopPendingRef.current = false;
    bump();
  };

  const stopBench = async () => {
    benchAbortRef.current = true;
    benchStopPendingRef.current = true;
    bump();
    try {
      await invoke("cmd_cancel_bench", { port });
    } catch {
      // Backend may already have finished; UI resets when the bench invoke returns.
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
      benchStopPendingRef.current = false;
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
      benchStopPendingRef.current = false;
      bump();
    }
  };

  const runBenchTg = async () => {
    if (ps.tgRunning || ps.ppRunning || !port) return;
    benchAbortRef.current = false;
    benchStopPendingRef.current = false;
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
    benchStopPendingRef.current = false;
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
    benchStopPendingRef.current = false;
    setSessionMode("both");
    ps.showResults = true;
    ps.tgResult = null;
    ps.ppResult = null;
    patchHero({ tg: null, pp: null });
    bump();

    await executeBenchTg(false);
    if (benchAbortRef.current || isBenchStopped(ps.tgResult?.error)) return;

    await executeBenchPp(false);
    if (benchAbortRef.current || isBenchStopped(ps.ppResult?.error)) return;

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
  const showTgResults =
    (ps.sessionMode === "tg" || ps.sessionMode === "both") && Boolean(ps.tgResult) && !ps.tgRunning;
  const showPpResults =
    (ps.sessionMode === "pp" || ps.sessionMode === "both") && Boolean(ps.ppResult) && !ps.ppRunning;
  const hasResults = showTgResults || showPpResults;

  const chipBtnClass = (active: boolean, disabled: boolean) =>
    `value-chip ${active ? "value-chip-active" : ""} whitespace-nowrap focus:outline-none cursor-pointer select-none disabled:opacity-30`;

  const concurrencyChipClass = (active: boolean, disabled: boolean) =>
    `bench-concurrency-chip value-chip ${active ? "value-chip-active" : ""} whitespace-nowrap focus:outline-none cursor-pointer select-none disabled:opacity-30`;

  const runBtnClass = (disabled: boolean) =>
    `text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-green-600/80 hover:bg-green-500 active:bg-green-700 text-white cursor-pointer select-none disabled:opacity-30`;

  const stopBtnClass =
    "text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-red-700/85 hover:bg-red-600 active:bg-red-800 text-white cursor-pointer select-none flex-shrink-0";

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
  const benchRowClass = "bench-control-row flex items-center justify-end gap-1 flex-shrink-0 overflow-hidden";
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
    });

  /** Fixed height — idle vs results (+ optional HW topo band). */
  const panelHeight = useMemo(
    () =>
      computeBenchPanelHeight({
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
      }),
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
  const ppErrorNotice =
    showPpResults && ps.ppResult && !ps.ppResult.success
      ? `PREFILL bench failed: ${ps.ppResult.error || "unknown"}`
      : null;
  const showResultsSidebar = Boolean(ppErrorNotice) || showInlineActions || showStackDismiss;
  const dismissResults = onCloseResults ?? closeResults;

  return (
      <div
        className={`bench-widget-panel w-full h-full rounded-sm flex flex-col overflow-hidden flex-shrink-0 ${isCompact ? "p-1" : "p-1.5"}`}
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
          <div className="mt-auto flex flex-col flex-shrink-0">
            <div className={benchRowClass}>
              <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-0.5">TG</span>
              {BENCH_TG_PREDICT_OPTIONS.map((tok) => (
                <button
                  key={tok}
                  onClick={() => { ps.nPredict = tok; bumpControls(); }}
                  disabled={isAnyRunning}
                  className={`px-1 py-0 text-[6px] font-mono rounded-sm ${chipBtnClass(ps.nPredict === tok, isAnyRunning)}`}
                >
                  {formatBenchK(tok)}
                </button>
              ))}
              <button
                onClick={runBenchTg}
                disabled={isAnyRunning}
                className={`${runBtnClass(isAnyRunning)} ml-0.5`}
              >
                RUN
              </button>
            </div>

            <div className={benchRowClass}>
              <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-0.5">PP</span>
              {BENCH_PP_TOKEN_OPTIONS.map((tok) => (
                <button
                  key={tok}
                  onClick={() => { ps.ppTargetTokens = tok; bumpControls(); }}
                  disabled={isAnyRunning}
                  className={`px-1 py-0 text-[6px] font-mono rounded-sm ${chipBtnClass(ps.ppTargetTokens === tok, isAnyRunning)}`}
                >
                  {formatBenchK(tok)}
                </button>
              ))}
              <button
                onClick={runBenchPp}
                disabled={isAnyRunning}
                className={`${runBtnClass(isAnyRunning)} ml-0.5`}
              >
                RUN
              </button>
            </div>

            <div className={benchRowClass}>
              <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-0.5">
                WARMUP
              </span>
              <button
                type="button"
                onClick={toggleTgWarmup}
                disabled={isAnyRunning}
                title={tgWarmupTitle}
                className={`bench-muted-btn px-1.5 py-0.5 text-[6px] font-mono rounded-sm focus:outline-none cursor-pointer select-none disabled:opacity-30 flex-shrink-0 ${
                  ps.tgWarmupEnabled ? "text-yellow-400/90" : "text-stealth-muted/55"
                }`}
              >
                {ps.tgWarmupEnabled ? "ON" : "OFF"}
              </button>
              <button
                onClick={cyclePromptMode}
                disabled={isAnyRunning}
                className="bench-muted-btn px-1 py-0.5 text-[6px] font-mono rounded-sm focus:outline-none cursor-pointer select-none disabled:opacity-30"
                title={
                  ps.promptMode === "unique"
                    ? "Unique: diverse technical vocabulary (512-tok prefill, token-calibrated). TG decode is temp-0 continuation."
                    : "Repetitive: fixed phrase cycled to 512-tok prefill — predictable for MTP/spec-decode. TG decode is temp-0 continuation of the pattern."
                }
              >
                {ps.promptMode === "unique" ? "Unique ▸" : "◂ Repetitive"}
              </button>
              <button
                onClick={runBenchBoth}
                disabled={isAnyRunning}
                className={runBtnClass(isAnyRunning)}
                title="Run TG then PP with current token selections"
              >
                RUN BOTH
              </button>
            </div>

            <div className={benchRowClass}>
              <span
                className="text-[6px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-0.5"
                title={BENCH_CONCURRENCY_HELP}
              >
                CONCURRENCY
              </span>
              {BENCH_TG_PARALLEL_OPTIONS.map((n) => (
                <button
                  key={`par-${n}`}
                  onClick={() => { ps.tgParallel = n; bumpControls(); }}
                  disabled={isAnyRunning}
                  title={benchConcurrencyChipTitle(n)}
                  className={`px-1 py-0 text-[6px] font-mono rounded-sm ${concurrencyChipClass(ps.tgParallel === n, isAnyRunning)}`}
                >
                  ×{n}
                </button>
              ))}
            </div>
          </div>
        )}

        {ps.showResults && (
           <div className={`bench-results-stack flex flex-col flex-shrink-0 min-h-0 ${footerDocked ? "" : "h-full overflow-hidden"}`}>
             <div className="bench-results-body flex flex-row items-start gap-x-1 px-1 flex-shrink-0">
               <div className={`flex flex-col flex-1 min-w-0${dualBenchLayout ? " gap-y-2.5" : ""}`}>
               {isAnyRunning && (
                 <div className="flex items-center justify-between gap-1.5 px-1 py-0.5">
                   <div className="flex items-center gap-1.5 min-w-0">
                     <span className="inline-block w-1 h-1 bg-yellow-400 rounded-full animate-pulse flex-shrink-0" />
                     <span className="text-[7px] font-mono text-stealth-muted truncate">
                       {benchStopPendingRef.current
                         ? "Finishing current run..."
                         : ps.tgRunning
                           ? (ps.tgPhase === "warmup"
                             ? `TG WARMUP (${ps.tgEffectiveLength ?? 512} tok)`
                             : ps.tgParallel > 1
                               ? `TG (${ps.nPredict} tok ×${ps.tgParallel})...`
                               : `TG (${ps.nPredict} tok)...`)
                           : ps.ppRunning
                             ? (ps.ppPhase === "warmup"
                               ? `PP WARMUP (${formatBenchK(ps.ppEffectiveLength ?? 512)} tok)`
                               : `PP (${formatBenchK(ps.ppTargetTokens)} tok)...`)
                             : ""}
                     </span>
                   </div>
                   <button
                     type="button"
                     onClick={() => { void stopBench(); }}
                     disabled={benchStopPendingRef.current}
                     className={stopBtnClass}
                     title="Finish the in-flight request, then stop before the next run"
                   >
                     STOP
                   </button>
                 </div>
               )}

               {showTgResults && ps.tgResult && (
                ps.tgResult.success ? (
                  <div className={benchResultGridClass()}>
                    <div>
                      <p className={`${benchLabelClass} font-mono text-stealth-muted uppercase tracking-wider`}>REQUEST LENGTH</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none ${benchValueClass}`}>{ps.tgResult.gen_tokens}</p>
                      <p className={`${benchUnitClass} font-mono text-stealth-muted/50 uppercase`}>
                        {ps.promptMode}
                      </p>
                    </div>
                    <div>
                      <p className={`${benchLabelClass} font-mono text-stealth-muted uppercase tracking-wider`}>GENERATION</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none ${benchValueClass}`}>{ps.tgResult.gen_tps.toFixed(1)}</p>
                      <div className="bench-result-unit-slot">
                        <BenchConcurrencyBadge
                          parallel={ps.tgResult.parallel_requests ?? 1}
                          compact={dualResults}
                        />
                      </div>
                    </div>
                    <div>
                      <p className={`${benchLabelClass} font-mono text-stealth-muted uppercase tracking-wider`}>ITL</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none ${benchValueClass}`}>
                        {((ps.tgResult.parallel_requests ?? 1) > 1 && ps.tgResult.per_request_gen_tps)
                          ? (1000 / ps.tgResult.per_request_gen_tps).toFixed(2)
                          : ps.tgResult.itl_ms.toFixed(2)}
                      </p>
                      <p className={`${benchUnitClass} font-mono text-stealth-muted/50`}>
                        {(ps.tgResult.parallel_requests ?? 1) > 1 ? "req ms" : "ms"}
                      </p>
                    </div>
                  </div>
                ) : (
                  <p className="text-[7px] font-mono text-red-400 px-1 py-0.5">TG FAILED: {ps.tgResult.error || "unknown"}</p>
                )
              )}

              {showPpResults && ps.ppResult?.success && (
                  <div className={benchResultGridClass()}>
                    <div>
                      <p className={`${benchLabelClass} font-mono text-stealth-muted uppercase tracking-wider`}>TOKENS</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none ${benchValueClass}`}>
                        {ps.ppResult.bench_prompt_tokens_actual.toLocaleString()}
                      </p>
                      <p className={`${benchUnitClass} font-mono text-stealth-muted/50`}>prompt tok</p>
                    </div>
                    <div>
                      <p className={`${benchLabelClass} font-mono text-stealth-muted uppercase tracking-wider`}>PREFILL</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none ${benchValueClass}`}>
                        {ps.ppResult.bench_prefill_tps.toFixed(1)}
                      </p>
                      <p className={`${benchUnitClass} font-mono text-stealth-muted/50`}>tok/s</p>
                    </div>
                  </div>
              )}
             </div>

             {showResultsSidebar && (
               <div
                 className="bench-results-sidebar flex flex-col items-end justify-end flex-shrink-0 self-stretch max-w-[11rem] min-w-[4.25rem]"
                 style={{ minHeight: ppErrorNotice && !showTgResults && !ps.ppResult?.success ? benchResultRowPx : undefined }}
               >
                 {ppErrorNotice && (
                   <p className="text-[6px] font-mono text-red-400 text-right leading-tight mb-auto pt-0.5">
                     {ppErrorNotice}
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
