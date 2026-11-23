//! Companion resolution — which projector / Engram table belongs to a model.
//!
//! The LOADOUT rail needs one answer per role: what is attached, what else could be,
//! and how sure we are. The only trustworthy signals are in the headers:
//!
//! * **Projector** — `clip.vision.projection_dim` must equal the model's
//!   `<arch>.embedding_length` (the projector projects *into* the model), and its
//!   `general.name` / `clip.projector_type` should agree with the model's name or arch.
//! * **Engram** — the lookup tensor's first dimension must equal the model's
//!   `<arch>.embedding_length_per_layer_input` (160 for Qwen3.8-Flash-Next, 256 for
//!   DeepSeek-V4.1), and its `split.no`/`split.count`/`split.tensors.count` should fill
//!   an index of that model's set, or be the text of a table that is already inside it.
//!
//! Two agreeing signals are "strong"; one is "medium" and the UI must ask. Nothing here
//! auto-downloads, and a pin always wins — launch and FIT read the same pins.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

use crate::gguf_patch::KvValue;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum CompanionRole {
    Mmproj,
    Engram,
}

impl CompanionRole {
    pub fn as_str(self) -> &'static str {
        match self {
            CompanionRole::Mmproj => "mmproj",
            CompanionRole::Engram => "engram",
        }
    }
}

/// One attachable file.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionCandidate {
    pub path: String,
    /// Name shown on the card (header name, else file stem).
    pub label: String,
    pub size_bytes: u64,
    pub size_str: String,
    /// `folder` (next to the model) or `extras` (shared store).
    pub source: String,
    /// Quant / precision label from the file name.
    pub precision: String,
    pub score: i32,
    /// Why this candidate scored — shown verbatim in the picker.
    pub reason: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_no: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_count: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lookup_dims: Option<Vec<u64>>,
}

/// State of one slot on the rail.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionSlot {
    pub role: CompanionRole,
    /// Engram only: the table already lives inside the model's own shard set.
    pub integrated: bool,
    /// Preselected candidate — always the top-ranked one; `confidence` says whether
    /// the UI may treat it as attached without asking.
    pub auto: Option<CompanionCandidate>,
    /// `strong` | `medium` | `none`.
    pub confidence: String,
    pub reason: String,
    /// Explicit pin (user chose this file).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pinned: Option<String>,
    /// Explicit detach: no companion, even if one would auto-resolve.
    #[serde(default)]
    pub pinned_off: bool,
    pub candidates: Vec<CompanionCandidate>,
}

