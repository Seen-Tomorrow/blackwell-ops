/** User-facing bench failure line — error text is formatted in Rust (`bench_cancel`). */
export function benchFailureLine(phase: "tg" | "pp", error?: string | null): string {
  const label = phase === "tg" ? "Generation bench failed" : "Prefill bench failed";
  const detail = error?.trim() || "unknown";
  return `${label}: ${detail}`;
}