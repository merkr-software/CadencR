use std::sync::Arc;

use axum::extract::ws::Message;
use tokio::sync::mpsc;

use crate::app_state::AppState;
use crate::domain::agents::adapter::RuntimeSpawnConfig;
use crate::domain::agents::resolve_effective_provider;
use crate::domain::agents::runtime::DEFAULT_PROVIDER;
use crate::domain::settings;
use crate::domain::workflow::worktree;
use crate::domain::ws_session::permissions;
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};
use crate::domain::ws_session::protocol::PromptSendPayload;
use crate::error::AppError;

use super::super::{
    default_permission_mode, parse_permission_mode, QueryState, SdkHandle, SdkSessions,
    SessionConfig, WsSender,
};
use super::prompt_followup::{handle_followup_prompt, FollowupPromptContext};
use super::prompt_pending::{handle_pending_prompt, PendingPromptContext};

/// Inject a prompt into a session without a connected WS client.
///
/// `replay` controls whether the standard prompt path persists and broadcasts
/// the inbound text as a user message. MCP callers persist the user message
/// themselves (with agent-to-agent origin metadata) and pass `true` to suppress
/// the duplicate; the scheduler passes `false` so a user-authored scheduled
/// message is persisted and mirrored to clients like any other user message.
pub(crate) async fn dispatch_control_prompt(
    app_state: &AppState,
    feature_id: i64,
    session_id: i64,
    text: &str,
    replay: bool,
) -> Result<(), AppError> {
    let mut payload = replay_payload(session_id, text, None, replay);
    let sender = control_sender();

    if dispatch_to_active_owner(app_state, &sender, session_id, payload.clone()).await {
        return Ok(());
    }

    payload.use_worktree = control_use_worktree(&app_state.read_pool, feature_id).await;
    ensure_control_pending_handle(app_state, feature_id, session_id).await?;
    dispatch_control_pending(
        app_state,
        &sender,
        &app_state.mcp_control_sessions,
        session_id,
        payload,
    )
    .await;
    Ok(())
}

async fn dispatch_to_active_owner(
    app_state: &AppState,
    sender: &WsSender,
    session_id: i64,
    payload: PromptSendPayload,
) -> bool {
    let Some(owner) = app_state.active_turns.owner_sessions(session_id).await else {
        return false;
    };
    let target = {
        let sessions = owner.lock().await;
        let Some(handle) = sessions.get(&session_id) else {
            return false;
        };
        match &handle.state {
            QueryState::Active { query, .. } => Some(FollowupPromptContext {
                query: query.clone(),
                feature_id: handle.feature_id,
                db_session_id: session_id,
                write_pool: app_state.write_pool.clone(),
                session_status_tx: app_state.session_status_tx.clone(),
                sender: sender.clone(),
                ws_feature_senders: app_state.ws_feature_senders.clone(),
                feature_events_tx: app_state.feature_events_tx.clone(),
                envelope_id: uuid::Uuid::new_v4().to_string(),
                sdk_sessions: owner.clone(),
                active_turns: app_state.active_turns.clone(),
                provider_id: handle.runtime_provider.clone(),
            }),
            QueryState::Pending(_) => None,
        }
    };
    let Some(context) = target else {
        return false;
    };
    handle_followup_prompt(context, payload).await;
    true
}

async fn ensure_control_pending_handle(
    app_state: &AppState,
    feature_id: i64,
    session_id: i64,
) -> Result<(), AppError> {
    let row = require_session_row(&app_state.read_pool, feature_id, session_id).await?;
    let (project_id, cwd) = project_context(&app_state.read_pool, feature_id).await?;
    let handle = build_pending_handle(app_state, project_id, cwd, row).await;
    app_state
        .mcp_control_sessions
        .lock()
        .await
        .insert(session_id, handle);
    Ok(())
}

async fn dispatch_control_pending(
    app_state: &AppState,
    sender: &WsSender,
    sessions: &SdkSessions,
    session_id: i64,
    payload: PromptSendPayload,
) {
    let Some(context) =
        pending_context_from_handle(app_state, sender, sessions, session_id, payload).await
    else {
        return;
    };
    handle_pending_prompt(context).await;
}

