import type { GpuInfo } from "../lib/types";
import { useFusionBooterState, phaseIndex, type GpuVramLoad } from "../hooks/useFusionBooterState";
import {
  LOAD_PHASE_LABELS,
  LOAD_PHASE_ORDER,
  type LoadPhaseId,
} from "../lib/fusionLoadParser";

const MAX_BOOT_GPUS = 8;
const GIB_HERO_THRESHOLD_MIB = 1024;

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

function binaryStream(tick: number, len = 8, seed = 0): string {
  return Array.from({ length: len }, (_, i) => {
    const wave = (tick * 3 + i * 2 + seed) % 11;
    return wave < 4 ? "0" : wave < 8 ? "1" : "·";
  }).join("").replace(/·/g, "0");
}

function formatDiskThroughput(mibPerS: number): { value: string; unit: string } {
  if (mibPerS >= GIB_HERO_THRESHOLD_MIB) {
    return { value: (mibPerS / 1024).toFixed(1), unit: "GiB/s" };
  }
  return { value: mibPerS.toFixed(1), unit: "MiB/s" };
}

function vramLoadForGpu(loads: GpuVramLoad[], index: number): GpuVramLoad | undefined {
  return loads.find((l) => l.index === index);
}

function GpuLoadMap({
  gpus,
  activeIndices,
  gpuVramLoads,
  bitTick,
}: {
  gpus: GpuInfo[];
  activeIndices: number[];
  gpuVramLoads: GpuVramLoad[];
  bitTick: number;
}) {
  if (gpus.length === 0) return null;

  const activeSet = new Set(activeIndices);
  const orderedActive = activeIndices
    .map((idx) => gpus.find((g) => g.index === idx))
    .filter((g): g is GpuInfo => g != null);
  const displayGpus = (orderedActive.length > 0 ? orderedActive : gpus).slice(0, MAX_BOOT_GPUS);

  return (
    <div className="flex items-end justify-center gap-1 sm:gap-1.5 w-full h-full min-h-0 px-0.5">
      {displayGpus.map((gpu, i) => {
        const active = activeSet.has(gpu.index);
        const load = vramLoadForGpu(gpuVramLoads, gpu.index);
        const fillPct = load ? Math.min(100, load.pct) : 0;
        const usedGb = load ? (load.usedMib / 1024).toFixed(1) : "0.0";
        const bits = binaryStream(bitTick + i * 4, 6, i);

        return (
          <div
            key={gpu.index}
            className="flex flex-col items-center flex-1 min-w-0 h-full max-w-[11%]"
          >
            <div
              className={`relative w-full flex-1 min-h-[48px] rounded-sm border overflow-hidden ${
                active ? "border-nv-green/50 bg-black/30" : "border-stealth-border/40 bg-black/15"
              }`}
            >
              <div
                className="absolute bottom-0 left-0 right-0 bg-nv-green transition-all duration-300 ease-out z-0"
                style={{
                  height: `${Math.max(2, fillPct)}%`,
                  opacity: active ? 0.6 : 0.12,
                }}
              />
              <div className="absolute inset-x-0 top-1 z-10 flex flex-col items-center gap-0.5 px-0.5 pointer-events-none">
                <span className="text-[6px] font-mono tracking-wider px-1 py-0.5 rounded-sm border border-stealth-border/50 bg-white/85 text-black leading-none truncate max-w-full">
                  GPU-{gpu.index}
                </span>
                <span className="text-[10px] font-mono font-bold leading-none text-black bg-white/80 px-1 py-px rounded-sm">
                  {usedGb}
                  <span className="text-[7px] font-normal"> GB</span>
                </span>
              </div>
            </div>

            <span className="h-[9px] mt-0.5 text-[5px] font-mono text-nv-green/55 tracking-widest text-center w-full leading-none overflow-hidden">
              {active ? bits : "······"}
            </span>
          </div>
        );
      })}
    </div>
  );
}

