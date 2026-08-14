# Mission Control — Agentic Harness Dashboard

> **Status:** Planned feature. This document is a goal, architecture plan, and implementation brief for a future session.
> **Owner:** Blackwell Ops team
> **Created:** 2026-08-11

---

## 1. Goal

Build a **Mission Control** dashboard inside Blackwell Ops that provides real-time visibility into pi's agentic harness activity — what each subagent is doing, which model it's using, how many turns/tools/tokens it has consumed, what files it has changed, and whether it succeeded or failed — without requiring the user to switch to a terminal or read raw JSONL files.

### The one-line pitch

> See every pi subagent as a live card on your dashboard: agent type, model, progress, tools used, files touched, and final output — updated in real time, zero config.

---

## 2. Why this matters

### Current state

Blackwell Ops launches pi as a coding harness for the Brain/Worker seat architecture. When pi spawns subagents (worker, reviewer, planner, etc.), the user has **zero visibility** into what those subagents are doing:

- Pi is spawned as a **fully detached console** (`stdin/stdout/stderr` → `null`, `CREATE_NO_WINDOW`)
- No pipes, no IPC channel, no WebSocket, no HTTP endpoint
- The app writes `models.json` + `settings.json` to disk, launches `pi run`, and forgets the PID
- `PiCodeStatus` reports only static install metadata (version, paths) — nothing about runtime activity

### What pi already produces (sitting unread on disk)

Pi's subagent extension writes rich structured data to `%TEMP%\pi-subagents-user-{user}\`:

| File | Contents |
|------|----------|
| `async-subagent-runs/{run-id}/status.json` | Agent name, model, state, turnCount, toolCount, tokens, timestamps, cwd, steps[], acceptance status |
| `async-subagent-runs/{run-id}/events.jsonl` | 17 event types: `run.started`, `step.started`, `tool_execution_start/end`, `turn_start/end`, `message_start/end`, `agent_start/end/settled`, `subagent.run.completed` |
| `async-subagent-runs/{run-id}/output-{n}.log` | Full subagent transcript: task, thinking, tool calls, final output, acceptance reports |
| `async-subagent-runs/{run-id}/subagent-log-{id}.md` | Human-readable summary |
| `async-subagent-runs/{run-id}/process-terminal.json` | Process exit state, exit code, resume disposition |
| `run-history.jsonl` (at pi-home) | Per-run summary: agent, taskHash, ts, status, duration |

**Blackwell Ops reads none of these files.**

### Competitive gap

No other local LLM harness (LM Studio, Ollama, Jan, GPT4All, KoboldCpp) offers multi-engine orchestration with subagent visibility. The Brain/Worker architecture is already unique — Mission Control makes it *visible* and *controllable*.

---

## 3. Architecture

### 3.1 Data pipeline: File-system watcher (Rust backend)

**No changes to pi itself are needed.** All data is already on disk. We add a watcher + parser on the Blackwell Ops side.

