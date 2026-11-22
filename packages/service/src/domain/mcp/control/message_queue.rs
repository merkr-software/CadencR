//! Delivering a message another session's agent queued with
//! `delivery=next_turn`. The queue itself is the target session's prompt
//! queue (`domain::prompt_queue`); this is what differs for an agent message:
//! it is recorded as sent by its source conversation, and a failure is
//! reported back to that conversation.

use super::generated_message::{
    dispatch_generated_prompt, persist_and_broadcast_generated_user_message,
};
use super::requester_delivery;
use super::scope::resolve_session_scope;
use crate::app_state::AppState;
use crate::domain::prompt_queue::store::{QueueRow, AGENT_MESSAGE_NOTE};
use crate::error::AppError;

const QUEUED_MESSAGE_FAILURE_NOTE: &str = "queued session message delivery failure";

/// Record the message in the target's transcript as sent by its source
/// conversation, then hand it to the target's agent.
pub(crate) async fn deliver(
    state: &AppState,
    target_feature_id: i64,
    message: &QueueRow,
    message_uuid: uuid::Uuid,
) -> Result<(), AppError> {
    // A sender deleted since (`ON DELETE SET NULL`) leaves nothing to attribute
    // the message to; older versions persisted automatic events before
    // queuing them. Either way the agent still receives it.
    if let Some(source_session_id) = message.source_session_id {
        let source = resolve_session_scope(&state.write_pool, source_session_id).await?;
        persist_and_broadcast_generated_user_message(
            state,
            &source,
            message.session_id,
            target_feature_id,
            &message.content,
            AGENT_MESSAGE_NOTE,
            message_uuid,
        )
        .await?;
    }
    dispatch_generated_prompt(
        state,
        target_feature_id,
        message.session_id,
        &message.content,
        message_uuid,
    )
    .await
}

/// Tell the source conversation its queued message could not be delivered.
/// Returns the error to record on the queue row.
pub(crate) async fn report_failure(
    state: &AppState,
    target_feature_id: i64,
    message: &QueueRow,
    error: AppError,
) -> AppError {
    let Some(source_session_id) = message.source_session_id else {
        return error;
    };
    match notify_source(state, target_feature_id, source_session_id, message, &error).await {
        Ok(()) => error,
        Err(notification_error) => AppError::internal(format!(
            "{error}; additionally failed to notify the requesting session: {notification_error}"
        )),
    }
}

