import { useState, useEffect, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { GpuInfo, ModelEntry } from "../lib/types";
import type { ReactorStatus, RodHandle, RodStatus } from "../lib/reactor";

interface Props {
  gpus: GpuInfo[];
  models: ModelEntry[];
}

function getRodStatus(status: any): string {
  if (!status) return "idle";
  if (typeof status === "string") return status.toLowerCase();
  if (status.type) return status.type.toLowerCase();
  return "unknown";
}

export default function ReactorCore({ gpus, models }: Props) {
  const [rods, setRods] = useState<RodHandle[]>([]);
  const [tierEnabled, setTierEnabled] = useState(false);
  const [draggedModel, setDraggedModel] = useState<ModelEntry | null>(null);

  useEffect(() => {
    invoke<ReactorStatus>("reactor_get_status")
      .then((s) => {
        setRods(s.rods);
        setTierEnabled(s.tier_enabled);
      })
      .catch(console.error);
  }, []);

  const totalVramUsed = rods.reduce((sum, r) => sum + (r.vram_mib || 0), 0);

  const handleDragStart = useCallback((model: ModelEntry) => {
    setDraggedModel(model);
  }, []);

  const handleDrop = useCallback(async () => {
    if (!draggedModel) return;

    try {
      await invoke("reactor_insert_rod", {
        config: {
          alias: `${draggedModel.name} (${draggedModel.quant})`,
          model_path: draggedModel.path,
          port: 0,
          device: "GPU-0",
          kv_quant: draggedModel.quant.toLowerCase().includes("q4") ? "Q4_K" : "F16",
          ctx_size: "32K",
          batch: 2048,
          ubatch: 512,
          parallel: 1,
          offload: "ALL",
          offload_mode: "REGULAR",
          split_mode: "",
          vision: draggedModel.vision ? "AUTO" : "OFF",
          flash_attn: true,
          jinja: false,
          cont_batching: true,
          metrics: false,
          reasoning: false,
          mmap: true,
        },
        gpus,
      });
      
      const status = await invoke<ReactorStatus>("reactor_get_status");
      setRods(status.rods);
    } catch (err) {
      console.error("Insert failed:", err);
    } finally {
      setDraggedModel(null);
    }
  }, [draggedModel, gpus]);

  const handleRemoveRod = useCallback(async (rodId: string) => {
    try {
      await invoke("reactor_remove_rod", { rodId });
      setRods((prev) => prev.filter((r) => r.id !== rodId));
    } catch (err) {
      console.error("Remove failed:", err);
    }
  }, []);

  const handleToggleTier = useCallback(async () => {
    try {
      const enabled = await invoke<boolean>("reactor_toggle_tier");
      setTierEnabled(enabled);
    } catch (err) {
      console.error("Toggle tier failed:", err);
    }
  }, []);

  return (
    <div className="h-full flex flex-col p-4 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-stealth-border pb-3">
        <div>
          <h2 className="text-sm font-mono text-nv-green tracking-widest">REACTOR CORE v0.1</h2>
          <p className="text-[10px] font-mono text-stealth-muted/50 mt-0.5">
            {rods.length} ROD{rods.length !== 1 ? "S" : ""} ACTIVE — {totalVramUsed.toFixed(0)}MB VRAM
          </p>
        </div>
        <button
          onClick={handleToggleTier}
          className={`px-3 py-1 text-[10px] font-mono tracking-wider border transition-colors ${
            tierEnabled
              ? "border-red-500/50 text-red-400 bg-red-500/10"
              : "border-stealth-border text-stealth-muted hover:border-orange-500/30"
          }`}
        >
          TIER-{tierEnabled ? "1" : "0"}
        </button>
      </div>

      {/* GPU Status Bar */}
      <div className="flex gap-2">
        {gpus.map((gpu, i) => {
          const usedPct = (gpu.memory_used / gpu.memory_total) * 100;
          const isOverwhelmed = rods.some(
            (r) =>
              r.allocation?.type === "Split" ||
              (r.allocation?.type === "Dedicated" && r.allocation.gpus?.[0] === i)
          );

          return (
            <div
              key={gpu.index}
              className={`flex-1 border rounded-sm p-2 ${
                isOverwhelmed ? "border-nv-green/30" : "border-stealth-border"
              }`}
            >
              <div className="flex justify-between text-[10px] font-mono mb-1">
                <span className={isOverwhelmed ? "text-nv-green" : "text-stealth-muted"}>
                  GPU-{gpu.index}
                </span>
                <span className="text-stealth-muted/50">
                  {((gpu.memory_total - gpu.memory_free) / 1024).toFixed(1)}GB /{" "}
                  {(gpu.memory_total / 1024).toFixed(0)}GB
                </span>
              </div>
              <CoolantBar percent={100 - usedPct} temperature={gpu.temperature_gpu} />
            </div>
          );
        })}
      </div>

      {/* Rod Wells */}
      <div className="flex-1 flex gap-2">
        {/* FLOOR 1: ROD_A1-A8 */}
        <div className="w-3/4 border border-nv-green/20 bg-stealth-panel/30 rounded-sm p-2">
          <p className="text-[10px] font-mono text-nv-green/50 mb-2 tracking-wider">FLOOR 1 — PRIMARY</p>
          <div
            className={`grid grid-cols-4 gap-2 ${draggedModel ? "ring-1 ring-nv-green/40 rounded" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            {[...Array(8)].map((_, i) => {
              const rodId = `ROD_A${i + 1}`;
              const rod = rods.find((r) => r.id === rodId);
              return (
                <RodWell
                  key={rodId}
                  id={rodId}
                  rod={rod}
                  onRemove={() => handleRemoveRod(rodId)}
                  index={i}
                />
              );
            })}
          </div>
        </div>

        {/* FLOOR 2: ROD_B1-B8 (Overflow) */}
        <div className="w-1/4 border border-stealth-border/50 bg-stealth-panel/20 rounded-sm p-2">
          <p className="text-[10px] font-mono text-orange-400/50 mb-2 tracking-wider">FLOOR 2</p>
          <div
            className={`grid grid-rows-4 gap-2 ${draggedModel ? "ring-1 ring-nv-green/40 rounded" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={handleDrop}
          >
            {[...Array(8)].map((_, i) => {
              const rodId = `ROD_B${i + 1}`;
              const rod = rods.find((r) => r.id === rodId);
              return (
                <RodWell
                  key={rodId}
                  id={rodId}
                  rod={rod}
                  onRemove={() => handleRemoveRod(rodId)}
                  index={i}
                  vertical
                />
              );
            })}
          </div>
        </div>

        {/* Model Catalog Sidebar */}
        <ModelDropZone models={models} onDragStart={handleDragStart} />
      </div>
    </div>
  );
}

function CoolantBar({ percent, temperature }: { percent: number; temperature: number }) {
  const heatLevel = Math.min(100, (temperature / 80) * 100);
  
  // Color gradient based on temperature
  const colorStop = temperature < 50 ? "bg-nv-green" : temperature < 65 ? "bg-orange-400" : "bg-red-500";
  const bgOpacity = temperature > 70 ? "after:bg-red-500/10" : "";

  return (
    <div className="h-3 bg-stealth-panel border border-stealth-border rounded-full overflow-hidden relative">
      {/* Coolant level */}
      <div
        className={`absolute inset-y-0 left-0 ${colorStop} transition-all duration-500`}
        style={{ width: `${percent}%`, opacity: 0.6 }}
      />
      
      {/* Heat shimmer overlay when hot */}
      {temperature > 65 && (
        <div
          className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent animate-pulse"
          style={{ animationDuration: "1s" }}
        />
      )}
    </div>
  );
}

function RodWell({
  id,
  rod,
  onRemove,
  index,
  vertical = false,
}: {
  id: string;
  rod?: RodHandle;
  onRemove: () => void;
  index: number;
  vertical?: boolean;
}) {
  const isEmpty = !rod;

  if (isEmpty) {
    return (
      <div
        className={`bg-stealth-panel/30 border border-dashed border-nv-green/20 rounded-sm p-2 ${
          vertical ? "h-12" : ""
        }`}
      >
        <span className="text-[9px] font-mono text-nv-green/30">{id}</span>
      </div>
    );
  }

  const statusType = getRodStatus(rod.status);
  const isRunning = statusType === "running";
  const isError = statusType === "error";

  return (
    <div
      className={`relative group border rounded-sm p-2 ${
        vertical ? "h-12" : ""
      } ${
        isRunning
          ? "border-nv-green/60 bg-nv-green/5"
          : isError
          ? "border-red-500/40 bg-red-500/5"
          : "border-orange-400/30 bg-stealth-panel border-orange-400/20"
      }`}
    >
      <div className="flex justify-between items-start">
        <span className={`text-[9px] font-mono tracking-wider ${
          isRunning ? "text-nv-green" : isError ? "text-red-400" : "text-orange-400"
        }`}>
          {id}
        </span>
        
        {/* Status LED */}
        <div
          className={`w-1.5 h-1.5 rounded-full ${
            isRunning
              ? "bg-nv-green animate-pulse"
              : isError
              ? "bg-red-500"
              : "bg-orange-400"
          }`}
        />
      </div>
      
      {rod.alias && (
        <p className="text-[8px] font-mono text-stealth-muted/70 mt-1 truncate" title={rod.alias}>
          {rod.alias.length > 12 ? rod.alias.slice(0, 10) + ".." : rod.alias}
        </p>
      )}
      
      <div className="mt-1">
        <CoolantBar
          percent={(rod.vram_mib / (96 * 1024)) * 100}
          temperature={50}
        />
      </div>

      {/* Remove button */}
      <button
        onClick={onRemove}
        className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 w-3 h-3 bg-red-500/60 hover:bg-red-500 rounded-sm flex items-center justify-center transition-opacity"
      >
        <span className="text-[6px] text-white">✕</span>
      </button>

      {/* TIER-1 diagnostic overlay */}
      {isRunning && (
        <div className={`absolute inset-0 pointer-events-none ${statusType === "running" ? "" : ""}`}>
          <DiagnosticOverlay rod={rod} />
        </div>
      )}
    </div>
  );
}

function DiagnosticOverlay({ rod }: { rod: RodHandle }) {
  return (
    <svg className="absolute inset-0 w-full h-full opacity-20">
      {/* Plasma lines */}
      {[...Array(3)].map((_, i) => (
        <line
          key={i}
          x1={`${10 + i * 30}%`}
          y1="0"
          x2={`${15 + i * 25}%`}
          y2="100%"
          stroke="#00ff88"
          strokeWidth="0.5"
          style={{
            animationDelay: `${i * 200}ms`,
            opacity: 0.3,
          }}
        />
      ))}
    </svg>
  );
}

function ModelDropZone({
  models,
  onDragStart,
}: {
  models: ModelEntry[];
  onDragStart: (m: ModelEntry) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  
  const toggleCollapse = () => setCollapsed(!collapsed);

  if (collapsed) {
    return (
      <div className="w-8 bg-stealth-panel/50 border-l border-nv-green/20 flex items-center justify-center">
        <button
          onClick={toggleCollapse}
          className="text-[10px] font-mono text-nv-green/40 hover:text-nv-green"
        >
          MODELS ▶
        </button>
      </div>
    );
  }

  return (
    <div className="w-48 border border-stealth-border bg-stealth-panel/30 rounded-sm p-2">
      <div className="flex justify-between items-center mb-2">
        <p className="text-[10px] font-mono text-nv-green/50 tracking-wider">MODELS</p>
        <button
          onClick={toggleCollapse}
          className="text-[8px] font-mono text-stealth-muted hover:text-nv-green"
        >
          ◀
        </button>
      </div>

      {/* Drag hint */}
      <div className="border border-dashed border-nv-green/30 rounded-sm p-2 mb-2 bg-nv-green/5">
        <p className="text-[8px] font-mono text-stealth-muted/60 text-center">
          DROP TO INSERT
        </p>
      </div>

      {/* Model list */}
      <div className="space-y-1 max-h-64 overflow-y-auto">
        {models.map((m) => (
          <DraggableModelCard key={m.path} model={m} onDragStart={onDragStart} />
        ))}
      </div>
    </div>
  );
}

function DraggableModelCard({
  model,
  onDragStart,
}: {
  model: ModelEntry;
  onDragStart: (m: ModelEntry) => void;
}) {
  return (
    <div
      draggable
      onDragStart={() => onDragStart(model)}
      className="border border-stealth-border/50 rounded-sm p-1.5 cursor-grab hover:border-nv-green/40 bg-stealth-panel/30 group"
    >
      <p className="text-[9px] font-mono text-stealth-muted truncate">{model.name}</p>
      <div className="flex justify-between mt-0.5">
        <span className="text-[7px] font-mono text-nv-green/60">{model.quant}</span>
        <span className="text-[7px] font-mono text-stealth-muted/40">{model.size_str}</span>
      </div>
    </div>
  );
}