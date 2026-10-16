import type { ModelEntry, UserEditedTemplateParam } from "./types";
import {
  KEYS,
  modelSpecOverrideKey,
  normalizeModelPathKey,
  paramUiGroup,
  readJsonStorage,
  removeStorage,
  writeJsonStorage,
  type ModelSpecOverride,
} from "./storage";
import { isTomProvider } from "./tomMtp";
import {
  isAnySpecProfileActive,
  isSpecProfileParamKey,
  SPEC_PROFILE_PARAM_KEYS,
} from "./specProfiles";

export type DraftRole = "none" | "external_dflash" | "external_eagle3" | "external_mtp";
export type CatalogDraftFilter = "regular" | "draft" | "all";
export type SpecCapability = "mtp" | "dflash" | "eagle3";

/** @deprecated Old single group — profiles use SPECULATIVE-MTP / SPECULATIVE-DFLASH. */
export const SPEC_DECODING_UI_GROUP = "SPECULATIVE-DECODING";

/** Profile knob keys are model-scoped (per-main overrides). */
export function isModelSpecParamKey(key: string): boolean {
  return isSpecProfileParamKey(key);
}

/** Any visible param in a SPEC profile group. */
export function isSpecDecodingGroupActive(params: UserEditedTemplateParam[]): boolean {
  return isAnySpecProfileActive(params);
}

export function resolveSpecLaunchActive(opts: {
  groupActive: boolean;
  hasCapability: boolean;
  specType: string | undefined;
  model: ModelEntry;
  models: ModelEntry[];
  providerId: string;
}): boolean {
  if (!opts.groupActive || !opts.hasCapability) return false;
  const st = opts.specType?.trim() ?? "";
  if (!st || st.toLowerCase() === "none") return false;
  return isSpecTypeValidForMain(st, opts.model, opts.models, opts.providerId);
}

export function essentialsSpecChipLabel(specType: string): string {
  const s = specType.trim().toLowerCase();
  if (s === "draft-mtp") return "MTP";
  if (s === "draft-dflash") return "DFLASH";
  return specType;
}

const DRAFT_ARCH_FOR_SPEC: Record<string, DraftRole> = {
  "draft-dflash": "external_dflash",
  // DSpark reuses external-draft pairing slot; path must contain dspark for engine validate.
  "draft-dspark": "external_dflash",
  "draft-eagle3": "external_eagle3",
  // Baked-in MTP has no draft file to pair. The role is resolved from the configured
  // draft path, not from this string — see draftRoleForSpecType.
  "draft-mtp": "external_mtp",
};

/**
 * CLI spec type → the catalog draft role it pairs against.
 *
 * `draft-mtp` is the one ambiguous string: it means baked-in MTP with no draft path, and
 * external MTP with one. With no path there is nothing to pair, so it resolves to null.
 */
export function draftRoleForSpecType(
  specType: string,
  draftPath?: string,
): DraftRole | null {
  const role = DRAFT_ARCH_FOR_SPEC[specType.trim().toLowerCase()] ?? null;
  if (role === "external_mtp" && specType.trim().toLowerCase() === "draft-mtp") {
    const path = draftPath?.trim() ?? "";
    if (!path || path.toLowerCase() === "off") return null;
  }
  return role;
}

/**
 * Minimum library pairing score (0–100).
 * Aligns with HF suggest tier: below this = ignore for auto-capability / auto-pair.
 * (Same-folder-only weak hits still fail stem overlap before reaching this floor.)
 */
export const MIN_DRAFT_PAIR_SCORE = 50;

/** High-confidence local pair — UI can badge as strong match. */
export const HIGH_DRAFT_PAIR_SCORE = 80;

