# Engine memory — what the buffers are and what actually moves them

Measured 2026-11-05 on 2 × RTX PRO 6000 (96 GB, TCC) with `scripts/engine-matrix.py`, which runs
launches through the app's own `launch_engine` (the UI path: `--load-mode mlock`, explicit
`--parallel`, `--fit off`, no `-ts`) and reads the engine's own buffer lines. Model:
`Qwen3.8-27B-UD-IQ3_XXS.gguf` unless marked DSV4.1.

Every number is **MiB per device**, from `load_tensors` / `llama_kv_cache` / `sched_reserve`, and
excludes the CUDA context (~625 MiB/device, calibrated separately). `total` is all CUDA buffers on
that card, including the ~78 MiB of auxiliary buffers.

Why this file exists: **the FIT probe ignores `--parallel` and omits the compute buffers**
(10–15 GB on a 400B-class model). A forecast built only from it OOMs on a machine that is at the
edge of its VRAM — which this one is.

## Parallel

ctx 32768, batch 2048, ubatch 512, KV q8_0, explicit `--parallel N`:

| par | slots | ctx/slot | KV/card | compute 0/1 | total 0/1 | all |
|---|---|---|---|---|---|---|
| 1 | 1 | 32768 | 544 | 715 / 377 | 5,478 / 6,537 | 12,015 |
| 2 | 2 | 16384 | 544 | 651 / 313 | 5,492 / 6,545 | 12,037 |
| 4 | 4 | 8192 | 544 | 619 / 281 | 5,616 / 6,656 | 12,272 |
| 8 | 8 | 4096 | 544 | 603 / 265 | 5,912 / 6,927 | 12,839 |
| 16 | 16 | 2048 | 544 | 595 / 257 | 6,527 / 7,492 | 14,020 |
| 32 | 32 | 1024 | 544 | 655 / 317 | 7,834 / 8,699 | 16,533 |

- **KV does not change with an explicit `--parallel`.** `n_ctx_slot = ctx / N`, `kv_unified=false`:
  the total context is fixed, so the cache is fixed.
- **Compute moves**: it dips to parallel 16 and then jumps hard at 32 (+4.5 GB total vs par 1).
  A 4-slot launch is *cheaper* than 1 slot at the same total context (−4.5 GB at 1M-request, see
  below) — this is the "parallel 4 used less VRAM" result, and it is real.
- **Omitting `--parallel` is a different regime.** llama picks `n_parallel = 4` **and flips
  `kv_unified = true`**, so every slot gets the *full* ctx and the KV cache quadruples. Observed on
  DeepSeek-V4.1 at ctx 262144: KV 621.6 MiB with `--parallel 1` vs 2,486.3 MiB with auto-4
  (+1.9 GB), plus compute 5,989/11,685 → 9,877/12,375 (+3.9/+0.7 GB).
  One flag, two behaviours — always pass it.

## Context length

`--parallel 1`, batch 2048, ubatch 512, KV q8_0:

| ctx | KV/card | compute 0/1 | total 0/1 | all |
|---|---|---|---|---|
| 32768 | 544 | 715 / 377 | 5,478 / 6,537 | 12,015 |
| 65536 | 1,088 | 971 / 633 | 6,278 / 7,337 | 13,615 |
| 131072 | 2,176 | 1,483 / 1,145 | 7,878 / 8,937 | 16,815 |
| 262144 | 4,352 | 2,507 / 2,169 | 11,078 / 12,137 | 23,215 |

- KV is exactly linear (544 → 1,088 → 2,176 → 4,352; ×2 per doubling).
- Compute is affine in ctx, with the **same slope on both devices** here
  (≈ 8 MiB per 1k tokens) and different intercepts (≈ 459 on GPU0, 121 on GPU1). On DSV4.1 the
  slope differs per device, so this is per model+placement — measure it.

## `ubatch` moves compute; `batch` does not

ctx 32768, KV q8_0, parallel 1:

