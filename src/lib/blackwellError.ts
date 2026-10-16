/**
 * Helpers for reading the typed backend error enum (`src-tauri/src/errors.rs`).
 *
 * A failed `invoke()` rejects with the serialized `BlackwellError` — a plain object
 * carrying a stable `kind` discriminant. Read `kind` with `errorKind` and branch on it;
 * never substring-match the human-readable `message`, which is display text only.
 */
export type BlackwellErrorKind =
  | "binary_not_found"
  | "binary_validation_failed"
  | "port_out_of_range"
  | "port_conflict"
  | "no_free_slot"
  | "engine_state_busy"
  | "alias_exhausted"
  | "engine_spawn_failed"
  | "fit_probe_skipped"
  | "fit_binary_missing"
  | "fit_binary_mismatch"
  | "fit_probe_timeout"
  | "fit_probe_failed";

/** Stable discriminant of a rejected `invoke()`, or null when the error is not typed. */
export function errorKind(e: unknown): BlackwellErrorKind | null {
  if (e == null || typeof e !== "object") return null;
  const kind = (e as { kind?: unknown }).kind;
  return typeof kind === "string" ? (kind as BlackwellErrorKind) : null;
}

/** Human-readable text for display — the `message` field, else the raw error stringified. */
export function errorMessage(e: unknown): string {
  if (e == null) return "";
  if (typeof e === "string") return e;
  if (typeof e === "object") {
    const message = (e as { message?: unknown }).message;
    if (typeof message === "string") return message;
  }
  return String(e);
}
