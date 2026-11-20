import { useCallback, useEffect, useState } from "react";
import {
  ensureTuneStatusSubscription,
  getTuneStatus,
  markTuneFinished,
  markTuneStarted,
  subscribeTuneStatus,
} from "../lib/moeTuneStatus";
import { invoke } from "@tauri-apps/api/core";

/** Shape returned by the Rust `moe_tune_run` command. */
interface MoeTuneComponents {
  model_mib: number;
  kv_mib: number;
  compute_mib: number;
  host_mib: number;
}

interface MoeTunePoint {
  cpu_moe: boolean;
  cache_mib: number;
  cpu_share: number;
  tps: number | null;
  error: string | null;
  vram_used_mib: number | null;
  vram_free_mib: number | null;
  components: MoeTuneComponents | null;
}

interface MoeTuneReport {
  points: MoeTunePoint[];
  best: { cpu_moe: boolean; cache_mib: number; cpu_share: number } | null;
  best_tps: number | null;
  baseline_tps: number | null;
  full_gpu_tps: number | null;
  full_gpu_error: string | null;
  budget_mib: number;
  seconds: number;
  measured_at: string;
  driver_version: string | null;
  engine_build: string | null;
  start_free_mib: number;
  cancelled: boolean;
  pair_runs: { label: string; cache_mib: number; cpu_share: number; tps: number | null }[];
  gain_pct: number | null;
  noise_pct: number | null;
  verdict: string | null;
}

/** Confirmation line: how the winner did against the baseline when they alternated. */
function verdictLine(report: MoeTuneReport): string | null {
  if (!report.verdict) return null;
  const gain = report.gain_pct != null ? `${report.gain_pct >= 0 ? "+" : ""}${report.gain_pct.toFixed(0)}%` : "";
  const noise = report.noise_pct != null ? ` +/-${report.noise_pct.toFixed(1)}%` : "";
  const label =
    report.verdict === "improved" ? "confirmed" : report.verdict === "flat" ? "no gain" : "inconclusive";
  return `${label} ${gain}${noise}`.trim();
}

interface MoeCacheTuneProps {
  config: Record<string, any>;
  modelPath: string | null;
  modelIsMoe: boolean;
  providerId: string;
  updateParam: (key: string, value: string | number) => void;
}

function gilb(mib: number): string {
  return `${(mib / 1024).toFixed(1)} GiB`;
}

/** "3d ago", "12m ago" - enough to judge whether a stored run is still believable. */
function relativeAge(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "?";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 90) return "just now";
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

/** The VRAM the winning configuration actually asked for, and what it was made of. */
function vramLine(report: MoeTuneReport): string | null {
  const best = report.best;
  if (!best) return null;
  const point = report.points.find(
    (p) => p.cpu_moe === best.cpu_moe && p.cache_mib === best.cache_mib && p.cpu_share === best.cpu_share,
  );
  if (!point?.vram_used_mib) return null;
  const c = point.components;
  const parts = c
    ? ` (model ${(c.model_mib / 1024).toFixed(1)} + kv ${(c.kv_mib / 1024).toFixed(1)} + compute ${(c.compute_mib / 1024).toFixed(1)}${best.cpu_moe ? ` + cache ${(best.cache_mib / 1024).toFixed(1)}` : ""})`
    : "";
  return `VRAM ${gilb(point.vram_used_mib)}${parts}`;
}

/**
 * Measures the expert cache instead of guessing it: three real launches (cache off, a quarter and
 * three quarters of the free VRAM, plus CPU compute for the misses) and reports the measured t/s.
 * Results are STAGED - the knobs change only when the user applies them.
 */
