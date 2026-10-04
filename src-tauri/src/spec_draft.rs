//! Speculative-decoding draft model classification and pairing helpers.
//!
//! One classifier, Rust authoritative — `docs/SPEC-ADAPTERS.md` §2.2 / §3.
//! Header evidence (`gguf_shape::GgufShape`) wins over everything; naming is a
//! fallback tier for files that have not been scanned. The case table lives in
//! `spec_draft/fixtures.json`, included here and also read by the vitest mirror.

use std::path::Path;

use crate::gguf_shape::GgufShape;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DraftRole {
    None,
    ExternalDflash,
    ExternalEagle3,
    ExternalMtp,
}

impl DraftRole {
    pub fn as_str(self) -> &'static str {
        match self {
            DraftRole::None => "none",
            DraftRole::ExternalDflash => "external_dflash",
            DraftRole::ExternalEagle3 => "external_eagle3",
            DraftRole::ExternalMtp => "external_mtp",
        }
    }

    pub fn is_external_draft_only(self) -> bool {
        matches!(self, DraftRole::ExternalDflash | DraftRole::ExternalEagle3 | DraftRole::ExternalMtp)
    }
}

/// Non-role facts the classifier derives. Baked-in MTP is a property of the
/// target, not a draft role — it never makes a file unlaunchable.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct SpecFacts {
    /// The main model carries MTP layers of its own (`--spec-type draft-mtp` is valid on it).
    pub baked_mtp: bool,
}

/// The shared case table, also read by `src/lib/specDraft.fixtures.test.ts`.
/// Included at compile time on purpose: it must not join `tauri.conf.json`
/// `bundle.resources`, which would drag the table into the installer.
#[cfg(test)]
const FIXTURES_JSON: &str = include_str!("spec_draft/fixtures.json");

/// Classify one model file.
///
/// - `shape`: header evidence, `None` when the file is unscanned.
/// - Tier 1 (header) **overrides** tier 2 (naming): a folder named `DFlash` cannot
///   condemn a full main model sitting inside it.
/// - Tier 2 runs only when `shape` is `None` or tier 1 produced no role.
pub fn classify_draft_role(
    shape: Option<&GgufShape>,
    path: &str,
    name: &str,
    hf_model_id: Option<&str>,
    source_path_label: Option<&str>,
) -> (DraftRole, SpecFacts) {
    let mut facts = SpecFacts::default();

    // ── Tier 1: header evidence ───────────────────────────────────────────
    if let Some(shape) = shape {
        let arch = shape.architecture.trim().to_lowercase();

        if shape.has_markov_w1 {
            // DSpark is a CLI type (draft-dspark), not a role — it is a DFlash draft.
            return (DraftRole::ExternalDflash, facts);
        }
        // `dflash-draft` is a real-world arch string upstream's registry rejects.
        if arch == "dflash" || arch == "dflash-draft" {
            return (DraftRole::ExternalDflash, facts);
        }
        if arch == "eagle3" {
            return (DraftRole::ExternalEagle3, facts);
        }
        if shape.nextn_layers > 0 {
            // A draft is usually a truncated copy of the target: it keeps the target
            // arch, so block_count + trunk — not architecture — is what separates it
            // from a main.
            if shape.block_count <= 1 && !shape.has_trunk {
                return (DraftRole::ExternalMtp, facts);
            }
            // Full-copy head exports exist (unsloth `mtp-<target>-Q8_0.gguf`): the
            // whole target tensor stack plus nextn layers. The header cannot separate
            // them from a baked-in main — both carry the full stack — so explicit
            // head naming is the only discriminator. Scoped to this branch: a naming
            // token can never condemn a file WITHOUT nextn (the
            // dflash-folder-cannot-condemn-a-main invariant).
            if full_copy_head_naming(path, name) {
                return (DraftRole::ExternalMtp, facts);
            }
            // Q4: nextn with a full stack is a baked-in MTP target.
            facts.baked_mtp = true;
            return (DraftRole::None, facts);
        }
        // A readable header is CONCLUSIVE: it says this is an ordinary target, so the
        // naming tier must not run. Otherwise a folder named `DFlash` would condemn a
        // full main model sitting inside it — the inversion this classifier exists to fix.
        return (DraftRole::None, facts);
    }

    // ── Tier 2: naming fallback (unscanned file, or header said nothing) ──
    let signals = catalog_signals(path, name, hf_model_id, source_path_label);
    for signal in &signals {
        if signal_contains_dflash(signal) {
            return (DraftRole::ExternalDflash, facts);
        }
        if signal_contains_eagle3(signal) {
            return (DraftRole::ExternalEagle3, facts);
        }
        if signal_contains_mtp_head(signal) {
            return (DraftRole::ExternalMtp, facts);
        }
    }
    for signal in &signals {
        if signal_contains_embedded_mtp(signal) {
            facts.baked_mtp = true;
            return (DraftRole::None, facts);
        }
    }

    (DraftRole::None, facts)
}

