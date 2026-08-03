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

export type DraftRole = "none" | "mtp_embedded" | "external_dflash" | "external_eagle3" | "external_mtp";
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
  "draft-eagle3": "external_eagle3",
  "draft-external-mtp": "external_mtp",
};

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

function compactAlnumLower(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export function signalContainsDflash(signal: string): boolean {
  const lower = signal.toLowerCase();
  if (lower.includes("dflash")) return true;
  if (DFLASH_SIGNAL_RE.test(signal)) return true;
  return compactAlnumLower(signal).includes("dflash");
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
 * Deliberately NOT matching bare "-MTP-" or "MTP-GGUF": MTP-enabled *main* models use those
 * in their folder/file names (e.g. "Qwen3.6-27B-MTP-GGUF/..."), which are baked-in MTP, not
 * separate head files. Standalone heads are caught reliably by the vocab_size==0 / tiny-file
 * metadata heuristics in `draftRoleFromModel` — the path signal is only a pre-scan convenience
 * for names that explicitly say "head".
 */
export function signalContainsMtpHead(signal: string): boolean {
  const lower = signal.toLowerCase();
  // mtp-head, mtp_head, mtphead
  if (lower.includes("mtp-head") || lower.includes("mtp_head") || compactAlnumLower(signal).includes("mtphead")) return true;
  // head-mtp, head_mtp, headmtp
  if (lower.includes("head-mtp") || lower.includes("head_mtp") || compactAlnumLower(signal).includes("headmtp")) return true;
  // File literally named "X.mtp.gguf" (literal dot before mtp, not a dash) — a clear
  // head-export naming. "-mtp.gguf" is ambiguous and intentionally not matched.
  if (lower.endsWith(".mtp.gguf")) return true;
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

function modelHaystack(model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">): string {
  const meta = model.metadata;
  return [
    model.draftRoleHint,
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

function pathIdentityDraftRole(
  model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
): DraftRole | null {
  for (const signal of catalogDraftSignals(model)) {
    if (signalContainsDflash(signal)) return "external_dflash";
    if (signalContainsEagle3(signal)) return "external_eagle3";
    if (signalContainsMtpHead(signal)) return "external_mtp";
  }
  return null;
}

function metadataSuggestsDflash(
  model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
): boolean {
  const meta = model.metadata;
  if (!meta) return false;
  const arch = (meta.architecture ?? "").trim().toLowerCase();
  if (arch === "dflash") return true;

  if (meta.rawKvs) {
    for (const key of Object.keys(meta.rawKvs)) {
      const k = key.toLowerCase();
      if ((k.includes("target_layers") || k.includes("target_layer_ids")) && arch !== "eagle3") {
        return true;
      }
    }
  }

  const hay = modelHaystack(model);
  if (signalContainsDflash(hay)) return true;

  if (meta.n_layer > 0 && meta.n_layer <= 12 && arch !== "eagle3") {
    if (hay.includes("draft")) return true;
  }
  return false;
}

function parseDraftRoleHint(hint: string | undefined): DraftRole | null {
  if (!hint || hint === "none") return null;
  if (hint === "external_dflash" || hint === "external_eagle3" || hint === "mtp_embedded" || hint === "external_mtp") {
    return hint;
  }
  return null;
}

export function draftRoleFromModel(
  model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
): DraftRole {
  const pathRole = pathIdentityDraftRole(model);
  if (pathRole) return pathRole;

  const meta = model.metadata;
  const arch = (meta?.architecture ?? "").trim().toLowerCase();
  if (arch === "dflash") return "external_dflash";
  if (arch === "eagle3") return "external_eagle3";
  if (metadataSuggestsDflash(model)) return "external_dflash";

  const hinted = parseDraftRoleHint(model.draftRoleHint);
  if (hinted) return hinted;

  if (meta?.draft_role) {
    const role = meta.draft_role as DraftRole;
    if (role !== "none") return role;
  }

  // Standalone MTP head: has nextn layers AND path signals a separate head file.
  if ((meta?.nextn_predict_layers ?? 0) > 0 && signalContainsMtpHead(modelHaystack(model))) {
    return "external_mtp";
  }
  // Head-only GGUF: has nextn layers but no vocabulary (embedding-free head file).
  // Full models always carry a tokenizer + vocab; standalone heads don't.
  if ((meta?.nextn_predict_layers ?? 0) > 0 && (meta?.vocab_size ?? 0) === 0 && meta?.architecture) {
    return "external_mtp";
  }
  // Small-file MTP head: has nextn layers AND the file is tiny (<10 GiB) compared to a full model
  // of the same architecture. Catches head exports that carry a full tokenizer.
  if ((meta?.nextn_predict_layers ?? 0) > 0 && (meta?.file_size_bytes ?? 0) > 0 && (meta?.file_size_bytes ?? 0) < 10_737_418_240) {
    return "external_mtp";
  }

  if ((meta?.nextn_predict_layers ?? 0) > 0) return "mtp_embedded";

  return "none";
}

export function isExternalDraftOnly(
  model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
): boolean {
  const role = draftRoleFromModel(model);
  return role === "external_dflash" || role === "external_eagle3" || role === "external_mtp";
}

export function isLaunchableMain(
  model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
): boolean {
  return !isExternalDraftOnly(model);
}

export function matchesCatalogDraftFilter(
  model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
  filter: CatalogDraftFilter,
): boolean {
  const external = isExternalDraftOnly(model);
  if (filter === "regular") return !external;
  if (filter === "draft") return external;
  return true;
}

export function draftRoleBadge(role: DraftRole): string | null {
  switch (role) {
    case "external_dflash":
      return "DFLASH";
    case "external_eagle3":
      return "EAGLE3";
    case "external_mtp":
      return "MTP";
    case "mtp_embedded":
      return "MTP";
    default:
      return null;
  }
}

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
  // External MTP heads are loaded via DFlash mechanism — compatible for pairing.
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
    // External MTP heads are loaded via DFlash mechanism — same Boost profile.
    if (findDraftCandidates(main, models, "external_mtp").length > 0) {
      caps.push("dflash");
    }
  }
  // Baked-in MTP does not exclude external DFlash — user picks spec_type at launch.
  if ((main.metadata?.nextn_predict_layers ?? 0) > 0) {
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
  if (caps.includes("dflash")) return "draft-dflash";
  if (caps.includes("mtp")) return "draft-mtp";
  if (caps.includes("eagle3")) return "draft-eagle3";
  return null;
}

/** Whether external MTP candidates are available for a main model. */
export function hasExternalMtpDraft(
  main: ModelEntry | null | undefined,
  models: ModelEntry[] | null | undefined,
): boolean {
  if (!main || !models?.length || isExternalDraftOnly(main)) return false;
  return findDraftCandidates(main, models, "external_mtp").length > 0;
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

export function specTypeAllowsParallel(specType: string): boolean {
  return specType.trim().toLowerCase() !== "draft-mtp";
}

export function draftRoleForSpecType(specType: string): DraftRole | null {
  return DRAFT_ARCH_FOR_SPEC[specType.trim().toLowerCase()] ?? null;
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
  const role = draftRoleForSpecType(pairing.specType);
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
  const role = draftRoleForSpecType(pairing.specType);
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
    const pairingRole = draftRoleForSpecType(pairing.specType);
    // Accept saved pair when roles match, or when saved under draft-dflash / draft-eagle3 alias.
    const roleOk =
      pairingRole === draftRole
      || (draftRole === "external_dflash" && String(pairing.specType).toLowerCase().includes("dflash"))
      || (draftRole === "external_eagle3" && String(pairing.specType).toLowerCase().includes("eagle"))
      || (draftRole === "external_mtp" && String(pairing.specType).toLowerCase().includes("mtp"));
    if (roleOk) {
      const saved = tryPath(pairing.draftPath, "restored");
      if (saved) return saved;
    }
  }

  return pickBestDraftPair(main, models, draftRole, HIGH_DRAFT_PAIR_SCORE)?.path ?? null;
}

/** True when Boost DFlash can enable CLI (draft path ready — not waiting on Get draft). */
export function hasReadyDflashDraft(
  main: ModelEntry | null | undefined,
  models: ModelEntry[] | null | undefined,
  currentDraftPath?: string | null,
): boolean {
  if (!main || !models?.length) return false;
  if (pickBestDraftPair(main, models, "external_dflash", HIGH_DRAFT_PAIR_SCORE)) return true;

  // Also check external MTP candidates.
  if (pickBestDraftPair(main, models, "external_mtp", HIGH_DRAFT_PAIR_SCORE)) return true;

  const pairing = loadDraftPairing(main.path);
  if (
    pairing
    && String(pairing.specType).toLowerCase().includes("dflash")
    && isUsableDraftPairing(pairing, main, models)
  ) {
    return true;
  }

  const resolved = resolveExternalDraftPath(main, models, "external_dflash", {
    currentPath: currentDraftPath,
    specType: "draft-dflash",
  });
  return Boolean(resolved);
}

