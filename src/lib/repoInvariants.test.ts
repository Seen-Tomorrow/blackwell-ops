import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { TextDecoder } from "node:util";
import { describe, expect, it } from "vitest";

/**
 * Repo-wide invariants — relationships that must hold no matter how the product
 * changes, so none of them need editing when UI text, themes, or layout move.
 *
 * These live in the frontend suite on purpose: `npm test` runs in ~3 s and is the
 * first thing `majestic ship` gates on, so a violation blocks a release without
 * anyone having to remember to run a separate lint.
 */

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".mjs", ".cjs", ".rs", ".css", ".md", ".json",
  ".ps1", ".nsi", ".nsh", ".yml", ".yaml", ".toml", ".html", ".txt", ".py",
  ".bat", ".cmd", ".lock",
]);

/**
 * UTF-8 bytes decoded as CP1252. Each entry is what a real character turns into:
 * `â€` is an em/en dash or smart quote, `Ã©` is é, `Â°` is a degree sign.
 * An explicit list rather than a broad class so the test cannot fire on legitimate
 * accented text.
 */
const MOJIBAKE_SIGNATURES = [
  "\u00E2\u20AC", // â€  em/en dash, single and double quotes, bullet, ellipsis, arrow
  "\u00E2\u0080", // â€  remaining CP1252 continuations of the same family
  "\u00C3\u00A9", "\u00C3\u00A8", "\u00C3\u00A4", "\u00C3\u00B6", "\u00C3\u00BC", // é è ä ö ü
  "\u00C3\u00A1", "\u00C3\u00B3", "\u00C3\u00BA", // á ó ú
  "\u00C2\u00A0", "\u00C2\u00B0", "\u00C2\u00A9", // nbsp, degree, copyright
];

/**
 * `releaseNotes.tsx` holds these sequences deliberately: it is the runtime
 * sanitizer that repairs mojibake arriving in GitHub release notes. Excluding the
 * fix from the test that forbids the bug is the whole point.
 */
const MOJIBAKE_ALLOWLIST = new Set(["src/lib/releaseNotes.tsx"]);

function trackedTextFiles(): string[] {
  const listing = execFileSync("git", ["ls-files", "-z"], { encoding: "buffer" });
  return listing
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0)
    .filter((path) => TEXT_EXTENSIONS.has(`.${path.slice(path.lastIndexOf(".") + 1).toLowerCase()}`));
}

describe("repo invariants", () => {
  it("every tracked text file is valid UTF-8 with no CP1252 mojibake", () => {
    const strict = new TextDecoder("utf-8", { fatal: true });
    const forgiving = new TextDecoder("utf-8");
    const undecodable: string[] = [];
    const corrupted: string[] = [];

    for (const path of trackedTextFiles()) {
      if (MOJIBAKE_ALLOWLIST.has(path.replace(/\\/g, "/"))) continue;
      const bytes = readFileSync(path);
      let text: string;
      try {
        text = strict.decode(bytes);
      } catch {
        undecodable.push(path);
        text = forgiving.decode(bytes);
      }
      const signature = MOJIBAKE_SIGNATURES.find((s) => text.includes(s));
      if (signature) corrupted.push(`${path} (contains ${JSON.stringify(signature)})`);
    }

    expect(undecodable, `not valid UTF-8:\n${undecodable.join("\n")}`).toEqual([]);
    expect(corrupted, `CP1252 mojibake:\n${corrupted.join("\n")}`).toEqual([]);
  });

  /**
   * `Instant::now() - Duration` panics with "overflow when subtracting duration
   * from instant" whenever uptime is shorter than the subtracted window. REL is
   * built with `panic = "abort"`, so that panic is an instant process death —
   * documented in AGENTS.md as the blink-close-after-reboot (`0xC0000409`) bug.
   * Only `saturating_sub` / `checked_sub` are safe.
   *
   * Everything from a `#[cfg(test)]` marker to end of file is skipped: fixtures
   * legitimately backdate an Instant, and a panic there fails a test rather than
   * a user's app.
   */
  it("no Rust code subtracts from an Instant without saturating or checked math", () => {
    const unsafe = /Instant::now\(\)\s*-|\bnow\s*-\s*Duration::/;
    const violations: string[] = [];

    for (const path of trackedTextFiles()) {
      if (!path.endsWith(".rs") || !path.startsWith("src-tauri")) continue;
      const lines: string[] = readFileSync(path, "utf8").split(/\r?\n/);
      for (let i = 0; i < lines.length; i += 1) {
        if (lines[i].includes("#[cfg(test)]")) break;
        const line = lines[i];
        if (line.trimStart().startsWith("//")) continue;
        if (unsafe.test(line) && !/saturating_sub|checked_sub/.test(line)) {
          violations.push(`${path}:${i + 1}: ${line.trim()}`);
        }
      }
    }

    expect(violations, `bare Instant subtraction:\n${violations.join("\n")}`).toEqual([]);
  });
});
