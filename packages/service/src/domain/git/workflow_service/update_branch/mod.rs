mod operation;
mod preconditions;
mod runner;

use crate::app_state::AppState;
use crate::domain::git::models::{
    GitOperationControlBody, GitOperationKind, GitOperationResponse, UpdateBranchBody,
};
use crate::error::AppError;

use self::preconditions::{
    attached_head_ref, mutation_error, require_clean_worktree, require_no_active_operation,
    resolve_feature_update_path, validate_target,
};
use super::{broadcast_after_write_at, resolve_target_branch};

pub use operation::detect_active_git_operation;
pub(crate) use preconditions::{resolve_configured_update_target, resolve_update_target};

/// Bring the configured target ref into the feature's current Git checkout.
/// This may be a configured linked worktree or the project's primary checkout;
/// unlike finish-branch merge, it never checks out or mutates the target ref.
pub async fn update_branch(
    state: &AppState,
    body: UpdateBranchBody,
) -> Result<GitOperationResponse, AppError> {
    let feature_id = body.feature_id;
    let worktree = resolve_feature_update_path(state, feature_id).await?;
    let permit = state
        .git_mutations
        .try_acquire(&worktree)
        .map_err(|error| mutation_error(error))?;
    let worktree = permit.worktree_path().to_path_buf();

    require_no_active_operation(&worktree).await?;
    let current_ref = attached_head_ref(&worktree).await?;
    require_clean_worktree(&worktree).await?;
    let configured_target = resolve_target_branch(state, feature_id, &worktree).await?;
    let target = resolve_update_target(&worktree, &current_ref, &configured_target).await?;
    validate_target(&worktree, &current_ref, &target).await?;

    let result = runner::start(&worktree, body.strategy, &target).await;
    drop(permit);
    broadcast_after_write_at(state, &worktree).await;
    result
}

pub async fn continue_update_branch(
    state: &AppState,
    body: GitOperationControlBody,
) -> Result<GitOperationResponse, AppError> {
    control_operation(state, body.feature_id, ControlAction::Continue).await
}

pub async fn abort_update_branch(
    state: &AppState,
    body: GitOperationControlBody,
) -> Result<GitOperationResponse, AppError> {
    control_operation(state, body.feature_id, ControlAction::Abort).await
}

#[derive(Clone, Copy)]
enum ControlAction {
    Continue,
    Abort,
}

async fn control_operation(
    state: &AppState,
    feature_id: i64,
    action: ControlAction,
) -> Result<GitOperationResponse, AppError> {
    let worktree = resolve_feature_update_path(state, feature_id).await?;
    let permit = state
        .git_mutations
        .try_acquire(&worktree)
        .map_err(|error| mutation_error(error))?;
    let worktree = permit.worktree_path().to_path_buf();
    let operation = detect_active_git_operation(&worktree)
        .await?
        .ok_or_else(|| AppError::BadRequest("no merge or rebase is active".into()))?;

    let result = match action {
        ControlAction::Continue => runner::continue_operation(&worktree, operation).await,
        ControlAction::Abort => runner::abort(&worktree, operation).await,
    };
    drop(permit);
    broadcast_after_write_at(state, &worktree).await;
    result
}

