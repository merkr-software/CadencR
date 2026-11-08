//! Low-level `git merge` invocation, failure inspection, and rollback used by
//! [`super::merge`]. Lives in its own file so the parent stays under the
//! 400-line cap (see `.claude/rules/file-size.md`).
//!
//! Why this exists at all: the shared `run_git*` helpers throw away stdout
//! on failure, while `git merge` often puts its only explanation there.
//! Conflicts are *not* read from that prose: the unmerged index entries and
//! `MERGE_HEAD` are the locale-independent truth, and they also cover
//! modify/delete, rename, and squash conflicts.

use std::fmt;
use std::path::Path;

use super::merge::MergeMode;
use crate::domain::git::commands::unmerged_paths;
use crate::domain::git::models::MergeResult;
use crate::error::AppError;
use crate::shared::git_cli::{
    git_output_error, git_ref_resolves_background, guard_positionals, run_git,
    run_git_output_with_env, run_git_safe_refs,
};

/// Outcome of a single `git merge` invocation. The `Failed` variant carries
/// both streams because git splits its explanation between them.
pub(super) enum MergeOutcome {
    Succeeded,
    Failed { stdout: String, stderr: String },
}

pub(super) async fn invoke_merge(
    repo: &Path,
    source_branch: &str,
    mode: MergeMode,
) -> Result<MergeOutcome, AppError> {
    guard_positionals(&[source_branch])?;
    let mut args: Vec<&str> = Vec::with_capacity(mode.flags().len() + 2);
    args.push("merge");
    args.extend_from_slice(mode.flags());
    args.push(source_branch);

    let output = run_git_output_with_env(&args, repo, &[]).await?;

    if output.status.success() {
        return Ok(MergeOutcome::Succeeded);
    }
    Ok(MergeOutcome::Failed {
        stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
    })
}

/// What a failed `git merge` left behind in the target worktree.
pub(super) struct FailedMergeState {
    pub(super) conflict_files: Vec<String>,
    merge_in_progress: bool,
}

pub(super) async fn inspect_failed_merge(repo: &Path) -> Result<FailedMergeState, AppError> {
    Ok(FailedMergeState {
        conflict_files: unmerged_paths(repo).await?,
        merge_in_progress: git_ref_resolves_background("MERGE_HEAD", repo).await?,
    })
}

/// Undo a half-applied merge. `merge --abort` needs `MERGE_HEAD`; a
/// conflicted `--squash` never writes one, so its unmerged entries are reset
/// with `reset --merge` (what `--abort` runs under the hood). A merge that
/// was refused before starting leaves neither and needs nothing.
pub(super) async fn roll_back_failed_merge(
    repo: &Path,
    state: &FailedMergeState,
) -> Result<(), AppError> {
    if state.merge_in_progress {
        run_git(&["merge", "--abort"], repo).await?;
    } else if !state.conflict_files.is_empty() {
        run_git(&["reset", "--merge"], repo).await?;
    }
    Ok(())
}

/// The target worktree's `HEAD` before the merge switched it, so it can be
/// put back exactly — including a detached `HEAD`, which `rev-parse
/// --abbrev-ref` would report as the useless name `HEAD`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(super) enum OriginalHead {
    Branch(String),
    Detached(String),
}

impl OriginalHead {
    pub(super) fn is_branch(&self, branch: &str) -> bool {
        matches!(self, Self::Branch(name) if name == branch)
    }
}

impl fmt::Display for OriginalHead {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Branch(name) => write!(formatter, "'{name}'"),
            Self::Detached(sha) => write!(formatter, "detached HEAD {sha}"),
        }
    }
}

pub(super) async fn read_original_head(repo: &Path) -> Result<OriginalHead, AppError> {
    let args = ["symbolic-ref", "--quiet", "--short", "HEAD"];
    let output = run_git_output_with_env(&args, repo, &[]).await?;
    if output.status.success() {
        let branch = String::from_utf8_lossy(&output.stdout).trim().to_string();
        return Ok(OriginalHead::Branch(branch));
    }
    if output.status.code() == Some(1) {
        let sha = run_git(&["rev-parse", "--verify", "HEAD"], repo).await?;
        return Ok(OriginalHead::Detached(sha.trim().to_string()));
    }
    Err(git_output_error(&args, &output))
}

pub(super) async fn restore_original_head(
    repo: &Path,
    original: &OriginalHead,
) -> Result<(), AppError> {
    let (flags, target): (&[&str], &str) = match original {
        OriginalHead::Branch(name) => (&[], name),
        OriginalHead::Detached(sha) => (&["--detach"], sha),
    };
    run_git_safe_refs(&["checkout"], flags, &[target], repo).await?;
    Ok(())
}

/// Attach a cleanup problem to the result without hiding the merge outcome:
/// a committed merge keeps `success` and carries a warning, a failed one
/// extends its error.
pub(super) fn attach_cleanup_problem(result: &mut MergeResult, problem: String) {
    let slot = if result.success {
        &mut result.warning
    } else {
        &mut result.error
    };
    *slot = Some(match slot.take() {
        Some(existing) => format!("{existing} {problem}"),
        None => problem,
    });
}

