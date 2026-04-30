export type R11RodStatusType = "inserting" | "running" | "stopping" | "error";

export interface R11RodHandle {
  id: string;
  alias: string;
  model_path: string;
  port: number;
  status: R11RodStatusType;
  allocation: R11GpuAllocation;
  vram_mib: number;
  ctx_size: number;
  slot_idx: number | null;
  quant: string;
  gpu_mask: string;
}

export type R11AllocationType = "Dedicated" | "Split";

export interface R11GpuAllocation {
  type: R11AllocationType;
  gpus?: number[];
}

export interface R11Status {
  rods: R11RodHandle[];
  total_vram_used_mib: number;
  tier_enabled: boolean;
}

export interface R11GpuDetail {
  index: number;
  name: string;
  total_mib: number;
  free_mib: number;
  used_by_rods_mib: number;
  projected_free_mib: number;
  can_fit: boolean;
}

export interface R11PredictiveFit {
  model_path: string;
  estimated_vram_mib: number;
  allocation: R11GpuAllocation | null;
  fits: boolean;
  gpu_details: R11GpuDetail[];
}

export type ThermalState = "cold" | "normal" | "elevated" | "critical";

export interface ThermalReading {
  state: ThermalState;
  temperature: number;
  coolantColor: string;
  turbulenceScale: number;
  hasRipple: boolean;
  hasHaze: boolean;
  hasBubbles: boolean;
  deepColor: string;
  midColor: string;
  surfaceColor: string;
  plasmaColor: string;
}
