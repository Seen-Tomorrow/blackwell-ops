import type { GpuInfo } from "../lib/types";
import { formatGpuDriverVersion } from "../lib/benchHwTopo";
import type { GpuOcOverlay } from "../hooks/useGpuControl";

interface GpuTopologyCardProps {
  gpu: GpuInfo;
  oc?: GpuOcOverlay;
  selected?: boolean;
  busy?: boolean;
  compact?: boolean;
  onSelect: () => void;
}

function utilBarClass(percent: number, kind: "gpu" | "mem"): string {
  if (percent > 90) return `gpu-topo-card__util-fill--${kind}-critical`;
  if (percent > 70) return `gpu-topo-card__util-fill--${kind}-high`;
  return `gpu-topo-card__util-fill--${kind}`;
}

function powerBarClass(percent: number): string {
  if (percent > 90) return "gpu-topo-card__power-fill--critical";
  if (percent > 70) return "gpu-topo-card__power-fill--high";
  return "gpu-topo-card__power-fill";
}

function tempClass(temp: number): string {
  if (temp > 85) return "gpu-topo-card__temp--hot";
  if (temp > 70) return "gpu-topo-card__temp--warm";
  return "gpu-topo-card__temp--cool";
}

export default function GpuTopologyCard({
  gpu,
  oc,
  selected,
  busy,
  compact = false,
  onSelect,
}: GpuTopologyCardProps) {
  const powerPercent = gpu.power_limit > 0 ? (gpu.power_draw / gpu.power_limit) * 100 : 0;
  const driverVer = formatGpuDriverVersion(gpu.driver_version);

  return (
    <button
      type="button"
      disabled={busy}
      onClick={onSelect}
      className={`gpu-topo-card phosphor-display-surface w-full text-left transition-colors disabled:opacity-60${
        selected ? " gpu-topo-card--selected" : ""
      }${compact ? " gpu-topo-card--compact" : ""}`}
    >
      <div className="gpu-topo-card__head">
        <div className="gpu-topo-card__head-top">
          <h3 className="gpu-topo-card__name truncate">{gpu.name}</h3>
          <span className={`gpu-topo-card__temp font-mono shrink-0 ${tempClass(gpu.temperature_gpu)}`}>
            {gpu.temperature_gpu}°C
          </span>
        </div>
        <p className="gpu-topo-card__meta">
          <span className="gpu-topo-card__meta-text">
            GPU-{gpu.index}
            {driverVer ? ` · drv ${driverVer}` : ""}
          </span>
          {selected ? (
            <span
              className={`gpu-topo-card__oc-badge${
                oc?.profileActive ? " gpu-topo-card__oc-badge--active" : " gpu-topo-card__oc-badge--idle"
              }`}
            >
              OC target
            </span>
          ) : null}
        </p>
      </div>

      <div className="gpu-topo-card__body px-3 pointer-events-none">
        <div className="gpu-topo-card__pair">
          <div className="gpu-topo-card__cell">
            <span className="gpu-topo-card__label">CORE</span>
            <p className="gpu-topo-card__value gpu-topo-card__value--readout font-mono tabular-nums">
              {oc ? (
                <>
                  {oc.coreClockMhz}
                  {oc.coreOffsetMhz > 0 && (
                    <span className="gpu-topo-card__offset"> +{oc.coreOffsetMhz}</span>
                  )}
                  {" MHz"}
                </>
              ) : (
                <span className="gpu-topo-card__empty">—</span>
              )}
            </p>
          </div>
          <div className="gpu-topo-card__cell">
            <span className="gpu-topo-card__label">MEM</span>
            <p className="gpu-topo-card__value gpu-topo-card__value--readout font-mono tabular-nums">
              {oc ? (
                <>
                  {oc.memClockMhz}
                  {oc.memOffsetMhz > 0 && (
                    <span className="gpu-topo-card__offset"> +{oc.memOffsetMhz}</span>
                  )}
                  {" MHz"}
                </>
              ) : (
                <span className="gpu-topo-card__empty">—</span>
              )}
            </p>
          </div>
        </div>

        <div className="gpu-topo-card__pair">
          <div className="gpu-topo-card__cell">
            <span className="gpu-topo-card__label">GPU UTIL</span>
            <p className="gpu-topo-card__value gpu-topo-card__value--readout font-mono tabular-nums">
              {gpu.utilization_gpu}%
            </p>
            <div className="gpu-topo-card__util-track">
              <div
                className={utilBarClass(gpu.utilization_gpu, "gpu")}
                style={{ width: `${Math.min(gpu.utilization_gpu, 100)}%` }}
              />
            </div>
          </div>
          <div className="gpu-topo-card__cell">
            <span className="gpu-topo-card__label">MEM UTIL</span>
            <p className="gpu-topo-card__value gpu-topo-card__value--readout font-mono tabular-nums">
              {gpu.utilization_memory}%
            </p>
            <div className="gpu-topo-card__util-track">
              <div
                className={utilBarClass(gpu.utilization_memory, "mem")}
                style={{ width: `${Math.min(gpu.utilization_memory, 100)}%` }}
              />
            </div>
          </div>
        </div>

        <div className="gpu-topo-card__power">
          <div className="gpu-topo-card__power-head">
            <span className="gpu-topo-card__label">POWER</span>
            <span className="gpu-topo-card__power-val font-mono tabular-nums">
              <span className="gpu-topo-card__power-watt">{gpu.power_draw.toFixed(0)}W</span>
              <span className="gpu-topo-card__power-denom">
                {" / "}
                {gpu.power_limit.toFixed(0)}W
                {oc && oc.configPowerLimitW !== Math.round(gpu.power_limit) && (
                  <span className="gpu-topo-card__power-target"> →{oc.configPowerLimitW}W</span>
                )}
              </span>
            </span>
          </div>
          <div className="gpu-topo-card__power-track">
            <div
              className={powerBarClass(powerPercent)}
              style={{ width: `${Math.min(powerPercent, 100)}%` }}
            />
          </div>
        </div>
      </div>
    </button>
  );
}