fn catalog_signals(
    path: &str,
    name: &str,
    hf_model_id: Option<&str>,
    source_path_label: Option<&str>,
) -> Vec<String> {
    let mut signals: Vec<String> = vec![path.to_string(), name.to_string()];
    signals.extend(path_segment_signals(path).map(str::to_string));
    if let Some(label) = source_path_label {
        if !label.is_empty() {
            signals.push(label.to_string());
        }
    }
    if let Some(hf) = hf_model_id {
        signals.push(hf.to_string());
    }
    signals
}

fn compact_alnum_lower(s: &str) -> String {
    s.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric())
        .collect()
}

fn signal_contains_dflash(signal: &str) -> bool {
    let lower = signal.to_lowercase();
    if lower.contains("dflash") {
        return true;
    }
    if compact_alnum_lower(signal).contains("dflash") {
        return true;
    }
    // D-Flash, D_Flash, D.Flash, "D Flash"
    lower.contains("d-flash")
        || lower.contains("d_flash")
        || lower.contains("d.flash")
        || lower.contains("d flash")
}

fn signal_contains_eagle3(signal: &str) -> bool {
    let lower = signal.to_lowercase();
    lower.contains("eagle3") || compact_alnum_lower(signal).contains("eagle3")
}

/// Detect standalone MTP head signals — explicit "head" tokens only.
///
/// Deliberately NOT matching `-mtp.gguf` or `MTP-GGUF`: those are baked-in MTP *mains*
/// (ISTA-DASLab `IQ3_S-mtp.gguf`, Unsloth `Qwen3.6-27B-MTP-GGUF`). The GGUF header has no
/// role field that distinguishes them from a sibling quant or from an external head.
fn signal_contains_mtp_head(signal: &str) -> bool {
    let lower = signal.to_lowercase();
    let alnum = compact_alnum_lower(signal);
    if lower.contains("mtp-head") || lower.contains("mtp_head") || alnum.contains("mtphead") {
        return true;
    }
    if lower.contains("head-mtp") || lower.contains("head_mtp") || alnum.contains("headmtp") {
        return true;
    }
    // "X.mtp.gguf" (dot) is a head export. "-mtp.gguf" is a baked-in main.
    lower.ends_with(".mtp.gguf")
}

/// Explicit external-head naming: `mtp-head` / `head-mtp` tokens, the `.mtp.gguf`
/// suffix, an `mtp-` **file-name prefix** (unsloth `mtp-Qwen3.8-Flash-Next-Q8_0`),
/// or a bare `mtp` path segment (an `MTP/` sidecar folder).
///
/// Deliberately narrower than `signal_contains_dflash`: a baked-in main lives in a
/// `Qwen3.6-27B-MTP-GGUF` repo folder (embedded token, not a bare segment) and is
/// named `X-MTP.gguf` (suffix, not prefix) — neither matches.
fn is_explicit_mtp_head_signal(signal: &str) -> bool {
    if signal_contains_mtp_head(signal) {
        return true;
    }
    for part in signal.split(['/', '\\']).filter(|s| !s.is_empty()) {
        let lower = part.to_lowercase();
        if lower == "mtp" {
            return true;
        }
        if lower.starts_with("mtp-") || lower.starts_with("mtp_") {
            return true;
        }
    }
    false
}