```
┌─────────────────────────────────────────────────────────┐
│  pi process (detached console)                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐     │
│  │  subagent   │  │  subagent   │  │  subagent   │     │
│  │  (worker)   │  │  (reviewer) │  │  (planner)  │     │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘     │
│         │                │                │            │
│         ▼                ▼                ▼            │
│  %TEMP%\pi-subagents-user-{user}\                      │
│  ┌──────────────────────────────────────────────┐      │
│  │  async-subagent-runs/                        │      │
│  │    {run-id-1}/                               │      │
│  │      status.json      ← structured state     │      │
│  │      events.jsonl     ← real-time events     │      │
│  │      output-0.log     ← full transcript      │      │
│  │    {run-id-2}/                               │      │
│  │      ...                                     │      │
│  └──────────────────────────────────────────────┘      │
└──────────────────────────┬─────────────────────────────┘
                           │
                           │ notify::Watcher (debounced)
                           │ + JSON parser
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Blackwell Ops backend (Rust / Tauri)                    │
│  ┌─────────────────────────────────────────────┐        │
│  │  pi_harness.rs (NEW MODULE)                  │        │
│  │  ├─ PiHarnessWatcher                         │        │
│  │  │   ├─ discover_temp_dirs()                 │        │
│  │  │   ├─ watch_run_dirs()  ← notify::Watcher  │        │
│  │  │   ├─ parse_status_json()                  │        │
│  │  │   ├─ tail_events_jsonl()                  │        │
│  │  │   └─ read_output_log()                    │        │
│  │  ├─ PiRunState                                │        │
│  │  │   ├─ run_id, agent, model, cwd             │        │
│  │  │   ├─ state: Running|Complete|Failed|...     │        │
│  │  │   ├─ turns, tools, tokens, duration        │        │
│  │  │   ├─ steps[] (for chains)                  │        │
│  │  │   ├─ current_tool, last_activity           │        │
│  │  │   └─ acceptance_status                     │        │
│  │  └─ emit_to_frontend()  ← Tauri event         │        │
│  └─────────────────────────────────────────────┘        │
└──────────────────────────┬─────────────────────────────┘
                           │
                           │ Tauri event stream
                           │ "pi-harness-update"
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  Frontend (React / TypeScript)                           │
│  ┌─────────────────────────────────────────────┐        │
│  │  HarnessDashboard.tsx (NEW COMPONENT)        │        │
│  │  ├─ RunCard[]                               │        │
│  │  │   ├─ Agent badge (worker/reviewer/etc)   │        │
│  │  │   ├─ Model pill                          │        │
│  │  │   ├─ State indicator (● running / ✓ / ✗) │        │
│  │  │   ├─ Progress: turns / tools / tokens    │        │
│  │  │   ├─ Duration timer                      │        │
│  │  │   └─ CWD path                            │        │
│  │  ├─ EventTimeline (tool calls, turns)       │        │
│  │  ├─ OutputViewer (final transcript)         │        │
│  │  └─ AcceptanceReport (pass/fail + evidence) │        │
│  └─────────────────────────────────────────────┘        │
└─────────────────────────────────────────────────────────┘
```

### 3.2 Connection strategy

| Layer | Mechanism | Frequency | Latency |
|-------|-----------|-----------|---------|
| **Run discovery** | `notify::Watcher` on `%TEMP%\pi-subagents-*\async-subagent-runs\` | Event-driven (new dir created) | < 500ms |
| **State updates** | Watch `status.json` for changes (mtime + size) | Event-driven (file write) | < 250ms |
| **Event stream** | Tail `events.jsonl` (seek to last known offset) | Poll every 500ms during active runs | ~500ms |
| **Output on completion** | Read `output-{n}.log` when `state=complete` | One-shot after completion | Instant |
| **Run history** | Parse `run-history.jsonl` at app startup | One-shot at launch | Instant |

### 3.3 Tauri event contract

Backend emits to frontend via `Tauri event`:

```typescript
// Event name
"pi-harness-update"

// Payload
interface PiHarnessUpdate {
  type: "run_started" | "run_state_changed" | "run_completed" | "run_failed" | "event_batch";
  runId: string;
  state?: PiRunState;
  events?: PiEvent[];        // For "event_batch" type
  output?: string;           // For "run_completed" type (full transcript)
}

interface PiRunState {
  runId: string;
  sessionId: string;
  agent: string;             // "worker" | "reviewer" | "planner" | "scout" | ...
  model: string;             // "local/DS4 Q8/Q4:medium"
  mode: "single" | "chain" | "parallel";
  state: "starting" | "running" | "complete" | "failed" | "stopped" | "paused";
  cwd: string;
  startedAt: number;         // epoch ms
  endedAt?: number;
  lastActivityAt: number;
  durationMs?: number;
  turnCount: number;
  toolCount: number;
  tokens: { input: number; output: number; total: number };
  currentTool?: string;
  currentToolStartedAt?: number;
  steps?: PiStepSummary[];   // For chains
  acceptance?: {
    status: "pending" | "auto" | "attested" | "checked" | "verified" | "rejected";
    criteria?: AcceptanceCriterion[];
  };
}

