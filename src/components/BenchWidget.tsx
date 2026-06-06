import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { bench_TGBenchResult, bench_PPBurstResult, bench_PromptMode } from "../lib/types";
import { useTauriListen } from "../hooks/useTauriListen";

interface BenchWidgetProps {
  port: number;
}

const TG_PREDICT_OPTIONS = [256, 512, 1024, 4096];
const PP_TOKEN_OPTIONS = [8192, 16384, 32768, 65536, 100000];

function formatBenchK(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

interface BenchPortState {
  tgRunning: boolean;
  tgResult: bench_TGBenchResult | null;
  tgPhase: "warmup" | "measured" | null;
  tgEffectiveLength: number | null;  // from progress event (fixed 1024 in warmup, user nPredict in measured)
  nPredict: number;
  promptMode: bench_PromptMode;
  ppRunning: boolean;
  ppResult: bench_PPBurstResult | null;
  ppPhase: "warmup" | "measured" | null;
  ppEffectiveLength: number | null;  // from progress event (fixed 1024 in warmup, user target in measured)
  ppTargetTokens: number;
  showResults: boolean;
}

function defaultBenchState(): BenchPortState {
  return {
    tgRunning: false,
    tgResult: null,
    tgPhase: null,
    tgEffectiveLength: null,
    nPredict: 256,
    promptMode: "unique",
    ppRunning: false,
    ppResult: null,
    ppPhase: null,
    ppEffectiveLength: null,
    ppTargetTokens: 8192,
    showResults: false,
  };
}

// Per-port bench state — survives engine switches without remounting
const portStates = new Map<number, BenchPortState>();

export default function BenchWidget({ port }: BenchWidgetProps) {
  let ps = portStates.get(port);
  if (!ps) {
    ps = defaultBenchState();
    portStates.set(port, ps);
  }

  const [, setTick] = useState(0);
  const tick = () => setTick(t => t + 1);

  useTauriListen<{ slot: number }>("slot-cleared", () => {
    portStates.clear();
    tick();
  });

  useTauriListen("engines-all-stopped", () => {
    portStates.clear();
    tick();
  });

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

  const runBenchTg = async () => {
    if (ps.tgRunning || !port) return;
    ps.tgRunning = true;
    ps.tgResult = null;
    ps.tgPhase = "warmup";
    ps.tgEffectiveLength = 1024;  // will be overridden by first progress event
    ps.showResults = true;
    tick();
    try {
      const res: bench_TGBenchResult = await invoke("cmd_burst_bench", {
        port,
        nPredict: ps.nPredict,
        benchPromptMode: ps.promptMode,
      });
      ps.tgResult = res;
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

  const runBenchPp = async () => {
    if (ps.ppRunning || !port) return;
    ps.ppRunning = true;
    ps.ppResult = null;
    ps.ppPhase = "warmup";
    ps.ppEffectiveLength = 1024;  // will be overridden by first progress event (fixed for warmup)
    ps.showResults = true;
    tick();
    try {
      const res: bench_PPBurstResult = await invoke("cmd_bench_pp_burst", {
        port,
        targetTokens: ps.ppTargetTokens,
        benchPromptMode: ps.promptMode,
      });
      ps.ppResult = res;
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

  const cyclePromptMode = () => {
    ps.promptMode = ps.promptMode === "unique" ? "repetitive" : "unique";
    tick();
  };

  const isAnyRunning = ps.tgRunning || ps.ppRunning;
  const hasResults = (ps.tgResult && !ps.tgRunning) || (ps.ppResult && !ps.ppRunning);

  const chipBtnClass = (active: boolean, disabled: boolean) =>
    `value-chip ${active ? "value-chip-active" : ""} whitespace-nowrap focus:outline-none cursor-pointer select-none disabled:opacity-30`;

  const runBtnClass = (disabled: boolean) =>
    `text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-green-600/80 hover:bg-green-500 active:bg-green-700 text-white cursor-pointer select-none disabled:opacity-30`;

  const closeResults = () => {
    ps.showResults = false;
    if (!isAnyRunning) {
      ps.tgResult = null;
      ps.ppResult = null;
    }
    tick();
  };

  return (
      <div className="w-full rounded-sm p-1.5 flex flex-col gap-1" style={{ boxShadow: 'inset 0 2px 8px rgba(0,0,0,0.6)', height: 60 }}>
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
                onClick={cyclePromptMode}
                disabled={isAnyRunning}
                className="px-1 py-0.5 text-[6px] font-mono bg-black text-white/70 rounded-sm focus:outline-none cursor-pointer select-none disabled:opacity-30"
              >
                {ps.promptMode === "unique" ? "Unique ▸" : "◂ Repetitive"}
              </button>
            </div>
          </>
        )}

        {ps.showResults && (
           <div className="pt-1 pb-1 px-1 flex-1">
             {isAnyRunning && (
               <div className="flex items-center gap-1.5 px-1 py-0.5">
                 <span className="inline-block w-1 h-1 bg-yellow-400 rounded-full animate-pulse" />
                 <span className="text-[7px] font-mono text-stealth-muted">
                   {ps.tgRunning ? (ps.tgPhase === "warmup" ? `TG WARMUP (${ps.tgEffectiveLength ?? 1024} tok)` : `TG (${ps.nPredict} tok)...`) : ps.ppRunning ? (ps.ppPhase === "warmup" ? `PP WARMUP (${formatBenchK(ps.ppEffectiveLength ?? 1024)} tok)` : `PP (${formatBenchK(ps.ppTargetTokens)} tok)...`) : ""}
                 </span>
               </div>
             )}

             {ps.tgResult && !ps.tgRunning && (
              ps.tgResult.success ? (
                <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 px-1 py-0.5">
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">PROMPT</p>
                    <p className="text-xl font-mono text-telemetry-amber">{ps.tgResult.prompt_tps.toFixed(1)}</p>
                    <p className="text-[6px] font-mono text-stealth-muted/50">{ps.tgResult.prompt_tokens} tok</p>
                  </div>
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">GENERATION</p>
                    <p className="text-xl font-mono text-nv-green">{ps.tgResult.gen_tps.toFixed(1)}</p>
                  </div>
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">ITL</p>
                    <p className="text-sm font-mono text-black">{ps.tgResult.itl_ms.toFixed(2)} ms</p>
                  </div>
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">REQUEST LENGTH</p>
                    <p className="text-sm font-mono text-black">{ps.tgResult.gen_tokens} Generated</p>
                  </div>
                </div>
              ) : (
                <p className="text-[7px] font-mono text-red-400 px-1 py-0.5">TG FAILED: {ps.tgResult.error || "unknown"}</p>
              )
            )}

            {ps.ppResult && !ps.ppRunning && (
              ps.ppResult.success ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 px-1 py-0.5">
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">PREFILL</p>
                    <p className="text-[9px] font-mono text-telemetry-amber">{ps.ppResult.bench_prefill_tps.toFixed(1)} TPS</p>
                  </div>
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">TOKENS</p>
                    {/* Raw number (e.g. 8000 not 8K) per request -- "looks more dramatic" for PP bench results */}
                    <p className="text-[9px] font-mono text-white">{ps.ppResult.bench_prompt_tokens_actual.toLocaleString()}</p>
                  </div>
                </div>
              ) : (
                <p className="text-[7px] font-mono text-red-400 px-1 py-0.5">PP FAILED: {ps.ppResult.error || "unknown"}</p>
              )
            )}

            {!isAnyRunning && hasResults && (
              <div className="flex justify-end -mt-[8px]">
                <button
                  onClick={closeResults}
                  className="text-[6px] font-mono bg-black text-white/60 hover:text-white transition-colors px-1.5 py-0.5 rounded-sm"
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
