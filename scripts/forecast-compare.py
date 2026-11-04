#!/usr/bin/env python3
"""Compare the three VRAM estimates we keep for a launch.

Reads the app's cache (no app needed, no engine spawn):

  forecast-log.jsonl   prelaunch (FIT / learned at launch), measured (real launch), plan
  learned-vram.json    what the launcher recorded per configuration
  gpu-calibration.json measured runtime overhead per device

The point is to answer one question per configuration: which estimate was closest to the
launch that actually happened, and by how much. Run after a test launch:

    python scripts/forecast-compare.py                  # all models, last 20 groups
    python scripts/forecast-compare.py Qwen3.8-27B      # filter by model substring
    python scripts/forecast-compare.py --cache <dir>    # non-default app root

Columns, all MiB unless noted:
  fit    prelaunch estimate (`validated_mib` when the source was a probe, else estimate_gb)
  plan   our layer plan total from a `plan` row (weights + KV + compute buffers)
  meas   the launch's recorded VRAM
  fit_d / plan_d   error against `meas` (negative = under-read, the dangerous direction)
  exact  whether the prelaunch source was exact for THIS ctx (`memory_source_exact`)
"""

from __future__ import annotations

import argparse
import collections
import json
import os
import sys

sys.stdout.reconfigure(encoding="utf-8", errors="replace")


def load_rows(path):
    if not os.path.exists(path):
        return []
    rows = []
    with open(path, encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rows.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return rows


def learned_points(path):
    """ctx -> vram_mib per configuration key, from the learned store."""
    try:
        with open(path, encoding="utf-8") as fh:
            store = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    entries = store.get("entries", store)
    out = collections.defaultdict(dict)
    for key, entry in entries.items():
        ctx = None
        for token in key.split("|"):
            if token.startswith("ctx="):
                try:
                    ctx = int(token[4:])
                except ValueError:
                    ctx = None
        if ctx is None or not isinstance(entry, dict):
            continue
        out[key.split("|", 1)[0]].setdefault(ctx, []).append(entry.get("vram_mib", 0))
    return out


def group_key(row):
    """One launch configuration: model + ctx + kv + split.

    A `measured` row carries only `learn_key`, so the configuration is recovered from it -
    otherwise the launch lands in its own anonymous group and nothing can be compared.
    """
    model = str(row.get("model_path") or row.get("model_name") or "?")
    ctx = row.get("ctx")
    kv = row.get("kv_quant")
    split = row.get("split")
    key = row.get("learn_key")
    if isinstance(key, str) and "|" in key:
        model, _, tail = key.partition("|")
        for token in tail.split("|"):
            if token.startswith("ctx=") and ctx is None:
                try:
                    ctx = int(token[4:])
                except ValueError:
                    pass
            elif token.startswith("kv=") and kv is None:
                kv = token[3:]
            elif token.startswith("split=") and split is None:
                split = token[6:]
    # Windows paths arrive with backslashes in one row and forward slashes in the other.
    return (model.replace("\\", "/").lower(), ctx, kv, split)


def fmt(value):
    return "     -" if value is None else f"{value:6.0f}"


def main():
    cache = os.path.join("src-tauri", "target", "debug", "config", "cache")
    argv = sys.argv[1:]
    if argv and argv[0] == "--cache":
        cache = argv[1]

    ap = argparse.ArgumentParser(add_help=False)
    ap.add_argument("filter", nargs="?", default="")
    ap.add_argument("--cache")
    ap.add_argument("--last", type=int, default=20)
    args, _ = ap.parse_known_args()

    rows = load_rows(os.path.join(cache, "forecast-log.jsonl"))
    if not rows:
        print(f"no rows in {os.path.join(cache, 'forecast-log.jsonl')}")
        return 1

    groups = collections.OrderedDict()
    for row in rows:
        model = group_key(row)[0]
        if args.filter and args.filter.lower() not in model.lower():
            continue
        groups.setdefault(group_key(row), []).append(row)

    print(f"{'model':34} {'ctx':>8} {'kv':>6} {'split':>6} "
          f"{'fit':>6} {'plan':>6} {'meas':>6} {'fit_d':>7} {'plan_d':>7} exact")
    shown = 0
    for (model, ctx, kv, split), bucket in reversed(list(groups.items())):
        if shown >= args.last:
            break
        fit = plan = meas = None
        exact = ""
        for row in bucket:
            kind = row.get("kind")
            if kind == "prelaunch":
                validated = row.get("validated_mib")
                estimate = row.get("estimate_gb")
                fit = validated if validated else (
                    estimate * 1024 if isinstance(estimate, (int, float)) else None
                )
                if row.get("memory_source_exact") is not None:
                    exact = "yes" if row["memory_source_exact"] else "no"
            elif kind == "plan":
                plan = row.get("plan_total_mib")
            elif kind == "measured":
                meas = row.get("vram_mib")
        if fit is None and plan is None and meas is None:
            continue
        short = os.path.basename(str(model)).replace("\\\\", "/").split("/")[-1][:34]
        fit_delta = fit - meas if (fit is not None and meas is not None) else None
        plan_delta = plan - meas if (plan is not None and meas is not None) else None
        print(f"{short:34} {str(ctx):>8} {str(kv):>6} {str(split):>6} "
              f"{fmt(fit)} {fmt(plan)} {fmt(meas)} "
              f"{fmt(fit_delta)} {fmt(plan_delta)} {exact}")
        shown += 1

    if shown == 0:
        print("no matching configurations — run a launch, then re-run this")
        return 1

    total = sum(1 for r in rows if r.get("kind") == "plan")
    print(f"\nplan rows in journal: {total}   "
          f"(a plan row appears when the PLAN chip computes for a configuration)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
