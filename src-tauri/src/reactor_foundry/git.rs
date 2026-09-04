//! Git spawn helpers, vendor patches, PR fetch/merge, and hard-sync.
//!
//! Leaf module of the Foundry build service. All git operations (clone, fetch,
//! hard-reset, vendor patch apply, GitHub PR merge) plus PR-URL parsing and
//! commit-hash helpers live here so the worker in `mod.rs` stays a thin sequencer.

use serde::Serialize;
use std::path::PathBuf;

pub(crate) async fn git_hidden_output(
    git_exe: std::path::PathBuf,
    current_dir: PathBuf,
    args: Vec<String>,
) -> Result<std::process::Output, String> {
    crate::engine_utils::run_hidden_output_async(move || {
        let mut cmd = std::process::Command::new(&git_exe);
        crate::sidecar_elevate::apply_portable_git_env(&mut cmd, &git_exe);
        cmd.args(&args).current_dir(&current_dir);
        cmd
    })
    .await
}
pub(crate) async fn ensure_git_available(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    let git_exe = crate::sidecar_elevate::resolve_git_exe(app)?;
    match git_hidden_output(git_exe.clone(), std::env::temp_dir(), vec!["--version".into()]).await
    {
        Ok(output) if output.status.success() => Ok(git_exe),
        Ok(output) => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            let stdout = String::from_utf8_lossy(&output.stdout);
            Err(format!(
                "Bundled Git check failed ({}): {}",
                git_exe.display(),
                if !stderr.trim().is_empty() {
                    stderr.trim()
                } else {
                    stdout.trim()
                }
            ))
        }
        Err(e) => Err(format!(
            "Bundled Git failed to run ({}): {}",
            git_exe.display(),
            e
        )),
    }
}
pub(crate) fn foundry_src_dir(provider_id: &str) -> PathBuf {
    crate::config::foundry_dir(provider_id).join("llama.cpp")
}
/// Resolve product vendor patches for a provider (`foundry/patches/<id>-*.patch`).
pub(crate) fn foundry_vendor_patch_files(provider_id: &str) -> Vec<PathBuf> {
    let dir = crate::config::foundry_patches_dir();
    let mut out = Vec::new();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return out;
    };
    let prefix = format!("{provider_id}-");
    for ent in rd.flatten() {
        let path = ent.path();
        if path.extension().and_then(|e| e.to_str()) != Some("patch") {
            continue;
        }
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or_default();
        if name.starts_with(&prefix) || name.starts_with("all-") {
            out.push(path);
        }
    }
    out.sort();
    out
}
pub(crate) fn git_output_text(output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let s = if !stderr.trim().is_empty() {
        stderr.trim()
    } else {
        stdout.trim()
    };
    s.lines()
        .take(8)
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" | ")
}
/// Snapshot dirty source tree before hard-reset so hand-edits are not silently lost.
pub(crate) async fn backup_foundry_src_dirty_diff(
    git_exe: &std::path::Path,
    src_dir: &std::path::Path,
    provider_id: &str,
) {
    let diff = match git_hidden_output(
        git_exe.to_path_buf(),
        src_dir.to_path_buf(),
        vec!["diff".into(), "--binary".into()],
    )
    .await
    {
        Ok(o) if !o.stdout.is_empty() => o.stdout,
        _ => return,
    };
    let backup_dir = crate::config::cache_dir().join("foundry-src-backups");
    if tokio::fs::create_dir_all(&backup_dir).await.is_err() {
        return;
    }
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let path = backup_dir.join(format!("{provider_id}-{ts}.patch"));
    let _ = tokio::fs::write(&path, diff).await;
    log::info!(
        "[foundry] Backed up dirty llama.cpp diff → {}",
        path.display()
    );
}
/// Fast-forward source to origin/<branch> (hard reset). Local dirt never blocks Foundry.
pub(crate) async fn git_hard_sync_branch(
    git_exe: &std::path::Path,
    src_dir: &std::path::Path,
    branch: &str,
) -> Result<(), String> {
    let remote_ref = format!("origin/{branch}");
    // Explicit refspec: a bare `git fetch origin <branch>` only updates FETCH_HEAD —
    // the remote-tracking ref is created only when it is already known, so a branch
    // switch on an existing (shallow) clone would leave `origin/<branch>` absent and
    // the checkout below would fail with "is not a commit".
    let fetch_refspec = format!("refs/heads/{branch}:refs/remotes/origin/{branch}");
    let fetch = git_hidden_output(
        git_exe.to_path_buf(),
        src_dir.to_path_buf(),
        vec![
            "fetch".into(),
            "origin".into(),
            fetch_refspec,
            "--recurse-submodules".into(),
        ],
    )
    .await
    .map_err(|e| format!("Git fetch failed: {e}"))?;
    if !fetch.status.success() {
        return Err(format!("Git fetch failed: {}", git_output_text(&fetch)));
    }

    let checkout = git_hidden_output(
        git_exe.to_path_buf(),
        src_dir.to_path_buf(),
        vec![
            "checkout".into(),
            "-f".into(),
            "-B".into(),
            branch.to_string(),
            remote_ref.clone(),
        ],
    )

    .await
    .map_err(|e| format!("Git checkout failed: {e}"))?;
    if !checkout.status.success() {
        return Err(format!(
            "Git checkout failed: {}",
            git_output_text(&checkout)
        ));
    }

    let reset = git_hidden_output(
        git_exe.to_path_buf(),
        src_dir.to_path_buf(),
        vec!["reset".into(), "--hard".into(), remote_ref],
    )
    .await
    .map_err(|e| format!("Git reset failed: {e}"))?;
    if !reset.status.success() {
        return Err(format!("Git reset failed: {}", git_output_text(&reset)));
    }

    let _ = git_hidden_output(
        git_exe.to_path_buf(),
        src_dir.to_path_buf(),
        vec![
            "submodule".into(),
            "update".into(),
            "--init".into(),
            "--recursive".into(),
        ],
    )
    .await;
    Ok(())
}
/// Apply durable product patches after clean clone/sync. Idempotent when already applied.
/// Never hard-fails the build: a broken/outdated patch is reported and skipped so the
/// battle-tested cmake/ninja path still runs (product has a fallback boot path without SSE).
pub(crate) async fn apply_foundry_vendor_patches(
    git_exe: &std::path::Path,
    src_dir: &std::path::Path,
    provider_id: &str,
) -> (Vec<String>, Vec<String>) {
    let patches = foundry_vendor_patch_files(provider_id);
    if patches.is_empty() {
        return (vec![], vec![]);
    }

    let mut applied = Vec::new();
    let mut failed = Vec::new();
    for patch in patches {
        let Some(patch_str) = patch.to_str().map(|s| s.to_string()) else {
            failed.push(format!(
                "patch path is not valid UTF-8: {}",
                patch.display()
            ));
            continue;
        };
        let name = patch
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("patch")
            .to_string();

        // Already applied? reverse --check succeeds only when the forward diff is present.
        let reverse_ok = git_hidden_output(
            git_exe.to_path_buf(),
            src_dir.to_path_buf(),
            vec![
                "apply".into(),
                "--reverse".into(),
                "--check".into(),
                patch_str.clone(),
            ],
        )
        .await
        .map(|o| o.status.success())
        .unwrap_or(false);
        if reverse_ok {
            applied.push(format!("{name} (already applied)"));
            continue;
        }

        let check = match git_hidden_output(
            git_exe.to_path_buf(),
            src_dir.to_path_buf(),
            vec![
                "apply".into(),
                "--check".into(),
                "--whitespace=nowarn".into(),
                patch_str.clone(),
            ],
        )
        .await
        {
            Ok(o) => o,
            Err(e) => {
                failed.push(format!("{name}: git apply --check spawn failed: {e}"));
                continue;
            }
        };

        if !check.status.success() {
            // 3-way can still land on drifted upstream context.
            let check3 = match git_hidden_output(
                git_exe.to_path_buf(),
                src_dir.to_path_buf(),
                vec![
                    "apply".into(),
                    "--3way".into(),
                    "--check".into(),
                    "--whitespace=nowarn".into(),
                    patch_str.clone(),
                ],
            )
            .await
            {
                Ok(o) => o,
                Err(e) => {
                    failed.push(format!("{name}: git apply --3way --check spawn failed: {e}"));
                    continue;
                }
            };
            if !check3.status.success() {
                failed.push(format!(
                    "{name}: does not apply on this upstream tree — {}",
                    git_output_text(&check3)
                ));
                continue;
            }
            let apply3 = match git_hidden_output(
                git_exe.to_path_buf(),
                src_dir.to_path_buf(),
                vec![
                    "apply".into(),
                    "--3way".into(),
                    "--whitespace=nowarn".into(),
                    patch_str.clone(),
                ],
            )
            .await
            {
                Ok(o) => o,
                Err(e) => {
                    failed.push(format!("{name}: git apply --3way spawn failed: {e}"));
                    continue;
                }
            };
            if !apply3.status.success() {
                failed.push(format!(
                    "{name}: 3-way apply failed — {}",
                    git_output_text(&apply3)
                ));
                continue;
            }
            applied.push(format!("{name} (3-way)"));
            continue;
        }

        let apply = match git_hidden_output(
            git_exe.to_path_buf(),
            src_dir.to_path_buf(),
            vec![
                "apply".into(),
                "--whitespace=nowarn".into(),
                patch_str,
            ],
        )
        .await
        {
            Ok(o) => o,
            Err(e) => {
                failed.push(format!("{name}: git apply spawn failed: {e}"));
                continue;
            }
        };
        if !apply.status.success() {
            failed.push(format!(
                "{name}: apply failed — {}",
                git_output_text(&apply)
            ));
            continue;
        }
        applied.push(name);
    }
    (applied, failed)
}
// ── PR Parsing (URL or number) ───────────────────────────────────────