| batch/ubatch | compute 0/1 | all |
|---|---|---|
| 512 / 512 | 715 / 377 | 12,015 |
| 1024 / 512 | 715 / 377 | 12,015 |
| 2048 / 512 | 715 / 377 | 12,015 |
| 2048 / 1024 | 1,053 / 625 | 12,601 |
| 3072 / 1536 | 1,391 / 873 | 13,187 |

- **`batch` alone changes nothing** in the buffer inventory (512 vs 2048 identical).
- **`ubatch` does**: +338 MiB on GPU0 and +248 on GPU1 per +512 ubatch, linear.
- Consequence: the learned key's `batch` token splits history for no memory reason; `ubatch` is the
  one that belongs in the identity. (Earlier "batch 2048 vs 8192 differ by 43 %" was an ubatch
  difference: 512 vs 1536.)

### The compute term is affine in ctx and ubatch — fitted per family

The 27B dense model gave an almost exactly proportional law for ubatch in its operating range
(4K → 8K doubled every buffer, x1.9999). DSV4.1 IQ2_XXS (MoE, 40 layers, boundary 22) does not:

| ctx | ub 512 | ub 1024 | ub 2048 |
|---|---|---|---|
| 65,536 | 1,121 / 1,892 | 2,098 / 3,688 | 4,112 / 7,328 |
| 131,072 | — | 3,543 / 6,349 | — |
| 262,144 | 3,638 / 5,938 | 5,985 / 11,609 | — |
| 524,288 | 6,982 / 11,331 | — | — |

(card0 / card1 compute MiB, batch 1024-4096 — batch moves nothing.)

- Doubling ubatch is **not** doubling compute: 1.87x at 65,536, 1.65x at 262,144. There is an
  ubatch-independent part, so a proportional factor over-predicts.
- The ubatch slope itself grows with ctx (card0: 1.91 MiB per ubatch token at 65,536, 4.59 at
  262,144), and compute is convex in ubatch (steps 977 then 2,014 at 65,536).
- The model is `compute_i = c0 + c1*ctx + c2*ubatch + c3*ctx*ubatch`, least squares over every
  measured point of the **family** (`model | provider | kv | topo | split | offload | cache_ram`,
  ctx and ubatch excluded). Fitted on seven of the eight points it predicts the eighth
  (65,536 @ ub 2048) at +3.1 % / -0.3 %; proportional scaling would have said 2,242 instead of
  2,098 at 65,536 @ ub 1024.
- **A `ubatch^2` term is deliberately absent.** Holding out the 2048 row, a quadratic fit
  predicts 5,699 / 1,768 — with three ubatch levels the top one *is* the curvature. Add it when a
  fourth level exists.
- **The ubatch shape is architecture-specific, and not even the same curvature.** Qwen3.8-Flash-Next
  (MoE, Q2_0) at one ctx (65,536) over four ubatch levels, card0 compute: 555.9 (512), 916.5
  (1024), 1637.9 (2048), 2856.5 (4096) MiB — ub 4096 costs **5.1x** the ub 512 value, not 8x, and
  the slope *falls* (0.70, 0.70, 0.60 MiB/ub) where DSV4.1's *rises* (1.91 then 3.93 at 65,536).
  A proportional factor over-predicts Flash by **+56 %** at ub 4096; the affine ubatch fit lands
  within ~5 %. One ctx cannot identify the plane, so that family falls through to
  `compute = c0 + c1*ub` instead.- **The law is per family, not global.** DSV4.1's affine plane is not Qwen3.8-27B's proportional
  line, and Qwen3.8-Flash will have its own. Families with fewer than four measured points keep
  the proportional fallback, so a new model starts simple and earns its coefficients.

## KV quantisation

ctx 32768, batch 2048/512, parallel 1:

| kv | KV/card | compute 0/1 | all |
|---|---|---|---|
| q4_0 | 288 | 715 / 377 | 11,503 |
| q8_0 | 544 | 715 / 377 | 12,015 |
| f16 | 1,024 | 628 / 290 | 12,801 |

