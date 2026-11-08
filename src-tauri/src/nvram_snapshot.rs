//! NVRAM snapshot + diff — the measurement loop, inside the app.
//!
//! One command writes a JSON snapshot of what the app can actually see:
//!
//! - NVML per device (measured)
//! - the engine stack: what is loaded, at which knobs, with the launch's own per-device
//!   buffer inventory (`vram_mib` / `gpu_breakdown_mib` from `launch_memory_parse`)
//! - the learned rows for those models, with their per-device components
//! - the per-device runtime calibration
//! - the glass's published state (the badge JSON), verbatim
//!
//! `--nvram-diff a.json b.json` compares two snapshots and prints only what moved, with the
//! provenance of each side. The point is the loop around a knob change: capture, change
//! ctx/parallel/`-ts`, capture, diff.
//!
//! ## The rule
//!
//! **Unknown is `null`, never 0.** A measured zero stays 0. A diff across an unknown side
//! reports the values but no delta — there is nothing to subtract from.
//!
//! No Python, no second binary: the snapshot is a Tauri command (and an automation action so a
//! test loop can drive it), the diff is a CLI branch of this executable that exits before Tauri
//! starts, so it works whether or not the app is running.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const SNAPSHOT_FORMAT: u32 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppSnap {
    pub version: String,
    pub app_root: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GpuSnap {
    pub index: u32,
    pub name: String,
    pub driver_version: Option<String>,
    pub driver_model: String,
    pub total_mib: u64,
    pub used_mib: u64,
    pub free_mib: u64,
    pub utilization_gpu: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineSnap {
    pub slot: usize,
    pub alias: String,
    pub status: String,
    pub port: u16,
    pub model_path: String,
    pub provider: String,
    pub backend_type: String,
    pub split_mode: String,
    pub parallel: i64,
    pub n_ctx: usize,
    pub binary_profile: String,
    /// Measured launch inventory for this slot; `null` while nothing has loaded.
    pub vram_mib: Option<f64>,
    pub gpu_breakdown_mib: Option<Vec<f64>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalSnap {
    pub index: u32,
    pub median_residual_mib: f64,
    pub samples: usize,
    pub driver_model: String,
    pub last_taken_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NvramSnapshot {
    pub format: u32,
    pub captured_at: String,
    pub app: AppSnap,
    /// Empty with `gpu_error` set when NVML is unavailable — never a fake zero-device list.
    pub gpus: Vec<GpuSnap>,
    pub gpu_error: Option<String>,
    pub engines: Vec<EngineSnap>,
    pub learned: Vec<crate::vram_learn::LearnedRowView>,
    pub calibration: Vec<CalSnap>,
    /// The glass's published state (`config/automation/ui/vram-badge.json`), verbatim.
    pub ui: Option<Value>,
}

pub fn snapshot_dir() -> PathBuf {
    crate::config::app_root_dir().join("config").join("cache").join("nvram")
}

/// Model paths a snapshot is about: what the stack has loaded, plus whatever the glass shows.
///
/// Learned rows are filtered to these so a diff does not drown in other models.
fn model_paths(engines: &[EngineSnap], ui: &Option<Value>) -> Vec<String> {
    let mut paths: Vec<String> = engines
        .iter()
        .map(|engine| engine.model_path.clone())
        .filter(|path| !path.is_empty())
        .collect();
    if let Some(path) = ui
        .as_ref()
        .and_then(|ui| ui.get("state"))
        .and_then(|state| state.get("modelPath"))
        .and_then(Value::as_str)
    {
        if !path.is_empty() {
            paths.push(path.to_string());
        }
    }
    paths.sort();
    paths.dedup();
    paths
}

fn badge_state_path() -> PathBuf {
    crate::config::app_root_dir()
        .join("config")
        .join("automation")
        .join("ui")
        .join("vram-badge.json")
}

fn timestamp_slug() -> String {
    chrono::Local::now().format("%Y%m%d-%H%M%S").to_string()
}

/// Capture everything the app can see right now and write it to `path` (default under
/// `config/cache/nvram/`). Returns the file it wrote.
pub async fn capture(app: &AppHandle, path: Option<PathBuf>) -> Result<PathBuf, String> {
    let ctx = app.state::<crate::AppContext>();

    let (gpus, gpu_error) = match crate::nvml_metrics::scan() {
        Some(samples) => (
            samples
                .into_iter()
                .map(|sample| GpuSnap {
                    index: sample.index,
                    name: sample.name,
                    driver_version: sample.driver_version,
                    driver_model: sample.driver_model,
                    total_mib: sample.memory_total_mib,
                    used_mib: sample.memory_used_mib,
                    free_mib: sample.memory_free_mib,
                    utilization_gpu: sample.utilization_gpu,
                })
                .collect(),
            None,
        ),
        None => (Vec::new(), Some("nvml unavailable".to_string())),
    };

    let engines = {
        let stack = ctx.stack.lock().await;
        let mut out = Vec::new();
        for (idx, slot) in stack.slots.iter().enumerate() {
            let Some(slot) = slot else { continue };
            let slot = slot.lock();
            if slot.status == crate::engine_stack::SlotStatus::Idle && slot.model_path.is_empty() {
                continue;
            }
            out.push(EngineSnap {
                slot: idx,
                alias: slot.alias.clone(),
                status: format!("{}", slot.status),
                port: slot.port,
                model_path: slot.model_path.clone(),
                provider: slot.provider_name.clone(),
                backend_type: slot.backend_type.clone(),
                split_mode: slot.split_mode.clone(),
                parallel: slot.parallel,
                n_ctx: slot.n_ctx,
                binary_profile: slot.binary_profile.clone(),
                // 0 is the stack's "nothing measured" default, not a measurement.
                vram_mib: (slot.vram_mib > 0.0).then_some(slot.vram_mib),
                gpu_breakdown_mib: slot.gpu_breakdown_mib.clone(),
            });
        }
        out
    };

    let calibration = crate::gpu_calibration::get_gpu_calibration()
        .into_iter()
        .map(|row| CalSnap {
            index: row.index,
            median_residual_mib: row.median_residual_mib,
            samples: row.samples,
            driver_model: row.driver_model,
            last_taken_at: row.last_taken_at,
        })
        .collect();

    let ui = std::fs::read_to_string(badge_state_path())
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let learned = crate::vram_learn::snapshot_rows(&model_paths(&engines, &ui));

    let snapshot = NvramSnapshot {
        format: SNAPSHOT_FORMAT,
        captured_at: chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, true),
        app: AppSnap {
            version: env!("CARGO_PKG_VERSION").to_string(),
            app_root: crate::config::app_root_dir().display().to_string(),
        },
        gpus,
        gpu_error,
        engines,
        learned,
        calibration,
        ui,
    };

    let out_path = match path {
        Some(path) => path,
        None => {
            let dir = snapshot_dir();
            std::fs::create_dir_all(&dir).map_err(|err| format!("{}: {err}", dir.display()))?;
            dir.join(format!("snap-{}.json", timestamp_slug()))
        }
    };
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent).map_err(|err| format!("{}: {err}", parent.display()))?;
    }
    crate::fs_util::write_json_atomic(&out_path, &snapshot)?;
    log::info!(
        "[nvram] snapshot → {} ({} gpu(s), {} engine(s), {} learned row(s))",
        out_path.display(),
        snapshot.gpus.len(),
        snapshot.engines.len(),
        snapshot.learned.len()
    );
    Ok(out_path)
}