/// Extract owner/repo and PR number from a GitHub PR URL.
pub(crate) fn parse_github_pr(url: &str) -> Option<(String, String)> {
    let u = url.trim();
    if let Some(idx) = u.find("/pull/") {
        let before = &u[..idx];
        let after = &u[idx + 6..];
        let pr_num = after.split('/').next().unwrap_or(after).trim().to_string();
        if let Some(re) = regex::Regex::new(r"(?:https?://)?github\.com/([^/]+)/([^/?#]+)").ok() {
            if let Some(caps) = re.captures(before) {
                let owner = caps.get(1)?.as_str();
                let repo = caps.get(2)?.as_str();
                return Some((format!("{}/{}", owner, repo), pr_num));
            }
        }
    }
    None
}

/// Try to extract "owner/repo" from common GitHub git URL formats.
/// Used to enable number-only PR cherry-picks by guessing the repo from the provider.
pub(crate) fn extract_github_owner_repo(git_url: &str) -> Option<String> {
    let url = git_url.trim().trim_end_matches(".git");

    // https://github.com/owner/repo or git@github.com:owner/repo
    if let Some(rest) = url.strip_prefix("https://github.com/") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
    } else if let Some(rest) = url.strip_prefix("git@github.com:") {
        let parts: Vec<&str> = rest.split('/').collect();
        if parts.len() >= 2 {
            return Some(format!("{}/{}", parts[0], parts[1]));
        }
    }

    None
}

