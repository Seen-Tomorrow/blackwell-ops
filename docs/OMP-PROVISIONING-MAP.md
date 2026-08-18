# OMP Provisioning Map

What Blackwell OPS must feed to **OMP** (oh-my-pi, the pi-mono fork) to fully cooperate with our
LLM server stack — the 1-click preset surface for the OMP integration.

- **Verified against:** live OMP install on this seat (`~/.omp/agent/`, `omp config list --json`,
  `omp://` harness docs) + running engines, 2026-08-18.
- **OMP lineage:** fork of pi-mono (last upstream sync marker 2026-03-22, see
  `omp://porting-from-pi-mono.md`). Shares the `PI_*` env surface with pi — most existing
  `pi_code.rs` plumbing carries over unchanged.
- **Companion doc:** `VRAM_SCENARIO_SYSTEM.md` (unrelated); the pi-side equivalent of this map
  lives in `src-tauri/src/pi_code.rs` (`pi_code_launch` and its writers).

---

## 1. Provisioning surface — files OMP reads

**Isolation strategy: OMP profile.** The app launches OMP with `OMP_PROFILE=blackwell`
(or `--profile blackwell`), which relocates the entire agent dir to
`~/.omp/profiles/blackwell/agent` — a namespaced subtree the user's default profile never
reads or writes, but first-class OMP:

- **consistent lookup bases** — context files, `SYSTEM.md`/`APPEND_SYSTEM.md`, agents, and
  memory all follow the active profile (the `PI_CODING_AGENT_DIR` variant does NOT — below);
- **user-visible** — `omp --profile blackwell` from a bare terminal enters the exact same
  world (sessions, memory, agents);
- **persistent** — survives app updates/reinstalls;
- **zero lifecycle code** — no backup/restore, no orphan detection, no env-stripping of home.

**Why not in-place + backup/restore** (rejected): "harness close" is not a reliable event
(spawned/elevated console, user window-close, taskkill, power loss — and this app has a
documented heap-corruption exit path), the agent dir holds live SQLite+WAL state plus the
user's OAuth credentials in `agent.db`, and a missed restore destroys the user's real OMP
setup. Isolation's failure mode is invisible (user's own omp doesn't see app config);
restore's failure mode is user data loss.

**Variant: fully app-owned dir.** `PI_CODING_AGENT_DIR` (the env var the pi integration
already sets) relocates the agent dir to any path, e.g. `external-tools\omp-home` outside
`~/.omp` — wiped/re-synced on app update, zero user visibility. Trade-off: the
`SYSTEM.md`/`APPEND_SYSTEM.md` lookup does **not** follow `PI_CODING_AGENT_DIR` (it follows
profiles / `PI_CONFIG_DIR`) — under this variant use `AGENTS.md` or `--append-system-prompt`.

### Agent dir (user scope)

All paths below are relative to the **active agent dir** — `~/.omp/profiles/blackwell/agent`
under the app's profile (or the `PI_CODING_AGENT_DIR` path under the app-owned variant).

