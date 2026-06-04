// src-tauri/src/output_console.rs
//
// Blackwell Output Console
// This module owns the backend side of the Blackwell Output Console feature.
//
// Philosophy (as per project guidelines):
// - All names must be explicit, descriptive, and human-readable.
// - Length is preferred over ambiguity.
// - We avoid short cryptic names that are easy to confuse with other similar concepts.

use serde::Serialize;
use std::collections::VecDeque;
use std::time::Instant;

/// The official name of this feature as chosen by the user.
/// Used in logs, errors, and documentation.
pub const BLACKWELL_OUTPUT_CONSOLE_FEATURE_NAME: &str = "Blackwell Output Console";

/// Static categories (tabs) available in the Blackwell Output Console.
///
/// These are intentionally kept as a simple enum for now.
/// Long-term this list may be moved into application configuration.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize)]
pub enum BlackwellOutputConsoleCategory {
    /// Output related to starting, stopping, and managing inference engines.
    Engines,

    /// Output from various utility operations (model scanning, library scanning, fit scanning, etc.).
    Utils,

    /// Output from custom engine builds performed via the Foundry system.
    Foundry,

    /// Aggregated error and warning messages from across the application.
    Error,

    /// General / miscellaneous output that does not clearly belong to another category.
    General,

    /// Debug output for development and troubleshooting.
    Debug,
}

impl BlackwellOutputConsoleCategory {
    /// Returns a stable, human-readable identifier suitable for serialization and config.
    pub fn identifier(&self) -> &'static str {
        match self {
            BlackwellOutputConsoleCategory::Engines => "engines",
            BlackwellOutputConsoleCategory::Utils => "utils",
            BlackwellOutputConsoleCategory::Foundry => "foundry",
            BlackwellOutputConsoleCategory::Error => "error",
            BlackwellOutputConsoleCategory::General => "general",
            BlackwellOutputConsoleCategory::Debug => "debug",
        }
    }

    /// Returns a user-facing display name for this category.
    pub fn display_name(&self) -> &'static str {
        match self {
            BlackwellOutputConsoleCategory::Engines => "Engines",
            BlackwellOutputConsoleCategory::Utils => "Utils",
            BlackwellOutputConsoleCategory::Foundry => "Foundry",
            BlackwellOutputConsoleCategory::Error => "Error",
            BlackwellOutputConsoleCategory::General => "General",
            BlackwellOutputConsoleCategory::Debug => "Debug",
        }
    }
}

/// Controlled set of styles that can be applied to a line in the Blackwell Output Console.
///
/// We deliberately avoid raw ANSI escape codes. Instead we use a small, well-defined set of
/// semantic styles that the frontend can render consistently.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum BlackwellOutputConsoleLineStyle {
    /// Normal, unstyled output.
    Normal,

    /// Lines that represent a command being executed (e.g. full CLI invocation).
    Command,

    /// Successful completion messages.
    Success,

    /// Non-critical warnings.
    Warning,

    /// Errors and critical failures.
    Error,

    /// Information that should stand out (e.g. important milestones during a build).
    Highlight,
}

/// A single line of text emitted to the Blackwell Output Console.
#[derive(Debug, Clone, Serialize)]
pub struct BlackwellOutputConsoleTextLine {
    /// ISO8601 timestamp when this line was captured.
    pub timestamp: String,

    /// The actual text content of the line.
    pub content: String,

    /// The semantic style to apply when rendering this line.
    pub style: BlackwellOutputConsoleLineStyle,
}

/// A bounded buffer that holds lines for one specific category of the Blackwell Output Console.
#[derive(Debug)]
pub struct BlackwellOutputConsoleCategoryBuffer {
    pub category: BlackwellOutputConsoleCategory,

    /// Maximum number of lines this buffer is allowed to hold.
    /// Older lines are dropped when this limit is exceeded.
    pub maximum_line_count: usize,

    /// The actual lines, stored oldest-first.
    pub lines: VecDeque<BlackwellOutputConsoleTextLine>,
}

impl BlackwellOutputConsoleCategoryBuffer {
    pub fn new(category: BlackwellOutputConsoleCategory, maximum_line_count: usize) -> Self {
        Self {
            category,
            maximum_line_count,
            lines: VecDeque::with_capacity(maximum_line_count),
        }
    }

    /// Appends a new line. If the buffer is at capacity, the oldest line is removed.
    pub fn append_line(&mut self, line: BlackwellOutputConsoleTextLine) {
        if self.lines.len() >= self.maximum_line_count {
            self.lines.pop_front();
        }
        self.lines.push_back(line);
    }

    /// Removes all lines currently stored in this buffer.
    pub fn clear(&mut self) {
        self.lines.clear();
    }

    /// Returns a snapshot of the most recent `count` lines (or all lines if fewer than `count` exist).
    pub fn get_last_lines(&self, count: usize) -> Vec<BlackwellOutputConsoleTextLine> {
        let start = if self.lines.len() > count {
            self.lines.len() - count
        } else {
            0
        };
        self.lines.range(start..).cloned().collect()
    }
}

/// Represents one complete Foundry build session from the perspective of the Blackwell Output Console.
///
/// We track builds separately from the general FOUNDRY category buffer so we can implement
/// "clear on successful modal close" behavior cleanly.
#[derive(Debug)]
pub struct BlackwellOutputConsoleFoundryBuildSession {
    pub build_session_id: u64,
    pub provider_id: String,
    pub environment: String,
    pub started_at: Instant,

