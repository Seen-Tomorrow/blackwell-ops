/**
 * Shared Blackwell Output Console vocabulary.
 *
 * Kept outside the component so the header, actions, footer dock and the console
 * itself can import it without a circular component module graph.
 */

export const OUTPUT_CONSOLE_CATEGORIES = [
  "engines",
  "utils",
  "foundry",
  "error",
  "scenarios",
  "debug",
] as const;

export type OutputConsoleCategory = (typeof OUTPUT_CONSOLE_CATEGORIES)[number];

export function parseOutputConsoleCategory(value: string): OutputConsoleCategory | null {
  const lower = value.toLowerCase();
  return (OUTPUT_CONSOLE_CATEGORIES as readonly string[]).includes(lower)
    ? (lower as OutputConsoleCategory)
    : null;
}

export const OUTPUT_CONSOLE_CATEGORY_LABELS: Record<OutputConsoleCategory, string> = {
  engines: "Engines",
  utils: "Utils",
  foundry: "Foundry",
  error: "Error",
  scenarios: "Scenarios",
  debug: "Debug",
};

/** RFC3339 or legacy ISO strings → local HH:MM:SS.mmm for display. */
export function formatConsoleTimestamp(timestamp: string): string {
  const parsed = new Date(timestamp);
  if (!Number.isNaN(parsed.getTime())) {
    const h = String(parsed.getHours()).padStart(2, "0");
    const m = String(parsed.getMinutes()).padStart(2, "0");
    const s = String(parsed.getSeconds()).padStart(2, "0");
    const ms = String(parsed.getMilliseconds()).padStart(3, "0");
    return `${h}:${m}:${s}.${ms}`;
  }
  if (timestamp.length >= 23) return timestamp.slice(11, 23);
  return timestamp;
}
