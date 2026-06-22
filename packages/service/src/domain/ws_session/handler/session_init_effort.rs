use tracing::warn;

use super::thinking_effort;
use crate::app_state::AppState;
use crate::domain::settings;
use crate::domain::ws_session::persistence::WsSessionPersistence;

pub(super) async fn resolve(
    app_state: &AppState,
    db_session_id: i64,
    effective_provider: &str,
    effective_model: Option<&str>,
    payload_thinking_effort: Option<String>,
    stored_thinking_effort: Option<String>,
) -> (Option<String>, bool) {
    let effective_thinking_effort = match payload_thinking_effort.or(stored_thinking_effort.clone())
    {
        Some(effort) => Some(effort),
        None => workspace_default(app_state, effective_provider, effective_model).await,
    };
    let (effective_thinking_effort, cleared) = thinking_effort::filter_for_model(
        effective_provider,
        effective_model,
        effective_thinking_effort,
    );
    if cleared {
        warn!(
            db_session_id,
            runtime_provider = %effective_provider,
            model = ?effective_model,
            "clearing thinking effort unsupported by selected model"
        );
    }
    if stored_thinking_effort.is_none() {
        anchor_conversation_effort(
            app_state,
            db_session_id,
            effective_thinking_effort.as_deref(),
        )
        .await;
    }
    (effective_thinking_effort, cleared)
}

async fn workspace_default(
    app_state: &AppState,
    effective_provider: &str,
    effective_model: Option<&str>,
) -> Option<String> {
    let model_id = effective_model?;
    settings::resolve_setting(
        &app_state.read_pool,
        &settings::thinking_effort_model_key(effective_provider, model_id),
        None,
        None,
        None,
    )
    .await
}

async fn anchor_conversation_effort(
    app_state: &AppState,
    db_session_id: i64,
    thinking_effort: Option<&str>,
) {
    if let Some(effort) = thinking_effort {
        WsSessionPersistence::update_thinking_effort_static(
            &app_state.write_pool,
            db_session_id,
            Some(effort),
        )
        .await;
    }
}