/// Parse PR input: supports full URL or plain number.
/// Returns (owner_repo, pr_number) for URLs, or (None, number) for plain numbers.
pub(crate) fn parse_pr_input(pr_input: &str) -> Option<(Option<String>, String)> {
    let trimmed = pr_input.trim();
    
    // Try as plain number first
    if trimmed.chars().all(|c| c.is_ascii_digit()) {
        return Some((None, trimmed.to_string()));
    }

    // Try as GitHub PR URL
    if let Some((owner_repo, pr_num)) = parse_github_pr(trimmed) {
        return Some((Some(owner_repo), pr_num));
    }

    None
}

/// Parse a PR list string into an ordered, deduped vector of (owner_repo_opt, pr_num).
///
/// Tokens are separated by comma, semicolon, and any whitespace (space/tab/newline).
/// Empty tokens are skipped. Each token is parsed with [`parse_pr_input`]; a token that
/// fails to parse yields `Err` naming the offending token. Deduplication is by
/// (owner_repo_opt, pr_num) preserving first-seen order.
pub(crate) fn parse_pr_list(input: &str) -> Result<Vec<(Option<String>, String)>, String> {
    let tokens: Vec<&str> = input
        .split(|c: char| c.is_whitespace() || c == ',' || c == ';')
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .collect();

    let mut seen: Vec<(Option<String>, String)> = Vec::new();
    for token in tokens {
        match parse_pr_input(token) {
            Some(entry) => {
                if !seen.contains(&entry) {
                    seen.push(entry);
                }
            }
            None => {
                return Err(format!(
                    "Invalid PR token: '{token}' — must be a GitHub PR URL or plain number"
                ));
            }
        }
    }
    Ok(seen)
}

/// Push a normalized PR-stack string into an MRU history vec (cap 3, newest first).
/// Reusing an existing entry moves it to the front; a new entry is inserted at 0 and
/// the vec is truncated to 3.
pub(crate) fn push_pr_history(history: &mut Vec<String>, entry: String) {
    history.retain(|h| h != &entry);
    history.insert(0, entry);
    history.truncate(3);
}
/// True when the repository at `src_dir` is a shallow clone.
///
/// Shallow clones lack the full commit history, so a `git merge` of a fetched PR head
/// cannot find its merge-base and fails. We check the `.git/shallow` marker file first
/// (no subprocess), then fall back to `git rev-parse --is-shallow-repository`.
pub(crate) async fn is_shallow_repo(git_exe: &std::path::Path, src_dir: &std::path::Path) -> bool {
    // Fast path: the shallow marker file exists.
    if src_dir.join(".git").join("shallow").exists() {
        return true;
    }
    // Authoritative check (works even if the marker was removed).
    match git_hidden_output(git_exe.to_path_buf(), src_dir.to_path_buf(), vec!["rev-parse".into(), "--is-shallow-repository".into()]).await {
        Ok(out) if out.status.success() => {
            String::from_utf8_lossy(&out.stdout).trim() == "true"
        }
        _ => false,
    }
}

/// GitHub PR merge state fetched from the REST API (soft-fail; fields may be absent).
#[derive(Debug, Clone, Default)]
pub(crate) struct PrMergeState {
    pub mergeable: Option<bool>,
    pub mergeable_state: Option<String>,
    pub title: Option<String>,
}

