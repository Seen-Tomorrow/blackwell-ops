# MOE OVERDRIVE — design and state

One screen for one question: **run this MoE model as fast as this rig allows.** It is deliberately
separate from the forecast, which answers the other question (where do the layers go when several
models share a machine). If this path dies, delete `MoeOverdrive.tsx`, `moe_overdrive.rs`,
`moe_overdrive_state` and the `.moe-od-*` block in `fusion-display.css` — nothing else depends on it.

## The idea

Large local MoE models are usually run alone, and the only goal is speed. When the expert weights do
not fit in VRAM, the fastest configuration is usually **experts in host RAM plus an expert cache in
VRAM** (`-cmoe` + `--moe-cache-mib`), sized from what the launch actually leaves free — not a
forecast. OVERDRIVE measures that and keeps the result.

## The flow

```
LAUNCH [ OVERDRIVE ]                       (cockpit, MoE model, ASSISTED only)
        │
        ├─ no stored record ──────────────────────────────────────────────┐
        │   load cache 0 (-cmoe)      [boot widget + STOP]                │
        │   probe PP (long prompt)    → free after prefill                │
        │   probe TG (64 tokens)      → free after generation             │
        │   cache = min(freePP, freeTG) − 512                             │
        │   save record · write knobs (cpu_moe=on, cache, share=0)        │
        │   relaunch with cache        [boot widget + STOP]               │
        │   TG bench → cached t/s · compare with cache-0 t/s              │
        └──────────────────────────────────────────────────────────────────┘
        │
        └─ stored record ── load with the saved cache (one load) · bench · compare

STAY on the screen after the run: ledger, dial, RECALIBRATE, RESET.
Leave with ← FORECAST. Later launches reuse the saved knobs and record.
```

The bench numbers come from the **existing TG bench** (same path as the bench tray); the PP/TG probe
is only for sizing. RESET clears the record **and** restores `cpu_moe=off`, cache 0, share 0.

## What is wired (2026-11-21)

| piece | state |
|---|---|
| Learned-key namespace `|experts=cpu-cache:<mib>` | **done** (`ecfd079fb`) — a cache launch can no longer teach the forecast that a plain launch fits |
| Record per shape (`config/cache/moe-overdrive/<hash>.json`) | **done** (`fca3299b9`) — identity = model+size, ctx, kv, split, GPU mask, draft, n-max; stores free PP/TG, cache, reserve, before/after t/s, engine, driver |
| Split LAUNCH button (left regular, right OVERDRIVE) | **done** (`a4ef905ff`) — right half forces `cpu_moe=on`, cache 0 or the record, share 0, opens the screen, launches through the normal engine path |
| Screen reads/saves the record, RESET restores the plain path | **done** (`66639c48c`) |
| Probe + SIZE (PP/TG, tighter number, reserve) | **done** (`b6b2e30ec`, `7a12e5cd5`) |
| Ledger bar (weights/KV/compute/cache/free) | **done** — reads `/memory` of the loaded engine |
| **Automatic cycle** (calibrate → write → relaunch → bench → compare) | **not built** — today the user presses PROBE + SIZE, then WRITE, then relaunches |
| **Before/after TG bench in the record** | **not built** (fields exist, both null) |
| **Forecast suggestion chip** | **not built** — planned: shown only when `n_expert>1` and the verdict is offload/nofit, `OVERDRIVE → experts don't fit; cache them instead` |
| Diagram strip (four panels, cache number between 3 and 4, t/s in 4) | **not built** |

## Behaviour rules

- **Never auto-enter.** The suggestion is a chip; the user clicks it.
- **AUTOPILOT**: the OVERDRIVE half of the button is hidden while `fullAutoMode` is on.
- **Fusion never steals the screen while OVERDRIVE is on** (the badge checks the flag before the
  fusion early-return, and the forecast layout does the same). This stays, since the screen has no
  auto-exit.
- **A plain launch is never repainted as a fit.** A stored record only adds the measured
  alternative line, never a green verdict for a launch shape that does not fit.
- Exit keeps `cpu_moe=on` and the measured cache (that is the product); RESET is the way back.

## Testing the manual loop today

1. Pick a MoE model, ASSISTED. Click `OVERDRIVE` on the launch button.
2. The engine loads with `cpu_moe=on`, cache 0, share 0; the screen shows the ledger bar.
3. `PROBE + SIZE` — the button says PROBING… while the paged passes run. Result:
   `PP 8,342 · TG 8,118 free → cache 7,918 (reserve 512)`.
4. `APPLY`/`WRITE` — writes the knobs and the record.
5. Relaunch (regular LAUNCH is fine; the knobs persist). The screen shows the stored line
   `stored: cache 7,918 MiB · free 8,118 after load · 3m ago`.
6. `RESET` — record gone, `cpu_moe=off`, cache 0: the next launch is the plain one.

Note: `PROBE + SIZE` needs the engine **loaded**, and `-cmoe` on. With the model loaded fully on the
GPU (cpu_moe off) the screen explains it and offers `ENABLE CPU MOE` instead of pretending to size.