- KV scales exactly with bits-per-element: q4_0 = 0.28125 × f16, q8_0 = 0.53125 × f16 (18/32 and
  34/32 bytes over 2 bytes). Predictable, no measurement needed beyond the f16 size.
- A quantised cache costs a little **compute** (f16 628 vs q8 715 on GPU0) — the dequant step is in
  the graph. Small, but in the direction of the fitted card.

## Requesting more context than the model has

`--ctx-size 1048576` on this 262,144-token model, `--parallel 1`, q8_0:

```
srv load_model: the slot context (1048576) exceeds the training context of the model (262144) - capping
srv load_model: initializing, n_slots = 1, n_ctx_slot = 262144, kv_unified = 'false'
GPU0: model 4,141 + KV 17,408 + compute 8,403 (+248)   GPU1: model 5,544 + KV 17,408 + compute 8,313
```

**The cap applies to the slot, not to the allocation.** KV was allocated for the requested 1M
(17,408/card = 4× the 4,352 at 262K), and compute grew 3.4×, for a context only a quarter of which
is usable. Total 61,466 MiB vs 23,215 at the same knobs with a 262K request. The forecast must
therefore treat "ctx above `n_ctx_train`" as fully allocated, not as capped.

## Distribution is not even

- Compute buffers are **not** split evenly and the skew is per model/placement, not a rule:
  Qwen3.8-27B at ctx 32K → **715 on GPU0 vs 377 on GPU1** (GPU0 heavier); DeepSeek-V4.1 at ctx
  262K → **5,989 on GPU0 vs 11,685 on GPU1** (GPU1 heavier, 2×). A 50/50 guess is wrong on both.
- Weights follow the layer split: DSV4.1 blocks grow 2.9 → 4.5 GiB, so 23/17 layers is
  81,241 / 75,728 MiB. Qwen's default split is 4,141 / 5,544 (fewer, smaller early layers).
- Painting a per-card forecast from a total split "by layer count" or 50/50 therefore invents GiB
  on whichever card carries less, in the direction that hides a spill.

## What follows for the forecast

1. **Compute must come from the engine, per device.** It is affine in ctx but the slope/intercept
   are per model+placement, and ubatch, KV quant and parallel all move it. The learned row already
   stores `gpu_components_mib` per device — use it, and treat a config with no row as unmeasured
   rather than guessing.
2. **FIT alone OOMs at the edge.** It has no parallel term and no compute buffers (10–15 GB on a
   model this size). It is a lower bound, not a forecast.
3. **Identity**: `ubatch` changes the footprint, `batch` does not; `parallel` has two regimes
   (explicit vs auto) and belongs in the identity only when it differs from the default; `-ts`
   changes the split, not the total, so it does not belong in the key — the split is planned from
   the layer table.
4. **Always pass `--parallel`** on a launch, even 1. Without it llama silently switches to 4 slots
   with a unified 4× cache.

## Snapshot + diff — the loop, in the app

No Python for the comparison: the app writes the snapshot, the same executable diffs it.

```powershell
python scripts/engine-test.py snapshot        # → {app_root}/config/cache/nvram/snap-<ts>.json
.\src-tauri\target\debug\blackwell-ops.exe --nvram-diff <before.json> <after.json> [--json]
```

