export interface GpuAllocation {
  type: 'Dedicated' | 'Split';
  gpus?: number[];
}

export type RodStatus = 
  | { type: 'Inserting' }
  | { type: 'Running' }
  | { type: 'Stopping' }
  | { type: 'Error'; message: string };

export interface RodHandle {
  id: string;
  alias: string;
  model_path: string;
  port: number;
  status: RodStatus;
  allocation: GpuAllocation;
  vram_mib: number;
  ctx_size: number;
  slot_idx?: number | null;
}

export interface ReactorStatus {
  rods: RodHandle[];
  total_vram_used_mib: number;
  tier_enabled: boolean;
}