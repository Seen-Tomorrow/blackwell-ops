/**
 * Model size labels ⇄ bytes — the one conversion both the catalog sort and the
 * metadata scan order use.
 *
 * `size_str` comes from the Rust catalog (`calc_size_str_from_bytes`): "754MB"
 * below a gigabyte, "46.2GB" above it, both 1024-based. Sorting on the number
 * alone therefore ranked a 754 MB model above a 46 GB one, so the unit has to
 * be converted rather than stripped.
 */

const SIZE_UNITS: Record<string, number> = {
  b: 1,
  k: 1024,
  kb: 1024,
  kib: 1024,
  m: 1024 ** 2,
  mb: 1024 ** 2,
  mib: 1024 ** 2,
  g: 1024 ** 3,
  gb: 1024 ** 3,
  gib: 1024 ** 3,
  t: 1024 ** 4,
  tb: 1024 ** 4,
  tib: 1024 ** 4,
};

/** `"46.2GB"` / `"754 MB"` → bytes; `null` when the label carries no usable size. */
export function sizeLabelBytes(label: string | null | undefined): number | null {
  if (!label) return null;
  const match = label.trim().match(/^(\d+(?:\.\d+)?)\s*([a-zA-Z]+)$/);
  if (!match) return null;
  const value = Number.parseFloat(match[1]);
  const unit = SIZE_UNITS[match[2].toLowerCase()];
  if (!Number.isFinite(value) || unit == null) return null;
  return value * unit;
}

/**
 * Bytes a catalog card shows for this model. The displayed label wins; the
 * probed file size is the fallback for entries whose label never got rendered.
 */
export function modelSizeBytes(model: {
  size_str?: string;
  metadata?: { file_size_bytes?: number } | null;
}): number | null {
  const fromLabel = sizeLabelBytes(model.size_str);
  if (fromLabel != null) return fromLabel;
  const bytes = model.metadata?.file_size_bytes;
  return typeof bytes === "number" && bytes > 0 ? bytes : null;
}
