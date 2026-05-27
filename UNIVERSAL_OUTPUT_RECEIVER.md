# Universal Output Receiver (UOR) — Architecture

**Date:** April 2026  
**Status:** Proposed Design  
**Audience:** Power users / Advanced operators

## 1. Goals

- Provide a clean, show/hide, **tabbed text output console** for power users.
- Act as a **universal receiver** for colored, filterable, searchable text streams coming from the Rust backend.
- Respect the product's performance focus and Windows-native desktop nature (no reliance on external terminals in release).
- Keep memory usage reasonable for normal users while allowing power users to see detailed output.
- Serve as the long-term home for verbose output (especially Foundry builds, engine commands, fit scanner, library scans, etc.).
- Replace the current pattern of dumping large amounts of text directly into React state (the main cause of the 1.7 GB webview memory after builds).

## 2. Product Context & Constraints

- This app is a **power-user focused, dense UI tool** (modernized TUI aesthetic).
- In release builds there is **no attached terminal**.
- Users have high freedom to configure and build custom engines.
- Memory discipline still matters — not everyone has 256 GB of RAM.

## 3. Core Model

### 3.1 Static Categories (Tabs)

Tabs are **static / category-based**, not dynamically created per session.

Initial proposed categories:

- **Builds** — Foundry custom builds (cmake configure + compilation output)
- **Engines** — Engine start/stop commands, full CLI that was executed
- **Fit Scanner** — Output from fit scanning operations
- **Library Scan** — Model/library scanning output
- **Errors** — Aggregated error/warning streams (optional)
- **General** — Catch-all / debug output

Emitters in Rust subscribe to one or more categories.

### 3.2 Buffer Strategy (Critical for Memory)

Different categories have different lifetime rules:

- **Builds**: Session-per-build. Full build is buffered while the build is active. When the user closes the build modal after a successful build, the buffer for that specific build is cleared.
- **Engines / Fit Scanner / Library Scan**: Bounded sliding window (e.g. last 2000–5000 lines per category, configurable).
- **Errors**: Longer retention (last N errors across sessions).

Every tab should have:
- Small action buttons: **C** (Clear), **S** (Save to file)
- A global "Clear All" action

### 3.3 Gating

The entire Output Console is initially gated behind the existing **Power User** toggle (the 3-way admin/power switch in the top right header, currently referred to as `isAdmin` in code).

This matches the user's current pattern for exposing advanced/internal features.

## 4. High-Level Architecture

### 4.1 Rust Side (Source of Truth)

- Central `OutputBus` / `OutputRegistry` (singleton or AppState-managed).
- Categories are defined as an enum or const strings.
- Emitters call something like:
  ```rust
  output_bus.emit(Category::Builds, line, style_metadata);
  ```
- Each category maintains its own buffer (bounded `VecDeque` or similar).
- For builds, we can have a **per-build session id** so we can clear precisely when that build modal closes.
- Tauri commands exposed:
  - `get_output_categories()`
  - `get_output_buffer(category, limit?)`
  - `clear_output_category(category)`
  - `clear_all_output()`
  - `save_output_category(category, path)`
  - (Optional later) `subscribe_live` via events for tailing

Rust should be responsible for:
- Coloring / metadata (if we want to preserve ANSI or our own style tags)
- Rate limiting / batching when output is extremely fast
- Memory caps per category

### 4.2 Frontend Side

- New component: `OutputConsole` (or `UniversalOutputPane`)
- Tab bar at the top with small action icons/buttons next to each tab (`C`, `S`, etc.)
- Main viewing area — should be virtualized (react-window or @tanstack/virtual) because even 2000 lines can hurt if rendered naively.
- Ability to show/hide the entire pane (dockable or bottom panel style, similar to how many IDEs do it).
- When gated behind power user mode, it can be completely absent from the DOM for normal users.

The console should feel like a "modern TUI output viewer" rather than a full xterm.js interactive terminal for now.

### 4.3 Data Flow for Builds (The Immediate Use Case)

Current pain: Every line is pushed as a `foundry-progress` event and accumulated in React state inside `FoundryModal` → massive memory after builds.

New desired flow:

1. During a Foundry build, Rust emits lines to `Category::Builds` (with build session id).
2. The `FoundryBuildProgress` component (after the recent split) only keeps a small window (or even just summary status).
3. Power users can open the Output Console → Builds tab to see the full (or large) output.
4. When the user closes the build modal after success → we send a command to clear that specific build's buffer in Rust.
5. On failure, the buffer can be kept longer or until user explicitly clears.

This directly solves the 1.7 GB webview problem while still giving power users excellent visibility.

## 5. Memory & Lifecycle Management

- Per-category bounded buffers (hard cap + drop oldest).
- Explicit clear on meaningful user actions (modal close after success for builds).
- "C" and "Clear All" buttons as first-class UI elements.
- Consider persisting nothing to disk by default (only on explicit Save).
- Future option: Per-category "Max lines to keep" setting in power user config.

## 6. Phased Implementation Suggestion

**Phase 1 (Foundation)**
- Define categories + OutputBus in Rust
- Basic Tauri commands (get buffer, clear, save)
- Simple frontend `OutputConsole` component (non-virtualized first)
- Gate behind existing power user toggle
- Wire the current Foundry build output to also emit to the new bus (dual emit temporarily)

**Phase 2**
- Add virtualization to the viewer
- Proper build session tracking + clear-on-modal-close logic
- Move the main log accumulation out of `FoundryBuildProgress` / modal
- Polish tab UI with small C/S buttons

**Phase 3 (Later)**
- More categories (Engines, Fit Scanner, etc.)
- Coloring / filtering / search in the console
- Optional live tailing improvements
- Possibly allow users to open the console automatically on certain events when in power user mode

## 7. Open Questions / Decisions Needed

- Exact list of initial categories?
- Default buffer size per category (e.g. 2000 lines)?
- Should the console be a bottom panel, a modal, or a separate floating window?
- Do we want simple ANSI color support from the beginning, or start with plain text + basic styling?
- Naming: "Output Console", "Log Console", "Command Output", "Universal Output Receiver"?

---

This document can serve as the single source of truth while we implement the system.

Next step: Once you confirm the direction above, we can start with the Rust `OutputBus` skeleton + the basic frontend component, and simultaneously plan the migration of Foundry build logging into this system.

Ready when you are.