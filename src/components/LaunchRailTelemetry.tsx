import type { CpuInfo, GpuInfo, SystemInfo } from "../lib/types";
import { useDisplayTexture } from "../context/DisplayTextureContext";
import { useTelemetry } from "../context/TelemetryContext";

const TEL_WIDGET_SURFACE = "phosphor-display-surface";

function shortGpuName(name: string): string {
  const trimmed = name.replace(/NVIDIA\s+/i, "").replace(/\s+Generation$/i, "");
  if (trimmed.length <= 22) return trimmed;
  return `${trimmed.slice(0, 20)}…`;
}

function tempTone(temp: number): string {
  if (temp > 85) return "launch-rail-tel__temp--hot";
  if (temp > 72) return "launch-rail-tel__temp--warm";
  return "launch-rail-tel__temp--cool";
}

function utilBarClass(percent: number, kind: "gpu" | "mem" | "power"): string {
  if (percent > 90) return `launch-rail-tel__bar-fill--${kind}-critical`;
  if (percent > 70) return `launch-rail-tel__bar-fill--${kind}-high`;
  return `launch-rail-tel__bar-fill--${kind}`;
}

function MemTotals({ gpus, systemInfo }: { gpus: GpuInfo[]; systemInfo: SystemInfo | null }) {
  const totalVramGb = gpus.reduce((s, g) => s + (g.memory_total_manufactured || g.memory_total), 0) / 1024;
  const usedVramGb = gpus.reduce((s, g) => s + g.memory_used, 0) / 1024;
  const ramTotalGb = (systemInfo?.total_memory_manufactured_mib || systemInfo?.total_memory_mib || 0) / 1024;
  const ramUsedGb = systemInfo
    ? (systemInfo.total_memory_mib - systemInfo.available_memory_mib) / 1024
    : 0;
  const vramPct = totalVramGb > 0 ? (usedVramGb / totalVramGb) * 100 : 0;
  const ramPct = ramTotalGb > 0 ? (ramUsedGb / ramTotalGb) * 100 : 0;

  return (
    <div className="launch-rail-tel__totals">
      <div className={`launch-rail-tel__total-cell ${TEL_WIDGET_SURFACE}`}>
        <span className="launch-rail-tel__total-label">VRAM</span>
        <span className="launch-rail-tel__total-value launch-rail-tel__total-value--vram">
          {usedVramGb.toFixed(1)}
          <span className="launch-rail-tel__total-denom"> / {totalVramGb.toFixed(0)} GB</span>
        </span>
        <div className="launch-rail-tel__total-track">
          <div
            className={`launch-rail-tel__total-fill launch-rail-tel__total-fill--vram${vramPct > 88 ? " launch-rail-tel__total-fill--warn" : ""}`}
            style={{ width: `${Math.min(vramPct, 100)}%` }}
          />
        </div>
      </div>
      {ramTotalGb > 0 && (
        <div className={`launch-rail-tel__total-cell ${TEL_WIDGET_SURFACE}`}>
          <span className="launch-rail-tel__total-label">RAM</span>
          <span className="launch-rail-tel__total-value launch-rail-tel__total-value--ram">
            {ramUsedGb.toFixed(1)}
            <span className="launch-rail-tel__total-denom"> / {ramTotalGb.toFixed(0)} GB</span>
          </span>
          <div className="launch-rail-tel__total-track">
            <div
              className={`launch-rail-tel__total-fill launch-rail-tel__total-fill--ram${ramPct > 88 ? " launch-rail-tel__total-fill--warn" : ""}`}
              style={{ width: `${Math.min(ramPct, 100)}%` }}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function cpuAvgBarClass(avg: number): string {
  if (avg > 85) return "launch-rail-tel__cpu-avg-fill--critical";
  if (avg > 60) return "launch-rail-tel__cpu-avg-fill--high";
  return "launch-rail-tel__cpu-avg-fill--normal";
}

function CpuStrip({ cpu }: { cpu: CpuInfo }) {
  const avg = Math.round(cpu.avg_usage_percent);

  return (
    <div className={`launch-rail-tel__cpu ${TEL_WIDGET_SURFACE}`}>
      <div className="launch-rail-tel__cpu-head">
        <div className="min-w-0 flex-1">
          <p className="launch-rail-tel__cpu-name" title={cpu.name}>
            {cpu.name}
          </p>
          <p className="launch-rail-tel__cpu-meta">
            {cpu.cores}C/{cpu.threads}T · {cpu.max_clock_mhz} MHz
          </p>
        </div>
        <div className="launch-rail-tel__cpu-avg">
          <span className="launch-rail-tel__cpu-avg-val">{avg}</span>
          <span className="launch-rail-tel__cpu-avg-unit">%</span>
        </div>
      </div>
      <div className="launch-rail-tel__cpu-avg-track">
        <div
          className={`launch-rail-tel__cpu-avg-fill ${cpuAvgBarClass(avg)}`}
          style={{ width: `${Math.min(avg, 100)}%` }}
        />
      </div>
    </div>
  );
}

function GpuStrip({ gpu }: { gpu: GpuInfo }) {
  const powerPct = gpu.power_limit > 0 ? (gpu.power_draw / gpu.power_limit) * 100 : 0;

  return (
    <div className={`launch-rail-tel__gpu ${TEL_WIDGET_SURFACE}`}>
      <div className="launch-rail-tel__gpu-head">
        <div className="min-w-0">
          <p className="launch-rail-tel__gpu-name" title={gpu.name}>
            GPU-{gpu.index}
          </p>
          <p className="launch-rail-tel__gpu-sub" title={gpu.name}>
            {shortGpuName(gpu.name)}
          </p>
        </div>
        <span className={`launch-rail-tel__temp ${tempTone(gpu.temperature_gpu)}`}>
          {gpu.temperature_gpu}°
        </span>
      </div>

      <div className="launch-rail-tel__metric">
        <div className="launch-rail-tel__metric-row">
          <span className="launch-rail-tel__metric-label">PWR</span>
          <span className="launch-rail-tel__metric-val">
            {gpu.power_draw.toFixed(0)}<span className="launch-rail-tel__metric-unit">W</span>
            <span className="launch-rail-tel__metric-denom"> / {gpu.power_limit.toFixed(0)}</span>
          </span>
        </div>
        <div className="launch-rail-tel__bar-track">
          <div
            className={utilBarClass(powerPct, "power")}
            style={{ width: `${Math.min(powerPct, 100)}%` }}
          />
        </div>
      </div>

      <div className="launch-rail-tel__metric-pair">
        <div className="launch-rail-tel__metric launch-rail-tel__metric--half">
          <div className="launch-rail-tel__metric-row">
            <span className="launch-rail-tel__metric-label">GPU</span>
            <span className="launch-rail-tel__metric-val">{gpu.utilization_gpu}%</span>
          </div>
          <div className="launch-rail-tel__bar-track launch-rail-tel__bar-track--thin">
            <div
              className={utilBarClass(gpu.utilization_gpu, "gpu")}
              style={{ width: `${Math.min(gpu.utilization_gpu, 100)}%` }}
            />
          </div>
        </div>
        <div className="launch-rail-tel__metric launch-rail-tel__metric--half">
          <div className="launch-rail-tel__metric-row">
            <span className="launch-rail-tel__metric-label">MEM</span>
            <span className="launch-rail-tel__metric-val">{gpu.utilization_memory}%</span>
          </div>
          <div className="launch-rail-tel__bar-track launch-rail-tel__bar-track--thin">
            <div
              className={utilBarClass(gpu.utilization_memory, "mem")}
              style={{ width: `${Math.min(gpu.utilization_memory, 100)}%` }}
            />
          </div>
        </div>
      </div>
    </div>
  );
}

export default function LaunchRailTelemetry() {
  const { gpus, cpu, systemInfo } = useTelemetry();
  const { texture: displayTexture } = useDisplayTexture();
  const totalPower = gpus.reduce((s, g) => s + (g.power_draw || 0), 0);

  return (
    <div
      className="launch-rail-tel h-full min-h-0 flex flex-col"
      data-display-texture={displayTexture}
    >
      <div className="launch-rail-tel__header">
        <div className="launch-rail-tel__header-left">
          <span className="launch-rail-tel__pulse" aria-hidden="true" />
          <span className="launch-rail-tel__title">HW MONITOR</span>
        </div>
        {gpus.length > 0 && (
          <span className="launch-rail-tel__power-pill">{totalPower.toFixed(0)}W Σ</span>
        )}
      </div>

      <div className="launch-rail-tel__body eink-scrollbar overflow-y-auto overflow-x-hidden min-h-0 flex-1">
        <MemTotals gpus={gpus} systemInfo={systemInfo} />
        {cpu && <CpuStrip cpu={cpu} />}
        {gpus.map((gpu) => (
          <GpuStrip key={gpu.index} gpu={gpu} />
        ))}
        {!cpu && gpus.length === 0 && (
          <p className="launch-rail-tel__empty text-[8px] font-mono text-stealth-muted/50 px-2 py-4 text-center">
            Scanning hardware…
          </p>
        )}
      </div>
    </div>
  );
}