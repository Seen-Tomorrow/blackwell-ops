import { useEffect, useRef, useState } from "react";
import type { CpuInfo } from "../../lib/types";
import { CPU_GRID_COLS_MIN, cpuCoreFill, resolveCpuGridColumns } from "../../lib/cpuGridLayout";
import HwFill from "./HwFill";

interface CpuCoreGridProps {
  cpu: CpuInfo;
  className?: string;
}

export default function CpuCoreGrid({ cpu, className = "" }: CpuCoreGridProps) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [cols, setCols] = useState(CPU_GRID_COLS_MIN);

  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;

    const measure = () => {
      setCols(resolveCpuGridColumns(el.clientWidth, undefined, undefined, undefined, undefined, cpu.threads));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [cpu.threads]);

  return (
    <div
      ref={wrapRef}
      className={`hw-cpu__grid${className ? ` ${className}` : ""}`}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {cpu.core_usages.map((usage, index) => (
        <div key={index} className="hw-cpu__core" title={`CPU ${index}: ${usage.toFixed(0)}%`}>
          <HwFill
            className="hw-cpu__core-fill"
            fill={cpuCoreFill(usage)}
            percent={usage}
            stepPct={5}
            animateDeltaPct={10}
          />
        </div>
      ))}
    </div>
  );
}
