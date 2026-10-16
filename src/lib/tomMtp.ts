import type { ModelEntry } from "./types";

/**
 * Shown by the client-side pre-flight guards (`useScenarioEvaluator`, `EngineConfigPanel`)
 * when a Tom seat is handed an MTP model. Those guards never reach the backend, so this
 * text cannot come from Rust.
 *
 * The backend has its own copy for the FIT skip note (`TOM_MTP_SKIP_NOTE` in
 * `src-tauri/src/fit_adapters/ggml_tom.rs`) and returns `kind: "fit_probe_skipped"`.
 * The two are no longer byte-synced on purpose: nothing *decides* on the text any more —
 * the rejected-promise branch switches on `kind` (see `lib/blackwellError.ts`), so these
 * strings only ever reach a human. Reword either side freely.
 */
export const TOM_MTP_SKIP_MESSAGE =
  "MTP model — Tom does not load draft/MTP models yet";

export function isTomProvider(providerId: string): boolean {
  const id = providerId.trim().toLowerCase();
  return id === "ggml-tom" || id === "ggml_tom" || id.includes("ggml-tom");
}

export function isMtpModel(model: Pick<ModelEntry, "path" | "metadata" | "hfMeta" | "hfModelId">): boolean {
  if ((model.metadata?.nextn_predict_layers ?? 0) > 0) return true;

  const hfId = (model.hfMeta?.hfModelId ?? model.hfModelId ?? "").toLowerCase();
  const repo = (model.hfMeta?.repoName ?? "").toLowerCase();
  if (hfId.includes("mtp") || repo.includes("mtp")) return true;

  const path = model.path.replace(/\\/g, "/").toLowerCase();
  const file = path.split("/").pop() ?? path;
  if (file.endsWith("-mtp.gguf") || file.endsWith("_mtp.gguf") || /[-_]mtp-\d{5}-of-\d{5}\.gguf$/i.test(file)) {
    return true;
  }
  return path.includes("mtp-gguf") || path.includes("-mtp-");
}

export function tomMtpBlocked(
  providerId: string,
  model: Pick<ModelEntry, "path" | "metadata" | "hfMeta" | "hfModelId">,
): boolean {
  return isTomProvider(providerId) && isMtpModel(model);
}

export function toastTomMtpSkip(message: string): void {
  window.__blackopsToasts?.addToast(message, "error");
}
