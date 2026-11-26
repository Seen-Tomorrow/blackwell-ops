/**
 * Launch cockpit — product language over parallel / spec / kv_quant / batch.
 * Full Auto (Joe): Smart/MTP/DFlash + optional batch push.
 * Assisted Full (Power): same Memory/Agents/Think; raw spec types; no Smart batch push.
 */

import type { SpecCapability } from "./specDraft";

/** Known agent presets + `p:N` for custom parallel values. */
export type CodingModeId = string;
/** Speed boost row — speculative draft / batch aggressiveness. */
export type SpeedBoostId = "off" | "mtp" | "dflash" | "dspark" | "smart";
/** Brains row — KV quant quality (VRAM trade) + `kv:VALUE` for custom. */
export type BrainsId = string;
/**
 * Optional thinking budget — the template's `reasoning` value name, verbatim.
 *
 * The template keeps the machine names (`off` / `on` / budgets) because they key its
 * `sub_params`; the cockpit only relabels the two sentinels so the ladder reads as a
 * token budget: `off` → Disabled, `on` → MAX (the template turns `on` into
 * `--reasoning-budget -1`, i.e. no limit). A budget keeps its own name, so the number
 * in the mark IS the token budget and needs no legend.
 */
export type ThinkId = string;

export interface ThinkOption {
  id: ThinkId;
  label: string;
  blurb: string;
}

/** Only the sentinel rungs get a word; everything else shows its own value. */
const THINK_LABEL: Record<string, string> = {
  off: "Disabled",
  on: "MAX",
};

const THINK_NOTES: Record<string, string> = {
  off: "Thinking off — no reasoning tokens",
  on: "No limit — the template maps this to -1",
};

/** Ladder position: off first, budgets ascending, the no-limit rung last. */
function thinkRank(id: string): number {
  const key = id.trim().toLowerCase();
  if (key === "off") return 0;
  if (key === "on") return Number.MAX_SAFE_INTEGER;
  const numeric = Number(key);
  return Number.isFinite(numeric) ? numeric : Number.MAX_SAFE_INTEGER - 1;
}

/** Label a rung gets on the slider — the stored value except for the two sentinels. */
export function thinkLabelFor(id: ThinkId): string {
  const key = String(id).trim().toLowerCase();
  return THINK_LABEL[key] ?? String(id);
}

/**
 * One mark per `reasoning` value the template publishes, ordered as a budget ladder.
 * A value we have never seen keeps its raw name, so a provider can add a rung freely.
 */
export function buildThinkOptions(values: (string | number)[] | undefined): ThinkOption[] {
  const seen = new Set<string>();
  const out: ThinkOption[] = [];
  for (const raw of values ?? []) {
    if (raw == null || typeof raw === "object") continue;
    const id = String(raw).trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push({
      id,
      label: thinkLabelFor(id),
      blurb: THINK_NOTES[id.toLowerCase()] ?? `Thinking budget ${id} tokens`,
    });
  }
  return out.sort((a, b) => thinkRank(a.id) - thinkRank(b.id));
}

/** Last resort only when a provider publishes no `reasoning` values at all. */
export const THINK_OPTIONS = buildThinkOptions(["off", 2000, 4000, 8000, "on"]);

export interface CodingModeOption {
  id: CodingModeId;
  label: string;
  parallel: number;
  blurb: string;
  /** True when value comes from user-added / non-preset factory chip. */
  custom?: boolean;
}

interface SpeedBoostOption {
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
  { id: "solo", label: "Solo", parallel: 1, blurb: "One stream - snappiest single agent" },
  { id: "twin", label: "Twin", parallel: 2, blurb: "2 agents — twin parallelism" },
  { id: "group", label: "Group", parallel: 4, blurb: "4 agents in parallel" },
  { id: "squad", label: "Squad", parallel: 8, blurb: "8 agents — coding swarm sweet spot" },
  { id: "team", label: "Team", parallel: 16, blurb: "16 agents — heavy harnesses" },
  { id: "swarm", label: "Swarm", parallel: 24, blurb: "24 agents — wide parallel swarm" },
  { id: "army", label: "Army", parallel: 32, blurb: "32 agents — max concurrency" },
  { id: "legion", label: "Legion", parallel: 64, blurb: "64 agents — beyond army scale" },
];

const PRESET_PARALLEL = new Set(CODING_MODE_OPTIONS.map((o) => o.parallel));

const SPEED_BOOST_OPTIONS: SpeedBoostOption[] = [
  {
    id: "smart",
    label: "Smart",
    blurb: "Factory-safe defaults — no speculative draft (placeholder until Smart algo)",
  },
  {
    id: "mtp",
    label: "MTP",
    blurb: "Built-in speculative tokens",
    needs: "mtp",
  },
  {
    id: "dflash",
    label: "DFlash2",
    blurb: "External DFlash1/2 draft — needs a draft model in your library",
    needs: "dflash",
  },
  {
    id: "dspark",
    label: "DSpark",
    blurb: "DeepSeek DSpark draft head — set draft GGUF path (Change draft)",
    // Always offered (path-based); not gated on catalog dflash capability
  },
];

