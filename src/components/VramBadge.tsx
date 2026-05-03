/**
 * VRAM Badge Component — Status display with GPU topology and guidance actions
 */

import { motion } from "framer-motion";
import type { VramStatus, GpuDistribution, RamEstimate, AutoOffloadResult } from "../hooks/useVramCalculator";
import type { GpuInfo } from "../lib/types";
import GpuTopology from "./GpuTopology";

interface VramDisplayResult {
  status: VramStatus;
  vramNeededMib: number;
  action: string;
  headroomMib: number;
  isCalibrated?: boolean;
}

interface VramBadgeProps {
  result: VramDisplayResult | null;
  gpus: GpuInfo[];
  gpuDistribution: GpuDistribution[];
  ramEstimate: RamEstimate | null;
  availableVramGb: number;
  committedVramMib: number;
  onFitCheck?: () => Promise<unknown> | null | void;
  isScanning: boolean;
  shouldShowRam?: boolean;
  modelName?: string;
  modelSizeStr?: string;
  autoOffload?: AutoOffloadResult | null;
}

const STATUS_CONFIG = {
  safe: {
    label: "Safe",
    color: "text-nv-green border-nv-green/30 bg-nv-green/5",
    badgeBg: "bg-nv-green/20",
    icon: "◉",
  },
  optimized: {
    label: "Optimized", 
    color: "text-telemetry-cyan border-telemetry-cyan/30 bg-telemetry-cyan/5",
    badgeBg: "bg-telemetry-cyan/20",
    icon: "◆",
  },
  pressure: {
    label: "Pressure",
    color: "text-yellow-400 border-yellow-400/30 bg-yellow-400/5",
    badgeBg: "bg-yellow-400/20",
    icon: "◐",
  },
  danger: {
    label: "Danger",
    color: "text-telemetry-red border-telemetry-red/30 bg-telemetry-red/5",
    badgeBg: "bg-telemetry-red/20",
    icon: "◆",
  },
  critical: {
    label: "Critical", 
    color: "text-white border-white/50 bg-black animate-pulse",
    badgeBg: "bg-white/10",
    icon: "!",
  },
};

