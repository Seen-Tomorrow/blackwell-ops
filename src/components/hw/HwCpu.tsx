import type { KeyboardEvent, ReactNode } from "react";
import type { CpuInfo } from "../../lib/types";
import { cpuAvgFill, cpuClockTitle, formatCpuClock } from "../../lib/hwReadouts";
import CpuCoreGrid from "./CpuCoreGrid";
import HwFill from "./HwFill";

const SURFACE = "phosphor-display-surface";

interface HwCpuProps {
  cpu: CpuInfo;
  coresOpen: boolean;
  /** Compact IS the closed-cores shape: header + average bar, nothing to expand. */
  compact: boolean;
  onToggleCores: () => void;
}

export default function HwCpu({ cpu, coresOpen, compact, onToggleCores }: HwCpuProps) {
  const showCores = coresOpen && !compact;
  const avg = Math.round(cpu.avg_usage_percent);
  const liveMhz = cpu.current_clock_mhz ?? 0;
  const baseMhz = cpu.max_clock_mhz ?? 0;
  // Cores open → hero readout is live frequency; closed → average usage %.
  const heroVal = showCores
    ? liveMhz > 0
      ? String(liveMhz)
      : baseMhz > 0
        ? String(baseMhz)
        : "—"
    : String(avg);
  const heroUnit = showCores ? "MHz" : "%";
  const heroTitle = showCores ? cpuClockTitle(cpu) : `Average utilization ${avg}%`;

  const onHeadKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onToggleCores();
    }
  };

  const head: ReactNode = (
    <>
      <div className="hw-cpu__id">
        <p className="hw-cpu__name" title={cpu.name}>
          {cpu.name}
        </p>
        <p className="hw-cpu__meta" title={cpuClockTitle(cpu)}>
          {cpu.cores}C/{cpu.threads}T
          {showCores ? ` · ${avg}%` : ` · ${formatCpuClock(cpu)}`}
        </p>
      </div>
      <div className="hw-cpu__head-right">
        {!compact && (
          <span className="hw-cpu__cores-badge" data-on={coresOpen ? "true" : "false"}>
            CORES {coresOpen ? "ON" : "OFF"}
          </span>
        )}
        <div className="hw-cpu__hero" data-mhz={showCores ? "true" : "false"} title={heroTitle}>
          <span className="hw-cpu__hero-val">{heroVal}</span>
          <span className="hw-cpu__hero-unit">{heroUnit}</span>
        </div>
      </div>
    </>
  );

  return (
    <div className={`hw-cpu ${SURFACE}`} data-cores={showCores ? "open" : "closed"}>
      {compact ? (
        <div className="hw-cpu__head">{head}</div>
      ) : (
        <div
          className="hw-cpu__head hw-cpu__head--toggle"
          role="button"
          tabIndex={0}
          onClick={onToggleCores}
          onKeyDown={onHeadKeyDown}
          title={coresOpen ? "Hide per-core grid" : "Show per-core grid"}
          aria-pressed={coresOpen}
        >
          {head}
        </div>
      )}
      <div className="hw-cpu__track">
        <HwFill className="hw-cpu__fill" fill={cpuAvgFill(avg)} percent={avg} />
      </div>
      {showCores ? <CpuCoreGrid cpu={cpu} /> : null}
    </div>
  );
}
