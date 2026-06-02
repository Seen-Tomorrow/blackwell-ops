import { useState, useRef, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { bench_TGBenchResult, bench_PPBurstResult, bench_PromptMode } from "../lib/types";

interface BenchWidgetProps {
  port: number;
  variant?: "compact" | "expanded";
}

const TG_PREDICT_OPTIONS = [256, 512, 1024, 4096];
const PP_TOKEN_OPTIONS = [8192, 16384, 32768, 65536];

function formatBenchK(n: number): string {
  if (n >= 1000) return `${Math.floor(n / 1000)}K`;
  return n.toString();
}

export default function BenchWidget({ port, variant = "compact" }: BenchWidgetProps) {
  // ── TG Bench state ──────────────────────────────
  const [bench_tgRunning, setBenchTgRunning] = useState(false);
  const [bench_tgResult, setBenchTgResult] = useState<bench_TGBenchResult | null>(null);
  const [bench_nPredict, setBenchNpredict] = useState(256);
  const [bench_promptMode, setBenchPromptMode] = useState<bench_PromptMode>("unique");

  // ── PP Burst state ──────────────────────────────
  const [bench_ppRunning, setBenchPpRunning] = useState(false);
  const [bench_ppResult, setBenchPpResult] = useState<bench_PPBurstResult | null>(null);
  const [bench_ppTargetTokens, setBenchPpTargetTokens] = useState(8192);

  // ── UI state ────────────────────────────────────
  const [bench_showResults, setBenchShowResults] = useState(false);

  // ── TG Bench handler ────────────────────────────
  const runBenchTg = async () => {
    if (bench_tgRunning || !port) return;
    setBenchTgRunning(true);
    setBenchTgResult(null);
    setBenchShowResults(true);
    try {
      const res: bench_TGBenchResult = await invoke("cmd_burst_bench", {
        port,
        nPredict: bench_nPredict,
        benchPromptMode: bench_promptMode,
      });
      setBenchTgResult(res);
    } catch (e) {
      const errMsg = typeof e === "string" ? e : String(e);
      setBenchTgResult({
        prompt_tokens: 0, gen_tokens: 0,
        prompt_tps: 0, gen_tps: 0, itl_ms: 0,
        success: false, error: errMsg,
      });
    } finally {
      setBenchTgRunning(false);
    }
  };

  // ── PP Burst handler ────────────────────────────
  const runBenchPp = async () => {
    if (bench_ppRunning || !port) return;
    setBenchPpRunning(true);
    setBenchPpResult(null);
    setBenchShowResults(true);
    try {
      const res: bench_PPBurstResult = await invoke("cmd_bench_pp_burst", {
        port,
        targetTokens: bench_ppTargetTokens,
        benchPromptMode: bench_promptMode,
      });
      setBenchPpResult(res);
    } catch (e) {
      const errMsg = typeof e === "string" ? e : String(e);
      setBenchPpResult({
        bench_prefill_tps: 0, bench_prompt_tokens_actual: 0,
        success: false, error: errMsg,
      });
    } finally {
      setBenchPpRunning(false);
    }
  };

  // ── Prompt mode toggle ──────────────────────────
  const cyclePromptMode = () => {
    setBenchPromptMode(prev => prev === "unique" ? "repetitive" : "unique");
  };

  const isAnyRunning = bench_tgRunning || bench_ppRunning;
  const hasResults = (bench_tgResult && !bench_tgRunning) || (bench_ppResult && !bench_ppRunning);

  // ── Shared button classes ───────────────────────
  const chipBtnClass = (active: boolean, disabled: boolean) =>
    `value-chip ${active ? "value-chip-active" : ""} whitespace-nowrap focus:outline-none cursor-pointer select-none disabled:opacity-30`;

  const runBtnClass = (disabled: boolean) =>
    `text-[7px] font-bold tracking-wider px-1.5 py-0.5 rounded bg-green-600/80 hover:bg-green-500 active:bg-green-700 text-white cursor-pointer select-none disabled:opacity-30`;

  // ── Compact variant (FusionOverlay) ─────────────
  if (variant === "compact") {
    return (
      <div className="border border-green-500/20 bg-black/15 rounded-sm p-1.5 flex flex-col gap-1">
        {/* Controls — visible when not running and results are hidden */}
        {!isAnyRunning && !bench_showResults && (
          <>
            {/* TG Bench row — tokens + RUN inline */}
            <div className="flex items-center justify-end gap-1">
              <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-0.5">TG</span>
              {TG_PREDICT_OPTIONS.map((tok) => (
                <button
                  key={tok}
                  onClick={() => setBenchNpredict(tok)}
                  disabled={isAnyRunning}
                  className={`px-1 py-0 text-[6px] font-mono rounded-sm ${chipBtnClass(bench_nPredict === tok, isAnyRunning)}`}
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

            {/* PP Burst row — tokens + RUN inline */}
            <div className="flex items-center justify-end gap-1">
              <span className="text-[6px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-0.5">PP</span>
              {PP_TOKEN_OPTIONS.map((tok) => (
                <button
                  key={tok}
                  onClick={() => setBenchPpTargetTokens(tok)}
                  disabled={isAnyRunning}
                  className={`px-1 py-0 text-[6px] font-mono rounded-sm ${chipBtnClass(bench_ppTargetTokens === tok, isAnyRunning)}`}
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

            {/* Mode toggle row */}
            <div className="flex items-center justify-end gap-1">
              <button
                onClick={cyclePromptMode}
                disabled={isAnyRunning}
                className={`px-1 py-0 text-[6px] font-mono rounded-sm ${chipBtnClass(false, isAnyRunning)}`}
              >
                {bench_promptMode === "unique" ? "Unique ▸" : "◂ Repetitive"}
              </button>
            </div>
          </>
        )}

        {/* ── Results panel — fixed height, always visible when showResults ═══ */}
        {bench_showResults && (
          <div className="border-t border-green-500/20 bg-black/30 pt-1 min-h-[48px]">
            {/* Running indicator */}
            {isAnyRunning && (
              <div className="flex items-center gap-1.5 px-1 py-0.5">
                <span className="inline-block w-1 h-1 bg-yellow-400 rounded-full animate-pulse" />
                <span className="text-[7px] font-mono text-stealth-muted">
                  {bench_tgRunning ? `TG (${bench_nPredict} tok)...` : bench_ppRunning ? `PP (${formatBenchK(bench_ppTargetTokens)} tok)...` : ""}
                </span>
              </div>
            )}

            {/* TG Results */}
            {bench_tgResult && !bench_tgRunning && (
              bench_tgResult.success ? (
                <div className="grid grid-cols-4 gap-x-2 gap-y-0.5 px-1 py-0.5">
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">PREFILL</p>
                    <p className="text-[9px] font-mono text-telemetry-amber">{bench_tgResult.prompt_tps.toFixed(1)} TPS</p>
                  </div>
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">GENERATION</p>
                    <p className="text-[9px] font-mono text-nv-green">{bench_tgResult.gen_tps.toFixed(1)} TPS</p>
                  </div>
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">ITL</p>
                    <p className="text-[9px] font-mono text-white">{bench_tgResult.itl_ms.toFixed(2)} ms</p>
                  </div>
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">TOKENS</p>
                    <p className="text-[9px] font-mono text-white">{bench_tgResult.prompt_tokens}P / {bench_tgResult.gen_tokens}G</p>
                  </div>
                </div>
              ) : (
                <p className="text-[7px] font-mono text-red-400 px-1 py-0.5">TG FAILED: {bench_tgResult.error || "unknown"}</p>
              )
            )}

            {/* PP Results */}
            {bench_ppResult && !bench_ppRunning && (
              bench_ppResult.success ? (
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 px-1 py-0.5">
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">PREFILL</p>
                    <p className="text-[9px] font-mono text-telemetry-amber">{bench_ppResult.bench_prefill_tps.toFixed(1)} TPS</p>
                  </div>
                  <div>
                    <p className="text-[6px] font-mono text-stealth-muted uppercase tracking-wider">TOKENS</p>
                    <p className="text-[9px] font-mono text-white">{formatBenchK(bench_ppResult.bench_prompt_tokens_actual)}</p>
                  </div>
                </div>
              ) : (
                <p className="text-[7px] font-mono text-red-400 px-1 py-0.5">PP FAILED: {bench_ppResult.error || "unknown"}</p>
              )
            )}

            {/* Close button — reveal controls again */}
            {!isAnyRunning && hasResults && (
              <button
                onClick={() => {
                  setBenchShowResults(false);
                  if (!isAnyRunning) {
                    setBenchTgResult(null);
                    setBenchPpResult(null);
                  }
                }}
                className="text-[6px] font-mono text-stealth-muted hover:text-white transition-colors px-1 py-0.5"
              >
                CLOSE
              </button>
            )}
          </div>
        )}
      </div>
    );
  }

  // ── Expanded variant (SlotLogPanel) ─────────────
  return (
    <div className="border border-green-500/20 bg-black/20 rounded-sm p-2 flex flex-col gap-1.5">
      {/* Controls — visible when not running and results are hidden */}
      {!isAnyRunning && !bench_showResults && (
        <>
          {/* TG Bench row — tokens + RUN inline */}
          <div className="flex items-center justify-end gap-1">
            <span className="text-[8px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-1">TG</span>
            {TG_PREDICT_OPTIONS.map((tok) => (
              <button
                key={tok}
                onClick={() => setBenchNpredict(tok)}
                disabled={isAnyRunning}
                className={`px-2 py-0.5 text-[8px] font-mono rounded-sm ${chipBtnClass(bench_nPredict === tok, isAnyRunning)}`}
              >
                {tok}
              </button>
            ))}
            <button
              onClick={runBenchTg}
              disabled={isAnyRunning}
              className={`${runBtnClass(isAnyRunning)} ml-1`}
            >
              RUN
            </button>
          </div>

          {/* PP Burst row — tokens + RUN inline */}
          <div className="flex items-center justify-end gap-1">
            <span className="text-[8px] font-mono text-stealth-muted/40 tracking-wider flex-shrink-0 mr-1">PP</span>
            {PP_TOKEN_OPTIONS.map((tok) => (
              <button
                key={tok}
                onClick={() => setBenchPpTargetTokens(tok)}
                disabled={isAnyRunning}
                className={`px-2 py-0.5 text-[8px] font-mono rounded-sm ${chipBtnClass(bench_ppTargetTokens === tok, isAnyRunning)}`}
              >
                {formatBenchK(tok)}
              </button>
            ))}
            <button
              onClick={runBenchPp}
              disabled={isAnyRunning}
              className={`${runBtnClass(isAnyRunning)} ml-1`}
            >
              RUN
            </button>
          </div>

          {/* Mode toggle row */}
          <div className="flex items-center justify-end gap-1">
            <button
              onClick={cyclePromptMode}
              disabled={isAnyRunning}
              className={`px-2 py-0.5 text-[8px] font-mono rounded-sm ${chipBtnClass(false, isAnyRunning)}`}
            >
              {bench_promptMode === "unique" ? "Unique ▸" : "◂ Repetitive"}
            </button>
          </div>
        </>
      )}

      {/* ── Results panel — fixed height, always visible when showResults ═══ */}
      {bench_showResults && (
        <div className="border-t border-green-500/20 bg-black/30 pt-1 min-h-[64px]">
          {/* Running indicator */}
          {isAnyRunning && (
            <div className="flex items-center gap-2 px-2 py-1">
              <span className="inline-block w-1.5 h-1.5 bg-yellow-400 rounded-full animate-pulse" />
              <span className="text-[9px] font-mono text-stealth-muted">
                {bench_tgRunning ? `TG (${bench_nPredict} tok)...` : bench_ppRunning ? `PP (${formatBenchK(bench_ppTargetTokens)} tok)...` : ""}
              </span>
            </div>
          )}

          {/* TG Results */}
          {bench_tgResult && !bench_tgRunning && (
            bench_tgResult.success ? (
              <div className="grid grid-cols-4 gap-x-5 gap-y-2 px-2 py-1">
                <div>
                  <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">PREFILL</p>
                  <p className="text-xs font-mono text-telemetry-amber">{bench_tgResult.prompt_tps.toFixed(1)} TPS</p>
                </div>
                <div>
                  <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">GENERATION</p>
                  <p className="text-xs font-mono text-nv-green">{bench_tgResult.gen_tps.toFixed(1)} TPS</p>
                </div>
                <div>
                  <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">ITL</p>
                  <p className="text-xs font-mono text-white">{bench_tgResult.itl_ms.toFixed(2)} ms</p>
                </div>
                <div>
                  <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">TOKENS</p>
                  <p className="text-xs font-mono text-white">{bench_tgResult.prompt_tokens}P / {bench_tgResult.gen_tokens}G</p>
                </div>
              </div>
            ) : (
              <p className="text-[9px] font-mono text-red-400 px-2 py-1">TG FAILED: {bench_tgResult.error || "unknown"}</p>
            )
          )}

          {/* PP Results */}
          {bench_ppResult && !bench_ppRunning && (
            bench_ppResult.success ? (
              <div className="grid grid-cols-2 gap-x-5 gap-y-2 px-2 py-1">
                <div>
                  <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">PREFILL</p>
                  <p className="text-xs font-mono text-telemetry-amber">{bench_ppResult.bench_prefill_tps.toFixed(1)} TPS</p>
                </div>
                <div>
                  <p className="text-[8px] font-mono text-stealth-muted uppercase tracking-wider">TOKENS</p>
                  <p className="text-xs font-mono text-white">{formatBenchK(bench_ppResult.bench_prompt_tokens_actual)}</p>
                </div>
              </div>
            ) : (
              <p className="text-[9px] font-mono text-red-400 px-2 py-1">PP FAILED: {bench_ppResult.error || "unknown"}</p>
            )
          )}

          {/* Close button — reveal controls again */}
          {!isAnyRunning && hasResults && (
            <button
              onClick={() => {
                setBenchShowResults(false);
                if (!isAnyRunning) {
                  setBenchTgResult(null);
                  setBenchPpResult(null);
                }
              }}
              className="text-[8px] font-mono text-stealth-muted hover:text-white transition-colors px-2 py-0.5"
            >
              CLOSE
            </button>
          )}
        </div>
      )}
    </div>
  );
}