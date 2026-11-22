use tracing::warn;

use super::thinking_effort;
use crate::app_state::AppState;
use crate::domain::settings;
use crate::domain::ws_session::persistence::{SessionRow, WsSessionPersistence};
use crate::domain::ws_session::runtime::helpers::{saved_or_report, setting_or_report};
use crate::error::AppError;

pub(super) async fn resolve(
    app_state: &AppState,
    db_session_id: i64,
    effective_provider: &str,
    effective_model: Option<&str>,
    payload_thinking_effort: Option<String>,
    row: Option<&SessionRow>,
) -> Result<(Option<String>, bool), EffortFailure> {
    let stored = row.and_then(|row| row.thinking_effort.as_ref());
    // A complete session configuration owns its effort, including the choice
    // to use the provider default. Older rows can still inherit the workspace level.
    let effective_thinking_effort =
        if row.is_some_and(|r| r.runtime_provider.is_some() && r.runtime_overrides.is_some()) {
            stored.cloned()
        } else if let Some(effort) = stored.cloned().or(payload_thinking_effort) {
            Some(effort)
        } else {
            workspace_default(app_state, effective_provider, effective_model)
                .await
                .map_err(EffortFailure::Read)?
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
    if stored.is_none() {
        anchor_conversation_effort(
            app_state,
            db_session_id,
            effective_thinking_effort.as_deref(),
        )
        .await
        .map_err(EffortFailure::Save)?;
    }
    Ok((effective_thinking_effort, cleared))
}

/// Why the effort could not be resolved: reading the workspace default and
/// anchoring the result are reported under different codes.
pub(super) enum EffortFailure {
    Read(AppError),
    Save(sqlx::Error),
}

/// The resolved effort, or `None` once the failure was reported to the
/// requester under its own code.
pub(super) fn reported<T>(
    sender: &super::WsSender,
    envelope_id: &str,
    resolved: Result<T, EffortFailure>,
) -> Option<T> {
    const WHAT: &str = "reasoning effort";
    match resolved {
        Ok(value) => Some(value),
        Err(EffortFailure::Read(error)) => setting_or_report(sender, envelope_id, WHAT, Err(error)),
        Err(EffortFailure::Save(error)) => saved_or_report(sender, envelope_id, WHAT, Err(error)),
    }
}

async fn workspace_default(
    app_state: &AppState,
    effective_provider: &str,
    effective_model: Option<&str>,
) -> Result<Option<String>, AppError> {
    let Some(model_id) = effective_model else {
        return Ok(None);
    };
    settings::thinking_effort_model_default(&app_state.read_pool, effective_provider, model_id)
        .await
}

async fn anchor_conversation_effort(
    app_state: &AppState,
    db_session_id: i64,
    thinking_effort: Option<&str>,
) -> Result<(), sqlx::Error> {
    if let Some(effort) = thinking_effort {
        WsSessionPersistence::update_thinking_effort_static(
            &app_state.write_pool,
            db_session_id,
            Some(effort),
        )
        .await?;
    }
    Ok(())
}
