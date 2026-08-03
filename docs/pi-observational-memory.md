# pi-observational-memory — tuning baseline

> Reference for how `pi-observational-memory` (v3) is tuned on this setup, and what
> to test/tune later. This is a **baseline**, not a target — we expect to iterate.

## Setup / hardware context

- **BRAIN** = `local`/`brain` (DS4, 524288 ctx, 262144 n_ctx) on `:8888` — the session model.
- **WORKER** = `worker`/`ENGINE_1` (27B Q4_K, 131072 ctx/slot, 4 slots) on `:9090`.
- Speed profile observed on BRAIN: slight drop ~75K, noticeable ~125K, **~150K is the sweet spot**.
- Goal: keep BRAIN fast while preserving fine detail across big refactors, without "dumbing down" BRAIN.

## The core idea

The extension does **three kinds of background memory work** on a token clock:

1. **Observer** (every `observeAfterTokens` raw tokens) — distills the un-compacted
   conversation chunk into timestamped observations. **Where fine detail is captured.**
   Smaller cadence = smaller chunks = more granular, detail-preserving capture.
2. **Reflector** (every `reflectAfterTokens`) — crystallizes durable reflections from observations.
3. **Dropper** (after reflections) — prunes observations deemed "covered" by reflections,
   down to `observationsPoolTargetTokens`. **The forgetting knob.**

Then **full compaction** fires at `compactAfterTokens` (only when idle): the entire raw
conversation collapses **instantly** into the prepared memory (reflections + active observation
pool). No re-summarization at compact time.

**Important:** the observer/reflector **prepare** memory but do **not** shrink the raw window.
The raw conversation stays until full compaction. The observation pool size IS how much fine
detail survives past the compaction point.

## Current config

Lives in `~/.pi/agent/settings.json` under `observational-memory`.

```json
{
  "observational-memory": {
    "observeAfterTokens": 15000,
    "reflectAfterTokens": 24000,
    "compactAfterTokens": 150000,
    "compactAfterTokensMode": "calibrated",
    "observationsPoolMaxTokens": 32000,
    "observationsPoolTargetTokens": 24000,
    "agentMaxTurns": 24,
    "model": {
      "provider": "worker",
      "id": "ENGINE_1",
      "thinking": "low"
    },
    "passive": false,
    "debugLog": false
  }
}
```

### Why these numbers

| Setting | Value | Reasoning |
|---|---|---|
| `compactAfterTokens` | **150000** | Full-compaction point. BRAIN's ~150K sweet spot — keeps it fast while giving refactor headroom. |
| `compactAfterTokensMode` | `calibrated` | Uses `compactAfterTokens` directly (exact, predictable). |
| `observeAfterTokens` | 15000 | Granular enough to catch refactor fine-detail; not so frequent it thrashes. |
| `reflectAfterTokens` | 24000 | Crystallize slightly after observations accumulate. |
| `observationsPoolMaxTokens` | 32000 | Detail budget that survives compaction. |
| `observationsPoolTargetTokens` | 24000 | **Forgetting knob** — raised to keep ~2.4× more fine detail than default (10K). |
| `agentMaxTurns` | 24 | Enough turns to fully cover rich refactor chunks. |
| `model` | worker/ENGINE_1 | **All memory work runs on WORKER** — keeps BRAIN 100% on the actual task (no dumbing down). |
| `passive` | false | Background observation/reflection/compaction active. |

### Config notes / gotchas

- **Proactive compaction fires even with pi's autocompact OFF.** The extension's trigger calls
  `ctx.compact()` directly, gated only by `passive`, **not** by pi's `settings.compaction.enabled`.
  So `compactAfterTokens` controls the extension's own compaction regardless of that setting.
- `observationsPoolTargetTokens` must be `< observationsPoolMaxTokens` (extension enforces it).
- `compactAfterTokensMode: "ratio"` is the alternative: threshold =
  `floor(contextWindow * compactAfterTokensRatio)`. `calibrated` is used here for an exact 150K.
- If `model` is omitted, memory workers use the **session model** (BRAIN) — which competes with
  the actual work. Setting it to the WORKER is the whole point of the topology.
- WORKER's registered `contextWindow` in `~/.pi/agent/models.json` must match reality (currently
  131072). If the worker slot config changes, update it or the observer input may be underestimated.

## Tuning levers (test these later)

| Want | Adjust | Direction |
|---|---|---|
| Earlier/later full compaction | `compactAfterTokens` | ↓ to compact sooner (faster, less detail); ↑ for more raw headroom |
| More fine-detail retention | `observationsPoolTargetTokens` (+ `observationsPoolMaxTokens`) | ↑ keeps more observations past compaction |
| Less forgetting by dropper | `observationsPoolTargetTokens` | ↑ (dropper prunes toward this) |
| More granular capture | `observeAfterTokens` | ↓ (smaller chunks, more runs — more worker load) |
| Fewer reflection passes | `reflectAfterTokens` | ↑ |
| More thorough worker coverage | `agentMaxTurns` | ↑ (cost: more worker tokens/time) |
| Keep memory off BRAIN | `model` | keep pointed at `worker`/`ENGINE_1` |

## Testing plan

1. Run a long refactor-heavy session past the 150K mark; verify:
   - BRAIN stays responsive (compare against the 125K / 150K / 200K speed profile).
   - After a full compaction at 150K, the agent still recalls fine details (file paths, exact
     decisions, supersessions) via `/om:view` and the `recall` tool.
2. Check `/om:status` for:
   - active observation pool vs target (24000) — is the dropper trimming too much/little?
   - last observer/reflector/dropper errors.
3. If detail loss is observed: raise `observationsPoolTargetTokens` toward max, or lower
   `observeAfterTokens` to 10000.
4. If BRAIN still feels slow: lower `compactAfterTokens` toward 125K–130K.
5. If the worker becomes the bottleneck (memory work queuing on 4 slots): raise `reflectAfterTokens`
   / `observeAfterTokens`, or lower `agentMaxTurns`.

## Where things live

- Config: `~/.pi/agent/settings.json` → `observational-memory` block.
- Model registry: `~/.pi/agent/models.json` (`local`/`brain`, `worker`/`ENGINE_1`).
- Extension package: `~/.pi/agent/npm/node_modules/pi-observational-memory/` (v3.0.3).
- Extension docs: `README.md`, `docs/configuration.md` inside the package.
- Backups taken before edits: `~/.pi/agent/settings.json.ombak`, `~/.pi/agent/models.json.ombak`.