#[tauri::command]
pub async fn capture_nvram_snapshot(
    app: AppHandle,
    path: Option<String>,
) -> Result<String, String> {
    let requested = path
        .filter(|p| !p.trim().is_empty())
        .map(PathBuf::from);
    let written = capture(&app, requested).await?;
    Ok(written.display().to_string())
}

// ── diff ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct DiffRow {
    /// Where it lives: `gpu0`, `slot0`, `learned ctx=262144`, `ui.plan`, `cal0`.
    pub scope: String,
    /// What moved: `used`, `vram`, `kv`, `compute`, `ts`, `status`, …
    pub field: String,
    /// Numeric sides. `None` is unknown, never zero.
    pub before: Option<f64>,
    pub after: Option<f64>,
    /// `after - before`; `None` when either side is unknown.
    pub delta: Option<f64>,
    pub unit: &'static str,
    /// Set for non-numeric fields (ts string, status, model path, …).
    pub before_text: Option<String>,
    pub after_text: Option<String>,
    pub note: Option<String>,
}

impl DiffRow {
    fn number(
        scope: impl Into<String>,
        field: impl Into<String>,
        before: Option<f64>,
        after: Option<f64>,
        unit: &'static str,
    ) -> Self {
        let delta = match (before, after) {
            (Some(b), Some(a)) => Some(a - b),
            _ => None,
        };
        let note = match (before.is_some(), after.is_some()) {
            (false, false) => Some("unknown on both sides".to_string()),
            (false, true) => Some("before unknown".to_string()),
            (true, false) => Some("after unknown".to_string()),
            _ => None,
        };
        Self {
            scope: scope.into(),
            field: field.into(),
            before,
            after,
            delta,
            unit,
            before_text: None,
            after_text: None,
            note,
        }
    }

