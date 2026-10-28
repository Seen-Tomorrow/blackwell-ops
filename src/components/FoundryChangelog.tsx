import { Fragment, type ReactNode } from "react";
import { open } from "@tauri-apps/plugin-shell";
import type { FoundryChangelog } from "../lib/types";

function openExternal(url: string): void {
  if (!/^https?:\/\//i.test(url)) return;
  void open(url).catch(() => { /* best effort — the URL is still visible as text */ });
}

/** Inline Markdown: links, bold, inline code. Everything else stays text. */
function renderInline(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const re = /(\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))|(\*\*([^*]+)\*\*)|(`([^`]+)`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) {
      nodes.push(text.slice(last, match.index));
    }
    if (match[1]) {
      const label = match[2];
      const url = match[3];
      nodes.push(
        <button
          key={`link-${key++}`}
          type="button"
          className="fnd-changelog__link"
          onClick={() => openExternal(url)}
          title={url}
        >
          {label}
        </button>,
      );
    } else if (match[4]) {
      nodes.push(<strong key={`bold-${key++}`}>{match[5]}</strong>);
    } else if (match[6]) {
      nodes.push(<code key={`code-${key++}`}>{match[7]}</code>);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Small, safe Markdown reader for GitHub release notes (no raw HTML). */
function renderMarkdown(markdown: string): ReactNode[] {
  const source = markdown.replace(/<!--[\s\S]*?-->/g, "");
  const lines = source.split(/\r?\n/);
  const blocks: ReactNode[] = [];
  let paragraph: string[] = [];
  let list: string[] = [];
  let ordered = false;
  let code: string[] = [];
  let inCode = false;
  let key = 0;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const pKey = key++;
    blocks.push(
      <p key={`p-${pKey}`}>
        {paragraph.map((line, index) => (
          <Fragment key={`p-${pKey}-${index}`}>
            {index > 0 && <br />}
            {renderInline(line)}
          </Fragment>
        ))}
      </p>,
    );
    paragraph = [];
  };
  const flushList = () => {
    if (list.length === 0) return;
    const items = list.map((item, index) => (
      <li key={`li-${key++}-${index}`}>{renderInline(item)}</li>
    ));
    blocks.push(ordered
      ? <ol key={`ol-${key++}`}>{items}</ol>
      : <ul key={`ul-${key++}`}>{items}</ul>);
    list = [];
  };
  const flushCode = () => {
    if (code.length === 0) return;
    blocks.push(<pre key={`pre-${key++}`} className="fnd-changelog__code">{code.join("\n")}</pre>);
    code = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    if (line.trimStart().startsWith("```")) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        flushAll();
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (!line.trim()) {
      flushAll();
      continue;
    }
    // Setext headings: "Assets" / "Changelog since v0.7.0" underlined with --- or ===.
    // GitHub release bodies use these heavily after the intro sections; without this
    // they collapse into ordinary paragraphs.
    const next = lines[i + 1]?.trim() ?? "";
    if (/^=+$/.test(next) || /^-{2,}$/.test(next)) {
      flushAll();
      blocks.push(
        <h3 key={`h-${key++}`} className="fnd-changelog__heading">
          {renderInline(line.trim())}
        </h3>,
      );
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      flushAll();
      const Tag = heading[1].length <= 2 ? "h3" : "h4";
      blocks.push(
        <Tag key={`h-${key++}`} className="fnd-changelog__heading">
          {renderInline(heading[2])}
        </Tag>,
      );
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      flushParagraph();
      if (list.length > 0 && ordered) flushList();
      ordered = false;
      list.push(line.replace(/^\s*[-*]\s+/, ""));
      continue;
    }
    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      flushParagraph();
      if (list.length > 0 && !ordered) flushList();
      ordered = true;
      list.push(numbered[1]);
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      flushAll();
      blocks.push(
        <blockquote key={`q-${key++}`} className="fnd-changelog__quote">
          {renderInline(line.replace(/^\s*>\s?/, ""))}
        </blockquote>,
      );
      continue;
    }
    if (/^\s*---+\s*$/.test(line)) {
      flushAll();
      blocks.push(<hr key={`hr-${key++}`} className="fnd-changelog__rule" />);
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  if (inCode) flushCode();
  flushAll();
  return blocks;
}

/**
 * In-app reader for the upstream release notes. Links open in the system browser.
 * The panel is inline on the FOUNDRY page — no modal.
 */
export default function FoundryChangelogPane({ changelog }: { changelog: FoundryChangelog }) {
  const parsed = changelog.publishedAt ? new Date(changelog.publishedAt) : null;
  const published = parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      })
    : "";
  return (
    <div className="fnd-changelog">
      <div className="fnd-changelog__head">
        <div className="fnd-changelog__title">
          <span className="fnd-changelog__tag">{changelog.tag}</span>
          {changelog.name && changelog.name !== changelog.tag && (
            <span className="fnd-changelog__name">{changelog.name}</span>
          )}
          {published && <span className="fnd-changelog__date">{published}</span>}
        </div>
        <button
          type="button"
          className="fnd-changelog__open"
          onClick={() => openExternal(changelog.htmlUrl)}
        >
          OPEN ON GITHUB ↗
        </button>
      </div>
      <div className="fnd-changelog__body">
        {changelog.body.trim()
          ? renderMarkdown(changelog.body)
          : <p className="fnd-changelog__empty">This release has no notes.</p>}
      </div>
    </div>
  );
}