| File | Purpose | pi equivalent |
|---|---|---|
| `models.yml` | providers + models. `baseUrl`, `auth: none`, `api: openai-completions`, `models[]` (`id`, `name`, `contextWindow`, `maxTokens`, `input`, `reasoning`, `thinkingLevelMap`, `compat`) | `models.json` — **the live file already written by the app is valid OMP as-is** |
| `config.yml` | ALL settings: `modelRoles`, `task.*`, `disabledProviders`, `providers.*`, `retry.*`… (YAML mapping; `config.yaml` accepted) | `settings.json` **+** `extensions/subagent/config.json` merged into one file |
| `AGENTS.md` | user-scope context, **native provider priority 100** — shadows every other user-level context file | `AGENTS.md` from `write_pi_context_files` |
| `APPEND_SYSTEM.md` | append instructions to the default prompt (safe, additive) | new |
| `SYSTEM.md` | **replaces** the whole default instruction template (drops tool policy / workflow text) — sledgehammer, use deliberately | new |
| `TITLE_SYSTEM.md` | custom session-title prompt | new |
| `agents\*.md` | custom agent definitions (frontmatter: `name`, `description`, `model`, `tools`, `spawns`, `output`, `blocking`, `prewalk`, `advisor`…). Override bundled agents by exact name | `agents\worker.md` from `write_worker_agent` |
| `RULES.md` | sticky always-apply rules (re-attached near the current turn, survives long sessions) | new |
| `.env` | agent-level env (load order: project `.env` → agent `.env` → config-root `.env` → home `.env`) | — |
| `memories\<encoded-project>\` | per-project memory: `learned.md`, `raw_memories.md`, `skills\` — auto-loaded summary each session in that repo | new (accumulates; `memory.backend: local`) |
| `managed-skills\` | auto-learned managed skills (`autolearn.enabled`) | new |
| `agent.db` | credentials (SQLite, bun:sqlite) — irrelevant with `auth: none` | `auth.json` |
| `models.db` | model-discovery cache (fingerprinted) | — |
| `sessions\<encoded-cwd>\` | session JSONL transcripts + subagent artifacts | `sessions\` |

### Project dir (`<cwd>\.omp\`)

| File | Purpose |
|---|---|
| `config.yml` | project settings layer — **read only from the launch cwd, no ancestor walk** |
| `AGENTS.md` | project context (native, priority 100 at its depth) |
| `agents\*.md` | project agents (override user agents, first-wins by name) |
| `RULES.md` | project sticky rules |
| `skills\` | project skills (`skills.enablePiProject`) |

Settings precedence (low → high): built-in defaults < global `config.yml` < project
`.omp/config.yml` < `--config` overlays / `PI_CONFIG_FILES` < runtime flags/env.
Deep-merge for objects; **arrays are replaced wholesale** (see Gotchas).

---

## 2. Context-file discovery (the "3 AGENTS.md" question)

OMP discovers context files from 8 providers and injects them as one `<repo-rules>` block:

| Priority | Provider | Files |
|---:|---|---|
| 100 | `native` | `~/.omp/agent/AGENTS.md` (user) + `<nearest non-empty .omp>/AGENTS.md` (project) |
| 80 | `claude` | `~/.claude/CLAUDE.md`, `<cwd>/.claude/CLAUDE.md` |
| 70 | `agents` / `codex` | `~/.agent(s)/AGENTS.md`; `~/.codex/AGENTS.md` (user only) |
| 60 | `gemini` | `~/.gemini/GEMINI.md`, `<cwd>/.gemini/GEMINI.md` |
| 55 | `opencode` | `~/.config/opencode/AGENTS.md` |
| 30 | `github` | `.github/copilot-instructions.md` (+user global) |
| 10 | `agents-md` | **standalone `AGENTS.md`** — walks cwd → repo root, and when the repo is under home, **through enclosing workspace dirs up to home** |

Dedup: **one user-scope file** (native wins) + **one project file per directory depth**
(higher priority wins at equal depth). Worked example — a session launched in
`C:\Users\GHOST-TOWER\INFRA\blackwell-ops` loads exactly:

1. `blackwell-ops\AGENTS.md` — `agents-md`, depth 0
2. `INFRA\AGENTS.md` — `agents-md`, depth 1 (enclosing dir under home)
3. `~\.codex\AGENTS.md` — `codex`, user scope (survives because no native user file exists)

**Deterministic strategy for the app:**
1. Write `<agent-dir>\AGENTS.md` (native user — shadows all other user files).
2. Optionally write `<project>\.omp\AGENTS.md` (native project — wins at its depth).
3. Disable foreign discovery providers in `disabledProviders`:
   `claude`, `codex`, `gemini`, `opencode`, `github`, `agents`.
4. Keep `agents-md` enabled only if standalone repo `AGENTS.md` files (like ours) should load;
   otherwise disable it too for a fully closed surface.

`@path` imports inside any context file expand inline (relative to the importing file, `~`
supported, 5 hops, cycles skipped) — one topology file can pull per-engine sections.

---

## 3. `models.yml` — provider/model basics

Shape is identical in spirit to pi's `models.json`. Blackwell twin example (the live file):

```yaml
providers:
  local_BLACKWELL-OPS-BRAIN:
    baseUrl: http://127.0.0.1:8888/v1
    api: openai-completions
    auth: none
    models:
      - id: BRAIN
        name: BWops BRAIN
        contextWindow: 256000
        maxTokens: 8192
        input: [text, image]        # image only when engine launched with --mmproj
        reasoning: true
        thinkingLevelMap: { low: low, medium: medium, xhigh: xhigh }
  local_BLACKWELL-OPS-WORKER:
    baseUrl: http://127.0.0.1:8889/v1
    api: openai-completions
    auth: none
    models:
      - id: WORKER
        name: BWops WORKER
        contextWindow: 87552
        maxTokens: 2048
        input: [text, image]
        reasoning: false
