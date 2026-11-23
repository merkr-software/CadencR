//! `GET /api/git/branches` — the searchable list backing the branch picker.

use std::collections::HashMap;
use std::path::Path;

use crate::app_state::AppState;
use crate::domain::git::commands;
use crate::domain::git::models::{BranchInfo, ListBranchesParams};
use crate::domain::git::repository;
use crate::error::AppError;
use crate::shared::git_cli::run_git;

pub async fn list_branches(
    state: &AppState,
    params: ListBranchesParams,
) -> Result<Vec<BranchInfo>, AppError> {
    let project_path = repository::get_project_path(&state.read_pool, params.project_id).await?;
    let repo = Path::new(&project_path);

    if !crate::shared::git_context::has_git_metadata(repo).await? {
        return Ok(vec![]);
    }

    // Two separate calls — `git branch -a --format=%(refname:short)` mixes
    // locals and remote-tracking refs into the same column, which breaks
    // dedupe when a local branch contains a `/` (e.g. `feat/a` vs the remote
    // `origin/feat/a`). `for-each-ref` filtered to a specific scope keeps
    // them sortable.
    let local_raw = run_git(
        &["for-each-ref", "--format=%(refname:short)", "refs/heads"],
        repo,
    )
    .await?;
    let remote_raw = run_git(
        &["for-each-ref", "--format=%(refname:short)", "refs/remotes"],
        repo,
    )
    .await?;

    let lookup =
        repository::get_worktree_feature_lookup(&state.read_pool, params.project_id).await?;
    let path_to_feature: HashMap<String, i64> = lookup
        .iter()
        .map(|row| (row.worktree_path.clone(), row.feature_id))
        .collect();
    let attached = collect_branch_attachments(repo, &path_to_feature).await?;

    Ok(parse_branches(&local_raw, &remote_raw, &attached))
}

/// Join the result of `commands::list_worktree_branches` (the *single* parser
/// for `git worktree list --porcelain` in the codebase) with the feature
/// lookup. A worktree listing Git cannot produce fails the request: an empty
/// join would show every checked-out branch as free to check out.
///
/// `attached_worktree_path` is set for **every** branch that git reports as
/// attached to a worktree, regardless of whether Cadencr knows about that
/// worktree. The `feature_id` is opt-in (`Some` when the worktree is one of
/// our features, `None` for vanilla `git worktree add`s the user made
/// themselves). The frontend uses the path to render the "has worktree" icon
/// and the optional feature id for the "in use by feature #N" caption.
async fn collect_branch_attachments(
    project_path: &Path,
    path_to_feature: &HashMap<String, i64>,
) -> Result<HashMap<String, (String, Option<i64>)>, AppError> {
    let attachments = commands::list_worktree_branches(project_path).await?;
    Ok(attachments
        .into_iter()
        .map(|(branch, path)| {
            let path_str = path.to_string_lossy().into_owned();
            let feature_id = path_to_feature.get(&path_str).copied();
            (branch, (path_str, feature_id))
        })
        .collect())
}

/// Build the picker list. Local and remote-tracking refs are emitted as
/// **separate, independently selectable entries** — the user picks which one
/// they want as a target (e.g. local `main` vs `origin/main`), and the rest
/// of the system honors that choice verbatim. This is intentional: a stale
/// local `main` and a fresh `origin/main` produce different ahead-of-target
/// counts and different commit logs, and only the user knows which truth
/// they care about for the current work.
///
/// Names are kept in their git-ref form so they can be passed straight to
/// `git rev-parse`, `git log`, etc.: `main` for locals, `origin/main` for
/// remote-tracking. We still drop `origin/HEAD`-style indirection rows
/// because they're aliases, not branches.
///
/// Order: locals first, alphabetical; then remote-tracking refs,
/// alphabetical. Stable so the picker's keyboard navigation feels
/// predictable across reloads.
fn parse_branches(
    local_raw: &str,
    remote_raw: &str,
    attached: &HashMap<String, (String, Option<i64>)>,
) -> Vec<BranchInfo> {
    let mut locals: Vec<String> = local_raw
        .lines()
        .map(str::trim)
        .filter(|n| !n.is_empty())
        .map(String::from)
        .collect();
    locals.sort();
    locals.dedup();

    let mut remotes: Vec<String> = remote_raw
        .lines()
        .map(str::trim)
        .filter_map(parse_remote_ref)
        .collect();
    remotes.sort();
    remotes.dedup();

    let mut out: Vec<BranchInfo> = Vec::with_capacity(locals.len().saturating_add(remotes.len()));
    for name in locals {
        let attach = attached.get(&name);
        out.push(BranchInfo {
            name: name.clone(),
            is_local: true,
            attached_worktree_path: attach.map(|(p, _)| p.clone()),
            attached_feature_id: attach.and_then(|(_, id)| *id),
        });
    }
    for name in remotes {
        out.push(BranchInfo {
            name,
            is_local: false,
            // Remote-tracking refs aren't checked out into worktrees; the
            // attachment join only ever matches local branch names.
            attached_worktree_path: None,
            attached_feature_id: None,
        });
    }
    out
}

