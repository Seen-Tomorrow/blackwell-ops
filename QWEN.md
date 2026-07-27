# Qwen Code context

<!-- BLACKWELL-QWEN:BEGIN -->
## Blackwell Ops — Qwen Code (managed)

### Paths (do not invent `~/.qwen`)

| Role | Absolute path |
|------|----------------|
| **QWEN_HOME** (settings, this file if user-scoped) | `C:\Users\GHOST-TOWER\INFRA\blackwell-ops\src-tauri\target\debug\config\external-tools\qwencode-home` |
| **Project cwd** (workspace / default file ops) | `C:\Users\GHOST-TOWER\INFRA\blackwell-ops` |
| **settings.json** | `C:\Users\GHOST-TOWER\INFRA\blackwell-ops\src-tauri\target\debug\config\external-tools\qwencode-home\settings.json` |

- Prefer project files under **Project cwd**.
- Config / session state live under **QWEN_HOME**, not `%USERPROFILE%\.qwen`.
- Install binary lives under `external-tools/qwen-code/` (not npm global).

### Model routing (how to switch engines)

Qwen identifies models by **`id` + `baseUrl`** in `settings.json` → `modelProviders.openai[]`.
Use **`/model <id>`** (not the raw GGUF name alone).

Launch mode: **solo**

| id (use with `/model`) | Role | Engine alias (OpenAI model string) | Endpoint |
|------------------------|------|--------------------------------------|----------|
| `local` | SOLO | `ENGINE_1` | `http://127.0.0.1:8888/v1` |

- Default **main** chat model is **`brain`** (twin) or **`local`** (solo).
- You (the agent) **cannot** switch the main session model; the user uses **`/model brain`** or **`/model worker`**.
- **Twin only:** `fastModel` and Explore use **`openai:worker`** (authType:modelId). Prefer **`worker-coder`** / **`worker-explore`** for implementation / parallel work so those calls hit the WORKER port.
- Named subagents use YAML frontmatter `model: openai:worker` (not inherit) for the worker seat.
- `ENGINE_*` names are llama-server **aliases**; harness routing keys are **`brain` / `worker` / `local`**.

### Vision

Image paste is enabled (`modalities.image/video`). Prefer multimodal tasks on the BRAIN/`local` seat.
<!-- BLACKWELL-QWEN:END -->

