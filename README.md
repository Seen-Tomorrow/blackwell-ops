# Blackwell Ops, pocket mini datacenter for local AI

**Windows-native local LLM inference** — a portable, tiny, single-exe multi-engine orchestrator for llama.cpp (official master + Tom TurboQuant fork). Built for GGUF models on Windows with easy Foundry builds from source , State of the art MEMORY forecast, and live fusion telemetry.
-support MTP, Dflash and TurboQuant out of the box.

No WSL. No Electron. No Docker required. Native desktop app for running and managing local llama servers on Windows.

[![Release](https://img.shields.io/github/v/release/Seen-Tomorrow/blackwell-ops?style=flat-square)](https://github.com/Seen-Tomorrow/blackwell-ops/releases)
![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D6?style=flat-square&logo=windows)
![Stack](https://img.shields.io/badge/core-Rust%20%2B%20Tauri%20v2-orange?style=flat-square&logo=rust)
![Mission](https://img.shields.io/badge/mission-local%20inference%20first-76B900?style=flat-square)

[→ Quick Start](#quick-start)

> *This project is my testament to open source and a **local inference first** mission.*

You do **not** need Linux to run serious LLM workloads on your own hardware.
Blackwell Ops exists to challenge it — directly, on Windows, with top performance and minimal memory footprint.
---
![Dashboard-themes](docs/screenshots/Dashboard-themes.png)
## What it is

Blackwell Ops is a native Windows desktop app for local LLM / llama.cpp users. It orchestrates multiple `llama-server` instances (GGUF models), provides a GGUF model library with VRAM estimation, one-click Foundry CMake builds, and real-time telemetry — all without Docker, WSL, or cloud dependencies. Fully portable and open source.

Drop the installer or portable folder anywhere. The app recreates its ecosystem around itself: configs, runtime engines, foundry artifacts, and user preferences — all relative to the install directory. Great for portable local LLM setups or moving between machines.

**At v1.0.x** we strongly focus on **GGML / llama.cpp** (official master + Tom TurboQuant fork bundled). 
Any llama-compatible fork can be easily wired in by users in 2 clicks. You will get most of funcionality right away, including 1click builds form source anytime. The architecture is **semi–backend-agnostic** by design — support grows over time.
---

## By the numbers

| | |
|---|---|
| **Core binary** | ~14 MB Rust executable |
| **Typical RAM (app shell)** | ~40 MB running — about half what Windows Notepad needs |
| **Engine slots (factory)** | Up to **64** concurrent instances (GGML master) |
| **Stress-tested** | **64** engine instances orchestrated with **~400 MB** total app RAM overhead |
| **Build investment** | ~**2,500+ hours** across ~5 months |
| **GPU targets** | **BLACKWELL** (heavily optimized), also **AMPERE · ADA** |

*Engine VRAM is separate — these figures are the ops layer, not model weights.*

---

## Why Blackwell Ops?

People running serious local LLMs on Windows often hit friction with existing tools:

| Tool          | Windows Native | Multiple Engines      | Easy Source Builds | Portable | Low Overhead | Full Config Freedom |
|---------------|----------------|-----------------------|--------------------|----------|--------------|---------------------|
| **Blackwell Ops** | ✅            | ✅ (up to 64 engines) | ✅ (Foundry)      | ✅      | ✅          | ✅                 |
| Ollama        | Partial (WSL)  | Limited               | No                 | No       | Medium       | Limited            |
| LM Studio     | ✅             | Limited               | No                 | No       | Medium       | Medium             |
| llama-server (bare) | ✅        | Manual                | Manual             | Partial  | ✅           | ✅ (CLI only)      |

**Blackwell Ops** is the Windows-native alternative to Ollama and LM Studio for power users who want full control over llama.cpp (and Tom TurboQuant builds) — multiple engines, source builds, and proper Windows integration.

### Parallel agents, no extra pain
Most users run models in a single session. But llama-server supports **multiple parallel slots** on one instance.

In Blackwell Ops you simply:
- Set 4× or 8× parallel slots on a single model / single port
- Tell your agent harness (OpenCode, etc.) something like:  
  *"Use up to 8 parallel agents for any suitable work or sub-task"*

Real results on the same hardware:
- Qwen3.6-27B single slot + MTP → ~185 TPS per session, but **prefill is halved** (painful for coding)
- Same model, **8× parallel, MTP off** → 330+ total TPS on one GPU
- 2× RTX Pro with tensor split → **850 TPS** combined, with full prefill speed

You get dramatically higher aggregate throughput and much snappier prefill behavior for agentic workflows — with almost no extra power draw.

(You can also run completely separate engine instances if you prefer full isolation.)

### Speculative decoding — MTP & DFlash, out of the box

Blackwell Ops treats faster generation as a first-class feature, not a hidden CLI flag. **Multi-Token Prediction (MTP)** and **DFlash** speculative decoding are wired through the whole stack — catalog, pairing, launch, and telemetry — so you can rapidly test a ton of settings just by clicking.

| | **MTP** | **DFlash** |
|---|---------|------------|
| **What it is** | Draft tokens baked into the main GGUF (`nextn` layers) | Separate lightweight draft model loaded alongside the main |
| **Best for** | Single-session speed on MTP-capable weights (Qwen 3.x, etc.) | Multi-slot / agent workloads — full prefill speed with parallel agents |
| **Setup** | Turn spec on — no second file | Family-matched draft picker finds the right `.gguf` in your library |
| **Parallel slots** | Use **1×** parallel (MTP + multi-slot conflict) | **4× / 8×** parallel — aggregate TPS without halving prefill |

**What you get in the app**

- **Smart catalog** — MAIN / DRAFT / ALL filter; DFLASH badges on external draft models; Gemma, Qwen, and family-aware pairing (no random cross-family matches).
- **Engine config** — spec group with ON/OFF toggle, live **MTP** / **DFLASH** mode badge, and a ★ best-match draft picker when DFlash is selected.
- **Both on the same main** — a model can ship with baked-in MTP *and* support an external DFlash draft; pick the mode that fits the workload (MTP for one chat, DFlash when you crank parallel agents).
- **FULL-AUTO + Essentials** — Regular Joe path: spec turns on when your model supports it, only **MTP** and **DFLASH** shown, sensible N-max / N-min presets applied automatically; Full config view stays untouched for power users.
- **Launch-safe** — draft-only GGUFs cannot be launched as mains; DFlash launches with `--fit off` and a resolved `--spec-draft-model` path.

*DFlash / external drafts are on **GGML master** today; Tom TurboQuant remains MTP-focused for now.*

### Core strengths
- **Native Rust + Tauri** — tiny footprint, no Electron bloat or Linux subsystem tax
- **Foundry** — one-click build `llama-server` from source with your preferred CUDA / VS version
- **Portable** — works from USB, relative paths everywhere
- **Multi-engine stack** — orchestrate many `llama-server` instances (or parallel slots) with a shared config system
- **Fusion telemetry** — real-time metrics from stderr + /slots without extra overhead

## Why Windows — on purpose

- **Native Rust, Win32/Tauri shell** — no Electron bloat, no Linux subsystem tax  
- **Foundry** — build `llama-server` from source on your machine (VS2022 / VS2026 + CUDA 12.8–13.3)  
- **Portable path model** — clone/move the folder, it still works, even from a flash drive.
- **Full config freedom** — factory templates merge with your overrides; nothing hidden behind a SaaS panel  
- **Low idle cost** — run many engine *slots* without many heavy processes until you launch  

---

## Bundled engine profiles (v1.0)

Pre-built binaries ship for multiple toolchain generations — pick the profile that matches your GPU and driver stack:

| Profile | CUDA | Toolchain |
|---------|------|-----------|
| **FRONTIER** | 13.3 | VS Build Tools 2026 | - The one Cuda to rule them all
| **STABLE** | 12.8 | VS Build Tools 2022 | - compatible path.

- Includes **GGML llama (master)** and **Tom-llama** runtimes.  
- Users can **Foundry-build** their own engines anytime (5minutes 1 click), or download asset packages later — the app does not lock you to shipped binaries.

---

## Features
- **Rapid onboarding** — two-click setup for local LLM on Windows from zero to first inference
- **GGUF Model Library** — catalog, metadata scan, VRAM fit estimation and benchmarks for your models
- **Multi-engine stack** — run, monitor, bench or stop many llama.cpp / llama-server instances side-by-side
- **Advanced Provider Config** — full params editor with 250+ parameters and factory templates
- **Foundry Builds** — update, configure, compile and publish llama-server binaries directly from the UI (custom CMake flags supported)
- **Fusion Telemetry** — real-time metrics (generation, prefill, progress) from multiple sources
- **MTP & DFlash speculative decoding** — catalog pairing, mode badges, draft picker, FULL-AUTO presets, full launch validation
- **Unified Console & Logs** — dockable logs for Engines, Foundry, Errors with search and syntax highlight (supports 64+ concurrent streams)
- **Portable & Lightweight** — relative paths, tiny RAM usage, works from USB stick, no registry
- **Hardware Monitoring** — GPU/CPU stats and vital signs
- **Zero Telemetry** — completely offline, no calling home, no data collection

Perfect for users looking for a **Windows native llama.cpp GUI**, **multiple llama engines**, or **portable local LLM server**.

---

## Screenshots & demo

A short auto-playing demo GIF lives in the Quick Start section below.

| Main dashboard | Engine stack | Foundry build |
|:---:|:---:|:---:|
| ![Dashboard](docs/screenshots/Dashboard.png) | ![Stack](docs/screenshots/Stack.png) | ![Foundry](docs/screenshots/Foundry.png) |

---

## Quick start

1. Download the latest **`Blackwell Ops_*_x64-setup.exe`** from [Releases](https://github.com/Seen-Tomorrow/blackwell-ops/releases).  
2. Install (or extract portable layout if you ship a zip).  
3. Point **Setup Guide → Step 1** at your GGUF model folder (or LM Studio / Ollama path).  
4. Pick a **provider profile** (FRONTIER or STABLE).  
5. Launch an engine.  

First-run onboarding walks the rest.

**Quick demo (replace the image below with a short `onboarding-demo.gif` for auto-playing inline preview):**

![Onboarding demo](docs/screenshots/Dashboard.png)

[Full video (MP4, 25s)](https://raw.githubusercontent.com/Seen-Tomorrow/blackwell-ops/main/docs/videos/blackwell_ops_onboarding.mp4)

### Requirements

- **Windows 10/11 x64**  
- **NVIDIA GPU** recommended (CUDA builds bundled), AMD, Intel will follow
- **GGUF models** — not included; you bring your own weights  
**Optional and trongly recommended** **BUILD TOOLS package** -for Foundry cmake builds
[BUILD TOOLS package](https://github.com/Seen-Tomorrow/blackwell-ops/releases/tag/toolchain).

---

## A personal note

I **vibe-coded** this app on **local models** — mostly **Qwen3.5 236B** + **Qwen3.6 27B** + **Step3.7-flash** — with hardening passes on **Composer 2.5**, on hand build custom workstation (**2× RTX PRO 6000 · 256 GB VRAM**).

I baked in **30+ years** of love for PC hardware and Windows — how machines should feel, how software should respect RAM, how inference should stay on *your* desk.

Roughly **3,000 hours** went into this across ~five months. Time not spent with my family and my **five-year-old daughter**, who I love more than anything. This repo is what that time became.

If Blackwell Ops helps one person run serious local inference on Windows without apologizing for their OS choice, it was worth it.
PS: This is my first coding endeavor. I openly state this, as inspiration to anyone hesitating to use AI besides chating. AI scene, including the local only is very powerfull already - DO NOT WAIT - JUST DO IT NOW, anyone can.
-This was very difficult project as a "starter", now it is progressively more easy. I had been fully determined to achieve this, since i had a strong skill in HW suite and clear idea how i want this to work. I would NEVER achieve that without AI - NEVER!
-I'am etternally gratefull to my family, to be supportive and respecting the need to pursue my purpose in this. Love you Karla.

---

## Roadmap (honest)

- [ ] In-app binary updates (GitHub release assets)  
- [ ] Broader backend adapters beyond GGML llama and TOM llama
- [ ] Deeper fusion metrics for third-party forks
- [ ] and one surprise very soon ;-)

---

## Links

- **Releases:** https://github.com/Seen-Tomorrow/blackwell-ops/releases  
- **Issues:** https://github.com/Seen-Tomorrow/blackwell-ops/issues  
- **Third-party notices:** [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (includes Nvidia Inspector / Orbmu2k attribution)

---

<p align="center">
  <strong>Local inference first. Windows is not the compromise.</strong><br>
  <sub>Built with open source engines, open source tools, and closed-door family time I'll try to win back.</sub>
</p>
