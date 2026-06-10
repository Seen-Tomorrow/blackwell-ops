import type { EngineConfig, MemorySource, VramManifest } from "../../lib/types";
import {
  extrapolateVramFromPoints,
  parseCtx,
  type ScenarioInput,
} from "./scenarios/scenarios_factory";

function cfgStr(cfg: EngineConfig, key: string, fallback: string): string {
  const v = cfg.extra_params?.[key];
  if (v == null || v === "") return fallback;
  return String(v);
}

function cfgNum(cfg: EngineConfig, key: string, fallback: number): number {
  const v = cfg.extra_params?.[key];
  if (v == null || v === "") return fallback;
  const n = typeof v === "number" ? v : parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function formatBreakdown(gpuMib?: number[], hostMib?: number): string | undefined {
  const parts: string[] = [];
  if (gpuMib && gpuMib.length > 0) {
    const gpuStr = gpuMib.map((m) => (m / 1024).toFixed(1)).join("+");
    parts.push(`GPU ${gpuStr} GB`);
  }
  if (hostMib != null && hostMib > 0) {
    parts.push(`Host ${(hostMib / 1024).toFixed(1)} GB`);
  }
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

function formatMeasuredAt(iso?: string): string {
  if (!iso) return "prior launch";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function wasFitCacheUsed(input: ScenarioInput): boolean {
  if (!input.fitPoints?.length) return false;
  const { engineConfig, modelMeta } = input;
  const weightsGb = modelMeta.file_size_bytes / (1024 ** 3);
  const userCtx = parseCtx(cfgStr(engineConfig, "ctx", "32k"));
  const splitRaw = cfgStr(engineConfig, "split", "none");
  const splitActive = splitRaw.length > 0 && splitRaw.toUpperCase() !== "NONE";
  const splitMode = splitActive ? splitRaw.toLowerCase() : "";
  return extrapolateVramFromPoints(
    input.fitPoints,
    userCtx,
    cfgStr(engineConfig, "kv_quant", "f16"),
    cfgNum(engineConfig, "batch", 2048),
    cfgNum(engineConfig, "parallel", 1),
    splitMode,
    weightsGb,
  ) !== null;
}

/** Resolve which of the four memory paths is driving the displayed GB number. */
export function resolveMemorySource(
  manifest: VramManifest,
  input: ScenarioInput,
): MemorySource {
  const ctx = parseCtx(cfgStr(input.engineConfig, "ctx", "32k"));
  const split = cfgStr(input.engineConfig, "split", "none");
  const splitSuffix =
    split.length > 0 && split.toUpperCase() !== "NONE" ? ` · ${split} split` : "";

  if (manifest.validatedVramMib != null && !manifest.learnedFromPreviousRun) {
    const when = manifest.fitProbeMeasuredAt ?? "just now";
    return {
      kind: "fit_probe",
      detail: `llama-fit-params · measured ${when}`,
      breakdown: formatBreakdown(
        manifest.validatedGpuBreakdownMib,
        manifest.validatedHostMib,
      ),
      confidence: 3,
    };
  }

  if (manifest.learnedFromPreviousRun) {
    return {
      kind: "learned",
      detail: `Prior launch · ${formatMeasuredAt(input.learnedMeasuredAt)} · ctx ${ctx}${splitSuffix}`,
      breakdown: formatBreakdown(
        input.learnedGpuBreakdownMib,
        input.learnedHostMib,
      ),
      confidence: 4,
    };
  }

  if (wasFitCacheUsed(input)) {
    const count = input.fitPoints?.length ?? 0;
    return {
      kind: "fit_cache",
      detail: `Library scan · ${count} points · interpolated to ctx ${ctx}`,
      confidence: 2,
    };
  }

  return {
    kind: "formula",
    detail: "GGUF estimate · no measurement yet",
    breakdown: "Launch model or run FIT probe to improve accuracy",
    confidence: 1,
  };
}

export function attachMemorySource(
  manifest: VramManifest,
  input: ScenarioInput,
): VramManifest {
  return {
    ...manifest,
    memorySource: resolveMemorySource(manifest, input),
  };
}

export const MEMORY_SOURCE_LABELS: Record<MemorySource["kind"], string> = {
  formula: "FORMULA",
  fit_cache: "FIT CACHE",
  fit_probe: "FIT PROBE",
  learned: "LEARNED",
};

export const MEMORY_SOURCE_ACCENT: Record<
  MemorySource["kind"],
  { text: string; border: string; gbGradient: string }
> = {
  formula: {
    text: "text-stealth-muted",
    border: "border-stealth-muted/30",
    gbGradient: "",
  },
  fit_cache: {
    text: "text-violet-400",
    border: "border-violet-400/40",
    gbGradient:
      "bg-gradient-to-r from-violet-300 via-purple-400 to-violet-500 bg-clip-text text-transparent drop-shadow-[0_0_8px_rgba(167,139,250,0.35)]",
  },
  fit_probe: {
    text: "text-amber-400",
    border: "border-amber-400/50",
    gbGradient:
      "bg-gradient-to-r from-amber-300 via-yellow-400 to-amber-500 bg-clip-text text-transparent drop-shadow-[0_0_8px_rgba(251,191,36,0.4)]",
  },
  learned: {
    text: "text-cyan-400",
    border: "border-cyan-400/50",
    gbGradient:
      "bg-gradient-to-r from-cyan-300 via-sky-400 to-cyan-500 bg-clip-text text-transparent drop-shadow-[0_0_8px_rgba(34,211,238,0.35)]",
  },
};