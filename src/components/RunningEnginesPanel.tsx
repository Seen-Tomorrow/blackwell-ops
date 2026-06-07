import { useMemo } from "react";
import type { ModelEntry, StackEntry } from "../lib/types";
import { ENV_META, type Env } from "../lib/foundry_constants";

function runtimeProfileLabel(binaryProfile?: string): string {
  const key = (binaryProfile || "vanguard").toLowerCase() as Env;
  return ENV_META[key]?.label ?? key.toUpperCase();
}

interface RunningEnginesPanelProps {
  stack: StackEntry[];
  models: ModelEntry[];
  selectedSlotIdx: number | null;
  onSelectEngine: (slotIdx: number) => void;
}

export default function RunningEnginesPanel({ stack, models, selectedSlotIdx, onSelectEngine }: RunningEnginesPanelProps) {
  const instances = useMemo(() => {
    const result: { entry: StackEntry; modelName: string; quant: string; sizeStr: string; vramUsedGb?: number }[] = [];
    for (const s of stack) {
      if (s.status !== "RUNNING" && s.status !== "LOADING") continue;
      const model = models.find(m => m.path === s.model_path);
      result.push({
        entry: s,
        modelName: model?.name || s.model_name || "",
        quant: model?.quant || "",
        sizeStr: model?.size_str || "",
        vramUsedGb: s.vram_mib ? s.vram_mib / 1024 : undefined,
      });
    }
    return result;
  }, [stack, models]);

  if (instances.length === 0) return null;

  return (
    <div className="border-t border-stealth-border/50">
      <div className="px-3 py-2.5 running-engines-header-row">
        <h3 className="text-xl font-mono tracking-widest uppercase block text-center text-white/60">
          ▼ RUNNING ENGINES
        </h3>
      </div>
      <div className="px-3 pb-2 grid grid-cols-2 gap-1">
        {instances.map(item => {
          const isThisSelected = selectedSlotIdx === item.entry.idx;
          const isNvfp = item.quant.toLowerCase().includes("nvfp");
          const gpuLabel = item.entry.gpu.split(',').map(g => `GPU${g.trim()}`).join(', ');
          return (
            <div
              key={`slot-${item.entry.idx}`}
              onClick={() => onSelectEngine(item.entry.idx)}
              className={`cursor-pointer rounded-sm px-2.5 py-2 border flex items-center gap-2 running-engine-card engine-panel-enter ${
                isThisSelected
                  ? "running-engine-card-selected"
                  : ""
              }`}
            >
              <div className="flex flex-col shrink-0 gap-0.5 max-w-[4.5rem]">
                <span className="text-[9px] font-mono text-white/70 truncate" title={item.entry.alias}>
                  {item.entry.alias}
                </span>
                <span className="running-engine-profile-label font-mono uppercase tracking-wider truncate">
                  {runtimeProfileLabel(item.entry.binaryProfile)}
                </span>
              </div>
              <span className="text-[8px] font-mono text-telemetry-cyan shrink-0 bg-telemetry-cyan/10 border border-telemetry-cyan/20 px-1 py-0.5 rounded-sm">
                {gpuLabel}
              </span>
              <span
                className={`text-[10px] font-mono truncate flex-1 min-w-0 ${isThisSelected ? "text-nv-green" : "text-white"}`}
                title={item.modelName}
              >
                {item.modelName}
              </span>
              {item.quant && (
                <span className={`text-[7px] font-mono px-1 py-0.5 rounded-sm shrink-0 ${isNvfp
                  ? 'bg-nv-green/20 border border-nv-green/40 text-nv-green'
                  : 'border border-telemetry-cyan/30 text-telemetry-cyan'}`}>
                  {item.quant}
                </span>
              )}
              {item.vramUsedGb != null && (
                <span className="text-[8px] font-mono text-stealth-muted shrink-0">
                  {item.vramUsedGb.toFixed(1)} GB
                </span>
              )}
              <span className="text-[7px] font-mono text-stealth-muted/50 shrink-0">
                :{item.entry.port}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