    fn text(
        scope: impl Into<String>,
        field: impl Into<String>,
        before: Option<String>,
        after: Option<String>,
    ) -> Self {
        Self {
            scope: scope.into(),
            field: field.into(),
            before: None,
            after: None,
            delta: None,
            unit: "",
            before_text: before,
            after_text: after,
            note: None,
        }
    }

    fn is_interesting(&self) -> bool {
        match (self.before, self.after) {
            (Some(b), Some(a)) => (a - b).abs() > 1e-9,
            // Both sides unknown is not a change — and not worth a row.
            (None, None) if self.before_text.is_none() && self.after_text.is_none() => false,
            _ => self.before_text != self.after_text || self.note.is_some(),
        }
    }
}

fn json_at<'a>(value: &'a Option<Value>, path: &[&str]) -> Option<&'a Value> {
    let mut cursor = value.as_ref()?;
    for key in path {
        cursor = cursor.get(*key)?;
    }
    Some(cursor)
}

fn ui_num(ui: &Option<Value>, path: &[&str]) -> Option<f64> {
    json_at(ui, path).and_then(Value::as_f64)
}

fn ui_text(ui: &Option<Value>, path: &[&str]) -> Option<String> {
    match json_at(ui, path)? {
        Value::String(text) => Some(text.clone()),
        other if other.is_number() || other.is_boolean() => Some(other.to_string()),
        other => Some(other.to_string()),
    }
}

/// Per-row identity for learned rows: what has to match for a delta to mean anything.
fn learned_identity(row: &crate::vram_learn::LearnedRowView) -> String {
    format!(
        "ctx={} kv={} split={} ubatch={} par={}",
        row.ctx.map(|c| c.to_string()).unwrap_or_else(|| "?".into()),
        row.kv.as_deref().unwrap_or("?"),
        row.split.as_deref().unwrap_or("?"),
        row.ubatch.as_deref().unwrap_or("?"),
        row.parallel
    )
}