export const FAMILY_RULES: { id: string; pattern: RegExp }[] = [
  { id: "qwen35", pattern: /qwen3\.?5|qwen35/i },
  { id: "qwen36", pattern: /qwen3\.?6|qwen36/i },
  { id: "qwen3-coder", pattern: /qwen3[-_.]?coder/i },
  { id: "qwen3", pattern: /qwen3/i },
  { id: "qwen2", pattern: /qwen2/i },
  { id: "gemma4", pattern: /gemma[-_.]?4|gemma4/i },
  { id: "gemma3", pattern: /gemma[-_.]?3|gemma3/i },
  { id: "gemma", pattern: /gemma/i },
  { id: "llama4", pattern: /llama[-_.]?4|llama4/i },
  { id: "llama3", pattern: /llama[-_.]?3|llama3/i },
  { id: "llama", pattern: /llama/i },
  { id: "mistral", pattern: /mistral/i },
  { id: "deepseek", pattern: /deepseek/i },
];

const DFLASH_SIGNAL_RE = /d[-_.\s]?flash/i;
const EAGLE3_SIGNAL_RE = /eagle[-_.\s]?3/i;
const DSPARK_SIGNAL_RE = /d[-_.\s]?spark/i;

function compactAlnumLower(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function signalContainsDflash(signal: string): boolean {
  const lower = signal.toLowerCase();
  if (lower.includes("dflash")) return true;
  if (DFLASH_SIGNAL_RE.test(signal)) return true;
  return compactAlnumLower(signal).includes("dflash");
}

/** DeepSeek DSpark draft head (path/name: dspark, d-spark, …). */
export function signalContainsDspark(signal: string): boolean {
  const lower = signal.toLowerCase();
  if (lower.includes("dspark")) return true;
  if (DSPARK_SIGNAL_RE.test(signal)) return true;
  return compactAlnumLower(signal).includes("dspark");
}

export function signalContainsEagle3(signal: string): boolean {
  const lower = signal.toLowerCase();
  if (lower.includes("eagle3")) return true;
  if (EAGLE3_SIGNAL_RE.test(signal)) return true;
  return compactAlnumLower(signal).includes("eagle3");
}

/**
 * Detect standalone MTP head signals — explicit "head" tokens only.
 *
 * Deliberately NOT matching `-mtp.gguf` or `MTP-GGUF`: those are baked-in MTP mains
 * (ISTA-DASLab `IQ3_S-mtp.gguf`, Unsloth `Qwen3.6-27B-MTP-GGUF`). The GGUF header has
 * no role field that distinguishes them from a sibling quant or from an external head.
 */
export function signalContainsMtpHead(signal: string): boolean {
  const lower = signal.toLowerCase();
  if (lower.includes("mtp-head") || lower.includes("mtp_head") || compactAlnumLower(signal).includes("mtphead")) return true;
  if (lower.includes("head-mtp") || lower.includes("head_mtp") || compactAlnumLower(signal).includes("headmtp")) return true;
  // "X.mtp.gguf" (dot before mtp) is a head export. "-mtp.gguf" is a baked-in main.
  if (lower.endsWith(".mtp.gguf")) return true;
  return false;
}

/**
 * Explicit external-head naming: the tokens above, an `mtp-` **file-name prefix**
 * (unsloth `mtp-Qwen3.8-Flash-Next-Q8_0`), or a bare `mtp` path segment (an `MTP/`
 * sidecar folder). Mirrors Rust `is_explicit_mtp_head_signal`.
 *
 * Narrower than a "contains mtp" test on purpose: a baked-in main lives in a
 * `Qwen3.6-27B-MTP-GGUF` repo folder (embedded token) and is named `X-MTP.gguf`
 * (suffix) — neither matches.
 */
export function isExplicitMtpHeadSignal(signal: string): boolean {
  if (signalContainsMtpHead(signal)) return true;
  for (const part of signal.replace(/\\/g, "/").split("/")) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (lower === "mtp") return true;
    if (lower.startsWith("mtp-") || lower.startsWith("mtp_")) return true;
  }
  return false;
}