/// Query GitHub for the PR's mergeability. Soft-fails: any HTTP/parse error yields
/// `Default` (all `None`) so the build never blocks on GitHub API availability.
pub(crate) async fn fetch_pr_merge_state(owner_repo: &str, pr_num: &str) -> PrMergeState {
    let url = format!(
        "https://api.github.com/repos/{owner_repo}/pulls/{pr_num}"
    );
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(10))
        // GitHub's REST API rejects the default reqwest User-Agent (403 / rate-limit),
        // so set an explicit one.
        .user_agent("Blackwell-Ops")
        .build()
        .unwrap_or_default();
    let resp = match client.get(&url).send().await {
        Ok(r) if r.status().is_success() => r,
        _ => return PrMergeState::default(),
    };
    let json: serde_json::Value = match resp.json().await {
        Ok(j) => j,
        Err(_) => return PrMergeState::default(),
    };
    PrMergeState {
        mergeable: json["mergeable"].as_bool(),
        mergeable_state: json["mergeable_state"].as_str().map(String::from),
        title: json["title"].as_str().map(String::from),
    }
}

/// Compose a user-facing error message for a failed PR apply, incorporating GitHub's
/// mergeability verdict when available.
pub(crate) fn format_pr_apply_failure(
    pr_num: &str,
    gh: &PrMergeState,
    local_line: &str,
) -> String {
    let title = gh.title.as_deref().unwrap_or("untitled");
    let gh_note = match (&gh.mergeable, &gh.mergeable_state) {
        (Some(false), Some(state)) => format!("GitHub: {state}"),
        (Some(false), None) => "GitHub: not mergeable".to_string(),
        (Some(true), Some(state)) if state != "clean" => format!("GitHub: {state}"),
        _ => "local conflict detected".to_string(),
    };
    format!(
        "PR #{pr_num} ({title}) conflicts with current branch ({gh_note}). Local: {local_line}. Rebase the PR or wait for the author — Foundry will not auto-resolve."
    )
}

