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