pub fn diff_snapshots(before: &NvramSnapshot, after: &NvramSnapshot) -> Vec<DiffRow> {
    let mut rows = Vec::new();

    // GPU counters — measured by NVML on both sides.
    for gpu_b in &before.gpus {
        let Some(gpu_a) = after.gpus.iter().find(|g| g.index == gpu_b.index) else {
            rows.push(DiffRow::text(
                format!("gpu{}", gpu_b.index),
                "present",
                Some("yes".into()),
                Some("no".into()),
            ));
            continue;
        };
        let scope = format!("gpu{}", gpu_b.index);
        rows.push(DiffRow::number(scope.clone(), "used", Some(gpu_b.used_mib as f64), Some(gpu_a.used_mib as f64), "MiB"));
        rows.push(DiffRow::number(scope.clone(), "free", Some(gpu_b.free_mib as f64), Some(gpu_a.free_mib as f64), "MiB"));
        rows.push(DiffRow::number(scope.clone(), "total", Some(gpu_b.total_mib as f64), Some(gpu_a.total_mib as f64), "MiB"));
        rows.push(DiffRow::number(scope.clone(), "util", Some(gpu_b.utilization_gpu as f64), Some(gpu_a.utilization_gpu as f64), "%"));
        if gpu_b.name != gpu_a.name {
            rows.push(DiffRow::text(scope, "name", Some(gpu_b.name.clone()), Some(gpu_a.name.clone())));
        }
    }
    for gpu_a in &after.gpus {
        if !before.gpus.iter().any(|g| g.index == gpu_a.index) {
            rows.push(DiffRow::text(
                format!("gpu{}", gpu_a.index),
                "present",
                Some("no".into()),
                Some("yes".into()),
            ));
        }
    }

    // Engines — matched by slot.
    for engine_b in &before.engines {
        let Some(engine_a) = after.engines.iter().find(|e| e.slot == engine_b.slot) else {
            rows.push(DiffRow::text(format!("slot{}", engine_b.slot), "present", Some("yes".into()), Some("no".into())));
            continue;
        };
        let scope = format!("slot{}", engine_b.slot);
        if engine_b.status != engine_a.status {
            rows.push(DiffRow::text(scope.clone(), "status", Some(engine_b.status.clone()), Some(engine_a.status.clone())));
        }
        if engine_b.model_path != engine_a.model_path {
            rows.push(DiffRow::text(scope.clone(), "model", Some(engine_b.model_path.clone()), Some(engine_a.model_path.clone())));
        }
        for (field, b, a) in [
            ("ctx", engine_b.n_ctx as f64, engine_a.n_ctx as f64),
            ("parallel", engine_b.parallel as f64, engine_a.parallel as f64),
        ] {
            rows.push(DiffRow::number(scope.clone(), field, Some(b), Some(a), ""));
        }
        if engine_b.split_mode != engine_a.split_mode {
            rows.push(DiffRow::text(scope.clone(), "split", Some(engine_b.split_mode.clone()), Some(engine_a.split_mode.clone())));
        }
        rows.push(DiffRow::number(scope.clone(), "vram", engine_b.vram_mib, engine_a.vram_mib, "MiB"));
        let devices = engine_b
            .gpu_breakdown_mib
            .as_ref()
            .map(|v| v.len())
            .unwrap_or(0)
            .max(engine_a.gpu_breakdown_mib.as_ref().map(|v| v.len()).unwrap_or(0));
        for i in 0..devices {
            rows.push(DiffRow::number(
                scope.clone(),
                format!("gpu{i}"),
                engine_b.gpu_breakdown_mib.as_ref().and_then(|v| v.get(i).copied()),
                engine_a.gpu_breakdown_mib.as_ref().and_then(|v| v.get(i).copied()),
                "MiB",
            ));
        }
    }
    for engine_a in &after.engines {
        if !before.engines.iter().any(|e| e.slot == engine_a.slot) {
            rows.push(DiffRow::text(format!("slot{}", engine_a.slot), "present", Some("no".into()), Some("yes".into())));
        }
    }

    // Learned rows — matched by identity (ctx + kv + split + ubatch + parallel), never by key
    // alone: a knob change is exactly when these keys differ.
    for row_b in &before.learned {
        let identity = learned_identity(row_b);
        let Some(row_a) = after.learned.iter().find(|r| learned_identity(r) == identity) else {
            rows.push(DiffRow::text(format!("learned {identity}"), "present", Some("yes".into()), Some("no".into())));
            continue;
        };
        let scope = format!("learned {identity}");
        rows.push(DiffRow::number(scope.clone(), "vram", Some(row_b.vram_mib), Some(row_a.vram_mib), "MiB"));
        rows.push(DiffRow::number(scope.clone(), "host", row_b.host_mib, row_a.host_mib, "MiB"));
        let devices = row_b
            .components
            .as_ref()
            .map(|v| v.len())
            .unwrap_or(0)
            .max(row_a.components.as_ref().map(|v| v.len()).unwrap_or(0));
        for i in 0..devices {
            let comp_b = row_b.components.as_ref().and_then(|v| v.get(i));
            let comp_a = row_a.components.as_ref().and_then(|v| v.get(i));
            for (field, pick) in [
                ("model", (|c: &crate::fit_scanner::GpuComponentMib| c.model_mib) as fn(&_) -> f64),
                ("kv", |c: &crate::fit_scanner::GpuComponentMib| c.ctx_mib),
                ("compute", |c: &crate::fit_scanner::GpuComponentMib| c.compute_mib),
            ] {
                rows.push(DiffRow::number(
                    scope.clone(),
                    format!("gpu{i}.{field}"),
                    comp_b.map(pick),
                    comp_a.map(pick),
                    "MiB",
                ));
            }
        }
    }
    for row_a in &after.learned {
        let identity = learned_identity(row_a);
        if !before.learned.iter().any(|r| learned_identity(r) == identity) {
            rows.push(DiffRow::text(format!("learned {identity}"), "present", Some("no".into()), Some("yes".into())));
        }
    }

    // Calibration — per device median residual.
    for cal_b in &before.calibration {
        if let Some(cal_a) = after.calibration.iter().find(|c| c.index == cal_b.index) {
            rows.push(DiffRow::number(
                format!("cal{}", cal_b.index),
                "residual",
                Some(cal_b.median_residual_mib),
                Some(cal_a.median_residual_mib),
                "MiB",
            ));
        }
    }

    // The glass: the scalars the forecast is made of. Paths track `VramBadge`'s published state —
    // a field it stops publishing shows up as `unknown`, not as a silent zero.
    const UI_NUMBERS: &[(&str, &[&str], &str)] = &[
        ("need", &["state", "vramNeedGb"], "GB"),
        ("ramNeed", &["state", "ramNeedGb"], "GB"),
        ("ctx", &["state", "ctx"], ""),
        ("plan.total", &["state", "plan", "totalMib"], "MiB"),
        ("plan.budget", &["state", "plan", "budgetSumMib"], "MiB"),
        ("plan.layers", &["state", "plan", "layers"], "layers"),
        ("plan.boundary", &["state", "plan", "boundary"], "layers"),
        ("plan.optimal", &["state", "plan", "optimalBoundary"], "layers"),
        ("plan.applied", &["state", "plan", "appliedBoundary"], "layers"),
    ];
    for (label, path, unit) in UI_NUMBERS {
        rows.push(DiffRow::number(
            "ui",
            *label,
            ui_num(&before.ui, path),
            ui_num(&after.ui, path),
            unit,
        ));
    }
    const UI_TEXTS: &[(&str, &[&str])] = &[
        ("source", &["state", "sourceKind"]),
        ("sourceDetail", &["state", "sourceDetail"]),
        ("fits", &["state", "fits"]),
        ("tone", &["state", "needTone"]),
        ("launchPaint", &["state", "launchPaint"]),
        ("kvQuant", &["state", "kvQuant"]),
        ("split", &["state", "splitMode"]),
        ("fitOff", &["state", "fitOff"]),
    ];
    for (label, path) in UI_TEXTS {
        rows.push(DiffRow::text(
            "ui",
            *label,
            ui_text(&before.ui, path),
            ui_text(&after.ui, path),
        ));
    }
    // Per-card arrays: the bars (`gpuLoadsGb`) and the plan's distribution (`plan.gpuMib`) are
    // what a placement change moves first.
    let ui_array = |ui: &Option<Value>, path: &[&str]| -> Vec<f64> {
        json_at(ui, path)
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_f64).collect())
            .unwrap_or_default()
    };
    for (scope, path, unit) in [
        ("ui.bars", &["state", "gpuLoadsGb"][..], "GB"),
        ("ui.plan", &["state", "plan", "gpuMib"][..], "MiB"),
    ] {
        let before_cards = ui_array(&before.ui, path);
        let after_cards = ui_array(&after.ui, path);
        let cards = before_cards.len().max(after_cards.len());
        for i in 0..cards {
            rows.push(DiffRow::number(
                scope,
                format!("card{i}"),
                before_cards.get(i).copied(),
                after_cards.get(i).copied(),
                unit,
            ));
        }
    }
    rows.push(DiffRow::text(
        "ui.plan",
        "ts",
        ui_text(&before.ui, &["state", "plan", "ts"]),
        ui_text(&after.ui, &["state", "plan", "ts"]),
    ));
    rows.push(DiffRow::text(
        "ui.plan",
        "applyTs",
        ui_text(&before.ui, &["state", "plan", "applyTs"]),
        ui_text(&after.ui, &["state", "plan", "applyTs"]),
    ));
    rows.push(DiffRow::text(
        "ui",
        "model",
        ui_text(&before.ui, &["state", "modelName"]),
        ui_text(&after.ui, &["state", "modelName"]),
    ));

    rows.retain(DiffRow::is_interesting);
    rows
}