async fn notify_source(
    state: &AppState,
    target_feature_id: i64,
    source_session_id: i64,
    message: &QueueRow,
    error: &AppError,
) -> Result<(), AppError> {
    let source = resolve_session_scope(&state.write_pool, source_session_id).await?;
    let target = resolve_session_scope(&state.write_pool, message.session_id).await?;
    // One notice per attempt. The queue moved to the prompt queue table, whose
    // ids restart, so the name differs from the old table's notices.
    let notification_uuid = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!(
            "cadencr:session-queue-delivery-error:{}:{}",
            message.id, message.attempt_count
        )
        .as_bytes(),
    );
    let content = format!(
        "<cadencr-delivery-error target-session=\"{}\" target-feature=\"{target_feature_id}\" queue-id=\"{}\">\nQueued message delivery failed: {error}\n</cadencr-delivery-error>",
        message.session_id, message.id
    );
    requester_delivery::deliver(
        state,
        &target,
        &source,
        &content,
        QUEUED_MESSAGE_FAILURE_NOTE,
        notification_uuid,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::QUEUED_MESSAGE_FAILURE_NOTE;
    use crate::app_state::AppState;
    use crate::domain::prompt_queue::delivery::{drain_agent_messages_if_idle, drain_next_if_idle};
    use crate::domain::prompt_queue::store::{enqueue_agent_message, AGENT_MESSAGE_NOTE};
    use crate::shared::migrate::{run_migrations, MigrationContext};

    /// Source session 777 (feature 42) queued a message for idle session 888
    /// (feature 43), whose provider is missing: every delivery fails.
    async fn queue_fixture() -> (sqlx::SqlitePool, AppState) {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        for statement in [
            "INSERT INTO projects (id, name, path) VALUES (7, 'Proj', '/tmp/proj')",
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (42, 7, 'Source', 'active', 'ws-session'),
                    (43, 7, 'Target', 'active', 'ws-session')",
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider)
             VALUES (777, 42, 'session', 'completed', 'missing_provider'),
                    (888, 43, 'session', 'completed', 'missing_provider')",
        ] {
            sqlx::query(statement).execute(&pool).await.unwrap();
        }
        enqueue_agent_message(&pool, 888, 777, "Queued work item", uuid::Uuid::new_v4())
            .await
            .unwrap();
        (pool.clone(), AppState::with_pool(pool))
    }

    async fn statuses(pool: &sqlx::SqlitePool) -> Vec<String> {
        sqlx::query_scalar("SELECT status FROM agent_session_prompt_queue ORDER BY id")
            .fetch_all(pool)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn failed_cross_project_delivery_keeps_the_sender_and_tells_it() {
        let (pool, state) = queue_fixture().await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (8, 'Other', '/tmp/other')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE features SET project_id = 8 WHERE id = 43")
            .execute(&pool)
            .await
            .unwrap();

        let error = drain_next_if_idle(&state, 888).await.unwrap_err();

        assert!(error.to_string().contains("runtime adapter unavailable"));
        assert_eq!(statuses(&pool).await, ["error"]);
        let origin: (String, i64, i64, i64, String) = sqlx::query_as(
            "SELECT origin_kind, source_session_id, source_feature_id, source_project_id, note
             FROM agent_message_origins
             JOIN agent_messages ON agent_messages.id = agent_message_origins.message_id
             WHERE agent_messages.session_id = 888",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            origin,
            (
                "session_generated".into(),
                777,
                42,
                7,
                AGENT_MESSAGE_NOTE.into()
            )
        );
        let notification: (String, String) = sqlx::query_as(
            "SELECT content, note FROM agent_messages
             JOIN agent_message_origins ON agent_message_origins.message_id = agent_messages.id
             WHERE session_id = 777 AND content LIKE '<cadencr-delivery-error%'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert!(notification.0.contains("queue-id=\"1\""));
        assert_eq!(notification.1, QUEUED_MESSAGE_FAILURE_NOTE);
    }

    #[tokio::test]
    async fn an_edited_message_is_delivered_as_sent_by_its_agent() {
        let (pool, state) = queue_fixture().await;
        crate::domain::prompt_queue::store::update_content(&pool, 888, 1, "Edited work item")
            .await
            .unwrap();

        drain_next_if_idle(&state, 888).await.unwrap_err();

        let delivered: (String, i64) = sqlx::query_as(
            "SELECT content, source_session_id FROM agent_messages
             JOIN agent_message_origins ON agent_message_origins.message_id = agent_messages.id
             WHERE agent_messages.session_id = 888",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(delivered, ("Edited work item".into(), 777));
    }

    #[tokio::test]
    async fn retried_row_dispatches_when_its_user_message_already_exists() {
        let (pool, state) = queue_fixture().await;
        // The first attempt persisted the message, then failed to dispatch.
        drain_next_if_idle(&state, 888).await.unwrap_err();
        sqlx::query("UPDATE agent_sessions SET status = 'completed' WHERE id = 888")
            .execute(&pool)
            .await
            .unwrap();

        let error = crate::domain::prompt_queue::delivery::send_now(&state, 888, 1)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("runtime adapter unavailable"));
        let status: String = sqlx::query_scalar("SELECT status FROM agent_sessions WHERE id = 888")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(
            status, "paused",
            "the missing-provider dispatch path proves the retry was attempted"
        );
        let copies: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages
             WHERE session_id = 888 AND content = 'Queued work item'",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(copies, 1);
    }

    #[tokio::test]
    async fn one_failed_delivery_does_not_strand_later_pending_rows() {
        let (pool, state) = queue_fixture().await;
        enqueue_agent_message(&pool, 888, 777, "second", uuid::Uuid::new_v4())
            .await
            .unwrap();

        drain_agent_messages_if_idle(&state, 888).await.unwrap_err();

        assert_eq!(statuses(&pool).await, ["error", "error"]);
    }

    #[tokio::test]
    async fn a_failed_user_prompt_stops_the_drain() {
        let (pool, state) = queue_fixture().await;
        for content in ["first", "second"] {
            crate::domain::prompt_queue::store::enqueue(&pool, 888, content)
                .await
                .unwrap();
        }

        drain_next_if_idle(&state, 888).await.unwrap_err();

        // The user's prompts go first; the runtime refused the first one.
        assert_eq!(statuses(&pool).await, ["pending", "error", "pending"]);
    }

    #[tokio::test]
    async fn a_pending_gate_keeps_agent_messages_queued() {
        let (pool, state) = queue_fixture().await;
        sqlx::query(
            "UPDATE agent_sessions
             SET status = 'paused', pending_questions = '[{\"question\":\"Choose\"}]'
             WHERE id = 888",
        )
        .execute(&pool)
        .await
        .unwrap();

        assert!(!drain_agent_messages_if_idle(&state, 888).await.unwrap());

        assert_eq!(statuses(&pool).await, ["pending"]);
    }
}
