/**
 * Full Auto — resolve DFlash draft candidates on HF for user confirmation.
 * Never auto-starts a download; Joe always picks from the candidate list.
 */

import { invoke } from "@tauri-apps/api/core";
import type { GgufFile, HfModel, HfModelInfo, HfSearchResponse, ModelEntry } from "./types";
import {
  extractModelFamily,
  isExternalDraftOnly,
  signalContainsDflash,
} from "./specDraft";

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
  /** Ranking score (higher = better match). */
  score: number;
  /** Joe-facing match notes (family / size / author). */
  matchNotes: string[];
  downloads: number;
}

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

function repoLooksLikeDflash(m: HfModel): boolean {
  const id = m.id || "";
  if (signalContainsDflash(id)) return true;
  if ((m.tags || []).some((t) => signalContainsDflash(t))) return true;
  return (m.gguf_files || []).some((f) => signalContainsDflash(f.type) || signalContainsDflash(f.url));
}

interface ScoredRepo {
  model: HfModel;
  score: number;
  notes: string[];
}

function scoreDflashRepo(m: HfModel, main: ModelEntry): ScoredRepo | null {
  if (!repoLooksLikeDflash(m)) return null;
  const idLower = m.id.toLowerCase();
  if (idLower.includes("mtp") && !signalContainsDflash(m.id)) return null;

  const mainFamily = extractModelFamily(main);
  const candFamily = familyFromHay(m.id);
  const mainSize = extractParamBillions(mainIdentityHay(main));
  const candSize = extractParamBillions(m.id);
  const notes: string[] = [];

  // Hard gates: wrong specific family or wrong param count.
  if (mainFamily && candFamily && mainFamily !== candFamily) {
    // qwen3 (generic) may still match qwen35/36 packs — only soft-penalize later
    const mainSpecific = mainFamily !== "qwen3" && mainFamily !== "qwen2" && mainFamily !== "gemma" && mainFamily !== "llama";
    const candSpecific = candFamily !== "qwen3" && candFamily !== "qwen2" && candFamily !== "gemma" && candFamily !== "llama";
    if (mainSpecific && candSpecific) {
      return null;
    }
  }
  if (mainSize != null && candSize != null && !sizesClose(mainSize, candSize)) {
    return null;
  }

  let score = Math.min(m.downloads || 0, 2_000_000) / 5000; // weak popularity tie-break only
  if (signalContainsDflash(m.id)) {
    score += 2_000;
    notes.push("DFlash pack");
  }
  if (idLower.includes("gguf")) score += 50;

  if (mainFamily && candFamily) {
    if (mainFamily === candFamily) {
      score += 8_000;
      notes.push(`family ${familyLabel(mainFamily)}`);
    } else if (mainFamily === "qwen3" && (candFamily === "qwen35" || candFamily === "qwen36")) {
      score += 1_500;
      notes.push(`family ${familyLabel(candFamily)} (generic Qwen3 main)`);
    } else {
      score -= 3_000;
      notes.push(`family soft-miss ${familyLabel(candFamily)}`);
    }
  } else if (mainFamily && !candFamily) {
    score -= 500;
    notes.push("family unclear on HF id");
  }

  if (mainSize != null && candSize != null) {
    if (sizesClose(mainSize, candSize)) {
      score += 6_000;
      notes.push(`${candSize}B params`);
    }
  } else if (mainSize != null && candSize == null) {
    score -= 1_500;
    notes.push("param size not in repo name");
  } else if (mainSize == null && candSize != null) {
    notes.push(`draft lists ${candSize}B`);
  }

  const author = (main.hfMeta?.author || main.author || "").toLowerCase();
  if (author && m.author?.toLowerCase() === author) {
    score += 400;
    notes.push("same author");
  }

  // Prefer drafts that are actually small (true draft packs).
  const smallest = (m.gguf_files || [])
    .map((f) => f.size_bytes)
    .filter((n) => n > 0)
    .sort((a, b) => a - b)[0];
  if (smallest != null && smallest < 8 * 1024 * 1024 * 1024) score += 80;

  return { model: m, score, notes };
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
  const usable = files.filter((f) => f.url?.trim() && f.size_bytes > 0);
  if (!usable.length) return null;

  const mq = (main.quant || main.metadata?.file_type_str || "").toLowerCase().trim();
  const prefs = mq ? [mq, ...QUANT_PREF] : QUANT_PREF;

  for (const p of prefs) {
    const hit = usable.find((f) => {
      const t = f.type.toLowerCase();
      return t === p || t.includes(p);
    });
    if (hit) return hit;
  }

  const sorted = [...usable].sort((a, b) => a.size_bytes - b.size_bytes);
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
 * Always returns a list for user confirmation — never auto-downloads.
 */
export async function findDflashDraftCandidates(
  main: ModelEntry,
  limit = 3,
): Promise<DflashDraftOffer[]> {
  const queries = dflashSearchQueries(main);
  const byId = new Map<string, ScoredRepo>();

  for (const query of queries) {
    try {
      const resp = await invoke<HfSearchResponse>("search_hf_models", {
        query,
        vramLimitGb: undefined,
        sort: "downloads",
        limit: 40,
      });
      for (const m of resp.models || []) {
        const scored = scoreDflashRepo(m, main);
        if (!scored) continue;
        const prev = byId.get(m.id);
        if (!prev || scored.score > prev.score) {
          byId.set(m.id, scored);
        }
      }
    } catch (err) {
      console.warn("[dflashGetDraft] search failed:", query, err);
    }
  }

  const ranked = [...byId.values()].sort((a, b) => b.score - a.score).slice(0, Math.max(1, limit));
  if (ranked.length === 0) return [];

  const offers: DflashDraftOffer[] = [];
  for (const row of ranked) {
    let files = row.model.gguf_files || [];
    try {
      const info = await invoke<HfModelInfo>("get_hf_model_info", { modelId: row.model.id });
      if (info.gguf_files?.length) files = info.gguf_files;
    } catch (err) {
      console.warn("[dflashGetDraft] get_hf_model_info failed:", row.model.id, err);
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
