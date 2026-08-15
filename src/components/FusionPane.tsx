/**
 * Isolated per-slot fusion subscriber — keeps parent off 25–40 Hz ticks.
 * One pane = one useFusionSlot. Dual stage mounts two of these.
 */

import type { GpuInfo } from "../lib/types";
import type { FusionShareLaunchConfig } from "../lib/fusionShareCapture";
import { useFusionSlot } from "../lib/fusionSlotStore";
import FusionOverlay from "./FusionOverlay";

export interface FusionPaneProps {
  active: boolean;
  slotIdx: number | null | undefined;
  alias?: string;
  enginePort?: number;
  supportsFusion?: boolean;
  engineStatus?: string;
  gpus?: GpuInfo[];
  gpuMask?: string;
  vramTargetMib?: number;
  modelLayerTotal?: number;
  gpuLoadTargetsMib?: Record<number, number>;
  modelName?: string;
  modelQuant?: string;
  providerName?: string;
  providerBuildVersion?: string;
  profileLabel?: string;
  cudaVersion?: string;
  launchConfig?: FusionShareLaunchConfig;
  hwTopo?: string;
  /** Dim chrome for secondary pane (no dual tray ownership). */
  secondary?: boolean;
  className?: string;
}

export default function FusionPane({
  active,
  slotIdx,
  alias,
  enginePort,
  supportsFusion = true,
  engineStatus,
  gpus = [],
  gpuMask = "",
  vramTargetMib,
  modelLayerTotal,
  gpuLoadTargetsMib,
  modelName,
  modelQuant,
  providerName,
  providerBuildVersion,
  profileLabel,
  cudaVersion,
  launchConfig,
  hwTopo,
  secondary = false,
  className = "",
}: FusionPaneProps) {
  const fusion = useFusionSlot(active ? slotIdx : null);
  if (!active) return null;

  return (
    <div
      className={`relative z-10 flex-1 min-h-0 w-full overflow-hidden flex flex-col fusion-overlay-fill fusion-pane${
        secondary ? " fusion-pane--secondary" : ""
      } ${className}`.trim()}
      data-fusion-pane={secondary ? "secondary" : "primary"}
      data-fusion-slot={slotIdx ?? -1}
      style={{ animation: secondary ? undefined : "fadeIn 0.2s ease" }}
    >
      <FusionOverlay
        alias={alias}
        enginePort={enginePort}
        fusion={fusion}
        supportsFusion={supportsFusion}
        engineStatus={engineStatus}
        slotIdx={slotIdx ?? -1}
        gpus={gpus}
        gpuMask={gpuMask}
        vramTargetMib={vramTargetMib}
        modelLayerTotal={modelLayerTotal}
        gpuLoadTargetsMib={gpuLoadTargetsMib}
        modelName={modelName}
        modelQuant={modelQuant}
        providerName={providerName}
        providerBuildVersion={providerBuildVersion}
        profileLabel={profileLabel}
        cudaVersion={cudaVersion}
        launchConfig={secondary ? undefined : launchConfig}
        hwTopo={hwTopo}
        hideBenchTray={false}
      />
    </div>
  );
}
