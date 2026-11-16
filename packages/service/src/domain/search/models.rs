use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

use crate::domain::features::models::FeatureStatus;

/// One conversation as the command palette searches it: active and archived
/// alike, with just what a result row and its preview name.
#[derive(Debug, Serialize, sqlx::FromRow, ToSchema)]
pub struct ConversationIndexEntry {
    pub id: i64,
    pub project_id: i64,
    pub title: String,
    pub status: FeatureStatus,
    pub label: Option<String>,
    pub is_pinned: bool,
    /// Provider of the latest agent session, else the conversation's setting.
    pub runtime_provider: Option<String>,
    /// Branch recorded for the conversation's worktree, when it has one.
    pub worktree_branch: Option<String>,
    pub created_at: String,
    /// Latest user message across the conversation's sessions, else its creation time.
    pub last_activity_at: String,
    /// When it was archived; `None` for an active conversation.
    pub archived_at: Option<String>,
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct SearchMessagesParams {
    /// Words to find; each one matches as a prefix, all of them must appear.
    pub q: String,
    /// How many conversations to return (1–30, default 8).
    pub limit: Option<i64>,
    /// Restrict the search to one project.
    pub project_id: Option<i64>,
    /// Leave archived conversations out (default: included).
    #[serde(default)]
    pub active_only: bool,
}

/// The most recent message of one conversation that matches the query.
#[derive(Debug, Serialize, sqlx::FromRow, ToSchema)]
pub struct MessageSearchHit {
    pub message_id: i64,
    pub feature_id: i64,
    pub project_id: i64,
    pub feature_title: String,
    pub feature_status: FeatureStatus,
    /// `user` or `assistant`.
    pub role: String,
    /// Text around the match; each matched word is wrapped in U+0002 … U+0003.
    pub snippet: String,
    pub created_at: String,
}
