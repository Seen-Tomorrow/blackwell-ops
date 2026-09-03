import type { ReactNode } from "react";

/** Repair common UTF-8-as-Latin-1 mojibake from GitHub / gh CLI on Windows. */
export function fixUtf8Mojibake(text: string): string {
  return text
    .replace(/â€"/g, "—")
    .replace(/â€™/g, "'")
    .replace(/â€œ/g, '"')
    .replace(/â€\u009d/g, '"')
    .replace(/â€¦/g, "…")
    .replace(/â€¢/g, "•")
    .replace(/â†'/g, "→");
}

function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const parts: ReactNode[] = [];
  const re = /\*\*([^*]+)\*\*|`([^`]+)`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) {
      parts.push(text.slice(last, m.index));
    }
    if (m[1]) {
      parts.push(
        <strong key={`${keyPrefix}-b-${i}`} className="text-white/75 font-semibold">
          {m[1]}
        </strong>,
      );
    } else if (m[2]) {
      parts.push(
        <code
          key={`${keyPrefix}-c-${i}`}
          className="notes-code type-label px-0.5 rounded-sm"
        >
          {m[2]}
        </code>,
      );
    }
    last = m.index + m[0].length;
    i += 1;
  }
  if (last < text.length) {
    parts.push(text.slice(last));
  }
  return parts.length > 0 ? parts : [text];
}

/** Lightweight markdown-ish renderer for GitHub release bodies. */
export function ReleaseNotesBody({ text, className = "" }: { text: string; className?: string }) {
  const normalized = fixUtf8Mojibake(text.trim());
  if (!normalized) return null;

  const lines = normalized.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let listItems: string[] = [];
  let blockIdx = 0;

  const flushList = () => {
    if (listItems.length === 0) return;
    blocks.push(
      <ul
        key={`list-${blockIdx++}`}
        className="notes-list list-disc list-outside ml-4 space-y-1 type-label font-mono config-muted leading-relaxed"
      >
        {listItems.map((item, li) => (
          <li key={li}>{renderInline(item, `li-${li}`)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (!trimmed) {
      flushList();
      continue;
    }

    if (trimmed.startsWith("### ")) {
      flushList();
      blocks.push(
        <h4
          key={`h-${blockIdx++}`}
          className="notes-heading type-body font-mono tracking-wider mt-2 first:mt-0"
        >
          {trimmed.slice(4)}
        </h4>,
      );
      continue;
    }

    if (trimmed.startsWith("## ")) {
      flushList();
      blocks.push(
        <h3
          key={`h2-${blockIdx++}`}
          className="notes-heading type-body font-mono tracking-widest mt-2 first:mt-0"
        >
          {trimmed.slice(3)}
        </h3>,
      );
      continue;
    }

    if (trimmed.startsWith(">")) {
      flushList();
      blocks.push(
        <blockquote
          key={`q-${blockIdx++}`}
        className="notes-quote border-l-2 pl-2.5 type-label font-mono leading-relaxed"
        >
          {renderInline(trimmed.replace(/^>\s?/, ""), `q-${i}`)}
        </blockquote>,
      );
      continue;
    }

    if (/^[-*]\s+/.test(trimmed)) {
      listItems.push(trimmed.replace(/^[-*]\s+/, ""));
      continue;
    }

    flushList();
    blocks.push(
      <p key={`p-${blockIdx++}`} className="notes-para type-label font-mono config-muted leading-relaxed">
        {renderInline(trimmed, `p-${i}`)}
      </p>,
    );
  }
  flushList();

  return <div className={`space-y-1.5 ${className}`.trim()}>{blocks}</div>;
}