#[path = "message_queue_persistence.rs"]
mod persistence;

pub(crate) use self::persistence::enqueue_message;
use self::persistence::{
    claim_next_message, mark_delivered, mark_error, queued_message_uuid, QueuedMessage,
};
use super::generated_message::dispatch_generated_prompt;
pub(super) use super::generated_message::persist_generated_user_message;
use super::scope::{is_active_db_state, resolve_session_scope};
use crate::app_state::AppState;
use crate::domain::mcp::control::send_message::publish_generated_user_message;
use crate::error::AppError;
use futures::{stream, StreamExt};
use std::sync::OnceLock;
use tokio::sync::Notify;

static QUEUE_WORKER_NOTIFY: OnceLock<Notify> = OnceLock::new();
const QUEUED_MESSAGE_DELIVERY_NOTE: &str = "delivered from queued session message";
const QUEUED_MESSAGE_FAILURE_NOTE: &str = "queued session message delivery failure";

fn worker_notify() -> &'static Notify {
    QUEUE_WORKER_NOTIFY.get_or_init(Notify::new)
}

pub(super) fn notify_worker() {
    worker_notify().notify_one();
}

pub fn spawn(state: AppState) {
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        loop {
            tokio::select! {
                _ = interval.tick() => {}
                _ = worker_notify().notified() => {}
            }
            if let Err(error) = drain_idle_queues_once(&state).await {
                tracing::error!(error = %error, "queued message background drain failed");
            }
        }
    });
}

async fn drain_idle_queues_once(state: &AppState) -> Result<(), AppError> {
    let targets: Vec<QueueTarget> = sqlx::query_as(
        "SELECT DISTINCT q.target_session_id AS session_id, s.feature_id, s.status,
                s.pending_permission, s.pending_questions
         FROM agent_session_message_queue q
         JOIN agent_sessions s ON s.id = q.target_session_id
         WHERE q.status = 'pending'",
    )
    .fetch_all(&state.read_pool)
    .await?;
    stream::iter(targets)
        .for_each_concurrent(4, |target| async move {
            if target.is_active() {
                return;
            }
            if let Err(error) =
                drain_next_queued_message(state, target.feature_id, target.session_id).await
            {
                tracing::error!(session_id = target.session_id, error = %error, "queued message delivery failed");
            }
        })
        .await;
    Ok(())
}

#[derive(sqlx::FromRow)]
struct QueueTarget {
    session_id: i64,
    feature_id: i64,
    status: String,
    pending_permission: Option<String>,
    pending_questions: Option<String>,
}

impl QueueTarget {
    fn is_active(&self) -> bool {
        is_active_db_state(
            &self.status,
            self.pending_permission.is_some(),
            self.pending_questions.is_some(),
        )
    }
}

pub(crate) async fn drain_next_queued_message(
    state: &AppState,
    target_feature_id: i64,
    target_session_id: i64,
) -> Result<bool, AppError> {
    let mut last_error = None;
    loop {
        let Some(message) = claim_next_message(&state.write_pool, target_session_id).await? else {
            return match last_error {
                Some(error) => Err(error),
                None => Ok(false),
            };
        };
        match deliver_message(state, target_feature_id, target_session_id, &message).await {
            Ok(()) => {
                mark_delivered(&state.write_pool, message.id, &message.claim_token).await?;
                return Ok(true);
            }
            Err(error) => {
                mark_error(
                    &state.write_pool,
                    message.id,
                    &message.claim_token,
                    &error.to_string(),
                )
                .await?;
                last_error = match surface_delivery_failure(
                    state,
                    target_feature_id,
                    target_session_id,
                    &message,
                    &error,
                )
                .await
                {
                    Ok(()) => Some(error),
                    Err(notification_error) => Some(AppError::internal(format!(
                        "{error}; additionally failed to notify the requesting session: {notification_error}"
                    ))),
                };
            }
        }
    }
}

async fn surface_delivery_failure(
    state: &AppState,
    target_feature_id: i64,
    target_session_id: i64,
    message: &QueuedMessage,
    error: &AppError,
) -> Result<(), AppError> {
    let Some(source_session_id) = message.source_session_id else {
        return Ok(());
    };
    let source = resolve_session_scope(&state.write_pool, source_session_id).await?;
    let target = resolve_session_scope(&state.write_pool, target_session_id).await?;
    let notification_uuid = uuid::Uuid::new_v5(
        &uuid::Uuid::NAMESPACE_URL,
        format!(
            "cadencr:queued-message-delivery-error:{}:{}",
            message.id, message.attempt_count
        )
        .as_bytes(),
    );
    let content = format!(
        "<cadencr-delivery-error target-session=\"{target_session_id}\" target-feature=\"{target_feature_id}\" queue-id=\"{}\">\nQueued message delivery failed: {error}\n</cadencr-delivery-error>",
        message.id
    );
    let (persisted, origin) = persist_generated_user_message(
        state,
        source.session_id,
        &target,
        &content,
        QUEUED_MESSAGE_FAILURE_NOTE,
        notification_uuid,
    )
    .await?;
    publish_generated_user_message(state, source.feature_id, &persisted, origin).await?;
    dispatch_generated_prompt(
        state,
        source.feature_id,
        source.session_id,
        &content,
        notification_uuid,
    )
    .await
}