async fn pending_context_from_handle(
    app_state: &AppState,
    sender: &WsSender,
    sessions: &SdkSessions,
    session_id: i64,
    payload: PromptSendPayload,
) -> Option<PendingPromptContext> {
    let mut guard = sessions.lock().await;
    let handle = guard.get_mut(&session_id)?;
    let spawned_model = handle.desired_model.clone();
    let spawned_thinking_effort = handle.desired_thinking_effort.clone();
    let config = handle.config.clone();
    let feature_id = handle.feature_id;
    let provider_id = handle.runtime_provider.clone();
    let options = match &mut handle.state {
        QueryState::Pending(options) => std::mem::take(options),
        QueryState::Active { .. } => return None,
    };
    drop(guard);
    Some(PendingPromptContext {
        envelope_id: uuid::Uuid::new_v4().to_string(),
        sender: sender.clone(),
        sdk_sessions: sessions.clone(),
        app_state: app_state.clone(),
        db_session_id: session_id,
        feature_id,
        provider_id,
        spawned_model,
        spawned_thinking_effort,
        config,
        options,
        payload,
        permission_tx: None,
    })
}

async fn require_session_row(
    pool: &sqlx::SqlitePool,
    feature_id: i64,
    session_id: i64,
) -> Result<SessionRow, AppError> {
    let Some(row) = WsSessionPersistence::get_session_row(pool, session_id).await else {
        return Err(AppError::NotFound(format!(
            "session {session_id} not found"
        )));
    };
    if row.feature_id != feature_id {
        return Err(AppError::BadRequest(
            "session does not belong to target feature".to_string(),
        ));
    }
    Ok(row)
}

async fn project_context(
    pool: &sqlx::SqlitePool,
    feature_id: i64,
) -> Result<(i64, String), AppError> {
    Ok(sqlx::query_as(
        "SELECT projects.id, projects.path
         FROM features
         JOIN projects ON projects.id = features.project_id
         WHERE features.id = ?",
    )
    .bind(feature_id)
    .fetch_one(pool)
    .await?)
}

async fn build_pending_handle(
    app_state: &AppState,
    project_id: i64,
    cwd: String,
    row: SessionRow,
) -> SdkHandle {
    let provider = effective_provider(app_state, project_id, &row).await;
    let options = runtime_options(app_state, project_id, &cwd, &provider, &row).await;
    let config = session_config(&options);
    SdkHandle {
        state: QueryState::Pending(options),
        feature_id: row.feature_id,
        runtime_provider: provider,
        desired_model: row.model.clone(),
        spawned_model: None,
        desired_permission_mode: config.permission_mode.clone(),
        spawned_permission_mode: None,
        desired_access_mode: config.access_mode.clone(),
        spawned_access_mode: None,
        desired_thinking_effort: row.thinking_effort.clone(),
        spawned_thinking_effort: None,
        desired_claude_profile: None,
        spawned_claude_profile: None,
        runtime_control_endpoint: None,
        resume_session_id: row.runtime_session_id.clone(),
        config,
        manual_compact_cancel: Arc::new(std::sync::atomic::AtomicBool::new(false)),
        manual_compact_spawn_pending: Arc::new(std::sync::atomic::AtomicBool::new(false)),
    }
}

async fn effective_provider(app_state: &AppState, project_id: i64, row: &SessionRow) -> String {
    let configured = settings::resolve_setting(
        &app_state.read_pool,
        &crate::domain::agents::runtime::runtime_setting_key("session"),
        Some(row.feature_id),
        Some(project_id),
        Some(DEFAULT_PROVIDER),
    )
    .await
    .unwrap_or_else(|| DEFAULT_PROVIDER.to_string());
    resolve_effective_provider(
        row.runtime_provider.clone().unwrap_or(configured),
        row.model.as_deref(),
    )
}

