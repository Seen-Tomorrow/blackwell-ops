/**
 * Full Auto — resolve DFlash draft candidates on HF for user confirmation.
 * Never auto-starts a download; Joe always picks from the candidate list.
 *
 * Caching: in-memory + localStorage TTL (~4h). Early-stop search when enough
 * ≥50% hits (or one ≥80%). On 429, serve stale cache if present.
 */

import { invoke } from "@tauri-apps/api/core";
import type { GgufFile, HfModel, HfModelInfo, HfSearchResponse, ModelEntry } from "./types";
import {
  extractModelFamily,
  isExternalDraftOnly,
  signalContainsDflash,
} from "./specDraft";
import { KEYS, readJsonStorage, writeJsonStorage } from "./storage";

const DFLASH_FAMILY_HINTS = new Set([
  "qwen3",
  "qwen35",
  "qwen36",
  "qwen3-coder",
  "gemma3",
  "gemma4",
  "llama3",
  "llama4",
  "mistral",
  "deepseek",
]);

/** Ordered like catalog family rules — more specific first. */
const FAMILY_DETECT: { id: string; pattern: RegExp }[] = [
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

export interface DflashDraftOffer {
  hfModelId: string;
  hfAuthor: string;
  quantType: string;
  file: GgufFile;
  sizeBytes: number;
  /** Short UI label, e.g. "org/repo · Q4_K_M · 1.8 GB" */
  label: string;
  /** Match confidence 0–100 (percentage). */
  score: number;
  /** Joe-facing match notes (family / size / author). */
  matchNotes: string[];
  downloads: number;
}

/**
 * Operational thresholds (0–100 confidence):
 *   ≥ HIGH  → pre-select / “high confidence” badge (still no auto-download)
 *   ≥ SUGGEST → show as recommended candidate (user confirms)
 *   < SUGGEST → ignore for auto-suggestions (drop from HF list)
 */
export const DFLASH_SCORE_SUGGEST = 50;
export const DFLASH_SCORE_HIGH = 80;

export type DflashMatchTier = "ignore" | "suggest" | "high";

export function dflashMatchTier(score: number | null | undefined): DflashMatchTier {
  if (score == null || !Number.isFinite(score) || score < DFLASH_SCORE_SUGGEST) return "ignore";
  if (score >= DFLASH_SCORE_HIGH) return "high";
  return "suggest";
}

/** Fresh cache TTL — high-confidence packs rarely flip hour-to-hour. */
export const DFLASH_CACHE_TTL_MS = 4 * 60 * 60 * 1000;
/** Stale entries still served on HF 429 (shared IP / CGNAT). */
export const DFLASH_CACHE_STALE_MAX_MS = 24 * 60 * 60 * 1000;
/** Cap disk map growth (per-main keys). */
const DFLASH_CACHE_MAX_KEYS = 40;

interface DflashCandidateCacheEntry {
  savedAt: number;
  offers: DflashDraftOffer[];
}

type DflashCandidateCacheMap = Record<string, DflashCandidateCacheEntry>;

/** Session memory — faster than re-reading localStorage every open. */
const memoryCache = new Map<string, DflashCandidateCacheEntry>();

/** Stable key for main model → candidate list. */
export function dflashCandidateCacheKey(main: ModelEntry): string {
  const family = extractModelFamily(main) ?? "";
  const sizeB = extractParamBillions(mainIdentityHay(main));
  const id =
    main.hfModelId?.trim() ||
    main.hfMeta?.hfModelId?.trim() ||
    main.path?.trim() ||
    main.name?.trim() ||
    "unknown";
  return `${id}|${family}|${sizeB ?? "na"}`.toLowerCase().replace(/\\/g, "/");
}

function cloneOffers(offers: DflashDraftOffer[]): DflashDraftOffer[] {
  return offers.map((o) => ({
    ...o,
    file: { ...o.file, shards: o.file.shards ? [...o.file.shards] : [] },
    matchNotes: [...(o.matchNotes || [])],
  }));
}

function isCacheFresh(entry: DflashCandidateCacheEntry, now = Date.now()): boolean {
  return now - entry.savedAt <= DFLASH_CACHE_TTL_MS;
}

function isCacheUsableStale(entry: DflashCandidateCacheEntry, now = Date.now()): boolean {
  return now - entry.savedAt <= DFLASH_CACHE_STALE_MAX_MS;
}

function readDiskCache(): DflashCandidateCacheMap {
  return readJsonStorage<DflashCandidateCacheMap>(KEYS.dflashHfCandidates) ?? {};
}

function writeDiskCache(map: DflashCandidateCacheMap): void {
  writeJsonStorage(KEYS.dflashHfCandidates, map);
}

/** Drop stale cache rows that predate size hard-gates (full 15GB "drafts"). */
function sanitizeCachedOffers(offers: DflashDraftOffer[]): DflashDraftOffer[] {
  return offers.filter(
    (o) =>
      o.file?.size_bytes > 0 &&
      o.file.size_bytes <= DFLASH_DRAFT_MAX_FILE_BYTES &&
      o.score >= DFLASH_SCORE_SUGGEST,
  );
}

function getCachedEntry(key: string): DflashCandidateCacheEntry | null {
  const mem = memoryCache.get(key);
  if (mem) {
    const offers = sanitizeCachedOffers(mem.offers);
    if (!offers.length) {
      memoryCache.delete(key);
      return null;
    }
    if (offers.length !== mem.offers.length) {
      const next = { ...mem, offers };
      memoryCache.set(key, next);
      return next;
    }
    return mem;
  }
  const disk = readDiskCache()[key];
  if (disk?.offers?.length) {
    const offers = sanitizeCachedOffers(disk.offers);
    if (!offers.length) return null;
    const next = { ...disk, offers };
    memoryCache.set(key, next);
    return next;
  }
  return null;
}

function putCache(key: string, offers: DflashDraftOffer[]): void {
  const entry: DflashCandidateCacheEntry = {
    savedAt: Date.now(),
    offers: cloneOffers(offers),
  };
  memoryCache.set(key, entry);

  const map = readDiskCache();
  map[key] = entry;
  // Prune oldest when over cap
  const keys = Object.keys(map);
  if (keys.length > DFLASH_CACHE_MAX_KEYS) {
    keys
      .map((k) => ({ k, t: map[k]?.savedAt ?? 0 }))
      .sort((a, b) => a.t - b.t)
      .slice(0, keys.length - DFLASH_CACHE_MAX_KEYS)
      .forEach(({ k }) => {
        delete map[k];
        memoryCache.delete(k);
      });
  }
  writeDiskCache(map);
}

/** Test / diagnostics — clear memory + disk candidate cache. */
export function clearDflashCandidateCache(): void {
  memoryCache.clear();
  writeDiskCache({});
}

function isRateLimitError(err: unknown): boolean {
  const s = typeof err === "string" ? err : err instanceof Error ? err.message : String(err ?? "");
  return /\b429\b/.test(s) || /rate.?limit/i.test(s) || /too many requests/i.test(s);
}

/** Early-stop: one high-confidence hit, or enough suggest-tier rows. */
function hasEnoughSearchHits(byId: Map<string, ScoredRepo>, limit: number): boolean {
  let suggest = 0;
  let high = 0;
  for (const row of byId.values()) {
    if (row.score >= DFLASH_SCORE_HIGH) high += 1;
    if (row.score >= DFLASH_SCORE_SUGGEST) suggest += 1;
  }
  if (high >= 1) return true;
  return suggest >= Math.max(limit, 3);
}

/** Known DFlash / speculator publishers (soft boost only). */
const DFLASH_TRUSTED_AUTHORS = new Set([
  "z-lab",
  "zlab",
  "redhatai",
  "redhat-ai",
]);

export function mainMaySupportDflash(main: ModelEntry | null | undefined): boolean {
  if (!main || isExternalDraftOnly(main)) return false;
  const family = extractModelFamily(main);
  if (family && DFLASH_FAMILY_HINTS.has(family)) return true;
  const hay = mainIdentityHay(main);
  return /qwen|gemma|llama|mistral|deepseek/i.test(hay);
}

function uniqueStrings(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    const s = raw.trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function mainIdentityHay(main: ModelEntry): string {
  return [
    main.name,
    main.path,
    main.hfModelId,
    main.hfMeta?.hfModelId,
    main.hfMeta?.repoName,
    main.metadata?.generalName,
    main.metadata?.general_basename,
  ]
    .filter(Boolean)
    .join(" ");
}

function stripGgufNoise(raw: string): string {
  return raw
    .replace(/\.gguf$/i, "")
    .replace(/-GGUF$/i, "")
    .replace(/_GGUF$/i, "")
    .replace(/-UD-.*$/i, "")
    .replace(/-(?:IQ\d|Q\d)[_A-Z0-9.]*$/i, "")
    .replace(/-\d{5}-of-\d{5}$/i, "")
    .trim();
}

function familyFromHay(hay: string): string | null {
  for (const rule of FAMILY_DETECT) {
    if (rule.pattern.test(hay)) return rule.id;
  }
  return null;
}

/**
 * Parameter count in billions (27, 35, 9…).
 * Avoids treating Qwen3.5 / Qwen3.6 version dots as sizes.
 */
export function extractParamBillions(hay: string): number | null {
  const cleaned = hay
    .replace(/qwen3\.5/gi, "qwen35")
    .replace(/qwen3\.6/gi, "qwen36")
    .replace(/gemma[-_.]?3/gi, "gemma3")
    .replace(/gemma[-_.]?4/gi, "gemma4");

  const patterns = [
    /(?:^|[^0-9])(\d{1,3}(?:\.\d+)?)\s*b(?:illion)?(?:[^a-z0-9]|$)/i,
    /[-_](\d{1,3}(?:\.\d+)?)b(?:[-_.]|$)/i,
  ];
  for (const re of patterns) {
    const m = cleaned.match(re);
    if (!m) continue;
    const n = parseFloat(m[1]);
    if (Number.isFinite(n) && n >= 0.5 && n <= 1000) return n;
  }
  return null;
}

function familyLabel(id: string | null): string {
  if (!id) return "unknown";
  switch (id) {
    case "qwen35":
      return "Qwen3.5";
    case "qwen36":
      return "Qwen3.6";
    case "qwen3-coder":
      return "Qwen3-Coder";
    case "qwen3":
      return "Qwen3";
    default:
      return id;
  }
}

function sizesClose(a: number, b: number): boolean {
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  if (lo <= 0) return false;
  return hi / lo <= 1.15 || Math.abs(a - b) <= 1;
}

/** HF search queries from main model identity (specific → broad). */
export function dflashSearchQueries(main: ModelEntry): string[] {
  const family = extractModelFamily(main);
  const hay = mainIdentityHay(main);
  const repo =
    main.hfMeta?.repoName?.trim() ||
    main.hfModelId?.split("/")[1]?.trim() ||
    main.hfMeta?.hfModelId?.split("/")[1]?.trim() ||
    "";
  const nameStem = stripGgufNoise(main.name || "");
  const repoStem = stripGgufNoise(repo);
  const sizeB = extractParamBillions(hay);
  const sizeToken = sizeB != null ? `${sizeB}B` : "";

  const familySearch =
    family === "qwen36"
      ? "Qwen3.6"
      : family === "qwen35"
        ? "Qwen3.5"
        : family === "qwen3-coder"
          ? "Qwen3-Coder"
          : family === "qwen3"
            ? "Qwen3"
            : familyLabel(family);

  const queries: string[] = [];
  // Most specific first — size + family + dflash
  if (familySearch && sizeToken) {
    queries.push(`${familySearch} ${sizeToken} dflash`);
    queries.push(`${familySearch}-${sizeToken} dflash`);
  }
  if (repoStem) {
    queries.push(`${repoStem} dflash`);
    if (sizeToken && !repoStem.toLowerCase().includes(sizeToken.toLowerCase())) {
      queries.push(`${repoStem} ${sizeToken} dflash`);
    }
  }
  if (nameStem && nameStem.toLowerCase() !== repoStem.toLowerCase()) {
    queries.push(`${nameStem} dflash`);
  }
  if (familySearch) {
    queries.push(`${familySearch} dflash gguf`);
  }
  // Broad fallback last — scoring will hard-reject wrong family/size
  queries.push("dflash gguf draft");
  return uniqueStrings(queries).slice(0, 8);
}

/** True draft packs are small; full 27B Q4 ≈15GB must never pass as DFlash. */
export const DFLASH_DRAFT_MAX_FILE_BYTES = 6 * 1024 * 1024 * 1024; // 6 GiB

function smallestGgufBytes(m: HfModel): number | null {
  const sizes = (m.gguf_files || [])
    .map((f) => f.size_bytes)
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!sizes.length) return null;
  return Math.min(...sizes);
}

function repoLooksLikeDflash(m: HfModel): boolean {
  const id = m.id || "";
  // Prefer repo id — tags alone often hitch-hike onto full-model cards from search.
  if (signalContainsDflash(id)) return true;
  if ((m.gguf_files || []).some((f) => signalContainsDflash(f.type) || signalContainsDflash(f.url))) {
    return true;
  }
  // Tags only: require at least one compact GGUF so we don't promote 15GB mains.
  if ((m.tags || []).some((t) => signalContainsDflash(t))) {
    const smallest = smallestGgufBytes(m);
    return smallest != null && smallest <= DFLASH_DRAFT_MAX_FILE_BYTES;
  }
  return false;
}

interface ScoredRepo {
  model: HfModel;
  /** 0–100 match confidence. */
  score: number;
  notes: string[];
}

/** Compact stem tokens from main identity for repo-name overlap (0–100 scorer). */
function mainNameTokens(main: ModelEntry): string[] {
  const hay = [
    main.hfMeta?.repoName,
    main.hfModelId?.split("/")[1],
    main.hfMeta?.hfModelId?.split("/")[1],
    stripGgufNoise(main.name || ""),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const cleaned = hay
    .replace(/qwen3\.5/g, "qwen35")
    .replace(/qwen3\.6/g, "qwen36")
    .replace(/[^a-z0-9]+/g, " ");
  return cleaned
    .split(/\s+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !/^(gguf|instruct|chat|thinking|base|preview|exp|ud)$/.test(t));
}

/**
 * Weighted 0–100 matrix for HF DFlash candidates.
 * Hard gates reject obvious mismatches; remaining weight is a confidence %.
 *
 * Budget (max 100):
 *   30  DFlash identity (id / tags / files)
 *   30  family
 *   25  param size
 *   10  repo name ↔ main slug overlap
 *    5  trusted / same author
 *  (+ downloads as sub-point tie-break only, never dominates)
 */
function scoreDflashRepo(m: HfModel, main: ModelEntry): ScoredRepo | null {
  if (!repoLooksLikeDflash(m)) return null;
  const idLower = m.id.toLowerCase();
  if (idLower.includes("mtp") && !signalContainsDflash(m.id)) return null;

  // Hard gate: full-size weights are not draft packs (e.g. 15GB Q4_K_M of 27B).
  const smallestKnown = smallestGgufBytes(m);
  if (smallestKnown != null && smallestKnown > DFLASH_DRAFT_MAX_FILE_BYTES) {
    return null;
  }

  const mainFamily = extractModelFamily(main);
  const candFamily = familyFromHay(m.id);
  const mainSize = extractParamBillions(mainIdentityHay(main));
  const candSize = extractParamBillions(m.id);
  const notes: string[] = [];

  // Hard gates: wrong specific family or wrong param count.
  if (mainFamily && candFamily && mainFamily !== candFamily) {
    // qwen3 (generic) may still match qwen35/36 packs — only soft-penalize later
    const mainSpecific =
      mainFamily !== "qwen3" &&
      mainFamily !== "qwen2" &&
      mainFamily !== "gemma" &&
      mainFamily !== "llama";
    const candSpecific =
      candFamily !== "qwen3" &&
      candFamily !== "qwen2" &&
      candFamily !== "gemma" &&
      candFamily !== "llama";
    if (mainSpecific && candSpecific) {
      return null;
    }
  }
  if (mainSize != null && candSize != null && !sizesClose(mainSize, candSize)) {
    return null;
  }

  let score = 0;

  // ── 1. DFlash identity (0–30) ──────────────────────────────────────────
  if (signalContainsDflash(m.id)) {
    score += 30;
    notes.push("DFlash pack");
  } else if ((m.tags || []).some((t) => signalContainsDflash(t))) {
    score += 18;
    notes.push("DFlash tag");
  } else {
    score += 10;
    notes.push("DFlash in files only");
  }

  // ── 2. Family (0–30) ───────────────────────────────────────────────────
  if (mainFamily && candFamily) {
    if (mainFamily === candFamily) {
      score += 30;
      notes.push(`family ${familyLabel(mainFamily)}`);
    } else if (mainFamily === "qwen3" && (candFamily === "qwen35" || candFamily === "qwen36")) {
      score += 14;
      notes.push(`family ${familyLabel(candFamily)} (generic Qwen3 main)`);
    } else {
      // Soft miss past hard gate (e.g. generic llama vs llama3)
      score += 4;
      notes.push(`family soft-miss ${familyLabel(candFamily)}`);
    }
  } else if (mainFamily && !candFamily) {
    score += 6;
    notes.push("family unclear on HF id");
  } else {
    score += 10;
  }

  // ── 3. Param size (0–25) ───────────────────────────────────────────────
  if (mainSize != null && candSize != null) {
    if (sizesClose(mainSize, candSize)) {
      score += 25;
      notes.push(`${candSize}B params`);
    }
  } else if (mainSize != null && candSize == null) {
    score += 6;
    notes.push("param size not in repo name");
  } else if (mainSize == null && candSize != null) {
    score += 10;
    notes.push(`draft lists ${candSize}B`);
  } else {
    score += 8;
  }

  // ── 4. Repo name ↔ main slug (0–10) ─────────────────────────────────────
  const tokens = mainNameTokens(main);
  const matched = tokens.filter((t) => idLower.includes(t));
  if (matched.length >= 2 || (matched.length === 1 && matched[0].length >= 6)) {
    score += 10;
    notes.push("name overlap");
  } else if (matched.length === 1) {
    score += 5;
    notes.push("partial name");
  }

  // ── 5. Author / trusted publishers (0–5) ───────────────────────────────
  const candAuthor = (m.author || m.id.split("/")[0] || "").toLowerCase();
  const mainAuthor = (main.hfMeta?.author || main.author || "").toLowerCase();
  if (candAuthor && DFLASH_TRUSTED_AUTHORS.has(candAuthor)) {
    score += 5;
    notes.push(`trusted ${candAuthor}`);
  } else if (mainAuthor && candAuthor && mainAuthor === candAuthor) {
    score += 4;
    notes.push("same author");
  }

  // Prefer compact draft packs (≤2 GiB strong, ≤6 GiB ok).
  if (smallestKnown != null) {
    if (smallestKnown <= 2 * 1024 * 1024 * 1024) {
      score += 3;
      notes.push("compact draft size");
    } else if (smallestKnown <= DFLASH_DRAFT_MAX_FILE_BYTES) {
      score += 1;
    }
  }

  // Downloads: sub-percent tie-break only (never more than ~1 pt).
  score += Math.min(1, Math.min(m.downloads || 0, 500_000) / 500_000);

  const pct = Math.max(0, Math.min(100, Math.round(score)));
  return { model: m, score: pct, notes };
}

const QUANT_PREF = [
  "q4_k_m",
  "q4_k_s",
  "q4_0",
  "iq4_xs",
  "iq4_nl",
  "q5_k_m",
  "q3_k_m",
  "q5_0",
  "q8_0",
];

export function pickDflashQuant(files: GgufFile[], main: ModelEntry): GgufFile | null {
  if (!files.length) return null;
  // Never offer full-size mains as "draft" (15GB Q4 of 27B, etc.).
  const usable = files.filter(
    (f) =>
      f.url?.trim() &&
      f.size_bytes > 0 &&
      f.size_bytes <= DFLASH_DRAFT_MAX_FILE_BYTES,
  );
  if (!usable.length) return null;

  // Prefer files whose name/type still says dflash when available.
  const dflashFirst = usable.filter(
    (f) => signalContainsDflash(f.type) || signalContainsDflash(f.url),
  );
  const pool = dflashFirst.length > 0 ? dflashFirst : usable;

  const mq = (main.quant || main.metadata?.file_type_str || "").toLowerCase().trim();
  const prefs = mq ? [mq, ...QUANT_PREF] : QUANT_PREF;

  for (const p of prefs) {
    const hit = pool.find((f) => {
      const t = f.type.toLowerCase();
      return t === p || t.includes(p);
    });
    if (hit) return hit;
  }

  const sorted = [...pool].sort((a, b) => a.size_bytes - b.size_bytes);
  const compact = sorted.find((f) => f.size_bytes <= 4 * 1024 * 1024 * 1024);
  return compact ?? sorted[0] ?? null;
}

function formatSize(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${Math.max(1, Math.round(mb))} MB`;
}

function offerLabel(hfModelId: string, quantType: string, sizeBytes: number): string {
  return `${hfModelId} · ${quantType} · ${formatSize(sizeBytes)}`;
}

/**
 * Search HF for up to `limit` DFlash draft candidates (default 3).
 * Drops scores &lt; {@link DFLASH_SCORE_SUGGEST} (ignore tier).
 * Fresh cache (~4h) short-circuits; stale cache (≤24h) used on 429.
 * Early-stops search after one ≥80% hit or enough ≥50% hits.
 * Always returns a list for user confirmation — never auto-downloads.
 */
export async function findDflashDraftCandidates(
  main: ModelEntry,
  limit = 3,
): Promise<DflashDraftOffer[]> {
  const cacheKey = dflashCandidateCacheKey(main);
  const cached = getCachedEntry(cacheKey);
  if (cached && isCacheFresh(cached) && cached.offers.length > 0) {
    return cloneOffers(cached.offers).slice(0, Math.max(1, limit));
  }

  const queries = dflashSearchQueries(main);
  const byId = new Map<string, ScoredRepo>();
  let hitRateLimit = false;
  let anySearchOk = false;

  for (const query of queries) {
    if (hasEnoughSearchHits(byId, limit)) break;
    try {
      const resp = await invoke<HfSearchResponse>("search_hf_models", {
        query,
        vramLimitGb: undefined,
        sort: "downloads",
        limit: 40,
      });
      anySearchOk = true;
      for (const m of resp.models || []) {
        const scored = scoreDflashRepo(m, main);
        if (!scored) continue;
        // Ignore tier: too weak for auto-suggestions (vocab / tensor risk).
        if (scored.score < DFLASH_SCORE_SUGGEST) continue;
        const prev = byId.get(m.id);
        if (!prev || scored.score > prev.score) {
          byId.set(m.id, scored);
        }
      }
    } catch (err) {
      if (isRateLimitError(err)) {
        hitRateLimit = true;
        console.warn("[dflashGetDraft] HF rate limit on search:", query, err);
      } else {
        console.warn("[dflashGetDraft] search failed:", query, err);
      }
    }
  }

  // 429 and no usable live hits → stale cache (up to 24h)
  if (byId.size === 0 && hitRateLimit && cached && isCacheUsableStale(cached) && cached.offers.length > 0) {
    console.warn("[dflashGetDraft] serving stale cache after HF 429");
    return cloneOffers(cached.offers).slice(0, Math.max(1, limit));
  }

  const ranked = [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit));

  if (ranked.length === 0) {
    if (hitRateLimit && !anySearchOk) {
      throw new Error(
        "HF rate limit (429) — retry later, or set HF token in CONFIG → Secrets",
      );
    }
    // Soft 429 after partial fails with empty score set
    if (hitRateLimit && cached && isCacheUsableStale(cached) && cached.offers.length > 0) {
      return cloneOffers(cached.offers).slice(0, Math.max(1, limit));
    }
    return [];
  }

  const offers: DflashDraftOffer[] = [];
  for (const row of ranked) {
    let files = row.model.gguf_files || [];
    const searchHasUsable = files.some((f) => f.url?.trim() && f.size_bytes > 0);
    // Search already returns siblings when full=true — skip extra tree fetch if usable.
    if (!searchHasUsable) {
      try {
        const info = await invoke<HfModelInfo>("get_hf_model_info", { modelId: row.model.id });
        if (info.gguf_files?.length) files = info.gguf_files;
      } catch (err) {
        if (isRateLimitError(err)) {
          hitRateLimit = true;
          console.warn("[dflashGetDraft] HF rate limit on model info:", row.model.id, err);
        } else {
          console.warn("[dflashGetDraft] get_hf_model_info failed:", row.model.id, err);
        }
      }
    }
    const file = pickDflashQuant(files, main);
    if (!file) continue;

    const slash = row.model.id.indexOf("/");
    const hfAuthor =
      slash > 0 ? row.model.id.slice(0, slash) : row.model.author || "unknown";

    offers.push({
      hfModelId: row.model.id,
      hfAuthor,
      quantType: file.type,
      file,
      sizeBytes: file.size_bytes,
      label: offerLabel(row.model.id, file.type, file.size_bytes),
      score: row.score,
      matchNotes: row.notes,
      downloads: row.model.downloads || 0,
    });
  }

  if (offers.length === 0) {
    if (hitRateLimit && cached && isCacheUsableStale(cached) && cached.offers.length > 0) {
      console.warn("[dflashGetDraft] serving stale cache after resolve 429");
      return cloneOffers(cached.offers).slice(0, Math.max(1, limit));
    }
    return [];
  }

  putCache(cacheKey, offers);
  return offers;
}

/** @deprecated Use findDflashDraftCandidates + user confirm. */
export async function findDflashDraftOffer(main: ModelEntry): Promise<DflashDraftOffer | null> {
  const list = await findDflashDraftCandidates(main, 1);
  return list[0] ?? null;
}

/** Normalize Joe paste: URL or bare `org/repo`. */
export function normalizeHfModelIdInput(raw: string): string | null {
  let s = raw.trim();
  if (!s) return null;
  s = s.replace(/^https?:\/\/huggingface\.co\//i, "");
  s = s.replace(/^hf:\/\//i, "");
  s = s.split(/[?#]/)[0] ?? s;
  s = s.replace(/\/tree\/.*$/i, "").replace(/\/resolve\/.*$/i, "").replace(/\/+$/, "");
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?\/[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(s)) {
    return null;
  }
  return s;
}

/**
 * Resolve a user-typed HF model card id into a downloadable DFlash offer.
 * Uses preferred quant pick against the main model.
 */
export async function resolveDflashOfferFromHfId(
  main: ModelEntry,
  rawId: string,
): Promise<DflashDraftOffer> {
  const hfModelId = normalizeHfModelIdInput(rawId);
  if (!hfModelId) {
    throw new Error('Use HF id format org/repo (e.g. zai-org/GLM-5.1)');
  }

  const info = await invoke<HfModelInfo>("get_hf_model_info", { modelId: hfModelId });
  const files = info.gguf_files || [];
  if (files.length === 0) {
    throw new Error(`No GGUF files found on ${hfModelId}`);
  }
  const file = pickDflashQuant(files, main);
  if (!file) {
    throw new Error(`No downloadable GGUF quant on ${hfModelId}`);
  }

  const slash = hfModelId.indexOf("/");
  const hfAuthor = slash > 0 ? hfModelId.slice(0, slash) : info.author || "unknown";

  return {
    hfModelId,
    hfAuthor,
    quantType: file.type,
    file,
    sizeBytes: file.size_bytes,
    label: offerLabel(hfModelId, file.type, file.size_bytes),
    score: 0,
    matchNotes: ["manual HF id"],
    downloads: info.downloads || 0,
  };
}

/** Enqueue quant download (same path as Model Hub). Only after user confirms. */
export async function startDflashDraftDownload(offer: DflashDraftOffer): Promise<string[]> {
  return invoke<string[]>("start_quant_download", {
    hfModelId: offer.hfModelId,
    hfAuthor: offer.hfAuthor,
    quantType: offer.quantType,
    ggufFile: offer.file,
  });
}

export function describeMainForDflashPick(main: ModelEntry): string {
  const family = familyLabel(extractModelFamily(main));
  const size = extractParamBillions(mainIdentityHay(main));
  const name = main.name || main.hfMeta?.repoName || "selected model";
  const sizeBit = size != null ? ` · ~${size % 1 === 0 ? size : size}B` : "";
  return `${name} (${family}${sizeBit})`;
}