```

Notes:
- Full custom provider requires `baseUrl` + `api` + (`apiKey` unless `auth: none`).
- `api` values: `openai-completions` (llama-server `/v1/chat/completions` — what we use),
  `openai-responses`, `anthropic-messages`, …
- Qwen thinking control (if ever wanted at harness level instead of server level):
  `compat.thinkingFormat: qwen` (top-level `enable_thinking`) or `qwen-chat-template`
  (`chat_template_kwargs.enable_thinking`); `reasoningEffortMap` maps internal effort levels
  to provider strings.
- `discovery.type: openai-models-list` can auto-list models from `/v1/models` instead of
  hand-declaring (llama-server exposes it, incl. `n_ctx`/`n_params` metadata).
- On schema failure the registry falls back to built-ins and surfaces the error — no crash.

---

## 4. `config.yml` — the routing + concurrency core

### Model roles

Built-in roles: `default`, `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`,
`task`, `advisor`. Values are `provider/model` selectors with optional `:thinkingLevel`
suffix (`off|minimal|low|medium|high|xhigh|max`). Custom roles via `modelTags`.

```yaml
modelRoles:
  default: local_BLACKWELL-OPS-BRAIN/BRAIN      # main session
  slow: local_BLACKWELL-OPS-BRAIN/BRAIN:xhigh   # deep reasoning lane
  vision: local_BLACKWELL-OPS-BRAIN/BRAIN:low
  smol: local_BLACKWELL-OPS-WORKER/WORKER:low   # fast grunt lane
  tiny: local_BLACKWELL-OPS-WORKER/WORKER:low   # titles/memory/classifier
  task: local_BLACKWELL-OPS-WORKER/WORKER:low   # subagent default role
  commit: local_BLACKWELL-OPS-WORKER/WORKER:low
```

Env overrides: `PI_SMOL_MODEL`, `PI_SLOW_MODEL`, `PI_PLAN_MODEL`.

### Task (subagent) settings — full live-verified key set

| Key | Live value | Meaning |
|---|---|---|
| `task.maxConcurrency` | 16 | **Single session-scoped semaphore, global across all agent types/models.** Cap on concurrent subagents; resized live. |
| `task.agentModelOverrides` | `{sonic: "@smol", task: BRAIN:low}` | Per-agent-type model pin (highest precedence in resolution) |
| `task.batch` | true | One call carries `{context, tasks[]}` — one subagent per item |
| `task.eager` | preferred | How strongly the prompt pushes delegation |
| `task.enableEffort` / `task.maxEffort` | true / low | per-spawn `effort` hint, clamped |
| `task.maxRecursionDepth` | 2 | subagents may spawn one level deep |
| `task.agentIdleTtlMs` | 420000 | idle subagents parked after 7 min (revivable via `hub`) |
| `task.softRequestBudget` (+`Notice`) | 200 / true | per-subagent request budget; wrap-up steer, hard stop at 1.5× |
| `task.maxRuntimeMs` | 0 | per-subagent wall clock (0 = off) |
| `task.disabledAgents` | [] | kill switch per agent name |
| `task.prewalk` / `task.agentPrewalk` | true / {} | start on one model, hand off to cheaper at first edit/write |
| `task.agentAdvisor` | {} | per-agent advisor model |
| `task.isolation.mode` | none | isolated workspace backends (none/auto/apfs/btrfs/…/projfs) |
| `task.showResolvedModelBadge` | true | TUI shows resolved model per subagent |
| `async.enabled` / `async.maxJobs` | true / 100 | background job execution |

### Concurrency mapping (the physical-state question)

Two knobs, two layers:

1. `task.maxConcurrency` — global subagent cap (harness level). Setting it above engine
   capacity does not fail; excess subagents run and their requests **queue at
   llama-server** — pure wall-time waste.
2. `providers.maxInFlightRequests` — **per-provider** cap on in-flight LLM HTTP requests,
   shared across omp processes on the same config root. This is the per-engine knob:

```yaml
providers:
  maxInFlightRequests:
    local_BLACKWELL-OPS-BRAIN: 2    # 1 main session + headroom
    local_BLACKWELL-OPS-WORKER: 8   # = WORKER engine --parallel