/** Baked-in MTP main from publisher naming. Not a GGUF KV. */
export function signalContainsEmbeddedMtp(signal: string): boolean {
  for (const part of signal.replace(/\\/g, "/").split("/")) {
    if (!part) continue;
    const lower = part.toLowerCase();
    if (lower.endsWith(".gguf")) {
      if (lower.endsWith("-mtp.gguf") || lower.endsWith("_mtp.gguf") || /[-_]mtp-\d{5}-of-\d{5}\.gguf$/i.test(lower)) {
        return true;
      }
    } else if (lower.includes("mtp-gguf")) {
      return true;
    }
  }
  return false;
}

function pathSegmentSignals(modelPath: string): string[] {
  return modelPath.replace(/\\/g, "/").split("/").filter((s) => s.trim().length > 0);
}

export function catalogDraftSignals(
  model: Pick<ModelEntry, "path" | "name" | "hfMeta" | "hfModelId" | "sourcePathLabel">,
): string[] {
  const normalized = model.path.replace(/\\/g, "/");
  const fileName = normalized.split("/").pop() ?? "";
  const segments = pathSegmentSignals(model.path);
  return [
    ...segments,
    model.path,
    model.name,
    fileName,
    model.sourcePathLabel ?? "",
    model.hfMeta?.hfModelId,
    model.hfMeta?.repoName,
    model.hfModelId,
  ].filter((s): s is string => Boolean(s && s.trim()));
}

