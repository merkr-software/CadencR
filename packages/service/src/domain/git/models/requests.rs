use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

// ---------------------------------------------------------------------------
// Request types
// ---------------------------------------------------------------------------

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetBranchParams {
    pub project_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetStatsParams {
    pub feature_id: i64,
    #[serde(default = "default_worktree_mode")]
    pub mode: String,
    pub target_branch: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetDiffParams {
    pub feature_id: i64,
    pub mode: String,
    pub commit_sha: Option<String>,
    pub target_branch: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetChangedFilesParams {
    pub feature_id: i64,
    pub mode: String,
    pub commit_sha: Option<String>,
    pub target_branch: Option<String>,
}

/// Per-file unified diff. Mirrors `GetDiffParams` but scoped to a single
/// `file_path`, so the diff pane can fetch each file's patch lazily instead of
/// downloading + parsing the whole working-tree diff as one blob.
#[derive(Debug, Deserialize, ToSchema)]
pub struct GetFileDiffParams {
    pub feature_id: i64,
    pub file_path: String,
    /// Pre-rename path for a rename/copy entry, so the diff can be scoped to
    /// both paths and git's rename detection fires instead of reporting a
    /// whole-file addition.
    pub old_file_path: Option<String>,
    pub mode: String,
    pub commit_sha: Option<String>,
    pub target_branch: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetFileContentParams {
    pub feature_id: i64,
    pub file_path: String,
    pub mode: String,
    pub commit_sha: Option<String>,
    pub target_branch: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "lowercase")]
pub enum DiffImageSide {
    Old,
    New,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetDiffImageParams {
    pub feature_id: i64,
    pub file_path: String,
    pub old_file_path: Option<String>,
    pub side: DiffImageSide,
    pub mode: String,
    pub commit_sha: Option<String>,
    pub target_branch: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetFileContentBatchBody {
    pub feature_id: i64,
    pub file_paths: Vec<String>,
    pub mode: String,
    pub commit_sha: Option<String>,
    pub target_branch: Option<String>,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetCommitLogParams {
    pub feature_id: i64,
    #[serde(default = "default_commit_limit")]
    pub limit: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetCommitGraphParams {
    pub feature_id: i64,
    /// Optional branch ref for a dedicated single-branch graph. When absent,
    /// the graph keeps its default HEAD + target-branch comparison scope.
    pub branch: Option<String>,
    /// Namespace discriminator for `branch`; required whenever `branch` is
    /// present so identically named local and remote refs stay unambiguous.
    pub branch_is_local: Option<bool>,
    #[serde(default)]
    pub skip: i64,
    #[serde(default = "default_graph_limit")]
    pub limit: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetCommitUrlParams {
    pub feature_id: i64,
    pub sha: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetBlameParams {
    pub project_id: i64,
    #[serde(default)]
    pub feature_id: Option<i64>,
    pub file_path: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetFileBlobShasParams {
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetGitPathPrefixParams {
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ListStashesParams {
    pub feature_id: i64,
}

/// Whole-file index mutation. Stage uses `git add -A -- <file_path>`; reset
/// means unstage only and must never change worktree bytes.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct FileMutationBody {
    pub feature_id: i64,
    pub file_path: String,
}

/// Create a stash. A non-blank message is passed to Git; `None` or blank input
/// uses Git's default stash description. Untracked files are opt-in and ignored
/// files are never included.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StashPushBody {
    pub feature_id: i64,
    pub message: Option<String>,
    #[serde(default)]
    pub include_untracked: bool,
}

/// Stable selector for apply, pop, and drop. The backend must re-resolve
/// `ref_name` and reject the mutation if it no longer matches `expected_sha`.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct StashMutationBody {
    pub feature_id: i64,
    pub ref_name: String,
    pub expected_sha: String,
}

/// Bring the configured target ref into the current feature worktree.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct UpdateBranchBody {
    pub feature_id: i64,
    pub strategy: super::UpdateBranchStrategy,
}

/// Continue or abort the merge/rebase currently active in a feature worktree.
#[derive(Debug, Serialize, Deserialize, ToSchema)]
pub struct GitOperationControlBody {
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ListFilesParams {
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct WorktreeInfoParams {
    pub project_id: i64,
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CreateWorktreeBody {
    pub project_id: i64,
    pub feature_id: i64,
    pub feature_title: String,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RemoveWorktreeParams {
    pub project_id: i64,
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DeleteWorktreeParams {
    pub project_id: i64,
    pub feature_id: i64,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RetryWorktreeBody {
    pub project_id: i64,
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ListProjectWorktreesParams {
    pub project_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct ListFeatureWorktreesParams {
    pub project_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct RemoveOrphanWorktreeBody {
    pub project_id: i64,
    pub worktree_path: String,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct GetOriginalBranchParams {
    pub project_id: i64,
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct CheckMergeConflictsParams {
    pub project_id: i64,
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct DeleteFeatureBranchParams {
    pub project_id: i64,
    pub feature_id: i64,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Deserialize, ToSchema)]
pub struct BranchDeleteCheckParams {
    pub project_id: i64,
    pub feature_id: i64,
}

#[derive(Debug, Deserialize, ToSchema)]
#[allow(dead_code)]
pub struct HasUncommittedChangesParams {
    pub project_id: i64,
    pub feature_id: i64,
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

fn default_worktree_mode() -> String {
    "worktree".to_string()
}

fn default_commit_limit() -> i64 {
    20
}

fn default_graph_limit() -> i64 {
    50
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mutation_request_contracts_deserialize_the_frozen_shapes() {
        let file: FileMutationBody = serde_json::from_value(serde_json::json!({
            "feature_id": 7,
            "file_path": "--literal-path"
        }))
        .unwrap();
        assert_eq!(file.feature_id, 7);
        assert_eq!(file.file_path, "--literal-path");

        let unnamed: StashPushBody =
            serde_json::from_value(serde_json::json!({ "feature_id": 7 })).unwrap();
        assert!(unnamed.message.is_none());
        assert!(!unnamed.include_untracked);

        let with_untracked: StashPushBody = serde_json::from_value(serde_json::json!({
            "feature_id": 7,
            "include_untracked": true
        }))
        .unwrap();
        assert!(with_untracked.include_untracked);

        let stash: StashMutationBody = serde_json::from_value(serde_json::json!({
            "feature_id": 7,
            "ref_name": "stash@{1}",
            "expected_sha": "abc123"
        }))
        .unwrap();
        assert_eq!(stash.ref_name, "stash@{1}");
        assert_eq!(stash.expected_sha, "abc123");

        let update: UpdateBranchBody = serde_json::from_value(serde_json::json!({
            "feature_id": 7,
            "strategy": "rebase"
        }))
        .unwrap();
        assert_eq!(update.strategy, super::super::UpdateBranchStrategy::Rebase);

        let control: GitOperationControlBody =
            serde_json::from_value(serde_json::json!({ "feature_id": 7 })).unwrap();
        assert_eq!(control.feature_id, 7);
    }
}
