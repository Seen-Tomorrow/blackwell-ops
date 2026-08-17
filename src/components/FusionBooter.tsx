import type { GpuInfo } from "../lib/types";
import { useFusionBooterState, phaseIndex, type GpuVramLoad } from "../hooks/useFusionBooterState";
import {
  LOAD_PHASE_LABELS,
  LOAD_PHASE_ORDER,
  type LoadPhaseId,
} from "../lib/fusionLoadParser";

const MAX_BOOT_GPUS = 8;

interface FusionBooterProps {
  slotIdx: number;
  alias: string;
  port: number;
  gpus: GpuInfo[];
  gpuMask: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
}

function vramLoadForGpu(loads: GpuVramLoad[], index: number): GpuVramLoad | undefined {
  return loads.find((l) => l.index === index);
}

function formatDiskRate(n: number): string {
  return Math.round(n).toLocaleString("en-US");
}

function formatTimer(elapsedSec: number): string {
  const mm = Math.floor(elapsedSec / 60);
  const ss = Math.floor(elapsedSec % 60);
  return `${mm}:${ss.toString().padStart(2, "0")}`;
}

function GpuLoadMap({
  gpus,
  activeIndices,
  gpuVramLoads,
}: {
  gpus: GpuInfo[];
  activeIndices: number[];
  gpuVramLoads: GpuVramLoad[];
}) {
  if (gpus.length === 0) return null;

  const activeSet = new Set(activeIndices);
  const orderedActive = activeIndices
    .map((idx) => gpus.find((g) => g.index === idx))
    .filter((g): g is GpuInfo => g != null);
  const displayGpus = (orderedActive.length > 0 ? orderedActive : gpus).slice(0, MAX_BOOT_GPUS);

  return (
    <div className="fusion-boot-gpu-bank" role="group" aria-label="GPU VRAM load">
      <div className="fusion-boot-gpu-bank__well">
        <span className="fusion-boot-gpu-bank__title">GPU VRAM</span>
        <div className="fusion-boot-gpu-bank__bars">
          {displayGpus.map((gpu) => {
            const active = activeSet.has(gpu.index);
            const load = vramLoadForGpu(gpuVramLoads, gpu.index);
            const fillPct = load ? Math.min(100, load.pct) : 0;
            const usedGb = load ? (load.usedMib / 1024).toFixed(1) : "0.0";
            const targetGb = load && load.targetMib > 0
              ? (load.targetMib / 1024).toFixed(0)
              : null;

            return (
              <div
                key={gpu.index}
                className={`fusion-boot-gpu-col${active ? " is-active" : " is-idle"}`}
              >
                <div
                  className="fusion-boot-gpu-col__track"
                  title={
                    targetGb
                      ? `GPU ${gpu.index}: +${usedGb} GiB / ~${targetGb} GiB target (Δ from load baseline)`
                      : `GPU ${gpu.index}: +${usedGb} GiB since load start`
                  }
                >
                  <div
                    className="fusion-boot-gpu-col__fill"
                    style={{ height: `${Math.max(active ? 3 : 2, fillPct)}%` }}
                  />
                  <div className="fusion-boot-gpu-col__readout">
                    <span className="fusion-boot-gpu-col__id">G{gpu.index}</span>
                    <span className="fusion-boot-gpu-col__val">{usedGb}</span>
                    <span className="fusion-boot-gpu-col__unit">GiB</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function DiskIoHero({ mibPerS }: { mibPerS: number }) {
  const value = formatDiskRate(mibPerS);
  const mbitPerS = formatDiskRate(mibPerS * 8);
  const hot = mibPerS >= 4096;
  const warm = !hot && mibPerS > 8;

  return (
    <div
      className={`fusion-boot-disk fusion-disk-hero${hot ? " is-hot" : warm ? " is-warm" : " is-idle"}`}
      aria-label={`NVMe read ${value} mebibytes per second`}
    >
      <span className="fusion-boot-disk__lab">NVMe READ</span>
      <span className="fusion-boot-disk__value fusion-disk-hero__value fusion-instrument__value">
        {value}
      </span>
      <span className="fusion-boot-disk__unit">MiB/s</span>
      <span className="fusion-boot-disk__mbit fusion-disk-hero__mbit">
        {mbitPerS} Mbit/s
      </span>
    </div>
  );
}

function PhaseLadder({
  phase,
  loadProgress01,
}: {
  phase: LoadPhaseId;
  loadProgress01: number;
}) {
  const current = phaseIndex(phase);
  const hasPct = loadProgress01 >= 0;
  const fillPct = hasPct ? Math.min(100, Math.round(loadProgress01 * 100)) : null;
  return (
    <div className="fusion-boot-phase" aria-label="Load phase">
      <div className="fusion-boot-phase__steps" role="list">
        {LOAD_PHASE_ORDER.map((id, i) => {
          const done = i < current;
          const active = i === current;
          const state = done ? "is-done" : active ? "is-active" : "is-todo";
          return (
            <div key={id} className={`fusion-boot-phase__step ${state}`} role="listitem">
              <div className="fusion-boot-phase__bar" />
              <span className="fusion-boot-phase__lab">{LOAD_PHASE_LABELS[id]}</span>
            </div>
          );
        })}
      </div>
      {fillPct != null && (
        <div
          className="fusion-boot-phase__progress"
          aria-label={`Load progress ${fillPct} percent`}
        >
          <div className="fusion-boot-phase__progress-track">
            <div
              className="fusion-boot-phase__progress-fill"
              style={{ width: `${Math.max(2, fillPct)}%` }}
            />
          </div>
          <span className="fusion-boot-phase__progress-val">{fillPct}%</span>
        </div>
      )}
    </div>
  );
}

export default function FusionBooter({
  slotIdx,
  alias,
  port,
  gpus,
  gpuMask,
  vramTargetMib,
  modelLayerTotal,
  gpuLoadTargetsMib,
}: FusionBooterProps) {
  const state = useFusionBooterState({
    slotIdx,
    port,
    gpuMask,
    vramTargetMib,
    modelLayerTotal,
    gpuLoadTargetsMib,
    gpus,
    active: true,
  });

  if (state.loadFailed) {
    return (
      <div className="fusion-boot fusion-boot--failed">
        <div className="fusion-boot__header">
          <span className="fusion-boot__title fusion-boot__title--fail">LOAD FAILED</span>
          <span className="fusion-boot__ident">
            {alias.toUpperCase()} :{port}
          </span>
        </div>
        <div className="fusion-boot-fail">
          <p className="fusion-boot-fail__reason">{state.loadErrorReason}</p>
          <p className="fusion-boot-fail__hint">Check engine logs · adjust CTX / layers / VRAM</p>
        </div>
      </div>
    );
  }

  const mapGpus = state.liveGpus.length > 0 ? state.liveGpus : gpus;
  const layerLabel =
    state.layerTotal > 0
      ? `${Math.min(state.layerCurrent, state.layerTotal)} / ${state.layerTotal}`
      : state.layerCurrent > 0
        ? `${state.layerCurrent}`
        : "—";
  const layerPct =
    state.layerTotal > 0
      ? Math.min(100, Math.round((Math.min(state.layerCurrent, state.layerTotal) / state.layerTotal) * 100))
      : null;

  const srcLabel =
    state.progressSource === "sse"
      ? "SSE"
      : state.progressSource === "logs"
        ? "LOGS"
        : "—";
  const srcTitle =
    state.progressSource === "sse"
      ? "Progress from GET /models/sse (real load fraction)"
      : state.progressSource === "logs"
        ? "Progress from engine stderr / system events only"
        : "No progress feed yet (waiting for SSE or logs)";

  return (
    <div
      className={`fusion-boot${
        state.progressSource === "sse"
          ? " fusion-boot--src-sse"
          : state.progressSource === "logs"
            ? " fusion-boot--src-logs"
            : ""
      }`}
    >
      <div className="fusion-boot__header">
        <span className="fusion-boot__title">ENGINE BOOT</span>
        <span
          className={`fusion-boot__src fusion-boot__src--${state.progressSource}`}
          title={srcTitle}
        >
          SRC {srcLabel}
        </span>
        <span className="fusion-boot__timer" title="Time since load started">
          {formatTimer(state.elapsedSec)}
        </span>
        <span className="fusion-boot__ident">
          {alias.toUpperCase()} :{port}
        </span>
      </div>

      <div className="fusion-boot__body">
        <div className="fusion-boot__gpus">
          <GpuLoadMap
            gpus={mapGpus}
            activeIndices={state.activeGpuIndices}
            gpuVramLoads={state.gpuVramLoads}
          />
        </div>
        <DiskIoHero mibPerS={state.diskReadMibPerS} />
      </div>

      <PhaseLadder phase={state.phase} loadProgress01={state.loadProgress01} />

      <div className="fusion-boot__footer">
        <div className="fusion-boot-ticker">
          {state.tickerLines.length === 0 ? (
            <p className="fusion-boot-ticker__empty">awaiting SSE / stderr…</p>
          ) : (
            state.tickerLines.map((line, i) => (
              <p key={`${i}-${line.slice(0, 12)}`} className="fusion-boot-ticker__line">
                {line}
              </p>
            ))
          )}
        </div>
        <div className="fusion-boot-meta">
          <div className="fusion-boot-meta__cell">
            <span className="fusion-boot-meta__lab">LAYER</span>
            <span className="fusion-boot-meta__val">{layerLabel}</span>
            {layerPct != null && (
              <span className="fusion-boot-meta__unit">{layerPct}%</span>
            )}
          </div>
          <div className="fusion-boot-meta__cell">
            <span className="fusion-boot-meta__lab">LOAD</span>
            <span className="fusion-boot-meta__val">
              {state.loadProgress01 >= 0
                ? `${Math.round(state.loadProgress01 * 100)}%`
                : "—"}
            </span>
            {state.loadStage ? (
              <span className="fusion-boot-meta__unit" title={state.loadStage}>
                {state.loadStage.replace(/_/g, " ").slice(0, 14)}
              </span>
            ) : null}
          </div>
          <div className="fusion-boot-meta__cell">
            <span className="fusion-boot-meta__lab">PHASE</span>
            <span className="fusion-boot-meta__val">{LOAD_PHASE_LABELS[state.phase]}</span>
          </div>
          <div className="fusion-boot-meta__cell">
            <span className="fusion-boot-meta__lab">ELAPSED</span>
            <span className="fusion-boot-meta__val">{state.elapsedSec}s</span>
          </div>
        </div>
      </div>
    </div>
  );
}
