use super::spawn_resolve::SpawnRuntimeSelection;
use super::spawn_session::SpawnSessionRequest;
use super::trimmed_optional;
use crate::app_state::AppState;
use crate::domain::sessions::models::AgentMessageOrigin;
use crate::domain::sessions::user_messages::{
    persist_user_message, NewUserMessage, PersistedUserMessage,
};
use crate::error::AppError;

pub(super) async fn insert_spawned_session(
    state: &AppState,
    feature_id: i64,
    body: &SpawnSessionRequest,
    runtime: &SpawnRuntimeSelection,
    codex_permission_mode: Option<&str>,
) -> Result<i64, AppError> {
    let now = chrono::Utc::now().to_rfc3339();
    // Persist the resolved model and level, not the raw request: providers
    // that inherit profile config restore from this document, so an omitted
    // level must carry the last-used/default level instead of inheriting.
    let overrides = crate::domain::agents::adapter::RuntimeConfigOverrides {
        model: runtime.model.clone(),
        thinking_effort: runtime.thinking_level.clone(),
        fast_mode: None,
    };
    let overrides = serde_json::to_string(&overrides)
        .map_err(|error| AppError::Internal(format!("serialize runtime overrides: {error}")))?;
    Ok(sqlx::query_scalar(
        "INSERT INTO agent_sessions
         (feature_id, agent_type, status, runtime_provider, model, profile, thinking_effort, permission_mode, codex_permission_mode, runtime_overrides, started_at)
         VALUES (?, 'session', 'paused', ?, ?, ?, ?, ?, COALESCE(?, 'default'), ?, ?)
         RETURNING id",
    )
    .bind(feature_id)
    // Persist the resolved owner even when the request omitted `provider`.
    // Headless/control dispatch must not need to rediscover ownership before
    // it can inject provider-specific runtime configuration.
    .bind(&runtime.effective_provider)
    .bind(runtime.model.as_deref())
    .bind(runtime.profile.as_deref())
    .bind(runtime.thinking_level.as_deref())
    .bind(trimmed_optional(body.permission_mode.as_deref()))
    .bind(codex_permission_mode)
    .bind(overrides)
    .bind(now)
    .fetch_one(&state.write_pool)
    .await?)
}

pub(super) async fn insert_initial_message(
    state: &AppState,
    source: &super::scope::SessionScope,
    session_id: i64,
    body: &SpawnSessionRequest,
) -> Result<Option<(PersistedUserMessage, AgentMessageOrigin)>, AppError> {
    let Some(message) = trimmed_optional(body.initial_message.as_deref()) else {
        return Ok(None);
    };
    let mut tx = state.write_pool.begin().await?;
    let persisted = persist_user_message(
        &mut tx,
        NewUserMessage {
            session_id,
            content: &message,
            message_uuid: uuid::Uuid::new_v4(),
            delivery_state: None,
        },
    )
    .await?;
    if body.follows_completion() {
        super::reply_wait::insert_pending(
            &mut tx,
            source.session_id,
            session_id,
            persisted.id,
            "spawn",
        )
        .await?;
    }
    sqlx::query(
        "INSERT INTO agent_message_origins
         (message_id, origin_kind, source_session_id, source_feature_id, source_project_id, note)
         VALUES (?, 'session_generated', ?, ?, ?, ?)",
    )
    .bind(persisted.id)
    .bind(source.session_id)
    .bind(source.feature_id)
    .bind(source.project_id)
    .bind(body.source_note.as_deref())
    .execute(&mut *tx)
    .await?;
    tx.commit().await?;
    let origin = AgentMessageOrigin {
        origin_kind: "session_generated".to_string(),
        source_session_id: Some(source.session_id),
        source_feature_id: Some(source.feature_id),
        source_project_id: Some(source.project_id),
        source_message_id: None,
        note: body.source_note.clone(),
        created_at: Some(persisted.created_at.clone()),
    };
    Ok(Some((persisted, origin)))
}

