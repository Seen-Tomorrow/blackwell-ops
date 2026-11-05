#!/usr/bin/env python3
"""Run a matrix of launches through the app's own launch path and tabulate what the engine did.

Why: the FIT probe ignores `--parallel` (and under-counts the compute buffers by ~10-15 GB on a
400B-class model), so a forecast built only from it OOMs at the edge. This tool measures the
engine's actual buffer inventory per device, so the forecast can be built from facts.

Every launch goes through `scripts/engine-test.py` -> the app's `launch_engine`, i.e. the same
code path the UI uses (ports, locks, logging, learned store).

    python scripts/engine-matrix.py --preset parallel
    python scripts/engine-matrix.py --preset all --model C:/.../Qwen3.8-27B-UD-IQ3_XXS.gguf

Reads the newest `config/logs/sessions/*/slot-*/stderr.log` after each launch and records:
model / kv / compute / other per CUDA device, the host rows, n_slots, n_ctx_slot, kv_unified.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_MODEL = r"C:\AI-MASTER\models\unsloth\Qwen3.8-27B-GGUF\Qwen3.8-27B-UD-IQ3_XXS.gguf"
APP_ROOT = os.path.join("src-tauri", "target", "debug")
SESSIONS = os.path.join(APP_ROOT, "config", "logs", "sessions")

BUF_RE = re.compile(r"(CUDA\d|CUDA_Host|CPU_Mapped|CPU|Host|Meta\(\))\s+(model|KV|compute|RS|output)\s+buffer size =\s+([\d.]+) MiB")
PAR_RE = re.compile(r"n_parallel is set to auto, using n_parallel = (\d+)")
SLOTS_RE = re.compile(r"n_slots = (\d+), n_ctx_slot = (\d+), kv_unified = '(\w+)'")

PRESETS: dict[str, list[dict]] = {
    # parallel sweep: everything else pinned low so the delta is the slot count
    "parallel": [
        {"ctx": 32768, "batch": 2048, "ubatch": 512, "kv": "q8_0", "parallel": n}
        for n in (1, 2, 4, 8, 16, 32)
    ],
    # ctx sweep at parallel 1: KV linear in ctx, compute affine in ctx
    "ctx": [
        {"ctx": ctx, "batch": 2048, "ubatch": 512, "kv": "q8_0", "parallel": 1}
        for ctx in (32768, 65536, 131072, 262144)
    ],
    # batch/ubatch: compute buffers scale here
    "batch": [
        {"ctx": 32768, "batch": b, "ubatch": u, "kv": "q8_0", "parallel": 1}
        for b, u in ((512, 512), (1024, 512), (2048, 512), (2048, 1024), (3072, 1536))
    ],
    # kv quantisation at a fixed ctx
    "kv": [
        {"ctx": 32768, "batch": 2048, "ubatch": 512, "kv": q, "parallel": 1}
        for q in ("q4_0", "q8_0", "f16")
    ],
    # the shape the user measured by hand: 1M ctx, low KV, parallel 1 vs 4
    "million": [
        {"ctx": 1048576, "batch": 1024, "ubatch": 512, "kv": "q4_0", "parallel": n}
        for n in (1, 4)
    ],
}


def newest_slot() -> str | None:
    try:
        sessions = sorted(
            (os.path.join(SESSIONS, d) for d in os.listdir(SESSIONS)
             if os.path.isdir(os.path.join(SESSIONS, d))),
            key=os.path.getmtime,
            reverse=True,
        )
    except OSError:
        return None
    for session in sessions:
        slots = sorted(
            (os.path.join(session, d) for d in os.listdir(session)
             if os.path.isdir(os.path.join(session, d))),
            key=os.path.getmtime,
            reverse=True,
        )
        if slots:
            return slots[0]
    return None


def parse_slot(slot: str) -> dict:
    text = open(os.path.join(slot, "stderr.log"), encoding="utf-8", errors="replace").read()
    per_gpu: dict[int, dict[str, float]] = {}
    host: dict[str, float] = {}
    for device, kind, mib in BUF_RE.findall(text):
        value = float(mib)
        if device.startswith("CUDA") and device[4:].isdigit():
            gpu = int(device[4:])
            row = per_gpu.setdefault(gpu, {})
            row[kind] = row.get(kind, 0.0) + value
        else:
            host[kind] = host.get(kind, 0.0) + value
    slots = SLOTS_RE.search(text)
    auto_par = PAR_RE.search(text)
    return {
        "gpus": {str(k): {kk: round(vv, 2) for kk, vv in sorted(v.items())} for k, v in sorted(per_gpu.items())},
        "gpu_total": {str(k): round(sum(v.values()), 2) for k, v in sorted(per_gpu.items())},
        "host": {k: round(v, 2) for k, v in sorted(host.items())},
        "n_slots": int(slots.group(1)) if slots else None,
        "ctx_slot": int(slots.group(2)) if slots else None,
        "kv_unified": slots.group(3) if slots else None,
        "parallel_auto": int(auto_par.group(1)) if auto_par else None,
    }


def run_one(cfg: dict, model: str, hold: int, timeout: int) -> dict:
    cmd = [
        sys.executable,
        os.path.join("scripts", "engine-test.py"),
        "launch",
        "--model", model,
        "--ctx", str(cfg["ctx"]),
        "--batch", str(cfg["batch"]),
        "--ubatch", str(cfg["ubatch"]),
        "--kv", cfg["kv"],
        "--parallel", str(cfg["parallel"]),
        "--ts", "",
        "--hold", str(hold),
        "--timeout", str(timeout),
    ]
    started = time.time()
    proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace")
    elapsed = round(time.time() - started, 1)
    slot = newest_slot()
    parsed = parse_slot(slot) if slot else {}
    ok = proc.returncode == 0
    return {"config": cfg, "ok": ok, "secs": elapsed, "slot": slot, **parsed}


def fmt(row: dict) -> str:
    c = row["config"]
    if not row.get("ok"):
        return f"ctx={c['ctx']:<8} b={c['batch']}/{c['ubatch']:<5} kv={c['kv']:<5} par={c['parallel']:<3} FAILED"
    g = row.get("gpus", {})
    def part(i: int, kind: str) -> float:
        return g.get(str(i), {}).get(kind, 0.0)
    total = row.get("gpu_total", {})
    grand = sum(total.values())
    return (
        f"ctx={c['ctx']:<8} b={c['batch']}/{c['ubatch']:<5} kv={c['kv']:<5} par={c['parallel']:<3} "
        f"slots={row.get('n_slots')} ctx_slot={row.get('ctx_slot')} unified={row.get('kv_unified')} | "
        f"GPU0 m={part(0,'model'):.0f} kv={part(0,'KV'):.0f} c={part(0,'compute'):.0f} tot={total.get('0',0):.0f} | "
        f"GPU1 m={part(1,'model'):.0f} kv={part(1,'KV'):.0f} c={part(1,'compute'):.0f} tot={total.get('1',0):.0f} | "
        f"all={grand:.0f} MiB host={row.get('host',{}).get('model',0):.0f}"
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--preset", default="all", choices=[*PRESETS, "all"])
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--hold", type=int, default=3000)
    ap.add_argument("--timeout", type=int, default=240)
    ap.add_argument("--out", default=os.path.join("tmp", "engine-matrix.json"))
    args = ap.parse_args()

    names = list(PRESETS) if args.preset == "all" else [args.preset]
    rows: list[dict] = []
    for name in names:
        print(f"\n=== {name} ===")
        for cfg in PRESETS[name]:
            row = run_one(cfg, args.model, args.hold, args.timeout)
            rows.append({"preset": name, **row})
            print(fmt(row), flush=True)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as fh:
        json.dump(rows, fh, indent=2)
    print(f"\nwrote {args.out} ({len(rows)} rows)")
    return 0 if all(r.get("ok") for r in rows) else 1


if __name__ == "__main__":
    sys.exit(main())
