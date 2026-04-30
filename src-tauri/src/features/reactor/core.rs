use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::telemetry::GpuInfo;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RodHandle {
    pub id: String,
    pub alias: String,
    pub model_path: String,
    pub port: u16,
    pub status: RodStatus,
    pub allocation: GpuAllocation,
    pub vram_mib: f64,
    pub ctx_size: usize,
    pub slot_idx: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum RodStatus {
    Inserting,
    Running,
    Stopping,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum GpuAllocation {
    Dedicated(u32),
    Split([u32; 2]),
}

impl GpuAllocation {
    pub fn gpu_mask(&self) -> String {
        match self {
            GpuAllocation::Dedicated(idx) => format!("{}", idx),
            GpuAllocation::Split(indices) => format!("{},{}", indices[0], indices[1]),
        }
    }

    pub fn is_split(&self) -> bool {
        matches!(self, GpuAllocation::Split(_))
    }
}

pub struct ReactorCore {
    pub rods: HashMap<String, RodHandle>,
    pub max_rods: usize,
    pub headroom_mib: f64,
    pub tier_enabled: bool,
}

impl Default for ReactorCore {
    fn default() -> Self {
        Self::new()
    }
}

impl ReactorCore {
    pub fn new() -> Self {
        Self {
            rods: HashMap::new(),
            max_rods: 8,
            headroom_mib: 10240.0,
            tier_enabled: false,
        }
    }

    /// Find the best GPU allocation for a model requiring `vram_required` MB.
    pub fn find_allocation(&self, vram_required: f64, gpus: &[GpuInfo]) -> Option<GpuAllocation> {
        let usable = |g: &GpuInfo| {
            (g.memory_total as f64) > self.headroom_mib + vram_required
        };

        // Dedicated GPU fit — prefer single GPU with headroom
        for gpu in gpus.iter().filter(|g| usable(g)) {
            return Some(GpuAllocation::Dedicated(gpu.index));
        }

        // Split across two GPUs if no single GPU has enough room
        let candidates: Vec<&GpuInfo> = gpus.iter()
            .filter(|g| (g.memory_total as f64) > vram_required / 2.0 + self.headroom_mib)
            .collect();

        if candidates.len() >= 2 {
            // Best fit — minimize fragmentation
            let mut best: Option<[u32; 2]> = None;
            let mut best_surplus = f64::MAX;
            
            for (i, a) in candidates.iter().enumerate() {
                for b in &candidates[i + 1..] {
                    let combined_free = (a.memory_total as f64) + (b.memory_total as f64);
                    if combined_free >= vram_required + self.headroom_mib * 2.0 {
                        let surplus = combined_free - (vram_required + self.headroom_mib * 2.0);
                        if surplus < best_surplus {
                            best_surplus = surplus;
                            best = Some([a.index, b.index]);
                        }
                    }
                }
            }
            
            return best.map(|indices| GpuAllocation::Split(indices));
        }

        None
    }

    pub fn total_vram_used(&self) -> f64 {
        self.rods.values()
            .filter(|r| r.status == RodStatus::Running)
            .map(|r| r.vram_mib)
            .sum()
    }
}