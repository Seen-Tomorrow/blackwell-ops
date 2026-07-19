/**
 * Full Auto fixed cockpit — product language over parallel / spec / kv_quant / batch.
 * Assisted mode keeps Essentials/Full + classic chips. Factory param keys unchanged.
 */

import type { SpecCapability } from "./specDraft";

export type CodingModeId = "solo" | "group" | "squad" | "team" | "army";
/** Speed boost row — speculative draft / batch aggressiveness. */
export type SpeedBoostId = "off" | "mtp" | "dflash" | "smart";
/** Brains row — KV quant quality (VRAM trade). */
export type BrainsId = "light" | "solid" | "sharp";
/** Optional thinking budget for models that expose reasoning flags. */
export type ThinkId = "off" | "on" | "budget";

export interface CodingModeOption {
  id: CodingModeId;
  label: string;
  parallel: number;
  blurb: string;
}

export interface SpeedBoostOption {
  id: SpeedBoostId;
  label: string;
  blurb: string;
  needs?: SpecCapability;
}

export interface BrainsOption {
  id: BrainsId;
  label: string;
  /** Preferred kv_quant value (factory values: q4_0 | q8_0 | f16 | bf16). */
  kvQuant: string;
  blurb: string;
}

export const CODING_MODE_OPTIONS: CodingModeOption[] = [
  { id: "solo", label: "Solo", parallel: 1, blurb: "One stream — snappiest single agent" },
  { id: "group", label: "Group", parallel: 4, blurb: "4 agents in parallel" },
  { id: "squad", label: "Squad", parallel: 8, blurb: "8 agents — coding swarm sweet spot" },
  { id: "team", label: "Team", parallel: 16, blurb: "16 agents — heavy harnesses" },
  { id: "army", label: "Army", parallel: 32, blurb: "32 agents — max concurrency" },
];

export const SPEED_BOOST_OPTIONS: SpeedBoostOption[] = [
  {
    id: "off",
    label: "Off",
    blurb: "No draft — pure multi-agent throughput",
  },
  {
    id: "mtp",
    label: "MTP",
    blurb: "Built-in speculative tokens — one agent only",
    needs: "mtp",
  },
  {
    id: "dflash",
    label: "DFlash",
    blurb: "External draft — needs a draft model in your library",
    needs: "dflash",
  },
  {
    id: "smart",
    label: "Smart",
    blurb: "Push batch sizes for faster prefill when VRAM allows",
  },
];

export const BRAINS_OPTIONS: BrainsOption[] = [
  { id: "light", label: "Light", kvQuant: "q4_0", blurb: "Smaller KV — more room for agents / context" },
  { id: "solid", label: "Solid", kvQuant: "q8_0", blurb: "Balanced quality vs memory" },
  { id: "sharp", label: "Sharp", kvQuant: "f16", blurb: "Highest KV quality — hungriest VRAM" },
];

export const THINK_OPTIONS: { id: ThinkId; label: string; blurb: string }[] = [
  { id: "off", label: "Off", blurb: "No chain-of-thought budget" },
  { id: "on", label: "Think", blurb: "Full reasoning when the model supports it" },
  { id: "budget", label: "4k", blurb: "Capped thinking budget (~4000)" },
];

/** Groups tucked away under Full Auto (Full Assisted still shows everything). */
export const FULL_AUTO_COLLAPSE_GROUPS = ["PERFORMANCE", "FEATURE-FLAGS", "ADVANCED"] as const;

export function codingModeFromParallel(parallel: number): CodingModeId {
  if (parallel >= 32) return "army";
  if (parallel >= 16) return "team";
  if (parallel >= 8) return "squad";
  if (parallel >= 4) return "group";
  return "solo";
}

export function parallelForCodingMode(mode: CodingModeId): number {
  return CODING_MODE_OPTIONS.find((o) => o.id === mode)?.parallel ?? 1;
}

export function brainsFromKvQuant(kv: string | undefined): BrainsId {
  const s = (kv ?? "").toLowerCase();
  if (s.includes("q4")) return "light";
  if (s.includes("q8")) return "solid";
  return "sharp";
}

export function pickKvQuantForBrains(
  brains: BrainsId,
  available: (string | number)[],
): string {
  const want = BRAINS_OPTIONS.find((b) => b.id === brains)?.kvQuant ?? "q8_0";
  const strs = available.map(String);
  if (strs.some((v) => v.toLowerCase() === want.toLowerCase())) return want;
  // Fallbacks along the quality ladder
  const ladder =
    brains === "light"
      ? ["q4_0", "q8_0", "f16", "bf16"]
      : brains === "solid"
        ? ["q8_0", "q4_0", "f16", "bf16"]
        : ["f16", "bf16", "q8_0", "q4_0"];
  for (const c of ladder) {
    const hit = strs.find((v) => v.toLowerCase() === c);
    if (hit) return hit;
  }
  return strs[0] ?? want;
}

/** Highest numeric chip ≤ maxHint (or top of list). */
export function pickHighNumeric(
  values: (string | number)[],
  maxHint?: number,
): number | null {
  const nums = values
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n) && n > 0)
    .sort((a, b) => a - b);
  if (nums.length === 0) return null;
  if (maxHint != null && maxHint > 0) {
    const fit = [...nums].reverse().find((n) => n <= maxHint);
    if (fit != null) return fit;
  }
  return nums[nums.length - 1]!;
}

