mod lock_recovery;

use std::path::Path;

use crate::domain::git::commands::unmerged_paths;
use crate::domain::git::models::{GitOperationKind, GitOperationResponse, UpdateBranchStrategy};
use crate::error::AppError;
use crate::shared::git_cli::{git_output_error, guard_positionals, run_git_output_with_env};

use super::operation::detect_active_git_operation;
use lock_recovery::invoke_with_index_lock_recovery;

pub(super) async fn start(
    worktree: &Path,
    strategy: UpdateBranchStrategy,
    target: &str,
) -> Result<GitOperationResponse, AppError> {
    guard_positionals(&[target])?;
    let (args, expected) = match strategy {
        UpdateBranchStrategy::Rebase => (vec!["rebase", target], GitOperationKind::Rebase),
        UpdateBranchStrategy::Merge => {
            (vec!["merge", "--no-edit", target], GitOperationKind::Merge)
        }
    };
    run_recoverable(worktree, &args, expected).await
}

pub(super) async fn continue_operation(
    worktree: &Path,
    operation: GitOperationKind,
) -> Result<GitOperationResponse, AppError> {
    let args = control_args(operation, "--continue");
    run_recoverable(worktree, &args, operation).await
}

pub(super) async fn abort(
    worktree: &Path,
    operation: GitOperationKind,
) -> Result<GitOperationResponse, AppError> {
    let args = control_args(operation, "--abort");
    let output = invoke(worktree, &args).await?;
    if !output.status.success() {
        return Err(git_output_error(&args, &output));
    }
    Ok(GitOperationResponse::Completed)
}

async fn run_recoverable(
    worktree: &Path,
    args: &[&str],
    expected: GitOperationKind,
) -> Result<GitOperationResponse, AppError> {
    let (invoked_args, output) = invoke_with_index_lock_recovery(worktree, args, expected).await?;
    if output.status.success() {
        return Ok(GitOperationResponse::Completed);
    }

    let primary = git_output_error(&invoked_args, &output);
    let active = detect_active_git_operation(worktree)
        .await
        .map_err(|inspection| inspection_error(&primary, inspection))?;
    if active != Some(expected) {
        return Err(primary);
    }
    let conflict_files = unmerged_paths(worktree)
        .await
        .map_err(|inspection| inspection_error(&primary, inspection))?;
    if !conflict_files.is_empty() {
        return Ok(GitOperationResponse::Conflicts { conflict_files });
    }
    Err(primary)
}

fn control_args(operation: GitOperationKind, action: &'static str) -> [&'static str; 2] {
    [super::operation_name(operation), action]
}

async fn invoke(worktree: &Path, args: &[&str]) -> Result<std::process::Output, AppError> {
    run_git_output_with_env(
        args,
        worktree,
        &[("GIT_EDITOR", "true"), ("GIT_SEQUENCE_EDITOR", "true")],
    )
    .await
}

