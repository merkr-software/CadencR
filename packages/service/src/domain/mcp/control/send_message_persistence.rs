use super::super::scope::SessionScope;
use crate::app_state::AppState;
use crate::domain::sessions::models::AgentMessageOrigin;
use crate::domain::sessions::user_messages::{
    persist_user_message, NewUserMessage, PersistedUserMessage,
};
use crate::error::AppError;

pub(super) struct ImmediateMessageRequest<'a> {
    pub state: &'a AppState,
    pub source: &'a SessionScope,
    pub target: &'a SessionScope,
    pub message: &'a str,
    pub message_uuid: uuid::Uuid,
    pub source_note: Option<&'a str>,
    pub link_to_current_session: bool,
    pub await_reply: bool,
}

pub(super) async fn persist_immediate_message(
    request: ImmediateMessageRequest<'_>,
) -> Result<(PersistedUserMessage, AgentMessageOrigin), AppError> {
    let mut tx = request.state.write_pool.begin().await?;
    let persisted = persist_user_message(
        &mut tx,
        NewUserMessage {
            session_id: request.target.session_id,
            content: request.message,
            message_uuid: request.message_uuid,
            delivery_state: Some("pending_agent"),
        },
    )
    .await?;
    if persisted.inserted {
        persist_immediate_side_effects(&mut tx, &request, persisted.id).await?;
    }
    validate_immediate_options(&mut tx, &request, persisted.id).await?;
    tx.commit().await?;
    let origin = crate::domain::sessions::repository::get_message_origin(
        &request.state.write_pool,
        persisted.id,
    )
    .await?
    .ok_or_else(|| {
        AppError::internal(format!(
            "message {} is missing canonical provenance",
            persisted.id
        ))
    })?;
    validate_immediate_origin(&request, &persisted, &origin)?;
    Ok((persisted, origin))
}

fn validate_immediate_origin(
    request: &ImmediateMessageRequest<'_>,
    message: &PersistedUserMessage,
    origin: &AgentMessageOrigin,
) -> Result<(), AppError> {
    if crate::domain::sessions::repository::origin_matches_session_generated(
        origin,
        request.source.session_id,
        request.source.feature_id,
        request.source.project_id,
        request.source_note,
    ) {
        return Ok(());
    }
    Err(AppError::Conflict(format!(
        "message UUID {} already has different provenance in session {}",
        message.message_uuid, request.target.session_id
    )))
}

async fn persist_immediate_side_effects(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    request: &ImmediateMessageRequest<'_>,
    message_id: i64,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO agent_message_dispatches
         (message_id, status, await_reply, link_to_current_session)
         VALUES (?, 'pending', ?, ?)",
    )
    .bind(message_id)
    .bind(request.await_reply)
    .bind(request.link_to_current_session)
    .execute(&mut **tx)
    .await?;
    if request.await_reply {
        super::super::reply_wait::insert_pending(
            tx,
            request.source.session_id,
            request.target.session_id,
            message_id,
            "message",
        )
        .await?;
    }
    sqlx::query(
        "INSERT INTO agent_message_origins
         (message_id, origin_kind, source_session_id, source_feature_id, source_project_id, note)
         VALUES (?, 'session_generated', ?, ?, ?, ?)",
    )
    .bind(message_id)
    .bind(request.source.session_id)
    .bind(request.source.feature_id)
    .bind(request.source.project_id)
    .bind(request.source_note)
    .execute(&mut **tx)
    .await?;
    if request.link_to_current_session {
        execute_message_link(
            &mut **tx,
            request.source.session_id,
            request.target.session_id,
            request.source_note,
        )
        .await?;
    }
    Ok(())
}

async fn validate_immediate_options(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    request: &ImmediateMessageRequest<'_>,
    message_id: i64,
) -> Result<(), AppError> {
    let options: (bool, bool) = sqlx::query_as(
        "SELECT await_reply, link_to_current_session
         FROM agent_message_dispatches WHERE message_id = ?",
    )
    .bind(message_id)
    .fetch_one(&mut **tx)
    .await?;
    if options == (request.await_reply, request.link_to_current_session) {
        return Ok(());
    }
    Err(AppError::Conflict(format!(
        "message UUID {} was retried with different await_reply or link_to_current_session options",
        request.message_uuid
    )))
}