export function MoeCacheTune({ config, modelPath, modelIsMoe, providerId, updateParam }: MoeCacheTuneProps) {
  const [status, setStatus] = useState(getTuneStatus);
  const running = status.running;
  const done = status.done;
  const total = status.total;
  const [report, setReport] = useState<MoeTuneReport | null>(null);
  const [staged, setStaged] = useState<{
    cpu_moe: boolean;
    cache_mib: number;
    cpu_share: number;
  } | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stopping, setStopping] = useState(false);
  /** Last stored run for this exact model + placement, loaded on mount. */
  const [history, setHistory] = useState<MoeTuneReport | null>(null);

  useEffect(() => {
    if (!modelPath) {
      setHistory(null);
      return;
    }
    let cancelled = false;
    void invoke<MoeTuneReport | null>("moe_tune_history", {
      modelPath,
      ctxSize: Number(config.ctx) || 32768,
      kvQuant: String(config.kv_quant ?? "f16"),
      splitMode: String(config.split ?? "none"),
      tensorSplit: config.tensor_split ? String(config.tensor_split) : null,
      device: String(config.device ?? "GPU-0"),
    })
      .then((stored) => {
        if (!cancelled) setHistory(stored);
      })
      .catch(() => {
        if (!cancelled) setHistory(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    modelPath,
    config.ctx,
    config.kv_quant,
    config.split,
    config.tensor_split,
    config.device,
  ]);

  // The subscription is page-wide (see lib/moeTuneStatus): a remount re-reads the live status.
  useEffect(() => {
    ensureTuneStatusSubscription();
    return subscribeTuneStatus(() => setStatus(getTuneStatus()));
  }, []);

  const canRun = !running && modelIsMoe && !!modelPath;

  const run = useCallback(async () => {
    if (!modelPath || running) return;
    markTuneStarted();
    setStatus(getTuneStatus());
    setError(null);
    setReport(null);
    setStaged(null);
    setApplied(false);
    try {
      const result = await invoke<MoeTuneReport>("moe_tune_run", {
        modelPath,
        providerId,
        ctxSize: Number(config.ctx) || 32768,
        kvQuant: String(config.kv_quant ?? "f16"),
        device: String(config.device ?? "GPU-0"),
        splitMode: String(config.split ?? "none"),
        tensorSplit: config.tensor_split ? String(config.tensor_split) : null,
        batch: Number(config.batch) || 2048,
        ubatch: Number(config.ubatch) || 512,
      });
      setReport(result);
      if (result.best) setStaged(result.best);
      const failed = result.points.filter((p) => p.tps == null);
      if (!result.best) {
        const first = failed[0]?.error;
        setError(first ?? "every calibration run failed - see the engine log");
      }
    } catch (e) {
      setError(String(e));
    } finally {
      markTuneFinished();
      setStatus(getTuneStatus());
    }
  }, [config, modelPath, providerId, running]);

  const stop = useCallback(async () => {
    setStopping(true);
    try {
      await invoke("moe_tune_stop");
    } catch (e) {
      setError(String(e));
    } finally {
      // The run itself resolves the promise; `running` clears there.
      setStopping(false);
    }
  }, []);

  const apply = useCallback(() => {
    if (!staged) return;
    // The winner may be "leave the experts on the GPU" - then -cmoe must go away too.
    updateParam("cpu_moe", staged.cpu_moe ? "on" : "off");
    updateParam("moe_cache_mib", staged.cache_mib);
    updateParam("moe_cache_cpu_share", staged.cpu_share);
    setStaged(null);
    setApplied(true);
  }, [staged, updateParam]);

  const label = running
    ? stopping
      ? "STOPPING…"
      : total > 0
        ? `STOP ${done}/${total}`
        : "STOP"
    : "TUNE";
  // A win over the CPU-expert launch is what the cache buys; a win over the all-on-GPU launch is
  // what keeps the cache honest on a card that already fits the model.
  const gain =
    report?.best_tps != null && report.baseline_tps != null && report.baseline_tps > 0
      ? report.best_tps / report.baseline_tps - 1
      : null;
  const gpuGain =
    report?.best_tps != null && report.full_gpu_tps != null && report.full_gpu_tps > 0
      ? report.best_tps / report.full_gpu_tps - 1
      : null;

  return (
    <span className="moe-tune">
      <button
        type="button"
        className={`value-chip font-mono moe-tune__btn${running ? " is-running" : ""}`}
        onClick={() => {
          if (running) {
            void stop();
          } else {
            void run();
          }
        }}
        disabled={running ? stopping : !canRun}
        title={
          modelIsMoe
            ? "Measure decode speed for cache sizes and CPU share (three launches, ~2 min)"
            : "Dense model - no expert cache to tune"
        }
      >
        {label}
      </button>
      {history?.best && !staged && !running && (
        <>
          <span
            className="moe-tune__staged type-micro font-mono"
            title={
              [
                `measured ${relativeAge(history.measured_at)}`,
                history.engine_build ? `engine ${history.engine_build}` : null,
                history.driver_version ? `driver ${history.driver_version}` : null,
                `free at start ${history.start_free_mib} MiB`,
              ]
                .filter(Boolean)
                .join(" · ")
            }
          >
            stored:{" "}
            {history.best.cpu_moe
              ? `${gilb(history.best.cache_mib)} · share ${history.best.cpu_share.toFixed(2)}`
              : "full GPU · no cache"}
            {history.best_tps != null ? ` · ${history.best_tps.toFixed(1)} t/s` : ""}
            {vramLine(history) ? ` · ${vramLine(history)}` : ""}
            {` · ${relativeAge(history.measured_at)}`}
          </span>
          <button
            type="button"
            className="value-chip font-mono moe-tune__btn"
            onClick={() => {
              setStaged(history.best);
              setReport(history);
            }}
            title="Stage the stored values again without re-running the calibration"
          >
            REUSE
          </button>
        </>
      )}
      {staged && !running && (
        <>
          <span
            className="moe-tune__staged type-micro font-mono"
            title={
              staged.cpu_moe
                ? "Measured with experts in host RAM; not applied yet"
                : "The model fits fully on the GPU - no expert cache is needed"
            }
          >
            {staged.cpu_moe
              ? `${gilb(staged.cache_mib)} · share ${staged.cpu_share.toFixed(2)}`
              : "full GPU · no cache"}
            {report?.best_tps != null ? ` · ${report.best_tps.toFixed(1)} t/s` : ""}
            {staged.cpu_moe && gain != null ? ` (+${(gain * 100).toFixed(0)}% vs CPU)` : ""}
            {report && verdictLine(report) ? ` | ${verdictLine(report)}` : ""}
            {!staged.cpu_moe && gpuGain != null && gpuGain > 0
              ? ` (+${(gpuGain * 100).toFixed(0)}% vs best cache)`
              : ""}
          </span>
          <button
            type="button"
            className="value-chip font-mono moe-tune__btn moe-tune__btn--apply"
            onClick={apply}
            title="Write both knobs into the launch config"
          >
            APPLY
          </button>
          <button
            type="button"
            className="value-chip font-mono moe-tune__btn"
            onClick={() => setStaged(null)}
            title="Drop the measured values"
          >
            DISCARD
          </button>
        </>
      )}
      {report?.cancelled && !running && (
        <span className="moe-tune__staged type-micro font-mono" title="Stopped part-way; the points measured before the stop are kept">
          stopped after {report.points.filter((p) => p.tps != null).length} measurements
        </span>
      )}
      {report && !staged && !running && !applied && vramLine(report) && (
        <span className="moe-tune__staged type-micro font-mono">{vramLine(report)}</span>
      )}
      {applied && !staged && !running && (
        <span className="moe-tune__staged type-micro font-mono">applied</span>
      )}
      {error && !running && (
        <span className="moe-tune__error type-micro font-mono" title={error}>
          {error.split("\n")[0]}
        </span>
      )}
    </span>
  );
}
