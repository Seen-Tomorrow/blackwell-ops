# NPU / OpenVINO integration plan

**Status:** Manual POC first — app integration blocked until POC gates pass.  
**Target hardware:** Intel Core Ultra 9 **386H** (Panther Lake, **NPU 5**, ~50 TOPS).  
**Primary use case (initial):** Low-power small workloads (e.g. speech / small LM @ ~2–3 W), not replacing CUDA stacks on the dev workstation.

This doc is the single source of truth so manual testing on the 386H box feeds directly into Blackwell Ops without rework.

---

## Goals

| Goal | Out of scope (for now) |
|------|-------------------------|
| Run `llama-server` on **NPU** via OpenVINO backend | Multi-GPU CUDA parity |
| Prove Q4_K_M small models (1B–8B) at acceptable latency | Auto VRAM / FIT library on NPU |
| Capture env, paths, and limits for a future `ggml-openvino` provider | Foundry auto-build (Phase 2) |
| Optional: iGPU (`GGML_OPENVINO_DEVICE=GPU`) as fallback | Full telemetry / NPU utilization bars |

---

## Architecture fit (Blackwell Ops today)

Blackwell Ops does **not** embed backends — it shells `llama-server.exe` with a **provider factory JSON** + **spawn_profile**:

```
runtime/<provider>/config/<provider>-default-config.json   ← params, build_profile, spawn_profile
runtime/<provider>/<env>/llama-server.exe                  ← binary (bundled or Foundry-built)
engine_stack.rs                                            ← spawn + env (today: CUDA_VISIBLE_DEVICES)
templates.rs build_command()                               ← CLI args from user config
```

OpenVINO is a **new provider** (`ggml-openvino`), not a flag on `ggml-master`. CUDA and OpenVINO are separate CMake builds (`-DGGML_CUDA=ON` vs `-DGGML_OPENVINO=ON`).

Upstream reference: [llama.cpp OPENVINO.md](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/OPENVINO.md).

---

## Phase 0 — Manual POC on Core Ultra 9 386H

**Machine:** Panther Lake laptop/desktop with 386H only (keep CUDA dev box separate).

### 0.1 Prerequisites (install once, record versions)