export const BRAINS_OPTIONS: BrainsOption[] = [
  { id: "light", label: "Light", kvQuant: "q4_0", blurb: "Smaller KV — more room for agents / context" },
  { id: "balanced", label: "Balanced", kvQuant: "f8_e4m3", blurb: "FP8 KV — near-Solid quality for less memory, needs an engine that supports it" },
  { id: "solid", label: "Solid", kvQuant: "q8_0", blurb: "Balanced quality vs memory" },
  { id: "sharp", label: "Sharp", kvQuant: "f16", blurb: "Highest KV quality — hungriest VRAM" },
  { id: "bf16", label: "BF16", kvQuant: "bf16", blurb: "BF16 KV — max quality when the binary supports it" },
];

const KNOWN_KV_BY_NORM = new Map(
  BRAINS_OPTIONS.map((o) => [o.kvQuant.toLowerCase(), o] as const),
);

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
 *
 * `onlyTemplateValues: true` — no Solo…Army fill; empty input → empty options
 * (custom providers with no `parallel` param must not show 1–32 defaults).
 */
export function buildAgentOptions(
  parallelValues: (string | number)[] | undefined,
  opts?: { markNonPresetAsCustom?: boolean; onlyTemplateValues?: boolean },
): CodingModeOption[] {
  const markCustom = opts?.markNonPresetAsCustom !== false;
  const onlyTemplate = opts?.onlyTemplateValues === true;
  const nums = new Set<number>();
  if (!onlyTemplate) {
    // Named presets so Solo…Army stay available on Master / family templates
    for (const o of CODING_MODE_OPTIONS) nums.add(o.parallel);
  }
  for (const v of parallelValues ?? []) {
    const n = typeof v === "number" ? v : parseInt(String(v), 10);
    if (Number.isFinite(n) && n > 0) nums.add(n);
  }
  if (onlyTemplate && nums.size === 0) return [];
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

/** Slider label for a kv_quant value ("Crisp"), or the raw value when unmapped. */
export function memoryLabelForKvQuant(kv: string | undefined): string {
  const s = (kv ?? "").trim();
  if (!s) return "";
  return KNOWN_KV_BY_NORM.get(s.toLowerCase())?.label ?? s;
}

function pickKvQuantForBrains(
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
      ? ["q4_0", "f8_e4m3", "q8_0", "f16", "bf16"]
      : brains === "balanced"
        ? ["f8_e4m3", "q8_0", "q4_0", "f16", "bf16"]
        : brains === "solid"
          ? ["q8_0", "f8_e4m3", "q4_0", "f16", "bf16"]
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
  const order = ["q4_0", "f8_e4m3", "q8_0", "f16", "bf16"];
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

type BoostMarkColor = "green" | "violet";

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
 * Spec types we omit from Boost (no draft UX yet; DFlash covers external draft).
 * Matching is case-insensitive on key and label tokens.
 */
export function shouldOmitSpecTypeFromBoost(specType: string): boolean {
  const s = String(specType).trim().toLowerCase();
  if (!s || s === "off" || s === "none") return true;
  // Eagle3 needs external draft pairing we do not ship — prefer DFlash.
  if (s.includes("eagle")) return true;
  return false;
}

/**
 * Parse any factory / user-added spec_type into cockpit 2-word marks.
 * First token above track, remainder under — no hardcoding beyond MTP/DFlash accents + rank.
 */
export function parseSpecTypeBoostMark(specType: string): BoostMarkParts {
  const raw = String(specType).trim();
  const s = raw.toLowerCase();

  // Canonical product accents (still 2-word: draft / MTP|DFlash)
  if (s === "draft-mtp" || s === "mtp") {
    return {
      id: "mtp",
      label: "MTP",
      aboveLabel: "draft",
      blurb: "Built-in speculative tokens",
      badgeColor: "green",
      rank: 90,
    };
  }
  if (s === "draft-dflash" || s === "dflash") {
    return {
      id: "dflash",
      label: "DFlash2",
      aboveLabel: "draft",
      blurb: "External DFlash1/2 draft model — needs a draft GGUF in library",
      badgeColor: "violet",
      rank: 100,
    };
  }
  if (s === "draft-dspark" || s === "dspark") {
    return {
      id: "dspark",
      label: "DSpark",
      aboveLabel: "draft",
      blurb: "DeepSeek DSpark external draft head",
      badgeColor: "violet",
      rank: 105,
    };
  }

  // Generic 2-word split on first delimiter (- _ space)
  const parts = raw.split(/[-_\s]+/).filter(Boolean);
  const above = (parts[0] || raw).toLowerCase();
  const underRaw = parts.length > 1 ? parts.slice(1).join("-") : parts[0] || raw;
  const under =
    underRaw.length <= 10
      ? underRaw.charAt(0).toUpperCase() + underRaw.slice(1)
      : underRaw.slice(0, 8) + "…";

  // Rank: ngram early, other mid, unknown mid-high (MTP/DFlash stay last via specials above)
  let rank = 50;
  if (above === "ngram" || s.startsWith("ngram")) rank = 10;
  else if (above === "draft" || s.startsWith("draft")) rank = 30;
  else if (s.includes("simple")) rank = 20;

  return {
    id: `raw:${raw}`,
    label: under,
    aboveLabel: above,
    blurb: `Spec type ${raw}`,
    rank,
  };
}

/** Collect Boost mark source list: factory values + userAdded, minus omitted. */
export function collectBoostSpecTypes(
  values: (string | number)[] | undefined,
  userAdded?: (string | number)[] | undefined,
): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of [...(values || []), ...(userAdded || [])]) {
    const s = String(v).trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    if (shouldOmitSpecTypeFromBoost(s)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
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
  /** Prefer aggressive batch/ubatch (Smart speed). */
  pushBatch: boolean;
  kvQuant: string;
  reasoning: string | number | null;
  outcome: string;
  /** Joe-facing soft note (not CLI jargon). */
  softNote: string | null;
  /** DFlash selected but no matching draft in library yet. */
  needsDflashDraft: boolean;
  /** Resolved boost for header tint: mtp | dflash | smart. */
  boostTone: "mtp" | "dflash" | "dspark" | "smart";
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
  let pushBatch = false;
  let softNote: string | null = null;
  let needsDflashDraft = false;

  if (speed === "mtp") {
    enableSpec = true;
    specType = "draft-mtp";
  } else if (speed === "dflash") {
    // Always keep SPEC group ON for DFlash boost so n_max/n_min survive MTP↔DFlash switches.
    // Missing draft only gates the Get-draft CTA / launch validity — never tears down knobs.
    enableSpec = true;
    specType = "draft-dflash";
    needsDflashDraft = !dflashLibraryReady;
  } else if (speed === "dspark") {
    // Same external-draft UX as DFlash; CLI type is draft-dspark (DeepSeek V4 head).
    enableSpec = true;
    specType = "draft-dspark";
    needsDflashDraft = !dflashLibraryReady;
  } else if (speed === "smart" && !powerUser) {
    // Joe Smart = safe "Off" wording until a real algo exists.
    // batch/ubatch come from factory via LaunchPolicy.batch = "factory" — do not max.
    pushBatch = false;
    enableSpec = false;
    specType = null;
  } else {
    // off (Power) or unknown — leave batch alone, spec off
    pushBatch = false;
    enableSpec = false;
    specType = null;
  }

  const kvQuant = pickKvQuantForBrains(brains, kvQuantValues);

  // Think slider only drives REASONING budget (--reasoning / budget).
  // Reasoning Preserve is a free FEATURE-FLAGS chip — never cockpit-owned.
  // The rung NAME is the value the template keys its sub_params by, so it is written
  // back verbatim: the template decides what the engine actually sees.
  const reasoning: string | number | null = think ? think : null;

  const brainsLabel =
    BRAINS_OPTIONS.find((b) => b.id === brains)?.label
    ?? (typeof brains === "string" && brains.startsWith("kv:")
      ? brains.slice(3)
      : "Solid");
  const agentsN = parallel;
  const agentsLabel = `×${agentsN}`;
  // Header summary uses the same word the slider shows, not the stored value name.
  const thinkLabel = thinkLabelFor(think);

  let boostTone: "mtp" | "dflash" | "dspark" | "smart" = "smart";
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
  } else if (speed === "dspark" && enableSpec) {
    boostTone = "dspark";
    boostLabel = needsDflashDraft ? "DSpark…" : "DSpark";
  } else if (speed === "off") {
    boostTone = "smart";
    boostLabel = "Off";
  } else if (speed === "smart") {
    boostTone = "smart";
    boostLabel = "Smart";
  }

  // Header order: <boost> Boost · <memory> Memory · Agents · Think
  const outcome = `${boostLabel} Boost · ${brainsLabel} Memory · Agents ${agentsLabel} · Think ${thinkLabel}`;

  return {
    parallel: agentsN,
    codingMode,
    speed,
    brains,
    think,
    enableSpec,
    specType,
    pushBatch,
    kvQuant,
    reasoning,
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

function buildHarnessSnippets(opts: {
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
