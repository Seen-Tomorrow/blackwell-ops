import { useState, useEffect, useRef, useCallback } from "react";
import { motion, AnimatePresence } from "framer-motion";
import type { ModelEntry } from "../lib/types";
import type { R11PredictiveFit } from "../lib/reactor11";
import { invoke } from "@tauri-apps/api/core";

interface Props {
  models: ModelEntry[];
  onInsertModel: (model: ModelEntry) => Promise<void>;
  onDragStart: (model: ModelEntry, e: React.MouseEvent) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
  gpus: any[];
  dragging: boolean;
}

export default function R11_Sidebar({ models, onInsertModel, onDragStart, collapsed, onToggleCollapse, gpus, dragging }: Props) {
  const [predictiveFit, setPredictiveFit] = useState<R11PredictiveFit | null>(null);
  const [hoveredModel, setHoveredModel] = useState<string | null>(null);

  useEffect(() => {
    if (hoveredModel && gpus.length > 0) {
      invoke<R11PredictiveFit>("r11_predict_fit", { modelPath: hoveredModel, gpus })
        .then(setPredictiveFit)
        .catch(() => setPredictiveFit(null));
    } else {
      setPredictiveFit(null);
    }
  }, [hoveredModel, gpus]);

  return (
    <motion.div
      animate={{ width: collapsed ? 48 : 280 }}
      transition={{ type: "spring", stiffness: 300, damping: 30 }}
      className="relative h-full flex-shrink-0 border-r border-stealth-border bg-stealth-dark/90 backdrop-blur-sm z-10"
    >
      {/* Collapse toggle bar */}
      <button
        onClick={onToggleCollapse}
        className={`absolute top-4 -right-3 w-6 h-8 bg-stealth-panel border border-stealth-border rounded-r-sm flex items-center justify-center hover:border-nv-green/40 transition-colors z-20 ${collapsed ? "top-1/2 -translate-y-1/2" : ""}`}
      >
        <span className={`text-[8px] font-mono text-stealth-muted transition-transform duration-300 ${collapsed ? "-rotate-180" : ""}`}>
          ▶
        </span>
      </button>

       {/* Sidebar header */}
      {!collapsed && (
        <div className="p-3 border-b border-stealth-border relative">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-[12px] font-mono text-nv-green/70 tracking-widest">MODEL RACK</h3>
            <span className="text-[10px] font-mono text-stealth-muted/40">{models.length} MODELS</span>
          </div>

          {/* Drag hint */}
          <div className="border border-dashed border-nv-green/20 rounded-sm p-2 bg-nv-green/[0.03]">
            <p className="text-[9px] font-mono text-stealth-muted/50 text-center leading-relaxed">
              DRAG MODEL TO CORE<br />TO INSERT ROD
            </p>
          </div>

          {/* Predictive fit preview — absolute to prevent layout shift */}
          <AnimatePresence>
            {predictiveFit && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute left-3 right-3 top-[92px] p-2 border border-stealth-border/50 rounded-sm bg-stealth-panel/80 backdrop-blur-md z-10"
              >
                <p className={`text-[10px] font-mono mb-1 ${predictiveFit.fits ? "text-nv-green" : "text-red-400"}`}>
                  {predictiveFit.fits ? "FIT: YES" : "FIT: NO"}
                </p>
                <p className="text-[9px] font-mono text-stealth-muted/60">
                  ~{(predictiveFit.estimated_vram_mib / 1024).toFixed(1)}GB VRAM
                </p>

                {/* GPU detail bars */}
                {predictiveFit.gpu_details.slice(0, 2).map((gpu) => (
                  <div key={gpu.index} className="mt-1">
                    <div className="flex justify-between text-[8px] font-mono text-stealth-muted/40 mb-0.5">
                      <span>GPU-{gpu.index}</span>
                      <span>{(gpu.projected_free_mib / 1024).toFixed(1)}GB free</span>
                    </div>
                    <div className="h-1 bg-stealth-border rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${gpu.can_fit ? "bg-nv-green" : "bg-red-500"}`}
                        style={{ width: `${Math.max(0, Math.min(100, (gpu.projected_free_mib / gpu.total_mib) * 100))}%` }}
                      />
                    </div>
                  </div>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      )}

      {/* Model list */}
      <AnimatePresence>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="flex-1 overflow-y-auto p-2 space-y-1.5"
            style={{ maxHeight: "calc(100vh - 180px)" }}
          >
            {models.map((m) => (
              <ModelCard
                key={m.path}
                model={m}
                onInsert={() => onInsertModel(m)}
                onDragStart={(e) => onDragStart(m, e)}
                onHoverIn={() => setHoveredModel(m.path)}
                onHoverOut={() => setHoveredModel(null)}
                dragging={dragging}
              />
            ))}

            {models.length === 0 && (
              <p className="text-[10px] font-mono text-stealth-muted/40 text-center py-4">
                NO MODELS FOUND<br />CHECK MODEL BASE PATH
              </p>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* Collapsed state */}
      {collapsed && (
        <div className="flex flex-col items-center pt-8 gap-3">
          <span className="text-[12px] text-nv-green/40 rotate-90 tracking-widest font-mono">MODELS</span>
        </div>
      )}
    </motion.div>
  );
}

function ModelCard({
  model,
  onInsert,
  onDragStart,
  onHoverIn,
  onHoverOut,
  dragging,
}: {
  model: ModelEntry;
  onInsert: () => Promise<void>;
  onDragStart: (e: React.MouseEvent) => void;
  onHoverIn: () => void;
  onHoverOut: () => void;
  dragging: boolean;
}) {
  return (
    <motion.div
      onMouseEnter={onHoverIn}
      onMouseLeave={onHoverOut}
      animate={{
        opacity: dragging ? 0.4 : 1,
        scale: dragging ? 0.98 : 1,
      }}
      transition={{ type: "spring", stiffness: 300, damping: 20 }}
      className="border border-stealth-border/50 rounded-sm p-3 cursor-grab hover:border-nv-green/40 bg-stealth-panel/30 transition-all group relative select-none"
    >
      {/* Drag capture layer — plain div so framer-motion doesn't intercept mousedown */}
      <div onMouseDown={(e) => { console.log("[R11-Sidebar] mousedown fired on model card"); onDragStart(e); }} className="absolute inset-0 z-[1] cursor-grab active:cursor-grabbing" />
      <p className="text-[10px] font-mono text-stealth-muted truncate leading-relaxed">{model.name}</p>

      <div className="flex justify-between items-center mt-1.5">
        <span className="text-[9px] font-mono text-nv-green/60">{model.quant}</span>
        <span className="text-[9px] font-mono text-stealth-muted/40">{model.size_str}</span>
      </div>

      {/* Vision indicator */}
      {model.vision && (
        <div className="mt-1 flex items-center gap-1">
          <span className="w-1.5 h-1.5 rounded-full bg-telemetry-cyan/60" />
          <span className="text-[8px] font-mono text-telemetry-cyan/50">VISION</span>
        </div>
      )}

      {/* Insert button */}
      <button
        onClick={(e) => { e.stopPropagation(); onInsert(); }}
        className="absolute top-1.5 right-1.5 w-4 h-4 flex items-center justify-center rounded-sm border border-nv-green/30 text-nv-green/60 hover:bg-nv-green/20 hover:border-nv-green/60 transition-colors opacity-0 group-hover:opacity-100"
        title="Insert rod"
      >
        <svg width="8" height="8" viewBox="0 0 8 8" fill="none">
          <path d="M4 0L4 7M1 3.5L4 7L7 3.5" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/>
        </svg>
      </button>

      {/* Hover glow */}
      <div className="absolute inset-0 rounded-sm bg-nv-green/5 opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity" />
    </motion.div>
  );
}