interface PiEvent {
  type: string;              // "tool_execution_start" | "turn_end" | "message_end" | ...
  ts: number;
  toolName?: string;
  toolArgs?: string;
  turnIndex?: number;
  message?: string;          // Truncated
  isError?: boolean;
}
```

---

## 4. Feature set

### 4.1 Live Run Cards (primary view)

Each active or recent subagent run appears as a card:

```
┌──────────────────────────────────────────────────┐
│  🤖 WORKER                          ● running    │
│  model: DS4 Q8/Q4:medium                         │
│  cwd: C:\Users\...\blackwell-ops                 │
│  ─────────────────────────────────────────────   │
│  Turns: 6    Tools: 5    Tokens: 12.4k          │
│  Duration: 1:09                                  │
│  ─────────────────────────────────────────────   │
│  Last tool: bash (cargo build)                   │
│  Files changed: solution.rs, main.rs             │
└──────────────────────────────────────────────────┘
```

Card states:
- **Running** — pulsing indicator, live counters updating
- **Complete** — green check, shows acceptance status
- **Failed** — red X, shows error
- **Paused/Stopped** — grey, shows last activity

### 4.2 Event Timeline

Below each run card (or in a detail panel), a chronological feed of events:

```
[08:49:45] ▶ Run started (agent: worker, mode: single)
[08:49:46] ▶ Step started (step 0)
[08:49:46] ▶ Agent start
[08:49:47] ▶ Turn 1 start
[08:49:48]   ├─ Tool: read (src/lib/types.ts)
[08:49:52]   ├─ Tool: read (src/services/vram/scenarios/scenario_a.ts)
[08:49:58] ▶ Turn 1 end
[08:49:59] ▶ Turn 2 start
[08:50:01]   ├─ Tool: edit (src/lib/types.ts) — 1 change
[08:50:15]   ├─ Tool: bash (cargo build)
[08:50:42] ▶ Turn 2 end
...
[08:51:09] ▶ Agent settled
[08:51:09] ▶ Run completed (exit: 0, duration: 1:09)
```

### 4.3 Output Viewer

On completion, show the full `output-{n}.log`:
- Syntax-highlighted code blocks
- Collapsible thinking sections
- Tool call results
- Final acceptance report rendered as a structured table

### 4.4 Acceptance Report

When a subagent run includes an acceptance contract, render it as a pass/fail dashboard:

```
Acceptance: ✓ CHECKED
┌──────────────┬──────────┬──────────────────────────┐
│ Criterion    │ Status   │ Evidence                 │
├──────────────┼──────────┼──────────────────────────┤
│ criterion-1  │ ✓ Pass   │ Changed 2 files...       │
│ criterion-2  │ ✓ Pass   │ 5 commands run, all pass │
└──────────────┴──────────┴──────────────────────────┘
```

### 4.5 Aggregated Stats (top bar)

```
Active runs: 2   │   Completed (session): 8   │   Failed: 1
Total turns: 47  │   Total tools: 38          │   Total tokens: 89.2k
Avg duration: 1:23
```

### 4.6 Chain / Parallel Visualization (advanced)

For chain and parallel runs, show a graph:

```
Chain:
  [Step 0: researcher] → [Step 1: planner] → [Step 2: worker] → [✓ checkpoint]
     ✓ complete            ● running            ○ pending

Parallel (×3):
  [worker ×1] ─┐
  [worker ×2] ─┼─→ [reviewer] → ✓
  [worker ×3] ─┘
     ✓             ✓            ○
