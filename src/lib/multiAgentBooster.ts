/**
 * Launch cockpit — product language over parallel / spec / kv_quant / batch.
 * Full Auto (Joe): Smart/MTP/DFlash + optional batch push.
 * Assisted Full (Power): same Memory/Agents/Think; raw spec types; no Smart batch push.
 */

import type { SpecCapability } from "./specDraft";

/** Known agent presets + `p:N` for custom parallel values. */
export type CodingModeId = string;
/** Speed boost row — speculative draft / batch aggressiveness. */
export type SpeedBoostId = "off" | "mtp" | "dflash" | "smart";
/** Brains row — KV quant quality (VRAM trade) + `kv:VALUE` for custom. */
export type BrainsId = string;
/** Optional thinking budget for models that expose reasoning flags. */
export type ThinkId = "off" | "on" | "budget" | "budget2k";

export interface CodingModeOption {
  id: CodingModeId;
  label: string;
  parallel: number;
  blurb: string;
  /** True when value comes from user-added / non-preset factory chip. */
  custom?: boolean;
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
  custom?: boolean;
}

export const CODING_MODE_OPTIONS: CodingModeOption[] = [
  { id: "solo", label: "Solo", parallel: 1, blurb: "One stream — snappiest single agent" },
  { id: "group", label: "Group", parallel: 4, blurb: "4 agents in parallel" },
  { id: "squad", label: "Squad", parallel: 8, blurb: "8 agents — coding swarm sweet spot" },
  { id: "team", label: "Team", parallel: 16, blurb: "16 agents — heavy harnesses" },
  { id: "army", label: "Army", parallel: 32, blurb: "32 agents — max concurrency" },
];

const PRESET_PARALLEL = new Set(CODING_MODE_OPTIONS.map((o) => o.parallel));

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
  { id: "bf16", label: "BF16", kvQuant: "bf16", blurb: "BF16 KV — max quality when the binary supports it" },
];

const KNOWN_KV_BY_NORM = new Map(
  BRAINS_OPTIONS.map((o) => [o.kvQuant.toLowerCase(), o] as const),
);

export const THINK_OPTIONS: { id: ThinkId; label: string; blurb: string }[] = [
  { id: "off", label: "Off", blurb: "No chain-of-thought budget" },
  { id: "on", label: "On", blurb: "Full reasoning when the model supports it" },
  { id: "budget2k", label: "2k", blurb: "Capped thinking budget (~2000)" },
  { id: "budget", label: "4k", blurb: "Capped thinking budget (~4000)" },
];

/** Groups tucked away under Full Auto (Full Assisted still shows everything). */
export const FULL_AUTO_COLLAPSE_GROUPS = ["PERFORMANCE", "FEATURE-FLAGS", "ADVANCED"] as const;

export function codingModeFromParallel(parallel: number): CodingModeId {
  const exact = CODING_MODE_OPTIONS.find((o) => o.parallel === parallel);
  if (exact) return exact.id;
  if (!Number.isFinite(parallel) || parallel < 1) return "solo";
  // Custom / non-preset chip (e.g. user-added 128) — exact mark, not nearest preset.
  return `p:${Math.floor(parallel)}`;
}

export function parallelForCodingMode(mode: CodingModeId): number {
  if (typeof mode === "string" && mode.startsWith("p:")) {
    const n = parseInt(mode.slice(2), 10);
    return Number.isFinite(n) && n > 0 ? n : 1;
  }
  return CODING_MODE_OPTIONS.find((o) => o.id === mode)?.parallel ?? 1;
}

/**
 * Build Agents slider options from a value list.
 * Marks not in Solo…Army presets are treated as custom (Assisted user-added).
 * Full Auto should pass factory values only; Assisted passes factory + userAdded.
 */
export function buildAgentOptions(
  parallelValues: (string | number)[] | undefined,
  opts?: { markNonPresetAsCustom?: boolean },
): CodingModeOption[] {
  const markCustom = opts?.markNonPresetAsCustom !== false;
  const nums = new Set<number>();
  // Always include named presets so Solo…Army stay available
  for (const o of CODING_MODE_OPTIONS) nums.add(o.parallel);
  for (const v of parallelValues ?? []) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  const sorted = [...nums].sort((a, b) => a - b);
  return sorted.map((parallel) => {
    const preset = CODING_MODE_OPTIONS.find((o) => o.parallel === parallel);
    if (preset) return { ...preset };
    return {
      id: `p:${parallel}`,
      label: `×${parallel}`,
      parallel,
      blurb: `Parallel ${parallel}`,
      custom: markCustom && !PRESET_PARALLEL.has(parallel),
    };
  });
}

export function brainsFromKvQuant(kv: string | undefined): BrainsId {
  const s = (kv ?? "").trim();
  if (!s) return "solid";
  const known = KNOWN_KV_BY_NORM.get(s.toLowerCase());
  if (known) return known.id;
  const low = s.toLowerCase();
  if (low.includes("q4")) return "light";
  if (low.includes("q8")) return "solid";
  if (low === "bf16" || low.includes("bf16")) return "bf16";
  if (low === "f16" || low.includes("f16")) return "sharp";
  return `kv:${s}`;
}

