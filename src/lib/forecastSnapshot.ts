import type { ModelEntry, VramManifest } from "./types";
import { bestVramEstimateGb, resolveSplitDriver } from "./autoVramLaunch";

export type ForecastSourceLabel = "LEARNED" | "FIT" | "FORMULA";

export function forecastSnapshotFromManifest(
  manifest: VramManifest | null,
  model: ModelEntry,
  extra: Record<string, unknown>,
): Record<string, unknown> {
  const meta = model.metadata;
  const driver = resolveSplitDriver(manifest);
  const source: ForecastSourceLabel = driver?.label === "LEARNED" || driver?.label === "FIT"
    ? driver.label
    : "FORMULA";
  return {
    launch_id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    source,
    estimate_gb: Math.round(bestVramEstimateGb(manifest) * 1000) / 1000,
    formula_gb: manifest?.formulaVramTotalGb ?? null,
    vram_total_gb: manifest?.vramTotalGb ?? null,
    vram_kv_gb: manifest?.vramKvGb ?? null,
    vram_weights_gb: manifest?.vramWeightsGb ?? null,
    vram_overhead_gb: manifest?.vramOverheadGb ?? null,
    validated_mib: manifest?.validatedVramMib ?? null,
    auto_split: manifest?.autoLayerSplit === true || driver?.willSplit === true,
    fits: manifest?.fits ?? null,
    memory_source: manifest?.memorySource?.kind ?? null,
    ctx: extra.ctx ?? null,
    kv_quant: extra.kv_quant ?? extra["kv_quant"] ?? null,
    batch: extra.batch ?? null,
    ubatch: extra.ubatch ?? null,
    device: extra.device ?? null,
    split: extra.split ?? null,
    offload_mode: extra.offload_mode ?? extra["offload_mode"] ?? null,
    spec_type: extra.spec_type ?? extra["spec_type"] ?? null,
    flash_attn: extra.flash_attn ?? extra["flash_attn"] ?? null,
    n_layer: meta?.n_layer ?? null,
    n_embd: meta?.n_embd ?? null,
    n_head: meta?.n_head ?? null,
    n_head_kv: meta?.n_head_kv ?? null,
    n_expert: meta?.n_expert ?? null,
    file_size_bytes: meta?.file_size_bytes ?? null,
    model_name: model.name ?? null,
  };
}