```

**Rule for the app (twin, 2-GPU: BRAIN 1 slot / WORKER N slots):**
`task.maxConcurrency = N` (+1 if BRAIN subagents should queue in during main-session gaps)
and `maxInFlightRequests` pinned per engine to each engine's `--parallel`.
The app already computes `routing_facts.slots` per engine in `build_models_and_settings` —
feed the same values into these two keys. (Pi had no per-engine knob either: its
`parallel.concurrency` + `globalConcurrencyLimit` were also global. `maxInFlightRequests`
is strictly more precise.)

**Orchestrator slot economics** — does the main session (default model = BRAIN) itself
need parallelism?
- llama-server slots are **per-request**, not per-session: the main session holds a BRAIN
  slot only while generating a turn; between turns (tool calls, `hub wait` for subagents)
  the slot is free.
- The main session is a **dispatcher** (generate → dispatch → wait → verify) and needs
  exactly 1 BRAIN slot. WORKER subagents run on a separate engine — zero contention with
  the main session, fully concurrent.
- BRAIN subagents (e.g. the `task` agent pinned to BRAIN) run in the **gaps** of a
  1-slot BRAIN — useful precisely while the main session is waiting on WORKER. To run
  BRAIN subagents *concurrently with active main-session generation* (e.g. a BRAIN
  reviewer while BRAIN is writing), give the BRAIN engine `--parallel 2` and raise
  `maxInFlightRequests[BRAIN]` to match.
- **Delegation is automatic**: the main agent fans out independent slices on its own
  (system tool policy + `task.eager: preferred`); the user's "parallel" keyword is a hard
  override, not a prerequisite. Per-topology tuning: `task.eager: none|auto` in
  **solo mode** (single engine — subagents would only queue behind the main session and
  add overhead), `preferred` in twin/multi mode.

**WORKER pool: N identical instances behind one endpoint** (the ctx-divide problem):
- `--parallel N` on one server divides the total ctx budget by N (256K/4 = 64K per slot —
  borderline for subagent work). Alternative: run N *identical* instances, each with full
  ctx (e.g. 2×128K), on separate internal ports.
- **OMP has no load pool**: one `baseUrl` per provider, and `retry.fallbackChains` is
  **failure-driven** (429s/outages + cooldown, "switches for the rest of the turn"), not
  load-driven — a healthy-but-queued engine never spills to its twin. Don't build a pool
  out of fallback chains.
- **Pool in the app's gateway** — the OpenAI-compatible facade already serving
  `:8888`/`:8889` as `ENGINE_1`/`ENGINE_2`: accept on one port, dispatch to the instance
  with a free slot (the app launched them — it knows slot state), bounded internal queue
  (mirrors llama-server's own slot queue; smoother than 429 + harness retry jitter).
- Harness side stays simple: **one provider, one model**; `maxInFlightRequests` and
  `task.maxConcurrency` = total pool slots (instances × slots/instance).
- Optional belt-and-braces: the gateway also exposes per-instance model ids
  (`WORKER-1..N`) and a `fallbackChains` entry for the WORKER model → instance-level
  *failure* failover on top of the gateway's load pooling.
- Size the pool with the existing VRAM forecast, not "as many as fit": subagent sessions
  are short-lived (7-min idle TTL, 200-request soft budget, 500 KB output cap), so
  per-instance ctx can stay moderate (128K is plenty for grunt work).

### Retry / fallback (local-only stacks)

`retry.fallbackChains` — keep chains local-only so a dead engine never silently routes to a
cloud provider:

```yaml
retry:
  modelFallback: true
  fallbackChains:
    default:
      - local_BLACKWELL-OPS-BRAIN/BRAIN