function modelHaystack(model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel">): string {
  const meta = model.metadata;
  return [
    ...catalogDraftSignals(model),
    meta?.general_basename,
    meta?.generalName,
    meta?.architecture,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

export function extractModelFamily(
  model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel">,
): string | null {
  const hay = modelHaystack(model);
  for (const rule of FAMILY_RULES) {
    if (rule.pattern.test(hay)) return rule.id;
  }
  return null;
}

/** Path-hint role guess for files the Rust scanner has not classified yet.
 *  Lower confidence by construction — Rust's `draftRoleHint` always wins. */
export function draftRoleFromPathHints(
  model: Pick<ModelEntry, "path" | "name" | "hfModelId" | "sourcePathLabel">,
): DraftRole | null {
  for (const signal of catalogDraftSignals(model)) {
    // DSpark heads before generic DFlash (path may contain both "dspark" and "Flash")
    if (signalContainsDspark(signal)) return "external_dflash";
    if (signalContainsDflash(signal)) return "external_dflash";
    if (signalContainsEagle3(signal)) return "external_eagle3";
    if (signalContainsMtpHead(signal)) return "external_mtp";
  }
  // Baked-in MTP naming is a capability, not a role — see `hasBakedMtp`.
  return null;
}

/** Baked-in MTP — a property of a TARGET, not a draft role.
 *  Header `nextnLayers` is authoritative; publisher naming only speaks when no shape has
 *  been scanned yet, because a baked-in main often omits the nextn KV entirely.
 *  A scanned shape with explicit head naming (`mtp-` prefix, `MTP/` folder) is a
 *  full-copy HEAD, not a baked-in target — mirrors the Rust classifier's full-copy branch. */
export function hasBakedMtp(
  model: Pick<ModelEntry, "path" | "name" | "hfModelId" | "sourcePathLabel" | "ggufShape">,
): boolean {
  if (model.ggufShape) {
    if ((model.ggufShape.nextnLayers ?? 0) <= 0) return false;
    if (isFullCopyHeadNaming(model)) return false;
    return true;
  }
  return catalogDraftSignals(model).some(signalContainsEmbeddedMtp);
}

/** Full-copy head export (whole target stack + nextn): the header cannot separate it
 *  from a baked-in main, so explicit head naming decides. Rust: `full_copy_head_naming`.
 *
 *  Deliberately file-local — NOT `catalogDraftSignals`, which includes the HF repo id.
 *  A repo named `*-MTP-GGUF` is a BAKED-IN main convention; a substring test on it
 *  would condemn every quant in such a repo to head-only. */
function isFullCopyHeadNaming(
  model: Pick<ModelEntry, "path" | "name">,
): boolean {
  const normalized = model.path.replace(/\\/g, "/");
  const fileName = (normalized.split("/").pop() ?? model.name).toLowerCase();
  if (fileName.startsWith("mtp-") || fileName.startsWith("mtp_")) return true;
  if (normalized.split("/").some((seg) => seg.toLowerCase() === "mtp")) return true;
  return signalContainsMtpHead(fileName);
}

/**
 * Rust owns classification (`spec_draft::classify_draft_role`). TS consumes the answer and
 * only falls back to path hints for files the scanner has not reached. `draftRoleHint` is
 * read exactly once, here — feeding it back into a classifier is the loop SPEC-ADAPTERS §1.5
 * calls a bug.
 */
export function draftRoleFromModel(
  model: Pick<ModelEntry, "path" | "name" | "hfModelId" | "sourcePathLabel" | "draftRoleHint" | "ggufShape">,
): DraftRole {
  // Tier 0 mirror of the Rust classifier: a private-format header (Strata's
  // `qwen4exp-mtp` material) is conclusive — no role, and the naming tier must
  // not run on it even though the folder is literally `mtp\`.
  if (model.ggufShape?.archMismatch) return "none";
  const hint = model.draftRoleHint;
  if (hint === "external_dflash" || hint === "external_eagle3" || hint === "external_mtp") {
    return hint;
  }
  // A scanned header is CONCLUSIVE for the truncated-copy rules, but a full-copy head
  // export (whole stack + nextn, named `mtp-*` / `MTP/`) is exactly the case the header
  // cannot separate from a baked-in main — Rust's classifier demotes it via naming and
  // this mirror must agree, or the two sides split on the same file.
  const shape = model.ggufShape;
  if (shape && (shape.nextnLayers ?? 0) > 0 && isFullCopyHeadNaming(model)) {
    return "external_mtp";
  }
  return draftRoleFromPathHints(model) ?? "none";
}

export function isExternalDraftOnly(
  model: Pick<ModelEntry, "path" | "name" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
): boolean {
  const role = draftRoleFromModel(model);
  return role === "external_dflash" || role === "external_eagle3" || role === "external_mtp";
}

export function isLaunchableMain(
  model: Pick<ModelEntry, "path" | "name" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
): boolean {
  return !isExternalDraftOnly(model);
}

export function matchesCatalogDraftFilter(
  model: Pick<ModelEntry, "path" | "name" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
  filter: CatalogDraftFilter,
): boolean {
  const external = isExternalDraftOnly(model);
  if (filter === "regular") return !external;
  if (filter === "draft") return external;
  return true;
}

export function draftRoleBadge(
  role: DraftRole,
  model?: Pick<ModelEntry, "path" | "name" | "hfModelId" | "sourcePathLabel" | "ggufShape">,
): string | null {
  // Private-format material gets its own badge — it is neither a draft nor a
  // main as far as our engines go (Strata's runtime consumes it, not `-md`).
  if (model?.ggufShape?.archMismatch) return "STRATA-MTP";
  switch (role) {
    case "external_dflash":
      if (model && catalogDraftSignals(model).some(signalContainsDspark)) return "DSPARK";
      return "DFLASH";
    case "external_eagle3":
      return "EAGLE3";
    case "external_mtp":
      return "MTP-HEAD";
    default:
      return null;
  }
}

/** Baked-in MTP badge — a TARGET capability, deliberately distinct from the
 *  external head's MTP-HEAD: same CLI string, different VRAM footprint and a
 *  different way to select it. */
export const BAKED_MTP_BADGE = "MTP-BAKED";

function stripShardSuffix(name: string): string {
  return name.replace(/-\d{5}-of-\d{5}(?:\.gguf)?$/i, "").replace(/\.gguf$/i, "");
}

function normalizeBaseStem(model: ModelEntry): string {
  const meta = model.metadata;
  const raw = meta?.general_basename?.trim() || meta?.generalName?.trim() || model.name.trim();
  let stem = stripShardSuffix(raw);
  stem = stem
    .replace(/-dflash$/i, "")
    .replace(/-eagle3$/i, "")
    .replace(/-mtp-gguf$/i, "")
    .replace(/-mtp$/i, "")
    .replace(/-gguf$/i, "")
    .replace(/[-_]draft$/i, "")
    .replace(/-(?:instruct|thinking|chat|base|preview|exp)$/i, "");
  return stem.toLowerCase();
}

/** Core identity for pairing — strips MoE / variant suffixes MTP mains often carry. */
function pairingStem(stem: string): string {
  return stem
    .replace(/qwen3\.6/g, "qwen36")
    .replace(/-a\d+b$/i, "")
    .replace(/-(?:next|coder-next|coder)$/i, "");
}

/** Qwen base families that share DFlash drafts (coder-next stays isolated). */
const QWEN_BASE_FAMILIES = new Set(["qwen3", "qwen35", "qwen36"]);

function quantToken(model: ModelEntry): string {
  const ft = model.metadata?.file_type_str?.trim() ?? "";
  const q = model.quant?.trim() ?? "";
  return (ft || q).toLowerCase();
}

function sameParent(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/[^/]+$/, "").toLowerCase();
  return norm(a) === norm(b);
}

function familiesCompatible(main: ModelEntry, draft: ModelEntry): boolean {
  const mainFamily = extractModelFamily(main);
  const draftFamily = extractModelFamily(draft);
  if (!mainFamily || !draftFamily) return false;
  if (mainFamily === draftFamily) return true;
  return QWEN_BASE_FAMILIES.has(mainFamily) && QWEN_BASE_FAMILIES.has(draftFamily);
}

function stemTokens(stem: string): string[] {
  return stem.split(/[-_.]+/).filter((t) => t.length >= 2);
}

function stemOverlapScore(mainStem: string, draftStem: string): number {
  if (!mainStem || !draftStem || mainStem.length < 5 || draftStem.length < 5) return 0;

  const mainCore = pairingStem(mainStem);
  const draftCore = pairingStem(draftStem);
  if (mainCore === draftCore) return 70;
  if (draftCore.includes(mainCore) || mainCore.includes(draftCore)) return 65;

  const mainTokens = stemTokens(mainCore);
  const draftTokenSet = new Set(stemTokens(draftCore));
  const shared = mainTokens.filter((t) => draftTokenSet.has(t));
  if (shared.length >= 2) return 58;
  if (shared.length === 1 && shared[0].length >= 4) return 52;

  return 0;
}

/// Roles that are interchangeable for pairing (e.g. external_mtp pairs with external_dflash).
function draftRolesMatch(asked: DraftRole, actual: DraftRole): boolean {
  if (actual === asked) return true;
  // A DFlash picker still accepts an MTP head: the head is a valid external draft for the
  // DFlash lane, and the reverse direction is what step 4's own lane now uses.
  if (asked === "external_dflash" && actual === "external_mtp") return true;
  return false;
}

export function scoreDraftPair(main: ModelEntry, draft: ModelEntry, draftRole: DraftRole): number {
  if (!draftRolesMatch(draftRole, draftRoleFromModel(draft))) return -1;
  if (!familiesCompatible(main, draft)) return -1;

  const mainStem = normalizeBaseStem(main);
  const draftStem = normalizeBaseStem(draft);
  const overlap = stemOverlapScore(mainStem, draftStem);
  if (overlap <= 0) return -1;

  // Overlap is already ~52–70; bonuses pad toward 100% confidence.
  let score = overlap;
  if (sameParent(main.path, draft.path)) score += 12;
  const mq = quantToken(main);
  const dq = quantToken(draft);
  if (mq && dq && mq === dq) score += 10;
  // External MTP heads use the same arch as the main model — trust stem overlap instead.
  if (draftRole !== "external_mtp" && draft.metadata?.architecture?.toLowerCase() === draftRole.replace("external_", "")) score += 8;
  // Cap at 100 — UI shows this as a percentage.
  return Math.min(100, score);
}

export type ScoredDraft = { model: ModelEntry; score: number };

export function findScoredDraftCandidates(
  main: ModelEntry,
  models: ModelEntry[],
  draftRole: DraftRole,
): ScoredDraft[] {
  if (isExternalDraftOnly(main)) return [];
  return models
    .filter((m) => m.path !== main.path && draftRolesMatch(draftRole, draftRoleFromModel(m)))
    .map((m) => ({ model: m, score: scoreDraftPair(main, m, draftRole) }))
    .filter((x) => x.score >= MIN_DRAFT_PAIR_SCORE)
    .sort((a, b) => b.score - a.score);
}

export function findDraftCandidates(
  main: ModelEntry,
  models: ModelEntry[],
  draftRole: DraftRole,
): ModelEntry[] {
  return findScoredDraftCandidates(main, models, draftRole).map((x) => x.model);
}

export function pickBestDraftPair(
  main: ModelEntry,
  models: ModelEntry[],
  draftRole: DraftRole,
  /** Default MIN — use HIGH for silent auto-apply (weak ~50–79 pairs often GGML_ASSERT at load). */
  minScore: number = MIN_DRAFT_PAIR_SCORE,
): ModelEntry | undefined {
  return findScoredDraftCandidates(main, models, draftRole).find((x) => x.score >= minScore)
    ?.model;
}

/** Spec modes a main model supports. MTP (baked-in nextn) and DFlash (external draft) are independent. */
export function specCapabilitiesForMain(
  main: ModelEntry,
  models: ModelEntry[],
  providerId: string,
): SpecCapability[] {
  if (isExternalDraftOnly(main)) return [];

  const caps: SpecCapability[] = [];
  if (!isTomProvider(providerId)) {
    if (findDraftCandidates(main, models, "external_dflash").length > 0) {
      caps.push("dflash");
    }
    if (findDraftCandidates(main, models, "external_eagle3").length > 0) {
      caps.push("eagle3");
    }
    // External MTP heads ride the MTP lane: `draft-mtp` + `-md` (mtp_draft_model).
    if (findDraftCandidates(main, models, "external_mtp").length > 0) {
      caps.push("mtp");
    }
  }
  // Baked-in MTP does not exclude external DFlash — user picks spec_type at launch.
  // Outside the Tom lane this is the same cap the external-MTP branch just pushed.
  if (hasBakedMtp(main) && !caps.includes("mtp")) {
    caps.push("mtp");
  }
  return caps;
}

export function defaultSpecTypeForMain(
  main: ModelEntry,
  models: ModelEntry[],
  providerId: string,
): string | null {
  const caps = specCapabilitiesForMain(main, models, providerId);
  // An external MTP head with no DFlash candidate rides its own lane: draft-mtp + -md.
  if (caps.includes("mtp") && findDraftCandidates(main, models, "external_mtp").length > 0) {
    return "draft-mtp";
  }
  if (caps.includes("dflash")) return "draft-dflash";
  if (caps.includes("mtp")) return "draft-mtp";
  if (caps.includes("eagle3")) return "draft-eagle3";
  return null;
}

/** Whether the chosen spec mode is supported by this main model (e.g. MTP needs nextn layers). */
export function isSpecTypeValidForMain(
  specType: string,
  main: ModelEntry,
  models: ModelEntry[],
  providerId: string,
): boolean {
  const normalized = specType.trim().toLowerCase();
  if (!normalized || normalized === "none") return true;
  const caps = specCapabilitiesForMain(main, models, providerId);
  // draft-mtp covers both baked-in nextn and an external MTP head (`draft-mtp` + `-md`).
  if (normalized === "draft-mtp") return caps.includes("mtp");
  if (normalized === "draft-dflash") return caps.includes("dflash");
  if (normalized.includes("eagle3") || normalized === "draft-eagle3") return caps.includes("eagle3");
  return true;
}

export function specTypeNeedsExternalDraft(specType: string): boolean {
  const lower = specType.trim().toLowerCase();
  if (lower.includes("dflash") || lower.includes("eagle3") || lower.includes("external-mtp")) return true;
  return lower.startsWith("draft-") && lower !== "draft-mtp" && lower !== "draft-simple";
}

/**
 * Spec types known NOT to support multiple slots (`-np > 1`).
 *
 * `draft-mtp` used to be listed here on assumption and was never measured — both shipped
 * seats run `total_slots: 1`, so the constraint was never actually exercised. Cleared so
 * `-np 2 --spec-type draft-mtp` can be benchmarked. Re-add only against a measured engine
 * failure, never a guess.
 */
const SPEC_TYPES_BLOCKING_PARALLEL = new Set<string>([]);

export function specTypeAllowsParallel(specType: string): boolean {
  return !SPEC_TYPES_BLOCKING_PARALLEL.has(specType.trim().toLowerCase());
}

export function isValidGgufDraftPath(path: string): boolean {
  const trimmed = path.trim();
  return trimmed.length > 0 && /\.gguf$/i.test(trimmed);
}

export function resolveDraftPathLabel(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const slash = normalized.lastIndexOf("/");
  return slash >= 0 ? normalized.slice(slash + 1) : normalized;
}

export type DraftPairing = { specType: string; draftPath: string };

export function loadDraftPairing(mainPath: string): DraftPairing | null {
  const map = readJsonStorage<Record<string, DraftPairing>>(KEYS.draftPairings) ?? {};
  return map[normalizeModelPathKey(mainPath)] ?? null;
}

export function saveDraftPairing(mainPath: string, specType: string, draftPath: string): void {
  const map = readJsonStorage<Record<string, DraftPairing>>(KEYS.draftPairings) ?? {};
  map[normalizeModelPathKey(mainPath)] = { specType, draftPath };
  writeJsonStorage(KEYS.draftPairings, map);
}

export function loadModelSpecOverride(mainPath: string): ModelSpecOverride | null {
  if (!mainPath) return null;
  return readJsonStorage<ModelSpecOverride>(modelSpecOverrideKey(mainPath));
}

export function saveModelSpecOverride(mainPath: string, patch: ModelSpecOverride): void {
  if (!mainPath) return;
  const prev = loadModelSpecOverride(mainPath) ?? {};
  writeJsonStorage(modelSpecOverrideKey(mainPath), { ...prev, ...patch });
}

export function clearModelSpecOverride(mainPath: string): void {
  if (!mainPath) return;
  removeStorage(modelSpecOverrideKey(mainPath));
}

export function isDraftPairingValid(
  pairing: DraftPairing,
  main: ModelEntry,
  models: ModelEntry[],
): boolean {
  const role = draftRoleForSpecType(pairing.specType, pairing.draftPath);
  if (!role) return false;
  const draft = models.find((m) => normalizeModelPathKey(m.path) === normalizeModelPathKey(pairing.draftPath));
  if (!draft) return false;
  // Silent restore / capability reuse — HIGH only. Weak (~50–79) auto-pairs often
  // GGML_ASSERT at load; user can still pick them live via Change draft.
  return scoreDraftPair(main, draft, role) >= HIGH_DRAFT_PAIR_SCORE;
}

/**
 * User-confirmed pairing still on disk (Change draft / Get draft / prior save).
 * MIN score — weaker than silent HIGH auto, but must not be wiped after the user picks it.
 */
export function isUsableDraftPairing(
  pairing: DraftPairing,
  main: ModelEntry,
  models: ModelEntry[],
): boolean {
  const role = draftRoleForSpecType(pairing.specType, pairing.draftPath);
  if (!role) return false;
  const draft = models.find(
    (m) => normalizeModelPathKey(m.path) === normalizeModelPathKey(pairing.draftPath),
  );
  if (draft) {
    if (!draftRolesMatch(role, draftRoleFromModel(draft))) return false;
    return scoreDraftPair(main, draft, role) >= MIN_DRAFT_PAIR_SCORE;
  }
  // Catalog lag after download — path still launchable if it looks like a GGUF.
  return isValidGgufDraftPath(pairing.draftPath);
}

/** Resolve external draft path via DFlash mechanism (also finds external MTP heads). */
export function resolveExternalDraftPath(
  main: ModelEntry,
  models: ModelEntry[],
  draftRole: DraftRole,
  opts?: {
    preferredPath?: string | null;
    currentPath?: string | null;
    specType?: string;
    /**
     * Fall back to the best-scoring candidate when nothing was chosen or saved.
     * DFlash keeps this (its ★ picker makes the result visible). MTP passes false:
     * a head must be picked or restored, never guessed into config silently.
     */
    allowAutoPair?: boolean;
  },
): string | null {
  const matchCatalog = (raw: string): ModelEntry | undefined =>
    models.find((m) => normalizeModelPathKey(m.path) === normalizeModelPathKey(raw));

  const tryPath = (
    raw: string | null | undefined,
    mode: "user" | "restored" | "auto",
  ): string | null => {
    if (raw == null) return null;
    const p = String(raw).trim();
    if (!p) return null;
    const low = p.toLowerCase();
    if (low === "off" || low === "auto" || low === "on" || low === "none") return null;

    const draft = matchCatalog(p);
    if (draft) {
      if (!draftRolesMatch(draftRole, draftRoleFromModel(draft))) return null;
      if (mode === "user") return draft.path;
      const score = scoreDraftPair(main, draft, draftRole);
      if (mode === "restored" && score < MIN_DRAFT_PAIR_SCORE) return null;
      if (mode === "auto" && score < HIGH_DRAFT_PAIR_SCORE) return null;
      return draft.path;
    }

    // Absolute path not yet in catalog (download just finished / external file).
    if (mode === "user" && isValidGgufDraftPath(p)) return p;
    if (mode === "restored" && isValidGgufDraftPath(p)) return p;
    return null;
  };

  const preferred = tryPath(opts?.preferredPath, "user");
  if (preferred) return preferred;

  const current = tryPath(opts?.currentPath, "restored");
  if (current) return current;

  const pairing = loadDraftPairing(main.path);
  if (pairing) {
    const pairingRole = draftRoleForSpecType(pairing.specType, pairing.draftPath);
    // Accept saved pair when roles match, or when saved under draft-dflash / draft-eagle3 alias.
    const st = String(pairing.specType).toLowerCase();
    const roleOk =
      pairingRole === draftRole
      || (draftRole === "external_dflash"
        && (st.includes("dflash") || st.includes("dspark")))
      || (draftRole === "external_eagle3" && st.includes("eagle"))
      || (draftRole === "external_mtp" && st.includes("mtp"));
    if (roleOk) {
      const saved = tryPath(pairing.draftPath, "restored");
      if (saved) return saved;
    }
  }

  if (opts?.allowAutoPair === false) return null;
  return pickBestDraftPair(main, models, draftRole, HIGH_DRAFT_PAIR_SCORE)?.path ?? null;
}

/** True when Boost DFlash/DSpark can enable CLI (draft path ready — not waiting on Get draft). */
export function hasReadyDflashDraft(
  main: ModelEntry | null | undefined,
  models: ModelEntry[] | null | undefined,
  currentDraftPath?: string | null,
): boolean {
  // User-confirmed absolute path (Change draft) — launchable even before role scoring.
  if (currentDraftPath && isValidGgufDraftPath(String(currentDraftPath))) {
    const low = String(currentDraftPath).trim().toLowerCase();
    if (low !== "off" && low !== "auto" && low !== "on" && low !== "none") {
      return true;
    }
  }

  if (!main || !models?.length) return false;
  if (pickBestDraftPair(main, models, "external_dflash", HIGH_DRAFT_PAIR_SCORE)) return true;

  // Also check external MTP candidates.
  if (pickBestDraftPair(main, models, "external_mtp", HIGH_DRAFT_PAIR_SCORE)) return true;

  const pairing = loadDraftPairing(main.path);
  if (pairing) {
    const st = String(pairing.specType).toLowerCase();
    if (
      (st.includes("dflash") || st.includes("dspark"))
      && isUsableDraftPairing(pairing, main, models)
    ) {
      return true;
    }
  }

  const resolved = resolveExternalDraftPath(main, models, "external_dflash", {
    currentPath: currentDraftPath,
    specType: "draft-dflash",
  });
  return Boolean(resolved);
}

