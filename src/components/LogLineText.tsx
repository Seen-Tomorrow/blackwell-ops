import { useMemo, type ReactNode } from "react";
import AnsiText from "./AnsiText";

const NON_SGR_RE = [
  /\x1b\].*?\x07/g,
  /\x1b\[[?0-9;]*[A-HJ-Kf]/g,
  /\x1b\[\?[0-9;]*[hl]/g,
];

function stripNonSgr(text: string): string {
  let result = text;
  for (const re of NON_SGR_RE) {
    result = result.replace(re, "");
  }
  return result;
}

function highlightPlainText(text: string, query: string): ReactNode[] {
  const q = query.trim();
  if (!q) return [text];

  const lower = text.toLowerCase();
  const qLower = q.toLowerCase();
  const nodes: ReactNode[] = [];
  let start = 0;
  let key = 0;
  let idx = lower.indexOf(qLower, start);

  while (idx !== -1) {
    if (idx > start) nodes.push(text.slice(start, idx));
    nodes.push(
      <mark key={key++} className="log-search-hit">
        {text.slice(idx, idx + q.length)}
      </mark>,
    );
    start = idx + q.length;
    idx = lower.indexOf(qLower, start);
  }

  if (start < text.length) nodes.push(text.slice(start));
  return nodes.length > 0 ? nodes : [text];
}

interface LogLineTextProps {
  text: string;
  highlightQuery?: string;
}

/** Log line with optional case-insensitive amber highlight (plain text mode when searching). */
export default function LogLineText({ text, highlightQuery }: LogLineTextProps) {
  const query = highlightQuery?.trim() ?? "";

  const highlighted = useMemo(() => {
    if (!query) return null;
    return highlightPlainText(stripNonSgr(text), query);
  }, [text, query]);

  if (!query) {
    return <AnsiText text={text} />;
  }

  return (
    <span className="inline" style={{ overflowWrap: "break-word" }}>
      {highlighted}
    </span>
  );
}