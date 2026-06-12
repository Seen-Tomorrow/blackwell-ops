# ⚡ Blackwell Ops (Foundry)

**The ultra-lean, high-concurrency native Windows command center for local LLM orchestration. No Electron bloat. No Docker overhead. No WSL2 latency. Built in pure Rust to push hardware to its absolute limit.**

[![Release](https://img.shields.io/github/v/release/Seen-Tomorrow/blackwell-ops?style=flat-square&color=76B900)](https://github.com/Seen-Tomorrow/blackwell-ops/releases)
[![Platform](https://img.shields.io/badge/platform-Windows%20x64-0078D6?style=flat-square&logo=windows)]()
[![Stack](https://img.shields.io/badge/core-Rust%20%2B%20Tauri%20v2-orange?style=flat-square&logo=rust)]()
[![Memory Cost](https://img.shields.io/badge/Idle%20RAM-90%20MB-blue?style=flat-square)]()

---

## 🦅 The Mission: Windows is NOT the Compromise

The narrative that you need a heavy Linux environment or complex virtualized Docker containers to run serious, high-throughput LLM workloads on consumer hardware is dead. 

**Blackwell Ops** is a hyper-optimized Win32 orchestrator designed for AI power-users, developers, and node operators. It treats your hardware with absolute respect, acting as a lightweight, zero-registry package manager and concurrent execution layer that lets you spin up, monitor, and scale up to **64 parallel engine slots** simultaneously.

---

## 📊 Performance By The Numbers (The Reality Check)

| Metric | Blackwell Ops Core | Typical Electron AI Wrappers |
| :--- | :--- | :--- |
| **Idle Memory Footprint** | **~90 MB RAM Total** (38MB Rust binary + ~52MB native Webview shell) | ~800 MB – 1.5 GB RAM (Static base cost) |
| **Core Executable Size** | **~12 MB** (Pure, highly optimized compiled Rust) | ~400 MB+ |
| **Max Concurrent Engines** | **Up to 64 independent slots** fully orchestrated | Hard-capped or chokes under single-threaded loops |
| **Stress-Test Memory Overhead** | **~400 MB total RAM** while actively managing **64 running engine instances** with 64 concurrent log & metric streams | Crashes or throttles system I/O entirely |
| **Peak Local Inference Speeds** | **805+ tok/s Single Gen / 23,419+ tok/s Prefill** (Tested on Blackwell workstation topology) | Single-threaded serialization bottlenecks |

---

## ⚡ The Headliners (Why This Repository is Different)

### 🧠 The 4-Tier Memory Estimation Engine (Absolute VRAM Control)
Never guess if a model will fit or cause an OOM crash again. We built a hyper-precise predictive allocation matrix:
* **Formula Mode:** Real-time auto-calculation derived directly from raw GGUF model metadata.
* **FIT Scan:** A robust, 29-point automated hardware scanner that probes the model using detailed multipoint measurements and interpolates with your current config on the fly.
* **FIT Probe:** One-click on-demand synthetic profiling for any unmapped model architectures.
* **LEARN Mode:** The app actively parses hardware memory breakdowns upon every live model launch, storing the footprint data forever to continually maximize estimation precision over time.

### 🏭 Completely Silent Background Foundry
Compile bleeding-edge `llama-server` binaries straight from upstream source code without staring at a black-and-white CMD terminal for 10 minutes. The Foundry engine handles native local compilation (CUDA 12.8 - 13.3 + VS Build Tools) completely in the background, minimized seamlessly. Once the build finishes, it instantly hot-swaps into your runtime—**zero configuration required, instant inference.**

### 🏎️ Integrated MTP (Speculative Decoding Masterclass)
Full native support for Multi-Token Prediction (MTP). Run the community's favorite heavy-hitting coding models like **Qwen3.6-27B reaching up to 165+ TPS** on enterprise workstation silicon, bringing production-grade generation speeds straight to local consumer hardware.

### 🎛️ Undockable Unified System Console & Real-time Log Filters
Total transparency. The application features a persistent, system-wide live event tracking console. Keep it as a clean 1-line status ticker, expand it to a 5-category matrix control panel, or **undock it completely** to slide and resize it onto a secondary monitor. Includes real-time log searching with multi-string color highlighting to track execution hooks instantly.

### 🚀 5-Second Zero-Copy Onboarding (LM-Studio Sync)
Don’t waste solid-state drive space or time duplicating massive datasets. Point Blackwell Ops at your existing machine cache, or use our robust **1-Click LM-Studio Migration tool** which automatically verifies and discovers localized libraries even if you moved them to custom paths. 

### 📦 Decoupled Portable Toolchains
The entire folder layout is completely relative. Drag, drop, or clone the application directory anywhere—even a portable high-speed external NVMe drive—and it executes flawlessly without breaking Windows registry paths. The app includes a decoupled, 1-click portable toolchain download module (including CUDA 13.3 environments) to guarantee pristine compilation states independent of the host machine's global system variables.

---

## 🎨 Immersive Interface Themes
Tailor your workspace to your environment with 5 distinct, high-fidelity color profiles baked right into the layout framework:
* **Arctic:** An ultra-premium, high-contrast crisp scientific look.
* **Amber / Cyan / Slate / Matrix:** Dark-mode terminal palettes engineered to reduce eye strain during extended, multi-engine coding sessions.

---

## 🚀 Quick Start

1. Head over to the [Releases Page](https://github.com/Seen-Tomorrow/blackwell-ops/releases) and grab the latest release bundle (`~750MB`, pre-packed with 5 fine-tuned engines for GGML and IK).
2. Extract or install the application footprint to any preferred directory path.
3. Pass the brief, two-step onboarding wizard to map your GGUF directory.
4. Select a pre-configured hardware profile (**FRONTIER / VANGUARD / FRESH / STABLE**).
5. Load your model, activate your target context slots (with true, independent per-slot cumulative tracking tank bars), and fire up your processing matrix.

---

## 💻 Local Development Workflow

```powershell
# Initialize development dependency layers
npm install

# Boot up local interactive hot-reloading development panel
npm run dev

# Package optimized native production release assets via specialized NSIS pipeline
npm run release