/// Apply a GitHub PR onto a clean foundry source tree (hard-synced branch, no local dirty).
///
/// If the tree is a shallow clone (Foundry clones with `--depth 1`), the full history is
/// fetched first (`git fetch --unshallow`, falling back to `--deepen=512`) so the PR merge
/// can find its merge-base. A shallow tree cannot merge a PR head — the merge-base commit
/// is missing — and the `--3way` patch fallback then fails with "Applied patch … with
/// conflicts" because the needed blobs are absent.
///
/// Prefers `git fetch … pull/<n>/head` + merge so already-landed hunks (common when master
/// moved under an open PR) resolve via real merge instead of brittle `git apply` context.
/// Falls back to the PR `.diff` with plain apply then `--3way`.
///
/// Returns a short method tag on success (`"merged"` / `"patch"` / `"patch-3way"`).
pub(crate) async fn apply_foundry_github_pr(
    git_exe: &std::path::Path,
    src_dir: &std::path::Path,
    owner_repo: &str,
    pr_num: &str,
) -> Result<&'static str, String> {
    let local_ref = format!("refs/foundry/pr-{pr_num}");
    let pull_refspec = format!("pull/{pr_num}/head:{local_ref}");

    // 0) Unshallow before fetching the PR. Foundry clones with `--depth 1`, so a shallow
    // tree has no merge-base for the PR head and the merge below fails. `git fetch
    // --unshallow` restores full history; if that fails (e.g. origin is a partial mirror),
    // deepen by 512 and continue — the merge may still succeed, and the patch fallback
    // remains available. Non-PR builds never reach here.
    if is_shallow_repo(git_exe, src_dir).await {
        let unshallow = git_hidden_output(
            git_exe.to_path_buf(),
            src_dir.to_path_buf(),
            vec!["fetch".into(), "--unshallow".into()],
        )
        .await;
        match &unshallow {
            Ok(o) if o.status.success() => {
                log::info!("[foundry] PR #{pr_num} unshallowed repository before merge");
            }
            Ok(o) => {
                log::warn!(
                    "[foundry] PR #{pr_num} unshallow failed, deepening by 512: {}",
                    git_output_text(o)
                );
                let _ = git_hidden_output(
                    git_exe.to_path_buf(),
                    src_dir.to_path_buf(),
                    vec!["fetch".into(), "--deepen=512".into()],
                )
                .await;
                if is_shallow_repo(git_exe, src_dir).await {
                    log::warn!(
                        "[foundry] PR #{pr_num} still shallow after deepen — merge may fail, falling back to patch apply"
                    );
                }
            }
            Err(e) => {
                log::warn!("[foundry] PR #{pr_num} unshallow spawn failed: {e}");
            }
        }
    }

    // 1) Fetch PR head — origin first (provider clone), then explicit base-repo URL.
    let mut fetch = git_hidden_output(
        git_exe.to_path_buf(),
        src_dir.to_path_buf(),
        vec![
            "fetch".into(),
            "origin".into(),
            pull_refspec.clone(),
            "--force".into(),
        ],
    )
    .await;

    if !fetch.as_ref().map(|o| o.status.success()).unwrap_or(false) {
        let url = format!("https://github.com/{owner_repo}.git");
        fetch = git_hidden_output(
            git_exe.to_path_buf(),
            src_dir.to_path_buf(),
            vec![
                "fetch".into(),
                url,
                format!("pull/{pr_num}/head:{local_ref}"),
                "--force".into(),
            ],
        )
        .await;
    }

    if let Ok(out) = &fetch {
        if out.status.success() {
            let merge = git_hidden_output(
                git_exe.to_path_buf(),
                src_dir.to_path_buf(),
                vec!["merge".into(), "--no-edit".into(), local_ref.clone()],
            )
            .await;
            match merge {
                Ok(mout) if mout.status.success() => return Ok("merged"),
                Ok(mout) => {
                    let _ = git_hidden_output(
                        git_exe.to_path_buf(),
                        src_dir.to_path_buf(),
                        vec!["merge".into(), "--abort".into()],
                    )
                    .await;
                    // Ensure the tree is clean before the patch fallback — merge --abort
                    // can leave a partially-merged index behind.
                    let _ = git_hidden_output(
                        git_exe.to_path_buf(),
                        src_dir.to_path_buf(),
                        vec!["reset".into(), "--hard".into(), "HEAD".into()],
                    )
                    .await;
                    // Fall through to patch apply — merge conflicts on drifted trees still happen.
                    log::warn!(
                        "[foundry] PR #{pr_num} merge failed, trying patch apply: {}",
                        git_output_text(&mout)
                    );
                }
                Err(e) => {
                    log::warn!("[foundry] PR #{pr_num} merge spawn failed, trying patch apply: {e}");
                }
            }
        } else {
            log::warn!(
                "[foundry] PR #{pr_num} fetch failed, trying patch apply: {}",
                git_output_text(out)
            );
        }
    } else if let Err(e) = &fetch {
        log::warn!("[foundry] PR #{pr_num} fetch spawn failed, trying patch apply: {e}");
    }

    // 2) Fallback: raw .diff (same source Foundry used historically).
    let patch_url = format!(
        "https://patch-diff.githubusercontent.com/raw/{owner_repo}/pull/{pr_num}.diff"
    );
    let patch_resp = reqwest::get(&patch_url)
        .await
        .map_err(|e| format!("HTTP fetch failed: {e}"))?;
    if !patch_resp.status().is_success() {
        return Err(format!(
            "PR not found or inaccessible (HTTP {})",
            patch_resp.status()
        ));
    }
    let patch = String::from_utf8_lossy(&patch_resp.bytes().await.unwrap_or_default()).to_string();
    if patch.trim().is_empty() {
        return Ok("merged"); // empty diff == already on tree
    }

    let patch_parent = src_dir
        .parent()
        .ok_or_else(|| "Cannot resolve patch path".to_string())?;
    let patch_path = patch_parent.join("pr-patch.diff");
    tokio::fs::write(&patch_path, &patch)
        .await
        .map_err(|e| format!("could not write patch file: {e}"))?;
    let patch_path_str = patch_path
        .to_str()
        .ok_or_else(|| "Patch path is not valid UTF-8".to_string())?
        .to_string();

    let mut apply_output = git_hidden_output(
        git_exe.to_path_buf(),
        src_dir.to_path_buf(),
        vec![
            "apply".into(),
            "--whitespace=nowarn".into(),
            patch_path_str.clone(),
        ],
    )
    .await;

    let mut method = "patch";
    if apply_output.as_ref().map_or(true, |o| !o.status.success()) {
        method = "patch-3way";
        apply_output = git_hidden_output(
            git_exe.to_path_buf(),
            src_dir.to_path_buf(),
            vec![
                "apply".into(),
                "--3way".into(),
                "--whitespace=nowarn".into(),
                patch_path_str,
            ],
        )
        .await;
    }

    let _ = tokio::fs::remove_file(&patch_path).await;

    match &apply_output {
        Ok(out) if out.status.success() => Ok(method),
        Ok(out) => {
            // `git apply --3way` leaves conflict markers in the worktree; `merge --abort`
            // is the wrong tool (no merge in progress). Hard-reset to clean the tree so
            // the next build starts from a known-good state.
            let _ = git_hidden_output(
                git_exe.to_path_buf(),
                src_dir.to_path_buf(),
                vec!["reset".into(), "--hard".into(), "HEAD".into()],
            )
            .await;
            // Prefer real failure lines (error:/fatal:/conflict) over "Applied … cleanly".
            let raw = {
                let stderr = String::from_utf8_lossy(&out.stderr);
                let stdout = String::from_utf8_lossy(&out.stdout);
                format!("{stderr}\n{stdout}")
            };
            let interesting = raw
                .lines()
                .map(str::trim)
                .filter(|l| !l.is_empty())
                .find(|l| {
                    let lower = l.to_ascii_lowercase();
                    lower.contains("error:")
                        || lower.contains("fatal:")
                        || lower.contains("conflict")
                        || lower.contains("does not apply")
                        || lower.contains("failed")
                })
                .unwrap_or_else(|| {
                    raw.lines()
                        .map(str::trim)
                        .find(|l| !l.is_empty())
                        .unwrap_or("unknown error")
                });
            let gh = fetch_pr_merge_state(owner_repo, pr_num).await;
            Err(format_pr_apply_failure(pr_num, &gh, interesting))
        }
        Err(e) => Err(format!("git apply spawn failed: {e}")),
    }
}
#[derive(Debug, Clone, Serialize)]
pub struct FoundrySourcePreview {
    pub status: String,
    pub branch: String,
    pub local_commit: Option<String>,
    pub remote_commit: Option<String>,
    pub installed_version: Option<String>,
    pub installed_commit: Option<String>,
    pub message: String,
    pub banner_tone: String,
}

