import { useMemo, type ReactNode } from "react";
import type { ModelEntry, StackEntry } from "../lib/types";
import { DEFAULT_BINARY_PROFILE, ENV_META, type Env } from "../lib/foundry_constants";

function runtimeProfileLabel(binaryProfile?: string): string {
  const key = (binaryProfile || DEFAULT_BINARY_PROFILE).toLowerCase() as Env;
  return ENV_META[key]?.label ?? key.toUpperCase();
}

function runtimeProviderLabel(entry: StackEntry): string {
  const name = (entry.provider_name || entry.provider_type || "").trim();
  return name;
}

/** e.g. "GGML master | FRONTIER" — provider + runtime profile for mixed stacks */
function runtimeEngineSourceLabel(entry: StackEntry): string {
  const profile = runtimeProfileLabel(entry.binaryProfile);
  const provider = runtimeProviderLabel(entry);
  return provider ? `${provider} | ${profile}` : profile;
}

function runtimeSplitMode(splitMode?: string): string {
  const raw = String(splitMode ?? "none").trim().toLowerCase();
  return raw.length > 0 ? raw : "none";
}

function parseGpuIndices(gpuField: string): string[] {
  return String(gpuField ?? "")
    .split(",")
    .map((g) => g.trim().replace(/^GPU-/i, ""))
    .filter((g) => g.length > 0);
}

/** ≤8: GPU0 · >8: G0 (fits dense multi-GPU). */
function gpuTag(id: string, short: boolean): string {
  return short ? `G${id}` : `GPU${id}`;
}

function runtimeGpuTitle(gpuField: string, splitMode?: string): string {
  const indices = parseGpuIndices(gpuField);
  const split = runtimeSplitMode(splitMode);
  const list = indices.length > 0 ? indices.map((id) => `GPU${id}`).join(", ") : "—";
  return split !== "none" ? `${list} · split ${split}` : list;
}

/**
 * Individual GPU badges; active split sits between chips with bidirectional arrows.
 * e.g. [GPU0] ⇄layer⇄ [GPU1] ⇄layer⇄ [GPU2]
 */
function GpuTopoBadges({
  gpuField,
  splitMode,
  compact = false,
}: {
  gpuField: string;
  splitMode?: string;
  /** Rail chips — slightly tighter. */
  compact?: boolean;
}) {
  const indices = parseGpuIndices(gpuField);
  const short = indices.length > 8;
  const split = runtimeSplitMode(splitMode);
  const title = runtimeGpuTitle(gpuField, splitMode);

  if (indices.length === 0) {
    return (
      <span className="running-engine-gpu-badge" title={title}>
        GPU?
      </span>
    );
  }

  const nodes: ReactNode[] = [];
  indices.forEach((id, i) => {
    if (i > 0) {
      if (split !== "none") {
        nodes.push(
          <span key={`link-${i}`} className="running-engine-gpu-link" aria-hidden>
            ⇄{split}⇄
          </span>,
        );
      }
    }
    nodes.push(
      <span key={`gpu-${id}-${i}`} className="running-engine-gpu-badge">
        {gpuTag(id, short)}
      </span>,
    );
  });

  return (
    <span
      className={`running-engine-gpu-badges${compact ? " running-engine-gpu-badges--compact" : ""}`}
      title={title}
    >
      {nodes}
    </span>
  );
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
                <span
                  className="text-[6px] font-mono text-stealth-muted/70 shrink-0 truncate max-w-[5.5rem] uppercase tracking-wide"
                  title={runtimeEngineSourceLabel(item.entry)}
                >
                  {runtimeEngineSourceLabel(item.entry)}
                </span>
                <GpuTopoBadges
                  gpuField={item.entry.gpu}
                  splitMode={item.entry.splitMode}
                  compact
                />
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
          const sourceLabel = runtimeEngineSourceLabel(item.entry);
          return (
            <div
              key={`slot-${item.entry.idx}`}
              onClick={() => onSelectEngine(item.entry.idx)}
              className={`cursor-pointer rounded-sm px-2.5 py-1.5 border flex flex-col gap-0.5 min-w-0 running-engine-card engine-panel-enter ${
                isThisSelected
                  ? "running-engine-card-selected"
                  : ""
              }`}
            >
              {/* Row 1: fixed-width alias → model names align across cards */}
              <div className="flex items-center gap-2 min-w-0 w-full">
                <span
                  className="running-engine-alias font-mono text-[9px] text-white/70 shrink-0 truncate"
                  title={item.entry.alias}
                >
                  {item.entry.alias}
                </span>
                <span
                  className={`text-[10px] font-mono truncate flex-1 min-w-0 ${isThisSelected ? "text-nv-green" : "text-white"}`}
                  title={item.modelName}
                >
                  {item.modelName}
                </span>
                {item.quant && (
                  <span className={`text-[7px] font-mono px-1 py-0.5 rounded-sm shrink-0 ${isNvfp
                    ? "bg-nv-green/20 border border-nv-green/40 text-nv-green"
                    : "border border-telemetry-cyan/30 text-telemetry-cyan"}`}>
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
              {/*
                Row 2: per-GPU badges (+ split links); provider|profile hugs right.
              */}
              <div className="running-engine-card__meta flex items-center gap-1.5 min-w-0 w-full">
                <GpuTopoBadges
                  gpuField={item.entry.gpu}
                  splitMode={item.entry.splitMode}
                />
                <span
                  className="running-engine-profile-label font-mono uppercase tracking-wider shrink-0 whitespace-nowrap ml-auto"
                  title={sourceLabel}
                >
                  {sourceLabel}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      </div>
    </div>
  );
}
