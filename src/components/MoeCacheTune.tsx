import { useCallback, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTauriListen } from "../hooks/useTauriListen";

/** Shape returned by the Rust `moe_tune_run` command. */
interface MoeTunePoint {
  cache_mib: number;
  cpu_share: number;
  tps: number | null;
  error: string | null;
}

interface MoeTuneReport {
  points: MoeTunePoint[];
  best: { cache_mib: number; cpu_share: number } | null;
  best_tps: number | null;
  baseline_tps: number | null;
  budget_mib: number;
  seconds: number;
}

interface TuneProgress {
  index: number;
  total: number;
  status: "running" | "done";
  tps?: number | null;
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

/**
 * Measures the expert cache instead of guessing it: three real launches (cache off, a quarter and
 * three quarters of the free VRAM, plus CPU compute for the misses) and reports the measured t/s.
 * Results are STAGED - the knobs change only when the user applies them.
 */
export function MoeCacheTune({ config, modelPath, modelIsMoe, providerId, updateParam }: MoeCacheTuneProps) {
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [total, setTotal] = useState(0);
  const [report, setReport] = useState<MoeTuneReport | null>(null);
  const [staged, setStaged] = useState<{ cache_mib: number; cpu_share: number } | null>(null);
  const [applied, setApplied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useTauriListen<TuneProgress>("moe-tune-progress", (evt) => {
    if (!evt) return;
    setTotal(evt.total);
    setDone(evt.status === "done" ? evt.index + 1 : evt.index);
  });

  const canRun = !running && modelIsMoe && !!modelPath;

  const run = useCallback(async () => {
    if (!modelPath || running) return;
    setRunning(true);
    setError(null);
    setReport(null);
    setStaged(null);
    setApplied(false);
    setDone(0);
    setTotal(0);
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
      setRunning(false);
    }
  }, [config, modelPath, providerId, running]);

  const apply = useCallback(() => {
    if (!staged) return;
    updateParam("moe_cache_mib", staged.cache_mib);
    updateParam("moe_cache_cpu_share", staged.cpu_share);
    setStaged(null);
    setApplied(true);
  }, [staged, updateParam]);

  const label = running ? (total > 0 ? `TUNE ${done}/${total}` : "TUNE…") : "TUNE";
  const gain =
    report?.best_tps != null && report.baseline_tps != null && report.baseline_tps > 0
      ? report.best_tps / report.baseline_tps - 1
      : null;

  return (
    <span className="moe-tune">
      <button
        type="button"
        className={`value-chip font-mono moe-tune__btn${running ? " is-running" : ""}`}
        onClick={() => void run()}
        disabled={!canRun}
        title={
          modelIsMoe
            ? "Measure decode speed for cache sizes and CPU share (three launches, ~2 min)"
            : "Dense model - no expert cache to tune"
        }
      >
        {label}
      </button>
      {staged && !running && (
        <>
          <span className="moe-tune__staged type-micro font-mono" title="Measured, not applied yet">
            {gilb(staged.cache_mib)} · share {staged.cpu_share.toFixed(2)}
            {report?.best_tps != null ? ` · ${report.best_tps.toFixed(1)} t/s` : ""}
            {gain != null ? ` (+${(gain * 100).toFixed(0)}%)` : ""}
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
