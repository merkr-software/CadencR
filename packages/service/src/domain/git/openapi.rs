use utoipa::OpenApi;

use super::{models, routes};

#[derive(OpenApi)]
#[openapi(
    paths(
        routes::get_branch_handler,
        routes::get_stats_handler,
        routes::get_diff_handler,
        routes::get_file_diff_handler,
        routes::get_changed_files_handler,
        routes::get_file_content_handler,
        routes::get_file_content_batch_handler,
        routes::get_commit_log_handler,
        routes::get_commit_graph_handler,
        routes::get_commit_url_handler,
        routes::get_file_blob_shas_handler,
        routes::list_stashes_handler,
        routes::list_files_handler,
        routes::get_worktree_info_handler,
        routes::create_worktree_handler,
        routes::remove_worktree_handler,
        routes::delete_worktree_handler,
        routes::retry_worktree_setup_handler,
        routes::list_project_worktrees_handler,
        routes::list_feature_worktrees_handler,
        routes::remove_orphan_worktree_handler,
        routes::get_original_branch_handler,
        routes::check_merge_conflicts_handler,
        routes::merge_feature_branch_handler,
        routes::delete_feature_branch_handler,
        routes::check_branch_delete_handler,
        routes::has_uncommitted_changes_handler,
        routes::get_blame_handler,
        routes::list_branches_handler,
        routes::get_git_status_handler,
        routes::get_compare_url_handler,
        super::workflow_service::checkout::checkout_branch_handler,
        super::workflow_service::checkout::validate_checkout_handler,
        routes::update_target_branch_handler,
        routes::commit_handler,
        routes::push_handler,
        routes::push_input_handler,
        routes::stage_file_handler,
        routes::reset_file_handler,
        routes::push_stash_handler,
        routes::apply_stash_handler,
        routes::pop_stash_handler,
        routes::drop_stash_handler,
        routes::update_branch_handler,
        routes::continue_update_branch_handler,
        routes::abort_update_branch_handler,
        routes::get_uncommitted_files_handler,
        super::forge::routes::get_forge_auth_status_handler,
        super::forge::routes::put_forge_token_handler,
        super::forge::routes::delete_forge_token_handler,
        super::forge::routes::get_pr_statuses_handler,
        super::forge::routes::get_pr_handler,
        super::forge::routes::get_pr_comments_handler,
        super::forge::merge_routes::get_pr_merge_status_handler,
        super::forge::merge_routes::post_pr_merge_handler,
        super::forge::merge_routes::delete_pr_merge_handler,
        super::forge::pr_lookup::lookup_feature_repo_pr,
        super::linked_branches::routes::link_feature_branch_handler,
        super::linked_branches::routes::unlink_feature_branch_handler,
    ),
    components(schemas(
        super::linked_branches::ThreadBranch,
        super::linked_branches::BranchOrigin,
        super::linked_branches::routes::FeatureBranchBody,
        models::BranchResponse,
        models::GitStats,
        models::DiffResponse,
        models::ChangedFile,
        models::FileContent,
        models::FileContentBatchItem,
        models::CommitLogEntry,
        models::CommitLogResponse,
        models::CommitGraphEntry,
        models::CommitRef,
        models::CommitRefKind,
        models::CommitGraphResponse,
        models::CommitUrlResponse,
        models::StashEntry,
        models::FileBlobSha,
        models::WorktreeInfo,
        models::ProjectWorktreeInfo,
        models::FeatureWorktreeInfo,
        models::MergeConflictResult,
        models::MergeResult,
        models::OriginalBranchResponse,
        models::SuccessResponse,
        models::CreateWorktreeResponse,
        models::GetFileContentBatchBody,
        models::CreateWorktreeBody,
        models::RetryWorktreeBody,
        models::RemoveOrphanWorktreeBody,
        super::workflow_service::MergeFeatureBranchBody,
        models::HasUncommittedChangesResponse,
        models::BlameLine,
        models::BlameResponse,
        models::BranchInfo,
        models::CompareUrlResponse,
        models::UpdateTargetBranchBody,
        models::CheckoutBody,
        models::CheckoutValidateBody,
        models::CommitBody,
        models::PushBody,
        models::PushForceMode,
        models::PushInputBody,
        models::FileMutationBody,
        models::StashPushBody,
        models::StashMutationBody,
        models::UpdateBranchBody,
        models::GitOperationControlBody,
        models::GitOperationResponse,
        models::UpdateBranchStrategy,
        models::GitOperationKind,
        models::FileStageState,
        models::ConflictKind,
        super::host::GitHost,
        super::git_status::GitStatusSnapshot,
        super::porcelain::UncommittedFile,
        super::forge::PrState,
        super::forge::ReviewState,
        super::forge::ForgeUser,
        super::forge::PrSummary,
        super::forge::CiState,
        super::forge::CiCheck,
        super::forge::CiRollup,
        super::forge::PrComment,
        super::forge::ThreadSide,
        super::forge::CommentThread,
        super::forge::PrCommentsResponse,
        super::forge::PrStatusSnapshot,
        super::forge::BranchPr,
        super::forge::ForgeAuthSource,
        super::forge::ForgeHostConfig,
        super::forge::ForgeAuthStatus,
        super::forge::ForgeTokenRequest,
        super::forge::ForgeTokenDeleteResponse,
        super::forge::merging::MergeMethod,
        super::forge::merging::ReviewerDecision,
        super::forge::merging::PrReviewer,
        super::forge::merging::PrApprovals,
        super::forge::merging::MergeReadiness,
        super::forge::merging::MergeQueueKind,
        super::forge::merging::MergeQueueEntry,
        super::forge::merging::AutoMergeState,
        super::forge::merging::MergeAction,
        super::forge::merging::DeleteSourceBranch,
        super::forge::merging::PrMergeStatus,
        super::forge::merging::PrMergeRequest,
        super::forge::merging::MergeOutcome,
        super::forge::merging::PrMergeResponse,
        super::forge::merging::PrMergeCancelResponse,
    ))
)]
struct GitApiDoc;