| Component | Action | Record in POC log |
|-----------|--------|-------------------|
| **Windows 11** | Latest stable + optional updates | Build number |
| **NPU driver** | Intel OpenVINO [hardware config](https://docs.openvino.ai/2026/get-started/install-openvino/configurations.html) — NPU section for Panther Lake | Driver version from Device Manager / Intel tool |
| **iGPU OpenCL** (optional GPU path) | Intel graphics driver + OpenCL ICD | Driver version |
| **VS 2022 Build Tools** | “Desktop development with C++” | vswhere path |
| **Git, CMake, Ninja** | `winget` or existing | Versions |
| **vcpkg + OpenCL** | Per OPENVINO.md Windows script | `C:\vcpkg` path |
| **OpenVINO Runtime** | Archive install → `C:\Intel\openvino` (no spaces) | **Exact** `2026.x` build string |

Create a local log file (not in repo unless you want it):

```
C:\BlackOps-NPU-POC\poc-log.md
```

### 0.2 Build llama.cpp (OpenVINO only)

Use Intel’s automated script or equivalent from OPENVINO.md (`windows-llamacpp-ov-install.bat`).

**Pin these for reproducibility:**

- `llama.cpp` commit hash (or tag)
- OpenVINO `OPENVINO_VERSION_FULL`
- CMake command line (copy from configure output)

**Expected CMake flags (no CUDA):**

```
-DGGML_OPENVINO=ON
-DLLAMA_CURL=OFF
-DCMAKE_BUILD_TYPE=Release
```

**Artifacts to keep** (copy to a durable folder — Foundry `work/` is disposable in-app):

```
C:\BlackOps-NPU-POC\artifacts\
  llama-server.exe
  llama-cli.exe
  *.dll                    ← all runtime deps next to exe
  build-info.txt           ← commit, OpenVINO version, cmake line
  openvino-runtime-copy\   ← minimal DLL set if you identify it
```

Run `dumpbin /dependents llama-server.exe` (or Dependencies.exe) and list every DLL path that matters at launch.

### 0.3 Runtime environment (document exactly)

After `C:\Intel\openvino\setupvars.bat` (or `.ps1`), note every env var set. Minimum for app integration later:

| Variable | NPU test value | Notes |
|----------|----------------|-------|
| `GGML_OPENVINO_DEVICE` | `NPU` | Also test `CPU`, `GPU` |
| `GGML_OPENVINO_STATEFUL_EXECUTION` | `0` | **NPU: stateless only** per upstream |
| `PATH` | Must include OpenVINO `runtime\bin\intel64\Release` | App spawn must prepend this |

**Do not assume** `setupvars` alone is enough when spawning from a GUI app with a stripped PATH — test launch from a **clean** `cmd` with only PATH + OpenVINO vars.

### 0.4 Model matrix (start small)

Use **Q4_K_M** GGUF first (NPU-validated quant family in upstream table). Suggested order:

1. `Llama-3.2-1B-Instruct-Q4_K_M` — sanity
2. `Llama-3.2-3B-Instruct-Q4_K_M` — speech / agent stub
3. `Meta-Llama-3.1-8B-Instruct-Q4_K_M` — upper comfort zone
4. One **fails** on purpose (e.g. 12B+) to learn error shape

For each model × device (`NPU`, `CPU`, `GPU`):

```cmd
set GGML_OPENVINO_DEVICE=NPU
llama-server.exe -m <model.gguf> --port 8080 -lv 4 --metrics
```

Record:

- Load time (first compile vs warm)
- Steady TG tokens/s (from stderr or `/metrics` if exposed)
- Power feel (Task Manager / Intel tools if available)
- Pass/fail + exact stderr on failure

**Speech-engine angle (~2–3 W):** also test tiny models (1B, or embedding-only `llama-embedding` if needed later) with short `n_predict` — note whether NPU actually engages vs CPU fallback.

### 0.5 HTTP / API parity check

Blackwell Ops expects standard `llama-server` behavior:

| Check | Command / endpoint | Required for app |
|-------|-------------------|------------------|
| Health | `GET /health` | Yes |
| Slots | `GET /slots` | Yes (Fusion) |
| Completion | `POST /completion` | Yes |
| Chat | `POST /v1/chat/completions` | If you use chat API |

Save one working `curl` / PowerShell example per model in the POC log.

### 0.6 POC exit gates (must pass before app work)

| Gate | Criterion |
|------|-----------|
| **G1** | `llama-server` loads ≥1 Q4_K_M model on **NPU** without crash |
| **G2** | `/health` + `/completion` work; TG is stable for ≥512 tokens |
| **G3** | DLL + env requirements documented; reproducible from clean shell |
| **G4** | Known bad cases logged (model too large, wrong quant, vision, spec decode) |
| **G5** | Panther Lake driver + OpenVINO version combo recorded |

If **G1** fails: try newer OpenVINO drop and NPU driver before touching Blackwell Ops. Panther Lake (NPU 5) may need a **newer** OpenVINO than Lunar Lake validation matrix — track Intel release notes.

---

## Phase 1 — App integration (after POC gates)

**Prerequisite:** `C:\BlackOps-NPU-POC\artifacts\` + `poc-log.md` complete.

### 1.1 New provider skeleton (no Foundry yet)

Add to repo (factory only first; binary dropped manually):

```
src-tauri/runtime/ggml-openvino/
  config/ggml-openvino-default-config.json
  stable/llama-server.exe          ← copy from POC artifacts
  stable/<dlls>                    ← same folder as exe
```

Factory JSON highlights:

```jsonc
{
  "id": "ggml-openvino",
  "template_type": "ggml-openvino",   // new — maps to Foundry cmake defaults later
  "build_profile": "-DGGML_OPENVINO=ON\n-DLLAMA_CURL=OFF\n-DGGML_NATIVE=ON",
  "spawn_profile": {
    "gpu_env": "GGML_OPENVINO_DEVICE",  // semantic rename; not CUDA
    "tensor_split": false,
    "auto_vram": false,
    "fit_style": "none",
    "supports_fusion": true,              // verify in POC — flip false if /slots differs
    "fusion_adapter": "ggml_master",
    "fit_adapter": "ggml_master",
    "max_engine_slots": 4,                // NPU: low concurrency expected
    "ngl_flag": []                        // no --n-gpu-layers on OpenVINO path
  }
}
```

**New param** (CONFIG UI):

| key | label | values | maps to |
|-----|-------|--------|---------|
| `ov_device` | OPENVINO-DEVICE | `NPU`, `GPU`, `CPU` | `GGML_OPENVINO_DEVICE` at spawn |

Hide CUDA-only params for this provider: `split`, `offload_mode` MOE paths, multi-GPU chips.

`templateVersion`: start at `1`; bump when params change (merge_template_for_provider).

### 1.2 Spawn plumbing

**File:** `src-tauri/src/engine_stack.rs`

Today:

```rust
.env("CUDA_VISIBLE_DEVICES", &gpu_mask)
```

Change to provider-driven env (design now, implement in Phase 1):

- If `spawn_profile.gpu_env == "CUDA_VISIBLE_DEVICES"` → current behavior
- If `spawn_profile.gpu_env == "GGML_OPENVINO_DEVICE"` → set from config param `ov_device` (default `NPU`)
- Prepend OpenVINO `runtime/bin` to `PATH` for child process (path from config or `C:\Intel\openvino` detection)

Optional: `spawn_profile.openvino_root` in factory JSON for portable installs.

**Do not** call `setupvars.bat` at spawn — inline the minimal env vars POC proved necessary.

### 1.3 VRAM / Auto-fit

| Component | Phase 1 behavior |
|-----------|------------------|
| `useScenarioEvaluator` | Skip GPU VRAM bars or show “NPU — no VRAM model” |
| `__ngl` injection in `templates.rs` | Disabled when `ngl_flag` empty |
| FIT scan | Disabled (`fit_style: none`) |
| Launch | Manual ctx/batch only (Essentials params) |

Revisit after POC shows whether `--fit` exists on OpenVINO builds at all.

### 1.4 Fusion / logs

If POC confirms `-lv 4` stderr + `/slots` match master:

- Reuse `ggml_master` fusion adapter (no new parser).

If Tom-style quiet logs needed, add `ggml_openvino` adapter only after diffing stderr.

### 1.5 Registry / provider list

**Files:** `config.rs` (`build_config_with_providers_full`), runtime folder scan — ensure `ggml-openvino` is discovered like other providers.

README roadmap line: “Intel NPU (OpenVINO) — experimental provider”.

---

## Phase 2 — Foundry OpenVINO build profile

Only after Phase 1 launch works with hand-copied binaries.

| Task | File(s) |
|------|---------|
| New `DEFAULT_CMAKE_FLAGS` entry `ggml-openvino` | `reactor_foundry.rs` |
| OpenVINO root + vcpkg toolchain in configure batch | `reactor_foundry.rs`, new `foundry_openvino.rs` or extend `foundry_toolchain.rs` |
| Skip CUDA nvcc / `CUDA_PATH` for this template_type | `reactor_foundry.rs` |
| Artifact mirror → `runtime/ggml-openvino/<env>/` | existing prerelease script |
| Optional: bundle minimal OpenVINO redistributable | legal + size review |

Foundry UI: show OpenVINO-specific cmake flags in WAIT-CONFIRM (same flow as CUDA).

---

## Phase 3 — Product polish (later)

- Model catalog badge: “NPU-friendly” (Q4_K_M, ≤8B) from static allowlist + POC results
- Telemetry: NPU utilization (Intel API / WMI — research per driver)
- Speech pipeline: separate thin model slot or link to EXTRAS playground
- In-app binary updates for `ggml-openvino` when `BINARY_UPDATES_ENABLED` ships

---

## Artifacts checklist (manual → app handoff)

Copy these from the 386H machine into repo or shared drive **before** Phase 1 coding:

- [ ] `poc-log.md` (versions, env vars, model matrix results)
- [ ] `llama-server.exe` + dependent DLLs (full set)
- [ ] `llama.cpp` git SHA
- [ ] OpenVINO version string
- [ ] NPU + graphics driver versions
- [ ] Working launch script (`.bat` / `.ps1`) from **clean** environment
- [ ] One saved engine log (stderr) for Fusion validation
- [ ] `curl` examples for `/health`, `/completion`
- [ ] List of params that **must not** be passed (CUDA-only flags that break OpenVINO)

---

## Risk register

| Risk | Mitigation |
|------|------------|
| Panther Lake NPU 5 newer than upstream validation table | Pin latest OpenVINO 2026.x; fail POC early |
| OpenVINO graph compile slow on first load | Document warm-up; UI “compiling…” state later |
| Large DLL footprint | Phase 1: user-installed OpenVINO; Phase 2: redist subset |
| `GGML_OPENVINO` WIP — wrong quant / architecture | Stay on Q4_K_M; document failures in poc-log |
| GUI app PATH unlike dev `cmd` | POC gate G3 from clean shell |
| 50 TOPS ≠ fast 8B TG | Position as 1B–3B / speech / always-on assistant, not main LLM |

---

## Implementation order (when you return from POC)

```
1. Paste artifacts → src-tauri/runtime/ggml-openvino/stable/
2. Add ggml-openvino-default-config.json (templateVersion 1)
3. engine_stack.rs — provider env + PATH
4. templates.rs — ov_device → env; skip ngl when ngl_flag empty
5. Frontend — hide CUDA params when provider id is ggml-openvino
6. Smoke: OPERATIONS launch, Fusion tick, logs tab
7. Foundry profile (Phase 2)
```

---

## References

- [llama.cpp OPENVINO backend](https://github.com/ggml-org/llama.cpp/blob/master/docs/backend/OPENVINO.md)
- [OpenVINO install (Windows archive)](https://docs.openvino.ai/2026/get-started/install-openvino/install-openvino-archive-windows.html)
- [OpenVINO hardware acceleration config](https://docs.openvino.ai/2026/get-started/install-openvino/configurations.html)
- Blackwell Ops: `docs/dev-paths-and-workflow.md` (runtime / factory paths)
- Blackwell Ops: `AGENTS.md` (Foundry artifacts path, spawn_profile invariants)

---

*Last updated: 2026-07-05 — manual POC phase, Core Ultra 9 386H Panther Lake.*