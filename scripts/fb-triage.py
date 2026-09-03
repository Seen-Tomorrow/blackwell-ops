#!/usr/bin/env python3
"""Classify every var(--x, <literal>) fallback by whether --x is actually themed.

A fallback is only ever read when the token is UNDEFINED at that element, so the
fallback's real meaning depends on where the token is defined:

  THEMED   defined in all three face objects in app-themes.ts -> fallback is dead
           weight; deleting it is safe and removes the "shadow"
  PARTIAL  defined in only 1-2 faces -> in the missing face(s) every site silently
           renders the literal: a real theme-switch bug, face-dependent
  BASE     defined only in tokens-base :root (never face-switched) -> the fallback is
           redundant; if the color SHOULD change per face the token is the problem
  NOWHERE  defined nowhere -> the literal IS the color; the property can never theme
           (and any use of that token WITHOUT a fallback is invalid-at-computed-value)

Run from repo root: python scripts/fb-triage.py [token-substring] [root]
"""
import glob
import re
import sys
from collections import defaultdict

FACES = ("MATRIX", "SLATE", "ARCTIC")
USE = re.compile(r"var\(\s*(--[a-zA-Z0-9-]+)\s*,\s*(#[0-9a-fA-F]{3,8}|rgba?\([^)]*\))\)")
DEF = re.compile(r"^\s*(--[a-zA-Z0-9-]+)\s*:\s*([^;]+)", re.M)
BASEVAL: dict = {}


def face_keys():
    """token -> set of faces that define it in app-themes.ts."""
    text = open("src/themes/app-themes.ts", encoding="utf-8").read()
    spans: dict = {}
    for face in FACES:
        m = re.search(r"const %s: AppTheme = \{" % face, text)
        if not m:
            continue
        start = m.end()
        nxt = re.search(r"\nconst [A-Z_]+: AppTheme = \{", text[start:])
        end = start + (nxt.start() if nxt else len(text))
        spans[face] = text[start:end]
    out = defaultdict(set)
    for face, body in spans.items():
        for k in re.findall(r'"(--[a-zA-Z0-9-]+)"\s*:', body):
            out[k].add(face)
    return out


def css_defs(root):
    """token -> files that DEFINE it (excluding var() fallback positions)."""
    out = defaultdict(set)
    for path in glob.glob(root + "/styles/*.css") + [root + "/index.css", root + "/controls.css"]:
        body = open(path, encoding="utf-8").read()
        stripped = re.sub(r"var\(\s*--[a-zA-Z0-9-]+\s*,[^)]*\)", "", body)
        for m in DEF.finditer(stripped):
            BASEVAL.setdefault(m.group(1), " ".join(m.group(2).split()))
            out[m.group(1)].add(path.replace("\\", "/"))
    return out


def classify(tok, faces, defs):
    """Is the fallback ever reachable, and does the token theme-switch?"""
    f = faces.get(tok, set())
    base = bool(defs.get(tok))
    chain = "var(" in BASEVAL.get(tok, "")
    if not f and not base:
        return "LIVE-LITERAL (token undefined: the fallback IS the paint, every face)"
    if len(f) == 3:
        return "DEAD (themed in all 3 faces: fallback never read)"
    if base:
        missing = ",".join(x for x in FACES if x not in f) or "none"
        if chain:
            return (f"DEAD-CHAIN (base def is a var() chain covering [%s]: fallback never "
                    "read, color still switches)" % missing)
        return (f"DEAD-FLAT (base def is a literal covering [%s]: fallback never read, "
                "color never switches)" % missing)
    return "FACE-GAP (%s undefined and no base def -> those faces DO render the literal)" % (
        ",".join(x for x in FACES if x not in f))


def main():
    needle = sys.argv[1] if len(sys.argv) > 1 else None
    root = sys.argv[2] if len(sys.argv) > 2 else "src"
    faces, defs = face_keys(), css_defs(root)
    rows = []
    for path in sorted(glob.glob(root + "/styles/*.css") + [root + "/index.css", root + "/controls.css"]):
        for i, line in enumerate(open(path, encoding="utf-8").read().split("\n"), 1):
            for m in USE.finditer(line):
                tok, lit = m.group(1), m.group(2)
                if needle and needle not in tok:
                    continue
                rows.append((classify(tok, faces, defs), tok, lit, path.replace("\\", "/").split("/")[-1], i))

    by_kind = defaultdict(list)
    for r in rows:
        by_kind[r[0]].append(r)
    print(f"root={root}  fallback sites: {len(rows)}   distinct tokens: {len({r[1] for r in rows})}")
    for kind in sorted(by_kind, key=lambda k: -len(by_kind[k])):
        group = by_kind[kind]
        toks = defaultdict(int)
        for r in group:
            toks[r[1]] += 1
        print(f"\n== {kind}: {len(group)} sites / {len(toks)} tokens")
        for tok, n in sorted(toks.items(), key=lambda x: -x[1])[:8]:
            ex = next(r for r in group if r[1] == tok)
            print(f"   {n:4}  {tok:<32} e.g. {ex[3]}:{ex[4]} -> {ex[2]}")
    if needle:
        print("\n-- all matching sites --")
        for r in rows[:80]:
            print(f"  {r[0]:<22} {r[1]:<30} {r[2]:<28} {r[3]}:{r[4]}")


if __name__ == "__main__":
    main()
