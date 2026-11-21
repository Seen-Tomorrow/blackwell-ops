/**
 * MOE OVERDRIVE — one screen for one question: run this MoE model as fast as this rig allows.
 *
 * The screen is a view over `moeOverdriveRun`: that module owns the cycle (calibration load →
 * probe → write → tuned relaunch → bench → compare). Here we only start it, show the real engine
 * boot instrument during both loads, and print the before/after the run measured.
 *
 * Forecast isolation: this component imports no forecast code. If OVERDRIVE dies, delete this
 * file, `moeOverdriveRun.ts`, `moe_overdrive.rs` and the `.moe-od-*` block in the CSS.
 */

import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useFusionSlot } from "../lib/fusionSlotStore";
import FusionBooter from "./FusionBooter";
import {
  abortOverdriveRun,
  comparisonFromRecord,
  isOverdriveBusy,
  readOverdriveRecord,
  resetOverdriveRun,
  useOverdriveRun,
  type MoeOverdriveIdentity,
  type OverdriveComparison,
  type OverdriveRecord,
} from "../lib/moeOverdriveRun";
import type { GpuInfo } from "../lib/types";

export interface MoeOverdriveBooter {
  gpuMask: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
}

export interface MoeOverdriveProps {
  identity: MoeOverdriveIdentity;
  gpus: GpuInfo[];
  /** Boot-widget inputs for the loads this run starts. */
  booter: MoeOverdriveBooter;
  /** The currently selected engine (idle view: show its live t/s). */
  selectedSlotIdx: number | null;
  activePort: number | null;
  /** OVERDRIVE is a MoE + ASSISTED path; false disables the run. */
  canStart: boolean;
  /** Start the run. `true` ignores a stored calibration and measures again. */
  onStart: (forceCalibrate: boolean) => void;
  /**
   * RESET: drop the record and put the launch back on the plain path
   * (cpu_moe off, cache 0, share 0). The engine keeps running until the user stops it.
   */
  onReset: () => void;
  /** Back to the forecast glass. */
  onExit: () => void;
}

const PHASE_LABEL: Record<string, string> = {
  idle: "READY",
  preparing: "PREPARING",
  "loading-calibration": "CALIBRATION LOAD",
  probing: "PROBING",
  "bench-before": "BASELINE BENCH",
  stopping: "STOPPING",
  "loading-tuned": "TUNED LOAD",
  "bench-after": "TUNED BENCH",
  done: "COMPLETE",
  error: "FAILED",
  aborted: "STOPPED",
};

function gib(mib: number): string {
  return `${(mib / 1024).toFixed(1)} GiB`;
}

function num(mib: number): string {
  return Math.round(mib).toLocaleString("en-US");
}

function tps(value: number | null | undefined): string {
  return value != null && value > 0 ? value.toFixed(1) : "—";
}

function relativeAge(iso: string | null): string {
  if (!iso) return "unknown age";
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return "unknown age";
  const secs = Math.max(0, (Date.now() - then) / 1000);
  if (secs < 90) return "just now";
  if (secs < 5400) return `${Math.round(secs / 60)}m ago`;
  if (secs < 172800) return `${Math.round(secs / 3600)}h ago`;
  return `${Math.round(secs / 86400)}d ago`;
}

function gainPct(before: number | null, after: number | null): number | null {
  if (before == null || after == null || before <= 0) return null;
  return (after / before - 1) * 100;
}