/// Build the user-facing `MergeResult` for a failed merge. Prefers a
/// structured conflict message (a file count; the paths travel in
/// `conflict_files`, which the desktop lists) when the index shows
/// unmerged paths, and falls back to whichever output stream is non-empty —
/// never returning an empty `failed:` tail.
pub(super) fn build_failure_result(
    conflict_files: Vec<String>,
    stdout: &str,
    stderr: &str,
    source_branch: &str,
    target_branch: &str,
) -> MergeResult {
    if !conflict_files.is_empty() {
        let count = conflict_files.len();
        let plural = if count == 1 { "" } else { "s" };
        let message = format!(
            "Merge conflict in {count} file{plural}. Resolve the conflict{plural} in \
             '{target_branch}', commit the result, then try merging '{source_branch}' again.",
        );
        return MergeResult {
            success: false,
            error: Some(message),
            conflict_files: Some(conflict_files),
            warning: None,
        };
    }

    let combined = combine_outputs(stdout, stderr);
    let message = if combined.is_empty() {
        format!("git merge {source_branch} failed with no output — run it manually to see why.")
    } else {
        format!("git merge {source_branch} failed: {combined}")
    };
    MergeResult {
        success: false,
        error: Some(message),
        conflict_files: None,
        warning: None,
    }
}

fn combine_outputs(stdout: &str, stderr: &str) -> String {
    let stdout = stdout.trim();
    let stderr = stderr.trim();
    match (stdout.is_empty(), stderr.is_empty()) {
        (true, true) => String::new(),
        (false, true) => stdout.to_string(),
        (true, false) => stderr.to_string(),
        (false, false) => format!("{stderr} ({stdout})"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_with_conflicts_counts_files_and_is_actionable() {
        let result = build_failure_result(
            vec!["foo.txt".to_string()],
            "CONFLIT (contenu) : Conflit de fusion dans foo.txt\n",
            "",
            "feature/x",
            "main",
        );
        assert!(!result.success);
        let err = result.error.expect("error message");
        assert!(err.starts_with("Merge conflict in 1 file. "), "{err}");
        assert!(err.contains("'main'"), "{err}");
        assert!(err.contains("'feature/x'"), "{err}");
        assert_eq!(
            result.conflict_files.as_deref(),
            Some(&["foo.txt".to_string()][..])
        );
    }

    #[test]
    fn failure_with_conflicts_keeps_paths_out_of_the_sentence() {
        let files = vec!["a/one.rs".to_string(), "b/two.rs".to_string()];
        let result = build_failure_result(files.clone(), "", "", "feature/x", "main");
        let err = result.error.expect("error message");
        assert!(
            err.starts_with("Merge conflict in 2 files. Resolve the conflicts in 'main'"),
            "{err}"
        );
        assert!(!err.contains("one.rs"), "{err}");
        assert_eq!(result.conflict_files, Some(files));
    }

    #[test]
    fn failure_without_output_still_produces_a_message() {
        // Regression: the original bug. Empty stdout + empty stderr used to
        // render `git merge … failed:` with nothing after the colon.
        let result = build_failure_result(vec![], "", "", "feature/x", "main");
        let err = result.error.expect("error message");
        assert!(!err.trim_end().ends_with(':'), "{err}");
        assert!(err.contains("feature/x"), "{err}");
        assert!(result.conflict_files.is_none());
    }

    #[test]
    fn failure_falls_back_to_stderr_when_no_conflicts_present() {
        let result = build_failure_result(
            vec![],
            "",
            "fatal: refusing to merge unrelated histories",
            "feature/x",
            "main",
        );
        let err = result.error.expect("error message");
        assert!(
            err.contains("refusing to merge unrelated histories"),
            "{err}"
        );
        assert!(result.conflict_files.is_none());
    }

    #[test]
    fn combine_outputs_handles_each_empty_combination() {
        assert_eq!(combine_outputs("", ""), "");
        assert_eq!(combine_outputs("out", ""), "out");
        assert_eq!(combine_outputs("", "err"), "err");
        assert_eq!(combine_outputs("out", "err"), "err (out)");
    }

    #[test]
    fn cleanup_problems_warn_on_success_and_extend_failures() {
        let mut merged = MergeResult {
            success: true,
            error: None,
            conflict_files: None,
            warning: None,
        };
        attach_cleanup_problem(&mut merged, "could not switch back".into());
        assert!(merged.success);
        assert!(merged.error.is_none());
        assert_eq!(merged.warning.as_deref(), Some("could not switch back"));

        let mut failed = build_failure_result(vec![], "", "boom", "feature/x", "main");
        attach_cleanup_problem(&mut failed, "abort failed".into());
        let error = failed.error.unwrap();
        assert!(
            error.contains("boom") && error.ends_with("abort failed"),
            "{error}"
        );
        assert!(failed.warning.is_none());
    }
}