export default function VramBadge({
  result,
  gpus,
  gpuDistribution,
  ramEstimate,
  availableVramGb,
  committedVramMib,
  onFitCheck,
  isScanning,
  shouldShowRam = false,
  modelName,
  modelSizeStr,
  autoOffload,
}: VramBadgeProps) {
  if (!result) return null;

  const { status, vramNeededMib, action, headroomMib, isCalibrated } = result;
  const cfg = STATUS_CONFIG[status];
  
  const neededGb = (vramNeededMib / 1024).toFixed(1);
  const availableStr = availableVramGb.toFixed(0);

  return (
    <div className={`border rounded-sm px-3 py-2.5 ${cfg.color}`}>
      {isCalibrated ? (
        // ── Calibrated state: Memory forecast LEFT, Badge RIGHT ────────────
        <div className="flex gap-4">
          {/* Left half: Memory values */}
          <div className="flex-1 space-y-2 min-w-0">
            <span className={`text-[10px] font-mono ${cfg.color}`}>
              {cfg.icon} MEMORY FORECAST
            </span>
            
            <div className="flex items-baseline justify-center gap-2">
              <span className={`text-xl font-mono ${cfg.color}`}>{neededGb}</span>
              <span className="text-[10px] font-mono text-stealth-muted">GB /</span>
              <span className="text-[10px] font-mono text-nv-green">{availableStr} GB</span>
            </div>

            {/* GPU topology in calibrated view */}
            {gpuDistribution.length > 0 && (
              <GpuTopology 
                distribution={gpuDistribution} 
                ramEstimate={ramEstimate} 
                status={status} 
                shouldShowRam={shouldShowRam || !!(ramEstimate && ramEstimate.spillMib > 0)} 
              />
            )}
            
            {action && (
              <p className={`text-[9px] font-mono ${cfg.color}`}>→ {action}</p>
            )}

            {/* Auto-offload layer breakdown */}
            {autoOffload && autoOffload.ramLayers > 0 && (
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[8px] font-mono text-nv-green">{autoOffload.nGpuLayers} layers on GPU</span>
                <span className="text-[8px] font-mono text-stealth-muted">/</span>
                <span className={`text-[8px] font-mono ${autoOffload.fitsRam ? "text-yellow-400" : "text-telemetry-red"}`}>
                  {autoOffload.ramLayers} in RAM ({(autoOffload.ramSpillMib / 1024).toFixed(1)} GB)
                </span>
              </div>
            )}
          </div>

          {/* Right half: Calibrated Badge */}
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            className="flex-1 flex flex-col justify-center border-l border-stealth-border/30 pl-4"
          >
            <div className={`inline-flex items-center gap-1.5 px-2 py-0.5 rounded-sm ${cfg.badgeBg}`}>
              <span className="text-[10px] font-mono">💎 CALIBRATED</span>
            </div>
            
            <div className="space-y-1 mt-2">
              {headroomMib > 0 ? (
                <>
                  <p className="text-[11px] font-mono text-telemetry-green">
                    {(headroomMib / 1024).toFixed(1)} GB Headroom
                  </p>
                  <p className="text-[8px] font-mono text-stealth-muted opacity-60">Zero RAM Spill</p>
                </>
              ) : (
                <>
                  <p className="text-[11px] font-mono text-telemetry-red">
                    {(Math.abs(headroomMib) / 1024).toFixed(1)} GB Over
                  </p>
                  <p className="text-[8px] font-mono text-yellow-400 opacity-70">RAM Offload Needed</p>
                </>
              )}
            </div>

            {status === 'danger' && (
              <button
                onClick={onFitCheck}
                disabled={isScanning}
                className="w-full mt-2 px-2 py-1 text-[9px] font-mono border border-telemetry-red/60 
                           text-telemetry-red hover:bg-telemetry-red/10 transition-colors rounded-sm"
              >
                Re-calibrate
              </button>
            )}
          </motion.div>
        </div>
      ) : (
        // ── Estimated state: GPU topology + action buttons ────────────────
        <div className="space-y-2">
          {/* Header row */}
          <div className="flex items-center justify-between">
            <span className={`text-[10px] font-mono text-telemetry-cyan`}>
              ESTIMATED VRAM for {modelName} — {modelSizeStr}
            </span>
          </div>

          {/* Memory values + inline FIT CHECK */}
          <div className="flex items-center justify-between">
            <span className="text-[10px] font-mono text-stealth-muted">
              need <span className={`text-xl font-mono ${cfg.color}`}>{neededGb}</span> GB from <span className="text-nv-green">{availableStr} GB</span> available
            </span>
            {onFitCheck && (
              <button
                onClick={() => {
                  if (onFitCheck) {
                    const r = onFitCheck();
                    Promise.resolve(r).catch(e => console.error("[VramBadge]", e));
                  }
                }}
                disabled={isScanning}
                className="px-2 py-0.5 text-[8px] font-mono border border-telemetry-cyan/40 
                           text-telemetry-cyan hover:bg-telemetry-cyan/10 rounded-sm transition-colors disabled:opacity-40 ml-3 flex-shrink-0"
              >
                {isScanning ? 'CALIBRATING...' : 'FIT CHECK'}
              </button>
            )}
          </div>

          {/* GPU Topology */}
          {gpuDistribution.length > 0 && (
            <GpuTopology 
              distribution={gpuDistribution} 
              ramEstimate={ramEstimate} 
              status={status} 
            />
          )}

          {/* Guidance action text only (no FIT CHECK button here anymore) */}
          {action && (
            <div className="flex items-center justify-center">
              <span className={`text-[9px] font-mono ${cfg.color}`}>→ {action}</span>
            </div>
          )}

          {/* Auto-offload layer breakdown */}
          {autoOffload && autoOffload.ramLayers > 0 && (
            <div className="flex items-center justify-center gap-2 mt-1">
              <span className="text-[8px] font-mono text-nv-green">{autoOffload.nGpuLayers} layers on GPU</span>
              <span className="text-[8px] font-mono text-stealth-muted">/</span>
              <span className={`text-[8px] font-mono ${autoOffload.fitsRam ? "text-yellow-400" : "text-telemetry-red"}`}>
                {autoOffload.ramLayers} in RAM ({(autoOffload.ramSpillMib / 1024).toFixed(1)} GB)
              </span>
            </div>
          )}
        </div>
      )}

      {/* Committed VRAM note */}
      {committedVramMib > 0 && (
        <p className="text-[8px] font-mono text-stealth-muted mt-2 opacity-60">
          {(committedVramMib / 1024).toFixed(0)} GB already committed to running engines
        </p>
      )}
    </div>
  );
}
