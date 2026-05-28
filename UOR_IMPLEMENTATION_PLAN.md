# Universal Output Receiver — Detailed Implementation Plan

**Document Purpose:** This is the authoritative, step-by-step implementation plan for introducing a power-user tabbed text output console into the application. It incorporates all confirmed product decisions as of April 2026.

**Core Philosophy (User Requirement):** All names in code, types, modules, events, and UI elements must be **explicit, revealing, and human-readable**. Length is acceptable if it removes ambiguity. Cryptic short names or names that differ by only one character from others are to be avoided.

---

## 1. Confirmed Product Decisions

- The console is for **power users** only.
- It is gated behind the existing Power User toggle (the 3-way switch currently referred to as the admin/power user control in the top-right header).
- Output is **text streams** that can be colored, filtered, and searched. Full interactive PTY shells are out of scope for the initial version.
- Tabs are **static categories**, not dynamically created per session.
- Initial categories: `ENGINES`, `UTILS`, `FOUNDRY`, `ERROR`. A `GENERAL` catch-all may be added if needed.
- Long-term: The list of categories may be moved into application configuration for extensibility without code changes.
- **Buffer strategy**:
  - Default of approximately 2000 lines per category.
  - **Builds (FOUNDRY category)** follow a **session-per-build** model: the full output for a build is kept while the build modal is open. When the user closes the build modal after a successful completion, that build’s buffer is cleared.
- **UI placement**:
  - Bottom panel style.
  - Expandable and collapsible.
  - Detachable (can float as a window).
  - When collapsed/docked near the status bar: shows a compact bar displaying only the last line, with distinct styling. Expanding reveals the full tabbed console.
- **Color support**: Colors are desired for important information. Raw ANSI escape sequences should be avoided. We will use controlled, semantic styling instead.
- Memory discipline matters. Per-tab Clear (“C”) and Save (“S”) actions are required, plus a global “Clear All” option.

---

## 2. Recommended Name Options for the Feature

The working title “Universal Output Receiver” was rejected (Flux capacitor association).

Here are strong, professional naming options. All follow the explicit, descriptive naming preference:

1. **Output Console** — Simple, clear, widely understood.
2. **System Output Console** — Emphasizes it shows internal/system-level streams.
3. **Runtime Output Console** — Highlights that it shows live runtime activity.
4. **Activity Output Console** — Focuses on the “things happening” nature.
5. **Command Output Console** — Highlights that much of the content will be command execution output.
6. **Internal Output Console** — Signals that this is deeper/internal information.
7. **Advanced Output Console** — Directly communicates it is for advanced/power users.
8. **Application Output Console** — Neutral and descriptive.

**Recommendation from the plan author:**  
**“Output Console”** or **“System Output Console”** are the strongest for long-term clarity and discoverability.

Please pick one (or propose a variation). Once chosen, we will use that name consistently in all code, comments, and UI text.

---

## 3. Naming Philosophy (Strictly Enforced)

All new code must use long, descriptive, self-documenting names.

Examples of good vs bad (for this project):

**Good:**
- `OutputConsoleCategory`
- `FoundryBuildSessionOutputBuffer`
- `RequestOutputBufferForCategory`
- `ClearOutputBufferForCategory`
- `OutputConsoleCollapsedStatusBar`
- `EmitTextStreamToOutputConsole`

**Avoid:**
- `Cat`, `OCat`, `Buf`, `out`, `console`, `logHub` (when it can be more specific)

We will prefer clarity over brevity in all new modules, types, functions, and events.

---

## 4. High-Level Architecture

### 4.1 Rust Side Ownership
- Rust becomes the **single source of truth** for all output streams that feed the console.
- The frontend only ever holds a small, controlled window of data.
- This directly addresses the current memory problem where large volumes of build output were accumulated in React state.

### 4.2 Frontend Role
- The frontend is a **consumer and presenter**, not the primary storage.
- It requests data on demand and receives live tail updates for the currently visible tab.

---

## 5. Detailed Rust-Side Design

### 5.1 New Module Recommendation

Create a new dedicated module because this is a distinct responsibility:

**Recommended new file:** `src-tauri/src/output_console.rs`

This keeps it separate from the existing `log_hub.rs` (which is more engine-slot specific).

### 5.2 Core Types (with explicit names)

```rust
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum OutputConsoleCategory {
    Engines,
    Utils,
    Foundry,
    Error,
    General, // optional
}

pub struct OutputConsoleTextLine {
    pub timestamp: String,
    pub content: String,
    pub style: OutputConsoleLineStyle, // controlled enum, not raw ANSI
}

pub enum OutputConsoleLineStyle {
    Normal,
    Command,
    Success,
    Warning,
    Error,
    Highlight,
    // extend as needed
}

pub struct OutputConsoleCategoryBuffer {
    pub category: OutputConsoleCategory,
    pub maximum_line_count: usize,
    pub lines: VecDeque<OutputConsoleTextLine>,
}

pub struct FoundryBuildOutputSession {
    pub build_session_id: u64,
    pub provider_id: String,
    pub environment: String,
    pub started_at: Instant,
    pub buffer: OutputConsoleCategoryBuffer, // or reference into the main one
}
```

### 5.3 Central Manager

**Recommended name:** `OutputConsoleManager`

This struct will live in `AppContext` or as a separate managed state.

