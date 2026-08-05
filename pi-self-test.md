# PI parallel fan-out self-test

Fire this from inside the app-integrated PI (the Blackwell-launched one) to confirm
the parallel subagent fan-out topology is wired correctly.

**How to run:** paste the whole file (or the one-shot block below) into PI as a single
message. It does NOT modify any project files — it only reads and writes throwaway
temp files under the OS temp dir, then reports.

**Fan-out works in BOTH launch modes.** Concurrency is driven by the running engine's
`--parallel` slot count (not hardcoded ×4).

- **Twin** (`brain_workers`): BRAIN = `local` (big-context orchestrator), WORKER =
  `worker` = a separate leaner engine with N slots. Subagents fan out across those N
  slots.
- **Solo** (single engine): `worker` aliases the SAME engine as `local`. A solo engine
  running N slots fans out N **equal-capability** workers across those N slots (NOT
  "1× brain + N−1 virtual workers" competing for the same slots).

---

## What it verifies

1. **Routing** — you (BRAIN) resolve to the `local` provider; the `worker` subagent
   resolves to the `worker` provider (twin) or the same `local` engine (solo).
2. **Parallel fan-out** — PI dispatches N independent workers concurrently across the
   engine's slots and each reports back through `contact_supervisor`.
3. **Result collection** — BRAIN gathers all workers' outputs and confirms none failed.

---

## One-shot block (paste this whole thing)

> Run a parallel fan-out self-test. Do NOT touch any files in the current project. Use
> only the OS temp dir for scratch.
>
> Steps:
> 1. Confirm your own (parent) model resolves to the `local` provider / BRAIN engine.
>    Check the subagent config concurrency: `{home}/agent/extensions/subagent/config.json`
>    `parallel.concurrency` / `globalConcurrencyLimit` — these equal the engine slot count.
> 2. Launch a PARALLEL fan-out of `worker` subagents via the `subagent` tool with
>    `action: "parallel"` and `tasks: [...]`. Use `concurrency` = the engine's slot count
>    (read it from the config.json above, or `{engine}/slots`). Give each worker a distinct
>    lane so they don't collide: worker N writes its own scratch file
>    `%TEMP%/pi-selftest/w{n}.txt` containing a one-line proof string like
>    `worker-{n}-ok-{random}` and returns that string as its result. Read-only is fine too
>    if the worker agent lacks write tools — in that case have each worker just return its
>    lane id + a computed value. Prefer `async: false` so the run completes before you report.
> 3. Wait for all workers, collect their returned results, and verify all N distinct worker
>    lane outputs came back (no failures / no timeouts).
> 4. Report a concise PASS/FAIL summary table: parent model, worker model, number of workers
>    dispatched, number of distinct results collected, and any errors.
> 5. Clean up the scratch dir `%TEMP%/pi-selftest` afterward.
>
> If any worker fails to spawn or the `subagent` tool is missing, report that explicitly
> (it means the pi-subagents routing is NOT installed).

---

## What a PASS looks like

Twin:

```
PASS
  parent (BRAIN) model : local/<brain-alias>
  worker model         : worker/<worker-alias>
  dispatched           : N
  distinct results     : N (worker-0-ok-…, worker-1-ok-…, …, worker-(N-1)-ok-…)
  failures             : 0
  routing              : BRAIN→WORKER fan-out OK
```

Solo (single engine):

```
PASS
  parent (BRAIN) model : local/<alias>
  worker model         : local/<alias>   (same engine, equal capability)
  dispatched           : N
  distinct results     : N (worker-0-ok-…, …, worker-(N-1)-ok-…)
  failures             : 0
  routing              : solo equal-capability fan-out OK
```

## What a FAIL looks like

```
FAIL — subagent tool not available
  The `subagent` tool is missing. The pi-subagents extension is not loaded.
  Check that pi-home/settings.json contains "packages": ["./pi-subagents"]
  and that pi-home/pi-subagents/ exists.
```

---

## Optional: repeatable short form

If you want a one-liner you can fire quickly, paste:

> Run the PI parallel fan-out self-test: fan out `worker` subagents equal to the engine's
> slot count (each writes a distinct throwaway file under the OS temp dir and returns its
> lane id), collect all results, and report a PASS/FAIL table. Don't touch project files.
> Clean up scratch.
