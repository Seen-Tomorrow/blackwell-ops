import type { VramManifest } from "../../../lib/types";
import { ggmlMasterAdapter } from "./adapters/ggml_master";
import type { ForecastAdapter, ForecastInput } from "./types";

const ADAPTERS: ForecastAdapter[] = [ggmlMasterAdapter];

function pickAdapter(providerId: string | undefined): ForecastAdapter {
  const id = (providerId || "").toLowerCase();
  for (const a of ADAPTERS) {
    if (a.ids.some((x) => x === id || (x !== "" && id.includes(x)))) return a;
  }
  // Default: ggml-master measured path for all providers until more adapters exist.
  return ggmlMasterAdapter;
}

/**
 * Measured-only forecast.
 * Returns null when no LEARNED / curve / FIT PROBE data is available yet.
 */
export function evaluate(input: ForecastInput): VramManifest | null {
  const providerId = input.engineConfig.backend_type || "";
  return pickAdapter(providerId).evaluate(input);
}
