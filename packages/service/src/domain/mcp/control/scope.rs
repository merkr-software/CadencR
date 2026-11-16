use crate::domain::session_status::{derive_status_from_db, AgentStatus, DbStatusInputs};
use crate::error::AppError;

#[derive(Debug, sqlx::FromRow)]
pub(super) struct SessionScope {
    pub session_id: i64,
    pub feature_id: i64,
    pub feature_title: String,
    pub project_id: i64,
    pub status: String,
    pub pending_permission: Option<String>,
    pub pending_questions: Option<String>,
}

impl SessionScope {
    pub(super) fn is_active(&self) -> bool {
        is_active_db_state(
            &self.status,
            self.pending_permission.is_some(),
            self.pending_questions.is_some(),
        )
    }
}

pub(crate) fn is_active_db_state(
    status_col: &str,
    pending_permission: bool,
    pending_question: bool,
) -> bool {
    if matches!(
        status_col,
        "awaiting_permission"
            | "awaiting_question"
            | "waiting_for_permission"
            | "waiting_for_question"
    ) {
        return true;
    }
    matches!(
        derive_status_from_db(DbStatusInputs {
            status_col,
            pending_permission,
            pending_question,
        })
        .status,
        AgentStatus::Agent | AgentStatus::Question
    )
}

pub(super) async fn resolve_session_scope(
    pool: &sqlx::SqlitePool,
    session_id: i64,
) -> Result<SessionScope, AppError> {
    sqlx::query_as(
        "SELECT s.id AS session_id, f.id AS feature_id, f.title AS feature_title,
                f.project_id, s.status, s.pending_permission, s.pending_questions
         FROM agent_sessions s
         JOIN features f ON f.id = s.feature_id
         WHERE s.id = ?",
    )
    .bind(session_id)
    .fetch_optional(pool)
    .await?
    .ok_or_else(|| AppError::NotFound(format!("session {session_id}")))
}

#[cfg(test)]
mod tests {
    use super::is_active_db_state;

    #[test]
    fn canonical_pending_gate_is_active_even_when_status_is_paused() {
        assert!(is_active_db_state("paused", true, false));
        assert!(is_active_db_state("paused", false, true));
        assert!(is_active_db_state("awaiting_question", false, false));
        assert!(!is_active_db_state("completed", false, false));
    }
}
