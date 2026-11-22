# Handover — PLAN / TAKEOVER review

> Superseded 2026-11-15 by `docs/PLAN-PLACEMENT.md`: the manual ENGINE FIT / APP TAKEOVER
> switch is gone, placement is automatic for every multi-GPU layer split, and SPLIT EQ is
> the manual nudge. Keep this file for the measurements and landmines it records.

Date: 2026-11-15. For a fresh session whose job is to review the *placement* feature: the layer plan
and the ENGINE FIT ↔ APP TAKEOVER switch. It is functional but clumsy; this file is what to know
before touching it.

## What the app does, in one line

Solo-dev desktop app for running local GGUF engines (llama.cpp forks under `ggml-master`). The glass
(a heavy bezel-styled badge) answers one question: does this model fit, and where do the layers go.

## Where we are after this week

- **Forecast is measured-only.** Learned rows per model family (weights / KV / compute / host), an
  affine compute fit over (ctx, ubatch), and a single on-demand FIT probe for models with no launch
  yet. Validated to ±0.3 % on the 27B across four ubatch levels.
- **Learned store has a schema stamp** (`STORE_SCHEMA` in `src-tauri/src/vram_learn.rs`). Bump it by
  hand when the *maths* changes, never per build; a mismatched store is discarded, not converted.
- **Library-wide FIT scan is gone** (`c21e54eb5`, `2a8a006cf`). No background GPU passes, no catalog
  fit badges. The metadata pass and its strip remain.
- **Vendor patches** (4): `memory-endpoint`, `memory-ledger` (both ours), `single-model-load-sse`,
  `telemetry-sse`. They give `/memory` (ledger of actual allocations) and the SSE telemetry stream.
- **WDDM fit is blind** (measured): `--fit` reads CUDA's *budget* (VRAM + shared system RAM), not
  physical free. Guard: when the target GPU already has >4 GiB in use (ours or external) the launch
  gets `--fit off` and logs the numbers. Confirmed live.

## The placement pipeline as it exists

1. **Plan** — `src/lib/vramLayerPlan.ts` `planLayerSplit()`: given per-block MiB, per-GPU budgets
   (after reserve + runtime overhead + draft), KV per layer, writes `boundary` (blocks on GPU0),
   `ts`, `applyTs`, `optimalBoundary`, per-GPU `weightsMib`/`kvMib`/`totalMib`/`util`, `sumMib`.
   Consumed by `src/hooks/useLayerPlan.ts` and displayed in the glass.
2. **Switch** — `VramBadge` "VRAM PLACEMENT": `ENGINE FIT` (fit on, no `-ts`) vs `APP TAKEOVER`
   (fit off + `split=layer` + `-ts` from `applyTs`). State is `fitOff` in `EngineConfigPanel`
   (persisted under `KEYS.fitOff`).
3. **Apply** — `EngineConfigPanel` `onApplyPlan(tensorSplit)`: `updateParam("split","layer")`,
   `updateParam("tensor_split", …)`, then **`save_provider`** with the row's `defaultValue` replaced,
   then `reloadProviders` + `paramConfigChanged`. Release path clears `-ts` first (a leftover makes
   `--fit` bail with "tensor_split already set").
4. **Launch** — `buildLaunchConfig` adds `__fit_off` when takeover is on; `tensor_split` rides as a
   flat config key and reaches the CLI as `-ts` through the provider template's text row.
5. **Forecast consumption** — `layerSplitMib` (plan per-card MiB) is passed to the adapter, which
   scales the learned/probe total by each card's share, then adds the measured per-card runtime
   residual. Plan is **placement only**: it must never appear as a second forecast number (we removed
   the "plan 41.0" chip from NEED for exactly that reason).

## Why it feels clumsy — concrete evidence from this session

- **The switch is not the whole story.** `fitOff` + no `-ts` (the busy-card guard, a fresh profile, a
  takeover that failed to persist) means llama picks its own split. So "APP TAKEOVER" can mean "plan
  honoured" *or* "llama defaults", and the glass cannot tell you which.
