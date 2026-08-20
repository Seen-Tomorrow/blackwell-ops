import type { EngineConfig, MemorySource, VramManifest } from "../../../lib/types";
import type { ForecastInput } from "./types";
import { cfgStr, parseCtx, resolveSplitTax } from "../shared";

function formatPerGpuVram(gpuMib: number[]): string {
  return gpuMib
    .map((m, i) => {
      const gb = (m / 1024).toFixed(1);
      return gpuMib.length > 1 ? `GPU${i} ${gb} GB` : `${gb} GB`;
    })
    .join(" + ");
}

function formatSplitModeLabel(split: string): string | undefined {
  const s = split.trim().toLowerCase();
  if (!s || s === "none") return undefined;
  if (s === "layer") return "layer split";
  if (s === "row") return "row split";
  if (s === "tensor") return "tensor split";
  return `${split} split`;
}

function weightDuplicationMib(
  components: Array<{ model_mib: number; ctx_mib: number; compute_mib: number }> | undefined,
  weightFileBytes: number | undefined,
  gpuCount: number,
  splitMode: string | undefined,
): number | undefined {
  if (!components?.length || !weightFileBytes || weightFileBytes <= 0) return undefined;
  const modelSum = components.reduce((s, c) => s + (c.model_mib || 0), 0);
  const fileMib = weightFileBytes / (1024 * 1024);
  if (modelSum <= fileMib * 1.05) return undefined;
  const split = (splitMode || "").toLowerCase();
  if (split === "tensor" || split === "row" || gpuCount > 1) {
    return Math.round(modelSum - fileMib);
  }
  return undefined;
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
  if (launchProfile) line1Parts.push(launchProfile);
  if (gpuMib?.length) line1Parts.push(formatPerGpuVram(gpuMib));
  const splitLabel = formatSplitModeLabel(splitMode || "");
  if (splitLabel) line1Parts.push(splitLabel);

  const line2Parts: string[] = [];
  if (components?.length) {
    const model = components.reduce((s, c) => s + (c.model_mib || 0), 0);
    const ctx = components.reduce((s, c) => s + (c.ctx_mib || 0), 0);
    const compute = components.reduce((s, c) => s + (c.compute_mib || 0), 0);
    line2Parts.push(
      `W ${(model / 1024).toFixed(1)} · KV ${(ctx / 1024).toFixed(1)} · OH ${(compute / 1024).toFixed(1)} GB`,
    );
    const dup = weightDuplicationMib(components, weightFileBytes, gpuMib?.length ?? 1, splitMode);
    if (dup != null && dup > 256) {
      line2Parts.push(`dup ~${(dup / 1024).toFixed(1)} GB`);
    }
  }
  if (hostMib != null && hostMib > 64) {
    line2Parts.push(`host ${(hostMib / 1024).toFixed(1)} GB`);
  }

  const breakdown = line1Parts.length > 0 ? line1Parts.join(" · ") : undefined;
  const breakdownSecondary = line2Parts.length > 0 ? line2Parts.join(" · ") : undefined;
  if (!breakdown && !breakdownSecondary) return {};
  return { breakdown, breakdownSecondary };
}

function formatMeasuredAt(iso?: string): string {
  if (!iso) return "prior launch";
  const d = Date.parse(iso);
  if (!Number.isFinite(d)) return iso;
  return new Date(d).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Resolve SOURCE for measured manifests only. Returns null if nothing measured. */
export function resolveMemorySource(
  manifest: VramManifest,
  input: ForecastInput,
): MemorySource | null {
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
    const liveCtx = parseCtx(String(input.engineConfig.extra_params?.ctx ?? "32768"));
    const tax = resolveSplitTax(split, liveCtx, input.fitPoints);
    let taxNote = "";
    if (tax.taxGb > 0) {
      const modeLab = formatSplitModeLabel(split) ?? split;
      if (tax.source === "library") {
        taxNote = ` · +${tax.taxGb.toFixed(1)} GB ${modeLab} tax (library FIT ×${tax.anchors})`;
      } else {
        taxNote = ` · +${tax.taxGb.toFixed(1)} GB ${modeLab} tax (fallback — no library Δ)`;
      }
    }
    return {
      kind: "fit_probe",
      detail: `llama-fit-params · measured ${manifest.fitProbeMeasuredAt}${taxNote}`,
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

  return null;
}

export function attachMemorySource(
  manifest: VramManifest,
  input: ForecastInput,
): VramManifest | null {
  const memorySource = resolveMemorySource(manifest, input);
  if (!memorySource) return null;
  return { ...manifest, memorySource };
}

export const MEMORY_SOURCE_LABELS: Record<MemorySource["kind"], string> = {
  fit_probe: "FIT PROBE",
  learned: "LEARNED",
  learned_curve: "LEARNED ≈",
};

export const MEMORY_SOURCE_ACCENT: Record<
  MemorySource["kind"],
  { text: string; border: string; gbGradient: string }
> = {
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