```

---

## 5. Subagent routing model

- **Bundled agents are compiled into the binary**: `scout`, `designer`, `reviewer`,
  `security-reviewer`, `librarian`, `task`, `sonic`. **No pi-subagents package sync needed.**
- **Custom agents**: `~/.omp/agent/agents\*.md` (user) and `<project>\.omp\agents\*.md`
  (project). First-wins dedup by exact name: project > user > extensions > claude plugins >
  bundled. One bad file is skipped with a warning; discovery never aborts.
- **Model resolution per spawn** (high → low):
  1. `task.agentModelOverrides[agentName]`
  2. agent frontmatter `model` (prioritized list; `@role` aliases + `:thinking` suffix;
     unresolved entries become fallbacks)
  3. parent's active model
- **`vibe_spawn` tiers**: `fast` → bundled `sonic`, `good` → bundled `task` (both pass
  through `agentModelOverrides` first).
- Spawn mechanics: `task` tool (batch on) → async background jobs → session-scoped
  semaphore → child sessions (no inherited history; get workspace tree, skills, context
  files, shared `local://` root) → finish via `yield` → idle (revivable via `hub`
  messaging) → parked after `agentIdleTtlMs`.
- Guardrails: `task.disabledAgents`, parent spawn policy, `PI_BLOCKED_AGENT`
  (self-recursion env guard), `task.maxRecursionDepth`.

**Consequence for the app:** the pi `write_worker_agent` (worker agent .md) is **not
required** — `modelRoles` + `task.agentModelOverrides` express the whole twin topology.
Ship a custom `agents\worker.md` only if you want a distinct system prompt / tool set /
output schema beyond what the bundled `sonic` gives.

---

## 6. Launch hooks (per-session, from the app)

| Hook | Use |
|---|---|
| `OMP_PROFILE=blackwell` / `omp --profile blackwell` / `PI_PROFILE` | **primary isolation hook** → agent dir `~/.omp/profiles/blackwell/agent` (see §1) |
| `PI_CONFIG_FILES` (platform path list) / `--config <file>` (repeatable) | **per-launch config overlays** — inject this session's engine topology without touching persistent files. Missing/invalid overlay = hard error. Doubles as the **opt-in bridge**: the user's own default-profile session can load the app's provider topology via `PI_CONFIG_FILES=<app>\blackwell-overlay.yml` — user-initiated, no lifecycle |
| `PI_CODING_AGENT_DIR` | relocate the agent dir to any path — the app-owned-dir variant (e.g. `external-tools\omp-home`). Caveat: `SYSTEM.md`/`APPEND_SYSTEM.md` lookup does not follow it (see §1) |
| `PI_SMOL_MODEL` / `PI_SLOW_MODEL` / `PI_PLAN_MODEL` | env overrides for matching roles |
| `--model`, `--thinking`, `--approval-mode` / `--yolo` | runtime flags (never persisted) |
| `PI_BLOCKED_AGENT` | self-recursion guard for a named agent |
| `PI_TASK_MAX_OUTPUT_BYTES` / `PI_TASK_MAX_OUTPUT_LINES` | subagent output caps (defaults 500 KB / 5000 lines) |
| `PI_NO_PTY=1`, `PI_PY=0`, `PI_JS=0` | process-local feature switches |