Responsibilities:
- Own all category buffers.
- Own active `FoundryBuildOutputSession` instances.
- Provide methods with very explicit names:
  - `emit_line_to_category(...)`
  - `start_new_foundry_build_session(...)`
  - `end_foundry_build_session(...)`
  - `clear_category_buffer(...)`
  - `clear_all_buffers(...)`
  - `get_recent_lines_for_category(...)`
  - `get_lines_in_range_for_category(...)`

### 5.4 Tauri Commands (explicit names)

- `get_output_console_categories`
- `get_output_console_buffer_for_category`
- `clear_output_console_category`
- `clear_all_output_console_buffers`
- `save_output_console_category_to_file`
- `start_output_console_foundry_build_session` (if needed for coordination)

---

## 6. Detailed Frontend-Side Design

### 6.1 New Components (Recommended)

Because the user prefers clarity, we will create focused components rather than one giant file.

Suggested new files under `src/components/`:

- `OutputConsole.tsx` — main orchestrator / panel
- `OutputConsoleTabBar.tsx`
- `OutputConsoleContent.tsx` — the actual virtualized text viewer
- `OutputConsoleCollapsedBar.tsx` — the compact “last line” bar when docked/collapsed
- `OutputConsoleLine.tsx` — individual line renderer with style mapping

### 6.2 Gating

The entire `OutputConsole` (and its collapsed bar) should only render when the Power User mode is active. This reuses the existing toggle logic.

### 6.3 Interaction Model

- Collapsed state: Shows a distinct bar (possibly attached near status bar) with the last line of the currently active/selected category.
- Expanded state: Full tabbed view with virtualized content.
- Detach button turns the panel into a floating window.
- Per-tab actions: Clear (C), Save (S)

---

## 7. Buffer & Memory Strategy (Detailed)

- Category buffers are bounded (default ~2000 lines). Oldest lines are dropped when the limit is reached.
- For `FOUNDRY` category specifically:
  - A new `FoundryBuildOutputSession` is created when a build starts.
  - All output for that build goes into its dedicated buffer (or a tagged section).
  - When the user successfully closes the build modal, we explicitly call `end_foundry_build_session(...)` which clears that session’s data.
- Power users still have manual Clear per tab and Clear All as safety valves.

This combination should keep memory usage dramatically lower than the current “accumulate everything in React forever” approach.

---

## 8. Migration Strategy for Current Foundry Logging

Phase A (parallel run):
- Keep existing `foundry-progress` events flowing to the modal (so nothing breaks).
- Additionally emit the same lines into the new `OutputConsoleManager` under the `FOUNDRY` category.

Phase B:
- Reduce the amount of data the modal itself stores (it can become much dumber — just status + summary + “Open in Output Console” button).
- The rich log view gradually moves to the new console.

Phase C:
- Remove the heavy log accumulation from the modal entirely for new builds.
- Old behavior is fully deprecated.

---

## 9. Phased Implementation Roadmap

**Phase 0 – Preparation (this work)**
- Finalize name for the feature.
- Lock this plan.

**Phase 1 – Rust Foundation**
- Create `src-tauri/src/output_console.rs`
- Define `OutputConsoleCategory`, `OutputConsoleTextLine`, `OutputConsoleLineStyle`, etc. with explicit names.
- Implement `OutputConsoleManager` with basic bounded buffers.
- Add Tauri commands for reading and clearing.
- Wire a simple emitter from the existing Foundry build path (dual emit).

**Phase 2 – Basic Frontend**
- Create the new component files listed above.
- Implement collapsed bar + expandable panel.
- Connect to the new Tauri commands.
- Gate behind Power User mode.
- Add per-tab Clear and Save buttons (Save can write to user-chosen file).

**Phase 3 – Polish & Foundry Migration**
- Add virtualization to the content viewer.
- Implement proper `FoundryBuildOutputSession` lifecycle + clearing on modal close.
- Reduce log data stored inside `FoundryBuildProgress.tsx`.
- Improve styling and color mapping.

**Phase 4 – Additional Categories & Features**
- Wire `ENGINES`, `UTILS`, `ERROR` categories from existing systems.
- Add basic filtering/search if desired.
- Consider configuration-driven categories.

---

## 10. New Files Expected

Rust:
- `src-tauri/src/output_console.rs` (new module)

Frontend:
- `src/components/OutputConsole.tsx`
- `src/components/OutputConsoleTabBar.tsx`
- `src/components/OutputConsoleContent.tsx`
- `src/components/OutputConsoleCollapsedBar.tsx`
- `src/components/OutputConsoleLine.tsx` (optional but recommended for clarity)

Possibly:
- A small types file: `src/lib/output_console_types.ts` if we want to share types cleanly.

---

## 11. Risks & Mitigations

- Risk: Adding another bottom panel increases UI density.  
  Mitigation: Start collapsed by default for power users; make it easy to ignore.

- Risk: Memory still grows if users never clear tabs.  
  Mitigation: Hard per-category caps + visible “C” buttons + auto-clear for build sessions.

- Risk: Coloring implementation becomes inconsistent.  
  Mitigation: Define a small, documented `OutputConsoleLineStyle` enum early.

---

**Next Action**

Please review this plan and pick a name for the feature from the list in section 2 (or propose your own).

Once you confirm the name and say you’re happy with the overall plan, we can begin **Phase 1** (Rust foundation) with the explicit, descriptive naming style you requested.

Ready when you are.