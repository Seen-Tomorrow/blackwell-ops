import type { ModelEntry } from "./types";

/** Keep in sync with `TOM_MTP_SKIP_NOTE` in `src-tauri/src/fit_adapters/ggml_tom.rs`. */
export const TOM_MTP_SKIP_MESSAGE =
  "MTP model — Tom does not load draft/MTP models yet";

export function isTomProvider(providerId: string): boolean {
  const id = providerId.trim().toLowerCase();
  return id === "ggml-tom" || id === "ggml_tom" || id.includes("ggml-tom");
}

export function isMtpModel(model: Pick<ModelEntry, "path" | "metadata" | "hf_meta" | "hf_model_id">): boolean {
  if ((model.metadata?.nextn_predict_layers ?? 0) > 0) return true;

  const hfId = (model.hf_meta?.hf_model_id ?? model.hf_model_id ?? "").toLowerCase();
  const repo = (model.hf_meta?.repo_name ?? "").toLowerCase();
  if (hfId.includes("mtp") || repo.includes("mtp")) return true;

  const path = model.path.replace(/\\/g, "/").toLowerCase();
  return path.includes("mtp-gguf") || path.includes("-mtp-");
}

export function tomMtpBlocked(
  providerId: string,
  model: Pick<ModelEntry, "path" | "metadata" | "hf_meta" | "hf_model_id">,
): boolean {
  return isTomProvider(providerId) && isMtpModel(model);
}

export function toastTomMtpSkip(message = TOM_MTP_SKIP_MESSAGE): void {
  window.__blackopsToasts?.addToast(message, "error");
}