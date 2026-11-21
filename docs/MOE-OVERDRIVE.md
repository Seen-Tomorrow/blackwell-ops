# MOE OVERDRIVE — design and state

One screen for one question: **run this MoE model as fast as this rig allows.** It is deliberately
separate from the forecast, which answers the other question (where do the layers go when several
models share a machine). If this path dies, delete `MoeOverdrive.tsx`, `moeOverdriveRun.ts`,
`moe_overdrive.rs` and the `.moe-od-*` / `.vram-fc-overdrive-entry*` blocks in
`fusion-display.css` — the forecast keeps working.

## The idea

Large local MoE models are usually run alone, and the only goal is speed. When the expert weights do
not fit in VRAM, the fastest configuration is usually **experts in host RAM plus an expert cache in
VRAM** (`-cmoe` + `--moe-cache-mib`), sized from what the launch actually leaves free — not a
forecast. OVERDRIVE measures that, keeps the result per launch shape, and reloads the model tuned.

## The run (one action)

`OVERDRIVE` (the right half of the launch button) and `RUN OVERDRIVE` on the screen both start the
same cycle. The screen is the only place the cycle is driven from; the module
`src/lib/moeOverdriveRun.ts` owns the state machine, so the panel and the screen cannot disagree.

```
click OVERDRIVE
  │
  ├─ seat check: stop a running engine of THIS model; refuse if another model is loaded
  ├─ stored calibration for this shape?  ── yes ── load with its cache · bench · compare
  │                                         no
  ├─ load cache 0 (-cmoe)        [ real boot screen, STOP = abort ]
  ├─ probe PP/TG               → free after the real launch
  ├─ baseline TG bench         → tps before · card + host memory before
  ├─ cache = min(free − 512, host expert pool)
  ├─ save the calibration       (so a failed tuned load is not a lost measurement)
  ├─ stop · load with the cache  [ real boot screen, STOP = abort ]
  ├─ tuned TG bench            → tps after · card + host memory after
  ├─ save the full record
  └─ print BEFORE → AFTER and stay until ← FORECAST
```

- **One click** from a cold first launch to the tuned engine. RECALIBRATE forces the measurement
  again (ignores the stored record); RUN (STORED CACHE) is the one-load fast path.
- **The real boot instrument runs on both loads** — the same `FusionBooter` the fusion view uses
  (phases, GPU VRAM, NVMe read, STOP). STOP aborts the run and restores the knobs it started with.
- **The cache is capped by the expert pool**, not just by free VRAM: caching more MiB than the
  host-resident experts is impossible and only eats the reserve.
- **Comparison**: TG t/s, card VRAM used, host RAM and the cache setting, before vs after. Card
  VRAM is NVML used (the engine's `/memory` ledger does not account for the expert cache — it lands
  in "unaccounted"). Both sides include any other app on the card, so the delta is the run's.
- **Identity = the launch shape**: model path+size, ctx, KV quant, split, the launch's GPU set
  (from the panel's device/split config — never the selected slot), draft identity and n-max. The
  record survives stopping the engine that measured it.
- **RESET** clears the record and restores the plain path (`cpu_moe=off`, cache 0, share 0). The
  engine keeps running until the user stops it; the next launch is plain.

## What is wired (2026-11-21)

| piece | state |
|---|---|
| Learned-key namespace `|experts=cpu-cache:<mib>` | **done** — a cache launch records its own key, and the forecast now asks for the same regime (`get_learned_vram` takes cpu_moe/cache), so it stops painting the plain footprint over a CPU-expert launch |
| Record per shape (`config/cache/moe-overdrive/<hash>.json`) | **done** — free PP/TG, cache, reserve, before/after t/s, card/host memory, engine, driver, age |
| One-click cycle (calibrate → write → tuned relaunch → bench → compare) | **done** — `moeOverdriveRun.ts`; abort stops the load and restores the knobs |
| Both loads use the real boot screen | **done** — `FusionBooter` inside the screen; STOP = abort |
| Forecast badge entry | **done** — one `MOE OVERDRIVE →` button opens the screen; no FORECAST/OVERDRIVE toggle and no badge SIZE/optimizer block |
| OVERDRIVE launch does not inherit the plain-launch fit gate | **done** — the overdrive half stays enabled when the forecast says the plain launch does not fit; that is the case it exists for |
| **Forecast suggestion chip** | **not built** — planned: shown only when `n_expert>1` and the verdict is offload/nofit, `OVERDRIVE → experts don't fit; cache them instead` |
| Diagram strip (four panels, cache number between 3 and 4, t/s in 4) | **not built** |

## Behaviour rules

- **Never auto-enter.** The badge entry opens the screen; the run starts on an explicit click.
- **AUTOPILOT**: OVERDRIVE is not offered (launch half hidden, badge entry disabled).
- **Fusion never steals the screen while OVERDRIVE is on** (the badge checks the flag before the
  fusion early-return, and the forecast layout does the same).
- **The run owns the knobs.** It writes `cpu_moe=on`, the cache it is loading and share 0 before
  each launch, so the switch, the learned key, the screen and the next regular launch read the same
  regime. An abort restores the pre-run values.
- Exit keeps `cpu_moe=on` and the measured cache (that is the product); RESET is the way back.
- **Scope today: one GPU.** The probe sizes from the launch's first GPU (`gpuMask` first index) and
  the cache is a single `--moe-cache-mib`; a multi-GPU split launch is measured on its first card.
  Revisit before trusting it for a layer-split cache.

## Limits

- The run is driven from the page: closing the app mid-run leaves the loading engine to the engine
  rail (STOP still works); the knobs are not restored automatically in that case.
- The cache fills lazily; the "after" card VRAM is what the bench actually touched, while the cache
  row is the cap the launch was given.
- The bench is `cmd_burst_bench` at 1024 generated tokens, no warmup, code prompt — the same
  primitive the bench tray uses.

## Testing the run

1. Pick a MoE model, ASSISTED. Click `OVERDRIVE` on the launch button.
2. Watch the calibration load on the real boot screen (cache 0). STOP aborts and restores.
3. `PROBING`, `BASELINE BENCH`; then the tuned load (cache from the probe) on the boot screen.
4. `TUNED BENCH` → the screen prints `calibration → tuned`: TG t/s, card VRAM, host RAM, cache.
5. Leave with `← FORECAST`. The tuned engine keeps running; later `RUN (STORED CACHE)` is one load.
6. `RECALIBRATE` measures again; `RESET` clears the record and returns the next launch to plain.