#[track_caller]
fn inspection_error(primary: &AppError, inspection: AppError) -> AppError {
    AppError::git_command(format!(
        "{primary}; conflict-state inspection also failed: {inspection}"
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::git_status::compute_status_or_empty;
    use crate::domain::git::models::FileMutationBody;
    use crate::domain::git::workflow_service::index as index_service;
    use crate::domain::git::workflow_service::update_branch::test_support::RepoFixture;
    use crate::error::AppError;

    #[tokio::test]
    async fn merge_conflicts_are_returned_and_left_active() {
        let fixture = RepoFixture::new();
        fixture.create_conflicting_histories();

        let response = start(&fixture.feature, UpdateBranchStrategy::Merge, "main")
            .await
            .unwrap();

        assert_eq!(
            response,
            GitOperationResponse::Conflicts {
                conflict_files: vec!["conflict.txt".into()]
            }
        );
        assert_eq!(
            detect_active_git_operation(&fixture.feature).await.unwrap(),
            Some(GitOperationKind::Merge)
        );
    }

    #[tokio::test]
    async fn merge_continue_and_abort_use_the_active_operation() {
        let fixture = RepoFixture::new();
        fixture.create_conflicting_histories();
        assert!(matches!(
            start(&fixture.feature, UpdateBranchStrategy::Merge, "main")
                .await
                .unwrap(),
            GitOperationResponse::Conflicts { .. }
        ));
        fixture.write_feature("conflict.txt", "resolved\n");
        fixture.git_feature(&["add", "conflict.txt"]);

        assert_eq!(
            continue_operation(&fixture.feature, GitOperationKind::Merge)
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );
        assert_eq!(
            detect_active_git_operation(&fixture.feature).await.unwrap(),
            None
        );

        let abort_fixture = RepoFixture::new();
        abort_fixture.create_conflicting_histories();
        assert!(matches!(
            start(&abort_fixture.feature, UpdateBranchStrategy::Merge, "main")
                .await
                .unwrap(),
            GitOperationResponse::Conflicts { .. }
        ));
        assert_eq!(
            abort(&abort_fixture.feature, GitOperationKind::Merge)
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );
        assert_eq!(
            detect_active_git_operation(&abort_fixture.feature)
                .await
                .unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn reset_rejection_preserves_merge_conflicts_and_blocks_continue() {
        assert_reset_rejection_preserves_conflict(
            UpdateBranchStrategy::Merge,
            GitOperationKind::Merge,
        )
        .await;
    }

    #[tokio::test]
    async fn reset_rejection_preserves_rebase_conflicts_and_blocks_continue() {
        assert_reset_rejection_preserves_conflict(
            UpdateBranchStrategy::Rebase,
            GitOperationKind::Rebase,
        )
        .await;
    }

    async fn assert_reset_rejection_preserves_conflict(
        strategy: UpdateBranchStrategy,
        operation: GitOperationKind,
    ) {
        let fixture = RepoFixture::new();
        fixture.create_conflicting_histories();
        assert!(matches!(
            start(&fixture.feature, strategy, "main").await.unwrap(),
            GitOperationResponse::Conflicts { .. }
        ));
        let marker_bytes = std::fs::read(fixture.feature.join("conflict.txt")).unwrap();
        assert!(
            marker_bytes
                .windows(b"<<<<<<<".len())
                .any(|bytes| bytes == b"<<<<<<<"),
            "{strategy:?} must begin with conflict markers"
        );
        let index_before = fixture
            .git_output_feature(&["ls-files", "--stage", "--", "conflict.txt"])
            .stdout;
        let status_before = compute_status_or_empty(&fixture.feature, 1, "main")
            .await
            .unwrap();
        assert_eq!(status_before.conflict_count, 1, "{strategy:?}");
        assert_eq!(status_before.operation, Some(operation), "{strategy:?}");
        let state = fixture.state("main").await;

        let error = index_service::reset_file(
            &state,
            FileMutationBody {
                feature_id: 1,
                file_path: "conflict.txt".into(),
            },
        )
        .await
        .unwrap_err();

        let AppError::BadRequest(message) = error else {
            panic!("expected BadRequest for {strategy:?}");
        };
        assert!(message.contains("resolve the conflict"), "{message}");
        assert!(message.contains("stage the resolution"), "{message}");
        assert_eq!(
            fixture
                .git_output_feature(&["ls-files", "--stage", "--", "conflict.txt"])
                .stdout,
            index_before,
            "{strategy:?} unmerged index entries changed"
        );
        assert_eq!(
            std::fs::read(fixture.feature.join("conflict.txt")).unwrap(),
            marker_bytes,
            "{strategy:?} worktree bytes changed"
        );
        let status_after = compute_status_or_empty(&fixture.feature, 1, "main")
            .await
            .unwrap();
        assert_eq!(status_after.conflict_count, 1, "{strategy:?}");
        assert_eq!(status_after.operation, Some(operation), "{strategy:?}");

        assert!(matches!(
            continue_operation(&fixture.feature, operation)
                .await
                .unwrap(),
            GitOperationResponse::Conflicts { .. }
        ));
        let status_after_continue = compute_status_or_empty(&fixture.feature, 1, "main")
            .await
            .unwrap();
        assert_eq!(status_after_continue.conflict_count, 1, "{strategy:?}");
        assert_eq!(
            status_after_continue.operation,
            Some(operation),
            "{strategy:?}"
        );
    }

    #[tokio::test]
    async fn rebase_can_conflict_again_on_a_later_commit_then_continue() {
        let fixture = RepoFixture::new();
        fixture.create_two_commit_rebase_conflict();

        assert!(matches!(
            start(&fixture.feature, UpdateBranchStrategy::Rebase, "main")
                .await
                .unwrap(),
            GitOperationResponse::Conflicts { .. }
        ));
        fixture.write_feature("first.txt", "resolved first\n");
        fixture.git_feature(&["add", "first.txt"]);
        let second = continue_operation(&fixture.feature, GitOperationKind::Rebase)
            .await
            .unwrap();
        assert_eq!(
            second,
            GitOperationResponse::Conflicts {
                conflict_files: vec!["second.txt".into()]
            }
        );

        fixture.write_feature("second.txt", "resolved second\n");
        fixture.git_feature(&["add", "second.txt"]);
        assert_eq!(
            continue_operation(&fixture.feature, GitOperationKind::Rebase)
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );
    }

    #[tokio::test]
    async fn rebase_abort_restores_the_feature_tip() {
        let fixture = RepoFixture::new();
        fixture.create_conflicting_histories();
        let before = fixture.rev_parse_feature("feature/test");
        assert!(matches!(
            start(&fixture.feature, UpdateBranchStrategy::Rebase, "main")
                .await
                .unwrap(),
            GitOperationResponse::Conflicts { .. }
        ));

        abort(&fixture.feature, GitOperationKind::Rebase)
            .await
            .unwrap();

        assert_eq!(fixture.rev_parse_feature("HEAD"), before);
        assert_eq!(
            detect_active_git_operation(&fixture.feature).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn continue_overrides_hostile_editor_configuration() {
        let fixture = RepoFixture::new();
        fixture.create_conflicting_histories();
        let marker = fixture.root.path().join("editor-ran");
        let editor = format!("touch {}; exit 1", marker.display());
        fixture.git_feature(&["config", "core.editor", &editor]);
        fixture.git_feature(&["config", "sequence.editor", &editor]);
        assert!(matches!(
            start(&fixture.feature, UpdateBranchStrategy::Rebase, "main")
                .await
                .unwrap(),
            GitOperationResponse::Conflicts { .. }
        ));
        fixture.write_feature("conflict.txt", "resolved\n");
        fixture.git_feature(&["add", "conflict.txt"]);

        let response = continue_operation(&fixture.feature, GitOperationKind::Rebase)
            .await
            .unwrap();

        assert_eq!(response, GitOperationResponse::Completed);
        assert!(!marker.exists(), "configured editor must not run");
    }
}