impl CompanionSlot {
    fn empty(role: CompanionRole) -> Self {
        Self {
            role,
            integrated: false,
            auto: None,
            confidence: "none".to_string(),
            reason: "nothing found".to_string(),
            pinned: None,
            pinned_off: false,
            candidates: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompanionReport {
    pub model_path: String,
    pub mmproj: CompanionSlot,
    pub engram: CompanionSlot,
}

// ── Facts read from headers ─────────────────────────────────────────────

#[derive(Debug, Default, Clone)]
struct ProjectorFacts {
    pub projection_dim: Option<i64>,
    pub projector_type: Option<String>,
    pub name: String,
    pub general_type: Option<String>,
    pub architecture: String,
}

#[derive(Debug, Default, Clone)]
struct LookupFacts {
    pub dims: Vec<u64>,
    pub split_no: Option<u32>,
    pub split_count: Option<u32>,
    pub tensors_declared: Option<u64>,
    pub name: String,
    pub only_lookup_tensor: bool,
    /// ggml type of the lookup tensor — the table's real precision (Q5_K, IQ4_NL…).
    pub table_type: u32,
}

#[derive(Debug, Default, Clone)]
struct ModelFacts {
    arch: String,
    n_embd: u32,
    ple_width: u32,
    general_name: String,
    split_count: Option<u32>,
    tensors_declared: Option<u64>,
    present_splits: Vec<u32>,
    folder: PathBuf,
    has_integrated_table: bool,
}

fn kv_int(facts: &crate::gguf_patch::HeaderFacts, key: &str) -> Option<i64> {
    match facts.kv_all.get(key) {
        Some(KvValue::Int(n)) => Some(*n),
        _ => None,
    }
}

fn kv_str(facts: &crate::gguf_patch::HeaderFacts, key: &str) -> Option<String> {
    match facts.kv_all.get(key) {
        Some(KvValue::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

fn read_projector_facts(path: &Path) -> Option<ProjectorFacts> {
    let facts = crate::gguf_patch::parse_header_from_file(path).ok()?;
    Some(ProjectorFacts {
        projection_dim: kv_int(&facts, "clip.vision.projection_dim"),
        projector_type: kv_str(&facts, "clip.projector_type"),
        name: kv_str(&facts, "general.name").unwrap_or_default(),
        general_type: kv_str(&facts, "general.type"),
        architecture: facts.architecture.unwrap_or_default(),
    })
}

fn read_lookup_facts(path: &Path) -> Option<LookupFacts> {
    let facts = crate::gguf_patch::parse_header_from_file(path).ok()?;
    let table: Vec<&crate::gguf_patch::TensorInfo> = facts
        .tensors
        .iter()
        .filter(|t| t.name.contains("per_layer_token_embd"))
        .collect();
    if table.is_empty() {
        return None;
    }
    let has_trunk = facts
        .tensors
        .iter()
        .any(|t| t.name.starts_with("blk.") || t.name == "output.weight");
    Some(LookupFacts {
        dims: table.first().map(|t| t.dims.clone()).unwrap_or_default(),
        split_no: kv_int(&facts, "split.no").map(|n| n as u32),
        split_count: kv_int(&facts, "split.count").map(|n| n as u32),
        tensors_declared: kv_int(&facts, "split.tensors.count").map(|n| n as u64),
        name: kv_str(&facts, "general.name").unwrap_or_default(),
        only_lookup_tensor: !has_trunk && facts.tensors.len() <= 2,
        table_type: table.first().map(|t| t.ggml_type).unwrap_or(0),
    })
}

fn read_model_facts(model_path: &str) -> Option<ModelFacts> {
    let path = Path::new(model_path);
    let facts = crate::gguf_patch::parse_header_from_file(path).ok()?;
    let arch = facts.architecture.clone().unwrap_or_default();
    let n_embd = kv_int(&facts, &format!("{arch}.embedding_length")).unwrap_or(0) as u32;
    let ple_width = kv_int(
        &facts,
        &format!("{arch}.embedding_length_per_layer_input"),
    )
    .unwrap_or(0) as u32;
    let general_name = kv_str(&facts, "general.name").unwrap_or_default();

    // Shard set: which indices are present, and does one of them already carry a table?
    let mut present_splits = Vec::new();
    let mut split_count = None;
    let mut tensors_declared = None;
    let mut has_integrated_table = false;
    for sibling in crate::model_catalog::shard_sibling_paths(model_path) {
        let Ok(sf) = crate::gguf_patch::parse_header_from_file(&sibling) else {
            continue;
        };
        if let Some(no) = kv_int(&sf, "split.no") {
            present_splits.push(no as u32);
        }
        split_count = split_count.or_else(|| kv_int(&sf, "split.count").map(|n| n as u32));
        tensors_declared =
            tensors_declared.or_else(|| kv_int(&sf, "split.tensors.count").map(|n| n as u64));
        if sf
            .tensors
            .iter()
            .any(|t| t.name.contains("per_layer_token_embd"))
        {
            has_integrated_table = true;
        }
    }

    Some(ModelFacts {
        arch,
        n_embd,
        ple_width,
        general_name,
        split_count,
        tensors_declared,
        present_splits,
        folder: path.parent().unwrap_or(Path::new("")).to_path_buf(),
        has_integrated_table,
    })
}

// ── Scoring (pure — covered by tests) ───────────────────────────────────

/// Keep letters and digits, lowercase. `Qwen3.5-9B` and `qwen35 9b` compare equal.
fn normalize_name(s: &str) -> String {
    s.chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

fn family_token(arch: &str) -> String {
    arch.chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Projector score: `projection_dim` equal to the model's n_embd is the hard check;
/// the name and projector type are corroboration, never a substitute.
fn score_projector(
    n_embd: u32,
    model_names: &[String],
    arch: &str,
    same_folder: bool,
    proj: &ProjectorFacts,
) -> (i32, String) {
    let mut score = 0;
    let mut reasons: Vec<String> = Vec::new();

    if n_embd > 0 && proj.projection_dim == Some(n_embd as i64) {
        score += 50;
        reasons.push(format!("dim {n_embd}"));
    }
    let proj_names: Vec<String> = [normalize_name(&proj.name)]
        .into_iter()
        .filter(|n| !n.is_empty())
        .collect();
    let name_match = model_names.iter().any(|m| {
        let m = normalize_name(m);
        !m.is_empty() && proj_names.iter().any(|p| p == &m || p.contains(&m) || m.contains(p))
    });
    if name_match {
        score += 40;
        reasons.push("name".to_string());
    }
    if let Some(pt) = proj.projector_type.as_deref() {
        let pt_n = normalize_name(pt);
        let arch_n = normalize_name(arch);
        if !arch_n.is_empty() && pt_n.contains(&arch_n) {
            score += 20;
            reasons.push("projector type".to_string());
        } else if !arch_n.is_empty() && family_token(pt) == family_token(arch) {
            score += 5;
            reasons.push("family".to_string());
        }
    }
    if same_folder {
        score += 10;
        reasons.push("alongside model".to_string());
    }

    (score, reasons.join(" · "))
}

/// Engram score. The lookup width is the hard check; the split bookkeeping proves
/// *which* set the table was cut from.
fn score_lookup(
    ple_width: u32,
    model: &ModelFacts,
    eng: &LookupFacts,
    same_folder: bool,
) -> (i32, String) {
    let mut score = 0;
    let mut reasons: Vec<String> = Vec::new();

    if ple_width > 0 && eng.dims.first().copied() == Some(ple_width as u64) {
        score += 50;
        reasons.push(format!("lookup width {ple_width}"));
    }
    let fills_index = match (model.split_count, eng.split_count, eng.split_no) {
        (Some(set_count), Some(eng_count), Some(no)) => {
            set_count == eng_count && !model.present_splits.contains(&no)
        }
        _ => false,
    };
    if fills_index {
        score += 40;
        reasons.push("fills the missing shard".to_string());
    }
    if let (Some(a), Some(b)) = (model.tensors_declared, eng.tensors_declared) {
        if a == b {
            score += 20;
            reasons.push("tensor count".to_string());
        }
    }
    if !eng.name.is_empty() && !model.general_name.is_empty() {
        let en = normalize_name(&eng.name);
        let mn = normalize_name(&model.general_name);
        if !en.is_empty() && (en.contains(&mn) || mn.contains(&en)) {
            score += 10;
            reasons.push("name".to_string());
        }
    }
    if same_folder {
        score += 5;
        reasons.push("alongside model".to_string());
    }

    (score, reasons.join(" · "))
}

fn confidence_for(score: i32) -> &'static str {
    if score >= 70 {
        "strong"
    } else if score >= 45 {
        "medium"
    } else {
        "none"
    }
}

// ── Candidate discovery ─────────────────────────────────────────────────

fn is_mmproj_name(name: &str) -> bool {
    name.to_ascii_lowercase().contains("mmproj")
}

/// GGML type discriminant → catalog label. The table's precision is the tensor's, not
/// the model's quant tag: an IQ2_XXS model can ship a Q5_K Engram table.
fn ggml_type_label(id: u32) -> &'static str {
    match id {
        0 => "F32",
        1 => "F16",
        2 => "Q4_0",
        3 => "Q4_1",
        6 => "Q5_0",
        7 => "Q5_1",
        8 => "Q8_0",
        10 => "Q2_K",
        11 => "Q3_K",
        12 => "Q4_K",
        13 => "Q5_K",
        14 => "Q6_K",
        16 => "IQ2_XXS",
        17 => "IQ2_XS",
        18 => "IQ3_XXS",
        19 => "IQ1_S",
        20 => "IQ4_NL",
        21 => "IQ3_S",
        22 => "IQ2_S",
        23 => "IQ4_XS",
        29 => "IQ1_M",
        30 => "BF16",
        39 => "MXFP4",
        _ => "",
    }
}
fn precision_label(file_name: &str, fallback: &str) -> String {
    let q = crate::model_catalog::extract_quant(file_name);
    if q != "GGUF" {
        q
    } else if !fallback.is_empty() {
        fallback.to_string()
    } else {
        "--".to_string()
    }
}

fn candidate(
    path: &Path,
    source: &str,
    label: String,
    precision: String,
    score: i32,
    reason: String,
    split_no: Option<u32>,
    split_count: Option<u32>,
    lookup_dims: Option<Vec<u64>>,
) -> CompanionCandidate {
    let size = std::fs::metadata(path).map(|m| m.len()).unwrap_or(0);
    CompanionCandidate {
        path: path.to_string_lossy().to_string(),
        label: if label.is_empty() {
            path.file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_default()
        } else {
            label
        },
        size_bytes: size,
        size_str: crate::model_catalog::calc_size_str_from_bytes(size),
        source: source.to_string(),
        precision,
        score,
        reason,
        split_no,
        split_count,
        lookup_dims,
    }
}

fn collect_mmproj_candidates(
    model: &ModelFacts,
    extras: &[PathBuf],
    index: &[crate::types::ExtraFileEntry],
) -> Vec<CompanionCandidate> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let model_names = vec![
        model.general_name.clone(),
        model
            .folder
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default(),
    ];

    let mut push = |path: &Path, source: &str| {
        let Some(facts) = read_projector_facts(path) else {
            return;
        };
        let is_projector = facts.general_type.as_deref() == Some("mmproj")
            || facts.architecture.eq_ignore_ascii_case("clip")
            || is_mmproj_name(&path.file_name().unwrap_or_default().to_string_lossy());
        if !is_projector {
            return;
        }
        let key = path.to_string_lossy().to_ascii_lowercase();
        if !seen.insert(key) {
            return;
        }
        let same_folder = path.parent() == Some(model.folder.as_path());
        let (score, reason) =
            score_projector(model.n_embd, &model_names, &model.arch, same_folder, &facts);
        let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let precision = precision_label(&file_name, "");
        out.push(candidate(
            path,
            source,
            facts.name.clone(),
            precision,
            score,
            reason,
            None,
            None,
            None,
        ));
    };

    // Every projector beside the model — not just the largest.
    if let Ok(entries) = std::fs::read_dir(&model.folder) {
        let mut paths: Vec<PathBuf> = entries
            .flatten()
            .map(|e| e.path())
            .filter(|p| {
                p.is_file()
                    && is_mmproj_name(&p.file_name().unwrap_or_default().to_string_lossy())
            })
            .collect();
        paths.sort();
        for p in paths {
            push(&p, "folder");
        }
    }
    for root in extras {
        let mut files = Vec::new();
        crate::shard_sets::walk_gguf_files(root, &mut files);
        for p in files {
            if is_mmproj_name(&p.file_name().unwrap_or_default().to_string_lossy()) {
                push(&p, "extras");
            }
        }
    }
    // Projectors discovered in other model folders by the last catalog pass.
    for e in index.iter().filter(|e| e.role == "mmproj") {
        let path = Path::new(&e.path);
        if path.is_file() {
            push(path, "library");
        }
    }
    out.sort_by(|a, b| b.score.cmp(&a.score));
    out
}

fn collect_engram_candidates(
    model_path: &str,
    model: &ModelFacts,
    extras: &[PathBuf],
    index: &[crate::types::ExtraFileEntry],
) -> Vec<CompanionCandidate> {
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |path: &Path, source: &str| {
        let Some(eng) = read_lookup_facts(path) else {
            return;
        };
        let same_folder = path.parent() == Some(model.folder.as_path());
        let (mut score, reason) = score_lookup(model.ple_width, model, &eng, same_folder);
        // A table inside the model's own set is the definition of "integrated" — it is
        // not a candidate to attach, it is already attached.
        let integrated_here =
            same_folder && eng.only_lookup_tensor && eng.split_no.is_some_and(|n| model.present_splits.contains(&n));
        if integrated_here {
            score = 100;
        }
        let key = path.to_string_lossy().to_ascii_lowercase();
        if !seen.insert(key) {
            return;
        }
        let file_name = path.file_name().unwrap_or_default().to_string_lossy().to_string();
        let tensor_precision = ggml_type_label(eng.table_type);
        let precision = if tensor_precision.is_empty() {
            precision_label(&file_name, &eng.name)
        } else {
            tensor_precision.to_string()
        };
        out.push(candidate(
            path,
            source,
            eng.name.clone(),
            precision,
            score,
            if integrated_here {
                "integrated in the model's set".to_string()
            } else {
                reason
            },
            eng.split_no,
            eng.split_count,
            Some(eng.dims.clone()).filter(|d| !d.is_empty()),
        ));
    };

    // Candidates in the model's own folder (a sibling table / the integrated one).
    for sibling in crate::model_catalog::shard_sibling_paths(model_path) {
        push(&sibling, "folder");
    }
    for root in extras {
        let mut files = Vec::new();
        crate::shard_sets::walk_gguf_files(root, &mut files);
        for p in files {
            push(&p, "extras");
        }
    }
    // Tables discovered elsewhere by the last catalog pass — including a table that is a
    // shard of another model's set, which is the normal shared-precision case.
    for e in index.iter().filter(|e| e.role == "ple") {
        let path = Path::new(&e.path);
        if !path.is_file() {
            continue;
        }
        let key = e.path.to_ascii_lowercase();
        if !seen.insert(key) {
            continue;
        }
        let Some(eng) = read_lookup_facts(path) else {
            continue;
        };
        let same_folder = path.parent() == Some(model.folder.as_path());
        let (score, reason) = score_lookup(model.ple_width, model, &eng, same_folder);
        let tensor_precision = ggml_type_label(eng.table_type);
        let precision = if tensor_precision.is_empty() {
            precision_label(&e.file_name, &eng.name)
        } else {
            tensor_precision.to_string()
        };
        out.push(candidate(
            path,
            "library",
            e.file_name.clone(),
            precision,
            score,
            reason,
            eng.split_no,
            eng.split_count,
            Some(eng.dims.clone()).filter(|d| !d.is_empty()),
        ));
    }
    out.sort_by(|a, b| b.score.cmp(&a.score));
    out
}

// ── Pins ────────────────────────────────────────────────────────────────

#[derive(Debug, Default, Serialize, Deserialize)]
struct PinFile {
    /// model path → role → path ("" means explicitly detached).
    #[serde(default)]
    pins: HashMap<String, HashMap<String, String>>,
}

fn pins_path() -> PathBuf {
    crate::config::config_dir()
        .join("cache")
        .join("companion_pins.json")
}

fn load_pins() -> PinFile {
    std::fs::read_to_string(pins_path())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_pins(pins: &PinFile) {
    let path = pins_path();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    if let Err(e) = crate::fs_util::write_json_atomic(&path, pins) {
        log::debug!("[companions] pin file not written: {e}");
    }
}

/// Pinned path for one role: `Some("")` = explicitly detached.
pub fn pinned_raw(model_path: &str, role: CompanionRole) -> Option<String> {
    let pins = load_pins();
    pins.pins
        .get(&crate::shard_sets::normalize_key(model_path))?
        .get(role.as_str())
        .cloned()
}

/// Pin one file (`path`) or detach (`path = ""`).
pub fn set_pin(model_path: &str, role: CompanionRole, path: &str) -> Result<(), String> {
    let mut pins = load_pins();
    pins.pins
        .entry(crate::shard_sets::normalize_key(model_path))
        .or_default()
        .insert(role.as_str().to_string(), path.to_string());
    save_pins(&pins);
    Ok(())
}

/// Drop the pin so auto-resolution applies again.
pub fn clear_pin(model_path: &str, role: CompanionRole) -> Result<(), String> {
    let mut pins = load_pins();
    if let Some(roles) = pins.pins.get_mut(&crate::shard_sets::normalize_key(model_path)) {
        roles.remove(role.as_str());
        if roles.is_empty() {
            pins.pins.remove(&crate::shard_sets::normalize_key(model_path));
        }
    }
    save_pins(&pins);
    Ok(())
}

// ── Resolution ──────────────────────────────────────────────────────────

fn finish_slot(
    role: CompanionRole,
    mut candidates: Vec<CompanionCandidate>,
    pinned: Option<String>,
    integrated: bool,
) -> CompanionSlot {
    let pinned_off = pinned.as_deref() == Some("");
    let pinned_path = pinned.filter(|p| !p.is_empty());
    // Only plausible companions belong in the picker. A projector that merely shares
    // the embedding width (a common n_embd) is not "for this model": it needs a name,
    // arch/type or same-folder agreement to clear 60. A live pin is always shown.
    candidates.retain(|c| {
        c.score >= 60 || pinned_path.as_deref() == Some(c.path.as_str())
    });
    let top = candidates.first().cloned();
    let confidence = top
        .as_ref()
        .map(|c| confidence_for(c.score).to_string())
        .unwrap_or_else(|| "none".to_string());
    let reason = top
        .as_ref()
        .map(|c| c.reason.clone())
        .unwrap_or_else(|| "nothing found".to_string());
    candidates.sort_by(|a, b| b.score.cmp(&a.score));
    CompanionSlot {
        role,
        integrated,
        auto: top,
        confidence,
        reason,
        pinned: pinned_path,
        pinned_off,
        candidates,
    }
}

fn extras_roots() -> Vec<PathBuf> {
    let cfg = crate::config::load_config();
    crate::config::get_extras_paths(&cfg)
        .into_iter()
        .map(|p| PathBuf::from(p.path))
        .filter(|p| p.is_dir())
        .collect()
}

/// Full report for the LOADOUT rail.
pub fn resolve(model_path: &str) -> CompanionReport {    let Some(model) = read_model_facts(model_path) else {
        return CompanionReport {
            model_path: model_path.to_string(),
            mmproj: CompanionSlot::empty(CompanionRole::Mmproj),
            engram: CompanionSlot::empty(CompanionRole::Engram),
        };
    };
    let extras = extras_roots();

    let index = crate::shard_sets::load_extras();
    let mmproj_candidates = collect_mmproj_candidates(&model, &extras, &index);
    let engram_candidates = collect_engram_candidates(model_path, &model, &extras, &index);

    let mmproj_pin = pinned_raw(model_path, CompanionRole::Mmproj);
    let engram_pin = pinned_raw(model_path, CompanionRole::Engram);

    let mmproj = finish_slot(
        CompanionRole::Mmproj,
        mmproj_candidates,
        mmproj_pin,
        false,
    );
    let engram = finish_slot(
        CompanionRole::Engram,
        engram_candidates,
        engram_pin,
        model.has_integrated_table,
    );
    CompanionReport {
        model_path: model_path.to_string(),
        mmproj,
        engram,
    }
}

// ── Launch / FIT consumption ────────────────────────────────────────────

fn existing(p: &str) -> bool {
    Path::new(p).is_file()
}

/// `--mmproj` value: a live pin wins; otherwise nothing (the legacy same-folder
/// injection still runs, so behaviour without a pin is unchanged).
pub fn launch_mmproj(model_path: &str) -> Option<String> {
    match pinned_raw(model_path, CompanionRole::Mmproj) {
        Some(p) if p.is_empty() => None,
        Some(p) if existing(&p) => Some(p),
        _ => None,
    }
}

/// `--ple` value: a live pin wins; an explicit detach disables pairing; otherwise the
/// shard-set tail discovered during the catalog pass.
pub fn launch_engram(model_path: &str) -> Option<String> {
    match pinned_raw(model_path, CompanionRole::Engram) {
        Some(p) if p.is_empty() => None,
        Some(p) if existing(&p) => Some(p),
        _ => {
            let externals = crate::shard_sets::launch_externals(model_path);
            if externals.is_empty() {
                None
            } else {
                Some(externals.join(","))
            }
        }
    }
}

// ── IPC ────────────────────────────────────────────────────────────────

pub(crate) fn parse_role(role: &str) -> Result<CompanionRole, String> {
    match role {
        "mmproj" => Ok(CompanionRole::Mmproj),
        "engram" => Ok(CompanionRole::Engram),
        other => Err(format!("unknown companion role '{other}'")),
    }
}

/// LOADOUT rail payload: what is attached, what else could be, and how sure we are.
#[tauri::command]
pub fn resolve_companions(model_path: String) -> CompanionReport {
    resolve(&model_path)
}

/// Pin a file to a role. `path = None` means explicitly detach (no companion at all).
#[tauri::command]
pub fn set_companion_pin(
    model_path: String,
    role: String,
    path: Option<String>,
) -> Result<(), String> {
    let role = parse_role(&role)?;
    set_pin(&model_path, role, path.as_deref().unwrap_or(""))
}

/// Drop the pin — auto-resolution applies again.
#[tauri::command]
pub fn clear_companion_pin(model_path: String, role: String) -> Result<(), String> {
    clear_pin(&model_path, parse_role(&role)?)
}


// ── Repo-side companions (LOADOUT "from this repo") ─────────────────────

/// One downloadable companion published in the model's HF repo.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RepoCompanion {
    pub repo_id: String,
    pub path_in_repo: String,
    pub file_name: String,
    pub size_bytes: u64,
    pub size_str: String,
    pub precision: String,
    pub url: String,
    pub lfs_oid: String,
}

/// `<author>/<repo>` from the first two components below any configured model root.
/// Separator/case-insensitive: roots are stored as typed, model paths come from the walk.
fn repo_id_from_roots(model_path: &str, roots: &[String]) -> Option<String> {
    fn norm(path: &str) -> String {
        path.replace('/', "\\").to_ascii_lowercase()
    }
    let target = norm(model_path);
    for root in roots {
        let root_norm = norm(root);
        let root_norm = root_norm.trim_end_matches('\\');
        let prefix = format!("{root_norm}\\");
        if target.starts_with(&prefix) {
            let rel = &model_path[prefix.len()..];
            let parts: Vec<&str> = rel.split(['\\', '/']).filter(|s| !s.is_empty()).collect();
            if parts.len() >= 3 {
                return Some(format!("{}/{}", parts[0], parts[1]));
            }
        }
    }
    None
}

/// HF ids are `<author>/<repo>`. The catalog can carry a directory-derived id with the
/// quant folder appended (`author/repo/QUANT`) for folders imported rather than
/// downloaded, so always keep the first two segments.
pub(crate) fn normalize_repo_id(id: &str) -> Option<String> {
    let parts: Vec<&str> = id.split('/').filter(|s| !s.is_empty()).collect();
    if parts.len() >= 2 {
        Some(format!("{}/{}", parts[0], parts[1]))
    } else {
        None
    }
}

fn repo_id_for(model_path: &str) -> Option<String> {
    if let Some(meta) = crate::model_cache::get_hf_metadata(model_path) {
        if let Some(id) = normalize_repo_id(&meta.hf_model_id) {
            return Some(id);
        }
    }
    // Configured model roots are the reliable anchor: the first two components below a
    // root are <author>/<repo>, whether or not a quant folder follows.
    let cfg = crate::config::load_config();
    let roots: Vec<String> = crate::config::get_model_paths(&cfg)
        .into_iter()
        .map(|root| root.path)
        .collect();
    if let Some(id) = repo_id_from_roots(model_path, &roots) {
        return Some(id);
    }
    // Fallback for a path outside every root: …/<author>/<repo>/file.gguf.
    let folder = std::path::Path::new(model_path).parent()?;
    let author = folder.parent()?.file_name()?.to_string_lossy().to_string();
    let repo = folder.file_name()?.to_string_lossy().to_string();
    if author.is_empty() || repo.is_empty() {
        None
    } else {
        Some(format!("{author}/{repo}"))
    }
}

fn repo_file_matches(role: CompanionRole, file: &crate::types::GgufFile) -> bool {
    let path = crate::types::hf_resolve_path_from_url(&file.url)
        .unwrap_or_default()
        .to_ascii_lowercase();
    let name = path.rsplit('/').next().unwrap_or("").to_string();
    let has = |s: &str| name.contains(s) || path.contains(s);
    match role {
        CompanionRole::Mmproj => has("mmproj"),
        CompanionRole::Engram => {
            has("engram") || has("ple") || file.role == crate::types::GgufRole::Swap
        }
    }
}

/// Companions for one role that the model's Hub repo publishes — offered in the
/// LOADOUT picker, downloaded only on an explicit click.
/// Files one role's companion may be taken from, for one explicitly named Hub repo.
async fn list_repo_companions(
    repo_id: &str,
    role: CompanionRole,
) -> Result<Vec<RepoCompanion>, String> {
    // Same token path as every other Hub read: without it this listing ran anonymously
    // while the rest of the app authenticated, which is how the picker burned the quota.
    let hf_token = crate::secrets::get_secret("hf_token")?;
    let files = crate::hf_api::list_repo_gguf_files(&repo_id, hf_token.as_deref()).await?;
    let mut out = Vec::new();
    for file in files {
        // Multi-shard weights are not companions; only single files make sense here.
        if file.shard_count > 1 || !repo_file_matches(role, &file) {
            continue;
        }
        let Some(path_in_repo) = crate::types::hf_resolve_path_from_url(&file.url) else {
            continue;
        };
        let Some(file_name) = path_in_repo.rsplit('/').next().map(|n| n.to_string()) else {
            continue;
        };
        let precision = crate::model_catalog::extract_quant(&file_name);
        out.push(RepoCompanion {
            repo_id: repo_id.to_string(),
            path_in_repo,
            file_name,
            size_bytes: file.size_bytes,
            size_str: crate::model_catalog::calc_size_str_from_bytes(file.size_bytes),
            precision: if precision == "GGUF" { String::new() } else { precision },
            url: file.url.clone(),
            lfs_oid: file.lfs_oid.clone(),
        });
    }
    Ok(out)
}

/// Companions for one role from the model's own Hub repo.
#[tauri::command]
pub async fn repo_companions(
    model_path: String,
    role: String,
) -> Result<Vec<RepoCompanion>, String> {
    let role = parse_role(&role)?;
    let repo_id = repo_id_for(&model_path)
        .and_then(|id| normalize_repo_id(&id))
        .ok_or_else(|| format!("no Hub repo for '{model_path}'"))?;
    list_repo_companions(&repo_id, role).await
}

/// Draft heads a repo publishes — the SAME listing the Model Hub download screen shows,
/// so the picker cannot disagree with it. The old draft search walked HF for candidate
/// repos and guessed by size; this asks the repo the user actually named.
#[tauri::command]
pub async fn repo_draft_files(model_id: String) -> Result<Vec<RepoCompanion>, String> {
    // Catalog ids can carry the quant folder (`author/repo/QUANT`): keep the two
    // segments HF wants BEFORE validating, or the command rejects its own input.
    let repo_id =
        normalize_repo_id(&model_id).ok_or_else(|| format!("'{model_id}' is not an org/repo id"))?;
    crate::config::validate_hf_model_id(&repo_id)?;
    let hf_token = crate::secrets::get_secret("hf_token")?;
    let files = crate::hf_api::list_repo_gguf_files(&repo_id, hf_token.as_deref()).await?;
    let mut out = Vec::new();
    for file in files {
        // Multi-shard weights are not heads; the role verdict comes from the same
        // classifier the Hub screen renders.
        if file.shard_count > 1 || file.role != crate::types::GgufRole::Draft {
            continue;
        }
        let Some(path_in_repo) = crate::types::hf_resolve_path_from_url(&file.url) else {
            continue;
        };
        let file_name = path_in_repo.rsplit('/').next().unwrap_or("").to_string();
        let precision = crate::model_catalog::extract_quant(&file_name);
        out.push(RepoCompanion {
            repo_id: repo_id.to_string(),
            path_in_repo,
            file_name,
            size_bytes: file.size_bytes,
            size_str: crate::model_catalog::calc_size_str_from_bytes(file.size_bytes),
            precision: if precision == "GGUF" { String::new() } else { precision },
            url: file.url.clone(),
            lfs_oid: file.lfs_oid.clone(),
        });
    }
    out.sort_by(|a, b| a.size_bytes.cmp(&b.size_bytes));
    Ok(out)
}

/// Companions from any repo the user pastes into the picker's HF-ID field. Nothing is
/// downloaded until a row is clicked; the file then lands in the SWAP store like any
/// other companion.
#[tauri::command]
pub async fn repo_companions_for(
    model_id: String,
    role: String,
) -> Result<Vec<RepoCompanion>, String> {
    let repo_id =
        normalize_repo_id(&model_id).ok_or_else(|| format!("'{model_id}' is not an org/repo id"))?;
    crate::config::validate_hf_model_id(&repo_id)?;
    let role = parse_role(&role)?;
    list_repo_companions(&repo_id, role).await
}

#[cfg(test)]
mod tests {    use super::*;

    fn model_facts(ple: u32, count: u32, tensors: u64) -> ModelFacts {
        ModelFacts {
            arch: "qwen4exp".to_string(),
            n_embd: 2560,
            ple_width: ple,
            general_name: "Qwen3.8 Flash Next".to_string(),
            split_count: Some(count),
            tensors_declared: Some(tensors),
            present_splits: vec![0, 1, 2, 3],
            folder: PathBuf::new(),
            has_integrated_table: false,
        }
    }


    #[test]
    fn repo_ids_normalize_to_two_segments() {
        // Directory-derived ids carry the quant folder; the Hub wants author/repo only.
        assert_eq!(
            normalize_repo_id("unsloth/Qwen3.8-Flash-Next-GGUF/UD-Q4_K_XL").as_deref(),
            Some("unsloth/Qwen3.8-Flash-Next-GGUF")
        );
        assert_eq!(
            normalize_repo_id("unsloth/Qwen3.5-9B-GGUF").as_deref(),
            Some("unsloth/Qwen3.5-9B-GGUF")
        );
        assert_eq!(normalize_repo_id("nolash"), None);
    }

    #[test]
    fn names_normalise_across_punctuation() {
        assert_eq!(normalize_name("Qwen3.5-9B"), normalize_name("qwen3.5 9b"));
        assert_ne!(normalize_name("Qwen3.5-9B"), normalize_name("Qwen3.5-4B"));
    }

    #[test]
    fn projector_dim_and_name_agree_is_strong() {
        let proj = ProjectorFacts {
            projection_dim: Some(2560),
            projector_type: Some("qwen3vl_merger".to_string()),
            name: "Qwen3.8 Flash Next".to_string(),
            general_type: Some("mmproj".to_string()),
            architecture: "clip".to_string(),
        };
        let (score, reason) = score_projector(
            2560,
            &["Qwen3.8 Flash Next".to_string()],
            "qwen4exp",
            true,
            &proj,
        );
        assert!(score >= 70, "expected strong, got {score}: {reason}");
        assert_eq!(confidence_for(score), "strong");
    }

    /// A projector that only happens to share the embedding width must not be strong:
    /// 2560 is a common n_embd.
    #[test]
    fn projector_dim_only_is_medium() {
        let proj = ProjectorFacts {
            projection_dim: Some(2560),
            projector_type: Some("qwen3vl_merger".to_string()),
            name: "Qwen3.5-4B".to_string(),
            general_type: Some("mmproj".to_string()),
            architecture: "clip".to_string(),
        };
        let (score, _) = score_projector(2560, &["Qwen3.8 Flash Next".to_string()], "qwen4exp", false, &proj);
        assert_eq!(confidence_for(score), "medium", "score {score}");
    }

    #[test]
    fn projector_wrong_dim_never_auto_attaches() {
        let proj = ProjectorFacts {
            projection_dim: Some(4096),
            projector_type: None,
            name: String::new(),
            general_type: None,
            architecture: "clip".to_string(),
        };
        let (score, _) = score_projector(2560, &[], "qwen4exp", false, &proj);
        assert!(score < 45, "score {score}");
    }

    #[test]
    fn engram_width_and_missing_tail_is_strong() {
        let model = model_facts(160, 4, 1224);
        let eng = LookupFacts {
            dims: vec![160, 320_001_536],
            split_no: Some(4),
            split_count: Some(4),
            tensors_declared: Some(1224),
            name: "Qwen3.8 Flash Next Engram".to_string(),
            only_lookup_tensor: true,
            ..Default::default()
        };
        let (score, reason) = score_lookup(160, &model, &eng, false);
        assert!(score >= 70, "expected strong, got {score}: {reason}");
    }

    /// Another model's table at the same width is not a match for *this* set.
    #[test]
    fn engram_width_only_is_medium() {
        let model = model_facts(160, 4, 1224);
        let eng = LookupFacts {
            dims: vec![160, 111_111],
            split_no: Some(0),
            split_count: Some(2),
            tensors_declared: Some(999),
            name: "Something Else".to_string(),
            only_lookup_tensor: true,
            ..Default::default()
        };
        let (score, _) = score_lookup(160, &model, &eng, false);
        assert_eq!(confidence_for(score), "medium", "score {score}");
    }

    #[test]
    fn engram_wrong_width_scores_nothing_strong() {
        let model = model_facts(160, 4, 1224);
        let eng = LookupFacts {
            dims: vec![256, 768_022_850],
            split_no: None,
            split_count: None,
            tensors_declared: None,
            name: String::new(),
            only_lookup_tensor: true,
            ..Default::default()
        };
        let (score, _) = score_lookup(160, &model, &eng, false);
        assert!(score < 45, "score {score}");
    }
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HeadHuntReport {
    /// Repos whose tree actually contained a head of the needed kind.
    pub repo_id: String,
    pub rows: Vec<RepoCompanion>,
    /// Repos whose NAME matched but whose tree did not contain a usable head (bounded).
    pub rejected: Vec<String>,
    pub searched: usize,
}

fn head_kind_token(lane: &str) -> Option<&'static str> {
    match lane {
        "mtp" => Some("mtp"),
        "dflash" => Some("dflash"),
        "dspark" => Some("dspark"),
        _ => None,
    }
}

/// The model's identifying tokens, e.g. "Qwen3.8-Flash-Next" -> qwen3, flash, next.
/// Family words alone are not enough, so the quant / shard noise is stripped first.
fn stem_tokens(name: &str) -> Vec<String> {
    let base = name
        .to_lowercase()
        .replace(".gguf", "")
        .replace("_gguf", "")
        .replace("-gguf", "");
    let mut tokens: Vec<String> = base
        .split(|c: char| !c.is_ascii_alphanumeric() && c != '.')
        .filter(|s| !s.is_empty())
        .filter(|s| {
            s.len() >= 3
                && !matches!(
                    *s,
                    "the" | "and" | "ud" | "gguf" | "q4" | "q5" | "q6" | "q8" | "iq" | "bf16"
                )
        })
        .map(|s| s.trim_matches('.').to_string())
        .filter(|s| !s.is_empty())
        .collect();
    tokens.dedup();
    tokens
}

/// Find a repo that actually carries a head of this kind for this model.
///
/// Bounded on purpose: one search, a deterministic name filter (the repo must contain every
/// stem token AND the kind token), then at most THREE tree lookups - stopping at the first
/// tree that really contains a matching head. No scoring, no ordering by popularity.
#[tauri::command]
pub async fn find_head_for_model(
    model_path: String,
    lane: String,
) -> Result<HeadHuntReport, String> {
    let kind = head_kind_token(&lane).ok_or_else(|| format!("Unsupported lane '{lane}'"))?;
    let name = std::path::Path::new(&model_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    let tokens = stem_tokens(&name);
    if tokens.is_empty() {
        return Err("The model name gives nothing to search for".to_string());
    }
    // The head kind is not part of the model's own name.
    let stem_tokens: Vec<&String> = tokens.iter().filter(|t| !t.contains(kind)).collect();
    if stem_tokens.is_empty() {
        return Err("The model name gives nothing to search for".to_string());
    }
    let query = format!("{} {} gguf", stem_tokens.iter().map(|s| s.as_str()).collect::<Vec<_>>().join(" "), kind);
    let hf_token = crate::secrets::get_secret("hf_token")?;
    let filters = crate::config::normalize_hf_search_inputs(query, None, None, Some(20))?;
    let response = crate::hf_api::search_models(&filters, hf_token.as_deref()).await?;

    // Deterministic name filter: every stem token and the kind token must be in the id.
    let mut candidates: Vec<String> = Vec::new();
    for model in response.models.iter() {
        let id = model.id.to_lowercase();
        if !id.contains(kind) {
            continue;
        }
        if !stem_tokens.iter().all(|t| id.contains(t.as_str())) {
            continue;
        }
        candidates.push(model.id.clone());
    }

    let mut rejected: Vec<String> = Vec::new();
    let searched = candidates.len();
    for repo_id in candidates.into_iter().take(3) {
        let Some(repo) = normalize_repo_id(&repo_id) else { continue };
        let files = match crate::hf_api::list_repo_gguf_files(&repo, hf_token.as_deref()).await {
            Ok(files) => files,
            Err(e) => {
                log::warn!("[head-hunt] {repo}: {e}");
                continue;
            }
        };
        let mut rows = Vec::new();
        for file in files {
            let Some(path_in_repo) = crate::types::hf_resolve_path_from_url(&file.url) else {
                continue;
            };
            let file_name = path_in_repo.rsplit('/').next().unwrap_or("").to_string();
            let lower = file_name.to_lowercase();
            let matched = match kind {
                "dspark" => lower.contains("dspark"),
                "dflash" => lower.contains("dflash") || lower.contains("dspark"),
                _ => lower.contains("mtp"),
            };
            if !matched || file.shard_count > 1 {
                continue;
            }
            let precision = crate::model_catalog::extract_quant(&file_name);
            rows.push(RepoCompanion {
                repo_id: repo.clone(),
                path_in_repo,
                file_name,
                size_bytes: file.size_bytes,
                size_str: crate::model_catalog::calc_size_str_from_bytes(file.size_bytes),
                precision: if precision == "GGUF" { String::new() } else { precision },
                url: file.url.clone(),
                lfs_oid: file.lfs_oid.clone(),
            });
        }
        if rows.is_empty() {
            rejected.push(repo);
            continue;
        }
        rows.sort_by(|a, b| a.size_bytes.cmp(&b.size_bytes));
        return Ok(HeadHuntReport { repo_id: repo, rows, rejected, searched });
    }
    Ok(HeadHuntReport {
        repo_id: String::new(),
        rows: Vec::new(),
        rejected,
        searched,
    })
}