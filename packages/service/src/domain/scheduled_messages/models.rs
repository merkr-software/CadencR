use serde::{Deserialize, Serialize};
use utoipa::ToSchema;

/// A user message queued for future delivery to a conversation (feature).
///
/// `scheduled_at` and `created_at` are serialised as ISO-8601 UTC (the
/// repository formats them with a trailing `Z`) so the frontend can parse them
/// unambiguously and render in the viewer's local timezone.
#[derive(Debug, Clone, Serialize, Deserialize, sqlx::FromRow, ToSchema)]
pub struct ScheduledMessage {
    pub id: i64,
    pub feature_id: i64,
    pub text: String,
    /// ISO-8601 UTC, e.g. `2026-06-21T15:00:00Z`.
    pub scheduled_at: String,
    /// `pending` | `sent` | `failed`.
    pub status: String,
    /// ISO-8601 UTC.
    pub created_at: String,
}

/// Create-or-replace payload. There is at most one pending scheduled message per
/// conversation, so a PUT replaces any existing pending row for that feature.
#[derive(Debug, Deserialize, ToSchema)]
pub struct SetScheduledMessageRequest {
    pub text: String,
    /// Target time as ISO-8601 (UTC). Normalised to SQLite UTC on insert.
    pub scheduled_at: String,
}

#[derive(Debug, Serialize, ToSchema)]
pub struct ScheduledMessageDeleted {
    pub deleted: bool,
}