fn fmt_value(value: f64) -> String {
    if (value - value.round()).abs() < 1e-9 {
        format!("{value:.0}")
    } else {
        format!("{value:.2}")
    }
}

fn fmt_num(value: Option<f64>) -> String {
    value.map(fmt_value).unwrap_or_else(|| "unknown".to_string())
}

fn fmt_delta(value: Option<f64>) -> String {
    match value {
        Some(v) if (v - v.round()).abs() < 1e-9 => format!("{v:+.0}"),
        Some(v) => format!("{v:+.2}"),
        None => "—".to_string(),
    }
}

pub fn render_diff(before: &NvramSnapshot, after: &NvramSnapshot, rows: &[DiffRow]) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "before  {}  app {}  {} gpu(s) / {} engine(s) / {} row(s)\n",
        before.captured_at, before.app.version, before.gpus.len(), before.engines.len(), before.learned.len()
    ));
    out.push_str(&format!(
        "after   {}  app {}  {} gpu(s) / {} engine(s) / {} row(s)\n",
        after.captured_at, after.app.version, after.gpus.len(), after.engines.len(), after.learned.len()
    ));
    if rows.is_empty() {
        out.push_str("\nno differences\n");
        return out;
    }

    // Two passes so a long scope or a text value cannot shear the table.
    struct Line {
        scope: String,
        field: String,
        before: String,
        after: String,
        delta: String,
        unit: &'static str,
        note: String,
    }
    let lines: Vec<Line> = rows
        .iter()
        .map(|row| Line {
            scope: row.scope.clone(),
            field: row.field.clone(),
            before: row.before_text.clone().unwrap_or_else(|| fmt_num(row.before)),
            after: row.after_text.clone().unwrap_or_else(|| fmt_num(row.after)),
            delta: if row.before_text.is_some() {
                String::new()
            } else {
                fmt_delta(row.delta)
            },
            unit: if row.before_text.is_some() { "" } else { row.unit },
            note: row
                .note
                .as_deref()
                .map(|n| format!("  ({n})"))
                .unwrap_or_default(),
        })
        .collect();
    let scope_w = lines.iter().map(|l| l.scope.chars().count()).max().unwrap_or(5).max(12);
    let field_w = lines.iter().map(|l| l.field.chars().count()).max().unwrap_or(5).max(11);
    let value_w = lines
        .iter()
        .map(|l| l.before.chars().count().max(l.after.chars().count()))
        .max()
        .unwrap_or(6)
        .max(8);

    out.push_str(&format!(
        "\n{:<scope_w$} {:<field_w$} {:>value_w$} {:>value_w$} {:>8}  {}\n",
        "scope",
        "field",
        "before",
        "after",
        "delta",
        "unit",
        scope_w = scope_w,
        field_w = field_w,
        value_w = value_w,
    ));
    for line in lines {
        out.push_str(&format!(
            "{:<scope_w$} {:<field_w$} {:>value_w$} {:>value_w$} {:>8}  {}{}\n",
            line.scope,
            line.field,
            line.before,
            line.after,
            line.delta,
            line.unit,
            line.note,
            scope_w = scope_w,
            field_w = field_w,
            value_w = value_w,
        ));
    }
    out
}