fn operation_name(operation: GitOperationKind) -> &'static str {
    match operation {
        GitOperationKind::Merge => "merge",
        GitOperationKind::Rebase => "rebase",
    }
}

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::git::models::UpdateBranchStrategy;
    use test_support::RepoFixture;

    fn update_body(strategy: UpdateBranchStrategy) -> UpdateBranchBody {
        UpdateBranchBody {
            feature_id: 1,
            strategy,
        }
    }

    #[tokio::test]
    async fn behind_only_merge_and_rebase_complete_in_the_feature_worktree() {
        for strategy in [UpdateBranchStrategy::Merge, UpdateBranchStrategy::Rebase] {
            let fixture = RepoFixture::new();
            fixture.commit_main_file("target.txt", "target\n", "target");
            let state = fixture.state("main").await;

            let response = update_branch(&state, update_body(strategy)).await.unwrap();

            assert_eq!(response, GitOperationResponse::Completed);
            assert_eq!(
                fixture.rev_parse_feature("HEAD"),
                fixture.rev_parse_project("main")
            );
        }
    }

    #[tokio::test]
    async fn divergent_merge_and_rebase_preserve_both_histories() {
        for strategy in [UpdateBranchStrategy::Merge, UpdateBranchStrategy::Rebase] {
            let fixture = RepoFixture::new();
            fixture.commit_feature_file("feature.txt", "feature\n", "feature");
            fixture.commit_main_file("target.txt", "target\n", "target");
            let state = fixture.state("main").await;

            assert_eq!(
                update_branch(&state, update_body(strategy)).await.unwrap(),
                GitOperationResponse::Completed
            );
            assert!(fixture.feature.join("feature.txt").exists());
            assert!(fixture.feature.join("target.txt").exists());
            fixture.assert_feature_ancestor("main");
        }
    }

    #[tokio::test]
    async fn update_never_checks_out_or_mutates_the_target_worktree() {
        let fixture = RepoFixture::new();
        fixture.commit_feature_file("feature.txt", "feature\n", "feature");
        fixture.commit_main_file("target.txt", "target\n", "target");
        let target_head = fixture.rev_parse_project("HEAD");
        let state = fixture.state("main").await;

        update_branch(&state, update_body(UpdateBranchStrategy::Merge))
            .await
            .unwrap();

        assert_eq!(fixture.rev_parse_project("HEAD"), target_head);
        assert_eq!(fixture.project_status(), "");
    }

    #[tokio::test]
    async fn configured_local_and_remote_tracking_targets_keep_exact_identity() {
        let remote_fixture = RepoFixture::new();
        remote_fixture.create_remote_only_tip();
        let remote_state = remote_fixture.state("origin/main").await;
        update_branch(&remote_state, update_body(UpdateBranchStrategy::Rebase))
            .await
            .unwrap();
        assert!(remote_fixture.feature.join("remote-only.txt").exists());
        assert_ne!(
            remote_fixture.rev_parse_feature("origin/main"),
            remote_fixture.rev_parse_feature("main")
        );

        let local_fixture = RepoFixture::new();
        local_fixture.create_remote_only_tip();
        let local_state = local_fixture.state("main").await;
        update_branch(&local_state, update_body(UpdateBranchStrategy::Rebase))
            .await
            .unwrap();
        assert!(!local_fixture.feature.join("remote-only.txt").exists());
    }

    #[tokio::test]
    async fn current_branch_can_update_from_its_incoming_upstream() {
        let fixture = RepoFixture::new();
        fixture.create_current_branch_remote_only_tip();
        let state = fixture.state("feature/test").await;

        assert_eq!(
            update_branch(&state, update_body(UpdateBranchStrategy::Rebase))
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );
        assert!(fixture.feature.join("upstream-only.txt").exists());
        assert_eq!(
            fixture.rev_parse_feature("HEAD"),
            fixture.rev_parse_feature("origin/feature/test")
        );
    }

    #[tokio::test]
    async fn local_configured_target_uses_its_incoming_upstream() {
        let fixture = RepoFixture::new();
        fixture.create_tracked_target_remote_only_tip();
        let state = fixture.state("main").await;

        assert_eq!(
            update_branch(&state, update_body(UpdateBranchStrategy::Rebase))
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );
        assert!(fixture.feature.join("remote-only.txt").exists());
        assert_eq!(
            fixture.rev_parse_feature("HEAD"),
            fixture.rev_parse_feature("origin/main")
        );
    }

    #[tokio::test]
    async fn local_target_ahead_of_upstream_keeps_its_local_commits() {
        let fixture = RepoFixture::new();
        fixture.create_tracked_target_remote_only_tip();
        fixture.git_project(&["reset", "--hard", "origin/main"]);
        fixture.commit_main_file("local-only.txt", "local\n", "local-only");
        let state = fixture.state("main").await;

        assert_eq!(
            update_branch(&state, update_body(UpdateBranchStrategy::Rebase))
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );
        assert!(fixture.feature.join("remote-only.txt").exists());
        assert!(fixture.feature.join("local-only.txt").exists());
        assert_eq!(
            fixture.rev_parse_feature("HEAD"),
            fixture.rev_parse_feature("main")
        );
    }

    #[tokio::test]
    async fn no_worktree_feature_updates_the_project_checkout() {
        let fixture = RepoFixture::new();
        fixture.create_remote_only_tip();
        let state = fixture.state_without_worktree("origin/main").await;

        assert_eq!(
            update_branch(&state, update_body(UpdateBranchStrategy::Rebase))
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );
        assert!(fixture.project.join("remote-only.txt").exists());
        assert_eq!(
            fixture.rev_parse_project("HEAD"),
            fixture.rev_parse_project("origin/main")
        );
    }

    #[tokio::test]
    async fn no_worktree_feature_can_recover_a_project_checkout_rebase() {
        let fixture = RepoFixture::new();
        fixture.git_project(&["checkout", "-q", "-b", "local-target"]);
        fixture.commit_main_file("conflict.txt", "target\n", "target conflict");
        fixture.git_project(&["checkout", "-q", "main"]);
        fixture.commit_main_file("conflict.txt", "current\n", "current conflict");
        let before = fixture.rev_parse_project("HEAD");
        let state = fixture.state_without_worktree("local-target").await;

        assert!(matches!(
            update_branch(&state, update_body(UpdateBranchStrategy::Rebase))
                .await
                .unwrap(),
            GitOperationResponse::Conflicts { .. }
        ));
        assert_eq!(
            abort_update_branch(&state, GitOperationControlBody { feature_id: 1 })
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );
        assert_eq!(fixture.rev_parse_project("HEAD"), before);
        assert_eq!(
            detect_active_git_operation(&fixture.project).await.unwrap(),
            None
        );
    }

    #[tokio::test]
    async fn mutation_guard_rejects_a_second_update_for_the_same_worktree() {
        let fixture = RepoFixture::new();
        let state = fixture.state("main").await;
        let _permit = state.git_mutations.try_acquire(&fixture.feature).unwrap();

        let error = update_branch(&state, update_body(UpdateBranchStrategy::Merge))
            .await
            .unwrap_err();

        assert!(matches!(error, AppError::Conflict(_)), "{error:?}");
    }

    #[tokio::test]
    async fn public_continue_and_abort_follow_the_detected_operation() {
        let fixture = RepoFixture::new();
        fixture.create_conflicting_histories();
        let state = fixture.state("main").await;
        let response = update_branch(&state, update_body(UpdateBranchStrategy::Merge))
            .await
            .unwrap();
        assert!(matches!(response, GitOperationResponse::Conflicts { .. }));
        fixture.write_feature("conflict.txt", "resolved\n");
        fixture.git_feature(&["add", "conflict.txt"]);
        assert_eq!(
            continue_update_branch(&state, GitOperationControlBody { feature_id: 1 })
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );

        let abort_fixture = RepoFixture::new();
        abort_fixture.create_conflicting_histories();
        let abort_state = abort_fixture.state("main").await;
        assert!(matches!(
            update_branch(&abort_state, update_body(UpdateBranchStrategy::Rebase))
                .await
                .unwrap(),
            GitOperationResponse::Conflicts { .. }
        ));
        assert_eq!(
            abort_update_branch(&abort_state, GitOperationControlBody { feature_id: 1 })
                .await
                .unwrap(),
            GitOperationResponse::Completed
        );
    }
}