/// Full-copy head naming. Only ever consulted when the header already proved nextn
/// layers exist on a full stack.
///
/// Deliberately NOT `catalog_signals`: that list includes the HF repo id, and a repo
/// named `*-MTP-GGUF` (unsloth `Qwen3.6-27B-MTP-GGUF`) is a BAKED-IN main convention.
/// A substring test on the repo id would condemn every quant in such a repo to
/// head-only. The markers here are file-local: an `mtp-`/`mtp_` file-name prefix, a
/// bare `MTP` folder segment, and the explicit head tokens of
/// `is_explicit_mtp_head_signal` applied to the file name.
fn full_copy_head_naming(path: &str, name: &str) -> bool {
    let file_name = path
        .rsplit(['/', '\\'])
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or(name);
    let file_lower = file_name.to_lowercase();
    if file_lower.starts_with("mtp-") || file_lower.starts_with("mtp_") {
        return true;
    }
    if path
        .split(['/', '\\'])
        .any(|seg| seg.to_lowercase() == "mtp")
    {
        return true;
    }
    is_explicit_mtp_head_signal(file_name)
}

fn gguf_file_is_embedded_mtp(name: &str) -> bool {
    let lower = name.to_lowercase();
    if !lower.ends_with(".gguf") {
        return false;
    }
    lower.ends_with("-mtp.gguf") || lower.ends_with("_mtp.gguf")
}

/// Baked-in MTP main from publisher naming. Not a GGUF KV — the header does not carry a
/// reliable MTP/draft role. ISTA-DASLab uses a `-mtp.gguf` suffix inside a repo that has
/// no MTP token; Unsloth uses an `MTP-GGUF` folder.
pub fn signal_contains_embedded_mtp(signal: &str) -> bool {
    for part in signal.split(['/', '\\']).filter(|s| !s.is_empty()) {
        let lower = part.to_lowercase();
        if lower.ends_with(".gguf") {
            if gguf_file_is_embedded_mtp(&lower) {
                return true;
            }
        } else if lower.contains("mtp-gguf") {
            return true;
        }
    }
    false
}

fn path_segment_signals(model_path: &str) -> impl Iterator<Item = &str> {
    model_path.split(['/', '\\']).filter(|s| !s.is_empty())
}

/// Launchability gate: only an external draft file is unlaunchable as `-m`.
/// Baked-in MTP is a capability of a perfectly normal main model.
pub fn is_launchable_target(shape: Option<&GgufShape>, model_path: &str) -> bool {
    !classify_draft_role(shape, model_path, "", None, None).0.is_external_draft_only()
}

/// Catalog `draftRoleHint` — the only draft identity TS reads.
pub fn is_external_draft_role_hint(hint: &str) -> bool {
    matches!(
        hint.trim().to_lowercase().as_str(),
        "external_dflash" | "external_eagle3" | "external_mtp"
    )
}

/// Does this spec type launch with an external draft GGUF?
/// `draft-mtp` is the split case: **with** a draft path it is an external MTP head
/// loaded via `--spec-draft-model`; **without** one it is baked-in MTP and takes no
/// draft path. Never conflate the two — their VRAM footprints differ.
pub fn spec_type_needs_external_draft(spec_type: &str, draft_value: &str) -> bool {
    let lower = spec_type.trim().to_lowercase();
    let draft = draft_value.trim();
    let draft_set = !draft.is_empty()
        && !draft.eq_ignore_ascii_case("off")
        && !draft.eq_ignore_ascii_case("none");
    // External MTP heads are loaded via --spec-draft-model, same as DFlash.
    lower.contains("dflash")
        || lower.contains("eagle3")
        || lower.contains("external-mtp")
        || (lower.starts_with("draft-") && lower != "draft-simple" && (lower != "draft-mtp" || draft_set))
}

pub fn resolve_spec_draft_model_path(
    model_path: &str,
    value: &str,
    pattern: &str,
) -> Option<String> {
    let trimmed = value.trim();
    if trimmed.is_empty() || trimmed.eq_ignore_ascii_case("off") {
        return None;
    }

    if trimmed.eq_ignore_ascii_case("auto") || trimmed.eq_ignore_ascii_case("on") {
        // The main's own folder first — the classic sidecar layout. The catalog
        // fallback lives in the launch path (`resolve_auto_draft_from_catalog`):
        // a head in a `…/MTP/` sidecar is not a sibling of a main in `…/UD-Q4_K_XL/`,
        // and the catalog needs AppConfig, which this module does not hold.
        return scan_sibling_draft(model_path, pattern);
    }

    if trimmed.ends_with(".gguf") {
        let candidate = Path::new(trimmed);
        if candidate.is_absolute() && candidate.is_file() {
            return Some(trimmed.to_string());
        }
        if let Some(parent) = Path::new(model_path).parent() {
            let joined = parent.join(trimmed);
            if joined.is_file() {
                return Some(joined.to_string_lossy().to_string());
            }
        }
        if candidate.is_file() {
            return Some(trimmed.to_string());
        }
    }

    None
}

