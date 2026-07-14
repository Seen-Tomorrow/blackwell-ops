import { useMemo } from "react";
import type { ModelEntry, StackEntry } from "../lib/types";
import { DEFAULT_BINARY_PROFILE, ENV_META, type Env } from "../lib/foundry_constants";

function runtimeProfileLabel(binaryProfile?: string): string {
  const key = (binaryProfile || DEFAULT_BINARY_PROFILE).toLowerCase() as Env;
  return ENV_META[key]?.label ?? key.toUpperCase();
}

function runtimeSplitLabel(splitMode?: string): string {
  const raw = String(splitMode ?? "none").trim().toLowerCase();
  return raw.length > 0 ? raw : "none";
}

interface RunningEnginesPanelProps {
  stack: StackEntry[];
  models: ModelEntry[];
  selectedSlotIdx: number | null;
  onSelectEngine: (slotIdx: number) => void;
  /** Compact vertical chips for launch rail. */
  variant?: "default" | "rail";
}

export default function RunningEnginesPanel({
  stack,
  models,
  selectedSlotIdx,
  onSelectEngine,
  variant = "default",
}: RunningEnginesPanelProps) {
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

  if (variant === "rail") {
    return (
      <div className="launch-rail-engines shrink-0">
        <p className="launch-rail-engines__label text-[7px] font-mono uppercase tracking-wider text-stealth-muted/50 px-0.5 mb-1">
          Running · {instances.length}
        </p>
        <div className="launch-rail-engines__list flex flex-col gap-1">
          {instances.map((item) => {
            const isThisSelected = selectedSlotIdx === item.entry.idx;
            const gpuLabel = item.entry.gpu.split(",").map((g) => `G${g.trim()}`).join(",");
            return (
              <button
                key={`slot-${item.entry.idx}`}
                type="button"
                onClick={() => onSelectEngine(item.entry.idx)}
                className={`launch-rail-engine-chip w-full text-left rounded-sm px-2 py-1 border flex items-center gap-1.5 min-w-0 transition-colors ${
                  isThisSelected ? "launch-rail-engine-chip--selected" : ""
                }`}
              >
                <span className="text-[8px] font-mono text-white/80 shrink-0 tabular-nums">
                  :{item.entry.port}
                </span>
                <span className="text-[8px] font-mono text-nv-green/90 shrink-0 truncate max-w-[3.5rem]" title={item.entry.alias}>
                  {item.entry.alias}
                </span>
                <span className="text-[7px] font-mono text-telemetry-cyan/80 shrink-0">{gpuLabel}</span>
                <span className="text-[7px] font-mono text-stealth-muted/55 truncate flex-1 min-w-0" title={item.modelName}>
                  {item.modelName}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="border-t border-stealth-border/50">
      <div className="px-3 py-2.5 running-engines-header-row flex-shrink-0">
        <h3 className="text-xl font-mono tracking-widest uppercase block text-center text-white/60">
          ▼ RUNNING ENGINES ({instances.length})
        </h3>
      </div>
      <div className="running-engines-scroll px-3 pb-2 eink-scrollbar">
      <div className="grid grid-cols-2 gap-1">
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
              <div className="flex flex-col shrink-0 gap-0.5 items-start max-w-[4.25rem]">
                <span className="text-[8px] font-mono text-telemetry-cyan bg-telemetry-cyan/10 border border-telemetry-cyan/20 px-1 py-0.5 rounded-sm leading-none">
                  {gpuLabel}
                </span>
                <span className="running-engine-profile-label pl-0.5">
                  S: {runtimeSplitLabel(item.entry.splitMode)}
                </span>
              </div>
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
    </div>
  );
}