async fn execute_message_link<'e, E>(
    executor: E,
    source_session_id: i64,
    target_session_id: i64,
    note: Option<&str>,
) -> Result<(), AppError>
where
    E: sqlx::Executor<'e, Database = sqlx::Sqlite>,
{
    sqlx::query(
        "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type, note)
         VALUES (?, ?, 'messaged', ?)",
    )
    .bind(source_session_id)
    .bind(target_session_id)
    .bind(note)
    .execute(executor)
    .await?;
    Ok(())
}

pub(super) async fn insert_message_link(
    state: &AppState,
    source_session_id: i64,
    target_session_id: i64,
    note: Option<&str>,
) -> Result<(), AppError> {
    execute_message_link(
        &state.write_pool,
        source_session_id,
        target_session_id,
        note,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    #[tokio::test]
    async fn retry_reuses_one_message_origin_and_link() {
        let (pool, state, source, target) = setup().await;
        let message_uuid = uuid::Uuid::new_v4();

        let persist = || ImmediateMessageRequest {
            state: &state,
            source: &source,
            target: &target,
            message: "same delegated prompt",
            message_uuid,
            source_note: Some("transport retry"),
            link_to_current_session: true,
            await_reply: false,
        };
        let (first, _) = persist_immediate_message(persist()).await.unwrap();
        let (retry, retry_origin) = persist_immediate_message(persist()).await.unwrap();
        let mismatched = persist_immediate_message(ImmediateMessageRequest {
            source_note: Some("different provenance"),
            ..persist()
        })
        .await;

        assert!(first.inserted);
        assert!(!retry.inserted);
        assert_eq!(first.id, retry.id);
        assert_eq!(retry_origin.note.as_deref(), Some("transport retry"));
        assert!(matches!(mismatched, Err(AppError::Conflict(_))));
        let counts: (i64, i64, i64, i64) = sqlx::query_as(
            "SELECT
                (SELECT COUNT(*) FROM agent_messages),
                (SELECT COUNT(*) FROM agent_message_origins),
                (SELECT COUNT(*) FROM agent_session_links),
                (SELECT COUNT(*) FROM agent_message_dispatches)",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(counts, (1, 1, 1, 1));
    }

    #[tokio::test]
    async fn retry_rejects_changed_side_effect_options() {
        let (_pool, state, source, target) = setup().await;
        let message_uuid = uuid::Uuid::new_v4();
        let request = |await_reply, link_to_current_session| ImmediateMessageRequest {
            state: &state,
            source: &source,
            target: &target,
            message: "same delegated prompt",
            message_uuid,
            source_note: None,
            link_to_current_session,
            await_reply,
        };

        persist_immediate_message(request(false, true))
            .await
            .unwrap();

        assert!(matches!(
            persist_immediate_message(request(true, true)).await,
            Err(AppError::Conflict(_))
        ));
        assert!(matches!(
            persist_immediate_message(request(false, false)).await,
            Err(AppError::Conflict(_))
        ));
    }

    async fn setup() -> (sqlx::SqlitePool, AppState, SessionScope, SessionScope) {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext::pool_only(&pool))
            .await
            .unwrap();
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (7, 'p', '/tmp/p')")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (42, 7, 'source', 'active', 'ws-session'),
                    (43, 7, 'target', 'active', 'ws-session')",
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status)
             VALUES (777, 42, 'session', 'running'), (888, 43, 'session', 'paused')",
        )
        .execute(&pool)
        .await
        .unwrap();
        let state = AppState::with_pool(pool.clone());
        let source = scope(777, 42, "running");
        let target = scope(888, 43, "paused");
        (pool, state, source, target)
    }

    fn scope(session_id: i64, feature_id: i64, status: &str) -> SessionScope {
        SessionScope {
            session_id,
            feature_id,
            feature_title: String::new(),
            project_id: 7,
            status: status.to_string(),
            pending_permission: None,
            pending_questions: None,
        }
    }
}