```

### 4.7 Integration with existing UI

| Existing component | Integration point |
|--------------------|-------------------|
| `RunningEnginesPanel.tsx` | Add "View pi activity" button per engine |
| `MultiAgentBooster.tsx` | Show harness dashboard link after launch |
| `EngineBoostSection.tsx` | Show active subagent count badge |
| `Playground.tsx` | Optional: show last pi run output in chat context |

---

## 5. Implementation plan

### Phase 1: Data pipeline (Rust backend)

**New module:** `src-tauri/src/pi_harness.rs`

| Task | Details | Files |
|------|---------|-------|
| 1.1 | Discover pi temp directories (`%TEMP%\pi-subagents-*`) | `discover_temp_dirs()` |
| 1.2 | Set up `notify::Watcher` on `async-subagent-runs/` | `watch_run_dirs()` |
| 1.3 | Parse `status.json` → `PiRunState` struct | `parse_status_json()` |
| 1.4 | Tail `events.jsonl` with offset tracking | `tail_events_jsonl()` |
| 1.5 | Read `output-{n}.log` on completion | `read_output_log()` |
| 1.6 | Parse `run-history.jsonl` at startup | `load_run_history()` |
| 1.7 | Emit Tauri events `pi-harness-update` | `emit_to_frontend()` |
| 1.8 | Cleanup on app shutdown | Drop watcher, clear state |

**Dependencies:** `notify` (already in `Cargo.toml`), `serde_json` (already present)

**Estimated effort:** 1 session (~4-6 hours)

### Phase 2: Frontend dashboard

**New components:** `src/components/HarnessDashboard.tsx`, `src/components/HarnessRunCard.tsx`, `src/components/HarnessEventTimeline.tsx`, `src/components/HarnessOutputViewer.tsx`

| Task | Details | Files |
|------|---------|-------|
| 2.1 | TypeScript types for `PiRunState`, `PiEvent`, `PiHarnessUpdate` | `src/lib/piHarnessTypes.ts` |
| 2.2 | Subscribe to Tauri event `pi-harness-update` | Custom hook `usePiHarness()` |
| 2.3 | Run card grid layout (responsive) | `HarnessDashboard.tsx` |
| 2.4 | Live state indicators + counters | `HarnessRunCard.tsx` |
| 2.5 | Event timeline (collapsible) | `HarnessEventTimeline.tsx` |
| 2.6 | Output viewer with syntax highlighting | `HarnessOutputViewer.tsx` |
| 2.7 | Acceptance report renderer | Inline in `HarnessRunCard.tsx` |
| 2.8 | CSS tokens (theme-aware) | `src/styles/pi-harness.css` |

**Estimated effort:** 1-2 sessions (~6-10 hours)

### Phase 3: Integration & polish

| Task | Details |
|------|---------|
| 3.1 | Add "Mission Control" nav item or tab in existing panel |
| 3.2 | Badge on `RunningEnginesPanel` showing active subagent count |
| 3.3 | Toast notification on run completion/failure |
| 3.4 | Persist last N runs in frontend state (survive app restart) |
| 3.5 | Chain/parallel graph visualization |
| 3.6 | Filter/sort by agent type, state, time range |

**Estimated effort:** 1 session (~4-6 hours)

---

## 6. Key data structures

### `status.json` fields we care about (from actual pi output)

```json
{
  "runId": "321a01f8-6df8-4f7b-a831-69605008652c",
  "sessionId": "C:\\...\\sessions\\...\\2026-08-11T08-43-49.jsonl",
  "mode": "single",
  "state": "complete",
  "pid": 31000,
  "cwd": "C:\\tmp\\TEST",
  "startedAt": 1786438185283,
  "endedAt": 1786438254913,
  "lastActivityAt": 1786438254697,
  "turnCount": 6,
  "toolCount": 5,
  "totalTokens": { "input": 0, "output": 0, "total": 0 },
  "steps": [{
    "agent": "worker",
    "description": "Work only inside directory C:/tmp/TEST/runs/MEDIUM...",
    "status": "complete",
    "model": "local/DS4 Q8/Q4:medium",
    "thinking": "medium",
    "turnCount": 6,
    "toolCount": 5,
    "startedAt": 1786438185290,
    "endedAt": 1786438254900,
    "durationMs": 69610,
    "exitCode": 0,
    "recentTools": ["bash", "read", "edit", "write"],
    "acceptance": {
      "status": "checked",
      "criteria": [...]
    }
  }]
}
```

### `events.jsonl` event types

| Event | When | Key fields |
|-------|------|------------|
| `subagent.run.started` | Run begins | runId, mode, cwd, pid |
| `subagent.step.started` | Chain step begins | runId, stepIndex, agent |
| `session` / `session_info_changed` | Subagent session created | name, subagentAgent |
| `agent_start` / `agent_end` / `agent_settled` | Agent lifecycle | — |
| `turn_start` / `turn_end` | Each LLM turn | turnIndex, message, toolResults |
| `tool_execution_start` / `_update` / `_end` | Each tool call | toolCallId, toolName, args, result, isError |
| `message_start` / `message_update` / `message_end` | Message streaming | message |
| `subagent.step.completed` | Chain step done | — |
| `subagent.run.completed` | Run done | — |
| `subagent.run.process_terminal` | Process exited | exitCode, signal |

---

## 7. Edge cases & considerations

| Concern | Mitigation |
|---------|------------|
| **Multiple pi instances** (user runs pi manually + via app) | Watch all `pi-subagents-*` temp dirs, tag by `sessionId` |
| **Stale runs from crashed sessions** | `status.json` has `state` field; `process-terminal.json` has exit info; clean up on app start |
| **Large event files** (long-running agents) | Tail from last known offset, don't re-read entire file |
| **Nested subagents** (worker spawning its own subagents) | `isNested` flag in `status.json`; indent in UI |
| **Temp dir cleanup** (Windows deletes `%TEMP%` on reboot) | Not an issue — runs are ephemeral by design |
| **Concurrent file writes** | `notify::Watcher` debouncing + atomic read (read full file, don't stream) |
| **Permission issues** | App runs as same user as pi → same temp dir access |
| **pi version changes** (schema changes) | Check `lifecycleArtifactVersion` in `status.json`; fail gracefully on unknown version |

---

## 8. What this unlocks

1. **Users can see what their agents are doing** without alt-tabbing to a terminal
2. **Debugging agent failures** becomes trivial — see which tool call failed, what error, what was the acceptance verdict
3. **Multi-agent orchestration becomes tangible** — the Brain/Worker architecture is invisible without this
4. **Confidence in autonomous agents** — acceptance reports give structured pass/fail, not just "it finished"
5. **Foundation for future control** — once we can read state, we can add cancel/interrupt/steer buttons (pi's RPC protocol already supports `interrupt`, `stop`, `steer`, `resume`)

---

## 9. Out of scope (future)

- **Bidirectional control** (cancel, steer, approve checkpoints from UI) — pi's RPC protocol supports this but requires a control channel
- **Historical analytics** (aggregate stats across sessions) — requires persisting run data beyond temp dir lifetime
- **Live token streaming** (watch tokens accumulate in real-time) — pi doesn't expose this; would need pi extension
- **Cost tracking** (token costs per agent/run) — requires model pricing data
- **Multi-user / multi-machine** — single-user desktop app, no remote monitoring

---

## 10. Files to create/modify

### New files
| Path | Purpose |
|------|---------|
| `src-tauri/src/pi_harness.rs` | Backend watcher + parser + event emitter |
| `src/lib/piHarnessTypes.ts` | TypeScript type definitions |
| `src/lib/usePiHarness.ts` | React hook for Tauri event subscription |
| `src/components/HarnessDashboard.tsx` | Main dashboard component |
| `src/components/HarnessRunCard.tsx` | Individual run card |
| `src/components/HarnessEventTimeline.tsx` | Event feed |
| `src/components/HarnessOutputViewer.tsx` | Transcript viewer |
| `src/styles/pi-harness.css` | Dashboard styles (theme tokens) |

### Modified files
| Path | Change |
|------|--------|
| `src-tauri/src/pi_code.rs` | Add `PiHarnessWatcher` lifecycle (start on app ready, stop on shutdown) |
| `src-tauri/Cargo.toml` | Add `notify` dependency (if not already present — it is) |
| `src/components/RunningEnginesPanel.tsx` | Add "View pi activity" button |
| `src/components/MultiAgentBooster.tsx` | Link to dashboard after harness launch |

---

## 11. Session kickoff prompt (for future agent)

```
You are building the Mission Control dashboard for Blackwell Ops.

Read these files first:
- docs/MISSION_CONTROL_PLAN.md (this file)
- src-tauri/src/pi_code.rs (current pi integration)
- src-tauri/src/vram_learn.rs (example of notify::Watcher usage)
- src/components/RunningEnginesPanel.tsx (existing panel pattern)
- src-tauri/Cargo.toml (dependencies)

Then implement Phase 1 (Rust backend):
1. Create src-tauri/src/pi_harness.rs with PiHarnessWatcher
2. Discover pi temp dirs, watch for status.json changes
3. Parse status.json → PiRunState structs
4. Emit Tauri events "pi-harness-update"
5. Wire into pi_code.rs lifecycle

After Phase 1 compiles and is tested, proceed to Phase 2 (frontend).

Key data locations:
- pi temp dir: %TEMP%\pi-subagents-user-{user}\
- status.json: {temp}/async-subagent-runs/{run-id}/status.json
- events.jsonl: {temp}/async-subagent-runs/{run-id}/events.jsonl
- output log: {temp}/async-subagent-runs/{run-id}/output-{n}.log

No changes to pi itself are needed. All data is file-based.
```