- **`-ts` persistence is asynchronous.** `save_provider` → `reloadProviders` → launch. A launch in
  the same tick can miss the new value (observed: one launch without `-ts`, the next with
  `0.480,0.520`). No "placement applied, safe to launch" state exists.
- **Two numbers describe the layout.** One badge dump had `need 77.25 GB` while `plan.totalMib`
  was 50.5 GB. Plan is placement, forecast is need — but nothing on screen says why they differ.
- **`-ts` is a layer fraction; bytes are not uniform.** DSV4.1 blocks grow 2.9 → 4.5 GiB, so a
  fraction of layers is not a fraction of bytes. `applyTs` comes from the byte-balanced boundary and
  the forecast scales by `layerSplitMib`, but a plan's prediction and the engine's actual per-card
  placement have never been compared on a real launch.
- **The plan is silent about takeover confidence.** `plan.appliedBoundary` / `squeezed` /
  `fit_changed` exist; none of them reach the switch's tooltip.

## Verify first (cheap, before changing anything)

```powershell
python scripts/engine-test.py launch --model <27B gguf> --ctx 262144 --kv q8_0 --device 0 `
    --split layer --parallel 1 --alias PLAN-CHECK        # leaves it running
# after it is RUNNING:
Get-Content src-tauri/target/debug/config/logs/sessions/<session>/slot-N_*/launch.cmd.txt
#   → expect "-ts <plan ts>" and "--fit off" when takeover was applied
python scripts/engine-test.py snapshot
blackwell-ops.exe --nvram-diff <a.json> <b.json>          # ready vs pre_launch
```

Then compare **planned** vs **measured** per card:

- plan: `config/cache/forecast-log.jsonl`, rows `kind:"plan"` (`ts`, `boundary`, `gpu_mib`,
  `measured_compute_mib`).
- measured: the same journal's `kind:"measured"` row, the `ready` snapshot, or `/memory` from the
  patched engine (the memory log's `CORE` chip means the ledger answered).

The 27B and DSV4.1 are the two useful models: uniform-ish blocks vs blocks that grow.

## Design questions to settle

1. **One owner for placement.** Either the engine's fit owns it (takeover impossible) or the app owns
   it (logical: fit is blind on WDDM and cannot see neighbours). Today both exist and the switch is
   manual. Proposal to review: takeover by default whenever the card is shared, probe/fit only for a
   free card, and delete the manual switch.
2. **A real "applied" state.** `onApplyPlan` should resolve only when the provider save round-trips,
   and the LAUNCH control should be disabled (or the launch should await) until then.
3. **One number on screen.** Decide whether the plan total must equal the forecast need; if not, the
   glass must label them unambiguously (e.g. "need 77.3 · planned 50.5" only in takeover).
4. **Plan confidence.** Surface `appliedBoundary` vs `optimalBoundary`, `squeezed`, and the per-card
   util next to the switch, so "takeover" is a decision with numbers, not a toggle.
5. **Is the plan needed at all with one GPU?** Split none + one card means the plan only adds noise.

## MoE expert placement — the second dimension (new in the 2026-11 engine)

The engine now carries three merged upstream changes that make expert placement tunable, and none of
them is wired into the app yet. This is the piece the plan/takeover review should absorb, because
"where do the layers go" is no longer the whole placement question for a MoE model.

| PR | what it does |
|---|---|
| [#31569](https://github.com/ggml-org/llama.cpp/pull/31569) | fit counted `n_layer+1` while the loader counted `n_layer_all+1`; on a multi-GPU layer split fit said "offloaded 65/66" and left layer 0 on the CPU. Fixed: skipped NextN layers now land in `n_gpu_layers` and the output device's split. **Our rebuilt engine includes it; a fit-on multi-card launch is one layer closer to the plan now.** |
| [#30966](https://github.com/ggml-org/llama.cpp/pull/30966) | `llama_moe_cache`: missed experts can be **computed on the CPU** (`--moe-cache-cpu-share`) instead of uploaded, and `--moe-cache-mib` / `--moe-cache-cpu-share` became real knobs. Ships `scripts/moe-cache-tune.py`, which sweeps cache MiB × share and prints a recommendation. |
| [#31233](https://github.com/ggml-org/llama.cpp/pull/31233) | Replaces the cache policy with ClassLRU (8 classes, decaying CRF), +6–7 % decode at the same cache size, and enables the cache's auto mode. |

Measured by the user on a 16 GB 5070 Ti: **5 → ~100 t/s** by keeping some experts in VRAM instead of
offloading all of them.

### What this changes for the forecast

- **VRAM need for a MoE model with the cache on** is `non-expert weights + KV + compute + moe_cache_mib`,
  and the cache is **split across devices like the layers** (`--tensor-split`) per the flag's own help
  text. The experts themselves stay in host RAM, so the cache is an extra VRAM copy — it does **not**
  reduce `ramNeed`.
- **"Spill" is no longer binary.** For MoE on a small card the honest verdict is a *recommendation*
  ("cache 24 GiB of experts in VRAM, keep the rest on host") rather than FIT/SPILL. The tuned example
  recommended `share 0` at 24 GiB because once the cache covers the working set the CPU share only
  costs time.
- **Parameters to wire, in this order:** template rows for `cpu_moe` (bool), `n_cpu_moe` (int,
  per-layer experts), `moe_cache_mib` (int), `moe_cache_cpu_share` (0–1) — first the template (a CLI
  key absent from the param list must not be invented), then the launch whitelist, then the forecast.
- **Cache size heuristic (no sweep):** `cache = min(free − (weights + KV + compute), ~1.2 × single
  token working set)`; below ~1.0× ClassLRU loses to the old policy, above ~1.2× it wins, so do not
  recommend a token-sized cache.
- **Do not model routing.** Hit rate is a workload property; the forecast owns the memory, the engine
  owns the cache. The one number the forecast can honestly add is the cache cap.

### Verify after the rebuild

`llama-server --help` on our artifact must list `-cmoe/--cpu-moe`, `-ncmoe/--n-cpu-moe`,
`--moe-cache-mib`, `--moe-cache-cpu-share` (build 12548 / `f8caa5ea3` does). Then one launch of a MoE
model with `-cmoe --moe-cache-mib N` and check that VRAM ≈ non-expert + KV + compute + N in the memory
log's `CORE` ledger, and that host still holds the full expert set.

## Expert cache — what exists now (wired, not yet forecast)

Shipped this session, all pushed (`8ea9d4ae9` … `0c510f737`):

- **Template `EXPERTS` group** (`templateVersion` 64): `cpu_moe`, `n_cpu_moe`, `moe_cache_mib` (slider,
  256 MiB step), `moe_cache_cpu_share` (0–1). The engine already carries `-cmoe`, `-ncmoe`,
  `--moe-cache-mib`, `--moe-cache-cpu-share`.
- **EXPERT CACHE instrument** in the ASSISTED cockpit (next to TASK / PROMPT CACHE / TWEAKS, open by
  default, hidden for dense models). The template rows alone were invisible there — the cockpit does
  not render the full param matrix, which is why the first cut looked like "no TUNE in the UI".
- **TUNE is measured, not predicted** (`src-tauri/src/moe_tune.rs`): one private `llama-server` per
  candidate on a loopback port with the real split/`-ts`, a fixed prompt ending on an open
  continuation and `ignore_eos: true` (without that a quantized model answers the sentence and stops
  on token 1 — the first live run measured 0 t/s four times). t/s comes from the server's own timings.
- **Candidates, in run order:** plain all-on-GPU launch → `-cmoe` no cache → ¼ budget → ¾ budget →
  ¾ budget + share 0.95. The GPU launch wins unless a cache config beats it by **more than 2 %**, so
  a fitting model gets `full GPU · no cache` and APPLY clears `-cmoe` instead of writing a cache size.
  APPLY is always explicit: DEV runs stage and wait (ASSISTED rule); FULL AUTO can take the numbers later.
- **VRAM ballast** (`src-tauri/src/bin/vram-ballast.rs`, separate bin, DEV only): holds raw device
  memory via the CUDA driver API — no gguf, no toolkit — and closes on the **NVML** free number (the
  one the glass, the guard and the tune read). Measured: target 24,576 MiB free → 24,592 MiB
  (+16 MiB, 0.07 %), reached in ~1 s. One process per card, so several cards can be held at once
  with a different free size each (GPU TOPO (DEV) → VRAM BALLAST: arm cards, pick 8-72 GB per card,
  HOLD). The hold is **fixed after start**: it never allocates again, only re-touches its pages every
  3 s while the driver demotes them for an engine that overcommits — free returns to the target when
  that engine exits, and RELEASE/HOLD re-plans. `--parent-pid` makes it release if the app dies;
  `--status` still works from a shell.
- **DEV gating:** ballast commands reject in release, the UI block only exists in DEV tools, and the
  tune's "card is busy" refusal stays in REL. In DEV an occupied card is allowed and the free
  remainder becomes the tuning budget — that is how the ballast turns a 96 GB card into a 16 GB one
  for the calibration.

### Next, in order

1. **Run the reduced-VRAM test.** Ballast 16 GB on the card, then TUNE on the Flash: the all-on-GPU
   candidate should now lose, and the cache numbers become the recommendation. Verify the DEV path
   actually passes the reduced budget (not just that it avoids the refusal).
2. **Glass segment.** VRAM need gains `moe_cache_mib` (split across devices like `-ts`); `ramNeed`
   keeps the full expert set because the cache is a copy. Verdict should read "expert cache" instead
   of "spill" for such a launch. Until then the forecast calls a cache launch a spill.
3. **REL surface review.** Confirm nothing from the ballast / DEV budget path can be reached in a
   release build (command bodies, UI mount, and the tune gate are the three places).
4. **Tune polish (optional):** print the measured table to the BOC console; persist the last report
   under `config/cache/moe-tune/` so a re-tune is opt-in.

### Traps found

- A second `[[bin]]` makes plain `cargo run` ambiguous and breaks `tauri dev`; `default-run` in
  `Cargo.toml` fixes it (`0c510f737`).
- The calibration child is not in the engines' Job Object; if the app is killed hard, a
  `llama-server` from a running calibration can survive. `--parent-pid` covers the ballast, not the
  tune's servers — the fix is the same one line (borrow the engine job) when this goes deeper.
- On WDDM a ballast does **not** force a hard OOM: CUDA may overcommit into shared memory, so the
  engine pages instead of failing. That is fine for comparing speed, but it cannot manufacture
  "does not fit".
- **Ballast top-up trap.** NVML free *rises* when the driver demotes ballast pages for an engine that
  overcommits, and the reading stays high for ~1 s after the pages are faulted back. Treating that as
  "the card has spare memory" and allocating on top leaves the card permanently below target: one
  split run left 16,384→15,999 and 24,576→24,121 MiB free, with no give-back path to recover. The
  hold must stay fixed after start; the re-touch is what returns free to the target.

## Landmines

- `--fit` on WDDM is blind (budget). Never trust its "will leave N free".
- A leftover `-ts` makes `--fit` refuse to run ("tensor_split already set"). Clear it when handing
  placement back, always.
- Do not reintroduce the library-wide FIT scan: it wrote `fit_scan_full.json`, which fed committed
  VRAM estimates and produced per-card nonsense when stale. Deleted for that reason.
- `STORE_SCHEMA` is a hand bump; do not tie it to build ids (engines are rebuilt several times a day).
- Keep the plan out of the NEED chip. It is placement, not a second forecast.

## Where things live

| area | file |
|---|---|
| plan geometry | `src/lib/vramLayerPlan.ts`, `src/hooks/useLayerPlan.ts` |
| switch + apply | `src/components/VramBadge.tsx`, `src/components/EngineConfigPanel.tsx` |
| launch config | `src/lib/buildLaunchConfig.ts` |
| forecast math | `src/services/vram/forecast/adapters/ggml_master.ts` |
| learned store / fit / guard | `src-tauri/src/vram_learn.rs`, `fit_scanner.rs`, `engine_utils.rs` |
| engine ledger + `/memory` | `src-tauri/src/engine_memory_view.rs`, `foundry/patches/*.patch` |
| checks | `npm run check` (the one command), `npm run check:patches` |
