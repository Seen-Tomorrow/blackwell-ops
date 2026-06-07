import type { GpuInfo, CpuInfo } from "../lib/types";
import { useTelemetry } from "../context/TelemetryContext";

export default function TelemetryPanel() {
  const { gpus, cpu, systemInfo } = useTelemetry();

  const totalVram = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);
  const usedVram = gpus.reduce((sum, g) => sum + g.memory_used, 0);
  const avgTemp = gpus.length > 0
    ? Math.round(gpus.reduce((sum, g) => sum + g.temperature_gpu, 0) / gpus.length)
    : 0;
  const totalPower = gpus.reduce((sum, g) => sum + (g.power_draw || 0), 0);

  return (
    <div className="h-full overflow-y-auto space-y-3">
      <SystemSummary
        totalVram={totalVram}
        usedVram={usedVram}
        avgTemp={avgTemp}
        totalPower={totalPower}
        ramManufacturedMib={systemInfo?.total_memory_manufactured_mib || 0}
      />

      {cpu && <CpuMatrix cpu={cpu} />}

      {gpus.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {gpus.map((gpu) => (
            <GpuCard key={gpu.index} gpu={gpu} />
          ))}
        </div>
      )}
    </div>
  );
}

function SystemSummary({ totalVram, usedVram, avgTemp, totalPower, ramManufacturedMib }: {
  totalVram: number;
  usedVram: number;
  avgTemp: number;
  totalPower: number;
  ramManufacturedMib: number;
}) {
  return (
    <div className="theme-surface rounded-sm p-4">
      <div className="flex items-center justify-center py-2 border-b border-stealth-border pb-3 mb-3 gap-8">
        <div className="text-center">
          <p className="text-[9px] font-mono text-stealth-muted tracking-wider">TOTAL VRAM</p>
          <p className="text-2xl font-mono mt-0.5 text-nv-green">{(totalVram / 1024).toFixed(0)} GB</p>
        </div>
        {ramManufacturedMib > 0 && (
          <>
            <div className="w-px h-8 bg-stealth-border" />
            <div className="text-center">
              <p className="text-[9px] font-mono text-stealth-muted tracking-wider">TOTAL RAM</p>
              <p className="text-2xl font-mono mt-0.5 text-electric-blue">{(ramManufacturedMib / 1024).toFixed(0)} GB</p>
            </div>
          </>
        )}
      </div>
      <div className="grid grid-cols-3 gap-4">
        <SummaryItem label="USED VRAM" value={`${(usedVram / 1024).toFixed(1)} GB`} warning={totalVram > 0 && ((usedVram / totalVram) * 100) > 90} />
        <SummaryItem label="AVG TEMP" value={`${avgTemp}°C`} warning={avgTemp > 80} />
        <SummaryItem label="POWER DRAW" value={`${totalPower.toFixed(0)}W`} />
      </div>
    </div>
  );
}

function SummaryItem({ label, value, warning }: { label: string; value: string; warning?: boolean }) {
  return (
    <div>
      <p className="text-[9px] font-mono text-stealth-muted tracking-wider">{label}</p>
      <p className={`text-sm font-mono mt-0.5 ${warning ? "text-telemetry-amber" : "text-white"}`}>
        {value}
      </p>
    </div>
  );
}