fn scan_sibling_draft(model_path: &str, pattern: &str) -> Option<String> {
    let parent = Path::new(model_path).parent()?;
    let entries = std::fs::read_dir(parent).ok()?;
    let pattern_lower = pattern.trim().to_lowercase();

    for entry in entries.flatten() {
        let fname = entry.file_name();
        let fname_str = fname.to_string_lossy();
        let fname_lower = fname_str.to_lowercase();
        if !fname_lower.ends_with(".gguf") {
            continue;
        }
        if matches_glob_pattern(&fname_lower, &pattern_lower) {
            return Some(fname.to_string_lossy().to_string());
        }
    }
    None
}

/// `auto` fallback: pick a pattern-matching draft from the catalog, scored against
/// the main (stem overlap + same-parent bonus, same rules as the ★ picker). The
/// catalog is the only place that knows where heads live outside the main's folder
/// (`…/MTP/` sidecars). Falls back to the first pattern match when nothing scores.
///
/// `catalog` is passed in, not fetched: the catalog is a filesystem walk with no
/// global cache (the `list_models` command builds it per call from `AppConfig`), so
/// the launch path hands down the paths it already holds under its config lock.
pub fn resolve_auto_draft_from_catalog(
    model_path: &str,
    pattern: &str,
    catalog: &[crate::types::ModelEntry],
) -> Option<String> {
    let pattern_lower = pattern.trim().to_lowercase();
    let main_stem = Path::new(model_path)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_lowercase()
        .replace(".gguf", "");

    let mut best: Option<(i32, String)> = None;
    let mut first_match: Option<String> = None;
    for entry in catalog {
        if entry.path == model_path {
            continue;
        }
        if !is_external_draft_role_hint(&entry.draft_role_hint) {
            continue;
        }
        let file_lower = entry
            .path
            .rsplit(['/', '\\'])
            .next()
            .unwrap_or("")
            .to_lowercase();
        if !file_lower.ends_with(".gguf") || !matches_glob_pattern(&file_lower, &pattern_lower) {
            continue;
        }
        if first_match.is_none() {
            first_match = Some(entry.path.clone());
        }
        let mut score = 0i32;
        if !main_stem.is_empty() && file_lower.contains(&main_stem) {
            score += 10;
        }
        if same_parent_dir(&entry.path, model_path) {
            score += 5;
        }
        if best.as_ref().is_none_or(|(s, _)| score > *s) {
            best = Some((score, entry.path.clone()));
        }
    }
    best.map(|(_, path)| path).or(first_match)
}

fn same_parent_dir(a: &str, b: &str) -> bool {
    let norm = |p: &str| {
        Path::new(p)
            .parent()
            .map(|d| d.to_string_lossy().to_lowercase())
            .unwrap_or_default()
    };
    norm(a) == norm(b)
}

fn matches_glob_pattern(name: &str, pattern: &str) -> bool {
    if pattern.is_empty() || pattern == "*" {
        return true;
    }
    if let Some(inner) = pattern.strip_prefix('*').and_then(|s| s.strip_suffix('*')) {
        return !inner.is_empty() && name.contains(inner);
    }
    if let Some(suffix) = pattern.strip_prefix('*') {
        return name.ends_with(suffix);
    }
    if let Some(prefix) = pattern.strip_suffix('*') {
        return name.starts_with(prefix);
    }
    name == pattern
}

/// Catalog `draftRoleHint` wire string for one row.
pub fn catalog_draft_role_hint(
    shape: Option<&GgufShape>,
    path: &str,
    name: &str,
    hf_model_id: Option<&str>,
    source_path_label: Option<&str>,
) -> String {
    classify_draft_role(shape, path, name, hf_model_id, source_path_label)
        .0
        .as_str()
        .to_string()
}