function DiskIoHero({ mibPerS }: { mibPerS: number }) {
  const { value, unit } = formatDiskThroughput(mibPerS);
  const gbitPerS = (mibPerS * 8) / 1000;
  const hot = mibPerS >= 4096;

  return (
    <div
      className={`flex flex-col items-center justify-center px-2 py-1 rounded-sm border flex-shrink-0 self-stretch min-w-[84px] max-w-[96px] ${
        hot ? "border-telemetry-cyan/40 bg-black/10" : "border-stone-500/10 bg-black/4"
      }`}
    >
      <span className="text-[7px] font-mono text-stealth-muted/50 tracking-wider mb-0.5">NVMe READ</span>
      <span
        className="font-mono font-bold tracking-tight leading-none"
        style={{
          fontSize: "clamp(1.35rem, 4vh, 2.2rem)",
          color: hot ? "#22d3ee" : mibPerS > 8 ? "rgba(34, 211, 238, 0.75)" : "rgba(34, 211, 238, 0.35)",
        }}
      >
        {value}
      </span>
      <span className="text-[7px] font-mono text-stealth-muted/40 tracking-wider mt-0.5">{unit}</span>
      <span className="text-[6px] font-mono text-stealth-muted/35 mt-1 text-center leading-tight">
        {gbitPerS >= 1 ? `${gbitPerS.toFixed(1)} Gbit/s` : `${(mibPerS * 8).toFixed(0)} Mbit/s`}
      </span>
    </div>
  );
}

function PhaseLadder({ phase }: { phase: LoadPhaseId }) {
  const current = phaseIndex(phase);
  return (
    <div className="flex items-center justify-between gap-1 w-full px-1">
      {LOAD_PHASE_ORDER.map((id, i) => {
        const done = i < current;
        const active = i === current;
        return (
          <div key={id} className="flex-1 flex flex-col items-center gap-0.5 min-w-0">
            <div
              className={`h-1 w-full rounded-sm transition-colors ${
                done ? "bg-nv-green" : active ? "bg-nv-green/60 animate-pulse" : "bg-stealth-border/60"
              }`}
            />
            <span
              className={`text-[6px] font-mono tracking-wider truncate w-full text-center ${
                done || active ? "text-nv-green" : "text-stealth-muted/40"
              }`}
            >
              {LOAD_PHASE_LABELS[id]}
            </span>
          </div>
        );
      })}
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

  const mapGpus = state.liveGpus.length > 0 ? state.liveGpus : gpus;
  const layerLabel =
    state.layerTotal > 0
      ? `LAYER ${Math.min(state.layerCurrent, state.layerTotal)} / ${state.layerTotal}`
      : state.layerCurrent > 0
        ? `LAYER ${state.layerCurrent}`
        : "LAYER —";

  return (
    <div className="flex flex-col w-full h-full gap-1.5 px-2 py-1 overflow-hidden">
      <div className="flex items-center justify-between flex-shrink-0">
        <span className="text-[9px] font-mono text-nv-green tracking-widest">FUSION BOOT</span>
        <span className="text-[8px] font-mono text-stealth-muted/50">
          {alias.toUpperCase()} :{port}
        </span>
      </div>

      <div className="flex gap-2 flex-1 min-h-0 items-stretch">
        <div className="flex-1 min-w-0 min-h-0 flex">
          <GpuLoadMap
            gpus={mapGpus}
            activeIndices={state.activeGpuIndices}
            gpuVramLoads={state.gpuVramLoads}
            bitTick={state.bitTick}
          />
        </div>
        <DiskIoHero mibPerS={state.diskReadMibPerS} />
      </div>

      <div className="flex-shrink-0">
        <PhaseLadder phase={state.phase} />
      </div>

      <div className="flex-shrink-0 flex flex-col gap-1">
        <div className="bg-black/40 border border-stealth-border/40 rounded-sm px-2 py-1.5 min-h-[36px] max-h-[48px] overflow-hidden">
          {state.tickerLines.length === 0 ? (
            <p className="text-[8px] font-mono text-stealth-muted/40 italic">awaiting stderr…</p>
          ) : (
            state.tickerLines.map((line, i) => (
              <p key={`${i}-${line.slice(0, 12)}`} className="text-[8px] font-mono text-nv-green/70 leading-snug truncate">
                {line}
              </p>
            ))
          )}
        </div>
        <div className="flex items-center justify-between text-[7px] font-mono text-stealth-muted/60">
          <span>{layerLabel}</span>
          <span>SONAR :{port} ×{state.pingAttempts}</span>
          <span>{state.elapsedSec}s</span>
        </div>
      </div>
    </div>
  );
}