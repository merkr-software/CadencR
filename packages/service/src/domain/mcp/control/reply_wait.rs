use serde::Deserialize;

use super::reply_audit::record_reply_delivery_audit;
use super::reply_envelope::{build_reply_envelope, ReplyEnvelopeMetadata};
use super::requester_delivery::deliver_reply;
use super::scope::{resolve_session_scope, SessionScope};
use crate::app_state::AppState;
use crate::domain::mcp::message_queries::latest_assistant_text_after;
use crate::error::AppError;

#[derive(Debug, Deserialize, sqlx::FromRow)]
struct ReplyWait {
    id: i64,
    requester_session_id: i64,
    responder_session_id: i64,
    request_message_id: Option<i64>,
    kind: String,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReplyOutcome {
    Completed,
    Failed,
}

impl ReplyOutcome {
    fn envelope_status(self) -> &'static str {
        match self {
            Self::Completed => "completed",
            Self::Failed => "failed",
        }
    }

    fn wait_status(self) -> &'static str {
        match self {
            Self::Completed => "delivered",
            Self::Failed => "failed",
        }
    }
}

pub(crate) async fn insert_pending(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    requester_session_id: i64,
    responder_session_id: i64,
    request_message_id: i64,
    kind: &str,
) -> Result<i64, AppError> {
    Ok(sqlx::query_scalar(
        "INSERT INTO agent_session_reply_waits
         (requester_session_id, responder_session_id, request_message_id, kind, status)
         VALUES (?, ?, ?, ?, 'pending') RETURNING id",
    )
    .bind(requester_session_id)
    .bind(responder_session_id)
    .bind(request_message_id)
    .bind(kind)
    .fetch_one(&mut **tx)
    .await?)
}

pub(crate) async fn arm(
    pool: &sqlx::SqlitePool,
    responder_session_id: i64,
    request_message_id: i64,
) -> Result<(), AppError> {
    let result = sqlx::query(
        "UPDATE agent_session_reply_waits
         SET status = 'armed', armed_at = datetime('now'), error = NULL
         WHERE responder_session_id = ? AND request_message_id = ? AND status = 'pending'",
    )
    .bind(responder_session_id)
    .bind(request_message_id)
    .execute(pool)
    .await?;
    if result.rows_affected() != 1 {
        return Err(AppError::Internal(
            "reply wait did not match exactly one pending request message".to_string(),
        ));
    }
    Ok(())
}

pub(crate) async fn deliver_completed(
    state: &AppState,
    responder_session_id: i64,
) -> Result<(), AppError> {
    let waits = load_armed_waits(&state.write_pool, responder_session_id).await?;
    for wait in waits {
        let text = latest_assistant_text_after(
            &state.read_pool,
            responder_session_id,
            wait.request_message_id.unwrap_or(0),
        )
        .await?;
        let (outcome, body) = match text {
            Some(text) => (ReplyOutcome::Completed, text),
            None => (
                ReplyOutcome::Failed,
                "The responder completed without a final assistant text response.".to_string(),
            ),
        };
        if claim_wait(&state.write_pool, wait.id, outcome).await? {
            deliver_one(state, &wait, outcome, &body).await?;
        }
    }
    Ok(())
}

pub(crate) async fn deliver_failed(
    state: &AppState,
    responder_session_id: i64,
    reason: &str,
) -> Result<(), AppError> {
    let waits = load_armed_waits(&state.write_pool, responder_session_id).await?;
    for wait in waits {
        if claim_wait(&state.write_pool, wait.id, ReplyOutcome::Failed).await? {
            deliver_one(state, &wait, ReplyOutcome::Failed, reason).await?;
        }
    }
    Ok(())
}

async fn load_armed_waits(
    pool: &sqlx::SqlitePool,
    responder_session_id: i64,
) -> Result<Vec<ReplyWait>, AppError> {
    let result = sqlx::query_as(
        "SELECT id, requester_session_id, responder_session_id, request_message_id, kind
         FROM agent_session_reply_waits
         WHERE responder_session_id = ? AND status = 'armed' ORDER BY id",
    )
    .bind(responder_session_id)
    .fetch_all(pool)
    .await;
    match result {
        Ok(waits) => Ok(waits),
        Err(error) if missing_reply_wait_table(&error) => Ok(Vec::new()),
        Err(error) => Err(error.into()),
    }
}

fn missing_reply_wait_table(error: &sqlx::Error) -> bool {
    matches!(error, sqlx::Error::Database(error) if error.message().contains("no such table: agent_session_reply_waits"))
}

async fn claim_wait(
    pool: &sqlx::SqlitePool,
    wait_id: i64,
    outcome: ReplyOutcome,
) -> Result<bool, AppError> {
    let result = sqlx::query(
        "UPDATE agent_session_reply_waits
         SET status = ?, delivered_at = datetime('now'), error = NULL
         WHERE id = ? AND status = 'armed'",
    )
    .bind(outcome.wait_status())
    .bind(wait_id)
    .execute(pool)
    .await?;
    Ok(result.rows_affected() == 1)
}

