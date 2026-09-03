#!/usr/bin/env python3
"""Tailwind-paint census — the law meter for the de-Tailwind week.

Run from repo root:  python scripts/tw-census.py            (full report)
                     python scripts/tw-census.py --json      (machine-readable)
                     python scripts/tw-census.py src/components/ConfigPage.tsx   (one file)

Measures the three paint dialects and the two dictionary gaps:
  nick  = Tailwind color nickname  (text-nv-green, border-stealth-border, bg-telemetry-red)
  pal   = Tailwind stock palette   (text-yellow-400, bg-red-500)   -> ARCTIC can never see it
  arb   = Tailwind arbitrary hex   (bg-[#1a1a2e])
  fb    = var(--x, #hex) fallback  (theme switch is shadowed by the literal)
  px    = text-[Npx] arbitrary type size (no type scale in the dictionary)
  imp   = !important declarations  (paint-bomb pressure)
"""
import json
import os
import re
import sys
import collections

ROOT = "src"
CODE = (".tsx", ".ts")
STYLE = (".css",)

NICK = re.compile(
    r"\b(?:text|bg|border|from|to|via|ring|fill|stroke|shadow|divide|outline|placeholder|decoration|accent|caret)-"
    r"(?:stealth|nv|telemetry|theme|reactor)(?:-[a-z0-9]+)?\b"
)
PAL = re.compile(
    r"\b(?:text|bg|border|from|to|via|ring|fill|stroke|shadow|divide|outline|placeholder|decoration|accent|caret)-"
    r"(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-[0-9]{2,3}\b"
)
ARB = re.compile(
    r"\b(?:text|bg|border|ring|shadow|from|to|divide|outline|placeholder)-\[[^\]]*#[0-9a-fA-F]{3,8}[^\]]*\]"
)
FB = re.compile(r"var\(\s*(--[a-z0-9-]+)\s*,\s*#[0-9a-fA-F]{3,8}\s*\)")
PX = re.compile(r"\btext-\[[0-9.]+px\]")
IMP = re.compile(r"!important")


def files(targets):
    if targets:
        return [p for p in targets if os.path.isfile(p)]
    out = []
    for dp, dn, fns in os.walk(ROOT):
        dn[:] = [d for d in dn if d not in ("node_modules", "dist", "assets")]
        for fn in fns:
            if fn.endswith(CODE + STYLE) and not fn.endswith(".test.ts"):
                out.append(os.path.join(dp, fn))
    return out


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    as_json = "--json" in sys.argv
    rows = []
    vocab = collections.Counter()
    fb_tok = collections.Counter()
    px_sizes = collections.Counter()
    for f in files(args):
        txt = open(f, encoding="utf-8", errors="replace").read()
        css = f.endswith(".css")
        nick = [] if css else NICK.findall(txt)   # CSS has no Tailwind utilities
        pal = [] if css else PAL.findall(txt)
        arb = [] if css else ARB.findall(txt)
        fb = FB.findall(txt)
        px = [] if css else PX.findall(txt)
        imp = len(IMP.findall(txt)) if css else 0
        for v in nick + pal + arb:
            vocab[v] += 1
        for v in fb:
            fb_tok[v] += 1
        for v in px:
            px_sizes[v] += 1
        paint = len(nick) + len(pal) + len(arb)
        if paint or fb or px or imp:
            rows.append(dict(file=f.replace("\\", "/"), nick=len(nick), pal=len(pal),
                             arb=len(arb), fb=len(fb), px=len(px), imp=imp,
                             paint=paint))
    rows.sort(key=lambda r: (-r["paint"], -r["fb"]))
    tot = {k: sum(r[k] for r in rows) for k in ("nick", "pal", "arb", "fb", "px", "imp", "paint")}

    if as_json:
        print(json.dumps(dict(total=tot, distinct_vocab=len(vocab),
                              distinct_fb_tokens=len(fb_tok), files=rows), indent=2))
        return

    print("=" * 86)
    print("TAILWIND PAINT CENSUS  (law meter)")
    print("=" * 86)
    print(f"  paint utilities total : {tot['paint']:6}   (nick {tot['nick']} / palette {tot['pal']} / arbitrary-hex {tot['arb']})")
    print(f"  distinct vocabulary   : {len(vocab):6}   <- closed set; a mapping table ends this")
    print(f"  var(--x,#hex) fallbacks: {tot['fb']:5}  across {len(fb_tok)} tokens  <- shadows the theme switch")
    print(f"  text-[Npx] type sites : {tot['px']:6}   <- no type scale in the dictionary")
    print(f"  !important (css only) : {tot['imp']:6}")
    print("-" * 86)
    print(f"{'file':56}{'paint':>6}{'nick':>6}{'pal':>5}{'fb':>5}{'px':>5}{'imp':>5}")
    for r in rows:
        print(f"{r['file']:56}{r['paint']:6}{r['nick']:6}{r['pal']:5}{r['fb']:5}{r['px']:5}{r['imp']:5}")
    print("-" * 86)
    print("top leaked vocabulary:")
    for k, n in vocab.most_common(24):
        print(f"  {n:5}  {k}")
    print("top shadowed tokens (var(--x,#hex)):")
    for k, n in fb_tok.most_common(16):
        print(f"  {n:5}  {k}")
    print("type sizes:")
    for k, n in px_sizes.most_common(13):
        print(f"  {n:5}  {k}")


if __name__ == "__main__":
    main()
