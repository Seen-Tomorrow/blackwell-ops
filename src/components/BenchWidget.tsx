import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { bench_TGBenchResult, bench_PPBurstResult } from "../lib/types";
import {
  getBenchPortState,
  resetAllBenchPortStates,
  subscribeBenchPortStore,
  type BenchSessionMode,
} from "../lib/benchPortStore";
import { useTauriListen } from "../hooks/useTauriListen";

export type { BenchSessionMode };

export type BenchHeroPatch = {
  tg?: number | null;
  pp?: number | null;
};

interface BenchWidgetProps {
  port: number;
  /** Tighter layout for engine stack cards — smaller result type + panel height. */
  compact?: boolean;
  /** Sync fusion hero TPS with bench results while the results panel is open. */
  onHeroPatch?: (patch: BenchHeroPatch) => void;
  /** TG / PP / both — fusion overlay shows only the matching hero lane. */
  onBenchSessionChange?: (mode: BenchSessionMode) => void;
}

const TG_PREDICT_OPTIONS = [256, 512, 1024, 2048, 4096];
const PP_TOKEN_OPTIONS = [8192, 16384, 32768, 65536, 100000];

function formatBenchK(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

export default function BenchWidget({
  port,
  compact = false,
  onHeroPatch,
  onBenchSessionChange,
}: BenchWidgetProps) {
  const ps = getBenchPortState(port);

  const [, setTick] = useState(0);
  const tick = () => setTick(t => t + 1);
  const benchAbortRef = useRef(false);

  useEffect(() => subscribeBenchPortStore(tick), []);

  /** Restore this port's cached results when navigating between running engines. */
  useEffect(() => {
    const state = getBenchPortState(port);
    if (!state.showResults) {
      onBenchSessionChange?.("idle");
      onHeroPatch?.({ tg: null, pp: null });
      return;
    }
    onBenchSessionChange?.(state.sessionMode);
    const heroPatch: BenchHeroPatch = {};
    if (state.tgResult?.success && state.tgResult.gen_tps > 0) {
      heroPatch.tg = state.tgResult.gen_tps;
    }
    if (state.ppResult?.success && state.ppResult.bench_prefill_tps > 0) {
      heroPatch.pp = state.ppResult.bench_prefill_tps;
    }
    onHeroPatch?.(heroPatch);
  }, [port, onBenchSessionChange, onHeroPatch]);

  const patchHero = (patch: BenchHeroPatch) => {
    onHeroPatch?.(patch);
  };

  const setSessionMode = (mode: BenchSessionMode) => {
    ps.sessionMode = mode;
    onBenchSessionChange?.(mode);
  };

  const handleBenchCancelled = () => {
    ps.showResults = false;
    ps.tgResult = null;
    ps.ppResult = null;
    setSessionMode("idle");
    patchHero({ tg: null, pp: null });
    benchAbortRef.current = true;
    tick();
  };

  const stopBench = async () => {
    benchAbortRef.current = true;
    try {
      await invoke("cmd_cancel_bench", { port });
    } catch {
      // Backend may already have finished; UI still resets when invoke returns.
    }
  };

  const clearBenchOnEngineStop = () => {
    resetAllBenchPortStates();
    onBenchSessionChange?.("idle");
    patchHero({ tg: null, pp: null });
    tick();
  };

  useTauriListen<{ slot: number }>("slot-cleared", clearBenchOnEngineStop);
  useTauriListen("engines-all-stopped", clearBenchOnEngineStop);

  useTauriListen<{ port: number; phase: string; effectiveLength?: number }>(
    "bench-tg-progress",
    (payload) => {
      if (payload.port !== port) return;
      ps.tgPhase = payload.phase as "warmup" | "measured";
      if (payload.effectiveLength != null) ps.tgEffectiveLength = payload.effectiveLength;
      tick();
    },
    [port],
  );

  useTauriListen<{ port: number; phase: string; effectiveLength?: number }>(
    "bench-pp-progress",
    (payload) => {
      if (payload.port !== port) return;
      ps.ppPhase = payload.phase as "warmup" | "measured";
      if (payload.effectiveLength != null) ps.ppEffectiveLength = payload.effectiveLength;
      tick();
    },
    [port],
  );

  const executeBenchTg = async (patchHeroOnSuccess = true): Promise<void> => {
    ps.tgRunning = true;
    ps.tgResult = null;
    ps.tgPhase = "warmup";
    ps.tgEffectiveLength = 1024;
    if (patchHeroOnSuccess) patchHero({ tg: null });
    tick();
    try {
      const res: bench_TGBenchResult = await invoke("cmd_burst_bench", {
        port,
        nPredict: ps.nPredict,
        benchPromptMode: ps.promptMode,
      });
      ps.tgResult = res;
      if (!res.success && res.error === "Cancelled") {
        handleBenchCancelled();
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
      tick();
    }
  };

  const executeBenchPp = async (patchHeroOnSuccess = true): Promise<void> => {
    ps.ppRunning = true;
    ps.ppResult = null;
    ps.ppPhase = "warmup";
    ps.ppEffectiveLength = 1024;
    if (patchHeroOnSuccess) patchHero({ pp: null });
    tick();
    try {
      const res: bench_PPBurstResult = await invoke("cmd_bench_pp_burst", {
        port,
        targetTokens: ps.ppTargetTokens,
        benchPromptMode: ps.promptMode,
      });
      ps.ppResult = res;
      if (!res.success && res.error === "Cancelled") {
        handleBenchCancelled();
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
      tick();
    }
  };

  const runBenchTg = async () => {
    if (ps.tgRunning || ps.ppRunning || !port) return;
    benchAbortRef.current = false;
    setSessionMode("tg");
    ps.showResults = true;
    ps.ppResult = null;
    patchHero({ tg: null, pp: null });
    tick();
    await executeBenchTg();
  };

  const runBenchPp = async () => {
    if (ps.tgRunning || ps.ppRunning || !port) return;
    benchAbortRef.current = false;
    setSessionMode("pp");
    ps.showResults = true;
    ps.tgResult = null;
    patchHero({ tg: null, pp: null });
    tick();
    await executeBenchPp();
  };

  const runBenchBoth = async () => {
    if (ps.tgRunning || ps.ppRunning || !port) return;
    benchAbortRef.current = false;
    setSessionMode("both");
    ps.showResults = true;
    ps.tgResult = null;
    ps.ppResult = null;
    patchHero({ tg: null, pp: null });
    tick();

    await executeBenchTg(false);
    if (benchAbortRef.current || ps.tgResult?.error === "Cancelled") return;

    await executeBenchPp(false);
    if (benchAbortRef.current || ps.ppResult?.error === "Cancelled") return;

    const heroPatch: BenchHeroPatch = {};
    if (ps.tgResult?.success && ps.tgResult.gen_tps > 0) heroPatch.tg = ps.tgResult.gen_tps;
    if (ps.ppResult?.success && ps.ppResult.bench_prefill_tps > 0) {
      heroPatch.pp = ps.ppResult.bench_prefill_tps;
    }
    patchHero(heroPatch);
    tick();
  };

  const cyclePromptMode = () => {
    ps.promptMode = ps.promptMode === "unique" ? "repetitive" : "unique";
    tick();
  };

  const isAnyRunning = ps.tgRunning || ps.ppRunning;
  const showTgResults =
    (ps.sessionMode === "tg" || ps.sessionMode === "both") && Boolean(ps.tgResult) && !ps.tgRunning;
  const showPpResults =
    (ps.sessionMode === "pp" || ps.sessionMode === "both") && Boolean(ps.ppResult) && !ps.ppRunning;
  const hasResults = showTgResults || showPpResults;

  const chipBtnClass = (active: boolean, disabled: boolean) =>
    `value-chip ${active ? "value-chip-active" : ""} whitespace-nowrap focus:outline-none cursor-pointer select-none disabled:opacity-30`;

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
    tick();
  };

  /** Fixed height — idle controls and PP/TG progress/results share the same footprint (no fusion layout jump). */
  const panelHeight = compact ? 66 : 78;
  const dualResults = ps.sessionMode === "both";
  const benchLabelClass = dualResults ? "text-[5px]" : "text-[6px]";
  const benchValueClass = dualResults
    ? (compact ? "text-[10px]" : "text-[15px]")
    : (compact ? "text-sm" : "text-xl");
  const benchUnitClass = dualResults ? "text-[5px]" : "text-[6px]";
  const benchRowPadClass = dualResults ? "gap-y-0 py-0" : (compact ? "gap-y-0 py-0" : "gap-y-0.5 py-0.5");
  const benchResultGridClass = `grid grid-cols-3 gap-x-2 px-1 ${benchRowPadClass}`;

  return (
      <div
        className={`bench-widget-panel w-full rounded-sm flex flex-col gap-1 overflow-hidden flex-shrink-0 ${compact ? "p-1" : "p-1.5"}`}
        style={{ height: panelHeight, minHeight: panelHeight }}
      >
        {!isAnyRunning && !ps.showResults && (
          <>
            <div className="flex items-center justify-end gap-1">
              <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-0.5">TG</span>
              {TG_PREDICT_OPTIONS.map((tok) => (
                <button
                  key={tok}
                  onClick={() => { ps.nPredict = tok; tick(); }}
                  disabled={isAnyRunning}
                  className={`px-1 py-0 text-[6px] font-mono rounded-sm ${chipBtnClass(ps.nPredict === tok, isAnyRunning)}`}
                >
                  {tok}
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

            <div className="flex items-center justify-end gap-1">
              <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-0.5">PP</span>
              {PP_TOKEN_OPTIONS.map((tok) => (
                <button
                  key={tok}
                  onClick={() => { ps.ppTargetTokens = tok; tick(); }}
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

            <div className="flex items-center justify-end gap-1">
              <button
                onClick={runBenchBoth}
                disabled={isAnyRunning}
                className={`${runBtnClass(isAnyRunning)}`}
                title="Run TG then PP with current token selections"
              >
                RUN BOTH
              </button>
              <button
                onClick={cyclePromptMode}
                disabled={isAnyRunning}
                className="bench-muted-btn px-1 py-0.5 text-[6px] font-mono rounded-sm focus:outline-none cursor-pointer select-none disabled:opacity-30"
              >
                {ps.promptMode === "unique" ? "Unique ▸" : "◂ Repetitive"}
              </button>
            </div>
          </>
        )}

        {ps.showResults && (
           <div className="px-1 flex flex-col flex-1 min-h-0 overflow-hidden">
             <div className="flex-1 min-h-0 overflow-hidden">
               {isAnyRunning && (
                 <div className="flex items-center justify-between gap-1.5 px-1 py-0.5">
                   <div className="flex items-center gap-1.5 min-w-0">
                     <span className="inline-block w-1 h-1 bg-yellow-400 rounded-full animate-pulse flex-shrink-0" />
                     <span className="text-[7px] font-mono text-stealth-muted truncate">
                       {ps.tgRunning
                         ? (ps.tgPhase === "warmup"
                           ? `TG WARMUP (${ps.tgEffectiveLength ?? 1024} tok)`
                           : `TG (${ps.nPredict} tok)...`)
                         : ps.ppRunning
                           ? (ps.ppPhase === "warmup"
                             ? `PP WARMUP (${formatBenchK(ps.ppEffectiveLength ?? 1024)} tok)`
                             : `PP (${formatBenchK(ps.ppTargetTokens)} tok)...`)
                           : ""}
                     </span>
                   </div>
                   <button
                     type="button"
                     onClick={() => { void stopBench(); }}
                     className={stopBtnClass}
                     title="Cancel in-flight benchmark request"
                   >
                     STOP
                   </button>
                 </div>
               )}

               {showTgResults && ps.tgResult && (
                ps.tgResult.success ? (
                  <div className={benchResultGridClass}>
                    <div>
                      <p className={`${benchLabelClass} font-mono text-stealth-muted uppercase tracking-wider`}>REQUEST LENGTH</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none ${benchValueClass}`}>{ps.tgResult.gen_tokens}</p>
                      <p className={`${benchUnitClass} font-mono text-stealth-muted/50`}>generated</p>
                    </div>
                    <div>
                      <p className={`${benchLabelClass} font-mono text-stealth-muted uppercase tracking-wider`}>GENERATION</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none ${benchValueClass}`}>{ps.tgResult.gen_tps.toFixed(1)}</p>
                      <p className={`${benchUnitClass} font-mono text-stealth-muted/50`}>tok/s</p>
                    </div>
                    <div>
                      <p className={`${benchLabelClass} font-mono text-stealth-muted uppercase tracking-wider`}>ITL</p>
                      <p className={`font-mono fusion-readout-emphasis leading-none ${benchValueClass}`}>{ps.tgResult.itl_ms.toFixed(2)}</p>
                      <p className={`${benchUnitClass} font-mono text-stealth-muted/50`}>ms</p>
                    </div>
                  </div>
                ) : (
                  <p className="text-[7px] font-mono text-red-400 px-1 py-0.5">TG FAILED: {ps.tgResult.error || "unknown"}</p>
                )
              )}

              {showPpResults && ps.ppResult && (
                ps.ppResult.success ? (
                  <div className={benchResultGridClass}>
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
                ) : (
                  <p className="text-[7px] font-mono text-red-400 px-1 py-0.5">PP FAILED: {ps.ppResult.error || "unknown"}</p>
                )
              )}
             </div>

            {!isAnyRunning && hasResults && (
              <div className="flex justify-end flex-shrink-0 pt-0.5">
                <button
                  onClick={closeResults}
                  className="bench-muted-btn text-[6px] font-mono transition-colors px-1.5 py-0.5 rounded-sm leading-none"
                >
                  CLOSE THE RESULTS
                </button>
              </div>
            )}
          </div>
        )}
      </div>
    );
}
