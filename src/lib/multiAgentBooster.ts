/**
 * Launch cockpit — product language over parallel / spec / kv_quant / batch.
 * Full Auto (Joe): Smart/MTP/DFlash + optional batch push.
 * Assisted Full (Power): same Memory/Agents/Think; raw spec types; no Smart batch push.
 */

import type { SpecCapability } from "./specDraft";

export type CodingModeId = "solo" | "group" | "squad" | "team" | "army";
/** Speed boost row — speculative draft / batch aggressiveness. */
export type SpeedBoostId = "off" | "mtp" | "dflash" | "smart";
/** Brains row — KV quant quality (VRAM trade). */
export type BrainsId = "light" | "solid" | "sharp";
/** Optional thinking budget for models that expose reasoning flags. */
export type ThinkId = "off" | "on" | "budget" | "budget2k";

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
    id: "smart",
    label: "Smart",
    blurb: "Push batch sizes for faster prefill when VRAM allows",
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
];

export const BRAINS_OPTIONS: BrainsOption[] = [
  { id: "light", label: "Light", kvQuant: "q4_0", blurb: "Smaller KV — more room for agents / context" },
  { id: "solid", label: "Solid", kvQuant: "q8_0", blurb: "Balanced quality vs memory" },
  { id: "sharp", label: "Sharp", kvQuant: "f16", blurb: "Highest KV quality — hungriest VRAM" },
];

export const THINK_OPTIONS: { id: ThinkId; label: string; blurb: string }[] = [
  { id: "off", label: "Off", blurb: "No chain-of-thought budget" },
  { id: "on", label: "On", blurb: "Full reasoning when the model supports it" },
  { id: "budget2k", label: "2k", blurb: "Capped thinking budget (~2000)" },
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
  /** DFlash selected but no matching draft in library yet. */
  needsDflashDraft: boolean;
  /** Resolved boost for header tint: mtp | dflash | smart. */
  boostTone: "mtp" | "dflash" | "smart";
  /** Short boost label for header (MTP / DFlash / Smart / DFlash…). */
  boostLabel: string;
  brainsLabel: string;
  agentsLabel: string;
  thinkLabel: string;
}

export function resolveFullAutoPlan(opts: {
  codingMode: CodingModeId;
  speed: SpeedBoostId;
  brains: BrainsId;
  think: ThinkId;
  capabilities: SpecCapability[];
  dflashLibraryReady: boolean;
  /** Family likely has a HF DFlash pack even if library empty. */
  dflashGettable?: boolean;
  kvQuantValues: (string | number)[];
  /**
   * Power (Assisted Full): never invent Smart→batch/ubatch; allow speed "off".
   * Joe / Full Auto / Essentials: default off→smart and may push batch.
   */
  powerUser?: boolean;
}): FullAutoPlan {
  const {
    codingMode,
    brains,
    think,
    capabilities,
    dflashLibraryReady,
    dflashGettable = false,
    kvQuantValues,
    powerUser = false,
  } = opts;
  let speed: SpeedBoostId = powerUser
    ? opts.speed
    : opts.speed === "off"
      ? "smart"
      : opts.speed;
  const hasMtp = capabilities.includes("mtp");
  const hasDflashLib = capabilities.includes("dflash") || dflashLibraryReady;
  const canAttemptDflash = hasDflashLib || dflashGettable;

  // Invalid boost for this main → fall through to another capable mode.
  // Joe path ends on Smart; Power path ends on Off (no silent batch push).
  if (speed === "mtp" && !hasMtp) {
    speed = canAttemptDflash ? "dflash" : powerUser ? "off" : "smart";
  }
  if (speed === "dflash" && !canAttemptDflash) {
    speed = hasMtp ? "mtp" : powerUser ? "off" : "smart";
  }
  if (powerUser && speed === "smart") {
    // Power never uses Smart as a product mode — treat as Off.
    speed = "off";
  }

  let parallel = parallelForCodingMode(codingMode);
  let enableSpec = false;
  let specType: string | null = null;
  let forcedSoloForMtp = false;
  let pushBatch = false;
  let softNote: string | null = null;
  let needsDflashDraft = false;

  if (speed === "mtp") {
    enableSpec = true;
    specType = "draft-mtp";
    if (parallel > 1) {
      parallel = 1;
      forcedSoloForMtp = true;
      softNote = "MTP works best with one agent — Agents set to Solo";
    }
  } else if (speed === "dflash") {
    if (dflashLibraryReady) {
      enableSpec = true;
      specType = "draft-dflash";
    } else {
      enableSpec = false;
      specType = null;
      needsDflashDraft = true;
      // softNote intentionally empty — draft CTA lives only under Boost strip
    }
  } else if (speed === "smart" && !powerUser) {
    // Joe Smart — push prefill batch; do not auto-enable MTP
    pushBatch = true;
    enableSpec = false;
    specType = null;
  } else {
    // off (Power) or unknown — leave batch alone, spec off
    pushBatch = false;
    enableSpec = false;
    specType = null;
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
  } else if (think === "budget2k") {
    reasoning = 2000;
    reasoningPreserve = "on";
  } else {
    reasoning = 4000;
    reasoningPreserve = "on";
  }

  const brainsLabel = BRAINS_OPTIONS.find((b) => b.id === brains)?.label ?? "Solid";
  const agentsN = forcedSoloForMtp ? 1 : parallel;
  const agentsLabel = `×${agentsN}`;
  const thinkLabel =
    think === "off"
      ? "Off"
      : think === "on"
        ? "On"
        : think === "budget2k"
          ? "2k"
          : "4k";

  let boostTone: "mtp" | "dflash" | "smart" = "smart";
  let boostLabel = powerUser ? "Off" : "Smart";
  if (speed === "mtp" && enableSpec) {
    boostTone = "mtp";
    boostLabel = "MTP";
  } else if (speed === "dflash" && enableSpec) {
    boostTone = "dflash";
    boostLabel = "DFlash";
  } else if (speed === "dflash" && needsDflashDraft) {
    boostTone = "dflash";
    boostLabel = "DFlash…";
  } else if (speed === "off") {
    boostTone = "smart";
    boostLabel = "Off";
  } else if (speed === "smart") {
    boostTone = "smart";
    boostLabel = "Smart";
  }

  // Header order: BOOST · MEMORY · AGENTS · THINK
  const outcome = `Boost ${boostLabel} · Memory ${brainsLabel} · Agents ${agentsLabel} · Think ${thinkLabel}`;

  return {
    parallel: agentsN,
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
    needsDflashDraft,
    boostTone,
    boostLabel,
    brainsLabel,
    agentsLabel,
    thinkLabel,
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