pub(super) async fn insert_spawn_link(
    state: &AppState,
    source_session_id: i64,
    target_session_id: i64,
    note: Option<&str>,
) -> Result<(), AppError> {
    sqlx::query(
        "INSERT INTO agent_session_links (source_session_id, target_session_id, link_type, note)
         VALUES (?, ?, 'spawned', ?)",
    )
    .bind(source_session_id)
    .bind(target_session_id)
    .bind(note)
    .execute(&state.write_pool)
    .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::domain::mcp::control::scope::resolve_session_scope;
    use crate::shared::migrate::{run_migrations, MigrationContext};

    #[tokio::test]
    async fn spawn_with_await_result_creates_reply_wait() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext {
            pool: &pool,
            db_path: None,
            app_version: None,
        })
        .await
        .unwrap();
        seed_sessions(&pool).await;
        let state = AppState::with_pool(pool.clone());
        let source = resolve_session_scope(&pool, 777).await.unwrap();
        let body = SpawnSessionRequest {
            source_feature_id: 42,
            source_session_id: 777,
            title: Some("Child".into()),
            initial_message: Some("Do the work".into()),
            branch: None,
            provider: None,
            model: None,
            thinking_level: None,
            profile: None,
            permission_mode: None,
            codex_permission_mode: None,
            source_note: None,
            follow: None,
            link_to_current_session: None,
            await_result: Some(true),
            target_project_id: Some(7),
            target_project_path: None,
        };

        let message_id = insert_initial_message(&state, &source, 888, &body)
            .await
            .unwrap()
            .unwrap()
            .0
            .id;

        let wait: (i64, i64, i64, String, String) = sqlx::query_as(
            "SELECT requester_session_id, responder_session_id, request_message_id, kind, status
             FROM agent_session_reply_waits",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(
            wait,
            (777, 888, message_id, "spawn".into(), "pending".into())
        );
    }

    #[tokio::test]
    async fn spawned_session_persists_effective_provider_and_profile() {
        let pool = sqlx::SqlitePool::connect("sqlite::memory:").await.unwrap();
        run_migrations(&MigrationContext {
            pool: &pool,
            db_path: None,
            app_version: None,
        })
        .await
        .unwrap();
        seed_sessions(&pool).await;
        let state = AppState::with_pool(pool.clone());
        let body = SpawnSessionRequest {
            source_feature_id: 42,
            source_session_id: 777,
            title: Some("Child".into()),
            initial_message: None,
            branch: None,
            provider: None,
            model: Some("gpt-5.6-sol".into()),
            thinking_level: None,
            profile: None,
            permission_mode: None,
            codex_permission_mode: None,
            source_note: None,
            follow: None,
            link_to_current_session: None,
            await_result: None,
            target_project_id: Some(7),
            target_project_path: None,
        };
        let runtime = SpawnRuntimeSelection {
            model: body.model.clone(),
            thinking_level: None,
            effective_provider: "claude_code".into(),
            profile: Some("bedrock".into()),
        };

        let session_id = insert_spawned_session(&state, 43, &body, &runtime, None)
            .await
            .unwrap();
        let stored: (String, Option<String>, String) = sqlx::query_as(
            "SELECT runtime_provider, profile, runtime_overrides FROM agent_sessions WHERE id = ?",
        )
        .bind(session_id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored.0, "claude_code");
        assert_eq!(stored.1.as_deref(), Some("bedrock"));
        let overrides: crate::domain::agents::adapter::RuntimeConfigOverrides =
            serde_json::from_str(&stored.2).unwrap();
        assert_eq!(overrides.model.as_deref(), Some("gpt-5.6-sol"));
        assert_eq!(overrides.fast_mode, None);
    }

    async fn seed_sessions(pool: &sqlx::SqlitePool) {
        sqlx::query("INSERT INTO projects (id, name, path) VALUES (7, 'Proj', '/tmp/proj')")
            .execute(pool)
            .await
            .unwrap();
        sqlx::query(
            "INSERT INTO features (id, project_id, title, status, type)
             VALUES (42, 7, 'Source', 'active', 'ws-session'),
                    (43, 7, 'Child', 'active', 'ws-session')",
        )
        .execute(pool)
        .await
        .unwrap();
        sqlx::query(
            "INSERT INTO agent_sessions (id, feature_id, agent_type, status)
             VALUES (777, 42, 'session', 'running'), (888, 43, 'session', 'paused')",
        )
        .execute(pool)
        .await
        .unwrap();
    }
}
