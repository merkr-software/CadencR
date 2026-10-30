use crate::domain::ws_session::runtime::output::SessionOutput;

use crate::app_state::AppState;
use crate::domain::workflow::worktree;
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};
use crate::domain::ws_session::protocol::PromptSendPayload;
use crate::error::AppError;

use super::control_dispatch_config::build_pending_handle;
use super::control_dispatch_payload::replay_payload;
use super::prompt_outcome::{publish_warnings, PromptDispatchOutcome};
use crate::domain::ws_session::runtime::prompt::prompt_followup::{
    handle_followup_prompt, FollowupPromptContext,
};
use crate::domain::ws_session::runtime::prompt::prompt_pending::{
    handle_pending_prompt, PendingPromptContext,
};
use crate::domain::ws_session::runtime::prompt::prompt_runtime_config::apply_respawn_if_needed;
use crate::domain::ws_session::runtime::prompt::prompt_selection_sync;
use crate::domain::ws_session::runtime::state::{QueryState, SdkSessions};

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
) -> Result<PromptDispatchOutcome, AppError> {
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
) -> Result<PromptDispatchOutcome, AppError> {
    let output = SessionOutput::headless();
    let result = dispatch_control_prompt_inner(
        app_state,
        feature_id,
        session_id,
        text,
        replay,
        message_uuid,
        &output,
    )
    .await;
    app_state
        .session_runtimes
        .prune_session(session_id, &app_state.ws_feature_senders)
        .await;
    result?;
    Ok(publish_warnings(app_state, feature_id, session_id, &output).await)
}

async fn dispatch_control_prompt_inner(
    app_state: &AppState,
    feature_id: i64,
    session_id: i64,
    text: &str,
    replay: bool,
    message_uuid: Option<uuid::Uuid>,
    sender: &SessionOutput,
) -> Result<(), AppError> {
    require_session_row(&app_state.read_pool, feature_id, session_id).await?;
    let mut payload = replay_payload(session_id, text, None, replay, message_uuid);

    if dispatch_to_active_owner(app_state, sender, session_id, payload.clone(), replay).await? {
        return Ok(());
    }

    payload.use_worktree = control_use_worktree(&app_state.read_pool, feature_id).await;
    let sessions = ensure_control_pending_handle(app_state, feature_id, session_id).await?;
    dispatch_control_pending(app_state, sender, &sessions, session_id, payload, replay).await?;
    Ok(())
}

