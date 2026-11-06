import type { MemorySource, VramManifest } from "../../../lib/types";
import type { ForecastInput } from "./types";
import { cfgStr } from "../shared";
import { resolveSpecAdapter } from "../../../lib/spec/adapters";
import { specDraftPathConfigured } from "./draftPath";

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

/** Wording for the learned snapshot's spec-method buffer: baked-in MTP is not a draft. */
function draftLabel(input: ForecastInput): string {
  const adapter = resolveSpecAdapter(
    cfgStr(input.engineConfig, "spec_type", "") || null,
    specDraftPathConfigured(input),
  );
  return adapter?.id === "mtp" ? "mtp" : "draft/spec";
}

function ctxLabel(ctx: number | null | undefined): string {
  if (ctx == null || !(ctx > 0)) return "another CTX";
  return ctx >= 1024 ? `${Math.round(ctx / 1024)}K` : String(ctx);
}

/**
 * SOURCE is built from the resolver state — one state per painted manifest.
 * The label promises what the number is: EXACT only when a launch measured this CTX,
 * ESTIMATE whenever the point was measured somewhere else (it is never scaled).
 */
function resolveMemorySource(
  manifest: VramManifest,
  input: ForecastInput,
): MemorySource | null {
  const state = manifest.memorySourceState;
  if (!state) return null;
  const split = cfgStr(input.engineConfig, "split", "none");
  const activeSplit = split.length > 0 && split.toUpperCase() !== "NONE" ? split : undefined;
  const weightFileBytes = input.modelMeta.file_size_bytes;

  if (state === "launch_exact" || state === "launch_other") {
    const draftCtx = input.learnedSpecContextMib;
    // Display note only — the decision lives in the adapter (ggml_master).
    const draftNote =
      draftCtx != null && draftCtx > 0
        ? ` · ${draftLabel(input)} ~${(draftCtx / 1024).toFixed(1)} GB`
        : "";
    const exact = state === "launch_exact";
    return {
      kind: "learned",
      exact,
      detail: exact
        ? `Launch at this ctx · ${formatMeasuredAt(input.learnedMeasuredAt)}${draftNote}`
        : `Measured at ${ctxLabel(manifest.memorySourceAnchorCtx)} · ${formatMeasuredAt(
            input.learnedMeasuredAt,
          )} · shown unscaled${draftNote}`,
      ...formatBreakdown(
        input.learnedGpuBreakdownMib,
        input.learnedHostMib,
        input.learnedGpuComponentsMib,
        input.learnedLaunchProfile,
        activeSplit,
        weightFileBytes,
      ),
      confidence: exact ? 4 : 1,
    };
  }

  if (state === "launch_curve") {
    const marks = (manifest.learnedCurveCtxs ?? [])
      .slice()
      .sort((a, b) => a - b)
      .map((c) => (c >= 1024 ? `${Math.round(c / 1024)}K` : String(c)))
      .join(" · ");
    return {
      kind: "learned_curve",
      exact: false,
      detail: marks ? `Between launches ${marks}` : "Between stored launches",
      confidence: 3,
    };
  }

  // probe_exact | probe_other
  const exact = state === "probe_exact";
  const probeAnchor = manifest.memorySourceAnchorCtx ?? input.fitProbeAnchorCtx ?? 0;
  const bd = formatBreakdown(
    manifest.validatedGpuBreakdownMib,
    manifest.validatedHostMib,
    manifest.validatedComponentsMib ?? undefined,
    undefined,
    activeSplit,
    weightFileBytes,
  );
  const tipBits = [bd.breakdown, bd.breakdownSecondary, "via llama-fit-params"].filter(
    Boolean,
  );
  return {
    kind: "fit_probe",
    exact,
    detail: exact
      ? `measured ${manifest.fitProbeMeasuredAt ?? "just now"}`
      : `estimate from probe @ ${ctxLabel(probeAnchor)} · ${manifest.fitProbeMeasuredAt ?? "just now"}`,
    breakdown: tipBits.length > 0 ? tipBits.join(" · ") : bd.breakdown,
    breakdownSecondary: undefined,
    confidence: exact ? 2 : 1,
  };
}

export function attachMemorySource(
  manifest: VramManifest,
  input: ForecastInput,
): VramManifest | null {
  const memorySource = resolveMemorySource(manifest, input);
  // No state means the adapter painted nothing it can name — do not invent a label.
  if (!memorySource) return null;
  return { ...manifest, memorySource };
}


export const MEMORY_SOURCE_LABELS: Record<MemorySource["kind"], string> = {
  fit_probe: "FIT PROBE",
  learned: "LEARNED",
  learned_curve: "LEARNED",
};

/** Surface classes for the SOURCE readout (paint in src/styles/badges.css).
 *  gbGradient is legacy chrome — no consumer reads it; kept empty for shape. */
export const MEMORY_SOURCE_ACCENT: Record<
  MemorySource["kind"],
  { text: string; border: string; gbGradient: string }
> = {
  /* Instrument / active measure */
  fit_probe: {
    text: "src-accent src-accent--probe",
    border: "src-accent-border src-accent--probe",
    gbGradient: "",
  },
  /* Premium locked / trusted launches */
  learned: {
    text: "src-accent src-accent--learned",
    border: "src-accent-border src-accent--learned",
    gbGradient: "",
  },
  learned_curve: {
    text: "src-accent src-accent--learned",
    border: "src-accent-border src-accent--curve",
    gbGradient: "",
  },
};
