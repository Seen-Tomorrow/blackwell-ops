#!/usr/bin/env python3
r"""Utility-name hook audit — the second law meter.

CSS in this repo repairs bad Tailwind palette colors by matching the LITERAL utility
name inside a container, e.g.

    [data-config-page] .text-yellow-400\/70 { color: var(--theme-secondary-bright) !important; }
    .phosphor-screen-inner .text-stealth-muted\/45 { color: var(--display-face-control-text) !important; }

Delete the utility from TSX and the correction silently stops applying — the element
loses its container-corrected color and nobody gets an error.

Usage:
    python scripts/hook-check.py                      # every partial
    python scripts/hook-check.py fusion-display.css   # one partial (bare filename)

Compared against commit a38f23abf (pre-de-Tailwind). Categories:
  BROKEN  hook's utility existed pre-migration, is gone from source now -> you broke it
  LEGACY  already dead before the migration (not your problem, do not touch)
  OK      utility still in use
For each BROKEN hook, decide one of:
  re-key  add a selector for the surface class that replaced that utility in this
          container, same declaration, keep specificity + !important
  drop    the replacement class already paints the correct value through semantic
          tokens in all three faces -> delete the dead selector, say why
NEVER leave a broken hook in place.
"""
import glob
import re
import subprocess
import sys
import collections

BASE = "a38f23abf"
HOOK = re.compile(
    r"\.((?:text|bg|border|ring|shadow|from|to)-(?:stealth|nv|telemetry|theme|reactor|slate|gray|zinc|"
    r"red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|"
    r"rose|electric|white|black)[-\w]*(?:\\\/[0-9]{1,3})?)"
)


def source_text(root):
    out = ""
    for pat in ("/**/*.tsx", "/**/*.ts"):
        for p in glob.glob(root + pat, recursive=True):
            out += open(p, encoding="utf-8", errors="replace").read()
    return out


def rule_body(lines, idx):
    s = idx
    while s > 0 and "{" not in lines[s] and lines[s].strip() and not lines[s].strip().startswith("/*"):
        s -= 1
    e = idx
    while e < len(lines) - 1 and "}" not in lines[e]:
        e += 1
    return " ".join(x.strip() for x in lines[s:e + 1])


def main():
    only = sys.argv[1] if len(sys.argv) > 1 else None
    tmp = "tmp/premigr"
    subprocess.run(f'mkdir -p {tmp} && git archive {BASE} src | tar -x -C {tmp}',
                   shell=True, check=False)
    now = source_text("src")
    pre = source_text(tmp + "/src")
    files = sorted(glob.glob("src/styles/*.css"))
    total = collections.Counter()
    for path in files:
        name = path.split("\\")[-1]
        if only and only not in name:
            continue
        lines = open(path, encoding="utf-8").read().split("\n")
        hits = []
        for i, line in enumerate(lines):
            for m in HOOK.finditer(line):
                lit = m.group(1).replace("\\/", "/")
                if lit in now:
                    total["ok"] += 1
                elif lit in pre:
                    hits.append((i + 1, m.group(1)))
                    total["broken"] += 1
                else:
                    total["legacy"] += 1
        # dedupe by rule body
        seen, rows = set(), []
        for ln, cls in hits:
            body = rule_body(lines, ln - 1)
            if body in seen:
                continue
            seen.add(body)
            rows.append((ln, cls, body))
        if rows:
            print(f"\n═══ {name} — {len(rows)} BROKEN hook rule(s)")
            for ln, cls, body in rows:
                print(f"  L{ln}  .{cls}\n        {body[:300]}")
    print(f"\nsummary: ok={total['ok']} broken={total['broken']} legacy={total['legacy']}")
    print("BROKEN = you deleted the utility this correction matched. Re-key or drop, with a reason.")


if __name__ == "__main__":
    main()
