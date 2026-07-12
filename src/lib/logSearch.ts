const LOG_SEARCH_STRIP_RE = [
  /\x1b\].*?\x07/g,
  /\x1b\[[?0-9;]*[A-HJ-Kf]/g,
  /\x1b\[\?[0-9;]*[hl]/g,
];

/** Plain text for ENGINE LOGS search — strips cursor/OSC ANSI, keeps SGR for display elsewhere. */
export function stripLogLineForSearch(text: string): string {
  let result = text;
  for (const re of LOG_SEARCH_STRIP_RE) {
    result = result.replace(re, "");
  }
  return result;
}

/** Split ENGINE LOGS highlight input into terms (comma, semicolon, or pipe). */
export function parseLogSearchTerms(query: string): string[] {
  const trimmed = query.trim();
  if (!trimmed) return [];

  const hasDelimiter = /[,|;]/.test(trimmed);
  if (!hasDelimiter) return [trimmed];

  const terms = trimmed
    .split(/[,|;]+/)
    .map((part) => part.trim())
    .filter(Boolean);

  return terms.length > 0 ? terms : [trimmed];
}

export function logLineMatchesSearch(text: string, query: string): boolean {
  const terms = parseLogSearchTerms(query);
  if (terms.length === 0) return false;
  const plain = stripLogLineForSearch(text).toLowerCase();
  return terms.some((term) => plain.includes(term.toLowerCase()));
}