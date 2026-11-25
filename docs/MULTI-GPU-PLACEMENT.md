# Multi-GPU Placement & Mixed-Topology Roadmap

This document records the engine (`llama-server` / `ggml-master`) multi-GPU capabilities, the pre-release selective placement design, and the post-release roadmap.

---

## 1. Engine Capabilities (`llama-server` / `ggml-master`)

| Mechanism | Flag(s) | Behavior | Notes for Mixed / eGPU Topologies |
|---|---|---|---|
| **Process device mask** | `CUDA_VISIBLE_DEVICES=0,1` | Restricts which GPUs the process can see. | **Current backbone.** Everything in OPS (`engine_memory_view`, `vramLayerPlan`, `fit_scanner`, `occupied_target_devices`, telemetry) maps `CUDA0..k` to `gpu_mask`. |
| **Device list** | `-dev` / `--device CUDA0,CUDA1` | Selects offload devices without hiding other GPUs from the process. | Required if main model and draft/mmproj live on different GPUs. |
| **Split mode** | `-sm` / `--split-mode {none,layer,row,tensor}` | `layer` (pipelined), `row` (parallelized), `tensor` (parallelized, experimental). | With selective `gpu_mask`, `layer`/`tensor` only spans the chosen subset. |
| **Layer proportions** | `-ts` / `--tensor-split N0,N1,...` | Fraction of layers per visible device. | Driven by `vramLayerPlan.ts` (min-max utilisation DP over exact per-block byte sizes). |
| **Main GPU** | `-mg` / `--main-gpu N` | Holds scratch / small tensors / KV in `row` mode (default `0`). | With `CUDA_VISIBLE_DEVICES`, mask order already controls `CUDA0`. |
| **Draft model device** | `--spec-draft-device` (`-devd`) | Places speculative draft model on specific device(s) independent of main model. | Needs `-dev` instead of `CUDA_VISIBLE_DEVICES` when main and draft target different cards. |
| **Vision projector device** | `-mmdev` / `--mmproj-device` | Places `mmproj` on a specific device (default: follows `--device`). | Same visibility requirement as `--spec-draft-device`. |
| **Per-tensor placement** | `-ot` / `--override-tensor <regex>=<buf>` (and `-otd` for draft) | Pin arbitrary tensors/layers/experts to `CUDA0`/`CUDA1`/`CPU`. | Maximum power, high complexity across architectures. |
| **MoE / FFN CPU spill** | `-cmoe`, `-ncmoe N`, `-ncffn N`, `--moe-cache-mib`, `--moe-cache-cpu-share` | Spill MoE experts / dense FFNs to host RAM with optional GPU cache. | `--moe-cache-mib` splits across active GPUs via `-ts`. |
| **Per-device FIT margin** | `-fitt` / `--fit-target MiB0,MiB1,...` | Per-GPU free VRAM margin when `--fit on`. | Useful when one GPU drives a display. |
| **RPC** | `--rpc host:port,...` | Remote GPU offload over network. | Niche / post-release. |

---

## 2. Pre-Release Implementation (Current)

1. **Unified Multi-Select GPU Toggle (`GpuAssignPanel`)**
   - `config.device` stores either a single GPU (`"GPU-0"`) or a comma-separated subset (`"GPU-0,GPU-1"`).
   - Clicking a GPU chip toggles it in/out of the active set (at least 1 GPU always remains selected):
     - 1 GPU selected → `split = "none"`.
     - 2+ GPUs selected → `split` promotes to `"layer"` (or keeps `"row"` / `"tensor"` if already active).
   - `compute_gpu_mask_from_params` in `src-tauri/src/engine_utils.rs` emits `CUDA_VISIBLE_DEVICES` for the selected subset (e.g. `0,1`), isolating slow-link or occupied cards (e.g. TB3 eGPU) from the split.

2. **Scoped Layer-Split Planning & Forecast**
   - `useLayerPlan` and `ggml_master` forecast adapter scope layer-split planning and projected VRAM bars to the active GPU subset. Unselected GPUs show `0` projected load.

3. **Manual Exclude-from-Auto-Split (`GpuTopology`)**
   - Each GPU card in `GpuTopology` (when 2+ GPUs are present) has a compact `AUTO` / `NO SPLIT` toggle.
   - Excluded GPUs are persisted in `localStorage` (`BlackOps-excluded-auto-split-gpus`) and skipped by `FULL AUTO` auto-split and when expanding `SPLIT` from `none` to `layer`/`row`/`tensor`. They remain available for solo / manual selection.

4. **HW Monitor PCIe Link Speed Highlight (`HwGpu`)**
   - `pcieLinkTone(gen, width)` classifies effective link bandwidth (`0.25 * 2^(gen - 1) * width` GB/s):
     - `>= 32 GB/s` (e.g. Gen5 x8/x16, Gen4 x16) → `good` (green)
     - `>= 16 GB/s` (e.g. Gen5 x4, Gen4 x8, Gen3 x16) → `warn` (amber)
     - `< 16 GB/s` (e.g. Gen4 x4, Gen3 x8, Gen3 x4 / TB3) → `slow` (red)

---

## 3. Post-Release Roadmap

- **Per-GPU Tensor-Split Override Slider on the VRAM Bar**:
  - Reuse the MoE expert-cache slider pattern directly on the VRAM bar: drag to tune/override how much tensor weight each GPU receives with live visual confirmation. Useful for preferring faster GPUs or partitioning VRAM for concurrent model runs.
- **Switch `CUDA_VISIBLE_DEVICES` → `-dev` (`--device`)**:
  - Unlocks independent `--spec-draft-device` (draft model placement) and `--mmproj-device` (vision projector placement) without hiding GPUs from the process.
- **Weighted / Priority Split Policies**:
  - Support "fill primary first" (pack fast/large GPU to ceiling, spill remainder) alongside the current utilisation equalizer.
- **PCIe / Interconnect-Aware Auto-Placement**:
  - Automatically warn or exclude slow-link GPUs (e.g. Gen3 x4 / TB3) from auto-split while still allowing solo placement.
- **Per-Device FIT Margin (`--fit-target`) & Per-Tensor Presets (`-ot`)**:
  - Reserve extra headroom on display-attached GPUs and offer curated `-ot` presets for attention/KV vs. cold experts.