async fn deliver_message(
    state: &AppState,
    target_feature_id: i64,
    target_session_id: i64,
    message: &QueuedMessage,
) -> Result<(), AppError> {
    let dispatch_message_uuid = if let Some(source_session_id) = message.source_session_id {
        let source = resolve_session_scope(&state.write_pool, source_session_id).await?;
        let message_uuid = queued_message_uuid(message)?;
        let (persisted, origin) = persist_generated_user_message(
            state,
            target_session_id,
            &source,
            &message.content,
            QUEUED_MESSAGE_DELIVERY_NOTE,
            message_uuid,
        )
        .await?;
        publish_generated_user_message(state, target_feature_id, &persisted, origin).await?;
        message_uuid
    } else {
        // Compatibility for automatic events queued by older versions. Their
        // canonical message was persisted before the transport row, so carry
        // that UUID through receipt tracking when the legacy row drains.
        queued_message_uuid(message)?
    };
    dispatch_generated_prompt(
        state,
        target_feature_id,
        target_session_id,
        &message.content,
        dispatch_message_uuid,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::persistence::{enqueue_message, seed_queue_fixture};
    use super::{
        drain_idle_queues_once, drain_next_queued_message, QUEUED_MESSAGE_DELIVERY_NOTE,
        QUEUED_MESSAGE_FAILURE_NOTE,
    };
    use crate::app_state::AppState;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    #[tokio::test]
    async fn failed_cross_project_queue_delivery_uses_neutral_provenance_and_marks_error() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext {
            pool: &pool,
            db_path: None,
            app_version: None,
        })
        .await
        .unwrap();
        seed_queue_fixture(&pool).await;
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (8, 'Other', '/tmp/other')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query("UPDATE features SET project_id = 8 WHERE id = 43")
            .execute(&pool)
            .await
            .unwrap();
        let state = AppState::with_pool(pool.clone());

        let error = drain_next_queued_message(&state, 43, 888)
            .await
            .unwrap_err();

        assert!(error.to_string().contains("runtime adapter unavailable"));
        let status: String =
            sqlx::query_scalar("SELECT status FROM agent_session_message_queue WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "error");
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
                QUEUED_MESSAGE_DELIVERY_NOTE.into()
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
    async fn retried_queue_row_dispatches_when_its_user_message_already_exists() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        seed_queue_fixture(&pool).await;
        sqlx::query("DELETE FROM agent_session_message_queue")
            .execute(&pool)
            .await
            .unwrap();
        let state = AppState::with_pool(pool.clone());
        let source = super::resolve_session_scope(&pool, 777).await.unwrap();
        let message_uuid = uuid::Uuid::new_v4();
        super::persist_generated_user_message(
            &state,
            888,
            &source,
            "already persisted",
            QUEUED_MESSAGE_DELIVERY_NOTE,
            message_uuid,
        )
        .await
        .unwrap();
        enqueue_message(&pool, 888, Some(777), "already persisted", message_uuid)
            .await
            .unwrap();

        let error = drain_next_queued_message(&state, 43, 888)
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
        let message_count: i64 = sqlx::query_scalar(
            "SELECT COUNT(*) FROM agent_messages
             WHERE session_id = 888 AND message_uuid = ?",
        )
        .bind(message_uuid.to_string())
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(message_count, 1);
    }

    #[tokio::test]
    async fn one_failed_delivery_does_not_strand_later_pending_rows() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        seed_queue_fixture(&pool).await;
        enqueue_message(
            &pool,
            888,
            Some(777),
            "second queued item",
            uuid::Uuid::new_v4(),
        )
        .await
        .unwrap();
        let state = AppState::with_pool(pool.clone());

        drain_next_queued_message(&state, 43, 888)
            .await
            .unwrap_err();

        let statuses: Vec<String> =
            sqlx::query_scalar("SELECT status FROM agent_session_message_queue ORDER BY id")
                .fetch_all(&pool)
                .await
                .unwrap();
        assert_eq!(statuses, vec!["error", "error"]);
    }

    #[tokio::test]
    async fn background_drain_preserves_queue_while_canonical_gate_is_pending() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        seed_queue_fixture(&pool).await;
        sqlx::query(
            "UPDATE agent_sessions
             SET status = 'paused', pending_questions = '[{\"question\":\"Choose\"}]'
             WHERE id = 888",
        )
        .execute(&pool)
        .await
        .unwrap();
        let state = AppState::with_pool(pool.clone());

        drain_idle_queues_once(&state).await.unwrap();

        let status: String =
            sqlx::query_scalar("SELECT status FROM agent_session_message_queue WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "pending");
    }
}
