import { useEffect, useRef, useState } from "react";
import type { CpuInfo } from "../lib/types";
import { CPU_GRID_COLS_MIN, coreUsageFillClass, resolveCpuGridColumns } from "../lib/cpuGridLayout";

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
      setCols(resolveCpuGridColumns(el.clientWidth));
    };

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const usages = cpu.core_usages;

  return (
    <div
      ref={wrapRef}
      className={`launch-rail-tel__cpu-grid${className ? ` ${className}` : ""}`}
      style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
    >
      {usages.map((usage, index) => (
        <div
          key={index}
          className="launch-rail-tel__cpu-core"
          title={`CPU ${index}: ${usage.toFixed(0)}%`}
        >
          <div
            className={`launch-rail-tel__cpu-core-fill ${coreUsageFillClass(usage)}`}
            style={{ width: `${Math.min(usage, 100)}%` }}
          />
        </div>
      ))}
    </div>
  );
}