async fn runtime_options(
    app_state: &AppState,
    project_id: i64,
    project_cwd: &str,
    provider: &str,
    row: &SessionRow,
) -> RuntimeSpawnConfig {
    let mut options = RuntimeSpawnConfig::default();
    options.cwd = runtime_cwd(app_state, row.feature_id, project_cwd).await;
    options.model = row.model.clone();
    options.thinking_effort = row.thinking_effort.clone();
    options.permission_mode = Some(
        row.permission_mode
            .as_deref()
            .map(parse_permission_mode)
            .unwrap_or_else(|| default_permission_mode(provider)),
    );
    let configured_codex =
        super::super::codex_access::configured_access_mode(&app_state.read_pool).await;
    let codex_mode = row
        .codex_permission_mode
        .as_deref()
        .unwrap_or(configured_codex.as_str());
    options.access_mode = super::super::codex_access::runtime_access_mode(
        provider,
        Some(codex_mode),
        &configured_codex,
    );
    if provider == crate::domain::agents::claude_code::PROVIDER_ID {
        options.allow_bypass_permissions = super::super::claude_access::bypass_permissions_enabled(
            &app_state.read_pool,
            Some(row.feature_id),
            Some(project_id),
        )
        .await;
    }
    options.resume_session_id = row.runtime_session_id.clone();
    options
}

async fn runtime_cwd(
    app_state: &AppState,
    feature_id: i64,
    project_cwd: &str,
) -> std::path::PathBuf {
    match worktree::get_setting(&app_state.read_pool, feature_id, "worktree_path").await {
        Some(path) if std::path::Path::new(&path).exists() => std::path::PathBuf::from(path),
        _ => std::path::PathBuf::from(project_cwd),
    }
}

fn session_config(options: &RuntimeSpawnConfig) -> SessionConfig {
    SessionConfig {
        cwd: options.cwd.clone(),
        canonical_cwd: permissions::canonicalize_worktree(&options.cwd),
        permission_mode: options.permission_mode.clone(),
        access_mode: options.access_mode.clone(),
        thinking_effort: options.thinking_effort.clone(),
        system_prompt: options.system_prompt.clone(),
        allow_bypass_permissions: options.allow_bypass_permissions,
        claude_profile: None,
        env: options.env.clone(),
    }
}

fn replay_payload(
    session_id: i64,
    text: &str,
    use_worktree: Option<bool>,
    replay: bool,
) -> PromptSendPayload {
    PromptSendPayload {
        session_id: session_id.to_string(),
        text: text.to_string(),
        profile: None,
        claude_profile: None,
        images: Vec::new(),
        attachments: Vec::new(),
        use_worktree,
        new_project_branch: None,
        client_message_id: None,
        // Replay re-sends an already-persisted message (replay → no new row),
        // so there is nothing to ack a persisted id for.
        user_message_ref: None,
        replay,
    }
}

async fn control_use_worktree(pool: &sqlx::SqlitePool, feature_id: i64) -> Option<bool> {
    match worktree::get_setting(pool, feature_id, "worktree_mode")
        .await
        .as_deref()
    {
        Some("new" | "reuse") => Some(true),
        Some("skip") => Some(false),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::*;

    async fn pool_with_feature_settings() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .connect(":memory:")
            .await
            .expect("pool");
        sqlx::query(
            "CREATE TABLE feature_settings (
                feature_id INTEGER NOT NULL,
                key TEXT NOT NULL,
                value TEXT NOT NULL,
                PRIMARY KEY (feature_id, key)
            )",
        )
        .execute(&pool)
        .await
        .expect("schema");
        pool
    }

    #[tokio::test]
    async fn control_use_worktree_enables_spawned_worktree_features() {
        let pool = pool_with_feature_settings().await;
        worktree::set_setting(&pool, 42, "worktree_mode", "new")
            .await
            .expect("set worktree mode");

        assert_eq!(control_use_worktree(&pool, 42).await, Some(true));
    }

    #[tokio::test]
    async fn control_use_worktree_does_not_default_missing_mode_to_worktree() {
        let pool = pool_with_feature_settings().await;

        assert_eq!(control_use_worktree(&pool, 42).await, None);
    }

    #[test]
    fn replay_payload_preserves_supplied_worktree_intent() {
        let payload = replay_payload(7, "start", Some(true), true);

        assert_eq!(payload.use_worktree, Some(true));
        assert!(payload.replay);
    }

    #[test]
    fn replay_payload_can_request_user_message_persistence() {
        let payload = replay_payload(7, "scheduled", None, false);

        assert!(!payload.replay);
    }
}

fn control_sender() -> WsSender {
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    tx
}
