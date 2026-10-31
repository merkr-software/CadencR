//! Questions and permission requests a restart left unanswerable.
//!
//! A gate lives in the agent process that asked it: the answer is the reply to
//! a request that process is blocked on. Once the restart killed it, the
//! persisted gate still shows, but answering it has no process to reach
//! ("Session not yet active"). So a captured turn's gate is cleared, and the
//! resumed agent is told to ask again — the user then answers a live gate.

use crate::app_state::AppState;
use crate::domain::session_status::AgentStatus;
use crate::domain::ws_session::persistence::WsSessionPersistence;

/// Clear the session's dead gate everywhere a client reads it from: the row,
/// the gate registry, and the live status book (seeded with "question" from
/// the row at startup). Returns whether there was one.
pub(super) async fn clear_dead_gate(
    state: &AppState,
    session_id: i64,
    feature_id: i64,
) -> Result<bool, sqlx::Error> {
    let Some(row) =
        WsSessionPersistence::try_get_session_row(&state.write_pool, session_id).await?
    else {
        return Ok(false);
    };
    let Some((_, payload)) = row.pending_gate_payload() else {
        return Ok(false);
    };
    WsSessionPersistence::clear_all_pending_user_input_static(&state.write_pool, session_id).await;
    state
        .pending_gates
        .complete(session_id, &payload.request_id)
        .await;
    state
        .session_status_tx
        .broadcast(session_id, feature_id, AgentStatus::Idle, None);
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::restart_continuations::store::tests::session;
    use crate::domain::schedules::repository::test_support::fixture;

    #[tokio::test]
    async fn a_dead_question_is_cleared_once() {
        let (pool, _, feature_id) = fixture().await;
        let session_id = session(&pool, feature_id, "paused").await;
        sqlx::query("UPDATE agent_sessions SET pending_questions = ? WHERE id = ?")
            .bind(r#"{"request_id":"q-1","tool_name":"AskUserQuestion","tool_input":{}}"#)
            .bind(session_id)
            .execute(&pool)
            .await
            .unwrap();
        let state = AppState::with_pool(pool.clone());

        assert!(clear_dead_gate(&state, session_id, feature_id)
            .await
            .unwrap());
        assert!(!clear_dead_gate(&state, session_id, feature_id)
            .await
            .unwrap());

        let pending: Option<String> =
            sqlx::query_scalar("SELECT pending_questions FROM agent_sessions WHERE id = ?")
                .bind(session_id)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert!(pending.is_none());
    }
}
