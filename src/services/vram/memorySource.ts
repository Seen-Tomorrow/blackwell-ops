import type { EngineConfig, MemorySource, VramManifest } from "../../lib/types";
import {
  type ComputedValues,
  type ScenarioInput,
} from "./scenarios/scenarios_factory";

function cfgStr(cfg: EngineConfig, key: string, fallback: string): string {
  const v = cfg.extra_params?.[key];
  if (v == null || v === "") return fallback;
  return String(v);
}

function formatPerGpuVram(gpuMib: number[]): string {
  const segments = gpuMib.map((m, i) => {
    const gb = (m / 1024).toFixed(1);
    return gpuMib.length > 1 ? `GPU${i} ${gb} GB` : `${gb} GB`;
  });
  return gpuMib.length > 1
    ? `Per-GPU VRAM ${segments.join(" + ")}`
    : `Per-GPU VRAM ${segments[0]}`;
}

function formatSplitModeLabel(split: string): string | undefined {
  const s = split.trim().toLowerCase();
  if (!s || s === "none") return undefined;
  if (s === "layer") return "layer split";
  if (s === "tensor" || s === "row") return "tensor split";
  return `${s} split`;
}

/** Tensor/row split can replicate weight buffers — sum(model) may exceed GGUF file size. */
function weightDuplicationMib(
  components: Array<{ model_mib: number; ctx_mib: number; compute_mib: number }> | undefined,
  weightFileBytes: number | undefined,
  gpuCount: number,
  splitMode: string | undefined,
): number | undefined {
  const splitLabel = splitMode ? formatSplitModeLabel(splitMode) : undefined;
  if (!splitLabel || gpuCount < 2 || !components?.length || !weightFileBytes) return undefined;
  const fileMib = weightFileBytes / (1024 * 1024);
  const sumWeightsMib = components.reduce((s, c) => s + c.model_mib, 0);
  const dup = sumWeightsMib - fileMib;
  // Ignore noise; real tensor replication is usually multi-GB.
  return dup > 512 ? dup : undefined;
}

function formatBreakdown(
  gpuMib?: number[],
  hostMib?: number,
  components?: Array<{ model_mib: number; ctx_mib: number; compute_mib: number }>,
  launchProfile?: string,
  splitMode?: string,
  weightFileBytes?: number,
): { breakdown?: string; breakdownSecondary?: string } {
  const line1Parts: string[] = [];
  if (launchProfile) {
    line1Parts.push(`Launch profile ${launchProfile}`);
  }
  if (gpuMib && gpuMib.length > 0) {
    line1Parts.push(formatPerGpuVram(gpuMib));
  }

  const line2Parts: string[] = [];
  if (components && components.length > 0) {
    const w = components.reduce((s, c) => s + c.model_mib, 0) / 1024;
    const kv = components.reduce((s, c) => s + c.ctx_mib, 0) / 1024;
    const oh = components.reduce((s, c) => s + c.compute_mib, 0) / 1024;
    line2Parts.push(`Weights ${w.toFixed(1)} GB`);
    line2Parts.push(`KV cache ${kv.toFixed(1)} GB`);
    line2Parts.push(`Compute overhead ${oh.toFixed(1)} GB`);
  }
  if (hostMib != null && hostMib > 0) {
    line2Parts.push(`Host RAM ${(hostMib / 1024).toFixed(1)} GB`);
  }
  const splitLabel = splitMode ? formatSplitModeLabel(splitMode) : undefined;
  const dupMib = weightDuplicationMib(
    components,
    weightFileBytes,
    gpuMib?.length ?? 0,
    splitMode,
  );
  if (splitLabel && dupMib != null) {
    line2Parts.push(
      `Weight duplication ${(dupMib / 1024).toFixed(1)} GB (${splitLabel})`,
    );
  }

  const breakdown = line1Parts.length > 0 ? line1Parts.join(" · ") : undefined;
  const breakdownSecondary = line2Parts.length > 0 ? line2Parts.join(" · ") : undefined;
  if (!breakdown && !breakdownSecondary) {
    return {};
  }
  return { breakdown, breakdownSecondary };
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


/** Resolve which memory path is driving the displayed GB number. */
export function resolveMemorySource(
  manifest: VramManifest,
  input: ScenarioInput,
  _computed?: ComputedValues,
): MemorySource {
  const split = cfgStr(input.engineConfig, "split", "none");
  const activeSplit = split.length > 0 && split.toUpperCase() !== "NONE" ? split : undefined;
  const weightFileBytes = input.modelMeta.file_size_bytes;

  if (manifest.learnedFromPreviousRun) {
    const draftCtx = input.learnedMtpContextMib;
    const draftNote =
      draftCtx != null && draftCtx > 64
        ? ` · draft/spec ~${(draftCtx / 1024).toFixed(1)} GB`
        : "";
    return {
      kind: "learned",
      detail: `Launch at this ctx · ${formatMeasuredAt(input.learnedMeasuredAt)}${draftNote}`,
      ...formatBreakdown(
        input.learnedGpuBreakdownMib,
        input.learnedHostMib,
        input.learnedGpuComponentsMib,
        input.learnedLaunchProfile,
        activeSplit,
        weightFileBytes,
      ),
      confidence: 4,
    };
  }

  if (manifest.learnedInterpolated) {
    const marks = (manifest.learnedCurveCtxs ?? [])
      .slice()
      .sort((a, b) => a - b)
      .map((c) => (c >= 1024 ? `${Math.round(c / 1024)}K` : String(c)))
      .join(" · ");
    return {
      kind: "learned_curve",
      detail: marks ? `Between launches ${marks}` : "Between stored launches",
      confidence: 4,
    };
  }

  if (manifest.fitProbeMeasuredAt != null && manifest.validatedVramMib != null) {
    const when = manifest.fitProbeMeasuredAt;
    return {
      kind: "fit_probe",
      detail: `llama-fit-params · measured ${when}`,
      ...formatBreakdown(
        manifest.validatedGpuBreakdownMib,
        manifest.validatedHostMib,
        manifest.validatedComponentsMib ?? undefined,
        undefined,
        activeSplit,
        weightFileBytes,
      ),
      confidence: 3,
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
  computed?: ComputedValues,
): VramManifest {
  return {
    ...manifest,
    memorySource: resolveMemorySource(manifest, input, computed),
  };
}

export const MEMORY_SOURCE_LABELS: Record<MemorySource["kind"], string> = {
  formula: "FORMULA",
  fit_probe: "FIT PROBE",
  learned: "LEARNED",
  learned_curve: "LEARNED ≈",
};

export const MEMORY_SOURCE_ACCENT: Record<
  MemorySource["kind"],
  { text: string; border: string; gbGradient: string }
> = {
  formula: {
    text: "text-stealth-muted",
    border: "border-stealth-muted/30",
    /** Kept for callers; GB value color lives on data-source-kind CSS. */
    gbGradient: "",
  },
  fit_probe: {
    text: "text-amber-400",
    border: "border-amber-400/50",
    gbGradient: "",
  },
  learned: {
    text: "text-cyan-400",
    border: "border-cyan-400/50",
    gbGradient: "",
  },
  learned_curve: {
    text: "text-cyan-400",
    border: "border-cyan-400/40",
    gbGradient: "",
  },
};