/// Filter and normalize a single line from `for-each-ref refs/remotes`.
/// Returns `Some(full_ref_shortname)` (e.g. `origin/main`) when the line is
/// a real remote-tracking branch; `None` for `HEAD ->` indirection rows,
/// the bare `<remote>/HEAD` ref, and empty lines.
fn parse_remote_ref(line: &str) -> Option<String> {
    if line.is_empty() || line.contains("HEAD ->") {
        return None;
    }
    let (_remote, branch) = line.split_once('/')?;
    if branch == "HEAD" || branch.is_empty() {
        return None;
    }
    Some(line.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_local_and_remote_tracking_as_separate_entries() {
        // The whole point of this change: `main` and `origin/main` are two
        // independent picks. Stale local `main` and fresh `origin/main` give
        // different ahead-of-target counts, and only the user knows which
        // they want.
        let local = "main\nfeature/x\n";
        let remote = "origin/HEAD -> origin/main\norigin/main\norigin/release\n";
        let out = parse_branches(local, remote, &HashMap::new());
        let names: Vec<&str> = out.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"main"), "local main must be present");
        assert!(
            names.contains(&"origin/main"),
            "remote-tracking origin/main must be present alongside local main"
        );
        assert!(names.contains(&"feature/x"));
        assert!(names.contains(&"origin/release"));
        // Local stays local, remote stays remote — no merging.
        let main = out.iter().find(|b| b.name == "main").unwrap();
        assert!(main.is_local);
        let origin_main = out.iter().find(|b| b.name == "origin/main").unwrap();
        assert!(!origin_main.is_local);
    }

    #[test]
    fn marks_attached_branch_with_feature_id() {
        let local = "feat/a\n";
        let mut attached = HashMap::new();
        attached.insert("feat/a".to_string(), ("/tmp/wt".to_string(), Some(42)));
        let out = parse_branches(local, "", &attached);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].name, "feat/a");
        assert!(out[0].is_local);
        assert_eq!(out[0].attached_feature_id, Some(42));
        assert_eq!(out[0].attached_worktree_path.as_deref(), Some("/tmp/wt"));
    }

    #[test]
    fn marks_attached_branch_without_feature_id() {
        // Branch is checked out in a worktree git knows about, but Cadencr
        // does not (e.g. the user ran `git worktree add` themselves). The
        // path still surfaces so the picker can render the "has worktree"
        // icon — only the feature id is absent.
        let local = "feat/manual\n";
        let mut attached = HashMap::new();
        attached.insert(
            "feat/manual".to_string(),
            ("/tmp/manual-wt".to_string(), None),
        );
        let out = parse_branches(local, "", &attached);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].attached_feature_id, None);
        assert_eq!(
            out[0].attached_worktree_path.as_deref(),
            Some("/tmp/manual-wt"),
        );
    }

    #[test]
    fn skips_origin_head_indirection() {
        // The `origin/HEAD -> origin/main` row is an alias and `origin/HEAD`
        // is a symbolic ref, neither belongs in the picker. Real
        // `origin/main` still surfaces from the standalone row.
        let local = "main\n";
        let remote = "origin/HEAD -> origin/main\norigin/main\n";
        let out = parse_branches(local, remote, &HashMap::new());
        let names: Vec<&str> = out.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"main"));
        assert!(names.contains(&"origin/main"));
        assert!(
            !names.contains(&"origin/HEAD"),
            "the HEAD alias must not appear as a selectable entry"
        );
    }

    #[test]
    fn handles_branch_names_with_slashes() {
        // Local `feat/a` and remote `origin/feat/a` are now both present
        // and trivially distinguishable by the `origin/` prefix on the
        // remote-tracking ref name.
        let local = "feat/a\nfeat/b\n";
        let remote = "origin/feat/a\norigin/feat/c\n";
        let out = parse_branches(local, remote, &HashMap::new());
        let names: Vec<&str> = out.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"feat/a"));
        assert!(names.contains(&"feat/b"));
        assert!(names.contains(&"origin/feat/a"));
        assert!(names.contains(&"origin/feat/c"));
        let a_local = out.iter().find(|b| b.name == "feat/a").unwrap();
        assert!(a_local.is_local);
        let a_remote = out.iter().find(|b| b.name == "origin/feat/a").unwrap();
        assert!(!a_remote.is_local);
    }

    #[test]
    fn keeps_locals_first_then_remotes() {
        // The picker's keyboard navigation feels predictable when the order
        // is stable and locals (the user's own working set) are surfaced
        // first.
        let local = "zzz\naaa\n";
        let remote = "origin/zzz\norigin/aaa\n";
        let out = parse_branches(local, remote, &HashMap::new());
        let names: Vec<&str> = out.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(
            names,
            vec!["aaa", "zzz", "origin/aaa", "origin/zzz"],
            "locals (sorted) must come before remote-tracking refs (sorted)"
        );
    }
}