export function pickKvQuantForBrains(
  brains: BrainsId,
  available: (string | number)[],
): string {
  if (typeof brains === "string" && brains.startsWith("kv:")) {
    return brains.slice(3);
  }
  const want = BRAINS_OPTIONS.find((b) => b.id === brains)?.kvQuant ?? "q8_0";
  const strs = available.map(String);
  if (strs.some((v) => v.toLowerCase() === want.toLowerCase())) {
    return strs.find((v) => v.toLowerCase() === want.toLowerCase()) ?? want;
  }
  // Fallbacks along the quality ladder
  const ladder =
    brains === "light"
      ? ["q4_0", "q8_0", "f16", "bf16"]
      : brains === "solid"
        ? ["q8_0", "q4_0", "f16", "bf16"]
        : brains === "bf16"
          ? ["bf16", "f16", "q8_0", "q4_0"]
          : ["f16", "bf16", "q8_0", "q4_0"];
  for (const c of ladder) {
    const hit = strs.find((v) => v.toLowerCase() === c);
    if (hit) return hit;
  }
  return strs[0] ?? want;
}

/**
 * Build Memory slider options from a value list.
 * Full Auto should pass factory values only; Assisted passes factory + userAdded.
 * Unknown values are custom-styled when markUnknownAsCustom is true (Assisted).
 */
export function buildMemoryOptions(
  kvQuantValues: (string | number)[] | undefined,
  opts?: { markUnknownAsCustom?: boolean },
): BrainsOption[] {
  const markCustom = opts?.markUnknownAsCustom !== false;
  const vals = (kvQuantValues ?? []).map(String).filter(Boolean);
  const list = vals.length > 0 ? vals : BRAINS_OPTIONS.map((o) => o.kvQuant);
  const seen = new Set<string>();
  const out: BrainsOption[] = [];
  for (const v of list) {
    const norm = v.toLowerCase();
    if (seen.has(norm)) continue;
    seen.add(norm);
    const known = KNOWN_KV_BY_NORM.get(norm);
    if (known) {
      out.push({ ...known, kvQuant: v });
      continue;
    }
    out.push({
      id: `kv:${v}`,
      label: v,
      kvQuant: v,
      blurb: `KV quant ${v}`,
      custom: markCustom,
    });
  }
  // Prefer quality ladder order when possible
  const order = ["q4_0", "q8_0", "f16", "bf16"];
  out.sort((a, b) => {
    const ia = order.indexOf(a.kvQuant.toLowerCase());
    const ib = order.indexOf(b.kvQuant.toLowerCase());
    if (ia >= 0 && ib >= 0) return ia - ib;
    if (ia >= 0) return -1;
    if (ib >= 0) return 1;
    return a.kvQuant.localeCompare(b.kvQuant);
  });
  return out;
}

// ── Boost (spec type) display: 2-word naming, family above track ───────────

export type BoostMarkColor = "green" | "violet";

export interface BoostMarkParts {
  /** Id for the slider (smart | off | mtp | dflash | raw:TYPE). */
  id: string;
  /** Word under the track (MTP, DFlash, mod, Eagle3, Smart…). */
  label: string;
  /** Family above track (draft / ngram) — empty for Off/Smart. */
  aboveLabel?: string;
  blurb: string;
  badgeColor?: BoostMarkColor;
  /** Sort: simple → complex; MTP/DFlash last. */
  rank: number;
}

/**
 * Parse factory / capability spec_type into cockpit 2-word marks.
 * Above = family (draft | ngram); under = mode name.
 */
export function parseSpecTypeBoostMark(specType: string): BoostMarkParts {
  const raw = String(specType).trim();
  const s = raw.toLowerCase();

  if (s === "draft-mtp" || s === "mtp") {
    return {
      id: "mtp",
      label: "MTP",
      aboveLabel: "draft",
      blurb: "Built-in speculative tokens — one agent only",
      badgeColor: "green",
      rank: 90,
    };
  }
  if (s === "draft-dflash" || s === "dflash") {
    return {
      id: "dflash",
      label: "DFlash",
      aboveLabel: "draft",
      blurb: "External draft model — needs a draft GGUF in library",
      badgeColor: "violet",
      rank: 100,
    };
  }
  if (s.startsWith("ngram")) {
    const rest = s.replace(/^ngram[-_]?/, "") || "mod";
    return {
      id: `raw:${raw}`,
      label: rest.length <= 8 ? rest : "mod",
      aboveLabel: "ngram",
      blurb: `N-gram speculative mode (${raw})`,
      rank: 10,
    };
  }
  if (s.startsWith("draft-")) {
    const rest = raw.slice("draft-".length) || raw;
    const pretty =
      rest.toLowerCase() === "eagle3"
        ? "Eagle3"
        : rest.toLowerCase() === "simple"
          ? "Simple"
          : rest.charAt(0).toUpperCase() + rest.slice(1);
    return {
      id: `raw:${raw}`,
      label: pretty,
      aboveLabel: "draft",
      blurb: `Speculative draft mode (${raw})`,
      rank: rest.toLowerCase().includes("eagle") ? 40 : 30,
    };
  }
  // Unknown factory value
  return {
    id: `raw:${raw}`,
    label: raw.length > 10 ? raw.slice(0, 8) + "…" : raw,
    aboveLabel: undefined,
    blurb: `Spec type ${raw}`,
    rank: 50,
  };
}

/** Complexity order for Boost marks — simplest first, MTP then DFlash last. */
export function compareBoostRank(a: BoostMarkParts, b: BoostMarkParts): number {
  if (a.rank !== b.rank) return a.rank - b.rank;
  return a.label.localeCompare(b.label);
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

  const brainsLabel =
    BRAINS_OPTIONS.find((b) => b.id === brains)?.label
    ?? (typeof brains === "string" && brains.startsWith("kv:")
      ? brains.slice(3)
      : "Solid");
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
