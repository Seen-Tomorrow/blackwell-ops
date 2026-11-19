/**
 * DFlash / MTP draft heads — the small surface the LOADOUT picker still needs.
 *
 * The picker used to live here too: an HF-wide repo search, a scorer, a candidate cache
 * and a quant picker that guessed by size. That path was replaced by the Model Hub's own
 * repo listing (`repo_draft_files` / `repo_companions_for`), which shows a repo's role-
 * classified files exactly as downloaded. What remains is the offer shape the confirm
 * path consumes, the download enqueue, and the "could this model use a draft?" test.
 */

import { invoke } from "@tauri-apps/api/core";
import type { GgufFile, ModelEntry } from "./types";
import { extractModelFamily, isExternalDraftOnly } from "./specDraft";

export interface DflashDraftOffer {
  hfModelId: string;
  hfAuthor: string;
  quantType: string;
  file: GgufFile;
  sizeBytes: number;
  /** Short UI label, e.g. "org/repo · Q4_K_M · 1.8 GB" */
  label: string;
  /** Match confidence 0–100 (percentage); 0 for a row taken straight from a listing. */
  score: number;
  /** Facing notes (family / size / author), or "repo listing" for a listed row. */
  matchNotes: string[];
  downloads: number;
}

/** Families known to accept a speculator head. Soft signal: the name test below is the */
/** fallback for anything the family table does not know. */
const DFLASH_FAMILY_HINTS = new Set([
  "qwen3",
  "qwen38",
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

function mainIdentityHay(main: ModelEntry): string {
  return [
    main.name,
    main.path,
    main.hfModelId,
    main.hfMeta?.hfModelId,
    main.hfMeta?.repoName,
    main.metadata?.general_name,
    main.metadata?.general_basename,
  ]
    .filter(Boolean)
    .join(" ");
}

export function mainMaySupportDflash(main: ModelEntry | null | undefined): boolean {
  if (!main || isExternalDraftOnly(main)) return false;
  const family = extractModelFamily(main);
  if (family && DFLASH_FAMILY_HINTS.has(family)) return true;
  const hay = mainIdentityHay(main);
  return /qwen|gemma|llama|mistral|deepseek/i.test(hay);
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