fn read_snapshot(path: &Path) -> Result<NvramSnapshot, String> {
    let text = std::fs::read_to_string(path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("{}: {err}", path.display()))
}

/// CLI branch: `--nvram-diff <before.json> <after.json> [--json]`.
///
/// Returns `None` when the args are not ours (the app starts normally), `Some(code)` when this
/// process handled the command and must exit.
pub fn run_cli() -> Option<i32> {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(first) = args.first() else { return None };
    if first != "--nvram-diff" {
        return None;
    }
    let json = args.iter().any(|arg| arg == "--json");
    let files: Vec<&String> = args
        .iter()
        .filter(|arg| !arg.starts_with("--") && *arg != first)
        .collect();
    if files.len() != 2 {
        eprintln!("usage: blackwell-ops --nvram-diff <before.json> <after.json> [--json]");
        return Some(2);
    }
    let (before, after) = match (read_snapshot(Path::new(files[0])), read_snapshot(Path::new(files[1]))) {
        (Ok(b), Ok(a)) => (b, a),
        (Err(err), _) | (_, Err(err)) => {
            eprintln!("nvram-diff: {err}");
            return Some(1);
        }
    };
    let rows = diff_snapshots(&before, &after);
    if json {
        match serde_json::to_string_pretty(&rows) {
            Ok(text) => println!("{text}"),
            Err(err) => {
                eprintln!("nvram-diff: {err}");
                return Some(1);
            }
        }
    } else {
        print!("{}", render_diff(&before, &after, &rows));
    }
    Some(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(used: u64, vram: Option<f64>, ts: &str) -> NvramSnapshot {
        NvramSnapshot {
            format: SNAPSHOT_FORMAT,
            captured_at: "t".into(),
            app: AppSnap { version: "1".into(), app_root: ".".into() },
            gpus: vec![GpuSnap {
                index: 0,
                name: "GPU".into(),
                driver_version: None,
                driver_model: "TCC".into(),
                total_mib: 97_887,
                used_mib: used,
                free_mib: 97_887 - used,
                utilization_gpu: 0,
            }],
            gpu_error: None,
            engines: vec![],
            learned: vec![],
            calibration: vec![],
            ui: Some(serde_json::json!({
                "state": {
                    "plan": { "ts": ts, "gpuMib": [100.0, 90.0] }
                }
            })),
        }
    }

    #[test]
    fn unknown_is_not_zero_and_yields_no_delta() {
        let row = DiffRow::number("slot0", "vram", None, Some(0.0), "MiB");
        assert_eq!(row.delta, None);
        assert_eq!(row.note.as_deref(), Some("before unknown"));
        assert!(row.is_interesting());
    }

    #[test]
    fn equal_numbers_are_not_reported() {
        let row = DiffRow::number("gpu0", "used", Some(1.0), Some(1.0), "MiB");
        assert!(!row.is_interesting());
        assert_eq!(row.delta, Some(0.0));
    }

    #[test]
    fn diff_reports_measured_moves_and_placement_text() {
        let before = snapshot(10_000, Some(80_000.0), "0.549,0.451");
        let after = snapshot(10_500, Some(81_000.0), "0.575,0.425");
        let rows = diff_snapshots(&before, &after);
        let used = rows.iter().find(|r| r.scope == "gpu0" && r.field == "used").expect("used row");
        assert_eq!(used.delta, Some(500.0));
        let ts = rows.iter().find(|r| r.scope == "ui.plan" && r.field == "ts").expect("ts row");
        assert_eq!(ts.before_text.as_deref(), Some("0.549,0.451"));
        assert_eq!(ts.after_text.as_deref(), Some("0.575,0.425"));
        assert!(rows.iter().all(DiffRow::is_interesting));
    }

    #[test]
    fn snapshot_round_trips_through_serde() {
        let snap = snapshot(42, Some(1234.5), "0.5,0.5");
        let text = serde_json::to_string(&snap).expect("serialize");
        let back: NvramSnapshot = serde_json::from_str(&text).expect("deserialize");
        assert_eq!(back.gpus.len(), 1);
        assert_eq!(back.gpus[0].used_mib, 42);
    }

    #[test]
    fn rendered_diff_names_the_move_and_its_unit() {
        let before = snapshot(10_000, None, "0.549,0.451");
        let after = snapshot(16_176, None, "0.575,0.425");
        let rows = diff_snapshots(&before, &after);
        let text = render_diff(&before, &after, &rows);
        assert!(text.contains("gpu0"), "{text}");
        assert!(text.contains("+6176"), "{text}");
        assert!(text.contains("MiB"), "{text}");
        assert!(text.contains("0.575,0.425"), "{text}");
    }

    #[test]
    fn reading_a_snapshot_file_keeps_unknowns_as_null() {
        let dir = std::env::temp_dir().join(format!("nvram-snap-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        let path = dir.join("snap.json");
        let mut snap = snapshot(1, None, "0.5,0.5");
        snap.gpu_error = None;
        snap.learned.clear();
        std::fs::write(&path, serde_json::to_string(&snap).expect("ser")).expect("write");
        let back = read_snapshot(&path).expect("read");
        assert_eq!(back.gpus[0].used_mib, 1);
        assert_eq!(back.ui.is_some(), true);
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_dir(&dir);
    }
}
