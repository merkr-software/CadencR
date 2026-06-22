use serde::Deserialize;

use super::scope::resolve_session_scope;
use crate::app_state::AppState;
use crate::domain::mcp::control::send_message::broadcast_generated_user_message;
use crate::domain::ws_session::handler::session_prompt::dispatch_control_prompt;
use crate::error::AppError;

#[derive(Debug, Deserialize, sqlx::FromRow)]
struct QueuedMessage {
    id: i64,
    source_session_id: Option<i64>,
    content: String,
}

pub(crate) async fn drain_next_queued_message(
    state: &AppState,
    target_feature_id: i64,
    target_session_id: i64,
) -> Result<bool, AppError> {
    let Some(message) = claim_next_message(&state.write_pool, target_session_id).await? else {
        return Ok(false);
    };
    match deliver_message(state, target_feature_id, target_session_id, &message).await {
        Ok(()) => {
            mark_delivered(&state.write_pool, message.id).await?;
            Ok(true)
        }
        Err(error) => {
            mark_error(&state.write_pool, message.id, &error.to_string()).await?;
            Err(error)
        }
    }
}

async fn claim_next_message(
    pool: &sqlx::SqlitePool,
    target_session_id: i64,
) -> Result<Option<QueuedMessage>, AppError> {
    Ok(sqlx::query_as(
        "UPDATE agent_session_message_queue
         SET status = 'delivering', error = NULL
         WHERE id = (
             SELECT id
             FROM agent_session_message_queue
             WHERE target_session_id = ? AND status = 'pending'
             ORDER BY id ASC
             LIMIT 1
         )
         RETURNING id, source_session_id, content",
    )
    .bind(target_session_id)
    .fetch_optional(pool)
    .await?)
}

async fn deliver_message(
    state: &AppState,
    target_feature_id: i64,
    target_session_id: i64,
    message: &QueuedMessage,
) -> Result<(), AppError> {
    if let Some(source_session_id) = message.source_session_id {
        persist_generated_user_message(
            state,
            target_session_id,
            source_session_id,
            &message.content,
        )
        .await?;
        let source = resolve_session_scope(&state.write_pool, source_session_id).await?;
        broadcast_generated_user_message(
            state,
            &source,
            target_feature_id,
            &message.content,
            Some("delivered from queued project_send_session_message"),
        )
        .await;
    }
    dispatch_control_prompt(
        state,
        target_feature_id,
        target_session_id,
        &message.content,
        // The user message was already persisted/broadcast above.
        true,
    )
    .await
}

async fn persist_generated_user_message(
    state: &AppState,
    target_session_id: i64,
    source_session_id: i64,
    content: &str,
) -> Result<(), AppError> {
    let source = resolve_session_scope(&state.write_pool, source_session_id).await?;
    let mut tx = state.write_pool.begin().await?;
    let message_id: i64 = sqlx::query_scalar(
        "INSERT INTO agent_messages (session_id, role, content, message_type)
         VALUES (?, 'user', ?, 'user_message')
         RETURNING id",
    )
    .bind(target_session_id)
    .bind(content)
    .fetch_one(&mut *tx)
    .await?;
    sqlx::query(
        "INSERT INTO agent_message_origins
         (message_id, origin_kind, source_session_id, source_feature_id, source_project_id, note)
         VALUES (?, 'session_generated', ?, ?, ?, ?)",
    )
    .bind(message_id)
    .bind(source.session_id)
    .bind(source.feature_id)
    .bind(source.project_id)
    .bind("delivered from queued project_send_session_message")
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    Ok(())
}

async fn mark_delivered(pool: &sqlx::SqlitePool, id: i64) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE agent_session_message_queue
         SET status = 'delivered', delivered_at = datetime('now'), error = NULL
         WHERE id = ? AND status = 'delivering'",
    )
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_error(pool: &sqlx::SqlitePool, id: i64, error: &str) -> Result<(), AppError> {
    sqlx::query(
        "UPDATE agent_session_message_queue
         SET status = 'error', error = ?
         WHERE id = ? AND status = 'delivering'",
    )
    .bind(error)
    .bind(id)
    .execute(pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::drain_next_queued_message;
    use crate::app_state::AppState;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    #[tokio::test]
    async fn drain_next_queued_message_persists_origin_and_marks_delivered() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext {
            pool: &pool,
            db_path: None,
            app_version: None,
        })
        .await
        .unwrap();
        seed_queue_fixture(&pool).await;
        let state = AppState::with_pool(pool.clone());

        let delivered = drain_next_queued_message(&state, 43, 888).await.unwrap();

        assert!(delivered);
        let status: String =
            sqlx::query_scalar("SELECT status FROM agent_session_message_queue WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "delivered");
        let origin: (String, i64, i64, i64) = sqlx::query_as(
            "SELECT origin_kind, source_session_id, source_feature_id, source_project_id
             FROM agent_message_origins
             JOIN agent_messages ON agent_messages.id = agent_message_origins.message_id
             WHERE agent_messages.session_id = 888",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(origin, ("session_generated".into(), 777, 42, 7));
    }

    #[tokio::test]
    async fn claim_next_message_marks_row_delivering_atomically() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext {
            pool: &pool,
            db_path: None,
            app_version: None,
        })
        .await
        .unwrap();
        seed_queue_fixture(&pool).await;

        let first = super::claim_next_message(&pool, 888).await.unwrap();
        let second = super::claim_next_message(&pool, 888).await.unwrap();

        assert!(first.is_some());
        assert!(second.is_none());
        let status: String =
            sqlx::query_scalar("SELECT status FROM agent_session_message_queue WHERE id = 1")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(status, "delivering");
    }

    async fn seed_queue_fixture(pool: &sqlx::SqlitePool) {
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (7, 'Proj', '/tmp/proj')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (42, 7, 'Source', 'active', 'ws-session'),
                    (43, 7, 'Target', 'active', 'ws-session')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status, runtime_provider)
             VALUES (777, 42, 'session', 'completed', 'missing_provider'),
                    (888, 43, 'session', 'completed', 'missing_provider')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_session_message_queue
             (id, target_session_id, source_session_id, content, status)
             VALUES (1, 888, 777, 'Queued work item', 'pending')",
        )
        .execute(pool)
        .await
        .unwrap();
    }
}
