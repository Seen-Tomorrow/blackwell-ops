#!/usr/bin/env python3
"""Drive the app's engine launch path from the command line.

Writes a job into `{app_root}/config/automation/queue/` and waits for the app to answer in
`results/`. The app executes the SAME `launch_engine` path the UI uses, so ports, locks,
logging and the learned store all behave exactly as they do for a real launch - no UI
scraping, no PowerShell, and no second copy of the launch logic.

Examples (DEV app root is src-tauri/target/debug):

    python scripts/engine-test.py launch --model C:/AI-MASTER/models/.../x.gguf --ctx 65536 --kv q8_0 --hold 12
    python scripts/engine-test.py launch --model ... --ctx 131072 --kv q8_0 --hold 12 --split layer
    python scripts/engine-test.py status
    python scripts/engine-test.py stop --slot 0

After a launch with --hold the journal has a `measured` row, so:

    python scripts/forecast-compare.py <model substring>

Options default to a conservative launch (batch 2048/512 so a small card cannot OOM during a
probe sweep); pass --batch/--ubatch to match the app's usual 8192/4096.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import uuid

sys.stdout.reconfigure(encoding="utf-8", errors="replace")

DEFAULT_APP_ROOT = os.path.join("src-tauri", "target", "debug")


def automation_dir(app_root: str) -> str:
    return os.path.join(app_root, "config", "automation")


def write_job(app_root: str, job: dict) -> str:
    queue = os.path.join(automation_dir(app_root), "queue")
    os.makedirs(queue, exist_ok=True)
    path = os.path.join(queue, f"{job['id']}.json")
    # Write then rename, so the watcher never reads a half-written job.
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(job, fh, indent=2)
    os.replace(tmp, path)
    return job["id"]


def wait_result(app_root: str, job_id: str, timeout_s: float) -> dict:
    path = os.path.join(automation_dir(app_root), "results", f"{job_id}.json")
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if os.path.exists(path):
            try:
                with open(path, encoding="utf-8") as fh:
                    return json.load(fh)
            except (OSError, json.JSONDecodeError):
                pass
        time.sleep(0.25)
    raise TimeoutError(f"no result for {job_id} within {timeout_s:.0f}s ({path})")


def launch_config(args) -> dict:
    extra = {
        "ctx": args.ctx,
        "kv_quant": args.kv,
        "split": args.split,
        "batch": args.batch,
        "ubatch": args.ubatch,
        "flash_attn": args.flash_attn,
        "offload_mode": "regular",
        "cache_ram": args.cache_ram,
        # Match the cockpit's key shape: without these the same launch lands under
        # mode=full_auto / no topo and is invisible to every UI lookup.
        "__memory_mode": args.mode,
        "__vram_topo": args.topo,
    }
    if args.device:
        extra["device"] = args.device
    config = {
        "alias": args.alias or f"TEST_{uuid.uuid4().hex[:4].upper()}",
        "model_path": args.model,
        "port": args.port,
        "backend_type": args.provider,
        "binary_profile": args.profile,
        "extra_params": extra,
    }
    return config


def print_result(payload: dict) -> int:
    if payload.get("ok"):
        result = payload.get("result") or {}
        print("OK")
        for key in ("slot", "port", "alias", "ready", "startup_ms", "stopped", "stop_error"):
            if key in result:
                print(f"  {key:12} {result[key]}")
        for key in ("weights_mib", "kv_mib", "compute_mib", "total_mib"):
            if key in result:
                print(f"  {key:12} {result[key]:.0f}")
        basis = result.get("basis") or {}
        if basis:
            points = basis.get("points") or []
            ratio = basis.get("kv_layer_ratio") or 0
            print(
                f"  basis        {basis.get('arch')} L{basis.get('layers')} "
                f"split={basis.get('split')} b{basis.get('batch')}/{basis.get('ubatch')} "
                f"points={len(points)} kv_ratio={ratio:.3f}"
            )
        return 0
    print("FAILED")
    print(f"  {payload.get('error')}")
    return 1


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("action", choices=["launch", "cold", "status", "stop"])
    ap.add_argument("--app-root", default=DEFAULT_APP_ROOT)
    ap.add_argument("--hold", type=int, default=0, help="ms to hold after RUNNING, then stop (0 = leave running)")
    ap.add_argument("--timeout", type=float, default=240.0, help="seconds to wait for the result")
    ap.add_argument("--model")
    ap.add_argument("--ctx", type=int, default=32768)
    ap.add_argument("--kv", default="q8_0")
    ap.add_argument("--split", default="layer")
    ap.add_argument("--batch", type=int, default=2048)
    ap.add_argument("--ubatch", type=int, default=512)
    ap.add_argument("--flash-attn", default="on", dest="flash_attn")
    ap.add_argument("--cache-ram", type=int, default=16384)
    ap.add_argument("--device", default="")
    ap.add_argument("--mode", default="assisted", help="__memory_mode (assisted|full_auto)")
    ap.add_argument("--topo", default="96", help="__vram_topo token (manufactured GB per card)")
    ap.add_argument("--port", type=int, default=8899)
    ap.add_argument("--alias")
    ap.add_argument("--provider", default="ggml-master")
    ap.add_argument("--profile", default="edge")
    ap.add_argument("--slot", type=int)
    ap.add_argument("--exclude-model", dest="exclude_model")
    ap.add_argument("--id")
    args = ap.parse_args()

    job_id = args.id or f"job-{int(time.time())}-{uuid.uuid4().hex[:5]}"
    job = {"id": job_id, "action": args.action}

    if args.action == "launch":
        if not args.model:
            print("launch needs --model", file=sys.stderr)
            return 2
        job["config"] = launch_config(args)
        job["timeout_ms"] = int(args.timeout * 1000)
        if args.hold:
            job["hold_ms"] = args.hold
    elif args.action == "cold":
        if not args.model:
            print("cold needs --model", file=sys.stderr)
            return 2
        job["params"] = {
            "model_path": args.model,
            "ctx": args.ctx,
            "kv_quant": args.kv,
            "split": args.split,
            "batch": args.batch,
            "ubatch": args.ubatch,
            "exclude_model": args.exclude_model,
        }
    elif args.action == "stop":
        if args.slot is None:
            print("stop needs --slot", file=sys.stderr)
            return 2
        job["slot"] = args.slot

    write_job(args.app_root, job)
    payload = wait_result(args.app_root, job_id, args.timeout)
    code = print_result(payload)
    print(f"\njournal: {os.path.join(args.app_root, 'config', 'cache', 'forecast-log.jsonl')}")
    return code


if __name__ == "__main__":
    sys.exit(main())
