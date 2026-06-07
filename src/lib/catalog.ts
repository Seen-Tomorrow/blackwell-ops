// Types and helpers for the live llama-server --help catalog.

import type { UserEditedTemplateParam } from "./types";

/** Raw catalog entry from Rust `get_llama_catalog` command (`includeAll` when power-user unlocked). */
export interface RawCatalogEntry {
  flag: string;
  short?: string;
  alternates?: string[];
  key: string;
  label: string;
  ptype: string;
  default_value?: string | number | boolean | null;
  values?: (string | number | boolean)[];
  presets?: (string | number | boolean)[];
  description: string;
  env_var?: string;
}

/**
 * Normalize a raw catalog entry into a UserEditedTemplateParam ready for addition.
 * Assigns "USER-ADDED-FROM-CATALOG" ui_group.
 */
export function catalogEntryToParam(
  entry: RawCatalogEntry,
  existingParams: UserEditedTemplateParam[],
  maxOrder: number,
): Omit<UserEditedTemplateParam, "order"> {
  // Use values from catalog entry
  let values: (string | number)[] = [];
  if (entry.values && entry.values.length > 0) {
    values = entry.values.filter((v): v is string | number => typeof v === "string" || typeof v === "number");
  }

  // For switch types, ensure true/false are present as strings
  if (entry.ptype === "switch_onoff" || entry.ptype === "switch_inverted") {
    if (!values.includes("on")) values.push("on");
    if (!values.includes("off")) values.push("off");
  }

  // Use first value as default, or default_value from catalog
  const defaultValue = entry.default_value
    ? (typeof entry.default_value === "string" || typeof entry.default_value === "number"
      ? entry.default_value
      : undefined)
    : (values.length > 0 ? values[0] : undefined);

  // Check if key already exists — if so, we skip addition
  const exists = existingParams.some((p) => p.key === entry.key);
  if (exists) {
    // Still return the param but caller should handle
  }

  return {
    key: entry.key,
    label: entry.label,
    values,
    hidden: false,
    flag: entry.flag,
    ptype: entry.ptype as UserEditedTemplateParam["ptype"],
    ui_group: "USER-ADDED-FROM-CATALOG",
    note: entry.description || "",
    defaultValue,
    factoryDefault: defaultValue,
    dock: undefined,
  };
}

/** Check if a param key already exists in the current provider's params. */
export function isKeyActive(key: string, existingParams: UserEditedTemplateParam[]): boolean {
  return existingParams.some((p) => p.key === key);
}

/** Fulltext search: score entries by query relevance. */
export function searchCatalog(
  entries: RawCatalogEntry[],
  query: string,
): RawCatalogEntry[] {
  if (!query.trim()) return entries;

  const q = query.toLowerCase().trim();
  const words = q.split(/\s+/).filter(Boolean);

  return entries
    .map((entry) => {
      const searchable = [
        entry.flag,
        entry.short || "",
        entry.key,
        entry.label,
        entry.description,
        entry.env_var || "",
        ...(entry.alternates || []),
      ].join(" ");

      const searchableLower = searchable.toLowerCase();

      // Score: exact flag/key match = 100, label match = 50, description = 10
      let score = 0;
      for (const word of words) {
        if (entry.key.toLowerCase() === word || entry.flag.toLowerCase().includes(word)) {
          score += 100;
        }
        if (entry.label.toLowerCase().includes(word)) {
          score += 50;
        }
        if (searchableLower.includes(word)) {
          score += 10;
        }
      }

      return { entry, score };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score)
    .map(({ entry }) => entry);
}