`.env` load order: project `.env` (launch cwd) → agent `.env` → config-root `.env` →
home `.env`; `OMP_*` keys mirror to `PI_*` aliases inside parsed dotenvs.

---

## 7. Writer spec — pi → OMP mapping

`pi_code.rs` today (pi path):

| pi writer | What it does |
|---|---|
| `build_models_and_settings()` | models.json + settings.json + routing facts (slots, twin) |
| `write_subagents_config(home, slots)` | `extensions/subagent/config.json` → `parallel.concurrency` + `globalConcurrencyLimit` = slots |
| `write_worker_agent(home, target, ctx, slots, twin)` | `agents/worker.md` with model pin + slot-aware prompt |
| `write_pi_context_files(home, project, …)` | `PI.md` + `AGENTS.md` (topology text) |
| `sync_bundled_subagents(home)` | copy pi-subagents package into home |
| disclaimer / `is_installed` / `write_outer_shim` / `spawn_pi_console` | launch mechanics |

OMP equivalent:
`home` = active agent dir — `~/.omp/profiles/blackwell/agent` (profile) or the
`PI_CODING_AGENT_DIR` path (app-owned variant).

| OMP writer (to build) | Target file(s) | Content |
|---|---|---|
| `write_omp_models(home)` | `<agent-dir>/models.yml` | same shape as today's models.json, YAML (see §3). Reuse `build_models_and_settings` model data. |
| `write_omp_config(home, routing_facts)` | `<agent-dir>/config.yml` | `modelRoles` (§4), `task.agentModelOverrides {sonic: "@smol", task: <brain-or-worker>}`, `task.maxConcurrency = worker_slots (+1)`, `providers.maxInFlightRequests` per engine, `disabledProviders` (complete list: model providers `ollama`/`llama.cpp`/`lm-studio` **+** discovery providers `claude`/`codex`/`gemini`/`opencode`/`github`/`agents`), `retry.fallbackChains` local-only |
| `write_omp_context(home, project, routing_facts)` | `<agent-dir>/AGENTS.md` (+ optional `<project>/.omp/AGENTS.md`, `APPEND_SYSTEM.md`) | topology text (modes, slots, roles, routing rules). Replaces `PI.md` + AGENTS.md. `@import` available for splitting. |
| *(none)* | — | **delete** `sync_bundled_subagents` (agents are compiled in) and `write_subagents_config` (folded into config.yml) |
| *(optional)* `write_omp_worker_agent(home, …)` | `<agent-dir>/agents/worker.md` | only if a custom worker prompt/toolset is wanted; frontmatter `model: "@smol"` |
| launch mechanics | — | keep disclaimer/shim/launcher; point at `omp.exe` (or bundled omp) instead of pi |