One snapshot holds what the app can actually see: **NVML per device**, the **engine stack** (status,
knobs, and the launch's own per-device buffer inventory), the **learned rows** for those models with
their per-device components, the **per-device calibration**, and the **glass's published state**
verbatim. The diff prints only what moved, with each side's value; it matches engines by slot and
learned rows by identity (`ctx + kv + split + ubatch + par`), never by key — a knob change is exactly
when keys differ.

The rule carries over: **unknown is `null`, never `0`**. A diff with an unknown side reports the
values and no delta. Capture is also the IPC command `capture_nvram_snapshot` and the automation
action `snapshot`; snapshots land under `{app_root}/config/cache/nvram/`.

## Lifecycle captures (automatic)

Three snapshots now bracket every launch, so the overlay shows a launch as a flow instead of a
pair of hand-taken points:

| phase | when | what it answers |
|---|---|---|
| `pre_launch` | before the child is spawned | baseline: free/used per card before anything is allocated |
| `ready` | when the engine is up **and** its buffer inventory is parsed | what this config cost, per device |
| `stopped` | ~0.9 s after teardown | reclamation: did the VRAM come back |

Measured on this box (Nexus-TinyFunction 1.2B Q6_K, ctx 4096, q8_0, one card):

```
pre_launch   gpu0 1,314 / gpu1 1,314   (desktop + webview only)
ready        gpu0 2,461 / gpu1 2,423   → +1,147 / +1,109 MiB
             engine inventory           594.95 / 558.82 MiB
             residual                   ≈552 / ≈550 MiB per card
stopped      gpu0 1,314 / gpu1 1,314   (back to baseline, exactly)
```

The residual is the CUDA context plus allocator slack — **~550 MiB per card on this driver**, not
the ~1.5 GB a plan once reserved from stale samples and not the 12 MiB a baseline-less sample
claimed. It is now recorded from the pair (`pre_launch` → `ready`) as a calibration sample, so the
median the planner spends comes from a same-moment subtraction.

Files keep the last 60 under `{app_root}/config/cache/nvram/`; three per launch is ~20 launches of
history. The badge's `NVRAM LOG` overlay shows the newest three, oldest → newest, with per-column
deltas.

## WDDM reservation, and why TCC is not the answer

Measured on this box (2 × RTX PRO 6000, driver 616.92, idle, no engine):

```
nvidia-smi --query-gpu=index,driver_model.current,memory.total,memory.reserved,memory.used
0  WDDM  97887 MiB   Reserved 1314 MiB   Used 0 MiB
1  WDDM  97887 MiB   Reserved 1314 MiB   Used 0 MiB
```

- **The 1.3 GiB is a driver reservation, not a process.** `free = total − reserved`, and no
  application can allocate it. It does not move with load and there is no Windows switch for it.
- **NVML v1 `used` is `total − free`, so it includes the reservation.** The card now also reads
  `nvmlDeviceGetMemoryInfo_v2` and carries `memory_reserved` through `GpuInfo` into the topo:
  the hatched strip and its tooltip show the measured pool (1.3 GB here), not a constant. The
  fit gate still spends `free`, and the bar paints `used + need` against `total` — the same
  inequality (`used + need <= total` ⟺ `need <= free`) — so the reservation is counted once.
  It used to be counted twice: `used` (which includes it) plus a hardcoded 1.75 GiB constant,
  which painted a 1.3 GB idle card as 3%. The strip is drawn but never added to the total or
  subtracted from free again. The calibration pair cancels it by construction, because the
  residual is a `pre_launch` → `ready` delta on the same card.
- **TCC reclaims the reservation and is not free.** The app can switch modes from the HW monitor
  overclock module without a restart, and TCC drops occupancy to ~1 GiB — but TCC also caps the
  memory clock (~28,000 MT/s vs ~33,000 MT/s in WDDM, i.e. > 2 TB/s lost on this pair). For
  inference throughput that is the worse trade, so WDDM stays the default.
- **GeForce has no TCC at all.** On a 16 GiB consumer card the same fixed pool plus display
  overhead leaves ~14 GiB usable and there is nothing a user can do on Windows. The product can
  only say so: the reservation is the driver's, not ours.
- **Per-process VRAM is `N/A` on WDDM** (`gpu_process_mem`), which is why the residual has to be
  measured as a device delta around the launch rather than read from the process counter.

## Open questions

- Why the graph at 1 slot / 1M request is 3.4× the 256K graph (it looks sized by the requested ctx,
  not the usable one).
- Why parallel 32 is more expensive than parallel 16 per slot (graph replication? scheduling
  buffers?).
- Whether `batch` matters at high ctx (only measured to 32K; one 256K run with batch 512 vs 2048
  would settle it).
