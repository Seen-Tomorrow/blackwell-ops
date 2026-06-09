import { useMemo, type ReactNode } from "react";
import AnsiText from "./AnsiText";
import { parseLogSearchTerms } from "../lib/logSearch";

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

function mergeRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a[0] - b[0]);
  const merged: Array<[number, number]> = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    const cur = sorted[i];
    if (cur[0] <= last[1]) {
      last[1] = Math.max(last[1], cur[1]);
    } else {
      merged.push(cur);
    }
  }
  return merged;
}

function findHighlightRanges(text: string, terms: string[]): Array<[number, number]> {
  const lower = text.toLowerCase();
  const ranges: Array<[number, number]> = [];

  for (const term of terms) {
    const qLower = term.toLowerCase();
    let idx = lower.indexOf(qLower);
    while (idx !== -1) {
      ranges.push([idx, idx + term.length]);
      idx = lower.indexOf(qLower, idx + term.length);
    }
  }

  return mergeRanges(ranges);
}

function highlightPlainText(text: string, terms: string[]): ReactNode[] {
  if (terms.length === 0) return [text];

  const ranges = findHighlightRanges(text, terms);
  if (ranges.length === 0) return [text];

  const nodes: ReactNode[] = [];
  let cursor = 0;
  let key = 0;

  for (const [start, end] of ranges) {
    if (start > cursor) nodes.push(text.slice(cursor, start));
    nodes.push(
      <mark key={key++} className="log-search-hit">
        {text.slice(start, end)}
      </mark>,
    );
    cursor = end;
  }

  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}

interface LogLineTextProps {
  text: string;
  highlightQuery?: string;
  ansiEnabled?: boolean;
}

/** Log line with optional multi-term highlight; ANSI rendering is toggleable. */
export default function LogLineText({
  text,
  highlightQuery,
  ansiEnabled = true,
}: LogLineTextProps) {
  const terms = useMemo(
    () => parseLogSearchTerms(highlightQuery ?? ""),
    [highlightQuery],
  );
  const plainText = useMemo(() => stripNonSgr(text), [text]);

  const highlighted = useMemo(() => {
    if (terms.length === 0) return null;
    return highlightPlainText(plainText, terms);
  }, [plainText, terms]);

  if (terms.length > 0) {
    return (
      <span className="inline" style={{ overflowWrap: "break-word" }}>
        {highlighted}
      </span>
    );
  }

  if (ansiEnabled) {
    return <AnsiText text={text} />;
  }

  return (
    <span className="inline" style={{ overflowWrap: "break-word" }}>
      {plainText}
    </span>
  );
}