export interface FullAutoPlan {
  parallel: number;
  codingMode: CodingModeId;
  speed: SpeedBoostId;
  brains: BrainsId;
  think: ThinkId;
  enableSpec: boolean;
  specType: string | null;
  forcedSoloForMtp: boolean;
  /** Prefer aggressive batch/ubatch (Smart speed). */
  pushBatch: boolean;
  kvQuant: string;
  reasoning: string | number | null;
  reasoningPreserve: "on" | "off" | null;
  vision: "auto" | null;
  outcome: string;
  /** Joe-facing soft note (not CLI jargon). */
  softNote: string | null;
}

export function resolveFullAutoPlan(opts: {
  codingMode: CodingModeId;
  speed: SpeedBoostId;
  brains: BrainsId;
  think: ThinkId;
  capabilities: SpecCapability[];
  dflashLibraryReady: boolean;
  kvQuantValues: (string | number)[];
}): FullAutoPlan {
  const { codingMode, brains, think, capabilities, dflashLibraryReady, kvQuantValues } = opts;
  let speed = opts.speed;
  const hasMtp = capabilities.includes("mtp");
  const hasDflash = capabilities.includes("dflash") && dflashLibraryReady;

  if (speed === "mtp" && !hasMtp) speed = hasDflash ? "dflash" : "smart";
  if (speed === "dflash" && !hasDflash) speed = hasMtp ? "mtp" : "off";

  let parallel = parallelForCodingMode(codingMode);
  let enableSpec = false;
  let specType: string | null = null;
  let forcedSoloForMtp = false;
  let pushBatch = false;
  let softNote: string | null = null;

  if (speed === "off") {
    enableSpec = false;
  } else if (speed === "mtp") {
    enableSpec = true;
    specType = "draft-mtp";
    if (parallel > 1) {
      parallel = 1;
      forcedSoloForMtp = true;
      softNote = "MTP works best with one agent — Agents set to Solo";
    }
  } else if (speed === "dflash") {
    enableSpec = true;
    specType = "draft-dflash";
  } else {
    // smart — no draft by default under multi-agent; push prefill batch
    pushBatch = true;
    enableSpec = false;
    specType = null;
    if (parallel <= 1 && hasMtp) {
      enableSpec = true;
      specType = "draft-mtp";
    }
  }

  const kvQuant = pickKvQuantForBrains(brains, kvQuantValues);

  let reasoning: string | number | null = null;
  let reasoningPreserve: "on" | "off" | null = null;
  if (think === "off") {
    reasoning = "off";
    reasoningPreserve = "off";
  } else if (think === "on") {
    reasoning = "on";
    reasoningPreserve = "on";
  } else {
    reasoning = 4000;
    reasoningPreserve = "on";
  }

  const modeLabel = CODING_MODE_OPTIONS.find((o) => o.id === codingMode)?.label ?? "Solo";
  const speedLabel = SPEED_BOOST_OPTIONS.find((o) => o.id === speed)?.label ?? "Off";
  const brainsLabel = BRAINS_OPTIONS.find((o) => o.id === brains)?.label ?? "Solid";

  let outcome: string;
  if (enableSpec && specType === "draft-mtp") {
    outcome = `Solo-class stream · MTP on · ${brainsLabel} memory quality`;
  } else if (enableSpec && specType === "draft-dflash") {
    outcome = `×${parallel} agents · DFlash draft · ${brainsLabel} memory`;
  } else if (pushBatch) {
    outcome = `×${parallel} agents · Smart prefill · ${brainsLabel} memory`;
  } else {
    outcome = `×${parallel} agents · pure multi-agent · ${brainsLabel} memory`;
  }

  return {
    parallel,
    codingMode: forcedSoloForMtp ? "solo" : codingMode,
    speed,
    brains,
    think,
    enableSpec,
    specType,
    forcedSoloForMtp,
    pushBatch,
    kvQuant,
    reasoning,
    reasoningPreserve,
    vision: "auto",
    outcome,
    softNote,
  };
}

export function buildHarnessSnippets(opts: {
  port: number;
  modelId: string;
  concurrentHint: number;
}): { id: string; title: string; body: string }[] {
  const base = `http://127.0.0.1:${opts.port}/v1`;
  const model = opts.modelId || "local-model";
  const n = Math.max(1, opts.concurrentHint);

  return [
    {
      id: "openai-env",
      title: "OpenAI-compatible endpoint",
      body: [
        `Base URL: ${base}`,
        `Model:    ${model}`,
        `API key:  any non-empty string (e.g. blackwell)`,
        "",
        "Chat:  POST /v1/chat/completions",
        "Comp:  POST /v1/completions",
      ].join("\n"),
    },
    {
      id: "opencode",
      title: "OpenCode / agent harness",
      body: [
        `Provider baseURL: ${base}`,
        `Model id:         ${model}`,
        "",
        `Ask the harness for up to ${n} concurrent agents / subagents`,
        "against this endpoint.",
        "",
        "Example env:",
        `  OPENAI_BASE_URL=${base}`,
        `  OPENAI_API_KEY=blackwell`,
        `  OPENAI_MODEL=${model}`,
      ].join("\n"),
    },
    {
      id: "curl",
      title: "Quick curl smoke test",
      body: [
        `curl -s ${base}/models | head`,
        "",
        `curl -s ${base}/chat/completions \\`,
        `  -H "Content-Type: application/json" \\`,
        `  -H "Authorization: Bearer blackwell" \\`,
        `  -d '{"model":"${model}","messages":[{"role":"user","content":"hi"}],"max_tokens":32}'`,
      ].join("\n"),
    },
  ];
}
