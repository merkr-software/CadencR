use super::super::output::{CommandError, OutputTarget, SessionOutput};
use super::super::prompt::{
    persist_and_publish_user_message, CanonicalUserMessageMode, CanonicalUserMessageRequest,
};
use crate::app_state::AppState;
use crate::domain::feature_events::FeatureEventAction;
use crate::domain::sessions::user_messages::canonical_user_message_uuid;
use crate::domain::ws_session::question_answers::format_answers_plain_text;

pub(super) async fn persist_question_answer(
    app_state: &AppState,
    output: &SessionOutput,
    feature_id: i64,
    session_id: i64,
    updated_input: Option<&serde_json::Value>,
    message_uuid: Option<&str>,
) -> Vec<CommandError> {
    let Some(answer_text) = updated_input.and_then(format_answers_plain_text) else {
        return Vec::new();
    };
    let message_uuid = match canonical_user_message_uuid(message_uuid) {
        Ok(message_uuid) => message_uuid,
        Err(error) => {
            return vec![CommandError::new("INVALID_MESSAGE_UUID", error)];
        }
    };
    let result = persist_and_publish_user_message(CanonicalUserMessageRequest {
        pool: &app_state.write_pool,
        feature_senders: &app_state.ws_feature_senders,
        owner: output.recipient(),
        feature_id,
        session_id,
        content: &answer_text,
        message_uuid,
        origin: None,
        mode: CanonicalUserMessageMode::PersistOnly,
    })
    .await;
    let mut warnings = Vec::new();
    match result {
        Ok(outcome) => {
            if let Err(error) = outcome.delivery {
                warnings.push(CommandError::new("USER_MESSAGE_DELIVERY_FAILED", error));
            }
            if outcome.message.inserted {
                app_state
                    .feature_events_tx
                    .emit(feature_id, None, FeatureEventAction::Reordered);
            }
        }
        Err(error) => warnings.push(CommandError::new("USER_MESSAGE_PERSIST_FAILED", error)),
    }
    warnings
}
