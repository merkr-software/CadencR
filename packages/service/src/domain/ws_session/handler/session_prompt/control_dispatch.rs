use axum::extract::ws::Message;
use tokio::sync::mpsc;

use crate::app_state::AppState;
use crate::domain::workflow::worktree;
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};
use crate::domain::ws_session::protocol::PromptSendPayload;
use crate::error::AppError;

use super::super::{QueryState, SdkSessions, WsSender};
use super::control_dispatch_config::build_pending_handle;
use super::control_dispatch_payload::replay_payload;
use super::prompt_followup::{handle_followup_prompt, FollowupPromptContext};
use super::prompt_pending::{handle_pending_prompt, PendingPromptContext};
use super::prompt_runtime_config::apply_respawn_if_needed;
use super::prompt_selection_sync;

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
    dispatch_control_prompt_with_message_uuid(app_state, feature_id, session_id, text, replay, None)
        .await
}

pub(crate) async fn dispatch_control_prompt_with_message_uuid(
    app_state: &AppState,
    feature_id: i64,
    session_id: i64,
    text: &str,
    replay: bool,
    message_uuid: Option<uuid::Uuid>,
) -> Result<(), AppError> {
    let mut payload = replay_payload(session_id, text, None, replay, message_uuid);
    let sender = control_sender();

    if dispatch_to_active_owner(app_state, &sender, session_id, payload.clone(), replay).await? {
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
        replay,
    )
    .await?;
    Ok(())
}

async fn dispatch_to_active_owner(
    app_state: &AppState,
    sender: &WsSender,
    session_id: i64,
    payload: PromptSendPayload,
    internal_replay: bool,
) -> Result<bool, AppError> {
    let Some(owner) = app_state.active_turns.owner_sessions(session_id).await else {
        return Ok(false);
    };
    let stored = prompt_selection_sync::load(&app_state.read_pool, session_id)
        .await
        .map_err(|(code, message)| AppError::Internal(format!("{code}: {message}")))?;
    let target = {
        let mut sessions = owner.lock().await;
        let Some(handle) = sessions.get_mut(&session_id) else {
            return Ok(false);
        };
        // The owner's runtime stays alive between turns. One still on another
        // model is closed so the prompt spawns on the persisted selection.
        if prompt_selection_sync::sync_handle(handle, &stored, app_state, session_id) {
            apply_respawn_if_needed(handle, app_state, session_id).await;
        }
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
                internal_replay,
                wait_for_delivery: true,
            }),
            QueryState::Pending(_) => None,
        }
    };
    let Some(context) = target else {
        return Ok(false);
    };
    handle_followup_prompt(context, payload)
        .await
        .map_err(AppError::Internal)?;
    Ok(true)
}

async fn ensure_control_pending_handle(
    app_state: &AppState,
    feature_id: i64,
    session_id: i64,
) -> Result<(), AppError> {
    let row = require_session_row(&app_state.read_pool, feature_id, session_id).await?;
    let project_id = worktree::get_project_id_for_feature(&app_state.read_pool, feature_id)
        .await
        .map_err(AppError::Internal)?;
    let handle = build_pending_handle(app_state, project_id, row).await?;
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
    internal_replay: bool,
) -> Result<(), AppError> {
    let Some(context) = pending_context_from_handle(
        app_state,
        sender,
        sessions,
        session_id,
        payload,
        internal_replay,
    )
    .await
    else {
        return Ok(());
    };
    handle_pending_prompt(context)
        .await
        .map_err(AppError::Internal)
}

async fn pending_context_from_handle(
    app_state: &AppState,
    sender: &WsSender,
    sessions: &SdkSessions,
    session_id: i64,
    payload: PromptSendPayload,
    internal_replay: bool,
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
        internal_replay,
        wait_for_delivery: true,
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
}

fn control_sender() -> WsSender {
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    tokio::spawn(async move { while rx.recv().await.is_some() {} });
    tx
}
