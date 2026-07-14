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

export type DraftRole = "none" | "mtp_embedded" | "external_dflash" | "external_eagle3";
export type CatalogDraftFilter = "regular" | "draft" | "all";
export type SpecCapability = "mtp" | "dflash" | "eagle3";

export const MODEL_SPEC_PARAM_KEYS = [
  "spec_type",
  "spec_draft_model",
  "spec_draft_n_max",
  "spec_draft_n_min",
] as const;

export const SPEC_DECODING_UI_GROUP = "SPECULATIVE-DECODING";

const MODEL_SPEC_KEY_SET = new Set<string>(MODEL_SPEC_PARAM_KEYS);

/** Any visible param in SPECULATIVE-DECODING — matches backend group toggle state. */
export function isSpecDecodingGroupActive(params: UserEditedTemplateParam[]): boolean {
  return params
    .filter((p) => paramUiGroup(p.ui_group) === SPEC_DECODING_UI_GROUP)
    .some((p) => !p.hidden);
}

/** Authoritative launch gate — group on, model capable, spec mode valid for this main. */
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

export function isModelSpecParamKey(key: string): boolean {
  return MODEL_SPEC_KEY_SET.has(key);
}

export function stripSpecExtraParams<T extends Record<string, unknown>>(params: T): T {
  const out = { ...params };
  for (const k of MODEL_SPEC_PARAM_KEYS) {
    delete out[k];
  }
  return out;
}

/** FULL-AUTO + Essentials — fixed N-max / N-min (hidden from UI). */
export const ESSENTIALS_SPEC_PRESETS: Record<
  string,
  { spec_draft_n_max: number; spec_draft_n_min: number }
> = {
  "draft-mtp": { spec_draft_n_max: 3, spec_draft_n_min: 1 },
  "draft-dflash": { spec_draft_n_max: 6, spec_draft_n_min: 1 },
};

export function essentialsSpecPreset(
  specType: string,
): { spec_draft_n_max: number; spec_draft_n_min: number } | null {
  return ESSENTIALS_SPEC_PRESETS[specType.trim().toLowerCase()] ?? null;
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
};

/** Minimum pairing score — blocks same-folder-only false positives. */
export const MIN_DRAFT_PAIR_SCORE = 58;

const FAMILY_RULES: { id: string; pattern: RegExp }[] = [
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
  if (hint === "external_dflash" || hint === "external_eagle3" || hint === "mtp_embedded") {
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

  if ((meta?.nextn_predict_layers ?? 0) > 0) return "mtp_embedded";

  return "none";
}

export function isExternalDraftOnly(
  model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
): boolean {
  const role = draftRoleFromModel(model);
  return role === "external_dflash" || role === "external_eagle3";
}

export function isLaunchableMain(
  model: Pick<ModelEntry, "path" | "name" | "metadata" | "hfMeta" | "hfModelId" | "sourcePathLabel" | "draftRoleHint">,
): boolean {
  return !isExternalDraftOnly(model);
}

/** @deprecated Use isLaunchableMain */
export const isLaunchableTarget = isLaunchableMain;

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

export function scoreDraftPair(main: ModelEntry, draft: ModelEntry, draftRole: DraftRole): number {
  if (draftRoleFromModel(draft) !== draftRole) return -1;
  if (!familiesCompatible(main, draft)) return -1;

  const mainStem = normalizeBaseStem(main);
  const draftStem = normalizeBaseStem(draft);
  const overlap = stemOverlapScore(mainStem, draftStem);
  if (overlap <= 0) return -1;

  let score = overlap;
  if (sameParent(main.path, draft.path)) score += 20;
  const mq = quantToken(main);
  const dq = quantToken(draft);
  if (mq && dq && mq === dq) score += 15;
  if (draft.metadata?.architecture?.toLowerCase() === draftRole.replace("external_", "")) score += 10;
  return score;
}

export type ScoredDraft = { model: ModelEntry; score: number };

export function findScoredDraftCandidates(
  main: ModelEntry,
  models: ModelEntry[],
  draftRole: DraftRole,
): ScoredDraft[] {
  if (isExternalDraftOnly(main)) return [];
  return models
    .filter((m) => m.path !== main.path && draftRoleFromModel(m) === draftRole)
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
): ModelEntry | undefined {
  return findScoredDraftCandidates(main, models, draftRole)[0]?.model;
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
  }
  // Baked-in MTP does not exclude external DFlash — user picks spec_type at launch.
  if ((main.metadata?.nextn_predict_layers ?? 0) > 0) {
    caps.push("mtp");
  }
  return caps;
}

/** @deprecated Use specCapabilitiesForMain */
export const specCapabilitiesForTarget = specCapabilitiesForMain;

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
  if (lower.includes("dflash") || lower.includes("eagle3")) return true;
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
  return scoreDraftPair(main, draft, role) >= MIN_DRAFT_PAIR_SCORE;
}