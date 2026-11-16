use axum::extract::ws::Message;

use super::super::output::{CommandError, SessionOutput};
use crate::app_state::AppState;
use crate::domain::ws_session::persistence::WsSessionPersistence;
use crate::domain::ws_session::protocol::{SessionWarningPayload, WsEnvelope, WsSessionEvent};

/// The provider accepted this prompt. Warnings describe subsequent local
/// bookkeeping and must never turn acceptance into a retryable delivery error.
#[derive(Debug)]
pub(crate) struct PromptDispatchOutcome {
    pub(crate) warnings: Vec<String>,
}

impl PromptDispatchOutcome {
    /// Callers whose response has no warning field explicitly acknowledge that
    /// the application already published these warnings, including explicit
    /// notice when their persistence failed.
    pub(crate) fn delivery_confirmed(self) {
        if !self.warnings.is_empty() {
            tracing::warn!(warnings = ?self.warnings, "prompt accepted; warnings published to session");
        }
    }
}

pub(super) async fn publish_warnings(
    state: &AppState,
    feature_id: i64,
    session_id: i64,
    output: &SessionOutput,
) -> PromptDispatchOutcome {
    let mut warnings = output.take_warnings();
    let mut persistence_warnings = Vec::new();
    for warning in &warnings {
        if let Err(error) = WsSessionPersistence::try_persist_error_message_static(
            &state.write_pool,
            session_id,
            &warning.message,
            None,
        )
        .await
        {
            persistence_warnings.push(CommandError::new(
                "WARNING_PERSIST_FAILED",
                format!("Prompt accepted, but its warning could not be saved: {error}"),
            ));
        }
    }
    warnings.extend(persistence_warnings);
    for warning in &warnings {
        publish_warning(state, feature_id, session_id, warning).await;
    }
    PromptDispatchOutcome {
        warnings: warnings
            .into_iter()
            .map(|warning| format!("{}: {}", warning.code, warning.message))
            .collect(),
    }
}

async fn publish_warning(
    state: &AppState,
    feature_id: i64,
    _session_id: i64,
    warning: &CommandError,
) {
    let envelope = WsEnvelope::session_event(&WsSessionEvent::Warning(SessionWarningPayload {
        code: warning.code.into(),
        message: warning.message.clone(),
    }))
    .expect("prompt warning should serialize");
    state
        .ws_feature_senders
        .send_and_mirror(
            feature_id,
            &SessionOutput::headless(),
            Message::Text(String::from(envelope).into()),
        )
        .await;
}