pub(crate) fn short_commit_hash(hash: &str) -> String {
    hash.trim().chars().take(8).collect()
}

pub(crate) fn extract_commit_from_build_version(version: &str) -> Option<String> {
    let v = version.trim();
    if v.is_empty() || crate::engine::is_placeholder_build_version(v) {
        return None;
    }
    // Prefer explicit "commit <hash>" (new llama.cpp) or bare "(deadbeef)".
    use std::sync::LazyLock;
    static COMMIT_WORD: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)commit\s+([0-9a-f]{7,40})").expect("commit word")
    });
    static BARE_PAREN_HASH: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"\(([0-9a-fA-F]{7,40})\)").expect("bare paren hash")
    });
    static ANY_HEX: LazyLock<regex::Regex> = LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b([0-9a-f]{7,40})\b").expect("any hex")
    });

    if let Some(caps) = COMMIT_WORD.captures(v) {
        return Some(short_commit_hash(&caps[1]));
    }
    if let Some(caps) = BARE_PAREN_HASH.captures(v) {
        return Some(short_commit_hash(&caps[1]));
    }
    // Last resort: first hex token that isn't a tiny number.
    ANY_HEX
        .captures_iter(v)
        .map(|c| c[1].to_string())
        .find(|h| h.len() >= 7)
        .map(|h| short_commit_hash(&h))
}


pub(crate) fn commits_match(a: &str, b: &str) -> bool {
    let a = a.trim().to_lowercase();
    let b = b.trim().to_lowercase();
    if a.is_empty() || b.is_empty() {
        return false;
    }
    a == b || a.starts_with(&b) || b.starts_with(&a)
}