function GpuCard({ gpu }: { gpu: GpuInfo }) {
  const vramPercent = gpu.memory_total > 0 ? (gpu.memory_used / gpu.memory_total) * 100 : 0;
  const tempColor = gpu.temperature_gpu > 85 ? "text-telemetry-red" : gpu.temperature_gpu > 70 ? "text-telemetry-amber" : "text-nv-green";
  const powerPercent = gpu.power_limit > 0 ? (gpu.power_draw / gpu.power_limit) * 100 : 0;

  return (
    <div className="theme-surface rounded-sm overflow-hidden">
      <div className="theme-surface-header px-3 py-2.5 border-b border-stealth-border flex items-center justify-between">
        <div>
          <h3 className="text-[11px] font-mono text-white truncate">{gpu.name}</h3>
          <p className="text-[9px] font-mono text-stealth-muted mt-0.5">GPU-{gpu.index}</p>
        </div>
        <span className={`text-sm font-mono ${tempColor}`}>
          {gpu.temperature_gpu}°C
        </span>
      </div>

      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] font-mono text-stealth-muted tracking-wider">VRAM</span>
          <p className="text-[9px] font-mono text-white/80">
            {(gpu.memory_used / 1024).toFixed(1)} / {(gpu.memory_total_manufactured || gpu.memory_total) / 1024} GB ({vramPercent.toFixed(0)}%)
          </p>
        </div>
        <div className="w-full h-1.5 theme-bar-track rounded-sm overflow-hidden">
          <div
            style={{ width: `${Math.min(vramPercent, 100)}%` }}
            className={`h-full rounded-sm transition-all duration-75 ${
              vramPercent > 90 ? "bg-telemetry-red" : vramPercent > 75 ? "bg-telemetry-amber" : "bg-nv-green"
            }`}
          />
        </div>

        <div className="flex items-center justify-between mt-2 mb-1">
          <span className="text-[9px] font-mono text-stealth-muted tracking-wider">POWER</span>
          <span className="text-[9px] font-mono text-white/80">
            <span className="text-sm font-mono text-telemetry-amber">{gpu.power_draw.toFixed(1)}W</span> / {gpu.power_limit.toFixed(0)}W ({powerPercent.toFixed(0)}%)
          </span>
        </div>
        <div className="w-full h-1.5 theme-bar-track rounded-sm overflow-hidden">
          <div
            style={{ width: `${Math.min(powerPercent, 100)}%` }}
            className="h-full bg-telemetry-amber rounded-sm transition-all duration-75"
          />
        </div>

        <div className="grid grid-cols-2 gap-3 mt-3">
          <UtilGauge label="GPU UTIL" value={gpu.utilization_gpu} max={100} color="text-nv-green" barColor="bg-nv-green" />
          <UtilGauge label="MEM UTIL" value={gpu.utilization_memory} max={100} color="text-telemetry-cyan" barColor="bg-telemetry-cyan" />
        </div>
      </div>
    </div>
  );
}

function UtilGauge({ label, value, max, color, barColor }: {
  label: string;
  value: number;
  max: number;
  color: string;
  barColor: string;
}) {
  const percent = max > 0 ? (value / max) * 100 : 0;

  return (
    <div>
      <span className="text-[8px] font-mono text-stealth-muted tracking-wider">{label}</span>
      <p className={`text-xs font-mono ${color}`}>{value}%</p>
      <div className="w-full h-1 theme-bar-track rounded-sm mt-0.5 overflow-hidden">
        <div
          style={{ width: `${percent}%` }}
          className={`h-full ${barColor} rounded-sm transition-all duration-75`}
        />
      </div>
    </div>
  );
}

function CpuMatrix({ cpu }: { cpu: CpuInfo }) {
  const cols = Math.min(cpu.threads, 8);

  return (
    <div className="theme-surface rounded-sm overflow-hidden">
      <div className="theme-surface-header px-4 py-2.5 border-b border-stealth-border flex items-center justify-between">
        <div>
          <h3 className="text-[11px] font-mono text-white truncate">{cpu.name}</h3>
          <p className="text-[9px] font-mono text-stealth-muted mt-0.5">
            {cpu.cores}C/{cpu.threads}T · {cpu.max_clock_mhz}MHz · AVG {Math.round(cpu.avg_usage_percent)}%
          </p>
        </div>
      </div>

      <div className="px-4 py-3">
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {cpu.core_usages.map((usage, i) => (
            <CoreCell key={i} index={i} usage={usage} />
          ))}
        </div>
      </div>

      <div className="theme-surface-header px-4 py-1.5 border-t border-stealth-border flex items-center gap-3">
        {[
          { label: "IDLE", color: "bg-white/8" },
          { label: "LOW", color: "bg-white/15" },
          { label: "MED", color: "bg-white/30" },
          { label: "HIGH (>80%)", color: "bg-orange-700" },
        ].map((item) => (
          <div key={item.label} className="flex items-center gap-1">
            <span className={`w-2 h-2 rounded-sm ${item.color}`} />
            <span className="text-[7px] font-mono text-stealth-muted/60">{item.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function CoreCell({ index, usage }: { index: number; usage: number }) {
  const color = usage > 80 ? "bg-orange-700" : usage >= 50 ? "bg-white/30" : usage >= 25 ? "bg-white/15" : "bg-white/8";

  return (
    <div className="relative h-6 theme-bar-track rounded-sm overflow-hidden group cursor-default">
      <div
        style={{ width: `${Math.min(usage, 100)}%` }}
        className={`h-full ${color} rounded-sm transition-all duration-75`}
      />
      <span className="absolute inset-0 flex items-center justify-center text-[7px] font-mono text-white/60 group-hover:text-white transition-colors">
        {index}
      </span>
    </div>
  );
}