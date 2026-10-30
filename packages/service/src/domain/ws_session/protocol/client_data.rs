use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HistoryGetPayload {
    pub project_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct HistoryAddPayload {
    pub project_id: i64,
    pub content: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DraftGetPayload {
    pub session_id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct DraftSavePayload {
    pub session_id: i64,
    pub draft: Option<String>,
}

/// Inbound payload shared by `branch.rewind` and `branch.fork`.
#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct BranchPayload {
    pub session_id: String,
    pub message_id: i64,
    /// Rewind only: the user has acknowledged that uncommitted changes since the
    /// checkpoint will be discarded. Ignored by fork.
    #[serde(default)]
    pub confirm_discard: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, ToSchema)]
pub struct RetryWorktreeSetupPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    pub feature_id: i64,
}