async fn dispatch_to_active_owner(
    app_state: &AppState,
    sender: &SessionOutput,
    session_id: i64,
    payload: PromptSendPayload,
    internal_replay: bool,
) -> Result<bool, AppError> {
    let Some(owner) = app_state.session_runtimes.get(session_id).await else {
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
                delivery_lease: Some(handle.identity.begin_delivery()),
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
) -> Result<SdkSessions, AppError> {
    let row = require_session_row(&app_state.read_pool, feature_id, session_id).await?;
    if let Some(sessions) = app_state.session_runtimes.get(session_id).await {
        if sessions.lock().await.contains_key(&session_id) {
            return Ok(sessions);
        }
    }
    let project_id = worktree::get_project_id_for_feature(&app_state.read_pool, feature_id)
        .await
        .map_err(AppError::Internal)?;
    let handle = build_pending_handle(app_state, project_id, row).await?;
    let candidate = std::sync::Arc::new(tokio::sync::Mutex::new(std::collections::HashMap::new()));
    let sessions = app_state
        .session_runtimes
        .bind_feature(session_id, feature_id, &candidate)
        .await;
    sessions.lock().await.entry(session_id).or_insert(handle);
    Ok(sessions)
}

async fn dispatch_control_pending(
    app_state: &AppState,
    sender: &SessionOutput,
    sessions: &SdkSessions,
    session_id: i64,
    payload: PromptSendPayload,
    internal_replay: bool,
) -> Result<(), AppError> {
    let spawn_claim = app_state.session_runtimes.claim_spawn(session_id).await;
    let feature_id = {
        let guard = sessions.lock().await;
        guard
            .get(&session_id)
            .map(|handle| handle.feature_id)
            .ok_or_else(|| AppError::NotFound(format!("session {session_id} runtime not found")))?
    };
    require_session_row(&app_state.read_pool, feature_id, session_id).await?;
    // Another caller may have installed a runtime while this prompt waited.
    let active = {
        let guard = sessions.lock().await;
        matches!(
            guard.get(&session_id).map(|handle| &handle.state),
            Some(QueryState::Active { .. })
        )
    };
    if active {
        drop(spawn_claim);
        return if dispatch_to_active_owner(app_state, sender, session_id, payload, internal_replay)
            .await?
        {
            Ok(())
        } else {
            Err(AppError::Conflict(
                "session runtime changed before follow-up delivery".into(),
            ))
        };
    }
    let Some(context) = pending_context_from_handle(
        app_state,
        sender,
        sessions,
        session_id,
        payload,
        internal_replay,
        spawn_claim,
    )
    .await
    else {
        return Err(AppError::Conflict(
            "session runtime changed before prompt delivery".into(),
        ));
    };
    handle_pending_prompt(context)
        .await
        .map_err(AppError::Internal)
}

async fn pending_context_from_handle(
    app_state: &AppState,
    sender: &SessionOutput,
    sessions: &SdkSessions,
    session_id: i64,
    payload: PromptSendPayload,
    internal_replay: bool,
    spawn_claim: tokio::sync::OwnedMutexGuard<()>,
) -> Option<PendingPromptContext> {
    let mut guard = sessions.lock().await;
    let handle = guard.get_mut(&session_id)?;
    let spawned_model = handle.desired_model.clone();
    let spawned_thinking_effort = handle.desired_thinking_effort.clone();
    let config = handle.config.clone();
    let feature_id = handle.feature_id;
    let provider_id = handle.runtime_provider.clone();
    let mut options = match &handle.state {
        QueryState::Pending(options) => options.clone(),
        QueryState::Active { .. } => return None,
    };
    if options.resume_session_id.is_none() {
        options.resume_session_id = handle.resume_session_id.clone();
    }
    let handle_identity = handle.identity.clone();
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
        spawn_claim: Some(spawn_claim),
        handle_identity,
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
    #[tokio::test]
    async fn cancelled_pending_context_preserves_config_for_retry() {
        use crate::domain::agents::adapter::RuntimeSpawnConfig;
        use crate::domain::ws_session::handler::tests::support::{
            make_active_handle, make_test_app_state,
        };
        let state = make_test_app_state().await;
        let mut handle = make_active_handle(1, None);
        let options = RuntimeSpawnConfig {
            cwd: "/tmp/preserved".into(),
            model: Some("preserved-model".into()),
            thinking_effort: Some("high".into()),
            ..Default::default()
        };
        handle.desired_model = options.model.clone();
        handle.desired_thinking_effort = options.thinking_effort.clone();
        handle.resume_session_id = Some("preserved-resume".into());
        handle.state = QueryState::Pending(options);
        let sessions = super::super::super::state::new_sdk_sessions();
        sessions.lock().await.insert(7, handle);
        state.session_runtimes.bind(7, &sessions).await;
        for _ in 0..2 {
            let claim = state.session_runtimes.claim_spawn(7).await;
            let context = pending_context_from_handle(
                &state,
                &SessionOutput::headless(),
                &sessions,
                7,
                replay_payload(7, "retry", None, true, None),
                true,
                claim,
            )
            .await
            .unwrap();
            assert_eq!(context.options.model.as_deref(), Some("preserved-model"));
            assert_eq!(context.options.thinking_effort.as_deref(), Some("high"));
            assert_eq!(
                context.options.resume_session_id.as_deref(),
                Some("preserved-resume")
            );
            assert_eq!(
                context.options.cwd,
                std::path::PathBuf::from("/tmp/preserved")
            );
            drop(context);
            assert!(!state.session_runtimes.is_spawning(7).await);
        }
        let guard = sessions.lock().await;
        assert_eq!(
            guard.get(&7).unwrap().resume_session_id.as_deref(),
            Some("preserved-resume")
        );
    }
}