pub(crate) async fn git_rev_parse_short(git_exe: &std::path::Path, repo_dir: &std::path::Path) -> Option<String> {
    let output = git_hidden_output(
        git_exe.to_path_buf(),
        repo_dir.to_path_buf(),
        vec!["rev-parse".into(), "--short=8".into(), "HEAD".into()],
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let hash = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if hash.is_empty() {
        None
    } else {
        Some(hash)
    }
}

pub(crate) async fn git_ls_remote_short(
    git_exe: &std::path::Path,
    git_url: &str,
    branch: &str,
) -> Option<String> {
    let output = git_hidden_output(
        git_exe.to_path_buf(),
        std::env::temp_dir(),
        vec![
            "ls-remote".into(),
            "--heads".into(),
            git_url.into(),
            branch.into(),
        ],
    )
    .await
    .ok()?;
    if !output.status.success() {
        return None;
    }
    let stdout = String::from_utf8_lossy(&output.stdout);
    let line = stdout.lines().next()?.trim();
    let hash = line.split_whitespace().next()?.trim();
    if hash.is_empty() {
        None
    } else {
        Some(short_commit_hash(hash))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn is_shallow_repo_marker_file() {
        // Fast path: a `.git/shallow` marker file means shallow, no subprocess needed.
        let tmp = std::env::temp_dir().join("foundry-test-shallow-marker");
        let git_dir = tmp.join(".git");
        let _ = std::fs::create_dir_all(&git_dir);
        let marker = git_dir.join("shallow");
        std::fs::write(&marker, b"").unwrap();
        // git_exe is irrelevant on the fast path (marker exists → true before any spawn).
        assert!(is_shallow_repo(&std::path::PathBuf::from("git"), &tmp).await);
        let _ = std::fs::remove_dir_all(&tmp);
    }

    #[tokio::test]
    async fn is_shallow_repo_no_marker_non_repo() {
        // No marker file and no real repo → rev-parse fails → not shallow.
        let tmp = std::env::temp_dir().join("foundry-test-shallow-none");
        let _ = std::fs::create_dir_all(&tmp);
        // Use a non-existent git exe so the rev-parse spawn fails → false (no marker).
        assert!(!is_shallow_repo(
            &std::path::PathBuf::from("definitely-not-a-real-git-exe-xyz"),
            &tmp
        )
        .await);
        let _ = std::fs::remove_dir_all(&tmp);
    }
    #[test]
    fn parse_github_pr_with_scheme() {
        let (repo, num) = parse_github_pr("https://github.com/ggml-org/llama.cpp/pull/1234").unwrap();
        assert_eq!(repo, "ggml-org/llama.cpp");
        assert_eq!(num, "1234");
    }

    #[test]
    fn parse_github_pr_without_scheme() {
        let (repo, num) = parse_github_pr("github.com/ggml-org/llama.cpp/pull/5678").unwrap();
        assert_eq!(repo, "ggml-org/llama.cpp");
        assert_eq!(num, "5678");
    }

    #[test]
    fn parse_github_pr_garbage_returns_none() {
        assert!(parse_github_pr("not a url").is_none());
        assert!(parse_github_pr("").is_none());
        assert!(parse_github_pr("https://example.com/foo/bar").is_none());
    }

    #[test]
    fn extract_owner_repo_https() {
        let r = extract_github_owner_repo("https://github.com/ggml-org/llama.cpp").unwrap();
        assert_eq!(r, "ggml-org/llama.cpp");
    }

    #[test]
    fn extract_owner_repo_https_strips_git() {
        let r = extract_github_owner_repo("https://github.com/ggml-org/llama.cpp.git").unwrap();
        assert_eq!(r, "ggml-org/llama.cpp");
    }

    #[test]
    fn extract_owner_repo_ssh_form() {
        let r = extract_github_owner_repo("git@github.com:ggml-org/llama.cpp.git").unwrap();
        assert_eq!(r, "ggml-org/llama.cpp");
    }

    #[test]
    fn extract_owner_repo_garbage_returns_none() {
        assert!(extract_github_owner_repo("https://example.com/foo").is_none());
        assert!(extract_github_owner_repo("").is_none());
    }

    #[test]
    fn parse_pr_input_digits_only() {
        let (repo, num) = parse_pr_input("1234").unwrap();
        assert!(repo.is_none());
        assert_eq!(num, "1234");
    }

    #[test]
    fn parse_pr_input_url() {
        let (repo, num) = parse_pr_input("https://github.com/ggml-org/llama.cpp/pull/999").unwrap();
        assert_eq!(repo, Some("ggml-org/llama.cpp".to_string()));
        assert_eq!(num, "999");
    }

    #[test]
    fn parse_pr_input_garbage_returns_none() {
        assert!(parse_pr_input("hello world").is_none());
        // Note: "" is vacuously all-digits, so parse_pr_input("") returns Some((None, ""))
        // — only truly non-numeric, non-URL input returns None.
    }

    #[test]
    fn parse_pr_list_single_number() {
        let v = parse_pr_list("1234").unwrap();
        assert_eq!(v, vec![(None, "1234".to_string())]);
    }

    #[test]
    fn parse_pr_list_single_url() {
        let v = parse_pr_list("https://github.com/ggml-org/llama.cpp/pull/999").unwrap();
        assert_eq!(v, vec![(Some("ggml-org/llama.cpp".to_string()), "999".to_string())]);
    }

    #[test]
    fn parse_pr_list_comma_space_mix() {
        let v = parse_pr_list("1234, 5678 ; 9012").unwrap();
        assert_eq!(
            v,
            vec![
                (None, "1234".to_string()),
                (None, "5678".to_string()),
                (None, "9012".to_string())
            ]
        );
    }

    #[test]
    fn parse_pr_list_newlines() {
        let v = parse_pr_list("111\n222\t333").unwrap();
        assert_eq!(
            v,
            vec![
                (None, "111".to_string()),
                (None, "222".to_string()),
                (None, "333".to_string())
            ]
        );
    }

    #[test]
    fn parse_pr_list_dedupe_preserves_first() {
        let v = parse_pr_list("1234, 1234, 5678, 1234").unwrap();
        assert_eq!(
            v,
            vec![(None, "1234".to_string()), (None, "5678".to_string())]
        );
    }

    #[test]
    fn parse_pr_list_garbage_token_errors() {
        let r = parse_pr_list("1234, hello world");
        assert!(r.is_err());
        assert!(r.unwrap_err().contains("hello"));
    }

    #[test]
    fn parse_pr_list_empty_and_whitespace() {
        assert_eq!(parse_pr_list("").unwrap(), Vec::<(Option<String>, String)>::new());
        assert_eq!(
            parse_pr_list("   \t\n  ").unwrap(),
            Vec::<(Option<String>, String)>::new()
        );
    }

    #[test]
    fn push_pr_history_cap_three() {
        let mut h: Vec<String> = Vec::new();
        push_pr_history(&mut h, "a".into());
        push_pr_history(&mut h, "b".into());
        push_pr_history(&mut h, "c".into());
        push_pr_history(&mut h, "d".into());
        assert_eq!(h, vec!["d", "c", "b"]);
    }

    #[test]
    fn push_pr_history_reuse_moves_to_front() {
        let mut h: Vec<String> = Vec::new();
        push_pr_history(&mut h, "a".into());
        push_pr_history(&mut h, "b".into());
        push_pr_history(&mut h, "a".into());
        assert_eq!(h, vec!["a", "b"]);
    }
    #[test]
    fn short_commit_hash_first_8_trimmed() {
        assert_eq!(short_commit_hash("abcdef1234567890"), "abcdef12");
        assert_eq!(short_commit_hash("  abcdef1234567890  "), "abcdef12");
        assert_eq!(short_commit_hash("abc"), "abc");
    }

    #[test]
    fn extract_commit_commit_word() {
        let v = "llama-server version 0.1.0 (commit abcdef1234567890)";
        let c = extract_commit_from_build_version(v).unwrap();
        assert_eq!(c, "abcdef12");
    }

    #[test]
    fn extract_commit_bare_paren_hash() {
        let v = "llama-server 0.1.0 (deadbeef)";
        let c = extract_commit_from_build_version(v).unwrap();
        assert_eq!(c, "deadbeef");
    }

    #[test]
    fn extract_commit_first_hex_ge7() {
        let v = "version 0.1.0 build 1234567890abcdef";
        let c = extract_commit_from_build_version(v).unwrap();
        assert_eq!(c, "12345678");
    }

    #[test]
    fn extract_commit_empty_returns_none() {
        assert!(extract_commit_from_build_version("").is_none());
    }

    #[test]
    fn extract_commit_placeholder_returns_none() {
        // "foundry-artifact" is a placeholder per is_placeholder_build_version
        assert!(extract_commit_from_build_version("foundry-artifact").is_none());
        assert!(extract_commit_from_build_version("unknown").is_none());
    }

    #[test]
    fn extract_commit_realistic_llama_version() {
        let v = "llama.cpp version 0.10.2 (commit 9a8b7c6d5e4f3a2b1c0d)";
        let c = extract_commit_from_build_version(v).unwrap();
        assert_eq!(c, "9a8b7c6d");
    }

    #[test]
    fn commits_match_equal() {
        assert!(commits_match("abcdef12", "abcdef12"));
    }

    #[test]
    fn commits_match_prefix_short_vs_long() {
        assert!(commits_match("abcdef12", "abcdef1234567890"));
        assert!(commits_match("abcdef1234567890", "abcdef12"));
    }

    #[test]
    fn commits_match_empty_is_false() {
        assert!(!commits_match("", "abcdef12"));
        assert!(!commits_match("abcdef12", ""));
    }

    #[test]
    fn commits_match_case_insensitive() {
        assert!(commits_match("ABCDEF12", "abcdef12"));
    }

    #[test]
    fn format_pr_apply_failure_dirty_with_title() {
        let gh = PrMergeState {
            mergeable: Some(false),
            mergeable_state: Some("dirty".into()),
            title: Some("model: add GLM-5-Next".into()),
        };
        let msg = format_pr_apply_failure(
            "27754",
            &gh,
            "Applied patch to 'src/llama-graph.cpp' with conflicts.",
        );
        assert!(msg.contains("PR #27754"));
        assert!(msg.contains("model: add GLM-5-Next"));
        assert!(msg.contains("GitHub: dirty"));
        assert!(msg.contains("Applied patch to 'src/llama-graph.cpp' with conflicts."));
        assert!(msg.contains("Foundry will not auto-resolve"));
    }

    #[test]
    fn format_pr_apply_failure_not_mergeable_no_state() {
        let gh = PrMergeState {
            mergeable: Some(false),
            mergeable_state: None,
            title: None,
        };
        let msg = format_pr_apply_failure("999", &gh, "error: patch does not apply");
        assert!(msg.contains("PR #999"));
        assert!(msg.contains("untitled"));
        assert!(msg.contains("GitHub: not mergeable"));
        assert!(msg.contains("error: patch does not apply"));
    }

    #[test]
    fn format_pr_apply_failure_github_unreachable() {
        // All None = API was down or timed out.
        let gh = PrMergeState::default();
        let msg = format_pr_apply_failure("123", &gh, "conflict in main.cpp");
        assert!(msg.contains("PR #123"));
        assert!(msg.contains("untitled"));
        assert!(msg.contains("local conflict detected"));
        assert!(msg.contains("conflict in main.cpp"));
    }

    #[test]
    fn format_pr_apply_failure_mergeable_true_but_being_built() {
        // GitHub says mergeable=true but state is "behind" (stale check).
        let gh = PrMergeState {
            mergeable: Some(true),
            mergeable_state: Some("behind".into()),
            title: Some("fix: typo".into()),
        };
        let msg = format_pr_apply_failure("42", &gh, "does not apply");
        assert!(msg.contains("GitHub: behind"));
        assert!(msg.contains("fix: typo"));
    }
}
