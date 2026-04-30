import type { GpuInfo, CpuInfo } from "../lib/types";
import IntelWidget from "./IntelWidget";

interface TelemetryPanelProps {
  gpus: GpuInfo[];
  cpu: CpuInfo | null;
  lowPower?: boolean;
  onToggleLowPower?: () => void;
}

export default function TelemetryPanel({ gpus, cpu, lowPower = false, onToggleLowPower }: TelemetryPanelProps) {

  // System summary calculations
  const totalVram = gpus.reduce((sum, g) => sum + (g.memory_total_manufactured || g.memory_total), 0);
  const usedVram = gpus.reduce((sum, g) => sum + g.memory_used, 0);
  const avgTemp = gpus.length > 0 ? Math.round(gpus.reduce((sum, g) => sum + (g.temperature_hot_spot ?? g.temperature_gpu), 0) / gpus.length) : 0;
  const totalPower = gpus.reduce((sum, g) => sum + g.power_draw, 0);

  return (
    <div className="h-full overflow-y-auto space-y-3">
      {/* System Summary — full width with floating power button */}
      <div className="relative">
        {onToggleLowPower && (
          <button
            onClick={onToggleLowPower}
            className={`absolute top-2 right-2 px-2 py-1 rounded-sm text-[9px] font-mono tracking-wider border transition-colors ${
              lowPower
                ? "bg-telemetry-amber/10 border-telemetry-amber/40 text-telemetry-amber"
                : "bg-stealth-panel border-stealth-border text-stealth-muted hover:text-white hover:border-stealth-muted"
            }`}
          >
            {lowPower ? "LOW POWER ON" : "LOW POWER OFF"}
          </button>
        )}
        <SystemSummary
          totalVram={totalVram}
          usedVram={usedVram}
          avgTemp={avgTemp}
          totalPower={totalPower}
        />
      </div>

      {/* GPU cards side by side */}
      {gpus.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          {gpus.map((gpu) => (
            <GpuCard key={gpu.index} gpu={gpu} />
          ))}
        </div>
      )}

      {/* CPU core matrix */}
      {cpu && <CpuMatrix cpu={cpu} />}

      {/* News feed — expanded, 2 items with full previews */}
      <div className="border border-stealth-border rounded-sm overflow-hidden">
        <IntelWidget compact={false} limit={2} />
      </div>
    </div>
  );
}

