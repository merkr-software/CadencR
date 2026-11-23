use tracing::warn;

use super::thinking_effort;
use crate::app_state::AppState;
use crate::domain::settings;
use crate::domain::ws_session::persistence::SessionRow;
use crate::domain::ws_session::runtime::helpers::setting_or_report;
use crate::error::AppError;

pub(super) async fn resolve(
    app_state: &AppState,
    db_session_id: i64,
    effective_provider: &str,
    effective_model: Option<&str>,
    payload_thinking_effort: Option<String>,
    row: Option<&SessionRow>,
) -> Result<(Option<String>, bool), AppError> {
    let stored = row.and_then(|row| row.thinking_effort.as_ref());
    // A complete session configuration owns its effort, including the choice
    // to use the provider default. Older rows can still inherit the workspace level.
    let effective_thinking_effort =
        if row.is_some_and(|r| r.runtime_provider.is_some() && r.runtime_overrides.is_some()) {
            stored.cloned()
        } else if let Some(effort) = stored.cloned().or(payload_thinking_effort) {
            Some(effort)
        } else {
            workspace_default(app_state, effective_provider, effective_model).await?
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
    Ok((effective_thinking_effort, cleared))
}

/// The resolved effort, or `None` once the failure to read the workspace
/// default was reported to the requester.
pub(super) fn reported<T>(
    sender: &super::WsSender,
    envelope_id: &str,
    resolved: Result<T, AppError>,
) -> Option<T> {
    setting_or_report(sender, envelope_id, "reasoning effort", resolved)
}

/// The effort to anchor on a row that had none (saved with the init's other
/// writes, see `writes`), so later workspace defaults do not move it.
pub(super) fn anchor(row: Option<&SessionRow>, resolved: Option<&str>) -> Option<String> {
    let stored = row.and_then(|row| row.thinking_effort.as_ref());
    stored
        .is_none()
        .then(|| resolved.map(str::to_owned))
        .flatten()
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
