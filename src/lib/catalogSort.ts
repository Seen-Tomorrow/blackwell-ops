/**
 * Catalog list order — one rule, used by the hook that renders the list.
 *
 * Size is compared in BYTES, never by the rendered number: `size_str` is
 * "754MB" below a gigabyte and "46.2GB" above it (Rust `calc_size_str_from_bytes`),
 * so stripping the unit ranked a 754 MB model above a 46 GB one.
 */
import type { ModelEntry } from "./types";
import { modelSizeBytes } from "./modelSize";

export type SortField = (keyof ModelEntry) | "date" | "type";
export type SortDirection = "asc" | "desc";

/**
 * Direction a field takes on first click. Size and date are read as "what is on
 * screen now" (BIGGEST / NEWEST), so their useful end comes first; author stays
 * A→Z.
 */
export const SORT_FIRST_DIRECTION: Partial<Record<SortField, SortDirection>> = {
  size_str: "desc",
  date: "desc",
};

/**
 * Compare two catalog entries for the given field.
 *
 * A model with no value sorts LAST in both directions — unscanned is not "the
 * biggest" and no creation date is not "the oldest".
 */
export function compareCatalogModels(
  a: ModelEntry,
  b: ModelEntry,
  field: SortField,
  direction: SortDirection,
): number {
  let comparison = 0;

  if (field === "type") {
    // Companion kinds in one order, so a long extras list groups by role instead of
    // interleaving drafts and projectors.
    comparison = roleRank(a) - roleRank(b);
    if (comparison === 0) comparison = (a.name ?? "").localeCompare(b.name ?? "");
  } else if (field === "date") {
    const aDate = a.metadata?.file_created ?? 0;
    const bDate = b.metadata?.file_created ?? 0;
    if ((aDate === 0) !== (bDate === 0)) return aDate === 0 ? 1 : -1;
    comparison = aDate - bDate;
  } else if (field === "size_str") {
    const aBytes = modelSizeBytes(a);
    const bBytes = modelSizeBytes(b);
    if (aBytes === null || bBytes === null) {
      if (aBytes === bBytes) return 0;
      return aBytes === null ? 1 : -1;
    }
    comparison = aBytes - bBytes;
  } else {
    const aVal = a[field];
    const bVal = b[field];
    if (typeof aVal === "string" && typeof bVal === "string") {
      comparison = aVal.localeCompare(bVal);
    } else if (typeof aVal === "boolean" && typeof bVal === "boolean") {
      comparison = Number(aVal) - Number(bVal);
    }
  }

  return direction === "asc" ? comparison : -comparison;
}
/** Grouping order for the TYPE sort: heads, tables, projectors, adapters, then rest. */
function roleRank(model: ModelEntry): number {
  switch (model.fileRole) {
    case "draft":
      return 0;
    case "ple":
      return 1;
    case "mmproj":
      return 2;
    case "adapter":
      return 3;
    case "model":
      return 4;
    default:
      return 5;
  }
}