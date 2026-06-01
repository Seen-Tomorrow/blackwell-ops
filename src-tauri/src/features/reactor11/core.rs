use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use crate::telemetry::GpuInfo;


#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct R11RodHandle {
    pub id: String,
    pub alias: String,
    pub model_path: String,
    pub port: u16,
    pub status: R11RodStatus,
    pub allocation: R11GpuAllocation,
    pub vram_mib: f64,
    pub ctx_size: usize,
    pub slot_idx: Option<usize>,
    pub quant: String,
    pub gpu_mask: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum R11RodStatus {
    Inserting,
    Running,
    Stopping,
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub enum R11GpuAllocation {
    Dedicated(u32),
    Split([u32; 2]),
}

impl R11GpuAllocation {
    pub fn gpu_mask(&self) -> String {
        match self {
            R11GpuAllocation::Dedicated(idx) => format!("{}", idx),
            R11GpuAllocation::Split(indices) => format!("{},{}", indices[0], indices[1]),
        }
    }

    pub fn is_split(&self) -> bool {
        matches!(self, R11GpuAllocation::Split(_))
    }

    pub fn gpu_count(&self) -> u32 {
        match self {
            R11GpuAllocation::Dedicated(_) => 1,
            R11GpuAllocation::Split(_) => 2,
        }
    }

    pub fn primary_gpu(&self) -> u32 {
        match self {
            R11GpuAllocation::Dedicated(idx) => *idx,
            R11GpuAllocation::Split([a, _]) => *a,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct R11PredictiveFit {
    pub model_path: String,
    pub estimated_vram_mib: f64,
    pub allocation: Option<R11GpuAllocation>,
    pub fits: bool,
    pub gpu_details: Vec<R11GpuDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct R11GpuDetail {
    pub index: u32,
    pub name: String,
    pub total_mib: f64,
    pub free_mib: f64,
    pub used_by_rods_mib: f64,
    pub projected_free_mib: f64,
    pub can_fit: bool,
}

pub struct R11Core {
    pub rods: HashMap<String, R11RodHandle>,
    pub max_rods: usize,
    pub headroom_mib: f64,
    pub tier_enabled: bool,
}

impl Default for R11Core {
    fn default() -> Self {
        Self::new()
    }
}

impl R11Core {
    pub fn new() -> Self {
        Self {
            rods: HashMap::new(),
            max_rods: 8,
            headroom_mib: 10240.0,
            tier_enabled: false,
        }
    }

    pub fn find_allocation(&self, vram_required: f64, gpus: &[GpuInfo]) -> Option<R11GpuAllocation> {
        let rod_vram_per_gpu = |gpu_idx: u32| -> f64 {
            self.rods.values()
                .filter(|r| r.status == R11RodStatus::Running)
                .filter(|r| match &r.allocation {
                    R11GpuAllocation::Dedicated(idx) => *idx == gpu_idx,
                    R11GpuAllocation::Split([a, b]) => *a == gpu_idx || *b == gpu_idx,
                })
                .map(|r| r.vram_mib / r.allocation.gpu_count() as f64)
                .sum()
        };

        let usable = |g: &GpuInfo| {
            let used_by_rods = rod_vram_per_gpu(g.index);
            (g.memory_total as f64 - used_by_rods) > self.headroom_mib + vram_required
        };

        for gpu in gpus.iter().filter(|g| usable(g)) {
            return Some(R11GpuAllocation::Dedicated(gpu.index));
        }

        let candidates: Vec<&GpuInfo> = gpus.iter()
            .filter(|g| {
                let used_by_rods = rod_vram_per_gpu(g.index);
                (g.memory_total as f64 - used_by_rods) > vram_required / 2.0 + self.headroom_mib
            })
            .collect();

        if candidates.len() >= 2 {
            let mut best: Option<[u32; 2]> = None;
            let mut best_surplus = f64::MAX;

            for (i, a) in candidates.iter().enumerate() {
                for b in &candidates[i + 1..] {
                    let a_used = rod_vram_per_gpu(a.index);
                    let b_used = rod_vram_per_gpu(b.index);
                    let combined_free = (a.memory_total as f64 - a_used) + (b.memory_total as f64 - b_used);
                    if combined_free >= vram_required + self.headroom_mib * 2.0 {
                        let surplus = combined_free - (vram_required + self.headroom_mib * 2.0);
                        if surplus < best_surplus {
                            best_surplus = surplus;
                            best = Some([a.index, b.index]);
                        }
                    }
                }
            }

            return best.map(|indices| R11GpuAllocation::Split(indices));
        }

        None
    }

    pub fn total_vram_used(&self) -> f64 {
        self.rods.values()
            .filter(|r| r.status == R11RodStatus::Running)
            .map(|r| r.vram_mib)
            .sum()
    }

    pub fn rod_count(&self) -> usize {
        self.rods.len()
    }

    pub fn running_rod_count(&self) -> usize {
        self.rods.values().filter(|r| r.status == R11RodStatus::Running).count()
    }

    pub fn predict_fit(&self, model_path: &str, gpus: &[GpuInfo]) -> R11PredictiveFit {
        // Simple file-size-based estimate for reactor UI (not precision-critical)
        let model_bytes = std::fs::metadata(model_path).map(|m| m.len()).unwrap_or(0);

        // Detect mmproj vision projector file (largest by filesize = highest precision)
        let mmproj_bytes: u64 = if let Some(dir) = std::path::Path::new(model_path).parent() {
            crate::model_catalog::find_largest_mmproj(dir).map(|(_, sz)| sz).unwrap_or(0)
        } else {
            0
        };

        // Rough estimate: model size + 30% overhead (weights + KV cache + CUDA context)
        let estimated_vram_mib = (model_bytes as f64 / (1024.0 * 1024.0)) * 1.3
            + (mmproj_bytes as f64 / (1024.0 * 1024.0))
            + 2560.0; // ~2.5 GB CUDA overhead per GPU

        let allocation = self.find_allocation(estimated_vram_mib, gpus);
        let fits = allocation.is_some();

        let gpu_details: Vec<R11GpuDetail> = gpus.iter().map(|g| {
            let used_by_rods = self.rods.values()
                .filter(|r| r.status == R11RodStatus::Running)
                .filter(|r| match &r.allocation {
                    R11GpuAllocation::Dedicated(idx) => *idx == g.index,
                    R11GpuAllocation::Split([a, b]) => *a == g.index || *b == g.index,
                })
                .map(|r| r.vram_mib / r.allocation.gpu_count() as f64)
                .sum::<f64>();

            let free_mib = (g.memory_total - g.memory_used) as f64;
            let per_gpu_req = if fits {
                match &allocation {
                    Some(R11GpuAllocation::Dedicated(idx)) if *idx == g.index => estimated_vram_mib,
                    Some(R11GpuAllocation::Split([a, b])) if *a == g.index || *b == g.index => estimated_vram_mib / 2.0,
                    _ => 0.0,
                }
            } else {
                0.0
            };
            let projected_free = free_mib - per_gpu_req;

            R11GpuDetail {
                index: g.index,
                name: g.name.clone(),
                total_mib: g.memory_total as f64,
                free_mib,
                used_by_rods_mib: used_by_rods,
                projected_free_mib: projected_free,
                can_fit: per_gpu_req == 0.0 || projected_free > 0.0,
            }
        }).collect();

        R11PredictiveFit {
            model_path: model_path.to_string(),
            estimated_vram_mib,
            allocation,
            fits,
            gpu_details,
        }
    }

    pub fn inject_tier1_flags(&self, extra_params: &mut HashMap<String, serde_json::Value>) {
        if self.tier_enabled {
            extra_params.insert("--perf".to_string(), serde_json::json!(true));
            extra_params.insert("--poll".to_string(), serde_json::json!(100));
            extra_params.insert("--backend-sampling".to_string(), serde_json::json!(true));
        }
    }
}
