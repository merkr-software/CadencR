use crate::app_state::AppState;
use crate::domain::ws_session::protocol::PromptSendPayload;
use crate::domain::ws_session::runtime::prompt::content::{
    build_persist_content, payload_attachments,
};
use crate::error::AppError;

use super::super::{send_error, SdkSessions, WsSender};
use super::{
    persist_and_publish_user_message, CanonicalUserMessageMode, CanonicalUserMessageRequest,
};

#[bon::builder]
pub(super) async fn report_settings_refusal(
    sender: &WsSender,
    correlation_id: &str,
    app_state: &AppState,
    sdk_sessions: &SdkSessions,
    session_id: i64,
    payload: &PromptSendPayload,
    error: &AppError,
) {
    let feature_id = sdk_sessions
        .lock()
        .await
        .get(&session_id)
        .map(|handle| handle.feature_id);
    if let (Some(feature_id), Some(message_uuid)) = (feature_id, payload.message_uuid.as_deref()) {
        match crate::domain::prompt_queue::acceptance::already_deferred(
            app_state,
            session_id,
            message_uuid,
        )
        .await
        {
            Ok(true) => return,
            Ok(false) => {
                let message_uuid =
                    uuid::Uuid::parse_str(message_uuid).expect("normalized prompt UUID");
                let content = build_persist_content(&payload.text, &payload_attachments(payload));
                // Keep the rejected prompt available for a manual retry. A failed
                // receipt has no dispatch claim and cannot be auto-delivered.
                let result = persist_and_publish_user_message(CanonicalUserMessageRequest {
                    pool: &app_state.write_pool,
                    feature_senders: &app_state.ws_feature_senders,
                    owner: Some(sender),
                    feature_id,
                    session_id,
                    content: &content,
                    message_uuid,
                    origin: None,
                    mode: CanonicalUserMessageMode::RejectedPrompt,
                })
                .await;
                match result {
                    Ok(outcome)
                        if outcome.message.delivery_state.as_deref() != Some("delivery_failed") =>
                    {
                        return
                    }
                    Ok(outcome) => {
                        if let Err(publish_error) = outcome.delivery {
                            tracing::warn!(session_id, %publish_error, "could not publish rejected prompt");
                        }
                    }
                    Err(persist_error) => {
                        tracing::warn!(session_id, %persist_error, "could not save rejected prompt")
                    }
                }
            }
            Err(queue_error) => {
                tracing::warn!(session_id, %queue_error, "could not check for a deferred prompt")
            }
        }
    }
    send_error(sender, correlation_id, error.code(), &error.to_string());
}