function ComparisonCard({ comparison }: { comparison: OverdriveComparison }) {
  const gain = gainPct(comparison.tpsBefore, comparison.tpsAfter);
  const beforeMemory = comparison.memoryBefore;
  const afterMemory = comparison.memoryAfter;
  return (
    <div className="moe-od__cmp">
      <div className="moe-od__cmp-head">
        <span>calibration → tuned</span>
        <span className="moe-od__cmp-age">
          {comparison.fromRecord ? `stored ${relativeAge(comparison.measuredAt)}` : "just measured"}
        </span>
      </div>
      <div className="moe-od__cmp-table">
        <span className="moe-od__cmp-lab">TG</span>
        <span className="moe-od__cmp-val">{tps(comparison.tpsBefore)}</span>
        <span className="moe-od__cmp-arrow">→</span>
        <span className="moe-od__cmp-val moe-od__cmp-val--after">{tps(comparison.tpsAfter)}</span>
        <span className="moe-od__cmp-unit">t/s</span>
        <span className={`moe-od__cmp-gain${gain != null && gain >= 0 ? " is-up" : ""}`}>
          {gain != null ? `${gain >= 0 ? "+" : ""}${gain.toFixed(0)}%` : ""}
        </span>

        <span className="moe-od__cmp-lab">VRAM</span>
        <span className="moe-od__cmp-val">
          {beforeMemory ? gib(beforeMemory.deviceMib) : "—"}
        </span>
        <span className="moe-od__cmp-arrow">→</span>
        <span className="moe-od__cmp-val moe-od__cmp-val--after">
          {afterMemory ? gib(afterMemory.deviceMib) : "—"}
        </span>
        <span className="moe-od__cmp-unit">card</span>
        <span className="moe-od__cmp-gain" />

        <span className="moe-od__cmp-lab">RAM</span>
        <span className="moe-od__cmp-val">
          {beforeMemory ? gib(beforeMemory.hostMib) : "—"}
        </span>
        <span className="moe-od__cmp-arrow">→</span>
        <span className="moe-od__cmp-val moe-od__cmp-val--after">
          {afterMemory ? gib(afterMemory.hostMib) : "—"}
        </span>
        <span className="moe-od__cmp-unit">host</span>
        <span className="moe-od__cmp-gain" />

        <span className="moe-od__cmp-lab">CACHE</span>
        <span className="moe-od__cmp-val">0</span>
        <span className="moe-od__cmp-arrow">→</span>
        <span className="moe-od__cmp-val moe-od__cmp-val--after">{num(comparison.cacheMib)}</span>
        <span className="moe-od__cmp-unit">MiB</span>
        <span className="moe-od__cmp-gain" />
      </div>
      {comparison.note && <div className="moe-od__cmp-note">{comparison.note}</div>}
    </div>
  );
}

