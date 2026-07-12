use crate::error::AppError;

#[derive(Debug, sqlx::FromRow)]
pub(super) struct SessionScope {
    pub session_id: i64,
    pub feature_id: i64,
    pub feature_title: String,
    pub project_id: i64,
    pub status: String,
}

pub(super) async fn resolve_session_scope(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<SessionScope, AppError> {
    sqlx::query_as(
        "SELECT s.id AS session_id, f.id AS feature_id, f.title AS feature_title,
                f.project_id, s.status
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("session {session_id}")))
}