Per-launch variant: instead of (or in addition to) rewriting `config.yml`, emit a
topology overlay file and set `PI_CONFIG_FILES` to it — persistent file stays stable,
session gets the current engine array. The same overlay file is the **user opt-in bridge**:
a default-profile `omp` session launched with it (by the user, or by an app "open in
terminal" action) gets the Blackwell engines on top of their own config — no files of
theirs are touched.

---

## 8. Gotchas

1. **Arrays replace, never append** — a higher layer's `disabledProviders` /
   `enabledModels` / `extensions` becomes the *entire* list. The app must always write
   complete lists.
2. `disabledProviders` is a **shared namespace**: model providers (`ollama`, `llama.cpp`,
   `lm-studio`, `anthropic`, …) and discovery providers (`claude`, `codex`, `gemini`,
   `opencode`, `github`, `agents`, `agents-md`, `native`) live in one list. Disabling a
   discovery provider drops everything it contributes (context, MCP, skills, commands).
3. **`task` agent defaulting to BRAIN on a 1-slot BRAIN is a trap**: `task`-type subagents
   queue behind the main session for the single slot (they only run in gaps between turns).
   Fine as an "equal-capability, idle-gap" lane; the fast lane is `sonic` → WORKER. Choose
   the `task` pin deliberately per topology (solo mode: same engine, so it's a non-issue).
4. Project settings are read **only from the launch cwd's `.omp/`** (no ancestor walk) —
   unlike standalone `AGENTS.md` discovery. Launch from the repo root or use the global file.
5. `SYSTEM.md` replaces the entire default instruction template (tool policy, workflow,
   internal-URL catalog). For additive per-topology instructions use `APPEND_SYSTEM.md`.
6. `omp config set` always writes the **global** file — for per-launch config use overlays
   (`--config` / `PI_CONFIG_FILES`), not `config set`.
7. `models.yml` schema failure → registry falls back to built-ins silently (error surfaced
   via UI/notifications). Validate in the app before writing.
8. Memory accumulates per project under `memories\<encoded-path>\` (learned.md,
   raw_memories.md, skills/). Decide: wipe on re-provision, or persist across launches.
   `autolearn.enabled` + `memory.backend: local` are what write to it.
9. Lookup-base consistency: under the **profile** mechanism every base (context files,
   `SYSTEM.md`/`APPEND_SYSTEM.md`, agents, memory) follows the active profile. Under the
   `PI_CODING_AGENT_DIR` variant, `SYSTEM.md`/`APPEND_SYSTEM.md` discovery does **not**
   follow it (it follows profiles / `PI_CONFIG_DIR`) — use `AGENTS.md` or
   `--append-system-prompt` there.
10. Subagent output caps: 500 KB / 5000 lines inline (full output always in `<id>.md`
    artifact) — `PI_TASK_MAX_OUTPUT_BYTES/LINES` to tune.

---

## 9. Verification checklist (after provisioning)

```powershell
# 1. Agent dir resolution (profile must be active)
omp --profile blackwell config path

# 2. Effective values (machine-readable)
omp --profile blackwell config list --json   # check task.maxConcurrency, agentModelOverrides,
                         # providers.maxInFlightRequests, disabledProviders, modelRoles

# 3. Models visible
omp --profile blackwell models               # both engines + models listed

# 4. Context surface: launch a session in a clean dir, inspect the opening <repo-rules>
#    block — expect exactly the files the app wrote (nothing from ~/.codex etc.)

# 5. Routing: dispatch 3 parallel sonic tasks; with task.showResolvedModelBadge on,
#    each must resolve to local_BLACKWELL-OPS-WORKER/WORKER; main session stays BRAIN.

# 6. Concurrency: dispatch maxConcurrency+2 sonic tasks; observe engine /slots —
#    never more than --parallel concurrent requests per engine; extras queue, none fail.
```

---

## Appendix A — Live evidence (2026-08-18, this seat)

- Engines: `llama-server.exe` × 2 — BRAIN `:8888` `--parallel 1` (27.3B Q4_K-Medium,
  ctx 262144, reasoning), WORKER `:8889` `--parallel 3` (27.3B Q4_K-Small, ctx 87552,
  multimodal, thinking disabled server-side).
- Live `~/.omp/agent/config.yml`: `modelRoles` (slow→BRAIN:xhigh, smol/tiny/task/commit→
  WORKER:low, vision→BRAIN:low, plan/designer→grok), `task.agentModelOverrides`
  `{sonic: "@smol", task: BRAIN:low}`, `task.maxConcurrency: 16`, `disabledProviders:
  [ollama, llama.cpp, lm-studio]`, `memory.backend: local`, `autolearn.enabled: true`.
- Live `~/.omp/agent/models.yml`: the twin provider pair exactly as in §3.
- Session context files loaded: 3 (see §2 worked example).
- 3 parallel sonic subagents on WORKER: all completed in ≤ 2 min wall, zero value errors
  across ~1,100 extracted items (mechanical extraction test).
- Isolation decision: OMP **profile** (`OMP_PROFILE=blackwell`) — chosen over in-place
  backup/restore (unreliable close event, live SQLite+WAL + user OAuth in `agent.db`,
  data-loss failure mode) and over bare `PI_CODING_AGENT_DIR` (SYSTEM.md lookup seam).
  Full rationale in §1.