export default function MoeOverdrive({
  identity,
  gpus,
  booter,
  selectedSlotIdx,
  activePort,
  canStart,
  onStart,
  onReset,
  onExit,
}: MoeOverdriveProps) {
  const run = useOverdriveRun();
  const busy = isOverdriveBusy(run.phase);
  const slotIdx = run.slotIdx ?? selectedSlotIdx;
  const port = run.port ?? activePort;
  const fusion = useFusionSlot(slotIdx);
  const [record, setRecord] = useState<OverdriveRecord | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const recordArgs = useMemo(
    () => ({
      modelPath: identity.modelPath,
      ctxSize: identity.ctxSize,
      kvQuant: identity.kvQuant,
      splitMode: identity.splitMode,
      gpuMask: identity.gpuMask,
      draft: identity.draft,
      draftNMax: identity.draftNMax,
    }),
    [
      identity.modelPath,
      identity.ctxSize,
      identity.kvQuant,
      identity.splitMode,
      identity.gpuMask,
      identity.draft,
      identity.draftNMax,
    ],
  );

  useEffect(() => {
    let cancelled = false;
    void invoke<{ record: OverdriveRecord } | null>("moe_overdrive_record", recordArgs)
      .then((stored) => {
        if (!cancelled) setRecord(stored?.record ?? null);
      })
      .catch(() => {
        if (!cancelled) setRecord(null);
      });
    return () => {
      cancelled = true;
    };
  }, [recordArgs]);

  useEffect(() => {
    if (run.phase !== "done") return;
    void readOverdriveRecord(recordArgs).then((stored) => setRecord(stored));
  }, [run.phase, recordArgs]);

  const comparison = run.comparison ?? (record ? comparisonFromRecord(record) : null);

  const reset = async () => {
    try {
      await invoke("moe_overdrive_record_clear", recordArgs);
    } catch (err) {
      setNote(String(err).split("\n")[0]);
      return;
    }
    setRecord(null);
    resetOverdriveRun();
    onReset();
    setNote("record cleared — the next launch is a plain one (CPU MOE off, cache 0)");
  };

  const liveTps = fusion
    ? fusion.genTpsInstant ?? fusion.genTpsSession ?? fusion.genTps ?? 0
    : 0;
  const ppTps = fusion?.prefillTpsSession ?? fusion?.prefillTpsInstant ?? 0;
  const loadPhase = run.phase === "loading-calibration" || run.phase === "loading-tuned";
  const showBooter = loadPhase && run.slotIdx != null && run.port != null;

  return (
    <div className="moe-od">
      <div className="moe-od__head">
        <span className="moe-od__title">MOE OVERDRIVE</span>
        <span className="moe-od__phase" data-phase={run.phase}>
          {PHASE_LABEL[run.phase] ?? run.phase.toUpperCase()}
        </span>
        <button
          type="button"
          className="moe-od__chip"
          onClick={onExit}
          disabled={busy}
          title={busy ? "Run in progress — stop the load to abort" : "Back to the forecast glass"}
        >
          ← FORECAST
        </button>
      </div>

      {!loadPhase && (
        <div className="moe-od__hero">
          <span className="moe-od__tps">{liveTps > 0 ? liveTps.toFixed(1) : "—"}</span>
          <span className="moe-od__unit">tok/s</span>
          <span className="moe-od__sub">
            {ppTps > 0 ? `prefill ${ppTps.toFixed(0)} t/s · ` : ""}
            {fusion ? `${fusion.ctxFillPct.toFixed(0)}% ctx` : port != null ? "engine ready" : "no engine"}
          </span>
        </div>
      )}

      {!loadPhase && record && (
        <div className="moe-od__learned">
          stored: cache {num(record.cache_mib)} MiB · free {num(record.free_after_load_mib)} after
          load · {relativeAge(record.measured_at)}
        </div>
      )}

      {showBooter ? (
        <div className="moe-od__boot">
          <div className="moe-od__boot-cap">{run.message}</div>
          <FusionBooter
            slotIdx={run.slotIdx as number}
            alias={run.alias ?? ""}
            port={run.port as number}
            gpus={gpus}
            gpuMask={run.gpuMask ?? booter.gpuMask}
            vramTargetMib={booter.vramTargetMib}
            modelLayerTotal={booter.modelLayerTotal}
            gpuLoadTargetsMib={booter.gpuLoadTargetsMib}
            onStop={abortOverdriveRun}
            stopPending={run.aborting}
          />
        </div>
      ) : busy ? (
        <div className="moe-od__progress">
          <span className="moe-od__progress-label">{PHASE_LABEL[run.phase] ?? "WORKING"}</span>
          <span className="moe-od__progress-msg">{run.message}</span>
          {run.phase === "probing" && (
            <span className="moe-od__progress-hint">
              two short passes against the loaded engine; no second launch
            </span>
          )}
          {run.aborting && <span className="moe-od__progress-hint">stopping…</span>}
        </div>
      ) : comparison ? (
        <ComparisonCard comparison={comparison} />
      ) : (
        <div className="moe-od__empty">
          No calibration for this shape yet. RUN OVERDRIVE loads it once with the experts in host
          RAM, sizes the expert cache from what the real launch leaves free, reloads it tuned and
          prints both runs side by side.
        </div>
      )}

      {!busy && (
        <div className="moe-od__actions">
          <button
            type="button"
            className="moe-od__chip moe-od__chip--primary"
            onClick={() => onStart(false)}
            disabled={!canStart}
            title={
              record
                ? `Load with the stored ${num(record.cache_mib)} MiB cache and check it`
                : "Calibrate, reload tuned and compare — one run"
            }
          >
            {record ? "RUN (STORED CACHE)" : "RUN OVERDRIVE"}
          </button>
          {record && (
            <button
              type="button"
              className="moe-od__chip"
              onClick={() => onStart(true)}
              disabled={!canStart}
              title="Ignore the stored calibration and measure this shape again"
            >
              RECALIBRATE
            </button>
          )}
          {record && (
            <button
              type="button"
              className="moe-od__chip"
              onClick={() => void reset()}
              title="Forget the calibration and return the launch to the plain path (CPU MOE off, cache 0)"
            >
              RESET
            </button>
          )}
          {!canStart && (
            <span className="moe-od__progress-hint">
              OVERDRIVE runs MoE models in ASSISTED mode
            </span>
          )}
        </div>
      )}

      {run.error && <div className="moe-od__note">{run.error}</div>}
      {!run.error && run.message && !busy && <div className="moe-od__note">{run.message}</div>}
      {note && <div className="moe-od__note">{note}</div>}
    </div>
  );
}