    /// The actual lines captured for this specific build.
    pub buffer: BlackwellOutputConsoleCategoryBuffer,
}

impl BlackwellOutputConsoleFoundryBuildSession {
    pub fn new(
        build_session_id: u64,
        provider_id: String,
        environment: String,
        maximum_line_count: usize,
    ) -> Self {
        Self {
            build_session_id,
            provider_id,
            environment,
            started_at: Instant::now(),
            buffer: BlackwellOutputConsoleCategoryBuffer::new(
                BlackwellOutputConsoleCategory::Foundry,
                maximum_line_count,
            ),
        }
    }
}

/// The central manager for the entire Blackwell Output Console system.
///
/// This struct is intended to be stored in the main application state (AppContext or similar)
/// and is responsible for all buffering, session management, and clearing logic.
pub struct BlackwellOutputConsoleManager {
    /// One bounded buffer per static category.
    /// Wrapped in Mutex for interior mutability (Tauri commands usually give &AppContext).
    category_buffers: std::sync::Mutex<std::collections::HashMap<
        BlackwellOutputConsoleCategory,
        BlackwellOutputConsoleCategoryBuffer,
    >>,

    /// Currently active Foundry build sessions.
    active_foundry_build_sessions: std::sync::Mutex<std::collections::HashMap<u64, BlackwellOutputConsoleFoundryBuildSession>>,

    /// Default maximum number of lines per category buffer.
    default_maximum_lines_per_category: usize,
}

impl BlackwellOutputConsoleManager {
    pub fn new(default_maximum_lines_per_category: usize) -> Self {
        let mut category_buffers = std::collections::HashMap::new();

        for category in [
            BlackwellOutputConsoleCategory::Engines,
            BlackwellOutputConsoleCategory::Utils,
            BlackwellOutputConsoleCategory::Foundry,
            BlackwellOutputConsoleCategory::Error,
            BlackwellOutputConsoleCategory::General,
            BlackwellOutputConsoleCategory::Debug,
        ] {
            category_buffers.insert(
                category,
                BlackwellOutputConsoleCategoryBuffer::new(
                    category,
                    default_maximum_lines_per_category,
                ),
            );
        }

        Self {
            category_buffers: std::sync::Mutex::new(category_buffers),
            active_foundry_build_sessions: std::sync::Mutex::new(std::collections::HashMap::new()),
            default_maximum_lines_per_category,
        }
    }

    // ---------------------------------------------------------------------
    // Public API with explicit, descriptive names
    // ---------------------------------------------------------------------

    /// Emits a single line of text to the specified category.
    /// This is the primary method used by various parts of the application to contribute output.
    pub fn emit_line_to_category(
        &self,
        category: BlackwellOutputConsoleCategory,
        content: String,
        style: BlackwellOutputConsoleLineStyle,
    ) {
        let timestamp = chrono::Utc::now().to_rfc3339();

        let line = BlackwellOutputConsoleTextLine {
            timestamp,
            content,
            style,
        };

        if let Ok(mut buffers) = self.category_buffers.lock() {
            if let Some(buffer) = buffers.get_mut(&category) {
                buffer.append_line(line);
            }
        }
    }

    /// Starts tracking a new Foundry build session.
    /// All subsequent lines emitted for this build (via `emit_line_to_foundry_build_session`)
    /// will be stored in a dedicated buffer that can be cleared independently.
    pub fn start_new_foundry_build_session(
        &self,
        build_session_id: u64,
        provider_id: String,
        environment: String,
    ) {
        let session = BlackwellOutputConsoleFoundryBuildSession::new(
            build_session_id,
            provider_id,
            environment,
            self.default_maximum_lines_per_category,
        );

        if let Ok(mut sessions) = self.active_foundry_build_sessions.lock() {
            sessions.insert(build_session_id, session);
        }
    }

    /// Ends a Foundry build session and clears its associated buffer.
    /// This is typically called when the user closes the build modal after a successful build.
    pub fn end_foundry_build_session(&self, build_session_id: u64) {
        if let Ok(mut sessions) = self.active_foundry_build_sessions.lock() {
            if let Some(session) = sessions.remove(&build_session_id) {
                // Discard the per-build buffer on completion (design decision)
                drop(session);
            }
        }
    }

    /// Clears all lines from a specific category buffer.
    pub fn clear_category_buffer(&self, category: BlackwellOutputConsoleCategory) {
        if let Ok(mut buffers) = self.category_buffers.lock() {
            if let Some(buffer) = buffers.get_mut(&category) {
                buffer.clear();
            }
        }
    }

    /// Clears every category buffer and all active Foundry build sessions.
    pub fn clear_all_buffers(&self) {
        if let Ok(mut buffers) = self.category_buffers.lock() {
            for buffer in buffers.values_mut() {
                buffer.clear();
            }
        }
        if let Ok(mut sessions) = self.active_foundry_build_sessions.lock() {
            sessions.clear();
        }
    }

    /// Returns up to `limit` most recent lines for a category (newest last).
    pub fn get_recent_lines_for_category(
        &self,
        category: BlackwellOutputConsoleCategory,
        limit: usize,
    ) -> Vec<BlackwellOutputConsoleTextLine> {
        if let Ok(buffers) = self.category_buffers.lock() {
            if let Some(buffer) = buffers.get(&category) {
                return buffer.get_last_lines(limit);
            }
        }
        Vec::new()
    }

    // More methods (get_recent_lines, get_lines_in_range, etc.) will be added in subsequent steps.
}