/// True when the file carries baked-in MTP layers, from header evidence plus the
/// publisher naming conventions (`-mtp.gguf`, `MTP-GGUF` folder).
pub fn baked_mtp_for_path(shape: Option<&GgufShape>, path: &str) -> bool {
    classify_draft_role(shape, path, "", None, None).1.baked_mtp
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::Deserialize;

    /// The fixture `shape` object is the same wire object `GgufShape` serializes to,
    /// so it deserializes straight into the real type — no parallel struct to drift.
    #[derive(Deserialize)]
    struct Fixture {
        id: String,
        path: String,
        #[serde(default)]
        shape: Option<GgufShape>,
        expected_role: String,
        expected_baked_mtp: bool,
    }

    fn role_str(role: DraftRole) -> String {
        role.as_str().to_string()
    }

    /// The shared case table — the same file the vitest mirror runs.
    #[test]
    fn fixture_table_classifies_every_case() {
        let cases: Vec<Fixture> =
            serde_json::from_str(FIXTURES_JSON).expect("fixtures.json parses");
        assert_eq!(cases.len(), 21, "fixture table case count drifted");

        for case in &cases {
            let (role, facts) = classify_draft_role(case.shape.as_ref(), &case.path, "", None, None);
            assert_eq!(
                role_str(role),
                case.expected_role,
                "fixture {} role: got {}, expected {}",
                case.id,
                role_str(role),
                case.expected_role
            );
            assert_eq!(
                facts.baked_mtp,
                case.expected_baked_mtp,
                "fixture {} baked_mtp: got {}, expected {}",
                case.id,
                facts.baked_mtp,
                case.expected_baked_mtp
            );
        }
    }

    /// Every fixture must stay launchable exactly when its role is not external —
    /// judged from the header evidence the fixture carries, the same way the catalog does.
    #[test]
    fn fixture_table_launchability_matches_role() {
        let cases: Vec<Fixture> =
            serde_json::from_str(FIXTURES_JSON).expect("fixtures.json parses");
        for case in &cases {
            let launchable = is_launchable_target(case.shape.as_ref(), &case.path);
            let expected = !is_external_draft_role_hint(&case.expected_role);
            assert_eq!(
                launchable, expected,
                "fixture {} launchability: got {}, expected {}",
                case.id, launchable, expected
            );
        }
    }

    #[test]
    fn fixtures_json_is_not_bundled_as_a_resource() {
        // The table is compile-time only; shipping it in the installer is a regression.
        let conf = include_str!("../tauri.conf.json");
        assert!(
            !conf.contains("fixtures.json"),
            "fixtures.json must not appear in tauri.conf.json bundle.resources"
        );
    }

    #[test]
    fn header_evidence_overrides_a_dflash_folder_name() {
        // The inversion this step exists for: today's code ran path heuristics first.
        let shape = GgufShape {
            architecture: "qwen36".into(),
            block_count: 64,
            nextn_layers: 0,
            has_markov_w1: false,
            has_trunk: true,
            has_vocab: true,
            shard_count: 1,
            tensor_count: 0,
            alignment: crate::gguf_patch::GGUF_DEFAULT_ALIGNMENT,
            header_end: 0,
        };
        let path = r"C:\models\DFlash\Qwen3.6-27B\Qwen3.6-27B-UD-Q4_K_XL.gguf";
        let (role, facts) = classify_draft_role(Some(&shape), path, "", None, None);
        assert_eq!(role, DraftRole::None);
        assert!(!facts.baked_mtp);
        assert!(is_launchable_target(Some(&shape), path));
    }

    #[test]
    fn naming_tier_still_fires_without_a_header() {
        let (role, facts) = classify_draft_role(
            None,
            r"C:\models\dflash\Qwen3.6-27B\dflash-draft-q8_0.gguf",
            "",
            None,
            None,
        );
        assert_eq!(role, DraftRole::ExternalDflash);
        assert!(!facts.baked_mtp);

        let (role, facts) = classify_draft_role(
            None,
            r"C:\models\ISTA-DASLab\Qwen3.8-27B-GSQ-RCO-GGUF\Qwen3.8-27B-GSQ-RCO-IQ3_S-mtp.gguf",
            "",
            None,
            None,
        );
        assert_eq!(role, DraftRole::None);
        assert!(facts.baked_mtp);
    }

    #[test]
    fn mtp_head_path_signal_is_external() {
        let (role, _) = classify_draft_role(None, r"C:\models\mtp-head.gguf", "", None, None);
        assert_eq!(role, DraftRole::ExternalMtp);
        let (role, _) = classify_draft_role(None, r"C:\models\mtp_head\draft.bin", "", None, None);
        assert_eq!(role, DraftRole::ExternalMtp);
    }

    /// The full-copy branch reads FILE-LOCAL naming only. A baked-in repo named
    /// `*-MTP-GGUF` (unsloth Qwen3.6-27B-MTP-GGUF) carries the mtp token in the repo
    /// folder and the hf_model_id — if the branch consulted those, every quant in
    /// the repo would flip to head-only and stop launching as `-m`.
    #[test]
    fn full_copy_branch_ignores_repo_naming() {
        let full_stack = GgufShape {
            architecture: "qwen35".into(),
            block_count: 65,
            nextn_layers: 65,
            has_markov_w1: false,
            has_trunk: true,
            has_vocab: true,
            shard_count: 1,
            tensor_count: 0,
            alignment: 32,
            header_end: 0,
        };
        let (role, facts) = classify_draft_role(
            Some(&full_stack),
            r"C:\models\unsloth\Qwen3.6-27B-MTP-GGUF\Qwen3.6-27B-UD-Q4_K_XL.gguf",
            "Qwen3.6-27B",
            Some("unsloth/Qwen3.6-27B-MTP-GGUF"),
            None,
        );
        assert_eq!(role, DraftRole::None, "repo naming must not condemn a baked-in main");
        assert!(facts.baked_mtp);

        // Same repo, but the FILE is a head export — file-local naming still fires.
        let (role, _) = classify_draft_role(
            Some(&full_stack),
            r"C:\models\unsloth\Qwen3.6-27B-MTP-GGUF\mtp-Qwen3.6-27B-Q8_0.gguf",
            "Qwen3.6-27B",
            Some("unsloth/Qwen3.6-27B-MTP-GGUF"),
            None,
        );
        assert_eq!(role, DraftRole::ExternalMtp);
    }

    #[test]
    fn external_roles_are_external_draft_only() {
        assert!(DraftRole::ExternalMtp.is_external_draft_only());
        assert!(DraftRole::ExternalDflash.is_external_draft_only());
        assert!(DraftRole::ExternalEagle3.is_external_draft_only());
        assert!(!DraftRole::None.is_external_draft_only());
    }

    #[test]
    fn spec_type_needs_external_draft_detects_dflash() {
        assert!(spec_type_needs_external_draft("draft-dflash", ""));
        assert!(spec_type_needs_external_draft("external-mtp", ""));
        // draft-mtp without a draft path is baked-in MTP — no draft lane.
        assert!(!spec_type_needs_external_draft("draft-mtp", ""));
        assert!(!spec_type_needs_external_draft("draft-mtp", "off"));
        // draft-mtp with a draft path is an external MTP head.
        assert!(spec_type_needs_external_draft("draft-mtp", r"C:\m\head.gguf"));
        assert!(!spec_type_needs_external_draft("draft-simple", r"C:\m\head.gguf"));
    }

    #[test]
    fn catalog_hint_wire_strings_are_the_four_roles() {
        for role in [
            DraftRole::None,
            DraftRole::ExternalDflash,
            DraftRole::ExternalEagle3,
            DraftRole::ExternalMtp,
        ] {
            assert!(
                role.as_str() == "none" || is_external_draft_role_hint(role.as_str()),
                "role {} is not reachable from the hint string",
                role.as_str()
            );
        }
        assert!(!is_external_draft_role_hint("mtp_embedded"));
    }

    #[test]
    fn embedded_mtp_signal_ignores_plain_and_head_naming() {
        assert!(signal_contains_embedded_mtp(
            r"C:\models\unsloth\Qwen3.6-27B-MTP-GGUF\Qwen3.6-27B-UD-Q4_K_XL.gguf"
        ));
        assert!(!signal_contains_embedded_mtp(
            r"C:\models\ddh0\DeepSeek-V4-Flash-GGUF\DeepSeek-V4-Flash-MTP-Q8_0.gguf"
        ));
        assert!(!signal_contains_embedded_mtp(
            r"C:\models\vendor\Qwen3.8-27B\Qwen3.8-27B-Q4_K_M.gguf"
        ));
    }
}