async fn deliver_one(
    state: &AppState,
    wait: &ReplyWait,
    outcome: ReplyOutcome,
    body: &str,
) -> Result<(), AppError> {
    let started_at = std::time::Instant::now();
    let responder = resolve_session_scope(&state.write_pool, wait.responder_session_id).await?;
    let requester = resolve_session_scope(&state.write_pool, wait.requester_session_id).await?;
    let envelope = reply_envelope(wait, &responder, outcome.envelope_status(), body);
    let delivery = deliver_reply(state, &responder, &requester, &envelope).await;
    let error = delivery.as_ref().err().map(ToString::to_string);
    if let Some(error) = error.as_deref() {
        record_delivery_error(&state.write_pool, wait.id, error).await?;
    }
    record_reply_delivery_audit(
        state,
        &responder,
        &requester,
        &envelope,
        error.as_deref(),
        started_at,
    )
    .await?;
    delivery
}

async fn record_delivery_error(
    pool: &sqlx::SqlitePool,
    wait_id: i64,
    error: &str,
) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE agent_session_reply_waits
         SET status = 'failed', error = ? WHERE id = ?",
    )
    .bind(error)
    .bind(wait_id)
    .execute(pool)
    .await?;
    Ok(())
}

fn reply_envelope(wait: &ReplyWait, responder: &SessionScope, status: &str, body: &str) -> String {
    let link = if wait.kind == "spawn" {
        "spawned"
    } else {
        "messaged"
    };
    build_reply_envelope(
        ReplyEnvelopeMetadata {
            responder_session_id: responder.session_id,
            responder_feature_id: responder.feature_id,
            responder_feature_title: &responder.feature_title,
            responder_project_id: responder.project_id,
            request_message_id: wait.request_message_id,
            link,
            status,
        },
        body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    #[tokio::test]
    async fn armed_result_delivers_envelope_with_responder_origin() {
        let (pool, state) = test_state().await;

        deliver_completed(&state, 888).await.unwrap();
        deliver_completed(&state, 888).await.unwrap();

        let delivered: (String, String, i64, i64, i64) = sqlx::query_as(
            "SELECT m.content, o.origin_kind, o.source_session_id,
                    o.source_feature_id, o.source_project_id
             FROM agent_messages m JOIN agent_message_origins o ON o.message_id = m.id
             WHERE m.session_id = 777 AND m.role = 'user'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(delivered.0.contains("<cadencr-reply from-session=\"888\" from-feature=\"43\" from-feature-title=\"Responder\" from-project=\"7\" status=\"completed\" link=\"messaged\" request-message-id=\"1\">"));
        assert!(delivered.0.contains("Finished successfully"));
        assert_eq!(
            (delivered.1, delivered.2, delivered.3, delivered.4),
            ("session_generated".into(), 888, 43, 7)
        );
        let status: String =
            sqlx::query_scalar("SELECT status FROM agent_session_reply_waits WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "delivered");
        let reply_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages
             WHERE session_id = 777 AND role = 'user' AND content LIKE '<cadencr-reply%'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(reply_count, 1, "a claimed wait must not deliver twice");
    }

    #[tokio::test]
    async fn completed_turn_does_not_reuse_assistant_text_before_request() {
        let (pool, state) = test_state().await;
        sqlx::query("UPDATE agent_session_reply_waits SET request_message_id = 2 WHERE id = 1")
            .execute(&pool)
            .await
            .unwrap();

        deliver_completed(&state, 888).await.unwrap();

        let content: String = sqlx::query_scalar(
            "SELECT content FROM agent_messages
             WHERE session_id = 777 AND role = 'user' AND content LIKE '<cadencr-reply%'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(content.contains("status=\"failed\""));
        assert!(!content.contains("Finished successfully"));
    }

    #[tokio::test]
    async fn busy_requester_persists_reply_before_queuing_next_turn() {
        let (pool, state) = test_state().await;
        sqlx::query("UPDATE agent_sessions SET status = 'running' WHERE id = 777")
            .execute(&pool)
            .await
            .unwrap();

        deliver_completed(&state, 888).await.unwrap();

        let reply_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages
             WHERE session_id = 777 AND role = 'user' AND content LIKE '<cadencr-reply%'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            reply_count, 1,
            "reply must be visible before the requester turn ends"
        );
        let queued: (String, Option<i64>) = sqlx::query_as(
            "SELECT status, source_session_id FROM agent_session_message_queue
             WHERE target_session_id = 777",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(queued, ("pending".into(), None));
    }

    async fn test_state() -> (sqlx::SqlitePool, AppState) {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext {
            pool: &pool,
            db_path: None,
            app_version: None,
        })
        .await
        .unwrap();
        seed_fixture(&pool).await;
        let state = AppState::with_pool(pool.clone());
        (pool, state)
    }

    async fn seed_fixture(pool: &sqlx::SqlitePool) {
        sqlx::raw_sql(
            "INSERT INTO projects (id, name, path) VALUES (7, 'Proj', '/tmp/proj');
             INSERT INTO features (id, project_id, title, status, type)
             VALUES (42, 7, 'Requester', 'active', 'ws-session'),
                    (43, 7, 'Responder', 'active', 'ws-session');
             INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider)
             VALUES (777, 42, 'session', 'paused', 'missing_provider'),
                    (888, 43, 'session', 'completed', 'missing_provider');
             INSERT INTO agent_messages (id, session_id, role, content, message_type)
             VALUES (1, 888, 'user', 'Do work', 'user_message'),
                    (2, 888, 'assistant', 'Finished successfully', 'text');
             INSERT INTO agent_session_reply_waits
             (id, requester_session_id, responder_session_id, request_message_id, kind, status, armed_at)
             VALUES (1, 777, 888, 1, 'message', 'armed', datetime('now'));",
        ).execute(pool).await.unwrap();
    }
}
