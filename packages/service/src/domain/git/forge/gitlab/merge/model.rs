//! Wire types for GitLab's merge request, approvals, and merge-train APIs.

use serde::Deserialize;

use super::super::GitLabUser;

#[derive(Deserialize)]
pub(super) struct MergeRequestDetail {
    pub iid: u64,
    pub state: String,
    pub sha: Option<String>,
    pub target_branch: String,
    pub detailed_merge_status: Option<String>,
    #[serde(default)]
    pub merge_when_pipeline_succeeds: bool,
    pub merge_user: Option<GitLabUser>,
    pub force_remove_source_branch: Option<bool>,
    /// The authenticated user's rights on this merge request.
    pub user: Option<ViewerRights>,
    pub source_project_id: Option<u64>,
    pub target_project_id: Option<u64>,
    #[serde(default)]
    pub reviewers: Vec<GitLabUser>,
}

#[derive(Deserialize)]
pub(super) struct ViewerRights {
    #[serde(default)]
    pub can_merge: bool,
}

#[derive(Deserialize)]
pub(super) struct Project {
    pub merge_method: Option<String>,
    pub squash_option: Option<String>,
    /// Absent on GitLab editions without merge trains.
    pub merge_trains_enabled: Option<bool>,
    pub remove_source_branch_after_merge: Option<bool>,
}

#[derive(Deserialize)]
pub(super) struct Approvals {
    pub approvals_required: Option<u32>,
    pub approvals_left: Option<u32>,
    #[serde(default)]
    pub approved_by: Vec<Approval>,
}

#[derive(Deserialize)]
pub(super) struct Approval {
    pub user: GitLabUser,
}

#[derive(Deserialize)]
pub(super) struct ReviewerState {
    pub user: GitLabUser,
    pub state: String,
}

#[derive(Deserialize)]
pub(super) struct MergeTrainEntry {
    pub status: String,
    pub user: Option<GitLabUser>,
    pub merge_request: Option<TrainMergeRequest>,
}

#[derive(Deserialize)]
pub(super) struct TrainMergeRequest {
    pub iid: u64,
}