pub fn api_doc() -> utoipa::openapi::OpenApi {
    GitApiDoc::openapi()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schema_required<'a>(document: &'a serde_json::Value, schema: &str) -> Vec<&'a str> {
        document["components"]["schemas"]
            .get(schema)
            .unwrap_or_else(|| panic!("missing OpenAPI schema {schema}"))["required"]
            .as_array()
            .unwrap_or_else(|| panic!("OpenAPI schema {schema} has no required array"))
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .unwrap_or_else(|| panic!("non-string required field in {schema}"))
            })
            .collect()
    }

    #[test]
    fn mutation_paths_and_schemas_preserve_the_frozen_contract() {
        let document = serde_json::to_value(api_doc()).unwrap();
        for path in [
            "/api/git/index/stage",
            "/api/git/index/reset",
            "/api/git/stashes/push",
            "/api/git/stashes/apply",
            "/api/git/stashes/pop",
            "/api/git/stashes/drop",
            "/api/git/update-branch",
            "/api/git/update-branch/continue",
            "/api/git/update-branch/abort",
        ] {
            assert!(document["paths"][path]["post"].is_object(), "{path}");
        }

        assert_eq!(
            schema_required(&document, "FileMutationBody"),
            ["feature_id", "file_path"]
        );
        assert_eq!(
            schema_required(&document, "StashMutationBody"),
            ["feature_id", "ref_name", "expected_sha"]
        );
        assert_eq!(schema_required(&document, "StashPushBody"), ["feature_id"]);
        assert_eq!(
            schema_required(&document, "GitOperationControlBody"),
            ["feature_id"]
        );
    }

    #[test]
    fn omitted_status_defaults_remain_optional_in_openapi() {
        let document = serde_json::to_value(api_doc()).unwrap();
        let required = schema_required(&document, "GitStatusSnapshot");
        for field in [
            "behind_target",
            "target_resolved",
            "update_target_branch",
            "ahead_of_update_target",
            "behind_update_target",
            "update_target_resolved",
            "conflict_count",
            "operation",
            "shared_with",
        ] {
            assert!(!required.contains(&field), "{field} must stay optional");
        }
    }
}