function SystemSummary({ totalVram, usedVram, avgTemp, totalPower }: {
  totalVram: number;
  usedVram: number;
  avgTemp: number;
  totalPower: number;
}) {
  return (
    <div className="bg-stealth-panel border border-stealth-border rounded-sm p-4">
      {/* Total VRAM — large and centered */}
      <div className="flex items-center justify-center py-2 border-b border-stealth-border pb-3 mb-3">
        <div className="text-center">
          <p className="text-[9px] font-mono text-stealth-muted tracking-wider">TOTAL VRAM</p>
          <p className="text-2xl font-mono mt-0.5 text-white">{(totalVram / 1024).toFixed(0)} GB</p>
        </div>
      </div>
      {/* Other stats */}
      <div className="grid grid-cols-3 gap-4">
        <SummaryItem label="USED VRAM" value={`${(usedVram / 1024).toFixed(1)} GB`} warning={((usedVram / totalVram) * 100) > 90} />
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

function TempLabel({ label, value, warning }: { label: string; value: number; warning?: boolean }) {
  const color = warning ? "text-telemetry-red" : value > 85 ? "text-telemetry-amber" : "text-nv-green";
  return (
    <div>
      <p className="text-[7px] font-mono text-stealth-muted/60 tracking-wider">{label}</p>
      <p className={`text-[10px] font-mono ${color}`}>{value}°C</p>
    </div>
  );
}

function GpuCard({ gpu }: { gpu: GpuInfo }) {
  const vramPercent = (gpu.memory_used / gpu.memory_total) * 100;
  const tempColor = gpu.temperature_gpu > 85 ? "text-telemetry-red" : gpu.temperature_gpu > 70 ? "text-telemetry-amber" : "text-nv-green";
  const powerPercent = gpu.power_limit > 0 ? (gpu.power_draw / gpu.power_limit) * 100 : 0;

  return (
    <div className="bg-stealth-panel border border-stealth-border rounded-sm overflow-hidden">
      {/* GPU header */}
      <div className="px-3 py-2.5 border-b border-stealth-border flex items-center justify-between bg-stealth-dark/50">
        <div>
          <h3 className="text-[11px] font-mono text-white truncate">{gpu.name}</h3>
          <p className="text-[9px] font-mono text-stealth-muted mt-0.5">GPU-{gpu.index}</p>
        </div>
        <span className={`text-sm font-mono ${tempColor}`}>
          {gpu.temperature_gpu}°C
        </span>
      </div>

      {/* Temp breakdown: core / hot spot / memory */}
      <div className="px-3 py-1.5 border-b border-stealth-border flex items-center gap-4 bg-stealth-dark/20">
        <TempLabel label="CORE" value={gpu.temperature_gpu} />
        {gpu.temperature_hot_spot !== null && gpu.temperature_hot_spot > 0 ? (
          <TempLabel label="HS" value={gpu.temperature_hot_spot} warning={gpu.temperature_hot_spot > 85} />
        ) : (
          <span className="text-[8px] font-mono text-stealth-muted/40">HS N/A</span>
        )}
        {gpu.temperature_memory !== null && gpu.temperature_memory > 0 ? (
          <TempLabel label="MEM" value={gpu.temperature_memory} />
        ) : (
          <span className="text-[8px] font-mono text-stealth-muted/40">MEM N/A</span>
        )}
      </div>

      {/* VRAM bar */}
      <div className="px-3 py-2.5">
        <div className="flex items-center justify-between mb-1">
          <span className="text-[9px] font-mono text-stealth-muted tracking-wider">VRAM</span>
          <span className="text-[9px] font-mono text-white/80">
            {gpu.memory_used} / {gpu.memory_total} MB ({vramPercent.toFixed(0)}%)
          </span>
        </div>
        <div className="w-full h-1.5 bg-stealth-black rounded-sm overflow-hidden">
          <div
            style={{ width: `${Math.min(vramPercent, 100)}%` }}
            className={`h-full rounded-sm transition-all duration-75 ${
              vramPercent > 90 ? "bg-telemetry-red" : vramPercent > 75 ? "bg-telemetry-amber" : "bg-nv-green"
            }`}
          />
        </div>

        {/* Power draw */}
        <div className="flex items-center justify-between mt-2 mb-1">
          <span className="text-[9px] font-mono text-stealth-muted tracking-wider">POWER</span>
          <span className="text-[9px] font-mono text-white/80">
            <span className="text-sm font-mono text-telemetry-amber">{gpu.power_draw.toFixed(1)}W</span> / {gpu.power_limit.toFixed(0)}W ({powerPercent.toFixed(0)}%)
          </span>
        </div>
        <div className="w-full h-1.5 bg-stealth-black rounded-sm overflow-hidden">
          <div
            style={{ width: `${Math.min(powerPercent, 100)}%` }}
            className="h-full bg-telemetry-amber rounded-sm transition-all duration-75"
          />
        </div>

        {/* Utilization stats */}
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
  const percent = (value / max) * 100;

  return (
    <div>
      <span className="text-[8px] font-mono text-stealth-muted tracking-wider">{label}</span>
      <p className={`text-xs font-mono ${color}`}>{value}%</p>
      <div className="w-full h-1 bg-stealth-black rounded-sm mt-0.5 overflow-hidden">
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
  const rows = Math.ceil(cpu.threads / cols);

  return (
    <div className="bg-stealth-panel border border-stealth-border rounded-sm overflow-hidden">
      {/* Header */}
      <div className="px-4 py-2.5 border-b border-stealth-border flex items-center justify-between bg-stealth-dark/50">
        <div>
          <h3 className="text-[11px] font-mono text-white truncate">{cpu.name}</h3>
          <p className="text-[9px] font-mono text-stealth-muted mt-0.5">
            {cpu.cores}C/{cpu.threads}T · {cpu.max_clock_mhz}MHz · AVG {Math.round(cpu.avg_usage_percent)}%
          </p>
        </div>
      </div>

      {/* Core grid */}
      <div className="px-4 py-3">
        <div className="grid gap-1" style={{ gridTemplateColumns: `repeat(${cols}, 1fr)` }}>
          {cpu.core_usages.map((usage, i) => (
            <CoreCell key={i} index={i} usage={usage} />
          ))}
        </div>
      </div>

      {/* Legend */}
      <div className="px-4 py-1.5 border-t border-stealth-border bg-stealth-dark/30 flex items-center gap-3">
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
    <div className="relative h-6 bg-stealth-black rounded-sm overflow-hidden group cursor-default">
      {/* Usage bar */}
      <div
        style={{ width: `${Math.min(usage, 100)}%` }}
        className={`h-full ${color} rounded-sm transition-all duration-75`}
      />
      {/* Core label */}
      <span className="absolute inset-0 flex items-center justify-center text-[7px] font-mono text-white/60 group-hover:text-white transition-colors">
        {index}
      </span>
    </div>
  );
}
